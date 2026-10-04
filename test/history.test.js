'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const History = require('../lib/history');
const { CAPS } = History;
const { estimateAgent, estimateWorkflow } = require('../lib/eta');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-view-history-'));
after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { /* best effort */ } });
let seq = 0;
const tmp = (name) => { const d = path.join(ROOT, name || 't' + (++seq)); fs.mkdirSync(d, { recursive: true }); return d; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const writeJson = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj)); };

// ---- synthetic result files (shape of ~/.claude/projects/<proj>/<sid>/workflows/wf_<run>.json) ----
const T0 = 1790000000000;
const ag = (o) => Object.assign({ type: 'workflow_agent', index: 1, label: 'research:x', phaseIndex: 1, phaseTitle: 'Research', agentId: 'a1', model: 'claude-opus-5[1m]', state: 'done', startedAt: T0, queuedAt: T0 - 10, attempt: 1, lastProgressAt: T0 + 1000, tokens: 1000, toolCalls: 3, durationMs: 60000 }, o);
const ph = (index, title) => ({ type: 'workflow_phase', index, title });
const result = (runId, status, progress, extra) => Object.assign({ runId, status, workflowName: 'w', startTime: T0, workflowProgress: progress, scriptPath: 'C:\\Users\\x\\AppData\\Local\\Temp\\s.js' }, extra);

// Run 1: completed. Research: 3 done + 1 error + 1 cached; Verify: 2 done (one is a retry).
const run1 = () => result('wf_aaa-111', 'completed', [
  ph(1, 'Research'), ph(2, 'Verify'),
  ag({ label: 'research:m365', agentId: 'a1', startedAt: T0, durationMs: 100000 }),
  ag({ label: 'research:n8n', agentId: 'a2', startedAt: T0 + 1000, durationMs: 200000 }),
  ag({ label: 'Research:Shop', agentId: 'a3', startedAt: T0 + 2000, durationMs: 300000, model: 'claude-sonnet-5-5' }),
  ag({ label: 'research:err', agentId: 'a4', startedAt: T0 + 3000, durationMs: 50000, state: 'error' }),
  ag({ label: 'research:cached', agentId: 'a5', startedAt: T0, durationMs: 1, cached: true }),
  ag({ label: 'verify:one', agentId: 'b1', phaseIndex: 2, phaseTitle: 'Verify', startedAt: T0 + 400000, durationMs: 60000 }),
  ag({ label: 'verify:two (retry 2)', agentId: 'b2', phaseIndex: 2, phaseTitle: 'Verify', startedAt: T0 + 400500, durationMs: 80000, attempt: 2 }),
]);
// Run 2: killed. Phase 1 finished, phase 2 (last) has a running agent and a done one.
const run2 = () => result('wf_bbb-222', 'killed', [
  ph(1, 'A'), ph(2, 'B'),
  ag({ label: 'a:1', agentId: 'c1', phaseIndex: 1, phaseTitle: 'A', startedAt: T0, durationMs: 50000 }),
  ag({ label: 'b:1', agentId: 'c2', phaseIndex: 2, phaseTitle: 'B', startedAt: T0 + 60000, durationMs: 20000 }),
  ag({ label: 'b:2', agentId: 'c3', phaseIndex: 2, phaseTitle: 'B', startedAt: T0 + 60000, state: 'progress', durationMs: undefined }),
]);
const run3 = (id) => result(id || 'wf_ggg-777', 'completed', [ph(1, 'P'), ag({ label: 'p:1', agentId: 'd1', phaseIndex: 1, phaseTitle: 'P', startedAt: T0, durationMs: 90000 })]);

const PROJ_A = (home) => path.join(home, 'projects', 'C--Proj-A', 'sid-1', 'workflows');

// ---------------------------------------------------------------------------------------------
// load: tolerant
// ---------------------------------------------------------------------------------------------

test('load: missing file and missing directory -> empty history, no throw, no file created', () => {
  const dir = tmp(); const file = path.join(dir, 'nope', 'history.json');
  const h = new History(file); h.load();
  assert.deepEqual(h.snapshot(), { agents: [], phaseDurSec: [] });
  h.flush(); assert.equal(fs.existsSync(file), false);
});

test('load: corrupt / foreign content -> empty history, and the next flush replaces the file with valid JSON', () => {
  const bad = ['', '   ', 'not json', '{"v":1,', '[1,2,3]', 'null', '"str"', '{"v":2,"agents":[]}', '{"agents":[]}', '\u0000\u0000\u0000', '{"v":1,"agents":"x","phaseDurSec":5,"ingestedRuns":7}'];
  for (const content of bad) {
    const file = path.join(tmp(), 'history.json'); fs.writeFileSync(file, content);
    const h = new History(file); assert.doesNotThrow(() => h.load(), JSON.stringify(content));
    assert.deepEqual(h.snapshot(), { agents: [], phaseDurSec: [] }, JSON.stringify(content));
    assert.equal(h.ingestAgent('k1', { kind: 'wf', prefix: 'verify', phase: 'v', model: 'm', proj: 'p', run: 'r', durSec: 10 }), true);
    h.flush();
    const j = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(j.v, 1); assert.equal(j.agents.length, 1);
  }
});

