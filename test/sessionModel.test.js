'use strict';
// Unit tests for lib/sessionModel.js on synthetic temp trees. AgentTracker, extractMetaSafe and eta are injected fakes:
// a fake agent file is a JSON object that becomes the AgentSnapshot, a fake script file is the JSON of its meta.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SessionModel = require('../lib/sessionModel');
const S = require('../lib/strings');

const NOW = Date.now();
const MIN = 60e3, HOUR = 3600e3;
const SID = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const J = o => JSON.stringify(o);

// ---------------------------------------------------------------- SPEC 2 typedef validator (exact key sets and types)
const T = {
  s: v => typeof v === 'string', n: v => typeof v === 'number' && Number.isFinite(v), b: v => typeof v === 'boolean',
  ns: v => v === null || typeof v === 'string', nn: v => v === null || (typeof v === 'number' && Number.isFinite(v)),
  in: (...xs) => v => xs.includes(v),
};
const shape = (o, spec, what) => {
  assert.deepEqual(Object.keys(o).sort(), Object.keys(spec).sort(), what + ' keys');
  for (const k of Object.keys(spec)) assert.ok(spec[k](o[k]), `${what}.${k} = ${JSON.stringify(o[k])}`);
};
function checkEta(e, w) {
  const opt = Object.assign({}, e.n !== undefined && { n: T.n }, e.runs !== undefined && { runs: T.n });
  shape(e, Object.assign({ kind: T.in('number', 'range', 'late', 'unknown', 'none'), basis: T.in('siblings', 'key', 'global', 'phases', 'none'), lo: T.nn, mid: T.nn, hi: T.nn, text: T.s, tip: T.s }, opt), w + ' eta');
  if ([e.lo, e.mid, e.hi].every(x => x !== null)) assert.ok(e.lo <= e.mid && e.mid <= e.hi, w + ' eta order');
}
function checkAgent(a, w) {
  shape(a, {
    id: v => T.s(v) && v.length > 0, label: T.s, phase: T.ns, kind: T.in('wf', 'task'), agentType: T.ns, shape: T.in(null, 'background', 'foreground'),
    model: m => T.ns(m.id) && T.ns(m.label) && Object.keys(m).length === 2, state: T.in('running', 'waiting', 'done', 'failed', 'interrupted', 'stopped'),
    quietSec: v => T.n(v) && v >= 0, tokens: v => T.n(v) && v >= 0, toolUses: v => T.n(v) && v >= 0, attempt: v => T.n(v) && v >= 1, startedAt: T.nn, endedAt: T.nn, durationMs: T.nn,
    cached: T.b, loading: T.b, activity: v => v === null || (T.in('tool', 'thinking', 'writing', 'waiting')(v.kind) && T.b(v.running)),
    failure: v => v === null || (T.nn(v.status) && T.ns(v.error) && T.s(v.text) && Object.keys(v).length === 3), resultPreview: v => v === null || (T.s(v) && v.length <= 160),
    eta: v => v === null || (checkEta(v, w), true),
  }, w + ' agent');
  if (a.state !== 'running' && a.state !== 'waiting') assert.equal(a.eta, null, w + ' eta only for live agents');
}
function checkCard(c, w) {
  const base = { kind: T.in('workflow', 'agent'), key: v => T.s(v) && v.length > 0, sessionId: T.s, sessionTitle: v => T.s(v) && v.length > 0, origin: T.in(null, 'VS Code', 'Desktop') };
  if (c.kind === 'agent') { shape(c, Object.assign(base, { agent: a => (checkAgent(a, w), a.kind === 'task') }), w + ' agentCard'); return; }
  shape(c, Object.assign(base, {
    runId: T.s, name: v => T.s(v) && v.length > 0, description: T.ns, status: T.s, startedAt: T.nn, endedAt: T.nn, durationMs: T.nn, agentsTotal: T.n, agentsDone: T.n, agentsFailed: T.n, tokens: T.n, toolUses: T.n,
    phases: v => Array.isArray(v), eta: v => v === null || (checkEta(v, w), true),
  }), w + ' workflowCard');
  assert.ok(c.agentsDone + c.agentsFailed <= c.agentsTotal, w + ' counters');
  for (const p of c.phases) {
    shape(p, { title: T.s, detail: T.ns, state: T.in('pending', 'running', 'done', 'partial'), done: T.n, failed: T.n, total: T.n, agents: Array.isArray }, w + ' phase');
    assert.ok(p.done + p.failed <= p.total && p.agents.length <= p.total && (p.state === 'pending') === (p.total === 0), w + ' phase counters');
    p.agents.forEach(a => checkAgent(a, w));
  }
}
function assertViewState(vs) {
  shape(vs, { v: v => v === 1, now: T.n, scope: T.in('workspace', 'all'), scopeLabel: T.s, claudeHome: T.s, running: Array.isArray, recent: Array.isArray, warnings: v => v.every(T.s), formatNote: T.ns }, 'ViewState');
  const live = c => (c.kind === 'agent' ? ['running', 'waiting'].includes(c.agent.state) : c.status === 'running');
  vs.running.concat(vs.recent).forEach(c => checkCard(c, c.key));
  const keys = vs.running.concat(vs.recent).map(c => c.key);
  assert.equal(new Set(keys).size, keys.length, 'card keys are unique');
  assert.ok(vs.running.every(live) && vs.recent.every(c => !live(c)), 'running holds running items only, recent holds finished ones');
}

function touch(file, text, ageMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const t = (NOW - (ageMs || 0)) / 1000;
  fs.utimesSync(file, t, t);
}

