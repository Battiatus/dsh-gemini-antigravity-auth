import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKIP_THOUGHT_SIGNATURE } from '../lib/google.js';
import { failureOf, toChunks, toRequest } from '../lib/gemini.js';

const P = { provider: 'agy-mm', model: 'gemini-3.8-flash' };
const text = (t) => ({ type: 'text', text: t });

async function collect(events) {
  const out = [];
  for await (const chunk of toChunks(events, P)) out.push(chunk);
  return out;
}

test('toRequest : système, tours fusionnés, appels rejoués avec leur signature', async () => {
  const replayState = { ...P, kinds: ['reasoning', 'tool-call', 'tool-call'], signatures: ['sigR', 'sigA', null] };
  const request = await toRequest({ ...P, system: 'Sois bref.', maxTokens: 100, messages: [
    { role: 'system', content: [text('En français.')] },
    { role: 'user', content: [text('Quelle heure ?')] },
    { role: 'assistant', source: { replayState }, content: [
      { type: 'reasoning', text: 'je cherche' },
      { type: 'tool-call', id: 'c1', name: 'clock', arguments: '{"tz":"UTC"}' },
      { type: 'tool-call', id: 'c2', name: 'web_search', arguments: '{"q"' }] },
    { role: 'tool', toolCallId: 'c1', content: [text('12:00')] },
    { role: 'tool', toolCallId: 'c2', content: [text('rien')] },
  ], tools: [{ name: 'web_search', description: 'cherche', parameters: { type: 'object', properties: { q: { type: 'string' } } } }] },
  'gemini-3.8-flash-medium', null);

  assert.equal(request.systemInstruction.parts[0].text, 'Sois bref.\n\nEn français.');
  assert.equal(request.generationConfig.maxOutputTokens, 100);
  assert.deepEqual(request.contents.map((c) => c.role), ['user', 'model', 'user']);
  assert.deepEqual(request.contents[1].parts, [
    { text: 'je cherche', thought: true, thoughtSignature: 'sigR' },
    { functionCall: { id: 'c1', name: 'clock', args: { tz: 'UTC' } }, thoughtSignature: 'sigA' },
    { functionCall: { id: 'c2', name: 'web_search', args: {} }, thoughtSignature: SKIP_THOUGHT_SIGNATURE },
  ]);
  assert.deepEqual(request.contents[2].parts.map((p) => [p.functionResponse.id, p.functionResponse.name]), [['c1', 'clock'], ['c2', 'web_search']]);
  // web_search reste un outil déclaré (la bibliothèque l'aurait remplacé par googleSearch)
  assert.equal(request.tools[0].functionDeclarations[0].name, 'web_search');
  assert.equal(request.tools[0].functionDeclarations[0].parameters.type, 'OBJECT');
});

test('toRequest change les types multiples et les items en tuple en anyOf', async () => {
  const request = await toRequest({ ...P, messages: [{ role: 'user', content: [text('?')] }], tools: [{ name: 't', description: 'd', parameters: {
    type: 'object', properties: {
      ids: { type: 'array', items: { type: ['string', 'number'] } },
      pair: { type: 'array', items: [{ type: 'string' }, { type: 'integer' }] },
      opt: { type: ['string', 'null'] },
      paths: { type: 'array', items: { type: ['string', 'array'], items: { type: 'string' } } },
      nested: { type: 'array', items: { items: { type: 'string' } } },
    } } }] }, 'gemini-3.8-flash-medium', null);
  const { properties } = request.tools[0].functionDeclarations[0].parameters;
  // items va dans la branche tableau, et un schéma avec items sans type devient un tableau
  assert.deepEqual(properties.paths.items, { anyOf: [{ type: 'STRING' }, { type: 'ARRAY', items: { type: 'STRING' } }] });
  assert.equal(properties.nested.items.type, 'ARRAY');
  assert.deepEqual(properties.ids.items, { anyOf: [{ type: 'STRING' }, { type: 'NUMBER' }] });
  assert.deepEqual(properties.pair.items, { anyOf: [{ type: 'STRING' }, { type: 'INTEGER' }] });
  assert.deepEqual(properties.opt, { type: 'STRING', nullable: true });
});