test('load: a directory or an oversized file at the history path is ignored', () => {
  const dir = tmp(); const asDir = path.join(dir, 'history.json'); fs.mkdirSync(asDir);
  const h = new History(asDir); assert.doesNotThrow(() => h.load()); assert.equal(h.snapshot().agents.length, 0);
  assert.doesNotThrow(() => { h.ingestAgent('k', { kind: 'wf', prefix: 'a', durSec: 5 }); h.flush(); });   // cannot replace a directory: swallowed
  assert.ok(h.lastError);
  const big = path.join(dir, 'big.json'); fs.writeFileSync(big, '{"v":1,"agents":[],"pad":"' + 'x'.repeat(9 * 1024 * 1024) + '"}');
  const h2 = new History(big); h2.load(); assert.equal(h2.snapshot().agents.length, 0);
});

test('load: BOM tolerated, bad records dropped, valid ones kept', () => {
  const file = path.join(tmp(), 'history.json');
  const good = { kind: 'wf', prefix: 'verify', phase: 'v', model: 'm', proj: 'p', run: 'r1', dur: 120.5 };
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ v: 1, agents: [good, null, 5, {}, { ...good, dur: NaN }, { ...good, dur: -1 }, { ...good, dur: 0 }, { ...good, dur: 'x' }, { ...good, kind: 'zzz' }, { ...good, prefix: 3 }, { ...good, dur: 1e12 }, { ...good, run: 'r2', model: undefined }],
    phaseDurSec: [100, 'x', NaN, -5, 0, null, 200], ingestedRuns: ['wf_aaa-111', 5, null, '', '../etc', 'bbb-222'], ingestedAgents: ['k1', 5, null, 'k1'] }));
  const h = new History(file); h.load();
  const s = h.snapshot();
  assert.deepEqual(s.agents.map(a => a.run), ['r1', 'r2']); assert.equal(s.agents[1].model, ''); assert.deepEqual(s.phaseDurSec, [100, 200]);
  assert.deepEqual(h.stats(), { agents: 2, phases: 2, runs: 2, agentIds: 1 });
  assert.equal(h.ingestRun('wf_aaa-111', run1()), false);   // persisted run ids dedupe, with or without "wf_"
  assert.equal(h.ingestRun('bbb-222', run2()), false);
});

test('load: files above the caps are trimmed to the caps, newest records kept', () => {
  const file = path.join(tmp(), 'history.json');
  const agents = []; for (let i = 0; i < CAPS.agents + 500; i++) agents.push({ kind: 'wf', prefix: 'p', phase: '', model: '', proj: '', run: 'r' + i, dur: 10 + (i % 7) });
  const phases = []; for (let i = 0; i < CAPS.phases + 50; i++) phases.push(100 + i);
  const ids = []; for (let i = 0; i < CAPS.ids + 100; i++) ids.push('run' + i);
  fs.writeFileSync(file, JSON.stringify({ v: 1, agents, phaseDurSec: phases, ingestedRuns: ids, ingestedAgents: ids }));
  const h = new History(file); h.load(); const s = h.snapshot();
  assert.equal(s.agents.length, CAPS.agents); assert.equal(s.agents[0].run, 'r500'); assert.equal(s.agents[CAPS.agents - 1].run, 'r' + (CAPS.agents + 499));
  assert.equal(s.phaseDurSec.length, CAPS.phases); assert.equal(s.phaseDurSec[0], 150);
  assert.equal(h.stats().runs, CAPS.ids); assert.equal(h.stats().agentIds, CAPS.ids);
});

// ---------------------------------------------------------------------------------------------
// ingestAgent / ingestRun
// ---------------------------------------------------------------------------------------------

