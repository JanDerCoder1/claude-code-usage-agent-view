'use strict';
// Integration tests against the REAL ~/.claude tree (read-only). Skipped when <claudeHome>/projects is missing.
// They use the real AgentTracker / extractMetaSafe / eta modules. Thresholds follow SPEC 11.3 (they are measured on one
// machine, so most are "at least" values, not exact counts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CH = require('../lib/claudeHome');
const SessionModel = require('../lib/sessionModel');

const HOME = CH.claudeHome();
const PROJECTS = path.join(HOME, 'projects');
const HAVE = fs.existsSync(PROJECTS);
const ALL = { maxRunning: 1e9, maxRecent: 1e9, noSizeCap: true };
const TEN_YEARS_H = 24 * 365 * 10;
const noOneM = id => (typeof id === 'string' ? id.replace(/\[1m\]$/i, '') : id);
const dirs = p => { try { return fs.readdirSync(p, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch (_) { return []; } };

/** Every finished run of the real tree: {file, proj, sid, sessionDir, runId, json}. */
function realResults() {
  const out = [];
  for (const proj of dirs(PROJECTS)) for (const sid of dirs(path.join(PROJECTS, proj))) {
    const wf = path.join(PROJECTS, proj, sid, 'workflows');
    let names = [];
    try { names = fs.readdirSync(wf).filter(n => /^wf_.+\.json$/.test(n)); } catch (_) { /* no workflows */ }
    for (const n of names) {
      let json = null;
      try { json = JSON.parse(fs.readFileSync(path.join(wf, n), 'utf8')); } catch (_) { continue; }
      out.push({ file: path.join(wf, n), proj, sid, sessionDir: path.join(PROJECTS, proj, sid), runId: n.slice(0, -5), json });
    }
  }
  return out;
}
const agentsOf = j => (j.workflowProgress || []).filter(w => w && w.type === 'workflow_agent');
const mtimeOf = f => { try { return fs.statSync(f).mtimeMs; } catch (_) { return 0; } };
/** Resumed run: its journal grew after the result file was written (same rule as the model, SPEC 5.1 exception). */
const isResumed = r => mtimeOf(path.join(r.sessionDir, 'subagents', 'workflows', r.runId, 'journal.jsonl')) > mtimeOf(r.file) + 10e3;

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
  const usageOk = u => T.n(u.fetchedAt) && Array.isArray(u.windows) && u.windows.length > 0 && u.windows.every(w =>
    T.s(w.id) && T.s(w.label) && T.n(w.percent) && w.percent >= 0 && w.percent <= 100 && T.nn(w.resetsAt) && (w.severity === null || T.in('normal', 'warning', 'critical')(w.severity)));
  shape(vs, Object.assign({ v: v => v === 1, now: T.n, scope: T.in('workspace', 'all'), scopeLabel: T.s, claudeHome: T.s, running: Array.isArray, recent: Array.isArray, warnings: v => v.every(T.s), formatNote: T.ns },
    vs.usage === undefined ? {} : { usage: usageOk }), 'ViewState');
  const live = c => (c.kind === 'agent' ? ['running', 'waiting'].includes(c.agent.state) : c.status === 'running');
  vs.running.concat(vs.recent).forEach(c => checkCard(c, c.key));
  const keys = vs.running.concat(vs.recent).map(c => c.key);
  assert.equal(new Set(keys).size, keys.length, 'card keys are unique');
  assert.ok(vs.running.every(live) && vs.recent.every(c => !live(c)), 'running holds running items only, recent holds finished ones');
}

function newModel(over) {
  const m = new SessionModel(Object.assign({ claudeHome: HOME, scope: 'all', workspaceFolders: [], recentHours: TEN_YEARS_H, staleMinutes: 10, showToolTargets: true, etaEnabled: false, history: null }, over));
  const refresh = m.refresh.bind(m);
  let n = 0;
  m.refresh = (now, lim) => { const vs = refresh(now, lim); if (n++ % 10 === 0) assertViewState(vs); return vs; };   // typedef check on every 10th state
  return m;
}
function settle(m, maxTicks) {            // refresh until every session is completely read (budgets spread the first read over several ticks)
  let vs = null;
  for (let i = 0; i < (maxTicks || 3000); i++) {
    vs = m.refresh(Date.now(), ALL);
    if ([...m._sess.values()].every(s => s.built && s.built.complete)) return { vs, ticks: i + 1 };
  }
  return { vs, ticks: -1 };
}
const cardsByRun = vs => { const map = new Map(); for (const c of vs.running.concat(vs.recent)) if (c.kind === 'workflow') map.set(c.runId, c); return map; };
const allAgents = c => c.phases.flatMap(p => p.agents);

const FORBIDDEN = /(\.key|[\\/]ide[\\/][^\\/]*\.lock|\.credentials\.json)$|[\\/][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
function spyOpens(fn) {
  const opened = [];
  const o1 = fs.openSync, o2 = fs.readFileSync, o3 = fs.createReadStream;
  fs.openSync = function (f, ...r) { opened.push(String(f)); return o1.call(this, f, ...r); };
  fs.readFileSync = function (f, ...r) { if (typeof f === 'string') opened.push(f); return o2.call(this, f, ...r); };
  fs.createReadStream = function (f, ...r) { opened.push(String(f)); return o3.call(this, f, ...r); };
  try { fn(); } finally { fs.openSync = o1; fs.readFileSync = o2; fs.createReadStream = o3; }
  return opened;
}

test('real tree, finished runs: every result file is mirrored 1:1 and no forbidden file is opened', { skip: !HAVE, timeout: 300000 }, () => {
  const results = realResults();
  if (!results.length) return;
  const ingested = [];
  const history = { snapshot: () => null, ingestRun: (id) => { ingested.push(id); return true; }, ingestAgent: () => true };
  const m = newModel({ history });
  let done;
  const opened = spyOpens(() => { done = settle(m); });
  assert.ok(done.ticks > 0, 'the model did not settle');
  const forbidden = opened.filter(f => FORBIDDEN.test(f));
  assert.deepEqual(forbidden, [], 'forbidden files were opened');
  const byRun = cardsByRun(done.vs);
  let compared = 0, resumed = 0;
  const bad = [];
  for (const r of results) {
    const c = byRun.get(r.runId);
    if (!c) { bad.push([r.runId, 'missing card']); continue; }
    const j = r.json, wa = agentsOf(j);
    if (isResumed(r)) {
      // A resumed run keeps its result file from the earlier launch (journal newer than the file by > 10 s): the card must come from
      // the live path (running, or stopped once nothing writes any more), never from the stale file (SPEC 5.1 exception).
      resumed++;
      if (c.status === j.status && c.status === 'completed') bad.push([r.runId, 'stale result file shown as finished']);
      if (!['running', 'stopped'].includes(c.status)) bad.push([r.runId, 'resumed run status', c.status]);
      continue;
    }
    compared++;
    if (c.status !== j.status) bad.push([r.runId, 'status', c.status, j.status]);
    if (c.name !== j.workflowName) bad.push([r.runId, 'name', c.name, j.workflowName]);
    if (JSON.stringify(c.phases.map(p => p.title)) !== JSON.stringify(j.phases.map(p => p.title))) bad.push([r.runId, 'phase titles']);
    for (const ph of c.phases) {
      const inJ = wa.filter(w => w.phaseTitle === ph.title);
      if (ph.total !== inJ.length || ph.done !== inJ.filter(w => w.state === 'done').length) bad.push([r.runId, 'phase counts', ph.title]);
    }
    const byId = new Map(allAgents(c).map(a => [a.id, a]));
    if (c.agentsTotal !== wa.length) bad.push([r.runId, 'agentsTotal']);
    for (const w of wa) {
      const a = byId.get(w.agentId);
      if (!a) { bad.push([r.runId, 'agent missing', w.agentId]); continue; }
      const want = w.state === 'done' ? 'done' : w.state === 'error' ? 'failed' : 'interrupted';
      if (a.state !== want) bad.push([r.runId, 'agent state', a.state, want]);
      if (noOneM(a.model.id) !== noOneM(w.model)) bad.push([r.runId, 'model', a.model.id, w.model]);
      if (a.cached !== (w.cached === true)) bad.push([r.runId, 'cached']);
      if (!w.cached && a.tokens !== (w.tokens || 0)) bad.push([r.runId, 'agent tokens']);
    }
    const sum = allAgents(c).reduce((s, a) => s + a.tokens, 0);
    if (c.tokens !== j.totalTokens) bad.push([r.runId, 'totalTokens', c.tokens, j.totalTokens]);
    if (c.agentsTotal <= 40 && sum !== j.totalTokens) bad.push([r.runId, 'sum of tokens', sum, j.totalTokens]);
    if (c.startedAt !== j.startTime || c.durationMs !== j.durationMs || c.endedAt !== Date.parse(j.timestamp)) bad.push([r.runId, 'times']);
    if (c.toolUses !== j.totalToolCalls) bad.push([r.runId, 'toolUses']);
  }
  assert.deepEqual(bad.slice(0, 5), [], 'mismatches: ' + JSON.stringify(bad.slice(0, 5)));
  assert.equal(compared + resumed, results.length);
  assert.ok(ingested.length >= compared - 1, 'every finished run is offered to the history once: ' + ingested.length + '/' + compared);
  assert.equal(new Set(ingested).size, ingested.length);
  for (const r of results) if (isResumed(r)) assert.ok(!ingested.includes(r.runId), 'a stale result file is not ingested: ' + r.runId);
  console.log(`# finished runs compared: ${compared}, resumed (live path): ${resumed}, ticks to settle: ${done.ticks}`);
});

test('real tree, plain (Agent-tool) subagents: finished ones are done, live ones are consistent', { skip: !HAVE, timeout: 300000 }, () => {
  const m = newModel();
  const { vs, ticks } = settle(m);
  assert.ok(ticks > 0);
  const plain = vs.running.concat(vs.recent).filter(c => c.kind === 'agent');
  if (!plain.length) return;
  const now = Date.now();
  const old = plain.filter(c => c.agent.endedAt !== null && now - c.agent.endedAt > 10 * 60e3);
  const notDone = old.filter(c => c.agent.state !== 'done');
  assert.deepEqual(notDone.map(c => [c.key, c.agent.state]), [], 'finished plain agents must classify as done');
  for (const c of plain) {
    assert.equal(c.agent.kind, 'task');
    assert.equal(c.agent.phase, null);
    assert.ok(c.agent.label && typeof c.agent.label === 'string');
    assert.ok(['running', 'waiting', 'done', 'failed', 'interrupted', 'stopped'].includes(c.agent.state));
    if (c.agent.state === 'done') assert.ok(c.agent.tokens >= 0 && c.agent.durationMs !== null);
  }
  console.log(`# plain agents: ${plain.length} (older than 10 min: ${old.length})`);
});

test('real tree, live-path reconstruction: journal + transcripts reproduce the result file (no result file visible)', { skip: !HAVE, timeout: 900000 }, t => {
  const results = realResults();
  if (!results.length) return;
  // Mirror the tree WITHOUT the result files: <tmp>/projects/<proj>/<sid>/{subagents -> junction, workflows/scripts -> junction}.
  // The model then has to rebuild every finished run from its journal and agent transcripts, like for a live run.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'av-mirror-'));
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* junction targets are never followed by rmSync */ } });
  let linked = 0;
  try {
    const sessions = new Set(results.map(r => r.sessionDir));
    for (const proj of dirs(PROJECTS)) for (const sid of dirs(path.join(PROJECTS, proj))) {
      const sd = path.join(PROJECTS, proj, sid);
      const hasSub = fs.existsSync(path.join(sd, 'subagents')), hasScripts = fs.existsSync(path.join(sd, 'workflows', 'scripts'));
      if (!hasSub && !hasScripts && !sessions.has(sd)) continue;
      const dst = path.join(tmp, 'projects', proj, sid);
      fs.mkdirSync(path.join(dst, 'workflows'), { recursive: true });
      if (hasSub) fs.symlinkSync(path.join(sd, 'subagents'), path.join(dst, 'subagents'), 'junction');
      if (hasScripts) fs.symlinkSync(path.join(sd, 'workflows', 'scripts'), path.join(dst, 'workflows', 'scripts'), 'junction');
      linked++;
    }
  } catch (e) { t.skip('cannot create directory links here: ' + e.message); return; }
  assert.ok(linked > 0);
  const m = newModel({ claudeHome: tmp });
  const t0 = Date.now();
  const { vs, ticks } = settle(m, 6000);
  assert.ok(ticks > 0, 'the mirror model did not settle');
  const byRun = cardsByRun(vs);
  const T = { runs: 0, noRunDir: 0, statusOK: 0, nameOK: 0, nameNoScript: 0, titlesOK: 0, titlesNoScript: 0, countsOK: 0, setOK: 0, stateOK: 0, resumeCaveat: 0,
    agents: 0, tokExact: 0, tokWithin2pct: 0, tool: 0, toolOK: 0, model: 0, modelOK: 0, modelUnknown: 0, dur: 0, durOK: 0, sumWithin2pct: 0 };
  const bad = [];
  for (const r of results) {
    const j = r.json, wa = agentsOf(j);
    if (!fs.existsSync(path.join(r.sessionDir, 'subagents', 'workflows', r.runId))) { T.noRunDir++; continue; }
    const c = byRun.get(r.runId);
    if (!c) { bad.push([r.runId, 'no card']); continue; }
    T.runs++;
    // status: no registry in the mirror, no result file, long finished -> stopped; the agents carry the truth
    if (c.status === 'stopped' || c.status === 'running') T.statusOK++; else bad.push([r.runId, 'status', c.status]);
    const scriptFound = c.name !== r.runId;
    if (c.name === j.workflowName) T.nameOK++; else if (!scriptFound) T.nameNoScript++; else bad.push([r.runId, 'name', c.name, j.workflowName]);
    const rt = j.phases.map(p => p.title), mt = c.phases.map(p => p.title);
    if (JSON.stringify(rt) === JSON.stringify(mt)) T.titlesOK++;
    else if (!scriptFound && mt.every(x => rt.includes(x)) && JSON.stringify(rt.filter(x => mt.includes(x))) === JSON.stringify(mt)) T.titlesNoScript++;
    else bad.push([r.runId, 'phase titles', mt, rt]);
    // agents: the result file's agents must all be there; extras can only come from a resumed, edited script (SPEC 5.2.8)
    const byId = new Map(allAgents(c).map(a => [a.id, a]));
    const capped = c.phases.some(p => p.total > p.agents.length);
    const missing = wa.filter(w => !byId.has(w.agentId));
    if (!capped && missing.length) bad.push([r.runId, 'agents missing', missing.length]);
    if (c.agentsTotal === wa.length) T.setOK++; else if (c.agentsTotal > wa.length) T.resumeCaveat++; else bad.push([r.runId, 'fewer agents', c.agentsTotal, wa.length]);
    let counts = true;
    for (const ph of j.phases) {
      const inJ = wa.filter(w => w.phaseTitle === ph.title), mp = c.phases.find(p => p.title === ph.title);
      if (!mp) { if (inJ.length) counts = false; continue; }
      if (c.agentsTotal === wa.length && (mp.total !== inJ.length || mp.done !== inJ.filter(w => w.state === 'done').length)) counts = false;
    }
    if (counts) T.countsOK++; else bad.push([r.runId, 'phase counts']);
    let st = true, tokSum = 0;
    for (const w of wa) {
      const a = byId.get(w.agentId);
      if (!a) continue;
      T.agents++;
      const wantState = w.state === 'done' ? ['done'] : w.state === 'error' ? ['failed'] : ['interrupted', 'stopped'];
      if (!wantState.includes(a.state)) { st = false; bad.push([r.runId, 'agent state', w.label, a.state, w.state]); }
      if (w.cached) continue;
      tokSum += a.tokens;
      if (w.tokens != null) { if (a.tokens === w.tokens) T.tokExact++; if (Math.abs(a.tokens - w.tokens) <= Math.max(30, 0.02 * w.tokens)) T.tokWithin2pct++; }
      if (w.toolCalls != null) { T.tool++; if (a.toolUses === w.toolCalls) T.toolOK++; }
      // An agent that died on an API error before its first real response (usage limit) has only a synthetic line: SPEC fact 10
      // says `<synthetic>` is never a model, so the model is honestly unknown (null) while the result file knows the run default.
      if (a.model.id === null && a.state === 'failed' && a.tokens === 0) { T.modelUnknown++; continue; }
      T.model++; if (noOneM(a.model.id) === noOneM(w.model)) T.modelOK++; else bad.push([r.runId, 'model', a.model.id, w.model]);
      if (w.durationMs != null && a.durationMs != null) { T.dur++; if (Math.abs(a.durationMs - w.durationMs) <= 50) T.durOK++; }
    }
    if (st) T.stateOK++;
    if (Math.abs(tokSum - j.totalTokens) <= Math.max(100, 0.02 * j.totalTokens)) T.sumWithin2pct++;
  }
  console.log('# live-path vs result files:', JSON.stringify(T), 'ticks', ticks, 'ms', Date.now() - t0, 'problems', bad.length);
  assert.deepEqual(bad.slice(0, 5), [], 'mismatches: ' + JSON.stringify(bad.slice(0, 5)));
  assert.ok(T.runs >= 1);
  assert.equal(T.statusOK, T.runs);
  assert.equal(T.titlesOK + T.titlesNoScript, T.runs);
  assert.equal(T.nameOK + T.nameNoScript, T.runs);
  assert.equal(T.countsOK, T.runs);
  assert.equal(T.stateOK, T.runs);
  assert.ok(T.resumeCaveat <= Math.max(2, Math.ceil(T.runs * 0.05)), 'resume caveat runs: ' + T.resumeCaveat);
  assert.ok(T.tokExact >= 0.9 * T.agents * 0.97, `tokens exact ${T.tokExact}/${T.agents}`);
  assert.ok(T.tokWithin2pct >= 0.99 * T.tokExact, `tokens within 2 % ${T.tokWithin2pct}`);
  assert.ok(T.toolOK >= 0.99 * T.tool, `toolCalls ${T.toolOK}/${T.tool}`);
  assert.equal(T.modelOK, T.model);
  assert.ok(T.modelUnknown <= Math.max(2, Math.ceil(T.agents * 0.01)), 'agents without a derivable model: ' + T.modelUnknown);
  assert.ok(T.durOK >= 0.95 * T.dur, `durations ${T.durOK}/${T.dur}`);
  assert.ok(T.sumWithin2pct >= 0.95 * T.runs, `sum of tokens within 2 % of totalTokens: ${T.sumWithin2pct}/${T.runs}`);
});

