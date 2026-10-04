'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractMetaSafe } = require('../lib/workflowMeta');

const script = meta => 'import x from "y";\n' + meta + '\nexport default async function run(ctx) { return 1; }\n';

test('plain object literal: name, description, phases with and without detail', () => {
  const m = extractMetaSafe(script(`export const meta = {
    name: 'agent-rail-research',
    description: "Parallel research of the plugin API",
    phases: [
      { title: 'Research', detail: '4 readers over the type declarations' },
      { title: 'Critic' },
    ],
  };`));
  assert.deepEqual(m, {
    name: 'agent-rail-research', description: 'Parallel research of the plugin API', degraded: false,
    phases: [{ title: 'Research', detail: '4 readers over the type declarations' }, { title: 'Critic', detail: null }],
  });
});

test('comments, trailing commas, quoted keys, numbers and booleans are understood', () => {
  const m = extractMetaSafe(`// header
export const meta = /* inline */ {
  "name": "q", // trailing comment
  description: 'd', /* block
  comment */
  maxAgents: 12, fast: true, off: false, none: null, neg: -3, exp: 1e3,
  phases: [ { title: "A", detail: "x", }, ],
}`);
  assert.equal(m.name, 'q');
  assert.equal(m.description, 'd');
  assert.equal(m.degraded, false);
  assert.deepEqual(m.phases, [{ title: 'A', detail: 'x' }]);
});

test('string concatenation, template literal without ${} and escapes', () => {
  const m = extractMetaSafe(script(
    'export const meta = { name: "wf-" + \'part\' + `two`, description: `line1\\nline2 \\u00e4\\u{1F600} \\x41 \\\' \\\\`, phases: [] };'));
  assert.equal(m.name, 'wf-parttwo');
  assert.equal(m.description, 'line1\nline2 ä\u{1F600} A \' \\');
  assert.equal(m.degraded, false);
  assert.deepEqual(m.phases, []);
});

test('multi-line template literal keeps its newlines', () => {
  const m = extractMetaSafe('export const meta = { name: "n", description: `a\nb` };');
  assert.equal(m.description, 'a\nb');
});

test('phases given as plain strings and unknown fields are normalised', () => {
  const m = extractMetaSafe('export const meta = { name: "n", whenToUse: "later", phases: ["One", { title: "Two", detail: 5 }, { nope: 1 }, 7] };');
  assert.deepEqual(m.phases, [{ title: 'One', detail: null }, { title: 'Two', detail: null }]);
  assert.equal(m.description, null);
});

test('no meta -> null; non-string input -> null', () => {
  assert.equal(extractMetaSafe('export default async () => 1;'), null);
  assert.equal(extractMetaSafe('const meta = { name: "not exported" }'), null);
  assert.equal(extractMetaSafe(''), null);
  assert.equal(extractMetaSafe(undefined), null);
  assert.equal(extractMetaSafe(null), null);
  assert.equal(extractMetaSafe({}), null);
  assert.equal(extractMetaSafe(42), null);
});

test('template literal with ${} is NOT evaluated: degraded fallback reads the plain literals only', () => {
  const m = extractMetaSafe('export const meta = { name: "ok-name", description: `uses ${process.env.HOME}`, phases: [{ title: "P1", detail: "d1" }] };');
  assert.equal(m.degraded, true);
  assert.equal(m.name, 'ok-name');
  assert.deepEqual(m.phases, [{ title: 'P1', detail: 'd1' }]);
  assert.equal(m.description, null);
});

test('hostile literal is never executed (IIFE, call, getter, constructor chain)', () => {
  delete globalThis.PWNED;
  const cases = [
    "export const meta = { name: (()=>{ globalThis.PWNED=1; return 'x' })(), phases: [] }",
    "export const meta = { name: 'a', get description() { globalThis.PWNED = 2; return 'd'; }, phases: [] }",
    "export const meta = { name: [].constructor.constructor('globalThis.PWNED=3')(), phases: [] }",
    "export const meta = { name: 'b', phases: [ (globalThis.PWNED = 4, { title: 'T' }) ] }",
    "export const meta = Object.assign({ name: 'c' }, (globalThis.PWNED = 5))",
    "export const meta = require('child_process').execSync('echo hi')",
  ];
  for (const c of cases) {
    const m = extractMetaSafe(c);
    assert.ok(m === null || m.degraded === true, c);
  }
  assert.equal(globalThis.PWNED, undefined);
});

test('degraded result of the hostile IIFE has no name but keeps the contract shape', () => {
  const m = extractMetaSafe("export const meta = { name: (()=>{ globalThis.PWNED=1; return 'x' })(), phases: [] }");
  assert.deepEqual(m, { name: null, description: null, phases: [], degraded: true });
});

test('references to constants fall back to the degraded reader (SPEC 5.2: constants in meta)', () => {
  const m = extractMetaSafe('const N = "x";\nexport const meta = { name: "refs", description: N, phases: [{ title: "Only", detail: "d" }] };');
  assert.equal(m.degraded, true);
  assert.equal(m.name, 'refs');
  assert.deepEqual(m.phases, [{ title: 'Only', detail: 'd' }]);
});

test('"__proto__" key does not pollute and does not change the result', () => {
  const m = extractMetaSafe('export const meta = { "__proto__": { polluted: true }, name: "n", phases: [] };');
  assert.equal(m.name, 'n');
  assert.equal(({}).polluted, undefined);
  assert.equal(m.degraded, false);
});

test('torn, unterminated or deeply nested input never throws', () => {
  for (const s of [
    'export const meta = { name: "unterminated',
    'export const meta = { name: "n", phases: [ { title: "a"',
    'export const meta = ',
    'export const meta = {',
    'export const meta = { name: "n" /* never closed',
    'export const meta = ' + '['.repeat(50000),
    'export const meta = ' + '{a:'.repeat(20000),
  ]) {
    const m = extractMetaSafe(s);
    assert.ok(m === null || typeof m === 'object');
    if (m) { assert.equal(typeof m.degraded, 'boolean'); assert.ok(Array.isArray(m.phases)); }
  }
});

test('only the first `export const meta` counts and CRLF scripts parse', () => {
  const m = extractMetaSafe('export const meta = { name: "first", phases: [] };\r\nexport const meta2 = { name: "second" };\r\n');
  assert.equal(m.name, 'first');
  const crlf = extractMetaSafe('export const meta = {\r\n  name: "crlf",\r\n  phases: [\r\n    { title: "A" },\r\n  ],\r\n};\r\n');
  assert.equal(crlf.name, 'crlf');
  assert.deepEqual(crlf.phases, [{ title: 'A', detail: null }]);
});

test('implausibly large sources are rejected without parsing', () => {
  assert.equal(extractMetaSafe('export const meta = { name: "x" };' + ' '.repeat(3 * 1024 * 1024)), null);
});