test('ingestAgent: normalises like eta.js, dedupes by key, rejects invalid input', () => {
  const h = new History(path.join(tmp(), 'h.json'));
  assert.equal(h.ingestAgent('s1/a1', { kind: 'task', prefix: 'Explore', phase: null, model: 'claude-haiku-4-5[1m]', proj: 'C:\\Proj\\X', run: null, durSec: 43.27 }), true);
  assert.equal(h.ingestAgent('s1/a1', { kind: 'task', prefix: 'Explore', durSec: 50 }), false);
  assert.equal(h.ingestAgent('s1/a2', { kind: 'wf', prefix: 'Prüfe:Foo (retry 2)', phase: 'Prüfung', model: 'm', proj: 'C--Proj', run: 'wf_abc-1', durSec: 12 }), true);
  const [a, b] = h.snapshot().agents;
  assert.deepEqual(a, { kind: 'task', prefix: 'explore', phase: '', model: 'claude-haiku-4-5', proj: 'c--proj-x', run: 'a:s1/a1', dur: 43.3 });
  assert.deepEqual(b, { kind: 'wf', prefix: 'pruefe', phase: 'pruefung', model: 'm', proj: 'c--proj', run: 'abc-1', dur: 12 });
  for (const bad of [undefined, null, 5, 'x', {}, { kind: 'wf' }, { kind: 'wf', prefix: 'a', durSec: 0 }, { kind: 'wf', prefix: 'a', durSec: -3 }, { kind: 'wf', prefix: 'a', durSec: NaN }, { kind: 'wf', prefix: 'a', durSec: Infinity },
    { kind: 'wf', prefix: 'a', durSec: '12' }, { kind: 'zzz', prefix: 'a', durSec: 5 }, { kind: 'wf', prefix: 'a', durSec: 1e9 }]) assert.equal(h.ingestAgent('bad-' + String(JSON.stringify(bad)), bad), false);
  for (const k of [undefined, null, '', 'x'.repeat(301)]) assert.equal(h.ingestAgent(k, { kind: 'wf', prefix: 'a', durSec: 5 }), false);
  assert.equal(h.stats().agents, 2);
});

test('ingestAgent: plain agents of one session share the run group "s:<sid>" (distinct runs = sessions, not agents)', () => {
  const h = new History(path.join(tmp(), 'h.json'));
  for (let i = 0; i < 20; i++) assert.equal(h.ingestAgent('sid1:a' + i, { kind: 'task', prefix: 'Explore', phase: null, model: 'm', proj: 'c--p', run: 's:sid1', durSec: 60 + i }), true);
  assert.equal(h.ingestAgent('sid2:a0', { kind: 'task', prefix: 'Explore', phase: null, model: 'm', proj: 'c--p', run: 's:sid2', durSec: 70 }), true);
  assert.deepEqual([...new Set(h.snapshot().agents.map(a => a.run))], ['s:sid1', 's:sid2']);
  // a malformed group falls back to "its own run" instead of being stored verbatim
  assert.equal(h.ingestAgent('x1', { kind: 'task', prefix: 'Explore', run: 's:../../etc', durSec: 5 }), true);
  assert.equal(h.snapshot().agents[21].run, 'a:x1');
  // the key history of eta.js therefore does not trigger for 20 agents of a single session (needs >= 8 distinct runs)
  const e = estimateAgent({ state: 'running', elapsedSec: 40, silentSec: 1, kind: 'task', label: 'x', agentType: 'Explore', project: 'c--p', siblingsDoneSec: [] }, h.snapshot());
  assert.equal(e.kind, 'unknown');
});

test('ingestRun: records only done non-cached agents; labels, models and projects normalised; phase durations first start -> last end', () => {
  const h = new History(path.join(tmp(), 'h.json'));
  assert.equal(h.ingestRun('wf_aaa-111', run1(), 'C--Proj-A'), true);
  const s = h.snapshot();
  assert.equal(s.agents.length, 5);
  assert.deepEqual(s.agents.map(a => a.dur), [100, 200, 300, 60, 80]);
  assert.deepEqual(s.agents.map(a => a.prefix), ['research', 'research', 'research', 'verify', 'verify']);        // retry suffix stripped, case folded
  assert.deepEqual(s.agents.map(a => a.phase), ['research', 'research', 'research', 'verify', 'verify']);
  assert.deepEqual(s.agents.map(a => a.model), ['claude-opus-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-opus-5']);   // [1m] stripped
  assert.ok(s.agents.every(a => a.kind === 'wf' && a.proj === 'c--proj-a' && a.run === 'aaa-111'));
  // Research: T0 .. max(T0+100s, T0+201s, T0+302s, T0+53s) = 302 s (the failed agent counts for the span, not for the records); Verify: T0+400s .. T0+480.5s
  assert.deepEqual(s.phaseDurSec, [302, 80.5]);
});