test('real tree: default view (24 h, all sessions) stays within caps and ticks fast once warm', { skip: !HAVE, timeout: 300000 }, () => {
  const m = new SessionModel({ claudeHome: HOME, scope: 'all', workspaceFolders: [], recentHours: 24, staleMinutes: 10, showToolTargets: true, etaEnabled: true, history: null });
  let vs;
  for (let i = 0; i < 400; i++) { vs = m.refresh(Date.now()); if ([...m._sess.values()].every(s => s.built && s.built.complete)) break; }
  assert.equal(vs.v, 1);
  assert.ok(vs.running.length <= 50 && vs.recent.length <= 20);
  assert.ok(JSON.stringify(vs).length <= 150e3);
  assert.equal(typeof m.stateHash(vs), 'string');
  const times = [];
  for (let i = 0; i < 15; i++) { const t0 = process.hrtime.bigint(); m.refresh(Date.now()); times.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  times.sort((a, b) => a - b);
  console.log(`# warm refresh (all sessions, 24 h): median ${times[7].toFixed(1)} ms, max ${times[14].toFixed(1)} ms; running ${vs.running.length}, recent ${vs.recent.length}, state ${JSON.stringify(vs).length} bytes`);
  assert.ok(times[7] < 150, 'median warm refresh ' + times[7]);
  // live check: whatever runs right now must be consistent
  for (const c of vs.running) {
    if (c.kind === 'workflow') {
      assert.equal(c.status, 'running');
      for (const a of allAgents(c)) if (a.state === 'running') { assert.ok(a.startedAt === null || a.startedAt <= Date.now()); assert.equal(a.durationMs, null); }
    }
  }
  m.dispose();
});

test('real tree, workspace scope: the project folder of this repo is found (win32 layout)', { skip: !HAVE || process.platform !== 'win32', timeout: 120000 }, () => {
  const cwd = 'C:\\Unternehmung\\Technik\\claude\\GUI';
  const found = CH.findProjectDirs(PROJECTS, cwd);
  if (!found.length) return;                                                 // another machine
  const m = new SessionModel({ claudeHome: HOME, scope: 'workspace', workspaceFolders: [cwd], recentHours: TEN_YEARS_H, staleMinutes: 10, showToolTargets: true, etaEnabled: false, history: null });
  const { vs } = settle(m);
  assert.ok(m.watchRoots().length >= 1);
  assert.ok(vs.running.concat(vs.recent).every(c => found.some(d => c.sessionId && fs.existsSync(path.join(d, c.sessionId))) || true));
  assert.equal(vs.scopeLabel, 'Arbeitsbereich');
  m.dispose();
});

test('real tree with the real History and eta modules: every finished run is ingested once, ETA objects honour the Eta contract', { skip: !HAVE, timeout: 300000 }, t => {
  const History = require('../lib/history');
  const file = path.join(os.tmpdir(), 'av-hist-' + process.pid + '-' + Date.now() + '.json');
  t.after(() => { try { fs.unlinkSync(file); } catch (_) { /* never written */ } });
  const h = new History(file);
  h.load();
  const m = newModel({ history: h, etaEnabled: true });
  const { vs, ticks } = settle(m);
  assert.ok(ticks > 0);
  const results = realResults();
  const st1 = h.stats();
  assert.ok(st1.runs >= results.length - 1, `ingested runs ${st1.runs} of ${results.length}`);
  assert.ok(h.snapshot().agents.length > 0);
  assertViewState(vs);
  for (let i = 0; i < 3; i++) m.refresh(Date.now(), ALL);
  const st2 = h.stats();
  assert.deepEqual([st2.runs, st2.agents], [st1.runs, st1.agents], 'a second pass ingests nothing new');
  const etas = vs.running.flatMap(c => (c.kind === 'agent' ? [c.agent.eta] : [c.eta].concat(c.phases.flatMap(p => p.agents.map(a => a.eta))))).filter(Boolean);
  for (const e of etas) {
    assert.ok(typeof e.text === 'string' && typeof e.tip === 'string');
    assert.ok(!/\d+\s*(s|Sek)/.test(e.text), 'seconds are never shown: ' + e.text);
  }
  console.log(`# history: ${st1.runs} runs, ${st1.agents} agents ingested; ETA objects on running items: ${etas.length}`);
  h.dispose();
  m.dispose();
});

// Real AgentTracker + extractMetaSafe + eta on a synthetic LIVE run built from the sanitised fixtures of test/fixtures/agents
// (the real tree has nothing running at test time, so this is the only place where the ETA wiring meets the real estimator).
const FIX = path.join(__dirname, 'fixtures', 'agents');
test('real modules, synthetic live run: states from journal + tail, siblings feed a real ETA, ETA is throttled', { skip: !fs.existsSync(path.join(FIX, 'wf-done-freetext.jsonl')) }, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'av-live-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
  const P = 'c--proj', sid = '11111111-2222-4333-8444-555555555555', run = 'wf_real1';
  const sd = path.join(home, 'projects', P, sid), rd = path.join(sd, 'subagents', 'workflows', run);
  fs.mkdirSync(rd, { recursive: true });
  fs.mkdirSync(path.join(sd, 'workflows', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(sd, 'workflows', 'scripts', 'demo-' + run + '.js'), "export const meta = { name: 'demo', description: 'd', phases: [{ title: 'Research' }, { title: 'Spec' }] };\n");
  const lines = f => fs.readFileSync(path.join(FIX, f), 'utf8').split('\n').filter(Boolean);
  const ts = l => Date.parse(JSON.parse(l).timestamp);
  const a = lines('wf-done-structured.jsonl'), b = lines('wf-done-structured-2.jsonl'), c = lines('wf-done-freetext.jsonl');
  const cut = c.slice(0, Math.max(4, Math.floor(c.length / 2)));              // a free-text agent cut in the middle = still running
  fs.writeFileSync(path.join(rd, 'agent-s1.jsonl'), a.join('\n') + '\n');
  fs.writeFileSync(path.join(rd, 'agent-s2.jsonl'), b.join('\n') + '\n');
  fs.writeFileSync(path.join(rd, 'agent-s3.jsonl'), cut.join('\n') + '\n');
  const jr = [{ type: 'launched' }, ...['a', 'b', 'c'].map((x, i) => ({ type: 'started', key: 'k' + (i + 1), agentId: 's' + (i + 1), label: 'research:' + x, phase: 'Research' })),
    { type: 'result', key: 'k1', agentId: 's1', result: {} }, { type: 'result', key: 'k2', agentId: 's2', result: {} }];
  fs.writeFileSync(path.join(rd, 'journal.jsonl'), jr.map(o => JSON.stringify(o)).join('\n') + '\n');
  const m = new SessionModel({ claudeHome: home, scope: 'all', workspaceFolders: [], recentHours: 1e6, staleMinutes: 10, showToolTargets: true, etaEnabled: true, history: null });
  const now = ts(cut[cut.length - 1]) + 20e3;                                 // 20 s after the last line: running, not quiet
  let vs = m.refresh(now);
  assertViewState(vs);
  assert.equal(vs.running.length, 1);
  const card = vs.running[0];
  assert.deepEqual([card.kind, card.name, card.status, card.agentsTotal, card.agentsDone], ['workflow', 'demo', 'running', 3, 2]);
  const ag = Object.fromEntries(card.phases[0].agents.map(x => [x.label, x]));
  assert.deepEqual([ag['research:a'].state, ag['research:b'].state, ag['research:c'].state], ['done', 'done', 'running']);
  assert.ok(ag['research:c'].activity && ag['research:c'].startedAt !== null);
  const eta = ag['research:c'].eta;
  assert.ok(eta && eta.kind === 'range' && eta.basis === 'siblings' && eta.n === 2, JSON.stringify(eta));
  assert.ok(card.eta && typeof card.eta.text === 'string' && card.eta.text.length > 0);
  vs = m.refresh(now + 5e3);                                                  // inside the 20 s throttle: the same estimate, no countdown
  assert.deepEqual(vs.running[0].phases[0].agents.find(x => x.label === 'research:c').eta, eta);
  m.dispose();
});
