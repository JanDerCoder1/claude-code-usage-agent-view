'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const eta = require('../lib/eta');
const { estimateRemaining: est, estimateWorkflowRemaining: wfest, formatEstimate: fmtE, makeRecord, labelPrefix, estimateAgent, estimateWorkflow, DEFAULTS } = eta;

// synthetic history: `runs` workflow runs, each with `per` agents of one label prefix in one project
const mkHist = (specs) => {
  const agents = [];
  for (const s of specs) for (let r = 0; r < s.runs; r++) for (let i = 0; i < s.per; i++) {
    const dur = s.base * (0.6 + 0.8 * ((i * 7 + r * 3) % 10) / 10);
    agents.push(makeRecord({ kind: s.kind || 'wf', label: s.label + ':x' + i, agentType: s.agentType, phase: s.phase || 'p', model: 'm', project: eta.projectKey(s.project || 'P'), runId: 'run-' + s.label + '-' + r, durationSec: dur }));
  }
  return { agents };
};
const A = (o) => Object.assign({ state: 'running', elapsedSec: 100, kind: 'wf', label: 'verify:a', phase: 'Verify', model: 'm', project: 'p', runId: 'run-new', siblingsDoneSec: [] }, o);
const EMPTY = { agents: [] };

// ---------------------------------------------------------------------------------------------
// 1. The research-phase core (25 tests of estimate.test.js; the two data-driven ones live in
//    history.integration.test.js because they need the real history). Logic must stay unchanged.
// ---------------------------------------------------------------------------------------------