test('ingestRun: killed run keeps finished phases and drops the cut-short last phase; the done agent of it still counts', () => {
  const h = new History(path.join(tmp(), 'h.json'));
  assert.equal(h.ingestRun('wf_bbb-222', run2()), true);
  const s = h.snapshot();
  assert.deepEqual(s.agents.map(a => a.dur), [50, 20]); assert.deepEqual(s.phaseDurSec, [50]);
  // a killed run whose last phase has only done agents: still skipped, it may have been cut short
  const r = run2(); r.workflowProgress = r.workflowProgress.filter(w => w.agentId !== 'c3');
  const h2 = new History(path.join(tmp(), 'h.json')); h2.ingestRun('wf_bbb-222', r); assert.deepEqual(h2.snapshot().phaseDurSec, [50]);
  // the same file with status completed keeps both
  r.status = 'completed'; const h3 = new History(path.join(tmp(), 'h.json')); h3.ingestRun('wf_bbb-222', r); assert.deepEqual(h3.snapshot().phaseDurSec, [50, 20]);
});

test('ingestRun: dedupe by run id (with / without "wf_"), invalid input, project from scriptPath', () => {
  const h = new History(path.join(tmp(), 'h.json'));
  assert.equal(h.ingestRun('wf_ggg-777', run3()), true);
  assert.equal(h.ingestRun('wf_ggg-777', run3()), false);
  assert.equal(h.ingestRun('ggg-777', run3()), false);
  assert.equal(h.stats().agents, 1);
  for (const [id, j] of [[undefined, run3()], ['', run3()], ['a/b', run3()], ['wf_x', null], ['wf_x', 'str'], ['wf_x', {}], ['wf_x', { workflowProgress: 'no' }], ['wf_x', []], [5, run3()]]) assert.equal(h.ingestRun(id, j), false);
  assert.equal(h.stats().agents, 1);
  // result without a usable agent still consumes the run id (and returns true)
  assert.equal(h.ingestRun('wf_empty-1', result('wf_empty-1', 'completed', [])), true); assert.equal(h.ingestRun('wf_empty-1', result('x', 'completed', [])), false);
  // project: explicit arg wins; otherwise the project dir in scriptPath; a script in %TEMP% gives ''
  const mk = (id, sp) => result(id, 'completed', [ph(1, 'P'), ag({ label: 'p:1', phaseIndex: 1, phaseTitle: 'P' })], { scriptPath: sp });
  h.ingestRun('wf_p1', mk('wf_p1', 'C:\\Users\\x\\.claude\\projects\\C--Foo-Bar\\sid\\workflows\\scripts\\n-wf_p1.js'));
  h.ingestRun('wf_p2', mk('wf_p2', 'C:\\Users\\x\\AppData\\Local\\Temp\\n.js'));
  h.ingestRun('wf_p3', mk('wf_p3', 'C:\\Users\\x\\.claude\\projects\\C--Foo-Bar\\sid\\workflows\\scripts\\n-wf_p3.js'), 'C--Other');
  assert.deepEqual(h.snapshot().agents.slice(1).map(a => a.proj), ['c--foo-bar', '', 'c--other']);
});

test('ingestRun: garbage inside workflowProgress is skipped without throwing', () => {
  const h = new History(path.join(tmp(), 'h.json'));
  const j = result('wf_g', 'completed', [null, 5, 'x', [], {}, { type: 'workflow_agent' }, ag({ durationMs: 'x' }), ag({ durationMs: -5 }), ag({ startedAt: 'x' }), ag({ label: null, phaseTitle: null, model: null }), ag({ phaseIndex: 'x', phaseTitle: undefined })]);
  assert.equal(h.ingestRun('wf_g', j), true);
  for (const r of h.snapshot().agents) assert.ok(isFinite(r.dur) && r.dur > 0);
});

// ---------------------------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------------------------

test('snapshot: { agents, phaseDurSec }, frozen, the same object until the content changes', () => {
  const h = new History(path.join(tmp(), 'h.json'));
  const s0 = h.snapshot(); assert.equal(h.snapshot(), s0); assert.ok(Object.isFrozen(s0) && Object.isFrozen(s0.agents) && Object.isFrozen(s0.phaseDurSec));
  h.ingestRun('wf_aaa-111', run1(), 'p');
  const s1 = h.snapshot(); assert.notEqual(s1, s0); assert.equal(h.snapshot(), s1); assert.equal(s0.agents.length, 0); assert.equal(s1.agents.length, 5);
  h.ingestRun('wf_aaa-111', run1(), 'p');   // duplicate: nothing changed, so same object
  assert.equal(h.snapshot(), s1);
  assert.deepEqual(Object.keys(s1).sort(), ['agents', 'phaseDurSec']);
  for (const r of s1.agents) assert.deepEqual(Object.keys(r).sort(), ['dur', 'kind', 'model', 'phase', 'proj', 'prefix', 'run'].sort());
});

