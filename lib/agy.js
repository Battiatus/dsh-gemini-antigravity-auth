// Client Antigravity (« agy ») : connexion OAuth Google, jetons, appels Gemini via v1internal.
// Canal non officiel : Google a déjà banni des comptes branchés ainsi dans des outils tiers.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import dns from 'node:dns';
import tls from 'node:tls';
import {
  CALLBACK_PORT, ENDPOINTS, Sessions, USER_AGENT, authorizeUrl, exchangeCode, fetchCatalog, fetchQuotaSummary, formatRefresh,
  parseRefresh, perModelQuota, projectFor, refreshAccess, request as httpsRequest, thinkingFor, tokenExpired,
} from './google.js';

export { CALLBACK_PORT };

/**
 * Fait confiance aux certificats du système (magasin Windows, trousseau macOS, /etc/ssl Linux) en plus de ceux de Node.
 * Sans cela, un antivirus ou un proxy d'entreprise qui inspecte HTTPS fait échouer chaque appel (« fetch failed »),
 * alors que le navigateur, qui lit ce magasin, fonctionne. Sans effet sur un Node trop ancien (< 22.19 / 24.5).
 */
export function trustSystemCertificates() {
  if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return false;
  try {
    tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])]);
    return true;
  } catch {
    return false;
  }
}
trustSystemCertificates();

const ANTIGRAVITY_HOST = /(^|[.-])cloudcode-pa\.googleapis\.com$/i; // cloudcode-pa et daily-cloudcode-pa
const LOOPBACK = /^(127\.|0\.0\.0\.0$|::1$|::ffff:127\.)/;

/**
 * Un outil tiers (relais Antigravity local, bloqueur) peut envoyer cloudcode-pa.googleapis.com sur 127.0.0.1
 * via le fichier hosts ; sans ce relais, tout échoue (ECONNREFUSED 127.0.0.1:443). Pour ces seuls noms, et seulement
 * s'ils pointent sur la machine, on demande la vraie adresse aux serveurs DNS du système. Le reste de la résolution,
 * et le fichier hosts, ne changent pas. Agit sur dns.lookup, que suivent les connexions de Node et de la bibliothèque.
 */
export function bypassLoopbackRedirect() {
  if (dns.lookup.agyBypass) return;
  dns.lookup = redirectAwareLookup(dns.lookup, new dns.Resolver());
}

/** dns.lookup qui, pour les hôtes Antigravity redirigés sur la machine, rend l'adresse donnée par `resolver`. */
export function redirectAwareLookup(base, resolver) {
  const lookup = function (hostname, options, callback) {
    if (typeof options === 'function') [callback, options] = [options, {}];
    if (typeof options === 'number') options = { family: options };
    options ??= {};
    if (!ANTIGRAVITY_HOST.test(String(hostname))) return base.call(dns, hostname, options, callback);
    base.call(dns, hostname, options, (error, address, family) => {
      const found = options.all ? address : [{ address, family }];
      if (error || !found?.length || !found.every((a) => LOOPBACK.test(a.address))) return callback(error, address, family);
      const answer = (ips, fam) => (options.all ? callback(null, ips.map((ip) => ({ address: ip, family: fam }))) : callback(null, ips[0], fam));
      resolver.resolve4(hostname, (e4, v4) => {
        if (!e4 && v4?.length) return answer(v4, 4);
        resolver.resolve6(hostname, (e6, v6) => (!e6 && v6?.length ? answer(v6, 6) : callback(error, address, family)));
      });
    });
  };
  lookup.agyBypass = true;
  return lookup;
}
bypassLoopbackRedirect();

export const DEFAULT_ACCOUNT_PATH = join(homedir(), '.dsh/agy-multimodal/accounts.json');
export const MAX_REQUEST_BYTES = 48e6; // au-delà, le serveur refuse les données en ligne (limite reprise de dsh-antigravity-auth)