test('labelPrefix folds umlauts, case and trailing digits', () => {
  assert.equal(labelPrefix('Prüfe:Foo'), 'pruefe'); assert.equal(labelPrefix('gegen2:x'), 'gegen'); assert.equal(labelPrefix('Fassung A'), 'fassung a');
});
test('not running -> none (no ETA for queued / finished / failed)', () => {
  for (const s of ['queued', 'done', 'failed']) assert.equal(est(A({ state: s }), EMPTY).kind, 'none');
  assert.equal(est(A({ elapsedSec: NaN }), EMPTY).kind, 'none');
});
test('first 15 s: warm-up -> unknown', () => {
  const r = est(A({ elapsedSec: 5 }), EMPTY); assert.equal(r.kind, 'unknown'); assert.equal(r.reason, 'warmup');
});
test('10 min of silence in the agent file -> unknown/stale (not an ETA)', () => {
  const r = est(A({ elapsedSec: 400, silentSec: 700, siblingsDoneSec: [100, 110] }), EMPTY); assert.equal(r.reason, 'stale'); assert.equal(fmtE(r), 'keine Aktivität');
});
test('siblings agree (>=2 survivors, spread <= max(45 s, 0.5*mid)) -> number', () => {
  const r = est(A({ elapsedSec: 200, siblingsDoneSec: [300, 320, 340, 150] }), EMPTY);   // survivors 100,120,140 -> mid 120, spread 40
  assert.equal(r.kind, 'number'); assert.equal(r.basis, 'siblings'); assert.equal(r.mid, 120); assert.equal(fmtE(r), '~2 Min.');
});
test('number below ~45 s is shown as "unter 1 Min." (never seconds: error is ~30 s)', () => {
  const r = est(A({ elapsedSec: 90, siblingsDoneSec: [100, 105, 110] }), EMPTY); assert.equal(r.kind, 'number'); assert.equal(fmtE(r), 'unter 1 Min.');
});
test('siblings disagree -> range [mid/2, 2*mid]', () => {
  const r = est(A({ elapsedSec: 150, siblingsDoneSec: [100, 300, 500] }), EMPTY);        // survivors 150,350 -> mid 250
  assert.equal(r.kind, 'range'); assert.equal(r.basis, 'siblings'); assert.equal(r.lo, 125); assert.equal(r.hi, 500); assert.equal(fmtE(r), '2–8 Min.');
});
test('one survivor only -> range (never a number)', () => {
  const r = est(A({ elapsedSec: 150, siblingsDoneSec: [100, 120, 400] }), EMPTY); assert.equal(r.kind, 'range');
});
test('already longer than every finished sibling -> late (never "0 s left")', () => {
  const r = est(A({ elapsedSec: 400, siblingsDoneSec: [100, 110, 120] }), EMPTY);
  assert.equal(r.kind, 'late'); assert.equal(r.reason, 'longer-than-finished-siblings'); assert.deepEqual([r.lo, r.hi], [30, 210]); assert.match(fmtE(r), /länger als die anderen/);
});
test('only 1 finished sibling is not enough -> falls through to history', () => {
  assert.equal(est(A({ siblingsDoneSec: [50] }), EMPTY).reason, 'thin-history');
});
test('thin history (<30 agents or <8 runs) -> unknown', () => {
  assert.equal(est(A(), mkHist([{ label: 'verify', runs: 3, per: 4, base: 200 }])).reason, 'thin-history');   // 12 agents, 3 runs
  assert.equal(est(A(), mkHist([{ label: 'verify', runs: 2, per: 40, base: 200 }])).reason, 'thin-history');  // 80 agents, 2 runs
});
test('Task agents (kind task) with tiny history -> unknown', () => {
  const h = mkHist([{ kind: 'task', label: 'x', agentType: 'Explore', runs: 3, per: 5, base: 200 }]);
  assert.equal(est(A({ kind: 'task', agentType: 'Explore', label: null }), h).kind, 'unknown');
});
test('enough history but no key match -> global prior only: unknown + typical range for tooltip', () => {
  const h = mkHist([{ label: 'review', runs: 12, per: 6, base: 300 }]);
  const r = est(A({ elapsedSec: 100 }), h);
  assert.equal(r.kind, 'unknown'); assert.equal(r.reason, 'prior-only'); assert.ok(r.typical.lo < r.typical.mid && r.typical.mid < r.typical.hi); assert.equal(fmtE(r), 'unbekannt');
});
test('key history (same project + label prefix, >=15 agents, >=8 runs) -> range with basis key', () => {
  const h = mkHist([{ label: 'verify', runs: 10, per: 3, base: 300 }]);
  const r = est(A({ elapsedSec: 100 }), h);
  assert.equal(r.kind, 'range'); assert.equal(r.basis, 'key'); assert.ok(r.lo > 0 && r.lo < r.mid && r.mid < r.hi); assert.equal(r.runs, 10);
});
test('key history of another project is not used', () => {
  const h = mkHist([{ label: 'verify', runs: 10, per: 3, base: 300, project: 'OTHER' }]);
  assert.equal(est(A({ elapsedSec: 100 }), h).kind, 'unknown');
});
test('elapsed beyond p90 of the pool -> "länger als üblich", no range, no number', () => {
  const h = mkHist([{ label: 'verify', runs: 10, per: 3, base: 300 }]);
  const r = est(A({ elapsedSec: 5000 }), h);
  assert.equal(r.kind, 'late'); assert.equal(r.reason, 'longer-than-usual'); assert.equal(r.lo, null); assert.equal(fmtE(r), 'länger als üblich');
});
test('estimates are pure and do not mutate inputs', () => {
  const h = mkHist([{ label: 'verify', runs: 10, per: 3, base: 300 }]); const a = A({ siblingsDoneSec: [300, 320, 340] }); const s = JSON.stringify([a, h]);
  est(a, h); assert.equal(JSON.stringify([a, h]), s);
});
test('formatEstimate rounding: <10 min whole minutes, >=10 min steps of 5', () => {
  assert.equal(fmtE({ kind: 'range', lo: 100, hi: 400 }), '2–7 Min.'); assert.equal(fmtE({ kind: 'range', lo: 700, hi: 1900 }), '10–30 Min.');
  assert.equal(fmtE({ kind: 'range', lo: 20, hi: 150 }), 'bis ~3 Min.'); assert.equal(fmtE({ kind: 'none' }), '');
});