test('snapshot feeds eta.js: key range from ingested runs, workflow phase fallback from phaseDurSec', () => {
  const h = new History(path.join(tmp(), 'h.json'));
  for (let r = 0; r < 10; r++) {
    const progress = [ph(1, 'Verify')];
    for (let i = 0; i < 3; i++) progress.push(ag({ label: 'verify:' + i, agentId: 'v' + i, phaseIndex: 1, phaseTitle: 'Verify', startedAt: T0 + i * 100, durationMs: (200 + 40 * ((r + i) % 5)) * 1000 }));
    h.ingestRun('wf_run-' + r, result('wf_run-' + r, 'completed', progress), 'C--Proj-A');
  }
  assert.equal(h.stats().agents, 30); assert.equal(h.stats().phases, 10);
  const input = { state: 'running', elapsedSec: 100, silentSec: 1, kind: 'wf', label: 'verify:new', phase: 'Verify', model: 'x', project: 'c--proj-a', runId: 'new', siblingsDoneSec: [] };
  const e = estimateAgent(input, h.snapshot());
  assert.equal(e.kind, 'range'); assert.equal(e.basis, 'key'); assert.equal(e.n, 30); assert.equal(e.runs, 10); assert.match(e.text, /Min\./);
  assert.equal(estimateAgent({ ...input, project: 'c--other' }, h.snapshot()).kind, 'unknown');
  assert.equal(estimateWorkflow({ elapsedSec: 100, phasesAhead: 1, currentPhaseSiblingsDoneSec: [], currentPhaseElapsedSecs: [100], runPhaseDurSec: [] }, h.snapshot()).kind, 'unknown');   // 10 phases < 20
});

// ---------------------------------------------------------------------------------------------
// persistence: atomic write, debounce, flush, reset
// ---------------------------------------------------------------------------------------------

test('flush: writes {v:1,...}, creates directories, leaves no temp files; a new instance reads it back', () => {
  const dir = tmp(); const file = path.join(dir, 'a', 'b', 'history.json');
  const h = new History(file); h.ingestRun('wf_aaa-111', run1(), 'C--Proj-A'); h.ingestAgent('s/a1', { kind: 'task', prefix: 'Explore', proj: 'p', durSec: 12 });
  h.flush();
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(j).sort(), ['agents', 'ingestedAgents', 'ingestedRuns', 'phaseDurSec', 'v']);
  assert.equal(j.v, 1); assert.equal(j.agents.length, 6); assert.deepEqual(j.ingestedRuns, ['aaa-111']); assert.deepEqual(j.ingestedAgents, ['s/a1']);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['history.json']);
  const h2 = new History(file); h2.load(); assert.deepEqual(h2.snapshot(), h.snapshot());
  assert.equal(h2.ingestRun('wf_aaa-111', run1()), false); assert.equal(h2.ingestAgent('s/a1', { kind: 'task', prefix: 'x', durSec: 1 }), false);
  const mtime = fs.statSync(file).mtimeMs; h2.flush(); assert.equal(fs.statSync(file).mtimeMs, mtime);   // nothing dirty: no write
});

test('flush is atomic: a failing rename or write leaves the previous file intact, removes the temp file and never throws', () => {
  const dir = tmp(); const file = path.join(dir, 'history.json');
  const h = new History(file); h.ingestAgent('k1', { kind: 'wf', prefix: 'a', durSec: 10 }); h.flush();
  const before = fs.readFileSync(file, 'utf8');
  h.ingestAgent('k2', { kind: 'wf', prefix: 'b', durSec: 20 });
  const { renameSync, writeFileSync } = fs;
  try {
    fs.renameSync = () => { const e = new Error('EPERM: rename'); e.code = 'EPERM'; throw e; };
    assert.doesNotThrow(() => h.flush());
    assert.equal(fs.readFileSync(file, 'utf8'), before); assert.deepEqual(fs.readdirSync(dir), ['history.json']); assert.ok(h.lastError); assert.equal(h._dirty, true);
    fs.renameSync = renameSync;
    fs.writeFileSync = (target, ...rest) => { if (/\.tmp$/.test(String(target))) { writeFileSync(target, '{"v":1,"agents":[{"kind":"wf","pre', 'utf8'); const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; } return writeFileSync(target, ...rest); };
    assert.doesNotThrow(() => h.flush());
    assert.equal(fs.readFileSync(file, 'utf8'), before); assert.deepEqual(fs.readdirSync(dir), ['history.json']); assert.equal(h._dirty, true);
  } finally { fs.renameSync = renameSync; fs.writeFileSync = writeFileSync; }
  h.flush(); assert.equal(h.lastError, null); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).agents.length, 2); assert.deepEqual(fs.readdirSync(dir), ['history.json']);
});