// Types acceptés par Gemini en données en ligne (doc Gemini API : image, audio, vidéo, PDF)
export const MEDIA_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif',
  '.wav': 'audio/wav', '.mp3': 'audio/mp3', '.aiff': 'audio/aiff', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.mpeg': 'video/mpeg', '.mpg': 'video/mpg', '.mov': 'video/mov', '.avi': 'video/avi', '.flv': 'video/x-flv',
  '.webm': 'video/webm', '.wmv': 'video/wmv', '.3gp': 'video/3gpp',
  '.pdf': 'application/pdf',
};

export function mediaType(path) {
  const type = MEDIA_TYPES[extname(path).toLowerCase()];
  if (!type) throw new Error(`unsupported format: ${extname(path) || path} (accepted: ${Object.keys(MEDIA_TYPES).join(' ')})`);
  return type;
}

/**
 * Ce que Google propose à ce compte, tel quel (fetchAvailableModels) : aucun tri ni filtre de notre part.
 * - `models` : la liste du sélecteur d'Antigravity (`agentModelSorts`), dans son ordre, avec les noms de Google ;
 *   seuls les modèles que Google marque `disabled` (« Unavailable » pour ce forfait) sont écartés, car tout appel échouerait.
 * - `defaultModel`, `webSearchModel` : les modèles que Google désigne pour l'agent et pour la recherche web.
 */
export function offeredModels({ models: available = {}, agentModelSorts, defaultAgentModelId, webSearchModelIds, imageGenerationModelIds } = {}) {
  const ids = agentModelSorts
    ? agentModelSorts.flatMap((s) => s.groups ?? []).flatMap((g) => g.modelIds ?? [])
    : Object.keys(available).filter((id) => available[id].displayName && !available[id].isInternal); // repli si Google ne trie plus
  // Google publie un id par niveau de raisonnement (gemini-3.8-flash-high, -medium, -low) : on les regroupe en un modèle
  // à niveaux, comme le sélecteur de raisonnement de DSH les attend. Un id sans suffixe de niveau reste seul.
  const families = new Map();
  for (const id of [...new Set(ids)].filter((x) => available[x] && !available[x].disabled)) {
    const m = available[id];
    const [, base, level] = /^(.+)-(minimal|low|medium|high)$/.exec(id) ?? [null, id, null];
    const family = families.get(base) ?? { id: base, name: (m.displayName ?? id).replace(/\s*\((minimal|low|medium|high)\)\s*$/i, ''), images: false, limit: { context: 0, output: 0 }, efforts: [] };
    family.images ||= m.supportsImages === true;
    family.limit = { context: Math.max(family.limit.context, m.maxTokens ?? 0) || undefined, output: Math.max(family.limit.output, m.maxOutputTokens ?? 0) || undefined };
    family.efforts.push({ id: level, wire: id });
    families.set(base, family);
  }
  const ORDER = ['minimal', 'low', 'medium', 'high'];
  const models = [...families.values()].map((f) => {
    const efforts = f.efforts.filter((e) => e.id).sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
    if (efforts.length === 0) return { ...f, efforts: [], wire: f.efforts[0].wire };
    // niveau par défaut : celui que Google choisit pour l'agent, sinon le plus élevé
    const preferred = efforts.find((e) => e.wire === defaultAgentModelId) ?? efforts.at(-1);
    return { ...f, efforts, defaultEffort: preferred.id, wire: preferred.wire };
  });
  return {
    models, defaultModel: defaultAgentModelId ?? models[0]?.wire, webSearchModel: webSearchModelIds?.[0] ?? defaultAgentModelId,
    imageModel: imageGenerationModelIds?.find((id) => available[id] && !available[id].disabled),
  };
}

/** Id Google à appeler pour un modèle regroupé et un niveau de raisonnement (le niveau par défaut s'il est absent ou inconnu). */
export function wireModel(model, effort) {
  return model.efforts.find((e) => e.id === effort)?.wire ?? model.wire;
}

