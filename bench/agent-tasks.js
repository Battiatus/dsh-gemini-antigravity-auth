// Petits projets pour le banc « agent » : plusieurs changements à faire, jugés par node --test.
// Chaque tâche demande de lire, modifier plusieurs fichiers et relancer les tests jusqu'au vert.

export const AGENT_TASKS = [
  {
    id: 'cart',
    request: 'The shopping cart module is unfinished. Make every test in test/ pass: implement the missing functions in src/cart.js, fix the discount bug in src/pricing.js, and add the `removeItem` export described in the tests. Do not change the tests.',
    files: {
      'package.json': '{ "name": "cart", "type": "module", "scripts": { "test": "node --test" } }',
      'src/pricing.js': `export function applyDiscount(total, percent) {
  // BUG: percent is a whole number (10 means 10%)
  return total - total * percent;
}
export const round2 = (n) => Math.round(n * 100) / 100;
`,
      'src/cart.js': `import { applyDiscount, round2 } from './pricing.js';
export function createCart() { return { items: [] }; }
export function addItem(cart, sku, price, qty = 1) {
  // TODO: add qty to an existing line with the same sku instead of a duplicate line
  cart.items.push({ sku, price, qty });
  return cart;
}
export function total(cart, discountPercent = 0) {
  // TODO: sum price * qty, apply the discount, round to cents
  throw new Error('not implemented');
}
`,
      'test/cart.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCart, addItem, total, removeItem } from '../src/cart.js';
import { applyDiscount } from '../src/pricing.js';
test('discount uses whole percents', () => { assert.equal(applyDiscount(200, 10), 180); });
test('same sku merges quantities', () => { const c = createCart(); addItem(c, 'a', 2, 1); addItem(c, 'a', 2, 2); assert.deepEqual(c.items, [{ sku: 'a', price: 2, qty: 3 }]); });
test('total with discount rounds to cents', () => { const c = createCart(); addItem(c, 'a', 9.99, 3); addItem(c, 'b', 0.333, 3); assert.equal(total(c), 30.97); assert.equal(total(c, 10), 27.87); });
test('removeItem removes qty and drops empty lines', () => { const c = createCart(); addItem(c, 'a', 1, 3); removeItem(c, 'a', 2); assert.deepEqual(c.items, [{ sku: 'a', price: 1, qty: 1 }]); removeItem(c, 'a', 5); assert.deepEqual(c.items, []); });
`,
    },
  },
  {
    id: 'text-stats',
    request: 'Finish the text statistics library so that all tests pass. Several functions in src/ are stubs or buggy, and src/index.js must re-export everything the tests import. Run the tests yourself and keep going until they all pass.',
    files: {
      'package.json': '{ "name": "text-stats", "type": "module", "scripts": { "test": "node --test" } }',
      'src/words.js': `export function words(text) {
  // BUG: splits on single spaces only and keeps punctuation and empty strings
  return text.split(' ');
}
`,
      'src/stats.js': `import { words } from './words.js';
export function wordCount(text) { return words(text).length; }
export function topWords(text, n) {
  // TODO: n most frequent lowercase words, ties broken alphabetically, as [word, count] pairs
  return [];
}
export function sentenceCount(text) {
  // TODO: count sentences ending with . ! or ? (ignore empty trailing text)
  return 0;
}
`,
      'src/index.js': `export { words } from './words.js';
`,
      'test/stats.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { words, wordCount, topWords, sentenceCount, readingTime } from '../src/index.js';
const t = 'The cat sat. The dog, the CAT and the bird sat!  Why?';
test('words strips punctuation and spaces', () => { assert.deepEqual(words('Hi,  there!  you'), ['Hi', 'there', 'you']); });
test('wordCount', () => { assert.equal(wordCount(t), 12); });
test('topWords', () => { assert.deepEqual(topWords(t, 3), [['the', 4], ['cat', 2], ['sat', 2]]); });
test('sentenceCount', () => { assert.equal(sentenceCount(t), 3); assert.equal(sentenceCount('No end'), 0); });
test('readingTime at 200 words per minute, rounded up, minimum 1', () => { assert.equal(readingTime(t), 1); assert.equal(readingTime(Array(401).fill('w').join(' ')), 3); });
`,
    },
  },
  {
    id: 'todo-api',
    request: 'The in-memory todo service needs three features to pass the test suite: due-date validation, filtering by status, and an undo of the last change. Implement them in src/todos.js (keep the existing API), make all tests pass, and do not edit the tests.',
    files: {
      'package.json': '{ "name": "todo-api", "type": "module", "scripts": { "test": "node --test" } }',
      'src/todos.js': `export function createStore() { return { todos: [], nextId: 1, history: [] }; }
export function add(store, title, due) {
  const todo = { id: store.nextId++, title, done: false, due: due ?? null };
  store.todos.push(todo);
  return todo;
}
export function complete(store, id) {
  const todo = store.todos.find((t) => t.id === id);
  todo.done = true;
  return todo;
}
`,
      'test/todos.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, add, complete, list, undo } from '../src/todos.js';
test('due must be a valid YYYY-MM-DD date', () => { const s = createStore(); assert.throws(() => add(s, 'x', '2026-13-01'), /due/); assert.throws(() => add(s, 'x', 'tomorrow'), /due/); assert.equal(add(s, 'ok', '2026-02-28').due, '2026-02-28'); });
test('complete on a missing id throws', () => { const s = createStore(); assert.throws(() => complete(s, 42), /not found/); });
test('list filters by status', () => { const s = createStore(); add(s, 'a'); add(s, 'b'); complete(s, 2); assert.deepEqual(list(s, 'open').map((t) => t.title), ['a']); assert.deepEqual(list(s, 'done').map((t) => t.title), ['b']); assert.equal(list(s).length, 2); });
test('undo reverts add and complete, newest first', () => { const s = createStore(); add(s, 'a'); complete(s, 1); undo(s); assert.equal(s.todos[0].done, false); undo(s); assert.equal(s.todos.length, 0); assert.equal(undo(s), false); });
`,
    },
  },
];

// Historique sans rapport ajouté devant la tâche, pour mesurer l'effet d'une longue session (≈ jetons / 4 caractères)
export function filler(tokens) {
  const block = 'Earlier in this session we discussed logging conventions, CI caching, release notes formatting, and a refactor of the settings screen that is already merged. ';
  return block.repeat(Math.ceil((tokens * 4) / block.length));
}