test('flush: the temp file is written next to the target and renamed over it (same directory = same volume)', () => {
  const dir = tmp(); const file = path.join(dir, 'history.json'); const calls = [];
  const { renameSync } = fs;
  fs.renameSync = (from, to) => { calls.push([from, to]); return renameSync(from, to); };
  try { const h = new History(file); h.ingestAgent('k', { kind: 'wf', prefix: 'a', durSec: 10 }); h.flush(); } finally { fs.renameSync = renameSync; }
  assert.equal(calls.length, 1); assert.equal(path.dirname(calls[0][0]), dir); assert.notEqual(calls[0][0], file); assert.equal(calls[0][1], file); assert.match(path.basename(calls[0][0]), /\.tmp$/);
});

test('debounce: many ingests -> one write after the window; the timer is unref\'d so it cannot keep the process alive', async () => {
  const dir = tmp(); const file = path.join(dir, 'history.json'); let renames = 0;
  const { renameSync } = fs; fs.renameSync = (a, b) => { renames++; return renameSync(a, b); };
  try {
    const h = new History(file, { debounceMs: 40 });
    for (let i = 0; i < 50; i++) h.ingestAgent('k' + i, { kind: 'wf', prefix: 'a', durSec: 10 + i });
    assert.equal(fs.existsSync(file), false);
    assert.ok(h._timer); assert.equal(h._timer.hasRef(), false);
    await sleep(160);
    assert.equal(fs.existsSync(file), true); assert.equal(renames, 1); assert.equal(h._timer, null);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).agents.length, 50);
    h.ingestAgent('later', { kind: 'wf', prefix: 'a', durSec: 5 }); await sleep(160);
    assert.equal(renames, 2);
  } finally { fs.renameSync = renameSync; }
});

test('flush() cancels the pending timer and writes now; dispose() flushes', async () => {
  const file = path.join(tmp(), 'history.json');
  const h = new History(file, { debounceMs: 30 }); h.ingestAgent('k', { kind: 'wf', prefix: 'a', durSec: 10 });
  h.flush(); assert.equal(h._timer, null); assert.equal(fs.existsSync(file), true);
  h.ingestAgent('k2', { kind: 'wf', prefix: 'a', durSec: 11 }); h.dispose(); assert.equal(h._timer, null); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).agents.length, 2);
  await sleep(80);
});

test('caps: 3000 agents (newest kept), 500 phases, 2000 ids per list', () => {
  const file = path.join(tmp(), 'history.json'); const h = new History(file);
  for (let i = 0; i < CAPS.agents + 100; i++) assert.equal(h.ingestAgent('k' + i, { kind: 'wf', prefix: 'a', phase: 'p', model: 'm', proj: 'p', run: null, durSec: 10 + (i % 50) }), true);
  let s = h.snapshot(); assert.equal(s.agents.length, CAPS.agents); assert.equal(s.agents[0].run, 'a:k100'); assert.equal(s.agents[CAPS.agents - 1].run, 'a:k' + (CAPS.agents + 99));
  assert.equal(h.stats().agentIds, CAPS.ids);
  assert.equal(h.ingestAgent('k' + (CAPS.agents + 99), { kind: 'wf', prefix: 'a', durSec: 5 }), false);   // recent id still remembered
  assert.equal(h.ingestAgent('k0', { kind: 'wf', prefix: 'a', durSec: 5 }), true);                       // evicted id is forgotten (its record is long gone too)
  // phases: one run with 600 completed phases
  const progress = []; for (let i = 1; i <= 600; i++) progress.push(ag({ label: 'x:' + i, agentId: 'a' + i, phaseIndex: i, phaseTitle: 'P' + i, startedAt: T0 + i * 10000, durationMs: 5000 + i }));
  assert.equal(h.ingestRun('wf_many', result('wf_many', 'completed', progress)), true);
  s = h.snapshot(); assert.equal(s.phaseDurSec.length, CAPS.phases); assert.equal(s.phaseDurSec[CAPS.phases - 1], 5.6); assert.equal(s.phaseDurSec[0], 5.1);
  // runs: ids beyond the cap are evicted oldest first
  for (let i = 0; i < CAPS.ids + 10; i++) h.ingestRun('wf_r' + i, result('wf_r' + i, 'completed', []));
  assert.equal(h.stats().runs, CAPS.ids); assert.equal(h.ingestRun('wf_r' + (CAPS.ids + 9), result('x', 'completed', [])), false);
  h.flush(); const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(j.agents.length <= CAPS.agents && j.phaseDurSec.length <= CAPS.phases && j.ingestedRuns.length <= CAPS.ids && j.ingestedAgents.length <= CAPS.ids);
  assert.ok(fs.statSync(file).size < 1024 * 1024);
});