/** Texte de la réponse, sans les parties de raisonnement (`thought`). v1internal enveloppe la réponse dans `response`. */
export function textOf(reply) {
  const parts = (reply.response ?? reply).candidates?.[0]?.content?.parts ?? [];
  return parts.filter((p) => !p.thought && p.text).map((p) => p.text).join('');
}

/** Sources web citées par l'ancrage Google Search : [{ title, uri }], sans doublon. */
export function sourcesOf(reply) {
  const chunks = (reply.response ?? reply).candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const seen = new Map();
  for (const { web } of chunks) if (web?.uri && !seen.has(web.uri)) seen.set(web.uri, { title: web.title ?? web.uri, uri: web.uri });
  return [...seen.values()];
}

/** Objets JSON d'un flux SSE (`data: {...}` suivis d'une ligne vide), dans l'ordre. */
export async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const data = buffer.slice(0, end).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      buffer = buffer.slice(end + 2);
      if (data) yield JSON.parse(data);
    }
  }
  const tail = buffer.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
  if (tail) yield JSON.parse(tail);
}

/** Cause réseau lisible : « fetch failed » seul ne dit pas si c'est le DNS, un proxy ou un certificat d'entreprise. */
export function networkCause(error) {
  const root = error?.cause ?? error;
  const code = root?.code ?? '';
  const local = ['127.0.0.1', '::1', '0.0.0.0'].includes(root?.address);
  const hint = local ? ' (Google\'s address points to this computer: remove the googleapis.com line from the hosts file, or turn off the DNS blocker or local proxy that redirects it)'
    : /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code) ? ' (a proxy or antivirus is intercepting HTTPS: set NODE_EXTRA_CA_CERTS to its certificate)'
    : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? ' (DNS cannot resolve Google: check the network or VPN)'
      : code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' ? ' (connection blocked: firewall, VPN or a proxy to set in HTTPS_PROXY)'
        : '';
  return `${root?.message ?? String(error)}${code && !String(root?.message).includes(code) ? ` [${code}]` : ''}${hint}`;
}

/** Réessaie une opération de fichier que Windows refuse un instant (fichier ouvert par un antivirus ou l'indexeur). */
async function withRetry(op, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      return await op();
    } catch (error) {
      if (i >= tries || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * i));
    }
  }
}

