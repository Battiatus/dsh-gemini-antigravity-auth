// Protocole Google Antigravity écrit pour ce plugin, sans dépendance : OAuth (PKCE), jetons, projet Cloud Code,
// transport HTTPS (proxy compris), catalogue de modèles, quotas et métadonnées de requête.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

// Client OAuth « application installée » d'Antigravity : identifiants publics, propres au client de bureau de Google
export const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
export const CALLBACK_PORT = 51121; // imposé par l'URI de retour enregistrée chez Google pour ce client
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/oauth-callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
];
export const ENDPOINTS = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'];
const DEFAULT_PROJECT = 'rising-fact-p41fc'; // projet partagé qu'Antigravity utilise quand le compte n'en a pas
/** Jeton factice que Gemini 3 accepte à la place d'une signature de raisonnement absente (appel d'outil rejoué). */
export const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

const PLATFORM = process.platform === 'win32' ? 'windows' : process.platform;
const ARCH = { x64: 'amd64', ia32: '386' }[process.arch] ?? process.arch;
/** Agent utilisateur du client en ligne de commande d'Antigravity, que les serveurs Cloud Code attendent. */
export const USER_AGENT = `antigravity/cli/1.3.5 (aidev_client; os_type=${PLATFORM}; arch=${ARCH}; cl=998863838; auth_method=consumer)`;

// ---------- transport ----------

/** Proxy HTTPS de l'environnement (HTTPS_PROXY, ALL_PROXY), sauf si NO_PROXY couvre l'hôte. */
function proxyFor(hostname) {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (!raw) return null;
  const skip = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const host = hostname.toLowerCase();
  if (skip.some((s) => s === '*' || host === s.replace(/^\./, '') || host.endsWith(s.startsWith('.') ? s : `.${s}`))) return null;
  try { return new URL(raw.includes('://') ? raw : `http://${raw}`); } catch { return null; }
}

