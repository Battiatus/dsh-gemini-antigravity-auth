#!/usr/bin/env node
// Banc « agent » : le modèle travaille seul sur un petit projet (lire, modifier, lancer les tests) jusqu'à ce qu'il
// s'arrête. On mesure s'il finit vraiment, s'il abandonne en route, et s'il annonce un succès alors que les tests échouent.
// Usage : node bench/agent.js [--only 'libellé 1|libellé 2'] [--steps 25]
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { Agy } from '../lib/agy.js';
import { AGENT_TASKS, filler } from './agent-tasks.js';

export const CONFIGS = [
  { label: 'flash high', model: 'gemini-3.8-flash-high' },
  { label: 'flash high, after 120k tokens of history', model: 'gemini-3.8-flash-high', history: 120_000 },
  { label: 'flash medium', model: 'gemini-3.8-flash-medium' },
  { label: 'claude sonnet 4.6', model: 'claude-sonnet-4-6' },
  { label: 'claude sonnet 5.5 high', model: 'claude-sonnet-5-5-high' },
];

const SYSTEM = 'You are a coding agent working in a project folder. Use the tools to do what the user asks. When you are finished, reply with a short summary of what you did.';
const TOOLS = [{ functionDeclarations: [
  { name: 'list_files', description: 'List the files of the project (recursive).' },
  { name: 'read_file', description: 'Read a file of the project.', parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } }, required: ['path'] } },
  { name: 'write_file', description: 'Create or replace a file of the project with the full new content.', parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' }, content: { type: 'STRING' } }, required: ['path', 'content'] } },
  { name: 'run_tests', description: 'Run the test suite (node --test) and return its output.' },
] }];

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const only = flag('--only')?.split('|');
const maxSteps = Number(flag('--steps') ?? 25);

// Tests lancés dans un Node restreint : lecture et écriture limitées au projet, sans processus enfant
function runTests(dir) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`, '--test', '--test-isolation=none', '--test-reporter=tap'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const pass = Number(/# pass (\d+)/.exec(out)?.[1] ?? 0), fail = Number(/# fail (\d+)/.exec(out)?.[1] ?? 0);
      done({ ok: code === 0 && fail === 0 && pass > 0, pass, fail, out: out.slice(-3500) });
    });
  });
}

async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(p, base)); else out.push(relative(base, p));
  }
  return out.sort();
}

const inside = (dir, path) => { const p = resolve(dir, String(path ?? '')); if (!p.startsWith(dir + '/') && p !== dir) throw new Error('path outside the project'); return p; };

async function tool(dir, name, a = {}) {
  try {
    if (name === 'list_files') return { files: await listFiles(dir) };
    if (name === 'read_file') return { content: await readFile(inside(dir, a.path), 'utf8') };
    if (name === 'write_file') { const p = inside(dir, a.path); await mkdir(dirname(p), { recursive: true }); await writeFile(p, String(a.content ?? '')); return { written: a.path }; }
    if (name === 'run_tests') { const r = await runTests(dir); return { passed: r.pass, failed: r.fail, output: r.out }; }
    return { error: `unknown tool ${name}` };
  } catch (error) {
    return { error: error.message };
  }
}

const agy = new Agy();

async function runTask(config, task) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `agy-agent-${task.id}-`)));
  for (const [p, content] of Object.entries(task.files)) { await mkdir(dirname(join(dir, p)), { recursive: true }); await writeFile(join(dir, p), content); }
  const contents = [];
  if (config.history) contents.push({ role: 'user', parts: [{ text: filler(config.history) }] }, { role: 'model', parts: [{ text: 'Noted.' }] });
  contents.push({ role: 'user', parts: [{ text: task.request }] });
  const key = `agent-${config.label}-${task.id}-${Date.now()}`;
  let steps = 0, toolCalls = 0, finalText = '', error;
  const start = Date.now();
  while (steps < maxSteps) {
    steps++;
    let reply;
    for (let attempt = 1; ; attempt++) {
      try { reply = await agy.call(config.model, { contents, systemInstruction: { parts: [{ text: SYSTEM }] }, tools: TOOLS }, { sessionKey: key, signal: AbortSignal.timeout(300_000) }); break; } catch (e) {
        if (attempt < 4 && (e.status === 429 || e.status >= 500)) { await new Promise((r) => setTimeout(r, 8000 * attempt)); continue; }
        error = e.message.slice(0, 160); break;
      }
    }
    if (!reply) break;
    const parts = (reply.response ?? reply).candidates?.[0]?.content?.parts ?? [];
    contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
    const calls = parts.filter((p) => p.functionCall);
    if (calls.length === 0) { finalText = parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim(); break; }
    toolCalls += calls.length;
    const responses = [];
    for (const { functionCall } of calls) responses.push({ functionResponse: { ...(functionCall.id ? { id: functionCall.id } : {}), name: functionCall.name, response: await tool(dir, functionCall.name, functionCall.args) } });
    contents.push({ role: 'user', parts: responses });
  }
  const final = await runTests(dir);
  const claimed = /all (the )?tests (now )?pass|tests are passing|tests pass|done|completed|implemented/i.test(finalText);
  return {
    task: task.id, ok: final.ok, pass: final.pass, fail: final.fail, steps, toolCalls, seconds: Math.round((Date.now() - start) / 1000),
    // s'est arrêté de lui-même avec des tests en échec (abandon), ou a annoncé un succès faux
    quitEarly: !final.ok && !error && steps < maxSteps, falseClaim: !final.ok && claimed, outOfSteps: !final.ok && steps >= maxSteps, error,
  };
}

const offered = new Set((await agy.models()).models.flatMap((m) => [m.wire, ...m.efforts.map((e) => e.wire)]));
const rows = [];
for (const config of CONFIGS.filter((c) => !only || only.includes(c.label))) {
  if (!offered.has(config.model)) { console.log(`skip ${config.label}: not offered to this account`); continue; }
  const results = [];
  for (const task of AGENT_TASKS) {
    const r = await runTask(config, task);
    results.push(r);
    console.log(`${config.label} · ${task.id}: ${r.ok ? '✓ solved' : `✗ ${r.pass}/${r.pass + r.fail} tests${r.quitEarly ? ', quit early' : ''}${r.falseClaim ? ', claimed success' : ''}${r.outOfSteps ? ', out of steps' : ''}${r.error ? `, error: ${r.error}` : ''}`} (${r.steps} steps, ${r.seconds} s)`);
  }
  rows.push({ config: config.label, solved: `${results.filter((r) => r.ok).length}/${results.length}`, 'quit early': results.filter((r) => r.quitEarly).length, 'false success': results.filter((r) => r.falseClaim).length, 'avg steps': (results.reduce((a, r) => a + r.steps, 0) / results.length).toFixed(1), results });
}
console.table(rows.map(({ results, ...r }) => r));
await mkdir(new URL('./results/', import.meta.url), { recursive: true });
const out = new URL(`./results/agent-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url);
await writeFile(out, JSON.stringify(rows, null, 2));
console.log(`details: ${out.pathname}`);
