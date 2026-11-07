// Traduction entre la conversation DSH et generateContent de Gemini, dans les deux sens.
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { MAX_REQUEST_BYTES, MEDIA_TYPES } from './agy.js';
import { SKIP_THOUGHT_SIGNATURE } from './google.js';
import { toClaudeParameters, toGeminiParameters } from './schema.js';

// Poignée texte que DSH met à la place d'un fichier joint non-image (audio, vidéo, PDF).
const FILE_HANDLE = /\[File "[^"]+" \((\d+) bytes, sha256:([a-f0-9]{64})\): verbatim read-only copy saved at "([^"]+)"\./g;

/** Parties inlineData des fichiers joints cités dans `text`. Un fichier absent, trop lourd ou modifié garde sa poignée texte. */
export async function attachedFiles(text) {
  const parts = [];
  for (const [, bytes, sha256, path] of text.matchAll(FILE_HANDLE)) {
    const mimeType = MEDIA_TYPES[extname(path).toLowerCase()];
    if (!mimeType || Number(bytes) * 4 / 3 > MAX_REQUEST_BYTES) continue;
    const data = await readFile(path).catch(() => null);
    if (data && createHash('sha256').update(data).digest('hex') === sha256) {
      parts.push({ inlineData: { mimeType, data: data.toString('base64') } });
    }
  }
  return parts;
}

const textOf = (blocks) => blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

/** Signatures de raisonnement rendues par Gemini à ce tour, si le tour vient de ce modèle et n'a pas été remanié. */
function signaturesOf(message, provider, model) {
  const state = message.source?.replayState ?? message.replayState;
  const same = state?.provider === provider && state.model === model && Array.isArray(state.signatures)
    && state.kinds?.join() === message.content.map((b) => b.type).join();
  return same ? state.signatures : [];
}

/**
 * Corps generateContent pour un appel DSH. `readImage(ref)` rend { data: Uint8Array, mediaType }.
 */
export async function toRequest(options, wire, readImage) {
  const toolNames = new Map(); // id d'appel → nom de l'outil : functionResponse ne porte que le nom
  const contents = [];
  for (const message of options.messages) {
    if (message.role === 'system') continue;
    let role = 'user';
    const parts = [];
    if (message.role === 'tool') {
      // l'id relie le résultat à son appel : Claude et GPT-OSS (via Antigravity) l'exigent, Gemini l'accepte
      parts.push({ functionResponse: { id: message.toolCallId, name: toolNames.get(message.toolCallId) ?? 'tool', response: { content: textOf(message.content) } } });
    } else if (message.role === 'assistant') {
      role = 'model';
      const signatures = signaturesOf(message, options.provider, options.model);
      message.content.forEach((block, i) => {
        const thoughtSignature = signatures[i];
        const sig = thoughtSignature ? { thoughtSignature } : {};
        if (block.type === 'text' && block.text) parts.push({ text: block.text, ...sig });
        else if (block.type === 'reasoning' && thoughtSignature) parts.push({ text: block.text, thought: true, ...sig });
        else if (block.type === 'tool-call') {
          toolNames.set(block.id, block.name);
          let args = {};
          try { args = JSON.parse(block.arguments || '{}'); } catch { /* arguments tronqués : appel rejoué sans eux */ }
          // sans signature, Gemini 3 refuse un appel d'outil rejoué : ce jeton désactive la vérification
          parts.push({ functionCall: { id: block.id, name: block.name, args }, thoughtSignature: thoughtSignature ?? SKIP_THOUGHT_SIGNATURE });
        }
      });
    } else {
      for (const block of message.content) {
        if (block.type === 'text' && block.text) parts.push({ text: block.text }, ...await attachedFiles(block.text));
        else if (block.type === 'image') {
          const { data, mediaType } = await readImage(block.attachment);
          parts.push({ inlineData: { mimeType: mediaType, data: Buffer.from(data).toString('base64') } });
        }
      }
    }
    if (parts.length === 0) continue;
    // Gemini veut des tours alternés : on fusionne les messages consécutifs du même rôle (résultats d'outils groupés)
    if (contents.at(-1)?.role === role) contents.at(-1).parts.push(...parts);
    else contents.push({ role, parts });
  }

  const request = { contents, generationConfig: {} };
  const system = [options.system, ...options.messages.filter((m) => m.role === 'system').map((m) => textOf(m.content))]
    .filter((s) => s?.trim()).join('\n\n');
  if (system) request.systemInstruction = { parts: [{ text: system }] };
  if (options.maxTokens) request.generationConfig.maxOutputTokens = options.maxTokens;
  if (options.temperature !== undefined) request.generationConfig.temperature = options.temperature;
  if (options.stop?.length) request.generationConfig.stopSequences = options.stop;
  if (options.tools?.length) {
    const claude = /^claude-/i.test(wire);
    request.tools = [{ functionDeclarations: options.tools.map(({ name, description, parameters }) => {
      if (claude) return { name, description, parametersJsonSchema: toClaudeParameters(parameters) ?? { type: 'object', properties: {} } };
      const params = toGeminiParameters(parameters);
      return { name, description, ...(params ? { parameters: params } : {}) };
    }) }];
  }
  return request;
}

const FINISH = { MAX_TOKENS: 'max-tokens' };

/** Échec DSH pour une erreur d'appel : le code décide si DSH réessaie (RATE_LIMIT, SERVER, TRANSPORT…). */
export function failureOf(error) {
  const status = error.status;
  const code = status === 401 || status === 403 ? 'AUTH'
    : status === 429 ? 'RATE_LIMIT'
      : status >= 500 ? 'SERVER'
        : status === 400 && /token count|context window|too long/i.test(error.message) ? 'CONTEXT_WINDOW_EXCEEDED'
          : status ? 'INVALID_REQUEST'
            : /no Antigravity account/.test(error.message) ? 'MISSING_CREDENTIAL' : 'TRANSPORT';
  return { message: error.message, code, ...(status ? { status } : {}) };
}

/**
 * Morceaux DSH pour un flux SSE Gemini (objets déjà décodés), terminés par un unique `finish`.
 * Les signatures de raisonnement repartent dans `replayState`, une par bloc dans l'ordre.
 */
export async function* toChunks(events, { provider, model }) {
  const blocks = []; // { type, text, id?, name?, arguments?, signature? }
  let current;
  let usage;
  let finishReason;
  const end = function* () {
    if (!current) return;
    const { type, text, id, name } = current;
    yield { type: 'block-end', index: blocks.length - 1, block: type === 'tool-call' ? { type, id, name, arguments: current.arguments } : { type, text } };
    current = undefined;
  };
  for await (const event of events) {
    const reply = event.response ?? event;
    if (reply.usageMetadata) usage = reply.usageMetadata;
    const candidate = reply.candidates?.[0];
    finishReason = candidate?.finishReason ?? finishReason;
    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall) {
        yield* end();
        current = { type: 'tool-call', id: part.functionCall.id ?? `call_${randomUUID()}`, name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}), signature: part.thoughtSignature };
        blocks.push(current);
        const index = blocks.length - 1;
        yield { type: 'block-start', index, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index, id: current.id, name: current.name, argumentsDelta: current.arguments };
        yield* end();
        continue;
      }
      const type = part.thought ? 'reasoning' : 'text';
      if (!part.text) {
        if (part.thoughtSignature && current) current.signature = part.thoughtSignature;
        continue;
      }
      if (current?.type !== type) {
        yield* end();
        current = { type, text: '' };
        blocks.push(current);
        yield { type: 'block-start', index: blocks.length - 1, blockType: type };
      }
      current.text += part.text;
      if (part.thoughtSignature) current.signature = part.thoughtSignature;
      yield { type: `${type}-delta`, index: blocks.length - 1, text: part.text };
    }
  }
  yield* end();
  if (usage) {
    const outputTokens = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
    yield { type: 'usage', usage: {
      inputTokens: usage.promptTokenCount ?? 0, outputTokens, totalTokens: usage.totalTokenCount ?? (usage.promptTokenCount ?? 0) + outputTokens,
      // jetons relus depuis le cache de Google (même session) : DSH les affiche en « Cache hit »
      ...(usage.cachedContentTokenCount ? { cacheReadTokens: usage.cachedContentTokenCount } : {}),
    } };
  }
  if (blocks.length === 0) {
    // un refus (SAFETY, RECITATION…) ne doit pas être réessayé : seul EMPTY_RESPONSE l'est
    const code = finishReason && finishReason !== 'STOP' ? 'CONTENT_FILTER' : 'EMPTY_RESPONSE';
    yield { type: 'finish', reason: { kind: 'error', failure: { message: `empty response (${finishReason ?? 'no reason'})`, code } } };
    return;
  }
  const kind = FINISH[finishReason] ?? (blocks.some((b) => b.type === 'tool-call') ? 'tool-calls' : 'stop');
  yield { type: 'finish', reason: { kind }, replayState: { provider, model, kinds: blocks.map((b) => b.type), signatures: blocks.map((b) => b.signature ?? null) } };
}