/** Ouvre `url` dans le navigateur de cette machine ; sans navigateur (serveur sans écran), ne fait rien : le lien affiché suffit. */
export function openBrowser(url) {
  const [cmd, ...args] = process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler'] : ['xdg-open'];
  const child = spawn(cmd, [...args, url], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

/** Une erreur réseau devient lisible (DNS, certificat, connexion bloquée) ; une erreur HTTP passe telle quelle. */
const readable = (promise) => promise.catch((error) => {
  if (error.status) throw error;
  throw Object.assign(new Error(networkCause(error), { cause: error }), { network: true });
});

/** Groupes de quota de retrieveUserQuotaSummary : [{ name, description, windows: [{ window, remainingFraction, resetTime }] }]. */
export function quotaPools(summary) {
  return (summary?.groups ?? []).map((group) => ({
    name: group.displayName ?? 'Models',
    description: group.description,
    windows: (group.buckets ?? []).filter((b) => b.disabled !== true)
      .map((b) => ({ window: b.window, remainingFraction: Math.max(0, Math.min(1, Number(b.remainingFraction ?? 0))), resetTime: b.resetTime }))
      .sort((a, b) => (a.window === '5h' ? -1 : b.window === '5h' ? 1 : 0)),
  })).filter((pool) => pool.windows.length > 0);
}

/** Erreur d'appel lisible : un quota épuisé donne l'heure de remise à zéro, une saturation est marquée à réessayer. */
export function callFailure(status, text) {
  let detail = text.slice(0, 600);
  let message;
  try {
    const error = JSON.parse(text).error ?? {};
    detail = error.message ?? detail;
    const reason = (error.details ?? []).map((d) => d.reason).find(Boolean) ?? error.status;
    const delay = (error.details ?? []).map((d) => d.retryDelay).find(Boolean);
    if (status === 429 && !/capacity/i.test(`${reason} ${detail}`)) {
      message = `Antigravity quota reached for this model${delay ? `, retry in about ${formatDelay(delay)}` : ''}. Switch model or account in Settings › Antigravity. (${detail})`;
    }
  } catch { /* corps non JSON : le texte brut sert de détail */ }
  const retryable = status === 503 || status === 529 || (status === 429 && /capacity|overloaded/i.test(text));
  return Object.assign(new Error(message ?? `Antigravity ${status}: ${detail}`), { status, retryable });
}

const formatDelay = (delay) => {
  const s = Math.ceil(parseFloat(delay));
  return s >= 3600 ? `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`;
};

const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

export class Agy {
  #login = null; // connexion Google en cours
  #sessions = new Sessions();
  #maxOutput = new Map(); // id Google → maxOutputTokens du dernier catalogue lu

  /** Comptes dans `accountPath` : { active: email, accounts: { [email]: { refresh, access, expires, email } } }. */
  constructor(accountPath = DEFAULT_ACCOUNT_PATH) {
    this.accountPath = accountPath;
  }

  // Seul un fichier absent vaut « aucun compte ». Toute autre erreur (fichier verrouillé par un antivirus sous Windows,
  // droits, JSON abîmé) remonte : la traiter comme vide ferait écraser tous les comptes à la prochaine écriture.
  async #load() {
    let text;
    try {
      text = await withRetry(() => readFile(this.accountPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { active: null, accounts: {} };
      throw new Error(`cannot read ${this.accountPath}: ${error.message}`, { cause: error });
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`${this.accountPath} is damaged (${error.message}): fix or delete it, then sign in again`, { cause: error });
    }
  }

  // écriture atomique : un fichier à moitié écrit ferait perdre tous les jetons
  async #store(data) {
    await mkdir(dirname(this.accountPath), { recursive: true, mode: 0o700 });
    const tmp = `${this.accountPath}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await withRetry(() => rename(tmp, this.accountPath));
  }

  async #save({ refresh, access, expires, email }) {
    const data = await this.#load();
    data.accounts[email] = { refresh, access, expires, email };
    await this.#store(data);
  }

  /** Comptes connectés, sans les jetons : [{ email, active, expires }]. */
  async accounts() {
    const { active, accounts } = await this.#load();
    return Object.values(accounts).map(({ email, expires }) => ({ email, active: email === active, expires }));
  }

  /** Compte actif, ou null. */
  async account() {
    return (await this.accounts()).find((a) => a.active) ?? null;
  }

  async use(email) {
    const data = await this.#load();
    if (!data.accounts[email]) throw new Error(`unknown account: ${email}`);
    await this.#store({ ...data, active: email });
  }

  /** Retire un compte de cette machine ; si c'était l'actif, le suivant prend sa place. */
  async remove(email) {
    const data = await this.#load();
    delete data.accounts[email];
    if (data.active === email) data.active = Object.keys(data.accounts)[0] ?? null;
    await this.#store(data);
  }

  /**
   * Lance une connexion Google : rend { url, done } sans attendre.
   * Google renvoie le navigateur sur 127.0.0.1:51121 ; si ce navigateur est sur un autre appareil (ou le port pris),
   * l'utilisateur colle l'adresse de la page d'arrivée dans finishLogin. Une seule connexion à la fois : la précédente est annulée.
   */
  async beginLogin({ timeoutMs = 10 * 60_000 } = {}) {
    this.#login?.cancel();
    const url = authorizeUrl();
    const state = new URL(url).searchParams.get('state');
    let settle;
    const code = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const server = createServer((req, res) => {
      if (!req.url.startsWith('/oauth-callback')) return res.writeHead(404).end();
      const reply = (text) => res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
      try { login.accept(new URL(req.url, 'http://localhost').searchParams); } catch (error) { return reply(`Sign-in failed: ${error.message}`); }
      login.done.then( // la page dit le vrai résultat, une fois le code échangé chez Google
        ({ email }) => reply(`Signed in as ${email}. You can close this tab and go back to DeepSeek Harness.`),
        (error) => reply(`Sign-in failed: ${error.message}. Start again from DeepSeek Harness.`));
    });
    server.on('error', () => {}); // port pris (autre outil Antigravity) : le collage de l'adresse reste possible
    server.listen(CALLBACK_PORT, '127.0.0.1');
    const timer = setTimeout(() => settle.reject(new Error('sign-in timed out: start it again')), timeoutMs);
    const login = {
      url,
      /** Paramètres de l'adresse de retour : refuse ceux d'une autre tentative sans clore celle-ci. */
      accept(params) {
        if (params.get('error')) return settle.reject(new Error(`Google refused the sign-in (${params.get('error')})`));
        if (!params.get('code')) throw new Error('this address has no sign-in code: copy the full address of the page Google sent you to');
        if (params.get('state') !== state) throw new Error('this address belongs to another sign-in attempt: start again');
        settle.resolve(params.get('code'));
      },
      cancel: () => settle.reject(new Error('sign-in cancelled')),
    };
    this.#login = login;
    login.done = code.then(async (value) => {
      const result = await readable(exchangeCode(value, state)).catch((error) => {
        throw new Error(/invalid_grant/.test(error.message)
          ? 'Google refused the sign-in code (expired, already used or incomplete). Start the sign-in again'
          : `Google refused the sign-in: ${error.message}`);
      });
      const email = result.email ?? `account-${Date.now()}`; // l'adresse sert de clé ; Google la renvoie normalement
      await this.#save({ ...result, email });
      await this.#store({ ...await this.#load(), active: email });
      return { email };
    }).finally(() => {
      clearTimeout(timer);
      server.close();
      if (this.#login === login) this.#login = null;
    });
    login.done.catch(() => {}); // l'appelant lit `done` ; pas de rejet non géré s'il ne le fait pas
    return { url, done: login.done };
  }

  /** Termine la connexion en cours avec l'adresse de la page où Google a renvoyé le navigateur (ou sa seule partie ?code=…). */
  async finishLogin(address) {
    if (!this.#login) throw new Error('no sign-in in progress: start one first');
    const text = String(address).trim();
    this.#login.accept(new URL(text.startsWith('?') ? text : text.includes('://') ? text : `?${text}`, 'http://localhost').searchParams);
    return this.#login.done;
  }

  cancelLogin() {
    this.#login?.cancel();
  }

  /** Jeton d'accès et projet d'un compte (l'actif par défaut), rafraîchis au besoin. */
  async credentials(email, { force = false } = {}) {
    const { active, accounts } = await this.#load();
    let auth = accounts[email ?? active];
    if (!auth) throw new Error('no Antigravity account: run /agy login');
    if (force || tokenExpired(auth)) {
      const parts = parseRefresh(auth.refresh);
      const fresh = await readable(refreshAccess(parts.refreshToken));
      auth = { ...auth, access: fresh.access, expires: fresh.expires, refresh: formatRefresh({ ...parts, refreshToken: fresh.refresh }) };
      await this.#save(auth);
    }
    const { project, refresh } = await projectFor(auth);
    if (refresh !== auth.refresh) await this.#save({ ...auth, refresh }); // projet géré trouvé : retenu pour la suite
    return { access: auth.access, project };
  }

  /**
   * Un appel Gemini. `request` suit generateContent (contents, systemInstruction, tools, generationConfig).
   * `stream: true` renvoie la Response SSE brute (streamGenerateContent?alt=sse) ; sinon le JSON de la réponse.
   */
  async call(model, request, { stream = false, signal, sessionKey, autoThinking = true } = {}) {
    // `model` est un id du compte (fetchAvailableModels) : envoyé tel quel
    const generationConfig = { ...request.generationConfig };
    // sans plafond explicite, celui que Google annonce pour ce modèle (le défaut du serveur couperait les longues réponses)
    if (generationConfig.maxOutputTokens === undefined && this.#maxOutput.has(model)) generationConfig.maxOutputTokens = this.#maxOutput.get(model);
    // niveau de raisonnement de l'id et texte du raisonnement pour DSH (voir thinkingFor)
    const thinking = autoThinking && !generationConfig.thinkingConfig ? thinkingFor(model) : undefined;
    if (thinking) generationConfig.thinkingConfig = thinking;
    // métadonnées de session de l'agent Antigravity : une conversation garde le même identifiant (cache côté Google)
    const meta = this.#sessions.begin(sessionKey ?? `call-${randomUUID()}`);
    const { contents, systemInstruction, tools, toolConfig, ...rest } = request;
    const payload = { contents, systemInstruction, tools, toolConfig, ...rest, generationConfig, sessionId: meta.sessionId };
    for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
    const path = stream ? 'v1internal:streamGenerateContent?alt=sse' : 'v1internal:generateContent';
    for (let attempt = 1, refreshed = false; ; attempt++) {
      const { access, project } = await this.credentials(undefined, { force: refreshed });
      const body = JSON.stringify({ project, model, request: payload, requestType: 'agent', userAgent: 'antigravity', requestId: meta.requestId });
      if (body.length > MAX_REQUEST_BYTES) {
        throw new Error(`request is ${(body.length / 1e6).toFixed(1)} MB, limit ${MAX_REQUEST_BYTES / 1e6} MB: use a smaller file`);
      }
      let failure;
      for (const endpoint of ENDPOINTS) {
        const res = await readable(httpsRequest(`${endpoint}/${path}`, {
          headers: { 'User-Agent': USER_AGENT, Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' },
          body, signal, timeoutMs: 600_000, idleTimeoutMs: 600_000,
        }));
        if (res.ok) return stream ? res : res.json();
        failure = callFailure(res.status, await res.text());
        if (res.status !== 404 && res.status < 500) break; // erreur du client : l'autre point d'accès répondra pareil
      }
      // jeton refusé avant son expiration (révoqué, horloge décalée) : un rafraîchissement forcé, une fois
      if (failure.status === 401 && !refreshed) { refreshed = true; continue; }
      // serveur saturé : on réessaie après une pause croissante ; un quota épuisé, lui, ne se réessaie pas
      if (failure.retryable && attempt < 3) { await pause(2000 * 3 ** (attempt - 1), signal); continue; }
      throw failure;
    }
  }

  /** Quota restant d'un compte : groupe Gemini et chaque modèle, chacun { remainingFraction 0..1, resetTime ISO }. */
  async quota(email) {
    const { access, project } = await this.credentials(email);
    try {
      // fenêtres de quota telles que Google les montre dans Antigravity : un groupe par famille, 5 h et semaine
      const pools = quotaPools(await readable(fetchQuotaSummary(access, project)));
      if (pools.length) return { pools };
    } catch { /* compte ou serveur sans résumé par fenêtre : quota par modèle */ }
    return { pools: [], models: perModelQuota(await this.#available(email)) };
  }

  /** Modèles que Google propose au compte actif (voir offeredModels). */
  async models() {
    return offeredModels(await this.#available());
  }

  async #available(email) {
    const { access, project } = await this.credentials(email);
    const catalog = await readable(fetchCatalog(access, project));
    for (const [id, m] of Object.entries(catalog.models ?? {})) if (m.maxOutputTokens) this.#maxOutput.set(id, m.maxOutputTokens);
    return catalog;
  }

  /** Partie `inlineData` pour un fichier local (image, audio, vidéo, PDF). */
  static async filePart(path) {
    const type = mediaType(path);
    const { size } = await stat(path);
    if (size * 4 / 3 > MAX_REQUEST_BYTES) throw new Error(`${path}: ${(size / 1e6).toFixed(1)} MB, too large to send inline`);
    return { inlineData: { mimeType: type, data: (await readFile(path)).toString('base64') } };
  }
}