/** Tunnel CONNECT à travers le proxy, puis TLS vers l'hôte : la connexion que https.request utilisera. */
function connectThroughProxy(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const auth = proxy.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` } : {};
    const req = http.request({ host: proxy.hostname, port: proxy.port || 8080, method: 'CONNECT', path: `${host}:${port}`, headers: { Host: `${host}:${port}`, ...auth }, timeout: timeoutMs });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error(`HTTPS proxy refused the tunnel (${res.statusCode})`)); }
      resolve(tls.connect({ socket, servername: host }));
    });
    req.on('timeout', () => req.destroy(new Error(`HTTPS proxy did not answer within ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Requête HTTPS rendue comme une Response de fetch (status, ok, headers, text, json, body en flux).
 * `timeoutMs` borne l'attente des en-têtes, `idleTimeoutMs` un corps qui ne reçoit plus rien. Les en-têtes partent
 * dans l'ordre donné. Le DNS suit dns.lookup (voir bypassLoopbackRedirect dans agy.js).
 */
export async function request(url, { method = 'POST', headers = {}, body, signal, timeoutMs = 60_000, idleTimeoutMs = 600_000 } = {}) {
  const target = new URL(url);
  signal?.throwIfAborted();
  const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : String(body));
  // en-têtes passés en liste ordonnée : Node n'ajoute alors pas Host, on le met en tête comme le client Antigravity
  const pairs = [['Host', target.port ? `${target.hostname}:${target.port}` : target.hostname], ...Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'host')];
  if (data && !pairs.some(([k]) => k.toLowerCase() === 'content-length')) pairs.push(['Content-Length', String(data.length)]);
  const proxy = proxyFor(target.hostname);
  const socket = proxy ? await connectThroughProxy(proxy, target.hostname, target.port || 443, timeoutMs) : undefined;
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: target.hostname, port: target.port || 443, path: target.pathname + target.search, method,
      headers: pairs.flat(), servername: target.hostname, agent: false,
      ...(socket ? { createConnection: () => socket } : {}),
    });
    const headerTimer = setTimeout(() => req.destroy(new Error(`no answer from ${target.hostname} within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    const abort = () => req.destroy(signal.reason ?? new Error('request aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    req.on('error', (error) => { clearTimeout(headerTimer); signal?.removeEventListener('abort', abort); reject(error); });
    req.on('response', (res) => {
      clearTimeout(headerTimer);
      res.setTimeout(idleTimeoutMs, () => res.destroy(new Error(`${target.hostname} stopped sending for ${Math.round(idleTimeoutMs / 1000)} s`)));
      res.on('close', () => signal?.removeEventListener('abort', abort));
      const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
      const stream = encoding === 'gzip' ? res.pipe(createGunzip()) : encoding === 'deflate' ? res.pipe(createInflate()) : encoding === 'br' ? res.pipe(createBrotliDecompress()) : res;
      if (stream !== res) res.on('error', (e) => stream.destroy(e));
      const responseHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (k !== 'content-encoding' && k !== 'content-length') responseHeaders.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      const status = res.statusCode ?? 0;
      const empty = status === 204 || status === 304 || method === 'HEAD';
      resolve(new Response(empty ? null : Readable.toWeb(stream), { status: status >= 200 && status <= 599 ? status : 502, headers: responseHeaders }));
    });
    if (data) req.write(data);
    req.end();
  });
}

const jsonHeaders = (access) => ({ 'User-Agent': USER_AGENT, Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' });

/** POST JSON sur chaque point d'accès jusqu'à une réponse ; une erreur client (4xx hors 404/429) ne change pas de point d'accès. */
async function postEndpoints(path, access, payload, { timeoutMs = 15_000, endpoints = ENDPOINTS } = {}) {
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      const res = await request(`${endpoint}/${path}`, { headers: jsonHeaders(access), body: JSON.stringify(payload), timeoutMs });
      if (res.ok) return await res.json();
      const text = (await res.text()).slice(0, 300);
      errors.push(Object.assign(new Error(`${path} ${res.status} at ${endpoint}: ${text}`), { status: res.status }));
      if (res.status < 500 && res.status !== 404 && res.status !== 429) break;
    } catch (error) {
      errors.push(error);
    }
  }
  const last = errors.at(-1);
  throw Object.assign(new Error(errors.map((e) => e.message).join('; ')), { status: last?.status, cause: last?.cause ?? last });
}

// ---------- OAuth ----------

/** Adresse de connexion Google, avec le vérificateur PKCE porté par `state`. */
export function authorizeUrl() {
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT_URI, scope: SCOPES.join(' '),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    state: Buffer.from(JSON.stringify({ verifier, projectId: '' })).toString('base64url'), access_type: 'offline', prompt: 'consent',
  }).toString();
  return url.toString();
}

const expiry = (start, seconds) => start + (Number(seconds) > 0 ? Number(seconds) : 3600) * 1000;

async function tokenRequest(params) {
  const start = Date.now();
  const res = await request('https://oauth2.googleapis.com/token', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: '*/*', 'User-Agent': USER_AGENT },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }).toString(), timeoutMs: 30_000,
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(text.slice(0, 400) || `token request failed (${res.status})`), { status: res.status });
  const payload = JSON.parse(text);
  return { ...payload, expires: expiry(start, payload.expires_in) };
}

/** Échange le code de retour : { refresh, access, expires, email } ; `refresh` contient aussi le projet. */
export async function exchangeCode(code, state) {
  const { verifier } = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
  const token = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI, code_verifier: verifier });
  if (!token.refresh_token) throw new Error('Google returned no refresh token');
  let email;
  try {
    const res = await request('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', { method: 'GET', headers: { Authorization: `Bearer ${token.access_token}`, 'User-Agent': USER_AGENT }, timeoutMs: 15_000 });
    if (res.ok) email = (await res.json()).email;
  } catch { /* l'adresse sert d'étiquette ; sans elle, l'appelant en fabrique une */ }
  const project = await loadProject(token.access_token).then((p) => p.id, () => '');
  return { refresh: formatRefresh({ refreshToken: token.refresh_token, projectId: project }), access: token.access_token, expires: token.expires, email };
}

/** Nouveau jeton d'accès depuis le jeton de rafraîchissement. */
export async function refreshAccess(refreshToken) {
  const token = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  return { access: token.access_token, refresh: token.refresh_token ?? refreshToken, expires: token.expires };
}

/** Le jeton enregistré porte « jeton|projet|projet géré » (format partagé avec les comptes déjà connectés). */
export function parseRefresh(refresh = '') {
  const [refreshToken = '', projectId = '', managedProjectId = ''] = refresh.split('|');
  return { refreshToken, projectId: projectId || undefined, managedProjectId: managedProjectId || undefined };
}
export function formatRefresh({ refreshToken, projectId, managedProjectId }) {
  return `${refreshToken}|${projectId ?? ''}${managedProjectId ? `|${managedProjectId}` : ''}`;
}
export const tokenExpired = (auth) => !auth.access || typeof auth.expires !== 'number' || auth.expires <= Date.now() + 60_000;

// ---------- projet Cloud Code ----------

const METADATA = { ideType: 'ANTIGRAVITY' };

/** Projet géré du compte selon loadCodeAssist : { id, tier }. */
async function loadProject(access) {
  const data = await postEndpoints('v1internal:loadCodeAssist', access, { metadata: METADATA }, { timeoutMs: 10_000 });
  const id = typeof data.cloudaicompanionProject === 'string' ? data.cloudaicompanionProject : data.cloudaicompanionProject?.id;
  const tier = (data.allowedTiers ?? []).find((t) => t?.isDefault)?.id ?? data.allowedTiers?.[0]?.id ?? 'free-tier';
  return { id: id || '', tier };
}

/** Inscrit le compte et attend son projet géré (opération longue, interrogée toutes les 5 s). */
async function onboard(access, tierId) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const data = await postEndpoints('v1internal:onboardUser', access, { tierId }, { endpoints: [ENDPOINTS[1], ENDPOINTS[0]] }).catch(() => null);
    if (!data) return '';
    if (data.done) return data.response?.cloudaicompanionProject?.id ?? '';
    await new Promise((r) => setTimeout(r, 5000));
  }
  return '';
}

const projectCache = new Map(); // jeton de rafraîchissement → { at, value }

/**
 * Projet à mettre dans chaque appel. Rend aussi `refresh` mis à jour quand un projet géré vient d'être trouvé,
 * pour l'enregistrer et ne plus le chercher.
 */
export async function projectFor(auth) {
  const parts = parseRefresh(auth.refresh);
  if (parts.managedProjectId) return { project: parts.managedProjectId, refresh: auth.refresh };
  const hit = projectCache.get(parts.refreshToken);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.value;
  let managed = '';
  try {
    const loaded = await loadProject(auth.access);
    managed = loaded.id || (await onboard(auth.access, loaded.tier));
  } catch { /* Cloud Code injoignable : projet connu ou partagé, l'appel dira la vraie erreur */ }
  const value = managed
    ? { project: managed, refresh: formatRefresh({ ...parts, managedProjectId: managed }) }
    : { project: parts.projectId || DEFAULT_PROJECT, refresh: auth.refresh };
  projectCache.set(parts.refreshToken, { at: Date.now(), value });
  return value;
}

// ---------- catalogue et quotas ----------

/** Catalogue des modèles que Google propose au compte (fetchAvailableModels), tel quel. */
export async function fetchCatalog(access, project) {
  try {
    return await postEndpoints('v1internal:fetchAvailableModels', access, project ? { project } : {});
  } catch (error) {
    if (error.status === 403 && project) return postEndpoints('v1internal:fetchAvailableModels', access, {});
    throw error;
  }
}

/** Résumé des quotas par fenêtre (retrieveUserQuotaSummary). */
export const fetchQuotaSummary = (access, project) => postEndpoints('v1internal:retrieveUserQuotaSummary', access, { project });

/** Quota par modèle tiré du catalogue, quand le résumé par fenêtre manque. */
export function perModelQuota(catalog) {
  return Object.entries(catalog?.models ?? {})
    .filter(([, m]) => m.quotaInfo && m.displayName && !m.isInternal)
    .map(([modelId, m]) => ({ modelId, displayName: m.displayName, remainingFraction: Math.max(0, Math.min(1, Number(m.quotaInfo.remainingFraction ?? 0))), resetTime: m.quotaInfo.resetTime }));
}

// ---------- requêtes de génération ----------

/**
 * Réglage de raisonnement d'un id Google, tel qu'Antigravity le comprend :
 * Argon et Claude 5.x reçoivent leur niveau, Gemini Flash Medium et Low leur plafond de réflexion.
 * Gemini Flash High garde le réglage d'Antigravity (mesuré dans bench/ : un budget illimité triple le temps sans gain).
 */
export function thinkingFor(model) {
  const [, level] = /-(low|medium|high)$/.exec(model) ?? [];
  if (!level) return undefined;
  if (/^gemini-4-argon/.test(model)) return { includeThoughts: true, thinkingLevel: level.toUpperCase() };
  if (/^claude-.*-5-\d+-/.test(model)) return { includeThoughts: true, thinkingBudget: 0, thinkingLevel: level.toUpperCase() };
  if (/^gemini-.*flash/.test(model)) return { includeThoughts: true, ...(level === 'medium' ? { thinkingBudget: 4000 } : level === 'low' ? { thinkingBudget: 1000 } : {}) };
  return undefined;
}

const fnv1a64 = (text) => {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(text)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return BigInt.asIntN(64, hash).toString();
};

/**
 * Identifiants de session à la manière de l'agent Antigravity : une conversation garde la même session et le même
 * fil, ce qui permet à Google de relire son cache. Une entrée par clé, oubliée après 24 h sans usage.
 */
export class Sessions {
  #entries = new Map();
  begin(key) {
    const now = Date.now();
    for (const [k, v] of this.#entries) if (now - v.used > 24 * 3600_000) this.#entries.delete(k);
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { conversation: randomUUID(), trajectory: randomUUID(), session: fnv1a64(`dsh:${key}`), step: 0, used: now };
      this.#entries.set(key, entry);
    }
    entry.used = now;
    entry.step += 1;
    return { sessionId: entry.session, requestId: `agent/${entry.conversation}/${now}/${entry.trajectory}/${entry.step}` };
  }
}
