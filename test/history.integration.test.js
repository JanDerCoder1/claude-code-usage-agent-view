'use strict';
// Integration: History.bootstrap over the real ~/.claude/projects tree (result files only) and eta.js over the result.
// Skipped when the tree does not exist. Thresholds, not exact numbers: the tree grows with every workflow run.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const History = require('../lib/history');
const eta = require('../lib/eta');

const HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS = path.join(HOME, 'projects');
const HAS_TREE = fs.existsSync(PROJECTS);
const opts = { skip: HAS_TREE ? false : 'no ~/.claude/projects on this machine' };

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-view-hist-int-'));
after(() => { try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (e) { /* best effort */ } });

// independent scan of the result files (does not use lib/history.js)
function scanResultFiles() {
  let files = 0, agents = 0, bad = 0;
  if (!HAS_TREE) return { files, agents, bad };
  for (const proj of fs.readdirSync(PROJECTS, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    for (const sid of fs.readdirSync(path.join(PROJECTS, proj.name), { withFileTypes: true })) {
      if (!sid.isDirectory()) continue;
      const wd = path.join(PROJECTS, proj.name, sid.name, 'workflows');
      let names; try { names = fs.readdirSync(wd); } catch (e) { continue; }
      for (const n of names) {
        if (!/^wf_.+\.json$/.test(n)) continue;
        let j; try { j = JSON.parse(fs.readFileSync(path.join(wd, n), 'utf8')); } catch (e) { bad++; continue; }
        if (!Array.isArray(j.workflowProgress)) { bad++; continue; }
        files++;
        for (const w of j.workflowProgress) if (w && w.type === 'workflow_agent' && w.state === 'done' && !w.cached && Number.isFinite(w.durationMs) && w.durationMs > 0) agents++;
      }
    }
  }
  return { files, agents, bad };
}

const state = {};
async function boot() {
  if (state.h) return state;
  state.expected = scanResultFiles();
  state.file = path.join(OUT, 'history.json');
  state.h = new History(state.file);
  let ticks = 0, done = false;
  const t0 = process.hrtime.bigint();
  const p = state.h.bootstrap(HOME).then(() => { done = true; });
  while (!done) { await new Promise(r => setImmediate(r)); ticks++; }
  await p;
  state.ms = Number(process.hrtime.bigint() - t0) / 1e6; state.ticks = ticks;
  return state;
}

test('bootstrap over the real tree: agent count matches an independent scan (about 500-600 on the reference machine)', opts, async () => {
  const s = await boot();
  const n = s.h.snapshot().agents.length;
  console.log('# bootstrap: ' + s.expected.files + ' result files, ' + n + ' agents, ' + s.h.snapshot().phaseDurSec.length + ' phases, ' + s.ms.toFixed(0) + ' ms, ' + s.ticks + ' event-loop turns');
  assert.ok(Math.abs(n - Math.min(s.expected.agents, 3000)) <= 10, 'bootstrap ' + n + ' vs independent scan ' + s.expected.agents);
  if (s.expected.files >= 40) assert.ok(n >= 450 && n <= 700, 'expected about 500-600 agents, got ' + n);
  assert.deepEqual(s.h.lastBootstrap && s.h.lastBootstrap.runs, s.h.stats().runs);
});

test('bootstrap records are well-formed: wf kind, finite positive durations, normalised keys, enough distinct runs', opts, async () => {
  const { h } = await boot(); const s = h.snapshot();
  if (!s.agents.length) return;
  const runs = new Set();
  for (const r of s.agents) {
    assert.equal(r.kind, 'wf'); assert.ok(Number.isFinite(r.dur) && r.dur > 0 && r.dur < 7 * 86400);
    assert.equal(r.proj, r.proj.toLowerCase()); assert.equal(r.prefix, eta.fold(r.prefix)); assert.equal(r.phase, eta.fold(r.phase)); assert.ok(!/\[1m\]/.test(r.model));
    assert.match(r.run, /^[\w.-]+$/); assert.ok(!/^wf_/.test(r.run)); runs.add(r.run);
  }
  assert.ok(runs.size >= Math.min(8, h.stats().runs));
  for (const d of s.phaseDurSec) assert.ok(Number.isFinite(d) && d > 0);
});

test('bootstrap stays cheap and yields to the event loop (no transcript scan)', opts, async () => {
  const s = await boot();
  assert.ok(s.ms < 10000, 'bootstrap took ' + s.ms.toFixed(0) + ' ms');
  if (s.expected.files >= 20) assert.ok(s.ticks >= 5, 'only ' + s.ticks + ' event-loop turns');
});

test('second bootstrap is a no-op (idempotent) and a reloaded instance equals the first', opts, async () => {
  const s = await boot(); const before = s.h.snapshot();
  await s.h.bootstrap(HOME); assert.equal(s.h.snapshot(), before);
  const h2 = new History(s.file); h2.load(); assert.deepEqual(h2.snapshot(), before);
  await h2.bootstrap(HOME); assert.equal(h2.stats().agents, s.h.stats().agents);
});

test('estimateAgent over the real history: Eta contract at every elapsed value (lo<=mid<=hi, finite, German, no seconds)', opts, async () => {
  const { h } = await boot(); const snap = h.snapshot();
  const seen = new Set(); let n = 0;
  const check = (e, where) => {
    assert.ok(['number', 'range', 'late', 'unknown', 'none'].includes(e.kind), where);
    assert.equal(typeof e.text, 'string'); assert.equal(typeof e.tip, 'string');
    for (const k of ['lo', 'mid', 'hi']) assert.ok(e[k] === null || (Number.isFinite(e[k]) && e[k] >= 0), where + ' ' + k);
    if (e.kind === 'number' || e.kind === 'range') { assert.ok(e.lo <= e.mid && e.mid <= e.hi, where + ' ' + JSON.stringify(e)); assert.ok(Number.isFinite(e.lo + e.mid + e.hi)); }
    assert.doesNotMatch(e.text + ' ' + e.tip, /\b\d+\s*(?:s|sek\.?|sec|sekunden?)(?![a-zäöüß])/i, where);
    assert.ok(!/undefined|NaN|\[object/.test(e.text + e.tip), where);
    seen.add(e.kind + '/' + e.basis); n++;
  };
  for (const a of snap.agents.slice(0, 250)) {
    for (let e = 0; e < Math.min(a.dur, 1500); e += 25) {
      const input = { state: 'running', elapsedSec: e, silentSec: 0, kind: 'wf', label: a.prefix + ':x', phase: a.phase, model: a.model, project: a.proj, runId: 'new-run', agentType: null, siblingsDoneSec: [] };
      check(eta.estimateAgent(input, snap), 'plain e=' + e + ' ' + a.prefix);
      check(eta.estimateAgent({ ...input, siblingsDoneSec: [a.dur * 0.8, a.dur * 1.1, a.dur * 1.3] }, snap), 'siblings e=' + e);
    }
  }
  console.log('# estimateAgent: ' + n + ' calls, kinds ' + [...seen].sort().join(', '));
  if (snap.agents.length >= 100) assert.ok(seen.size >= 3, 'only ' + [...seen].join(', '));
});

test('real history: the global conditional remaining time is ~flat (median 3-8 min at every elapsed in 20..600 s) -> only a prior', opts, async () => {
  const { h } = await boot(); const durs = h.snapshot().agents.map(a => a.dur);
  if (durs.length < 100) return;
  for (const e of [20, 60, 120, 300, 600]) { const R = durs.filter(d => d > e).map(d => d - e); const q = eta.quantile(R, 0.5); assert.ok(q > 180 && q < 480, e + ': ' + q); }
});

test('real history: a fresh agent of a known prefix gets either a key range or "unbekannt", never a number without siblings', opts, async () => {
  const { h } = await boot(); const snap = h.snapshot();
  const byKey = new Map();
  for (const a of snap.agents) { const k = a.proj + '|' + a.prefix; byKey.set(k, (byKey.get(k) || 0) + 1); }
  for (const [k, c] of byKey) {
    const [proj, prefix] = k.split('|');
    const e = eta.estimateAgent({ state: 'running', elapsedSec: 120, silentSec: 0, kind: 'wf', label: prefix + ':z', project: proj, siblingsDoneSec: [] }, snap);
    assert.notEqual(e.kind, 'number', k); assert.ok(e.kind !== 'range' || e.basis === 'key', k);
    if (e.kind === 'range') assert.ok(c >= eta.DEFAULTS.keyMinAgents && e.n >= eta.DEFAULTS.keyMinAgents && e.runs >= eta.DEFAULTS.keyMinRuns, k + ' ' + JSON.stringify(e));
  }
});

test('estimateWorkflow with the real phase durations as fallback (needs >= 20 phases)', opts, async () => {
  const { h } = await boot(); const snap = h.snapshot();
  const e = eta.estimateWorkflow({ elapsedSec: 200, phasesAhead: 1, currentPhaseSiblingsDoneSec: [], currentPhaseElapsedSecs: [200], runPhaseDurSec: [] }, snap);
  assert.ok(['range', 'unknown'].includes(e.kind));
  if (snap.phaseDurSec.length >= eta.DEFAULTS.wfMinHistPhases) {
    assert.equal(e.kind, 'range'); assert.ok(e.lo <= e.mid && e.mid <= e.hi && Number.isFinite(e.hi)); assert.match(e.text, /^Rest grob: /);
  } else assert.equal(e.kind, 'unknown');
});

test('estimateAgent on the real snapshot costs well under a millisecond per call (index built once per snapshot)', opts, async () => {
  const { h } = await boot(); const snap = h.snapshot();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 2000; i++) eta.estimateAgent({ state: 'running', elapsedSec: 30 + (i % 900), silentSec: 0, kind: 'wf', label: 'verify:' + i, project: 'c--x', siblingsDoneSec: [] }, snap);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 1500, ms.toFixed(0) + ' ms for 2000 estimates');
});