// ---- workflow level (core) ----
test('workflow: no finished phase and no history -> unknown', () => {
  const r = wfest({ phasesDeclared: 3, phases: [{ elapsedSec: 60, finished: false, doneDurSec: [], runningElapsedSec: [60, 60] }] }, EMPTY); assert.equal(r.kind, 'unknown');
});
test('workflow: last phase with finished siblings -> coarse range [c/2, 2c], never a number', () => {
  const r = wfest({ phasesDeclared: 1, phases: [{ elapsedSec: 200, finished: false, doneDurSec: [250, 260], runningElapsedSec: [200] }] }, EMPTY);
  assert.equal(r.kind, 'range'); assert.equal(r.basis, 'phases'); assert.equal(r.mid, 55); assert.equal(r.lo, 27.5); assert.equal(r.hi, 110);
});
test('workflow: exceeded siblings never yields 0 (uses 0.5*median)', () => {
  const r = wfest({ phasesDeclared: 1, phases: [{ elapsedSec: 400, finished: false, doneDurSec: [250, 260], runningElapsedSec: [400] }] }, EMPTY); assert.equal(r.mid, 127.5);
});
test('workflow: phases ahead * typical phase duration from this run', () => {
  const r = wfest({ phasesDeclared: 3, phases: [{ elapsedSec: 600, finished: true, durSec: 600, doneDurSec: [], runningElapsedSec: [] }, { elapsedSec: 100, finished: false, doneDurSec: [], runningElapsedSec: [100] }] }, EMPTY);
  assert.equal(r.nAhead, 1); assert.equal(r.mid, 500 + 600);
});
test('workflow: history phase durations used only with >=20 samples', () => {
  const run = { phasesDeclared: 2, phases: [{ elapsedSec: 100, finished: false, doneDurSec: [], runningElapsedSec: [100] }] };
  assert.equal(wfest(run, { phaseDurSec: new Array(5).fill(500) }).kind, 'unknown');
  assert.equal(wfest(run, { phaseDurSec: new Array(25).fill(500) }).kind, 'range');
});

// ---------------------------------------------------------------------------------------------
// 2. Text formatting
// ---------------------------------------------------------------------------------------------

test('fmtRange: both ends below 45 s -> "unter 1 Min.", never "~< 1 Min."', () => {
  assert.equal(eta.fmtRange(2.5, 10), 'unter 1 Min.');
  assert.equal(fmtE({ kind: 'range', lo: 10, hi: 30 }), 'unter 1 Min.');
  assert.equal(eta.fmtRange(100, 130), '~2 Min.');            // same rounded minute on both ends
  assert.equal(eta.fmtRange(NaN, 100), '');
});
test('fmtMin boundaries: 44 s -> < 1, 45 s -> 1, 9.5 min -> 10 (then steps of 5), 12 min -> 10, 13 min -> 15', () => {
  assert.equal(eta.fmtMin(44), '< 1'); assert.equal(eta.fmtMin(45), '1'); assert.equal(eta.fmtMin(570), '10');
  assert.equal(eta.fmtMin(12 * 60), '10'); assert.equal(eta.fmtMin(13 * 60), '15'); assert.equal(eta.fmtMin(NaN), '');
});

// ---------------------------------------------------------------------------------------------
// 3. Adapter estimateAgent -> Eta (SPEC 2) with German text/tip
// ---------------------------------------------------------------------------------------------

const ETA_KEYS = ['basis', 'hi', 'kind', 'lo', 'mid', 'text', 'tip'];
const SECONDS_RE = /\b\d+(?:[.,]\d+)?\s*(?:s|sek\.?|sec|secs|sekunden?|seconds?)(?![a-zäöüß])/i;
const ASCII_UMLAUT_RE = /\b\w*(?:laenger|ueblich|aktivitaet|laeuf|schaetz|ueber|koenn|fuer|waehrend|moeglich|zuverlaessig)\w*/i;