test('reset: clears memory, deletes the file, ingest and bootstrap work again afterwards', async () => {
  const home = tmp(); writeJson(path.join(PROJ_A(home), 'wf_aaa-111.json'), run1());
  const file = path.join(tmp(), 'history.json'); const h = new History(file);
  await h.bootstrap(home); assert.equal(h.stats().agents, 5); assert.equal(fs.existsSync(file), true);
  h.reset(); assert.deepEqual(h.snapshot(), { agents: [], phaseDurSec: [] }); assert.equal(fs.existsSync(file), false); assert.deepEqual(h.stats(), { agents: 0, phases: 0, runs: 0, agentIds: 0 });
  assert.doesNotThrow(() => h.reset());   // already gone
  await sleep(10);
  assert.equal(fs.existsSync(file), false);
  await h.bootstrap(home); assert.equal(h.stats().agents, 5);
});

// ---------------------------------------------------------------------------------------------
// bootstrap over a synthetic tree
// ---------------------------------------------------------------------------------------------

function buildTree() {
  const home = tmp('home-' + (++seq));
  const P = (...p) => path.join(home, 'projects', ...p);
  writeJson(path.join(PROJ_A(home), 'wf_aaa-111.json'), run1());
  writeJson(P('c--proj-a', 'sid-1', 'workflows', 'wf_bbb-222.json'), run2());                 // other drive-letter spelling of the same project
  writeJson(P('C--Proj-B', 'sid-2', 'workflows', 'wf_ccc-333.json'), '{"torn":');               // corrupt result file
  writeJson(P('C--Proj-B', 'sid-2', 'workflows', 'wf_ddd-444.json.bak'), run3('wf_ddd-444'));   // not a result file
  writeJson(P('C--Proj-B', 'sid-2', 'workflows', 'notes.json'), run3('wf_notes'));
  fs.mkdirSync(P('C--Proj-B', 'sid-2', 'workflows', 'wf_eee-555.json'), { recursive: true });    // a directory with that name
  writeJson(P('C--Proj-B', 'sid-2', 'workflows', 'wf_fff-666.json'), { runId: 'wf_fff-666', status: 'completed' });   // no workflowProgress
  fs.mkdirSync(P('C--Proj-B', 'sid-3'), { recursive: true });                                    // session without workflows
  writeJson(P('C--Proj-B', 'sid-4', 'workflows', 'wf_ggg-777.json'), run3());
  writeJson(P('C--Proj-B', 'sid-4', 'workflows', 'scripts', 'name-wf_ggg-777.js'), 'x');          // scripts dir must not confuse anything
  fs.writeFileSync(P('C--Proj-B', 'sid-4.jsonl'), 'TRAP main transcript\n');                      // main transcript (never read)
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true }); fs.writeFileSync(path.join(home, 'sessions', '123.key'), 'secret');
  fs.writeFileSync(P('loose-file.txt'), 'x');                                                     // a file directly in projects/
  return home;
}

// spy on every read the bootstrap performs
function spyReads(fn) {
  const fsp = fs.promises; const reads = [];
  const orig = { readFile: fsp.readFile, stat: fsp.stat, readdir: fsp.readdir, open: fsp.open };
  fsp.readFile = (p, ...r) => { reads.push(String(p)); return orig.readFile(p, ...r); };
  fsp.stat = (p, ...r) => { reads.push(String(p)); return orig.stat(p, ...r); };
  fsp.open = (p, ...r) => { reads.push(String(p)); return orig.open(p, ...r); };
  return fn(reads).finally(() => Object.assign(fsp, orig));
}

test('bootstrap: synthetic tree - result files only, records and phases as expected, project dirs merged case-insensitively', async () => {
  const home = buildTree(); const file = path.join(tmp(), 'history.json'); const h = new History(file);
  await spyReads(async (reads) => {
    await h.bootstrap(home);
    assert.ok(reads.length > 0);
    for (const p of reads) assert.match(path.basename(p), /^wf_.+\.json$/, 'bootstrap touched ' + p);   // never the main transcript, *.key, scripts, sessions
  });
  const s = h.snapshot();
  assert.deepEqual(h.stats(), { agents: 5 + 2 + 1, phases: 2 + 1 + 1, runs: 3, agentIds: 0 });
  assert.deepEqual(h.lastBootstrap, { files: 5, runs: 3, agents: 8 });
  assert.deepEqual([...new Set(s.agents.map(a => a.proj))].sort(), ['c--proj-a', 'c--proj-b']);
  assert.deepEqual([...new Set(s.agents.map(a => a.run))].sort(), ['aaa-111', 'bbb-222', 'ggg-777']);
  assert.deepEqual(s.phaseDurSec.slice().sort((a, b) => a - b), [50, 80.5, 90, 302]);
  // persisted by the bootstrap itself
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).agents.length, 8);
});

