'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Tail } = require('../lib/tail');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentview-tail-'));
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } });
let n = 0;
const mk = () => path.join(dir, 'f' + (++n) + '.jsonl');
const line = o => JSON.stringify(o) + '\n';

test('complete lines are returned, a torn last line waits until it is completed', () => {
  const f = mk();
  fs.writeFileSync(f, line({ a: 1 }) + line({ a: 2 }) + '{"a":3');
  const t = new Tail(f);
  let r = t.poll(1e6);
  assert.deepEqual(r.lines, [{ a: 1 }, { a: 2 }]);
  assert.equal(r.loading, false);
  assert.equal(r.reset, false);
  assert.equal(r.missing, false);
  assert.equal(r.changed, true);
  assert.equal(r.badLines, 0);
  assert.equal(r.size, fs.statSync(f).size);
  fs.appendFileSync(f, ',"b":1}\n' + line({ a: 4 }));
  r = t.poll(1e6);
  assert.deepEqual(r.lines, [{ a: 3, b: 1 }, { a: 4 }]);
  assert.equal(r.badLines, 0);
});

test('a final line without trailing newline is never parsed', () => {
  const f = mk();
  fs.writeFileSync(f, '{"a":1}');
  const t = new Tail(f);
  assert.deepEqual(t.poll(1e6).lines, []);
  fs.appendFileSync(f, '\n');
  assert.deepEqual(t.poll(1e6).lines, [{ a: 1 }]);
});

test('unchanged (size, mtime) -> changed:false and no lines; first poll is always changed', () => {
  const f = mk();
  fs.writeFileSync(f, line({ a: 1 }));
  const t = new Tail(f);
  assert.equal(t.poll(1e6).changed, true);
  const r = t.poll(1e6);
  assert.equal(r.changed, false);
  assert.deepEqual(r.lines, []);
  assert.equal(r.bytesRead, 0);
  assert.equal(r.size, fs.statSync(f).size);
  assert.equal(new Tail(mk()).poll(1e6).changed, true);   // missing file on the first poll
});

test('an empty file is a valid, changed-once state', () => {
  const f = mk();
  fs.writeFileSync(f, '');
  const t = new Tail(f);
  const r = t.poll(1e6);
  assert.deepEqual(r.lines, []);
  assert.equal(r.missing, false);
  assert.equal(r.size, 0);
  assert.equal(t.poll(1e6).changed, false);
});

test('multi-byte UTF-8 characters split across read chunks survive', () => {
  const f = mk();
  const objs = [{ s: 'äöü€ ñ 😀 日本語' }, { s: '😀😀😀' }, { s: 'ß' }];
  fs.writeFileSync(f, objs.map(line).join(''));
  const t = new Tail(f);
  const got = [];
  let polls = 0, total = 0;
  for (;;) {
    const r = t.poll(5);                       // 5 bytes cut every character class in half sooner or later
    polls++; total += r.bytesRead;
    assert.ok(r.bytesRead <= 5);
    got.push(...r.lines);
    if (!r.loading) break;
    assert.ok(polls < 500);
  }
  assert.deepEqual(got, objs);
  assert.equal(total, fs.statSync(f).size);
  assert.ok(polls > 5);
});

test('read budget: loading stays true until everything is read; budget 0 reads nothing', () => {
  const f = mk();
  const objs = Array.from({ length: 20 }, (_, i) => ({ i, pad: 'x'.repeat(50) }));
  fs.writeFileSync(f, objs.map(line).join(''));
  const size = fs.statSync(f).size;
  const t = new Tail(f);
  let r = t.poll(0);
  assert.deepEqual(r.lines, []);
  assert.equal(r.loading, true);
  assert.equal(r.bytesRead, 0);
  assert.equal(r.size, size);
  r = t.poll(0);                                // still starved: nothing changes, still loading
  assert.equal(r.loading, true);
  assert.equal(r.changed, false);
  const got = [];
  for (let i = 0; i < 100; i++) {
    r = t.poll(200);
    assert.ok(r.bytesRead <= 200);
    got.push(...r.lines);
    if (!r.loading) break;
  }
  assert.equal(r.loading, false);
  assert.deepEqual(got, objs);
});

