'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJournal } = require('../lib/journal');

const L = (...objs) => objs.map(o => JSON.stringify(o)).join('\n') + '\n';
const started = (key, agentId, label, phase) => ({ type: 'started', key, agentId, label, phase });

test('empty, non-string and garbage input give no slots', () => {
  for (const x of ['', null, undefined, 42, {}, '\n\n', 'not json\n{broken']) assert.deepEqual(parseJournal(x), { slots: [], phasesSeen: [] });
});

test('started / result / failed: one slot per key, state per outcome, phases in first-seen order', () => {
  const t = L({ type: 'launched' }, started('k1', 'a1', 'research:x', 'Research'), started('k2', 'a2', 'research:y', 'Research'), started('k3', 'a3', 'spec', 'Spec'),
    { type: 'result', key: 'k1', agentId: 'a1', result: { big: 'object' } },
    { type: 'result', key: 'k2', agentId: 'a2', result: 'free text answer' },
    { type: 'failed', key: 'k3', agentId: 'a3' });
  const j = parseJournal(t);
  assert.deepEqual(j.phasesSeen, ['Research', 'Spec']);
  assert.deepEqual(j.slots.map(s => [s.key, s.id, s.label, s.phase, s.attempts, s.state, s.resultText]), [
    ['k1', 'a1', 'research:x', 'Research', 1, 'done', null],
    ['k2', 'a2', 'research:y', 'Research', 1, 'done', 'free text answer'],
    ['k3', 'a3', 'spec', 'Spec', 1, 'failed', null],
  ]);
});

test('a slot without outcome stays running', () => {
  const j = parseJournal(L(started('k1', 'a1', 'x', 'P')));
  assert.equal(j.slots[0].state, 'running');
  assert.equal(j.slots[0].attempts, 1);
});

test('retry: the latest started of a key wins, attempts count up, and the old attempt never gets an outcome', () => {
  const t = L(started('k', 'old', 'verify:b', 'Verify'), started('k', 'new', 'verify:b', 'Verify'),
    { type: 'result', key: 'k', agentId: 'old', result: 'stale' });          // stalled earlier attempt answering late
  let j = parseJournal(t);
  assert.equal(j.slots.length, 1);
  assert.equal(j.slots[0].id, 'new');
  assert.equal(j.slots[0].attempts, 2);
  assert.equal(j.slots[0].state, 'running');
  assert.equal(j.slots[0].resultText, null);
  j = parseJournal(t + L({ type: 'result', key: 'k', agentId: 'new', result: 'fresh' }));
  assert.equal(j.slots[0].state, 'done');
  assert.equal(j.slots[0].resultText, 'fresh');
});

test('a restart after an outcome resets the slot (resume): state running again, result text cleared', () => {
  const j = parseJournal(L(started('k', 'a1', 'x', 'P'), { type: 'result', key: 'k', agentId: 'a1', result: 'r' }, started('k', 'a2', 'x', 'P')));
  assert.equal(j.slots[0].state, 'running');
  assert.equal(j.slots[0].id, 'a2');
  assert.equal(j.slots[0].resultText, null);
});

test('labels are not unique: two keys with the same label are two slots', () => {
  const j = parseJournal(L(started('k1', 'a1', 'same', 'P'), started('k2', 'a2', 'same', 'P')));
  assert.equal(j.slots.length, 2);
  assert.deepEqual(j.slots.map(s => s.id), ['a1', 'a2']);
});

test('torn last line is ignored; the line completes later', () => {
  const full = L(started('k1', 'a1', 'x', 'P'), { type: 'result', key: 'k1', agentId: 'a1', result: 'done' });
  const cut = full.slice(0, full.length - 10);                                // inside the result line
  let j = parseJournal(cut);
  assert.equal(j.slots.length, 1);
  assert.equal(j.slots[0].state, 'running');
  j = parseJournal(full);
  assert.equal(j.slots[0].state, 'done');
});

test('outcome lines for unknown slots or without usable ids are ignored', () => {
  const j = parseJournal(L({ type: 'result', key: 'zz', agentId: 'q', result: 'x' }, { type: 'failed' }, { type: 'started', key: 'k' }, { type: 'launched' }, started('k1', 'a1', 'x', null)));
  assert.equal(j.slots.length, 1);
  assert.equal(j.slots[0].phase, null);
  assert.deepEqual(j.phasesSeen, []);
});

test('result without a key falls back to the agent id; a key that belongs to another agent does not', () => {
  let j = parseJournal(L(started('k1', 'a1', 'x', 'P'), { type: 'result', agentId: 'a1', result: 'r' }));
  assert.equal(j.slots[0].state, 'done');
  j = parseJournal(L(started('k1', 'a1', 'x', 'P'), { type: 'result', key: 'k1', agentId: 'someone-else', result: 'r' }));
  assert.equal(j.slots[0].state, 'running');
});

test('only a preview of a long result string is kept', () => {
  const j = parseJournal(L(started('k', 'a', 'x', 'P'), { type: 'result', key: 'k', agentId: 'a', result: 'y'.repeat(5000) }));
  assert.ok(j.slots[0].resultText.length <= 400);
});

test('CRLF line endings and blank lines are fine', () => {
  const j = parseJournal(JSON.stringify(started('k', 'a', 'x', 'P')) + '\r\n\r\n' + JSON.stringify({ type: 'failed', key: 'k', agentId: 'a' }) + '\r\n');
  assert.equal(j.slots[0].state, 'failed');
});

test('performance: 2000 lines parse in well under 100 ms', () => {
  const rows = [];
  for (let i = 0; i < 1000; i++) rows.push(started('k' + i, 'a' + i, 'l' + i, 'P' + (i % 5)), { type: 'result', key: 'k' + i, agentId: 'a' + i, result: { v: 'x'.repeat(50) } });
  const t0 = process.hrtime.bigint();
  const j = parseJournal(L(...rows));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(j.slots.length, 1000);
  assert.ok(ms < 100, 'took ' + ms);
});