function assertEta(e, where) {
  const w = where || JSON.stringify(e);
  assert.ok(['number', 'range', 'late', 'unknown', 'none'].includes(e.kind), w);
  assert.ok(['siblings', 'key', 'global', 'phases', 'none'].includes(e.basis), w);
  assert.equal(typeof e.text, 'string', w); assert.equal(typeof e.tip, 'string', w);
  for (const k of ['lo', 'mid', 'hi']) assert.ok(e[k] === null || (typeof e[k] === 'number' && isFinite(e[k]) && e[k] >= 0), w + ' ' + k);
  if (e.kind === 'number' || e.kind === 'range') { assert.ok(e.lo <= e.mid && e.mid <= e.hi, w); }
  for (const k of Object.keys(e)) assert.ok([...ETA_KEYS, 'n', 'runs'].includes(k), 'unexpected field ' + k);
  for (const s of [e.text, e.tip]) {
    assert.doesNotMatch(s, SECONDS_RE, 'seconds shown: ' + s);
    assert.doesNotMatch(s, ASCII_UMLAUT_RE, 'ASCII fallback instead of umlaut: ' + s);
    assert.ok(!s.includes('\uFFFD') && !/undefined|NaN|null|\[object/.test(s), 'garbage in text: ' + s);
  }
  if (e.kind === 'none') assert.deepEqual([e.text, e.tip], ['', '']);
  else assert.ok(e.text.length > 0 && e.tip.length > 0, w);
}

test('estimateAgent: exports match the contract', () => {
  assert.equal(typeof estimateAgent, 'function'); assert.equal(typeof estimateWorkflow, 'function');
  assert.equal(DEFAULTS.minElapsed, 15); assert.equal(DEFAULTS.staleSilenceSec, 600); assert.equal(DEFAULTS.keyMinRuns, 8);
  assert.ok(Object.isFrozen(DEFAULTS));
});
test('estimateAgent: not running -> kind none with empty text and tip', () => {
  for (const s of ['queued', 'waiting', 'done', 'failed', 'interrupted', 'stopped']) {
    const e = estimateAgent(A({ state: s }), null); assertEta(e); assert.equal(e.kind, 'none');
  }
});
test('estimateAgent: warm-up and stale -> unknown with the right German label', () => {
  const w = estimateAgent(A({ elapsedSec: 5 }), null); assertEta(w); assert.equal(w.kind, 'unknown'); assert.equal(w.text, 'unbekannt'); assert.match(w.tip, /gerade erst gestartet/);
  const s = estimateAgent(A({ elapsedSec: 400, silentSec: 700 }), null); assertEta(s); assert.equal(s.text, 'keine Aktivität'); assert.match(s.tip, /Seit über 10 Min\./);
});
test('estimateAgent: siblings agree -> number "~2 Min." with seconds in lo/mid/hi and n', () => {
  const e = estimateAgent(A({ elapsedSec: 200, siblingsDoneSec: [300, 320, 340, 150] }), null); assertEta(e);
  assert.equal(e.kind, 'number'); assert.equal(e.basis, 'siblings'); assert.equal(e.text, '~2 Min.');
  assert.deepEqual([e.lo, e.mid, e.hi], [100, 120, 140]); assert.equal(e.n, 4); assert.equal(e.runs, undefined);
  assert.match(e.tip, /Basis: 4 fertige Geschwister/);
});
test('estimateAgent: number below 45 s -> "unter 1 Min."', () => {
  const e = estimateAgent(A({ elapsedSec: 90, siblingsDoneSec: [100, 105, 110] }), null); assertEta(e); assert.equal(e.text, 'unter 1 Min.');
});
test('estimateAgent: siblings disagree -> range "2–8 Min." and a "Grob" tooltip with the basis', () => {
  const e = estimateAgent(A({ elapsedSec: 150, siblingsDoneSec: [100, 300, 500] }), null); assertEta(e);
  assert.equal(e.kind, 'range'); assert.equal(e.text, '2–8 Min.'); assert.deepEqual([e.lo, e.mid, e.hi], [125, 250, 500]); assert.match(e.tip, /^Grobe Schätzung/); assert.match(e.tip, /Basis: 3 fertige Geschwister/);
});
test('estimateAgent: longer than all siblings -> late with the "meist < 4 Min. mehr" text', () => {
  const e = estimateAgent(A({ elapsedSec: 400, siblingsDoneSec: [100, 110, 120] }), null); assertEta(e);
  assert.equal(e.kind, 'late'); assert.equal(e.text, 'länger als die anderen (meist < 4 Min. mehr)'); assert.equal(e.mid, null); assert.deepEqual([e.lo, e.hi], [30, 210]);
});
test('estimateAgent: key history -> range, tooltip names agents and runs', () => {
  const h = mkHist([{ label: 'verify', runs: 10, per: 3, base: 300 }]);
  const e = estimateAgent(A({ elapsedSec: 100 }), h); assertEta(e);
  assert.equal(e.kind, 'range'); assert.equal(e.basis, 'key'); assert.equal(e.n, 30); assert.equal(e.runs, 10);
  assert.match(e.tip, /Basis: 30 Agenten aus 10 Läufen \(gleiches Projekt, gleicher Namensanfang\)/);
});
test('estimateAgent: past p90 -> "länger als üblich"; thin history and prior-only -> unbekannt', () => {
  const h = mkHist([{ label: 'verify', runs: 10, per: 3, base: 300 }]);
  const late = estimateAgent(A({ elapsedSec: 5000 }), h); assertEta(late); assert.equal(late.text, 'länger als üblich'); assert.equal(late.lo, null);
  const thin = estimateAgent(A(), mkHist([{ label: 'verify', runs: 3, per: 4, base: 200 }])); assertEta(thin); assert.equal(thin.text, 'unbekannt'); assert.match(thin.tip, /Noch zu wenig Vergleichswerte/);
  const prior = estimateAgent(A({ elapsedSec: 100 }), mkHist([{ label: 'review', runs: 12, per: 6, base: 300 }])); assertEta(prior);
  assert.equal(prior.kind, 'unknown'); assert.equal(prior.basis, 'global'); assert.equal(prior.mid, null); assert.match(prior.tip, /nur ein Erfahrungswert/); assert.match(prior.tip, /Basis: 72 Agenten aus 12 Läufen/);
});
test('estimateAgent: label retry suffix and project spelling do not change the key', () => {
  const h = mkHist([{ label: 'verify', runs: 10, per: 3, base: 300, project: 'c--x-y' }]);
  const a = estimateAgent(A({ label: 'verify:a (retry 2)', project: 'C--X-Y' }), h);
  const b = estimateAgent(A({ label: 'Verify:a', project: 'c--x-y' }), h);
  assert.equal(a.basis, 'key'); assert.deepEqual(a, b);
  assert.equal(eta.projectKey('C--X-Y'), 'c--x-y'); assert.equal(eta.projectKey('C:\\Unternehmung\\Technik'), 'c--unternehmung-technik');
  assert.equal(eta.projectKey('C:\\Users\\x\\.claude\\projects\\C--Foo-Bar\\'), 'c--foo-bar'); assert.equal(eta.projectKey(null), '');
});
test('estimateAgent: task agents work off the agent type', () => {
  const h = mkHist([{ kind: 'task', label: 'x', agentType: 'Explore', runs: 10, per: 3, base: 200, project: 'p' }]);
  const e = estimateAgent({ state: 'running', elapsedSec: 100, kind: 'task', label: 'Look around', agentType: 'Explore', project: 'p', siblingsDoneSec: [] }, h); assertEta(e);
  assert.equal(e.basis, 'key'); assert.match(e.tip, /gleicher Agententyp/);
});
test('estimateAgent: garbage input never throws and yields a valid Eta', () => {
  const junk = [undefined, null, 0, 42, 'x', [], {}, { state: 'running' }, { state: 'running', elapsedSec: 'abc' }, { state: 'running', elapsedSec: -5 }, { state: 'running', elapsedSec: Infinity, kind: 'wf' },
    A({ siblingsDoneSec: 'nope' }), A({ siblingsDoneSec: [NaN, 'a', null, -3, undefined, {}] }), A({ label: 42, project: {}, phase: [], model: 1 }), A({ kind: 'weird' })];
  const hists = [undefined, null, 5, 'h', {}, { agents: 'x' }, { agents: [null, 3, {}] }, { agents: [{ kind: 'wf' }] }];
  for (const j of junk) for (const h of hists) { const e = estimateAgent(j, h); assert.ok(e && typeof e.text === 'string' && typeof e.tip === 'string'); }
  assertEta(estimateAgent(A({ siblingsDoneSec: [NaN, 'a', null, -3, undefined, {}] }), null));
});
test('estimateAgent: pure, does not mutate input or history snapshot', () => {
  const h = mkHist([{ label: 'verify', runs: 10, per: 3, base: 300 }]); const a = A({ siblingsDoneSec: [300, 320, 340], label: 'verify (retry 1)', project: 'P' });
  const s = JSON.stringify([a, h]); estimateAgent(a, h); assert.equal(JSON.stringify([a, h]), s);
});
test('estimateAgent: sweep over elapsed x sibling sets x histories keeps the Eta contract, German and without seconds', () => {
  const hists = [null, EMPTY, mkHist([{ label: 'verify', runs: 10, per: 3, base: 300 }]), mkHist([{ label: 'review', runs: 12, per: 6, base: 300 }]), mkHist([{ label: 'verify', runs: 10, per: 3, base: 40 }])];
  const sibs = [[], [50], [100, 110], [100, 105, 110], [100, 300, 500], [20, 25, 400], [1, 2, 3], [5000, 5010, 9000]];
  const seen = new Set();
  for (const h of hists) for (const siblings of sibs) for (const e of [0, 10, 15, 30, 44, 45, 60, 90, 99, 100, 150, 200, 400, 600, 899, 2000, 5000, 20000]) for (const silentSec of [0, 700]) {
    const r = estimateAgent(A({ elapsedSec: e, silentSec, siblingsDoneSec: siblings }), h); assertEta(r, JSON.stringify({ e, siblings, silentSec }));
    seen.add(r.kind + '/' + r.basis);
    if (r.kind === 'number') assert.doesNotMatch(r.text, /~0 Min|bis ~0/);
    if (r.kind === 'range') assert.doesNotMatch(r.text, /~0 Min|bis ~0|< 1/);
  }
  for (const want of ['number/siblings', 'range/siblings', 'late/siblings', 'range/key', 'late/key', 'unknown/none', 'unknown/global']) assert.ok(seen.has(want), 'branch not exercised: ' + want);
});
test('estimateAgent: a number or range is never 0 (finished siblings that are all shorter than elapsed give "late")', () => {
  for (let e = 15; e < 1000; e += 7) {
    const r = estimateAgent(A({ elapsedSec: e, siblingsDoneSec: [100, 200, 300] }), null); assertEta(r);
    if (r.kind === 'number' || r.kind === 'range') assert.ok(r.lo > 0 && r.mid > 0 && r.hi > 0);
    if (e >= 300) assert.equal(r.kind, 'late');
  }
});

// ---------------------------------------------------------------------------------------------
// 4. Adapter estimateWorkflow
// ---------------------------------------------------------------------------------------------

const W = (o) => Object.assign({ elapsedSec: 300, phasesAhead: 0, currentPhaseSiblingsDoneSec: [], currentPhaseElapsedSecs: [], runPhaseDurSec: [] }, o);

test('estimateWorkflow: last phase with finished siblings -> "Rest grob: bis ~2 Min." (range [c/2, 2c], seconds in lo/mid/hi)', () => {
  const e = estimateWorkflow(W({ elapsedSec: 200, currentPhaseSiblingsDoneSec: [250, 260], currentPhaseElapsedSecs: [200] }), null); assertEta(e);
  assert.equal(e.kind, 'range'); assert.equal(e.basis, 'phases'); assert.deepEqual([e.lo, e.mid, e.hi], [27.5, 55, 110]); assert.equal(e.text, 'Rest grob: bis ~2 Min.'); assert.match(e.tip, /Grobe Schätzung/);
});
test('estimateWorkflow: one phase ahead, typical duration from this run -> "Rest grob: 9–35 Min."', () => {
  const e = estimateWorkflow(W({ elapsedSec: 700, phasesAhead: 1, currentPhaseElapsedSecs: [100], runPhaseDurSec: [600] }), null); assertEta(e);
  assert.equal(e.mid, 1100); assert.equal(e.text, 'Rest grob: 9–35 Min.'); assert.match(e.tip, /plus 1 weitere Phase/);
});
test('estimateWorkflow: SPEC 6.3 - two or more phases ahead -> "Rest unbekannt" even though the core would give a range', () => {
  const input = W({ elapsedSec: 700, phasesAhead: 2, currentPhaseElapsedSecs: [100], runPhaseDurSec: [600] });
  assert.equal(wfest({ phasesDeclared: 4, phases: [{ elapsedSec: 600, finished: true, durSec: 600, doneDurSec: [], runningElapsedSec: [] }, { elapsedSec: 100, finished: false, doneDurSec: [], runningElapsedSec: [100] }] }, EMPTY).kind, 'range');
  const e = estimateWorkflow(input, null); assertEta(e); assert.equal(e.kind, 'unknown'); assert.equal(e.text, 'Rest unbekannt'); assert.equal(e.lo, null); assert.match(e.tip, /Mehrere Phasen/);
});
test('estimateWorkflow: no finished phase and no history -> unknown with the thin-history tooltip', () => {
  const e = estimateWorkflow(W({ phasesAhead: 2, currentPhaseElapsedSecs: [60, 60] }), null); assertEta(e);
  assert.equal(e.text, 'Rest unbekannt'); assert.match(e.tip, /mindestens 20 Phasen/);
});
test('estimateWorkflow: history phase durations count only with >= 20 samples (phaseDurSec of the snapshot)', () => {
  const input = W({ phasesAhead: 1, currentPhaseElapsedSecs: [100] });
  assert.equal(estimateWorkflow(input, { agents: [], phaseDurSec: new Array(5).fill(500) }).kind, 'unknown');
  const e = estimateWorkflow(input, { agents: [], phaseDurSec: new Array(25).fill(500) }); assertEta(e); assert.equal(e.kind, 'range'); assert.equal(e.mid, 400 + 500);
});
test('estimateWorkflow: current phase elapsed is derived from the run clock when no agent of it is running', () => {
  const e = estimateWorkflow(W({ elapsedSec: 450, currentPhaseSiblingsDoneSec: [100, 100], runPhaseDurSec: [300] }), null); assertEta(e);
  assert.equal(e.mid, 150); assert.equal(e.text, 'Rest grob: 1–5 Min.');    // pm 300 - (450 - 300)
});
test('estimateWorkflow: exceeded siblings never yield 0; tiny remainder -> unknown (too small)', () => {
  const e = estimateWorkflow(W({ currentPhaseSiblingsDoneSec: [250, 260], currentPhaseElapsedSecs: [400] }), null); assertEta(e); assert.equal(e.mid, 127.5);
  const t = estimateWorkflow(W({ currentPhaseSiblingsDoneSec: [40, 41], currentPhaseElapsedSecs: [30] }), null); assertEta(t); assert.equal(t.kind, 'unknown'); assert.equal(t.basis, 'phases'); assert.match(t.tip, /sehr kurz/);
  const nothing = estimateWorkflow(W({}), null); assertEta(nothing); assert.equal(nothing.kind, 'unknown');
});
test('estimateWorkflow: garbage input never throws; the Eta contract holds over a sweep', () => {
  for (const j of [undefined, null, 5, 'x', [], {}, W({ currentPhaseSiblingsDoneSec: 'x', currentPhaseElapsedSecs: [NaN, 'a'], runPhaseDurSec: [null, -1], phasesAhead: 'many', elapsedSec: 'x' })])
    for (const h of [undefined, null, 3, {}, { phaseDurSec: 'x' }]) { const e = estimateWorkflow(j, h); assert.ok(e && typeof e.text === 'string' && typeof e.tip === 'string'); }
  for (const ahead of [0, 1, 2, 3]) for (const done of [[], [30], [200, 260], [3000, 4000]]) for (const run of [[], [10], [100, 400], [60, 70, 80]]) for (const fin of [[], [300], [30, 40]]) for (const el of [0, 100, 5000]) {
    assertEta(estimateWorkflow(W({ elapsedSec: el, phasesAhead: ahead, currentPhaseSiblingsDoneSec: done, currentPhaseElapsedSecs: run, runPhaseDurSec: fin }), { agents: [], phaseDurSec: new Array(30).fill(400) }));
  }
});