test('bootstrap: idempotent - second run (same instance or a fresh one loading the file) does not re-read ingested result files', async () => {
  const home = buildTree(); const file = path.join(tmp(), 'history.json'); const h = new History(file);
  await h.bootstrap(home); const first = h.snapshot();
  // files that could not be ingested (corrupt / no workflowProgress) are retried on purpose: a torn file may be mid-write
  const retried = ['wf_ccc-333.json', 'wf_fff-666.json'];
  const wfReads = (reads) => [...new Set(reads.filter(p => /wf_.+\.json$/.test(p)).map(p => path.basename(p)))].sort();
  await spyReads(async (reads) => {
    await h.bootstrap(home); assert.deepEqual(wfReads(reads), retried);
    reads.length = 0;
    const h2 = new History(file); h2.load(); await h2.bootstrap(home); assert.deepEqual(wfReads(reads), retried);
    assert.deepEqual(h2.snapshot(), first);
  });
  assert.equal(h.snapshot(), first);   // nothing changed: same cached snapshot object
  // a new result file appears later -> it is read in addition
  writeJson(path.join(PROJ_A(home), 'wf_new-999.json'), run3('wf_new-999'));
  await spyReads(async (reads) => { await h.bootstrap(home); assert.deepEqual(wfReads(reads), [...retried, 'wf_new-999.json'].sort()); });
  assert.equal(h.stats().agents, 9);
});

test('bootstrap: a run already ingested live is not ingested again (ids shared with ingestRun)', async () => {
  const home = buildTree(); const h = new History(path.join(tmp(), 'history.json'));
  assert.equal(h.ingestRun('wf_aaa-111', run1(), 'C--Proj-A'), true);
  await h.bootstrap(home);
  assert.equal(h.snapshot().agents.filter(a => a.run === 'aaa-111').length, 5);
  assert.equal(h.stats().runs, 3);
});

test('bootstrap: oldest result files first, so the newest survive the caps', async () => {
  const home = tmp('home-order'); const dir = path.join(home, 'projects', 'C--P', 's', 'workflows');
  for (const [id, age] of [['wf_new', 10], ['wf_old', 1000], ['wf_mid', 500]]) {
    const f = path.join(dir, id + '.json'); writeJson(f, run3(id)); const t = new Date(Date.now() - age * 1000); fs.utimesSync(f, t, t);
  }
  const h = new History(path.join(tmp(), 'history.json')); await h.bootstrap(home, { batch: 1 });
  assert.deepEqual(h.snapshot().agents.map(a => a.run), ['old', 'mid', 'new']);
});

test('bootstrap: yields to the event loop between small batches', async () => {
  const home = tmp('home-yield'); const dir = path.join(home, 'projects', 'C--P', 's', 'workflows');
  for (let i = 0; i < 24; i++) writeJson(path.join(dir, 'wf_r' + i + '.json'), run3('wf_r' + i));
  const h = new History(path.join(tmp(), 'history.json')); let ticks = 0, done = false;
  const p = h.bootstrap(home, { batch: 1 }).then(() => { done = true; });
  while (!done) { await new Promise(r => setImmediate(r)); ticks++; }
  await p;
  assert.equal(h.stats().runs, 24); assert.ok(ticks >= 24, 'only ' + ticks + ' event-loop turns during a 24-file bootstrap with batch 1');
});

test('bootstrap: concurrent calls share one run; missing/odd roots resolve quietly', async () => {
  const home = buildTree(); const h = new History(path.join(tmp(), 'history.json'));
  const p1 = h.bootstrap(home), p2 = h.bootstrap(home); assert.equal(p1, p2); await p1;
  assert.equal(h.stats().runs, 3);
  for (const root of [undefined, null, '', path.join(ROOT, 'does-not-exist'), path.join(home, 'projects', 'loose-file.txt')]) await assert.doesNotReject(new History(path.join(tmp(), 'h.json')).bootstrap(root));
  const empty = tmp(); fs.mkdirSync(path.join(empty, 'projects')); const h2 = new History(path.join(tmp(), 'h.json')); await h2.bootstrap(empty); assert.equal(h2.stats().agents, 0);
});

test('bootstrap: oversized result files are skipped, a failing history file does not reject the bootstrap', async () => {
  const home = tmp('home-big'); const dir = path.join(home, 'projects', 'C--P', 's', 'workflows');
  writeJson(path.join(dir, 'wf_ok.json'), run3('wf_ok'));
  const big = path.join(dir, 'wf_big.json'); fs.writeFileSync(big, '{"workflowProgress":[],"pad":"' + 'x'.repeat(33 * 1024 * 1024) + '"}');
  const blocked = path.join(tmp(), 'dir-as-file'); fs.mkdirSync(blocked);
  const h = new History(blocked);   // flush at the end of the bootstrap cannot write
  await assert.doesNotReject(h.bootstrap(home));
  assert.equal(h.stats().runs, 1); assert.deepEqual(h.snapshot().agents.map(a => a.run), ['ok']);
});