test('a line longer than the read budget accumulates in the carry and completes later', () => {
  const f = mk();
  const big = { v: 'y'.repeat(3000) };
  fs.writeFileSync(f, line(big) + line({ z: 1 }));
  const t = new Tail(f);
  const got = [];
  for (let i = 0; i < 100; i++) { const r = t.poll(700); got.push(...r.lines); if (!r.loading) break; }
  assert.deepEqual(got, [big, { z: 1 }]);
});

test('file shrinks (rotation/rewrite): reset:true and the new content is read from the start', () => {
  const f = mk();
  fs.writeFileSync(f, line({ a: 1 }) + line({ a: 2 }) + line({ a: 3 }));
  const t = new Tail(f);
  assert.equal(t.poll(1e6).lines.length, 3);
  fs.writeFileSync(f, line({ n: 1 }));
  const r = t.poll(1e6);
  assert.equal(r.reset, true);
  assert.equal(r.changed, true);
  assert.deepEqual(r.lines, [{ n: 1 }]);
  fs.appendFileSync(f, line({ n: 2 }));
  const r2 = t.poll(1e6);
  assert.equal(r2.reset, false);
  assert.deepEqual(r2.lines, [{ n: 2 }]);
});

test('missing file: missing:true without throwing; a file that vanishes and comes back counts as reset', () => {
  const f = mk();
  const t = new Tail(f);
  let r = t.poll(1e6);
  assert.equal(r.missing, true);
  assert.deepEqual(r.lines, []);
  assert.equal(r.size, 0);
  fs.writeFileSync(f, line({ a: 1 }));
  r = t.poll(1e6);
  assert.equal(r.missing, false);
  assert.deepEqual(r.lines, [{ a: 1 }]);
  fs.unlinkSync(f);
  assert.equal(t.poll(1e6).missing, true);
  fs.writeFileSync(f, line({ b: 1 }) + line({ b: 2 }) + line({ b: 3 }));      // larger than the old offset: still a new file
  r = t.poll(1e6);
  assert.equal(r.reset, true);
  assert.deepEqual(r.lines, [{ b: 1 }, { b: 2 }, { b: 3 }]);
});

test('unparsable complete lines are counted and skipped; blank lines and CRLF are fine', () => {
  const f = mk();
  fs.writeFileSync(f, 'garbage\n{"ok":1}\r\n[1,2]\n"str"\n\n   \n{"ok":2}\n');
  const t = new Tail(f);
  const r = t.poll(1e6);
  assert.deepEqual(r.lines, [{ ok: 1 }, { ok: 2 }]);
  assert.equal(r.badLines, 3);
  fs.appendFileSync(f, 'more garbage\n');
  assert.equal(t.poll(1e6).badLines, 4);          // cumulative
});

test('a directory or a non-file path is reported as missing, never thrown', () => {
  const t = new Tail(dir);
  const r = t.poll(1e6);
  assert.equal(r.missing, true);
  assert.deepEqual(r.lines, []);
});

test('hostile budget values are tolerated', () => {
  const f = mk();
  fs.writeFileSync(f, line({ a: 1 }));
  const t = new Tail(f);
  assert.deepEqual(t.poll(NaN).lines, []);
  assert.deepEqual(t.poll(-5).lines, []);
  assert.deepEqual(t.poll(undefined).lines, []);
  assert.deepEqual(t.poll(1e6).lines, [{ a: 1 }]);
});

test('Infinity means "no cap"', () => {
  const f = mk();
  fs.writeFileSync(f, line({ a: 1 }) + line({ a: 2 }));
  const r = new Tail(f).poll(Infinity);
  assert.deepEqual(r.lines, [{ a: 1 }, { a: 2 }]);
  assert.equal(r.loading, false);
});