test('toRequest ignore les signatures d\'un autre modèle ou d\'un tour remanié', async () => {
  const message = (replayState) => ({ ...P, messages: [{ role: 'assistant', source: { replayState },
    content: [{ type: 'tool-call', id: 'c', name: 'f', arguments: '{}' }] }] });
  for (const state of [{ ...P, model: 'autre', kinds: ['tool-call'], signatures: ['s'] }, { ...P, kinds: ['text'], signatures: ['s'] }]) {
    const request = await toRequest(message(state), 'w', null);
    assert.equal(request.contents[0].parts[0].thoughtSignature, SKIP_THOUGHT_SIGNATURE);
  }
});

test('toRequest joint images et fichiers cités, seulement si l\'empreinte correspond', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-mm-'));
  const audio = join(dir, 'conte.flac');
  await writeFile(audio, 'son');
  const sha = createHash('sha256').update('son').digest('hex');
  const handle = (hash) => `[File "conte.flac" (3 bytes, sha256:${hash}): verbatim read-only copy saved at "${audio}". Use read.]`;
  const request = await toRequest({ ...P, messages: [{ role: 'user', content: [
    text(`Transcris ${handle(sha)}`), text(handle('0'.repeat(64))), { type: 'image', attachment: 'ref1' }] }] },
  'w', async (ref) => ({ data: new TextEncoder().encode(ref), mediaType: 'image/png' }));
  const inline = request.contents[0].parts.filter((p) => p.inlineData).map((p) => p.inlineData);
  assert.deepEqual(inline, [
    { mimeType: 'audio/flac', data: Buffer.from('son').toString('base64') },
    { mimeType: 'image/png', data: Buffer.from('ref1').toString('base64') },
  ]);
});

test('toChunks : raisonnement, texte, appel d\'outil, usage et signatures à rejouer', async () => {
  const ev = (parts, extra = {}) => ({ response: { candidates: [{ content: { parts }, ...extra }] } });
  const chunks = await collect([
    ev([{ text: 'hmm', thought: true, thoughtSignature: 'sigR' }]),
    ev([{ text: 'Bon' }, { text: 'jour' }]),
    ev([{ functionCall: { name: 'f', args: { a: 1 } }, thoughtSignature: 'sigF' }], { finishReason: 'STOP' }),
    { response: { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2, totalTokenCount: 16, cachedContentTokenCount: 8 } } },
  ]);
  const ends = chunks.filter((c) => c.type === 'block-end').map((c) => c.block);
  assert.deepEqual(ends.map((b) => b.type), ['reasoning', 'text', 'tool-call']);
  assert.equal(ends[1].text, 'Bonjour');
  assert.equal(ends[2].arguments, '{"a":1}');
  assert.deepEqual(chunks.find((c) => c.type === 'usage').usage, { inputTokens: 10, outputTokens: 6, totalTokens: 16, cacheReadTokens: 8 });
  const finish = chunks.at(-1);
  assert.equal(finish.reason.kind, 'tool-calls');
  assert.deepEqual(finish.replayState, { ...P, kinds: ['reasoning', 'text', 'tool-call'], signatures: ['sigR', null, 'sigF'] });
  assert.equal(chunks.filter((c) => c.type === 'finish').length, 1);
});

test('toChunks : réponse vide, refus et coupure par longueur', async () => {
  assert.equal((await collect([])).at(-1).reason.failure.code, 'EMPTY_RESPONSE');
  const refused = await collect([{ response: { candidates: [{ finishReason: 'SAFETY' }] } }]);
  assert.equal(refused.at(-1).reason.failure.code, 'CONTENT_FILTER');
  const cut = await collect([{ response: { candidates: [{ content: { parts: [{ text: 'a' }] }, finishReason: 'MAX_TOKENS' }] } }]);
  assert.equal(cut.at(-1).reason.kind, 'max-tokens');
});

test('failureOf classe les erreurs pour la politique de nouvelle tentative de DSH', () => {
  const err = (status, message = 'x') => Object.assign(new Error(message), { status });
  assert.equal(failureOf(err(401)).code, 'AUTH');
  assert.equal(failureOf(err(429)).code, 'RATE_LIMIT');
  assert.equal(failureOf(err(503)).code, 'SERVER');
  assert.equal(failureOf(err(400, 'input token count exceeds')).code, 'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(failureOf(err(400)).code, 'INVALID_REQUEST');
  assert.equal(failureOf(new Error('no Antigravity account: run /agy login')).code, 'MISSING_CREDENTIAL');
  assert.equal(failureOf(new Error('fetch failed')).code, 'TRANSPORT');
});