// ---------------------------------------------------------------- fakes
class FakeTracker {
  static reset() { FakeTracker.created = []; FakeTracker.reads = 0; FakeTracker.disposed = 0; }
  constructor(file, opts) { this.file = file; this.opts = opts; this.read = false; FakeTracker.created.push({ file, opts }); }
  poll(now, budget) {
    let st;
    try { st = fs.statSync(this.file); } catch (_) { return Object.assign(FakeTracker.base(), { missing: true }); }
    if (!this.read && !(budget && budget.bytes > 0)) return Object.assign(FakeTracker.base(), { loading: true, size: st.size, mtimeMs: st.mtimeMs });
    let spec = {};
    try { spec = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { /* head-only files etc. */ }
    if (!this.read) { this.read = true; FakeTracker.reads++; if (budget) budget.bytes -= spec.cost || 100; }
    return Object.assign(FakeTracker.base(), spec, { size: st.size, mtimeMs: st.mtimeMs });
  }
  dispose() { FakeTracker.disposed++; }
  static base() {
    return { missing: false, loading: false, badLines: 0, size: 0, mtimeMs: 0, id: null, model: { id: null, label: null }, tokens: 0, toolUses: 0, firstTs: null, lastTs: null, end: 'running', activity: null, failure: null, resultPreview: null };
  }
}
const fakeMeta = src => { try { return JSON.parse(src); } catch (_) { return null; } };
function fakeEta() {
  const e = { agentCalls: [], wfCalls: [] };
  e.estimateAgent = (input, hist) => { e.agentCalls.push({ input, hist }); return { kind: 'range', basis: 'siblings', lo: 60, mid: 120, hi: 240, text: '1-4 Min.', tip: 'tip' }; };
  e.estimateWorkflow = (input, hist) => { e.wfCalls.push({ input, hist }); return { kind: 'range', basis: 'phases', lo: 60, mid: 120, hi: 240, text: 'Rest grob: 1-4 Min.', tip: 'tip' }; };
  return e;
}
function fakeHistory() {
  const h = { runs: [], agents: [], snaps: 0 };
  h.snapshot = () => { h.snaps++; return { agents: [], phaseDurSec: [] }; };
  h.ingestRun = (id, obj, proj) => { h.runs.push({ id, obj, proj }); return true; };
  h.ingestAgent = (key, rec) => { h.agents.push({ key, rec }); return true; };
  return h;
}

// ---------------------------------------------------------------- synthetic tree
class Tree {
  constructor() { this.home = fs.mkdtempSync(path.join(os.tmpdir(), 'av-sm-')); this.projects = path.join(this.home, 'projects'); fs.mkdirSync(this.projects); }
  sd(proj, sid) { return path.join(this.projects, proj, sid); }
  transcript(proj, sid, ageMs) { touch(path.join(this.projects, proj, sid + '.jsonl'), '{}\n', ageMs); }
  runDir(proj, sid, run) { return path.join(this.sd(proj, sid), 'subagents', 'workflows', run); }
  journal(proj, sid, run, rows, ageMs, raw) { touch(path.join(this.runDir(proj, sid, run), 'journal.jsonl'), raw !== undefined ? raw : rows.map(J).join('\n') + '\n', ageMs); }
  agent(proj, sid, run, id, spec, ageMs) { touch(path.join(this.runDir(proj, sid, run), 'agent-' + id + '.jsonl'), J(spec || {}), ageMs); }
  agentMeta(proj, sid, run, id, meta) { touch(path.join(this.runDir(proj, sid, run), 'agent-' + id + '.meta.json'), J(meta)); }
  script(proj, sid, run, name, meta) { touch(path.join(this.sd(proj, sid), 'workflows', 'scripts', name + '-' + run + '.js'), J(meta)); }
  result(proj, sid, run, obj, ageMs) { touch(path.join(this.sd(proj, sid), 'workflows', run + '.json'), J(obj), ageMs); }
  plain(proj, sid, id, spec, meta, ageMs) {
    const d = path.join(this.sd(proj, sid), 'subagents');
    touch(path.join(d, 'agent-' + id + '.jsonl'), typeof spec === 'string' ? spec : J(spec || {}), ageMs);
    if (meta) touch(path.join(d, 'agent-' + id + '.meta.json'), J(meta), ageMs);
  }
  title(proj, sid, t) { touch(path.join(this.sd(proj, sid), 'custom-title.json'), J({ customTitle: t })); }
  registry(...entries) {
    fs.mkdirSync(path.join(this.home, 'sessions'), { recursive: true });
    entries.forEach((e, i) => { const pid = e.pid || process.pid + i; touch(path.join(this.home, 'sessions', pid + '.json'), J(Object.assign({ pid, sessionId: e.sid, cwd: '', entrypoint: 'claude-vscode', status: 'busy', name: null, version: '2.1.287' }, e.over || {}, { pid }))); });
  }
}
let trees = [];
const tree = () => { const t = new Tree(); trees.push(t); return t; };
test.after(() => { for (const t of trees) { try { fs.rmSync(t.home, { recursive: true, force: true }); } catch (_) { /* best effort */ } } });

function mk(t, over) {
  FakeTracker.reset();
  const eta = (over && over.eta) || fakeEta();
  const history = over && over.history !== undefined ? over.history : null;
  const o = Object.assign({ claudeHome: t.home, scope: 'all', workspaceFolders: [], recentHours: 24, staleMinutes: 10, showToolTargets: true, etaEnabled: true, history }, over);
  delete o.eta; delete o.deps;
  o.deps = Object.assign({ AgentTracker: FakeTracker, extractMetaSafe: fakeMeta, eta, prettyModel: id => (id ? 'P:' + id : null) }, over && over.deps);
  const m = new SessionModel(o);
  m.fake = eta;
  const refresh = m.refresh.bind(m);                 // every ViewState any test sees must satisfy the SPEC 2 typedefs
  m.refresh = (now, lim) => { const vs = refresh(now, lim); assertViewState(vs); return vs; };
  return m;
}
const snap = (over, ageStartMs, ageLastMs) => Object.assign({ firstTs: NOW - (ageStartMs || 0), lastTs: NOW - (ageLastMs === undefined ? 1000 : ageLastMs), tokens: 1000, toolUses: 2, model: { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' } }, over);
const wfCard = vs => vs.running.concat(vs.recent).filter(c => c.kind === 'workflow');
const phase = (c, title) => c.phases.find(p => p.title === title);
const agentOf = (c, id) => c.phases.flatMap(p => p.agents).find(a => a.id === id);

// ---------------------------------------------------------------- basics
test('missing claudeHome: empty ViewState with a hint, never an error', () => {
  const m = mk({ home: path.join(os.tmpdir(), 'av-does-not-exist-' + process.pid) });
  const vs = m.refresh(NOW);
  assert.equal(vs.v, 1);
  assert.equal(vs.now, NOW);
  assert.deepEqual(vs.running, []);
  assert.deepEqual(vs.recent, []);
  assert.equal(vs.warnings.length, 1);
  assert.match(vs.warnings[0], /Kein Sitzungsverzeichnis/);
  assert.equal(vs.formatNote, null);
  assert.deepEqual(m.watchRoots(), []);
  assert.equal(m.hasActivity(NOW + 1e6), false);
});

test('constructor defaults and dispose do not throw', () => {
  const m = new SessionModel({ claudeHome: os.tmpdir() + '/nothing-here', deps: { AgentTracker: FakeTracker, extractMetaSafe: fakeMeta, eta: fakeEta(), prettyModel: x => x } });
  assert.doesNotThrow(() => m.refresh(NOW));
  assert.doesNotThrow(() => m.dispose());
  assert.doesNotThrow(() => m.setOptions(null));
});

// ---------------------------------------------------------------- live run
test('live run: phases, counters, header sums, start time, ETA inputs (SPEC 5.2 / 6.1)', () => {
  const t = tree(), P = 'c--proj', sid = SID(1), run = 'wf_live1';
  t.transcript(P, sid, 5000);
  t.registry({ sid, over: { name: 'coding-92', entrypoint: 'claude-vscode' } });
  t.script(P, sid, run, 'demo-wf', { name: 'demo', description: 'Demo run', phases: [{ title: 'Research', detail: 'read' }, { title: 'Spec', detail: null }, { title: 'Critic', detail: 'check' }] });
  t.journal(P, sid, run, [{ type: 'launched' },
    { type: 'started', key: 'k1', agentId: 'a1', label: 'research:x', phase: 'Research' }, { type: 'started', key: 'k2', agentId: 'a2', label: 'research:y', phase: 'Research' },
    { type: 'result', key: 'k1', agentId: 'a1', result: { r: 1 } }, { type: 'result', key: 'k2', agentId: 'a2', result: 'text result' },
    { type: 'started', key: 'k3', agentId: 'a3', label: 'spec', phase: 'Spec' }], 1000);
  t.agent(P, sid, run, 'a1', snap({ end: 'finished', tokens: 111, toolUses: 5, resultPreview: 'prev1' }, 600e3, 400e3));
  t.agent(P, sid, run, 'a2', snap({ end: 'finished', tokens: 222, toolUses: 6 }, 590e3, 300e3));
  t.agent(P, sid, run, 'a3', snap({ tokens: 333, toolUses: 7, activity: { kind: 'tool', tool: 'Grep', target: 'x.js', running: true } }, 120e3, 2000), 1000);
  const m = mk(t, { history: fakeHistory() });
  const vs = m.refresh(NOW);
  assert.equal(vs.running.length, 1);
  const c = vs.running[0];
  assert.equal(c.kind, 'workflow');
  assert.equal(c.runId, run);
  assert.equal(c.sessionId, sid);
  assert.equal(c.sessionTitle, 'coding-92');
  assert.equal(c.origin, 'VS Code');
  assert.equal(c.name, 'demo');
  assert.equal(c.description, 'Demo run');
  assert.equal(c.status, 'running');
  assert.equal(c.startedAt, NOW - 600e3);
  assert.equal(c.endedAt, null);
  assert.equal(c.durationMs, null);
  assert.deepEqual([c.agentsTotal, c.agentsDone, c.agentsFailed, c.tokens, c.toolUses], [3, 2, 0, 666, 18]);
  assert.deepEqual(c.phases.map(p => [p.title, p.detail, p.state, p.done, p.failed, p.total]), [
    ['Research', 'read', 'done', 2, 0, 2], ['Spec', null, 'running', 0, 0, 1], ['Critic', 'check', 'pending', 0, 0, 0]]);
  const a3 = agentOf(c, 'a3');
  assert.equal(a3.state, 'running');
  assert.equal(a3.kind, 'wf');
  assert.deepEqual(a3.activity, { kind: 'tool', tool: 'Grep', target: 'x.js', running: true });
  assert.equal(a3.model.label, 'Sonnet 5.5');
  assert.equal(a3.durationMs, null);
  assert.equal(a3.endedAt, null);
  assert.equal(a3.quietSec, 2);
  assert.equal(a3.eta.kind, 'range');
  const a1 = agentOf(c, 'a1');
  assert.deepEqual([a1.state, a1.endedAt, a1.durationMs, a1.resultPreview], ['done', NOW - 400e3, 200e3, 'prev1']);
  assert.equal(agentOf(c, 'a2').resultPreview, 'text result');                 // journal result string as fallback
  // ETA inputs
  assert.equal(m.fake.agentCalls.length, 1);
  const inp = m.fake.agentCalls[0].input;
  assert.equal(inp.state, 'running');
  assert.equal(inp.kind, 'wf');
  assert.equal(inp.label, 'spec');
  assert.equal(inp.phase, 'Spec');
  assert.equal(inp.project, 'c--proj');
  assert.equal(inp.runId, run);
  assert.equal(inp.model, 'claude-sonnet-5-5');
  assert.equal(Math.round(inp.elapsedSec), 120);
  assert.equal(inp.silentSec, 2);
  assert.deepEqual(inp.siblingsDoneSec, []);                                    // no finished sibling in phase "Spec"
  assert.deepEqual(inp.siblingsRunningSec, []);                                 // and no other running one
  assert.deepEqual([inp.phaseSize, inp.phasePos], [1, 0.5]);                    // one agent started in the phase, second of three phases
  assert.deepEqual(inp.otherPhases, [{ size: 2, pos: 0, doneSec: [200, 290] }]);  // what the finished phase "Research" tells about this run
  assert.equal(m.fake.wfCalls.length, 1);
  const w = m.fake.wfCalls[0].input;
  assert.equal(w.phasesAhead, 1);                                               // Critic has no slot yet
  assert.deepEqual(w.siblingsDoneSec, []);
  assert.equal(w.runningSec.length, 1);
  assert.deepEqual([w.phaseSize, w.phasePos], [1, 0.5]);
  assert.deepEqual(w.otherPhases, [{ size: 2, pos: 0, doneSec: [200, 290] }]);
  assert.equal(c.eta.kind, 'range');
  assert.equal(m.fake.wfCalls[0].hist.phaseDurSec.length, 0);                   // History.snapshot() reaches the estimator
});

test('ETA siblings: finished same-phase siblings of the same run, cached ones excluded, recomputed only every 20 s', () => {
  const t = tree(), P = 'c--proj', sid = SID(2), run = 'wf_sib';
  t.transcript(P, sid, 1000);
  t.registry({ sid });
  t.journal(P, sid, run, ['s1', 's2', 's3', 's4'].map((k, i) => ({ type: 'started', key: k, agentId: k, label: 'work:' + k, phase: i === 3 ? 'Other' : 'Work' }))
    .concat([{ type: 'result', key: 's1', agentId: 's1', result: {} }, { type: 'result', key: 's2', agentId: 's2', result: {} }, { type: 'result', key: 's4', agentId: 's4', result: {} }]), 500);
  t.agent(P, sid, run, 's1', snap({ end: 'finished' }, 400e3, 100e3));         // 300 s
  t.agent(P, sid, run, 's2', snap({ end: 'finished' }, 380e3, 180e3));         // 200 s
  t.agent(P, sid, run, 's3', snap({}, 100e3, 1000), 1000);
  t.agent(P, sid, run, 's4', snap({ end: 'finished' }, 400e3, 1e3));           // other phase
  const m = mk(t);
  m.refresh(NOW);
  assert.equal(m.fake.agentCalls.length, 1);
  assert.deepEqual(m.fake.agentCalls[0].input.siblingsDoneSec.sort(), [200, 300]);
  m.refresh(NOW + 5000);                                                        // same siblings, < 20 s: no recomputation
  assert.equal(m.fake.agentCalls.length, 1);
  m.refresh(NOW + 21000);
  assert.equal(m.fake.agentCalls.length, 2);
  m.setOptions({ etaEnabled: false });
  const vs = m.refresh(NOW + 22000);
  assert.equal(m.fake.agentCalls.length, 2);
  assert.equal(agentOf(vs.running[0], 's3').eta, null);
  assert.equal(vs.running[0].eta, null);
});

test('run status rules (SPEC 3.8) and the orphan guard', () => {
  const cases = [
    // [label, registry?, liveEntry, quietMs, staleMinutes, expected status]
    ['live registry session, quiet 5 min', true, true, 5 * MIN, 10, 'running'],
    ['registry present, session not in it, quiet 5 min', true, false, 5 * MIN, 10, 'stopped'],
    ['registry present, session not in it, quiet 30 s', true, false, 30e3, 10, 'running'],
    ['no registry dir, quiet 5 min (< staleMinutes)', false, false, 5 * MIN, 10, 'running'],
    ['no registry dir, quiet 15 min', false, false, 15 * MIN, 10, 'stopped'],
    ['no registry dir, quiet 15 min, staleMinutes 30', false, false, 15 * MIN, 30, 'running'],
    ['live registry session, silent 2 h: orphaned earlier run', true, true, 2 * HOUR, 10, 'stopped'],
  ];
  cases.forEach(([label, regDir, liveEntry, quiet, stale, want], i) => {
    const t = tree(), P = 'c--p', sid = SID(10 + i), run = 'wf_s' + i;
    t.transcript(P, sid, quiet);
    if (regDir) { if (liveEntry) t.registry({ sid }); else t.registry({ sid: SID(999) }); }
    t.journal(P, sid, run, [{ type: 'started', key: 'k', agentId: 'a', label: 'x', phase: 'P' }, { type: 'started', key: 'k2', agentId: 'b', label: 'y', phase: 'P' }, { type: 'result', key: 'k2', agentId: 'b', result: {} }], quiet);
    t.agent(P, sid, run, 'a', snap({}, quiet + 1000, quiet), quiet);
    t.agent(P, sid, run, 'b', snap({ end: 'finished' }, quiet + 1000, quiet), quiet);
    const m = mk(t, { staleMinutes: stale, recentHours: 48 });
    const vs = m.refresh(NOW);
    const c = wfCard(vs)[0];
    assert.ok(c, label + ': card missing');
    assert.equal(c.status, want, label);
    assert.equal(agentOf(c, 'a').state, want === 'running' ? 'running' : 'stopped', label);
    assert.equal(agentOf(c, 'b').state, 'done', label);                         // journal outcome stays
    assert.equal(vs.running.length, want === 'running' ? 1 : 0, label);
    if (want === 'stopped') {
      assert.equal(vs.recent.length, 1, label);
      assert.equal(c.endedAt, NOW - quiet, label);
      assert.ok(c.durationMs >= 0);
      assert.equal(agentOf(c, 'a').quietSec, 0);
      assert.equal(agentOf(c, 'a').eta, null);
    }
  });
});

test('agent state: the journal is authoritative, the file tail only adds interrupted / failed / activity (SPEC 4.5)', () => {
  const t = tree(), P = 'c--p', sid = SID(20), run = 'wf_states';
  t.transcript(P, sid, 1000); t.registry({ sid });
  const rows = [['j_done', 'done'], ['j_fail', 'failed'], ['t_int', null], ['t_run', null], ['t_fail', null], ['t_wait', null], ['t_fin', null]];
  t.journal(P, sid, run, rows.map(([k]) => ({ type: 'started', key: k, agentId: k, label: k, phase: 'P' })).concat([
    { type: 'result', key: 'j_done', agentId: 'j_done', result: {} }, { type: 'failed', key: 'j_fail', agentId: 'j_fail' }]), 500);
  const fail = { status: 429, error: 'rate_limit', text: 'limit hit' };
  t.agent(P, sid, run, 'j_done', snap({ end: 'running' }, 9e4, 5e3));
  t.agent(P, sid, run, 'j_fail', snap({ end: 'failed', failure: fail }, 9e4, 5e3));
  t.agent(P, sid, run, 't_int', snap({ end: 'interrupted' }, 9e4, 5e3));
  t.agent(P, sid, run, 't_run', snap({ end: 'running' }, 9e4, 5e3));
  t.agent(P, sid, run, 't_fail', snap({ end: 'failed', failure: fail }, 9e4, 5e3));
  t.agent(P, sid, run, 't_wait', snap({ end: 'waiting' }, 9e4, 5e3));
  t.agent(P, sid, run, 't_fin', snap({ end: 'finished' }, 9e4, 5e3));
  const c = wfCard(mk(t).refresh(NOW))[0];
  const st = Object.fromEntries(c.phases[0].agents.map(a => [a.id, a.state]));
  assert.deepEqual(st, { j_done: 'done', j_fail: 'failed', t_int: 'interrupted', t_run: 'running', t_fail: 'failed', t_wait: 'waiting', t_fin: 'running' });
  assert.deepEqual(agentOf(c, 'j_fail').failure, fail);
  assert.equal(agentOf(c, 't_run').failure, null);
  assert.equal(c.phases[0].state, 'running');
  assert.equal(c.agentsFailed, 2);
});

test('retry and restart: latest attempt wins, attempt counter and the "(retry n)" suffix', () => {
  const t = tree(), P = 'c--p', sid = SID(21), run = 'wf_retry';
  t.transcript(P, sid, 1000); t.registry({ sid });
  t.journal(P, sid, run, [{ type: 'started', key: 'k', agentId: 'old', label: 'verify:b (retry 1)', phase: 'V' }, { type: 'started', key: 'k', agentId: 'new', label: 'verify:b', phase: 'V' },
    { type: 'result', key: 'k', agentId: 'old', result: 'late answer of the stalled attempt' }], 500);
  t.agent(P, sid, run, 'old', snap({ end: 'finished' }, 9e5, 5e5));
  t.agent(P, sid, run, 'new', snap({}, 1e5, 1000));
  const c = wfCard(mk(t).refresh(NOW))[0];
  assert.equal(c.agentsTotal, 1);
  const a = c.phases[0].agents[0];
  assert.deepEqual([a.id, a.attempt, a.state, a.label], ['new', 2, 'running', 'verify:b']);
});

test('torn last journal line is ignored until it is complete', () => {
  const t = tree(), P = 'c--p', sid = SID(22), run = 'wf_torn';
  t.transcript(P, sid, 1000); t.registry({ sid });
  const full = [{ type: 'started', key: 'k', agentId: 'a', label: 'x', phase: 'P' }, { type: 'result', key: 'k', agentId: 'a', result: 'ok' }].map(J).join('\n') + '\n';
  t.journal(P, sid, run, null, 500, full.slice(0, full.length - 8));
  t.agent(P, sid, run, 'a', snap({ end: 'finished' }, 9e4, 5e3));
  const m = mk(t);
  assert.equal(agentOf(wfCard(m.refresh(NOW))[0], 'a').state, 'running');
  t.journal(P, sid, run, null, 0, full);
  assert.equal(agentOf(wfCard(m.refresh(NOW + 1000))[0], 'a').state, 'done');
});

test('no journal: slots from the agent files and their meta.json, state from the tail', () => {
  const t = tree(), P = 'c--p', sid = SID(23), run = 'wf_nojournal';
  t.transcript(P, sid, 1000); t.registry({ sid });
  t.agent(P, sid, run, 'a1', snap({ end: 'finished' }, 9e4, 5e3)); t.agentMeta(P, sid, run, 'a1', { description: 'first', workflowPhase: 'Alpha' });
  t.agent(P, sid, run, 'a2', snap({}, 9e4, 1e3)); t.agentMeta(P, sid, run, 'a2', { description: 'second', workflowPhase: 'Beta' });
  const c = wfCard(mk(t).refresh(NOW))[0];
  assert.equal(c.name, run);                                                    // no script: name falls back to the run id
  assert.equal(c.description, null);
  assert.deepEqual(c.phases.map(p => [p.title, p.state]), [['Alpha', 'done'], ['Beta', 'running']]);
  assert.equal(c.phases[0].agents[0].label, 'first');
});

test('script lookup across the folders of one session; name falls back to the script file name', () => {
  const t = tree(), sid = SID(24), run = 'wf_multi';
  t.transcript('pA', sid, 1000);
  t.registry({ sid });
  t.journal('pB', sid, run, [{ type: 'started', key: 'k', agentId: 'a', label: 'x', phase: 'P' }], 500);
  t.agent('pB', sid, run, 'a', snap({}, 9e4, 1e3));
  t.script('pC', sid, run, 'folder-name', null);                                // meta unparsable -> name from the file name
  fs.mkdirSync(path.join(t.sd('pC', sid), 'subagents'), { recursive: true });
  const c = wfCard(mk(t).refresh(NOW))[0];
  assert.equal(c.name, 'folder-name');
  assert.equal(c.agentsTotal, 1);
  t.script('pA', sid, run, 'other', { name: 'from-meta', phases: [{ title: 'P', detail: 'd' }] });
  fs.mkdirSync(path.join(t.sd('pA', sid), 'subagents'), { recursive: true });
  const c2 = wfCard(mk(t).refresh(NOW))[0];
  assert.equal(c2.name, 'from-meta');
});

// ---------------------------------------------------------------- finished runs
const resultFile = (over, agents, phases) => Object.assign({
  runId: 'wf_done1', timestamp: new Date(NOW - 10 * MIN).toISOString(), script: 'x'.repeat(5000), scriptPath: 'C:\\somewhere\\s.js', result: null, agentCount: agents.length, logs: [],
  durationMs: 120e3, summary: 'What the run did', workflowName: 'demo-done', status: 'completed', startTime: NOW - 12 * MIN, defaultModel: 'claude-opus-5[1m]',
  phases: phases || [{ title: 'Research', detail: 'read' }, { title: 'Critic', detail: 'check' }],
  workflowProgress: [{ type: 'workflow_phase', index: 1, title: 'Research' }, { type: 'workflow_phase', index: 2, title: 'Critic' }].concat(agents),
  totalTokens: 5000, totalToolCalls: 40,
}, over);
const wa = (o) => Object.assign({ type: 'workflow_agent', index: 1, label: 'a', phaseIndex: 1, phaseTitle: 'Research', agentId: 'x1', model: 'claude-opus-5[1m]', state: 'done', startedAt: NOW - 700e3, queuedAt: NOW - 701e3, attempt: 1, lastProgressAt: NOW - 600e3, tokens: 1000, toolCalls: 10, durationMs: 100e3, resultPreview: '{"a":1}' }, o);

test('finished run: read from the result file only, no transcript is touched, ingested into the history once', () => {
  const t = tree(), P = 'c--p', sid = SID(30), run = 'wf_done1';
  t.transcript(P, sid, 20 * MIN);
  t.journal(P, sid, run, [{ type: 'started', key: 'k', agentId: 'x1', label: 'a', phase: 'Research' }], 20 * MIN);
  t.agent(P, sid, run, 'x1', snap({}, 9e5, 5e5), 20 * MIN);
  t.result(P, sid, run, resultFile({}, [
    wa({ index: 1, label: 'a', agentId: 'x1' }),
    wa({ index: 2, label: 'verify:b (retry 1)', agentId: 'x2', attempt: 2, tokens: 2000, toolCalls: 20, durationMs: 50e3, lastAgentType: 1, agentType: 'claude-code-guide', model: 'claude-haiku-4-5-20251001' }),
    wa({ index: 3, label: 'c', agentId: 'x3', cached: true, tokens: undefined, toolCalls: undefined, durationMs: undefined, queuedAt: undefined, attempt: undefined, startedAt: NOW - 300e3, lastProgressAt: NOW - 300e3 }),
    wa({ index: 4, label: 'd', agentId: 'x4', state: 'error', error: 'API Error: 529 overloaded', durationMs: 30e3, resultPreview: undefined, tokens: 77, toolCalls: 1 }),
  ]), 10 * MIN);
  const hist = fakeHistory();
  const m = mk(t, { history: hist });
  const vs = m.refresh(NOW);
  assert.equal(vs.running.length, 0);
  assert.equal(vs.recent.length, 1);
  const c = vs.recent[0];
  assert.deepEqual([c.kind, c.runId, c.name, c.description, c.status], ['workflow', 'wf_done1', 'demo-done', 'What the run did', 'completed']);
  assert.deepEqual([c.startedAt, c.endedAt, c.durationMs, c.tokens, c.toolUses], [NOW - 12 * MIN, NOW - 10 * MIN, 120e3, 5000, 40]);
  assert.deepEqual([c.agentsTotal, c.agentsDone, c.agentsFailed], [4, 3, 1]);
  assert.deepEqual(c.phases.map(p => [p.title, p.detail, p.state, p.done, p.failed, p.total]), [['Research', 'read', 'partial', 3, 1, 4], ['Critic', 'check', 'pending', 0, 0, 0]]);
  const x1 = agentOf(c, 'x1'), x2 = agentOf(c, 'x2'), x3 = agentOf(c, 'x3'), x4 = agentOf(c, 'x4');
  assert.deepEqual([x1.state, x1.tokens, x1.toolUses, x1.durationMs, x1.startedAt, x1.endedAt, x1.model], ['done', 1000, 10, 100e3, NOW - 700e3, NOW - 600e3, { id: 'claude-opus-5[1m]', label: 'P:claude-opus-5[1m]' }]);
  assert.deepEqual([x2.label, x2.attempt, x2.agentType, x2.model.id], ['verify:b', 2, 'claude-code-guide', 'claude-haiku-4-5-20251001']);
  assert.deepEqual([x3.cached, x3.tokens, x3.durationMs, x3.startedAt, x3.attempt, x3.state], [true, 0, null, null, 1, 'done']);
  assert.deepEqual([x4.state, x4.failure, x4.resultPreview, x4.eta, x4.quietSec], ['failed', { status: 529, error: null, text: 'API Error: 529 overloaded' }, null, null, 0]);
  assert.equal(x1.resultPreview, '{"a":1}');
  assert.deepEqual(FakeTracker.created, [], 'no AgentTracker may exist for a finished run');
  assert.equal(hist.runs.length, 1);
  assert.equal(hist.runs[0].id, 'wf_done1');
  assert.equal(hist.runs[0].obj.workflowName, 'demo-done');
  assert.equal(hist.runs[0].proj, 'c--p');
  m.refresh(NOW + 1000);
  assert.equal(hist.runs.length, 1, 'ingested once per model instance');
  assert.equal(m.fake.agentCalls.length, 0);
});

test('killed run: progress agents are interrupted, run keeps its status verbatim, unknown status is passed through', () => {
  const t = tree(), P = 'c--p', sid = SID(31);
  t.transcript(P, sid, 20 * MIN);
  const killed = resultFile({ runId: 'wf_k', status: 'killed', error: 'Error: Workflow aborted', timestamp: new Date(NOW - 5 * MIN).toISOString() }, [
    wa({ agentId: 'p1', state: 'progress', durationMs: undefined, resultPreview: undefined, startedAt: NOW - 8 * MIN, lastProgressAt: NOW - 6 * MIN, tokens: 500, toolCalls: 3 })]);
  t.result(P, sid, 'wf_k', killed, 5 * MIN);
  t.result(P, sid, 'wf_odd', resultFile({ runId: 'wf_odd', status: 'weird-new-status' }, [wa({ agentId: 'q1' })]), 4 * MIN);
  const vs = mk(t).refresh(NOW);
  const k = vs.recent.find(c => c.runId === 'wf_k'), odd = vs.recent.find(c => c.runId === 'wf_odd');
  assert.equal(k.status, 'killed');
  const p1 = agentOf(k, 'p1');
  assert.deepEqual([p1.state, p1.endedAt, p1.durationMs, p1.tokens], ['interrupted', NOW - 5 * MIN, 3 * MIN, 500]);
  assert.equal(k.phases[0].state, 'partial');
  assert.equal(odd.status, 'weird-new-status');
  assert.deepEqual(vs.recent.map(c => c.runId), ['wf_k', 'wf_odd'], 'newest first');
});

test('a result file appearing for a live run turns it into a finished card on the next tick', () => {
  const t = tree(), P = 'c--p', sid = SID(32), run = 'wf_switch';
  t.transcript(P, sid, 1000); t.registry({ sid });
  t.journal(P, sid, run, [{ type: 'started', key: 'k', agentId: 'x1', label: 'a', phase: 'Research' }], 500);
  t.agent(P, sid, run, 'x1', snap({}, 9e4, 1e3));
  const hist = fakeHistory();
  const m = mk(t, { history: hist });
  let vs = m.refresh(NOW);
  assert.equal(vs.running.length, 1);
  assert.equal(hist.runs.length, 0);
  t.result(P, sid, run, resultFile({ runId: run, timestamp: new Date(NOW).toISOString() }, [wa({ agentId: 'x1' })]), 0);
  vs = m.refresh(NOW + 1000);
  assert.equal(vs.running.length, 0);
  assert.equal(vs.recent.length, 1);
  assert.equal(vs.recent[0].status, 'completed');
  assert.equal(vs.recent[0].name, 'demo-done');
  assert.equal(hist.runs.length, 1);
});

test('resumed run: a result file older than the journal is the earlier launch, so the run shows as live; a rewritten file wins again', () => {
  const t = tree(), P = 'c--p', sid = SID(33), run = 'wf_resumed';
  t.transcript(P, sid, 1000); t.registry({ sid });
  t.journal(P, sid, run, [{ type: 'started', key: 'k', agentId: 'x1', label: 'a', phase: 'Research' }], 1000);     // the resumed launch is writing now
  t.agent(P, sid, run, 'x1', snap({}, 9e4, 1e3), 1000);
  t.result(P, sid, run, resultFile({ runId: run, timestamp: new Date(NOW - 3 * HOUR).toISOString() }, [wa({ agentId: 'x1' })]), 3 * HOUR);
  const hist = fakeHistory();
  const m = mk(t, { history: hist });
  let vs = m.refresh(NOW);
  assert.equal(vs.recent.length, 0);
  assert.equal(vs.running.length, 1);
  assert.equal(vs.running[0].status, 'running');
  assert.equal(agentOf(vs.running[0], 'x1').state, 'running');
  assert.equal(hist.runs.length, 0, 'the stale file is neither shown nor ingested');
  t.result(P, sid, run, resultFile({ runId: run, timestamp: new Date(NOW).toISOString() }, [wa({ agentId: 'x1' })]), 0);   // the resumed launch ends: file newer than the journal
  vs = m.refresh(NOW + 6000);
  assert.equal(vs.running.length, 0);
  assert.equal(vs.recent.length, 1);
  assert.equal(vs.recent[0].status, 'completed');
  assert.equal(hist.runs.length, 1);
  // the harness writes agent files and the journal a little around the result file: a few seconds of skew is the same launch
  const sid2 = SID(34), run2 = 'wf_skew';
  t.transcript(P, sid2, 20e3);
  t.journal(P, sid2, run2, [{ type: 'started', key: 'k', agentId: 'y1', label: 'a', phase: 'Research' }], 5e3);
  t.agent(P, sid2, run2, 'y1', snap({ end: 'finished' }, 9e4, 5e3), 5e3);
  t.result(P, sid2, run2, resultFile({ runId: run2, timestamp: new Date(NOW - 10e3).toISOString() }, [wa({ agentId: 'y1' })]), 10e3);
  vs = m.refresh(NOW + 12000);
  assert.ok(vs.recent.some(c => c.runId === run2), 'journal 5 s newer than the file still counts as finished');
  assert.ok(!vs.running.some(c => c.runId === run2));
});

test('recent list: only runs finished within recentHours, newest first, at most 20; old result files are not even read', () => {
  const t = tree(), P = 'c--p', sid = SID(33);
  t.transcript(P, sid, 5 * MIN);
  for (let i = 0; i < 25; i++) {
    const age = (i + 1) * 30 * MIN;
    t.result(P, sid, 'wf_r' + String(i).padStart(2, '0'), resultFile({ runId: 'wf_r' + i, timestamp: new Date(NOW - age).toISOString() }, [wa({ agentId: 'r' + i })]), age);
  }
  for (let i = 0; i < 3; i++) t.result(P, sid, 'wf_old' + i, resultFile({ runId: 'wf_old' + i, timestamp: new Date(NOW - 30 * HOUR).toISOString() }, [wa({ agentId: 'o' + i })]), 30 * HOUR);
  const hist = fakeHistory();
  const m = mk(t, { history: hist });
  const vs = m.refresh(NOW);
  assert.equal(vs.recent.length, 20);
  assert.deepEqual(vs.recent.map(c => c.runId), Array.from({ length: 20 }, (_, i) => 'wf_r' + String(i).padStart(2, '0')));
  assert.equal(hist.runs.length, 25, 'the 3 runs older than 24 h are skipped without reading');
  m.setOptions({ recentHours: 48 });
  m.refresh(NOW + 10000);
  assert.equal(hist.runs.length, 28, 'a larger window reads them');
});

test('a corrupt result file does not break the session and is retried', () => {
  const t = tree(), P = 'c--p', sid = SID(34);
  t.transcript(P, sid, 5 * MIN);
  touch(path.join(t.sd(P, sid), 'workflows', 'wf_bad.json'), '{"runId": "wf_bad", "workflowProgress": [', 5 * MIN);
  t.result(P, sid, 'wf_good', resultFile({ runId: 'wf_good' }, [wa({ agentId: 'g1' })]), 5 * MIN);
  const m = mk(t);
  const vs = m.refresh(NOW);
  assert.deepEqual(vs.recent.map(c => c.runId), ['wf_good']);
  assert.deepEqual(vs.warnings, []);
  t.result(P, sid, 'wf_bad', resultFile({ runId: 'wf_bad', workflowName: 'fixed' }, [wa({ agentId: 'b1' })]), 4 * MIN);
  const vs2 = m.refresh(NOW + 3000);
  assert.deepEqual(vs2.recent.map(c => c.runId).sort(), ['wf_bad', 'wf_good']);
});

// ---------------------------------------------------------------- plain agents
test('plain agents: states, card shape, ETA kind, history ingest, old files skipped (SPEC 5.4 / 4.5)', () => {
  const t = tree(), P = 'c--p', sid = SID(40);
  t.transcript(P, sid, 1000);
  t.registry({ sid });
  const meta = d => ({ agentType: 'Explore', description: d, requestShape: 'background', toolUseId: 'tu', model: 'haiku' });
  t.plain(P, sid, 'run1', snap({ activity: { kind: 'thinking', running: true } }, 30e3, 2e3), meta('Find the parser'), 2000);
  t.plain(P, sid, 'fin1', snap({ end: 'finished', resultPreview: 'the report' }, 90e3, 50e3), meta('Summarise'), 50e3);
  t.plain(P, sid, 'wait1', snap({ end: 'waiting' }, 200e3, 90e3), meta('Idle one'), 90e3);
  t.plain(P, sid, 'wait2', snap({ end: 'waiting' }, 20e3, 5e3), meta('Fresh idle'), 5e3);
  t.plain(P, sid, 'fail1', snap({ end: 'failed', failure: { status: 429, error: 'rate_limit', text: 'limit' } }, 90e3, 50e3), meta('Failing'), 50e3);
  t.plain(P, sid, 'int1', snap({ end: 'interrupted' }, 90e3, 50e3), meta('Interrupted'), 50e3);
  t.plain(P, sid, 'old1', snap({ end: 'finished' }, 50 * HOUR, 49 * HOUR), meta('Ancient'), 49 * HOUR);
  t.plain(P, sid, 'nometa', snap({ end: 'finished' }, 90e3, 50e3, 50e3), null, 50e3);
  const hist = fakeHistory();
  const m = mk(t, { history: hist });
  const vs = m.refresh(NOW);
  const by = id => [...vs.running, ...vs.recent].find(c => c.kind === 'agent' && c.agent.id === id);
  assert.equal(by('old1'), undefined);
  assert.ok(!FakeTracker.created.some(c => /old1/.test(c.file)), 'no tracker for a file older than recentHours');
  const run1 = by('run1');
  assert.deepEqual(Object.keys(run1).sort(), ['agent', 'key', 'kind', 'origin', 'sessionId', 'sessionTitle']);
  assert.equal(run1.key, sid + ':run1');
  assert.deepEqual([run1.agent.kind, run1.agent.phase, run1.agent.label, run1.agent.agentType, run1.agent.shape, run1.agent.state], ['task', null, 'Find the parser', 'Explore', 'background', 'running']);
  assert.deepEqual(run1.agent.activity, { kind: 'thinking', running: true });
  assert.equal(run1.agent.eta.kind, 'range');
  assert.equal(m.fake.agentCalls[0].input.kind, 'task');
  assert.equal(m.fake.agentCalls[0].input.agentType, 'Explore');
  assert.deepEqual(m.fake.agentCalls[0].input.siblingsDoneSec, []);
  assert.equal(by('fin1').agent.state, 'done');
  assert.equal(by('fin1').agent.resultPreview, 'the report');
  assert.equal(by('fin1').agent.durationMs, 40e3);
  assert.deepEqual(by('wait1').agent.state, 'done');
  assert.equal(by('wait1').agent.resultPreview, S.noReport);
  assert.equal(by('wait2').agent.state, 'waiting');
  assert.equal(by('wait2').agent.eta, null);
  assert.deepEqual([by('fail1').agent.state, by('fail1').agent.failure.status], ['failed', 429]);
  assert.equal(by('int1').agent.state, 'interrupted');
  assert.equal(by('nometa').agent.label, 'nometa');
  assert.deepEqual(vs.running.map(c => c.agent.id).sort(), ['run1', 'wait2']);
  // ingested once when done (successful ends only: not the 'ohne Bericht' one)
  assert.deepEqual(hist.agents.map(a => a.key).sort(), [sid + ':fin1', sid + ':nometa']);
  const r = hist.agents.find(a => a.key === sid + ':fin1').rec;
  assert.deepEqual([r.kind, r.prefix, r.phase, r.proj, r.run, r.durSec, r.model], ['task', 'explore', null, 'c--p', 's:' + sid, 40, 'claude-sonnet-5-5']);
  m.refresh(NOW + 1000);
  assert.equal(hist.agents.length, 2);
  assert.equal(FakeTracker.created.every(c => c.opts.isWf === false), true);
});

test('plain agent: not alive and quiet -> stopped; recent activity keeps it running; resumed agent flips back', () => {
  const t = tree(), P = 'c--p', sid = SID(41);
  t.transcript(P, sid, 10 * MIN);
  t.registry({ sid: SID(999) });                                                // registry exists, this session is not live
  t.plain(P, sid, 'gone', snap({}, 12 * MIN, 5 * MIN), { description: 'Stuck' }, 5 * MIN);
  t.plain(P, sid, 'hot', snap({}, 12 * MIN, 20e3), { description: 'Hot' }, 20e3);
  const vs = mk(t).refresh(NOW);
  const all = vs.running.concat(vs.recent);
  assert.equal(all.find(c => c.agent.id === 'gone').agent.state, 'stopped');
  assert.equal(all.find(c => c.agent.id === 'hot').agent.state, 'running');
  assert.deepEqual(vs.running.map(c => c.agent.id), ['hot']);
  assert.deepEqual(vs.recent.map(c => c.agent.id), ['gone']);
});

// ---------------------------------------------------------------- scope, discovery, titles
test('scope workspace: matching project dirs + live registry sessions inside the folder; empty window behaves as "all"', () => {
  const t = tree(), WS = process.platform === 'win32' ? 'C:\\ws\\app' : '/ws/app';
  const sub = process.platform === 'win32' ? 'c:\\ws\\app\\sub' : '/ws/app/sub';
  const mkPlain = (P, sid, id) => { t.transcript(P, sid, 1000); t.plain(P, sid, id, snap({ end: 'finished' }, 9e4, 5e4), { description: id }, 5e4); };
  const enc = s => s.replace(/[^a-zA-Z0-9]/g, '-');
  mkPlain(enc(WS), SID(50), 'inA');
  mkPlain(enc(WS) + '-sub', SID(51), 'inB');                                   // other project folder, live session in a subfolder
  mkPlain('C--elsewhere', SID(52), 'inC');
  t.registry({ sid: SID(51), over: { cwd: sub, name: 'sub-session' } }, { sid: SID(52), over: { cwd: process.platform === 'win32' ? 'C:\\elsewhere' : '/elsewhere' } });
  const ids = vs => vs.running.concat(vs.recent).map(c => c.agent.id).sort();
  const m = mk(t, { scope: 'workspace', workspaceFolders: [WS] });
  let vs = m.refresh(NOW);
  assert.deepEqual(ids(vs), ['inA', 'inB']);
  assert.equal(vs.scope, 'workspace');
  assert.equal(vs.scopeLabel, S.scopeWorkspace);
  assert.equal(vs.claudeHome, t.home);
  assert.deepEqual(m.watchRoots().map(d => path.basename(d)).sort(), [enc(WS), enc(WS) + '-sub'].sort());
  m.setOptions({ scope: 'all' });
  vs = m.refresh(NOW + 1);
  assert.deepEqual(ids(vs), ['inA', 'inB', 'inC']);
  assert.equal(vs.scopeLabel, S.scopeAll);
  assert.deepEqual(m.watchRoots(), [t.projects]);
  m.setOptions({ scope: 'workspace', workspaceFolders: [] });
  vs = m.refresh(NOW + 2);
  assert.deepEqual(ids(vs), ['inA', 'inB', 'inC']);
  assert.equal(vs.scope, 'workspace');
  assert.equal(vs.scopeLabel, S.scopeAllNoFolder);
});

test('inclusion: live or active within recentHours; cold sessions are built once and re-checked only when their activity changed', () => {
  const t = tree(), P = 'c--p';
  t.transcript(P, SID(60), 2 * HOUR); t.plain(P, SID(60), 'cold', snap({ end: 'finished' }, 3 * HOUR, 2 * HOUR), { description: 'cold' }, 2 * HOUR);
  t.transcript(P, SID(61), 40 * HOUR); t.plain(P, SID(61), 'ancient', snap({ end: 'finished' }, 41 * HOUR, 40 * HOUR), { description: 'ancient' }, 40 * HOUR);
  t.transcript(P, SID(62), 40 * HOUR); t.registry({ sid: SID(62) });             // old but live
  const m = mk(t);
  let vs = m.refresh(NOW);
  assert.deepEqual(vs.recent.map(c => c.agent.id), ['cold']);
  assert.equal(FakeTracker.created.length, 1);
  m.refresh(NOW + 2000);
  assert.equal(FakeTracker.created.length, 1, 'cold session is not rebuilt');
  t.plain(P, SID(60), 'cold2', snap({ end: 'finished' }, 100e3, 50e3), { description: 'cold2' }, 50e3);
  vs = m.refresh(NOW + 7000);                                                    // discovery notices the new activity
  assert.deepEqual(vs.recent.map(c => c.agent.id).sort(), ['cold', 'cold2']);
});

test('session title: custom-title.json, then registry name, then the first 8 characters of the id', () => {
  const t = tree(), P = 'c--p';
  for (const n of [70, 71, 72]) { t.transcript(P, SID(n), 1000); t.plain(P, SID(n), 'a' + n, snap({ end: 'finished' }, 9e4, 5e4), { description: 'x' }, 5e4); }
  t.title(P, SID(70), 'My custom title');
  t.registry({ sid: SID(70), over: { name: 'registry name 70' } }, { sid: SID(71), over: { name: 'registry name 71', entrypoint: 'claude-desktop' } });
  const vs = mk(t).refresh(NOW);
  const by = n => vs.running.concat(vs.recent).find(c => c.sessionId === SID(n));
  assert.equal(by(70).sessionTitle, 'My custom title');
  assert.equal(by(71).sessionTitle, 'registry name 71');
  assert.equal(by(72).sessionTitle, SID(72).slice(0, 8));
  assert.equal(by(71).origin, 'Desktop');
});

test('origin: registry entrypoint, else the entrypoint of the first agent line, else null', () => {
  const t = tree(), P = 'c--p';
  for (const n of [80, 81, 82]) t.transcript(P, SID(n), 1000);
  t.plain(P, SID(80), 'a', '{"type":"user","entrypoint":"claude-vscode","message":{}}\n', { description: 'x' }, 5e4);
  t.plain(P, SID(81), 'b', '{"type":"user","entrypoint":"claude-desktop"}\n', { description: 'x' }, 5e4);
  t.plain(P, SID(82), 'c', '{"type":"user","entrypoint":"sdk-cli"}\n', { description: 'x' }, 5e4);
  const vs = mk(t).refresh(NOW);
  const by = n => vs.running.concat(vs.recent).find(c => c.sessionId === SID(n));
  assert.equal(by(80).origin, 'VS Code');
  assert.equal(by(81).origin, 'Desktop');
  assert.equal(by(82).origin, null);
});

test('format note: registry version outside the tested range', () => {
  for (const [v, want] of [['2.1.288', null], ['2.1.287', null], ['2.1.263', null], ['2.1.300', null], ['2.1.262', 'match'], ['2.2.0', 'match'], ['3.0.0', 'match'], [null, null]]) {
    const t = tree(), sid = SID(90);
    t.transcript('c--p', sid, 1000); t.registry({ sid, over: { version: v } });
    const vs = mk(t).refresh(NOW);
    if (want === null) assert.equal(vs.formatNote, null, String(v)); else { assert.match(vs.formatNote, /2\.1\.263-2\.1\.288/); assert.ok(vs.formatNote.includes(v)); }
  }
});

// ---------------------------------------------------------------- robustness, budgets, size
test('read budget: at most 40 agent files per tick and 8 MB per tick; loading flags clear over a few ticks', () => {
  const t = tree(), P = 'c--p', sid = SID(100), run = 'wf_big';
  t.transcript(P, sid, 1000); t.registry({ sid });
  const n = 60;
  t.journal(P, sid, run, Array.from({ length: n }, (_, i) => ({ type: 'started', key: 'k' + i, agentId: 'a' + i, label: 'l' + i, phase: 'P' + (i % 3) })), 500);   // 3 phases: every agent stays visible
  const loadingCount = c => c.phases.flatMap(p => p.agents).filter(a => a.loading).length;
  for (let i = 0; i < n; i++) t.agent(P, sid, run, 'a' + i, snap({ cost: 100 }, 9e4, 5e3));
  const m = mk(t);
  let vs = m.refresh(NOW);
  assert.equal(FakeTracker.reads, 40);
  assert.equal(loadingCount(wfCard(vs)[0]), 20);
  vs = m.refresh(NOW + 1000);
  assert.equal(FakeTracker.reads, 60);
  assert.equal(loadingCount(wfCard(vs)[0]), 0);
  // byte budget: 12 agents of 1 MB each -> 8 in the first tick
  const t2 = tree(), sid2 = SID(101);
  t2.transcript(P, sid2, 1000); t2.registry({ sid: sid2 });
  t2.journal(P, sid2, 'wf_mb', Array.from({ length: 12 }, (_, i) => ({ type: 'started', key: 'k' + i, agentId: 'a' + i, label: 'l' + i, phase: 'P' })), 500);
  for (let i = 0; i < 12; i++) t2.agent(P, sid2, 'wf_mb', 'a' + i, snap({ cost: 1024 * 1024 }, 9e4, 5e3));
  const m2 = mk(t2);
  m2.refresh(NOW);
  assert.equal(FakeTracker.reads, 8);
  m2.refresh(NOW + 1000);
  assert.equal(FakeTracker.reads, 12);
});

test('one failing session becomes a warning, the others are still shown', () => {
  const t = tree(), P = 'c--p';
  t.transcript(P, SID(110), 1000); t.result(P, SID(110), 'wf_boom', resultFile({ runId: 'wf_boom' }, [wa({ agentId: 'z', model: 'boom' })]), 5 * MIN);
  t.transcript(P, SID(111), 1000); t.result(P, SID(111), 'wf_fine', resultFile({ runId: 'wf_fine' }, [wa({ agentId: 'y' })]), 5 * MIN);
  const m = mk(t, { deps: { prettyModel: id => { if (id === 'boom') throw new Error('kaputt'); return id; } } });
  const vs = m.refresh(NOW);
  assert.deepEqual(vs.recent.map(c => c.runId), ['wf_fine']);
  assert.equal(vs.warnings.length, 1);
  assert.match(vs.warnings[0], new RegExp('^Sitzung ' + SID(110).slice(0, 8)));
  assert.match(vs.warnings[0], /kaputt/);
});

test('warnings are capped at 5 plus a summary line', () => {
  const t = tree(), P = 'c--p';
  const SIDX = i => String(10000000 + i) + '-0000-4000-8000-000000000000';       // distinct 8-character prefixes: the warnings differ
  for (let i = 0; i < 8; i++) { t.transcript(P, SIDX(i), 1000); t.result(P, SIDX(i), 'wf_b' + i, resultFile({ runId: 'wf_b' + i }, [wa({ agentId: 'z' + i, model: 'boom' })]), 5 * MIN); }
  const vs = mk(t, { deps: { prettyModel: id => { if (id === 'boom') throw new Error('kaputt'); return id; } } }).refresh(NOW);
  assert.equal(vs.warnings.length, 6);
  assert.match(vs.warnings[5], /3 weitere/);
});

test('phases: more than 40 agents collapse, counters stay complete, running and failed agents are kept', () => {
  const t = tree(), P = 'c--p', sid = SID(130), run = 'wf_wide';
  t.transcript(P, sid, 1000); t.registry({ sid });
  const n = 100;
  t.journal(P, sid, run, Array.from({ length: n }, (_, i) => ({ type: 'started', key: 'k' + i, agentId: 'a' + i, label: 'l' + i, phase: i < 60 ? 'One' : 'Two' }))
    .concat(Array.from({ length: n }, (_, i) => i).filter(i => i < 90 && i !== 5).map(i => (i % 17 === 0 ? { type: 'failed', key: 'k' + i, agentId: 'a' + i } : { type: 'result', key: 'k' + i, agentId: 'a' + i, result: {} }))), 500);
  for (let i = 0; i < n; i++) t.agent(P, sid, run, 'a' + i, snap({ end: 'finished', cost: 10 }, 9e4 - i, 5e3));
  const c = wfCard(mk(t).refresh(NOW))[0];
  assert.equal(c.agentsTotal, 100);
  const one = phase(c, 'One'), two = phase(c, 'Two');
  assert.equal(one.total, 60);
  assert.equal(one.agents.length, 40);
  assert.equal(two.total, 40);
  assert.equal(two.agents.length, 40);
  assert.ok(one.agents.some(a => a.id === 'a5'), 'the running agent is kept');
  assert.ok(one.agents.some(a => a.state === 'failed'));
  assert.deepEqual([one.done, one.failed], [55, 4]);                              // 60 slots: 1 without outcome (a5), 4 failed (0, 17, 34, 51)
  assert.deepEqual([two.done, two.failed], [28, 2]);                              // 40 slots: 10 without outcome, 2 failed (68, 85)
  assert.equal(S.moreAgents(one.total - one.agents.length), '+20 weitere');
});

test('ViewState size cap: 150 KB, counters survive, cached cards are not damaged', () => {
  const t = tree(), P = 'c--p', sid = SID(140);
  t.transcript(P, sid, 5 * MIN);
  const long = 'L'.repeat(200);
  for (let r = 0; r < 20; r++) {
    const agents = Array.from({ length: 40 }, (_, i) => wa({ index: i + 1, label: 'agent-' + i + '-' + long, agentId: 'r' + r + 'a' + i, resultPreview: long, phaseTitle: i < 20 ? 'Research' : 'Critic' }));
    t.result(P, sid, 'wf_c' + r, resultFile({ runId: 'wf_c' + r, summary: long, timestamp: new Date(NOW - (r + 1) * MIN).toISOString() }, agents), (r + 1) * MIN);
  }
  const m = mk(t);
  const vs = m.refresh(NOW);
  assert.ok(JSON.stringify(vs).length <= 150e3, 'size ' + JSON.stringify(vs).length);
  assert.equal(vs.recent.length, 20);
  assert.ok(vs.warnings.includes(S.warnCapped));
  assert.ok(vs.recent.every(c => c.agentsTotal === 40 && c.phases.length === 2 && c.phases[0].total === 20));
  const cached = [...m._results.values()].filter(c => c.card).map(c => c.card);
  assert.equal(cached.length, 20);
  assert.ok(cached.every(c => c.phases[0].agents.length === 20), 'the cache keeps its agents');
});

test('a 100-agent live session stays below the cap', () => {
  const t = tree(), P = 'c--p', sid = SID(141), run = 'wf_100';
  t.transcript(P, sid, 1000); t.registry({ sid });
  t.journal(P, sid, run, Array.from({ length: 100 }, (_, i) => ({ type: 'started', key: 'k' + i, agentId: 'a' + i, label: 'l' + i, phase: 'P' + (i % 4) })), 500);
  for (let i = 0; i < 100; i++) t.agent(P, sid, run, 'a' + i, snap({ activity: { kind: 'tool', tool: 'Read', target: 'C:/some/long/path/' + 'x'.repeat(40), running: true }, cost: 10 }, 9e4, 2e3));
  const vs = mk(t).refresh(NOW);
  assert.ok(JSON.stringify(vs).length < 150e3);
  assert.equal(wfCard(vs)[0].agentsTotal, 100);
});

test('ordering: running newest first, recent by end time', () => {
  const t = tree(), P = 'c--p', sid = SID(150);
  t.transcript(P, sid, 1000); t.registry({ sid });
  for (const [run, age] of [['wf_old', 900e3], ['wf_mid', 300e3], ['wf_new', 60e3]]) {
    t.journal(P, sid, run, [{ type: 'started', key: 'k', agentId: run + 'a', label: 'x', phase: 'P' }], 500);
    t.agent(P, sid, run, run + 'a', snap({}, age, 1000));
  }
  const vs = mk(t).refresh(NOW);
  assert.deepEqual(vs.running.map(c => c.runId), ['wf_new', 'wf_mid', 'wf_old']);
});

// ---------------------------------------------------------------- hash, activity, options
test('stateHash ignores `now` and the ticking of quiet time, but not real changes', () => {
  const t = tree(), P = 'c--p', sid = SID(160), run = 'wf_h';
  t.transcript(P, sid, 1000); t.registry({ sid });
  t.journal(P, sid, run, [{ type: 'started', key: 'k', agentId: 'a', label: 'x', phase: 'P' }], 500);
  t.agent(P, sid, run, 'a', snap({ tokens: 10 }, 9e4, 5e3), 5e3);
  const m = mk(t);
  const v1 = m.refresh(NOW), v2 = m.refresh(NOW + 3000);
  assert.notEqual(v1.now, v2.now);
  assert.equal(m.stateHash(v1), m.stateHash(v2));
  assert.equal(typeof m.stateHash(v1), 'string');
  t.agent(P, sid, run, 'a', snap({ tokens: 11 }, 9e4, 5e3), 5e3);
  const v3 = m.refresh(NOW + 4000);
  assert.notEqual(m.stateHash(v3), m.stateHash(v1));
});

test('hasActivity: running items, or a change within 30 s', () => {
  const t = tree(), P = 'c--p', sid = SID(161);
  t.transcript(P, sid, 5 * MIN);
  t.result(P, sid, 'wf_x', resultFile({ runId: 'wf_x' }, [wa({ agentId: 'q' })]), 5 * MIN);
  const m = mk(t);
  assert.equal(m.hasActivity(NOW), false);
  m.refresh(NOW);
  assert.equal(m.hasActivity(NOW + 10e3), true);
  assert.equal(m.hasActivity(NOW + 31e3), false);
  const t2 = tree(), sid2 = SID(162);
  t2.transcript(P, sid2, 1000); t2.registry({ sid: sid2 });
  t2.journal(P, sid2, 'wf_r', [{ type: 'started', key: 'k', agentId: 'a', label: 'x', phase: 'P' }], 500);
  t2.agent(P, sid2, 'wf_r', 'a', snap({}, 9e4, 1000));
  const m2 = mk(t2);
  m2.refresh(NOW);
  assert.equal(m2.hasActivity(NOW + 10 * MIN), true);
});

test('invalidate(): forces a rediscovery on the next refresh (a new session shows up before the 5 s discovery cadence)', () => {
  const t = tree(), P = 'c--p', sid = SID(163), sid2 = SID(164);
  assert.doesNotThrow(() => new SessionModel({ claudeHome: t.home, deps: { AgentTracker: FakeTracker, extractMetaSafe: fakeMeta, eta: fakeEta(), prettyModel: x => x } }).invalidate());
  t.plain(P, sid, 'old1', snap({ end: 'running' }, 30e3, 1000), { description: 'first' }, 1000);
  const m = mk(t);
  assert.equal(m.refresh(NOW).running.length, 1);
  t.plain(P, sid2, 'new1', snap({ end: 'running' }, 20e3, 500), { description: 'second' }, 500);
  assert.equal(m.refresh(NOW + 1000).running.length, 1, 'no rediscovery inside the 5 s cadence');
  m.invalidate();
  const vs = m.refresh(NOW + 1500);
  assert.deepEqual(vs.running.map(c => c.agent.label).sort(), ['first', 'second']);
  assert.equal(m.refresh(NOW + 2000).running.length, 2);
  m.invalidate();
  m.invalidate();                                                               // idempotent, only a flag
  assert.equal(m.refresh(NOW + 2500).running.length, 2);
});

test('setOptions: showToolTargets recreates trackers, claudeHome switches the tree, dispose releases trackers', () => {
  const t = tree(), P = 'c--p', sid = SID(170), run = 'wf_o';
  t.transcript(P, sid, 1000); t.registry({ sid });
  t.journal(P, sid, run, [{ type: 'started', key: 'k', agentId: 'a', label: 'x', phase: 'P' }], 500);
  t.agent(P, sid, run, 'a', snap({}, 9e4, 1000));
  const m = mk(t);
  m.refresh(NOW);
  assert.deepEqual(FakeTracker.created.map(c => [c.opts.isWf, c.opts.showToolTargets]), [[true, true]]);
  m.setOptions({ showToolTargets: false });
  m.refresh(NOW + 1000);
  assert.deepEqual(FakeTracker.created.map(c => [c.opts.isWf, c.opts.showToolTargets]), [[true, true], [true, false]]);
  const t2 = tree();
  m.setOptions({ claudeHome: t2.home });
  const vs = m.refresh(NOW + 2000);
  assert.deepEqual(vs.running, []);
  assert.equal(vs.claudeHome, t2.home);
  assert.match(vs.warnings[0] || '', /Kein Sitzungsverzeichnis|^$/);
  m.setOptions({ claudeHome: t.home });
  assert.equal(m.refresh(NOW + 3000).running.length, 1);
  const before = FakeTracker.disposed;
  m.dispose();
  assert.ok(FakeTracker.disposed > before);
});

test('buildPhases helper: declared order first, journal-only titles appended, agents without a phase get their own', () => {
  const { buildPhases } = SessionModel;
  const ag = (id, phase, state, startedAt) => ({ id, phase, state, startedAt });
  const ph = buildPhases([{ title: 'B', detail: 'bd' }, { title: 'A', detail: null }, { title: 'B', detail: 'dup' }], [ag('1', 'Z', 'running', 5), ag('2', 'A', 'done', 9), ag('3', 'A', 'failed', 3), ag('4', null, 'done', null)], ['Y']);
  assert.deepEqual(ph.map(p => [p.title, p.detail, p.state, p.done, p.failed, p.total]), [
    ['B', 'bd', 'pending', 0, 0, 0], ['A', null, 'partial', 1, 1, 2], ['Y', null, 'pending', 0, 0, 0], ['Z', null, 'running', 0, 0, 1], [S.noPhase || 'Ohne Phase', null, 'done', 1, 0, 1]]);
  assert.deepEqual(ph[1].agents.map(a => a.id), ['3', '2'], 'ordered by start');
});

// ---------------------------------------------------------------- garbage, loading, limits, env
test('garbage in result files, journals, metas and registry files never throws and still gives valid cards', () => {
  const t = tree(), P = 'c--p';
  t.transcript(P, SID(180), 3 * MIN);
  t.result(P, SID(180), 'wf_g1', { runId: 7, workflowProgress: [null, 5, 'x', { type: 'workflow_agent' }, { type: 'workflow_agent', agentId: 42, label: 7, state: 'done', tokens: 'many', startedAt: 'x', durationMs: -1 }, { type: 'workflow_phase' }],
    phases: 'not an array', workflowName: 7, status: 5, startTime: 'a', timestamp: 'zz', totalTokens: 'lots', totalToolCalls: null, summary: { a: 1 } }, 3 * MIN);
  t.result(P, SID(180), 'wf_g2', [1, 2, 3], 3 * MIN);                                           // valid JSON, wrong shape
  t.result(P, SID(180), 'wf_g3', { workflowProgress: 'nope', phases: [null, { title: 5 }, { title: 'ok', detail: 9 }] }, 3 * MIN);
  t.journal(P, SID(180), 'wf_g4', null, 2 * MIN, '{"type":"started","key":"k","agentId":"a","label":null,"phase":7}\n\u0000\u0000garbage\n[1,2]\n{"type":"result"}\n');
  touch(path.join(t.runDir(P, SID(180), 'wf_g4'), 'agent-a.jsonl'), 'not json at all', 2 * MIN);                                         // fake tracker tolerates this: all defaults
  t.plain(P, SID(180), 'g5', '{{{', '[]', 2 * MIN);                                              // meta is not an object
  t.plain(P, SID(180), 'g6', {}, '"just a string"', 2 * MIN);
  fs.mkdirSync(path.join(t.home, 'sessions'), { recursive: true });
  touch(path.join(t.home, 'sessions', '999.json'), '{"pid": "x", "sessionId": 5}', 0);
  touch(path.join(t.home, 'sessions', '998.json'), '', 0);
  touch(path.join(t.sd(P, SID(180)), 'custom-title.json'), '{"customTitle": 12}', 0);
  const vs = mk(t).refresh(NOW);                                                                // every refresh() is also validated against the typedefs
  const ids = vs.recent.map(c => (c.kind === 'agent' ? c.agent.id : c.runId)).sort();
  assert.deepEqual(ids, ['g5', 'g6', 'wf_g1', 'wf_g3', 'wf_g4'], 'wf_g2 (valid JSON of the wrong shape) is ignored');
  const g1 = vs.recent.find(c => c.runId === 'wf_g1');
  assert.equal(g1.status, '5');
  assert.equal(g1.name, 'wf_g1');
  assert.equal(g1.agentsTotal, 2);
  assert.deepEqual(vs.recent.find(c => c.runId === 'wf_g3').phases.map(p => p.title), ['ok']);
});

test('no estimate is made from a half-read transcript (loading), it follows once the read is complete', () => {
  const t = tree(), P = 'c--p', sid = SID(181), run = 'wf_load';
  t.transcript(P, sid, 1000); t.registry({ sid });
  t.journal(P, sid, run, [{ type: 'started', key: 'k', agentId: 'a', label: 'x', phase: 'P' }, { type: 'started', key: 'k2', agentId: 'b', label: 'y', phase: 'P' }], 500);
  t.agent(P, sid, run, 'a', snap({ cost: 9 * 1024 * 1024 }, 200e3, 1000));                       // eats the whole tick budget
  t.agent(P, sid, run, 'b', snap({ cost: 100 }, 200e3, 1000));
  const m = mk(t);
  const vs = m.refresh(NOW);
  const c = wfCard(vs)[0];
  assert.equal(agentOf(c, 'b').loading, true);
  assert.equal(m.fake.agentCalls.length, 0);
  assert.equal(m.fake.wfCalls.length, 0);
  assert.equal(c.eta, null);
  assert.equal(agentOf(c, 'a').eta, null);
  const vs2 = m.refresh(NOW + 1000);
  const c2 = wfCard(vs2)[0];
  assert.equal(c2.phases[0].agents.every(a => !a.loading), true);
  assert.equal(m.fake.agentCalls.length, 2);
  assert.equal(m.fake.wfCalls.length, 1);
  assert.ok(agentOf(c2, 'a').eta && c2.eta);
});

test('refresh(now, limits): the caps can be lifted for tools and tests', () => {
  const t = tree(), P = 'c--p', sid = SID(182);
  t.transcript(P, sid, 5 * MIN);
  for (let i = 0; i < 25; i++) t.result(P, sid, 'wf_l' + i, resultFile({ runId: 'wf_l' + i, timestamp: new Date(NOW - (i + 1) * MIN).toISOString() }, [wa({ agentId: 'l' + i })]), (i + 1) * MIN);
  const m = mk(t);
  assert.equal(m.refresh(NOW).recent.length, 20);
  assert.equal(m.refresh(NOW, { maxRecent: 100 }).recent.length, 25);
  assert.equal(m.refresh(NOW, { maxRecent: 3 }).recent.length, 3);
});

test('claudeHome falls back to CLAUDE_CONFIG_DIR when the option is empty', () => {
  const t = tree(), P = 'c--p', sid = SID(183);
  t.transcript(P, sid, 5 * MIN);
  t.result(P, sid, 'wf_env', resultFile({ runId: 'wf_env' }, [wa({ agentId: 'e1' })]), 5 * MIN);
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = t.home;
  try {
    const m = mk(t, { claudeHome: '' });
    const vs = m.refresh(NOW);
    assert.equal(vs.claudeHome, t.home);
    assert.deepEqual(vs.recent.map(c => c.runId), ['wf_env']);
  } finally { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved; }
});

test('model never opens a main transcript, registry key files or lock files (only stat)', () => {
  const t = tree(), P = 'c--p', sid = SID(184), run = 'wf_spy';
  t.transcript(P, sid, 1000); t.registry({ sid });
  touch(path.join(t.home, 'sessions', '4242.key'), 'SECRET', 0);
  touch(path.join(t.home, 'ide', '1.lock'), 'TOKEN', 0);
  t.journal(P, sid, run, [{ type: 'started', key: 'k', agentId: 'a', label: 'x', phase: 'P' }], 500);
  t.agent(P, sid, run, 'a', snap({}, 9e4, 1000));
  t.plain(P, sid, 'pp', '{"entrypoint":"claude-vscode"}', { description: 'd' }, 1000);
  const opened = [];
  const o1 = fs.openSync, o2 = fs.readFileSync;
  fs.openSync = function (f, ...r) { opened.push(String(f)); return o1.call(this, f, ...r); };
  fs.readFileSync = function (f, ...r) { if (typeof f === 'string') opened.push(f); return o2.call(this, f, ...r); };
  try { const m = mk(t); m.refresh(NOW); m.refresh(NOW + 6000); } finally { fs.openSync = o1; fs.readFileSync = o2; }
  assert.ok(opened.length > 0);
  assert.deepEqual(opened.filter(f => /\.key$|\.lock$|credentials/i.test(f) || f.endsWith(sid + '.jsonl')), []);
});
