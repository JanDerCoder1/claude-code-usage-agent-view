'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const eta = require('../lib/eta');
const { makeRecord, labelPrefix, estimateAgent, estimateWorkflow, formatSpan, formatOne, DEFAULTS } = eta;

// synthetic history of `runs` runs with `per` workflow agents each (phase size np, position pos)
const mkHist = (specs) => {
  const agents = [];
  for (const s of specs) for (let r = 0; r < s.runs; r++) for (let i = 0; i < (s.per || 1); i++) {
    const dur = s.base * (0.6 + 0.8 * ((i * 7 + r * 3) % 10) / 10);
    agents.push(makeRecord({ kind: s.kind || 'wf', label: 'x' + i, agentType: s.agentType, phase: s.phase || 'p', model: 'm', project: 'p', runId: 'run-' + (s.label || 'a') + r, durationSec: dur, phaseSize: s.np || 1, phasePos: s.pos || 0 }));
  }
  return { agents, phaseDurSec: [] };
};
const A = (o) => Object.assign({ state: 'running', elapsedSec: 100, kind: 'wf', label: 'verify:a', phase: 'Verify', model: 'm', project: 'p', runId: 'run-new', phaseSize: 1, phasePos: 0.5, siblingsDoneSec: [], siblingsRunningSec: [], otherPhases: [] }, o);

// ---- helpers ------------------------------------------------------------------------------------------------------------------

test('labelPrefix folds umlauts, case and trailing digits; stripRetry and projectKey normalise keys', () => {
  assert.equal(labelPrefix('Prüfe:Foo'), 'pruefe'); assert.equal(labelPrefix('gegen2:x'), 'gegen'); assert.equal(labelPrefix('Fassung A'), 'fassung a');
  assert.equal(eta.stripRetry('verify:a (retry 2)'), 'verify:a'); assert.equal(eta.stripRetry('verify:a'), 'verify:a');
  assert.equal(eta.projectKey('C--X-Y'), 'c--x-y'); assert.equal(eta.projectKey('C:\\Unternehmung\\Technik'), 'c--unternehmung-technik');
  assert.equal(eta.projectKey('C:\\Users\\x\\.claude\\projects\\C--Foo-Bar\\'), 'c--foo-bar'); assert.equal(eta.projectKey(null), '');
});

test('makeRecord keeps the phase size and position the regression needs, clamped and rounded', () => {
  const r = makeRecord({ kind: 'wf', label: 'verify:a', phase: 'Verify', model: 'm', project: 'p', runId: 'r', durationSec: 12.34, phaseSize: 7, phasePos: 0.3333 });
  assert.deepEqual([r.np, r.pos, r.dur], [7, 0.33, 12.3]);
  const d = makeRecord({ kind: 'task', label: 'x', agentType: 'Explore', durationSec: 5 });
  assert.deepEqual([d.np, d.pos], [1, 0]);
  const c = makeRecord({ kind: 'wf', label: 'x', durationSec: 5, phaseSize: 99999, phasePos: 7 });
  assert.deepEqual([c.np, c.pos], [500, 1]);
});

// ---- text formatting ----------------------------------------------------------------------------------------------------------

test('formatSpan: minutes, outward rounding, "unter" below a minute, hours only when even the lower end is an hour', () => {
  assert.equal(formatSpan(200, 1500), 'ca. 3–25 Min.');
  assert.equal(formatSpan(100, 130), 'ca. 1–3 Min.');           // lower end rounded down, upper end up
  assert.equal(formatSpan(30, 600), 'unter 10 Min.');             // under a minute at the low end
  assert.equal(formatSpan(40, 50), 'unter 1 Min.');
  assert.equal(formatSpan(0, 30), 'unter 1 Min.');
  assert.equal(formatSpan(700, 5000), 'ca. 10–90 Min.');          // 90 min stays minutes: "0–1,5 Std." would be nonsense
  assert.equal(formatSpan(2400, 9000), 'ca. 40–150 Min.');
  assert.equal(formatSpan(3700, 9000), 'ca. 1–2,5 Std.');
  assert.equal(formatSpan(5400, 12000), 'ca. 1,5–3,5 Std.');
  assert.equal(formatSpan(3600, 3600), 'ca. 1 Std.');
  assert.equal(formatSpan(120, 120), 'ca. 2 Min.');
  assert.equal(formatSpan(NaN, 100), ''); assert.equal(formatSpan(-5, 100), ''); assert.equal(formatSpan(100, Infinity), '');
});
test('formatSpan: the upper end is never below the real upper end (rounded outward), the lower end never above', () => {
  for (let lo = 20; lo < 20000; lo = Math.round(lo * 1.37 + 3)) for (const f of [1.2, 2, 5, 12]) {
    const s = formatSpan(lo, lo * f);
    const m = /^ca\. ([\d,]+)(?:–([\d,]+))? (Min|Std)\.$/.exec(s) || /^unter ([\d,]+) Min\.$/.exec(s);
    assert.ok(m, 'format of ' + s);
    const num = (t, unit) => parseFloat(t.replace(',', '.')) * (unit === 'Std' ? 3600 : 60);
    if (s.startsWith('unter')) { assert.ok(num(m[1], 'Min') >= lo * f - 1e-9, s); continue; }
    const hiTxt = m[2] || m[1], loTxt = m[1];
    assert.ok(num(hiTxt, m[3]) >= lo * f - 1e-6, 'upper end of ' + s + ' for ' + lo + '..' + lo * f);
    assert.ok(num(loTxt, m[3]) <= lo + 1e-6, 'lower end of ' + s + ' for ' + lo);
  }
});
test('formatOne: one number rounded to the nearest step; below a minute it says so', () => {
  assert.equal(formatOne(360), 'ca. 6 Min.'); assert.equal(formatOne(50), 'ca. 1 Min.'); assert.equal(formatOne(20), 'unter 1 Min.');
  assert.equal(formatOne(1000), 'ca. 15 Min.'); assert.equal(formatOne(3600), 'ca. 1 Std.'); assert.equal(formatOne(5400), 'ca. 1,5 Std.');
  assert.equal(formatOne(NaN), ''); assert.equal(formatOne(-1), '');
});

// ---- Eta contract -------------------------------------------------------------------------------------------------------------

const ETA_KEYS = ['basis', 'hi', 'kind', 'lo', 'mid', 'text', 'tip'];
const SECONDS_RE = /\b\d+(?:[.,]\d+)?\s*(?:s|sek\.?|sec|secs|sekunden?|seconds?)(?![a-zäöüß])/i;
const ASCII_UMLAUT_RE = /\b\w*(?:laenger|ueblich|aktivitaet|laeuf|schaetz|ueber|koenn|fuer|waehrend|moeglich|zuverlaessig)\w*/i;
const BASES = ['siblings', 'run', 'history', 'prior', 'phases', 'none'];

function assertEta(e, where) {
  const w = where || JSON.stringify(e);
  assert.ok(['number', 'range', 'late', 'unknown', 'none'].includes(e.kind), w);
  assert.ok(BASES.includes(e.basis), w + ' basis ' + e.basis);
  assert.equal(typeof e.text, 'string', w); assert.equal(typeof e.tip, 'string', w);
  for (const k of ['lo', 'mid', 'hi']) assert.ok(e[k] === null || (typeof e[k] === 'number' && isFinite(e[k]) && e[k] >= 0), w + ' ' + k);
  if (['number', 'range', 'late'].includes(e.kind)) { assert.ok(e.lo !== null && e.lo <= e.mid && e.mid <= e.hi, w); }
  if (e.kind === 'unknown') assert.deepEqual([e.lo, e.mid, e.hi], [null, null, null]);
  for (const k of Object.keys(e)) assert.ok([...ETA_KEYS, 'n', 'runs'].includes(k), 'unexpected field ' + k);
  for (const s of [e.text, e.tip]) {
    assert.doesNotMatch(s, SECONDS_RE, 'seconds shown: ' + s);
    assert.doesNotMatch(s, ASCII_UMLAUT_RE, 'ASCII fallback instead of umlaut: ' + s);
    assert.ok(!s.includes('\uFFFD') && !/undefined|NaN|null|\[object/.test(s), 'garbage in text: ' + s);
  }
  if (e.kind === 'none') assert.deepEqual([e.text, e.tip], ['', '']);
  else assert.ok(e.text.length > 0 && e.tip.length > 0, w);
  if (e.kind === 'range' || e.kind === 'number') assert.match(e.text, /^Fertig in (ca\. |unter )/, w);
  if (e.kind === 'late') assert.match(e.text, /^länger als üblich: (ca\. |unter )/, w);
}

test('exports match the contract', () => {
  assert.equal(typeof estimateAgent, 'function'); assert.equal(typeof estimateWorkflow, 'function');
  assert.equal(DEFAULTS.minElapsed, 15); assert.equal(DEFAULTS.staleSilenceSec, 600); assert.ok(DEFAULTS.loQ < DEFAULTS.midQ && DEFAULTS.midQ < DEFAULTS.hiQ && DEFAULTS.hiQ <= DEFAULTS.wfHiQ);
  assert.ok(Object.isFrozen(DEFAULTS));
});

// ---- estimateAgent ------------------------------------------------------------------------------------------------------------

test('not running -> kind none with empty text and tip', () => {
  for (const s of ['queued', 'waiting', 'done', 'failed', 'interrupted', 'stopped']) { const e = estimateAgent(A({ state: s }), null); assertEta(e); assert.equal(e.kind, 'none'); }
  assert.equal(estimateAgent(A({ elapsedSec: NaN }), null).kind, 'none');
  assert.equal(estimateAgent(A({ elapsedSec: -1 }), null).kind, 'none');
});
test('warm-up and stale -> unknown with the right German label', () => {
  const w = estimateAgent(A({ elapsedSec: 5 }), null); assertEta(w); assert.equal(w.kind, 'unknown'); assert.equal(w.text, 'Dauer noch unbekannt'); assert.match(w.tip, /gerade erst gestartet/);
  const s = estimateAgent(A({ elapsedSec: 400, silentSec: 700 }), null); assertEta(s); assert.equal(s.kind, 'unknown'); assert.equal(s.text, 'keine Aktivität'); assert.match(s.tip, /Seit über 10 Min\./);
});
test('a workflow agent always gets a span: even a fresh install without any history estimates from the typical values', () => {
  const e = estimateAgent(A({ elapsedSec: 120 }), null); assertEta(e);
  assert.ok(e.kind === 'range' || e.kind === 'number'); assert.equal(e.basis, 'prior');
  assert.match(e.tip, /noch wenig eigener Verlauf/); assert.match(e.tip, /7 von 10/);
  assert.ok(e.lo < e.mid && e.mid < e.hi);
});
test('the label says "Fertig in ca. X–Y Min." and the span is wide when nothing is known', () => {
  const e = estimateAgent(A({ elapsedSec: 120 }), null);
  assert.match(e.text, /^Fertig in ca\. \d+–\d+ Min\.$/);
});
test('siblings: quick finished siblings -> a short span; slow ones -> a long one', () => {
  const quick = estimateAgent(A({ elapsedSec: 100, phaseSize: 10, siblingsDoneSec: [90, 95, 110, 120, 105], siblingsRunningSec: [100, 100, 100, 100] }), null); assertEta(quick);
  const slow = estimateAgent(A({ elapsedSec: 100, phaseSize: 10, siblingsDoneSec: [900, 950, 1100, 1200, 1050], siblingsRunningSec: [100, 100, 100, 100] }), null); assertEta(slow);
  assert.equal(quick.basis, 'siblings'); assert.equal(quick.n, 5);
  assert.match(quick.tip, /Basis: 5 fertige Geschwister dieser Phase; 4 Geschwister laufen noch;/);
  assert.ok(slow.mid > 4 * quick.mid, quick.text + ' vs ' + slow.text);
});
test('earlier phases of the same run count as evidence (basis "run") and the tooltip says so', () => {
  const e = estimateAgent(A({ elapsedSec: 600, phaseSize: 1, phasePos: 1, otherPhases: [{ size: 1, pos: 0, doneSec: [2400] }, { size: 2, pos: 0.5, doneSec: [700, 820] }] }), null); assertEta(e);
  assert.equal(e.basis, 'run'); assert.match(e.tip, /3 fertige Agenten früherer Phasen dieses Laufs/); assert.equal(e.n, 3);
});
test('history: enough records of the same shape move the estimate and the tooltip names agents and runs', () => {
  const quickHist = mkHist([{ runs: 12, per: 3, base: 60, np: 3, pos: 0.5 }]);   // 36 quick agents
  const slowHist = mkHist([{ runs: 12, per: 3, base: 3000, np: 3, pos: 0.5 }]);
  const q = estimateAgent(A({ elapsedSec: 40, phaseSize: 3 }), quickHist), s = estimateAgent(A({ elapsedSec: 40, phaseSize: 3 }), slowHist);
  assertEta(q); assertEta(s);
  assert.equal(q.basis, 'history'); assert.equal(q.runs, 12);
  assert.match(q.tip, /Verlauf: 36 Agenten aus 12 Läufen/);
  assert.ok(s.mid > 3 * q.mid, q.text + ' vs ' + s.text);
});
test('history rows without phase size (records of an older format) are ignored, not misread', () => {
  const old = { agents: Array.from({ length: 40 }, (_, i) => ({ kind: 'wf', prefix: 'x', phase: 'p', model: 'm', proj: 'p', run: 'r' + i, dur: 50 })), phaseDurSec: [] };
  const a = estimateAgent(A({ elapsedSec: 100 }), old), b = estimateAgent(A({ elapsedSec: 100 }), null);
  assertEta(a); assert.equal(a.basis, 'prior'); assert.deepEqual([a.lo, a.mid, a.hi], [b.lo, b.mid, b.hi]);
});
test('"länger als üblich" appears only for agents that outlast almost every comparable agent, and still gives a span', () => {
  const e = estimateAgent(A({ elapsedSec: 40000, phaseSize: 1 }), null); assertEta(e);
  assert.equal(e.kind, 'late'); assert.match(e.text, /^länger als üblich: (ca\. \d+–\d+ (Min|Std)\.|ca\. [\d,]+–[\d,]+ Std\.)/); assert.match(e.tip, /länger als etwa 9 von 10/);
  const normal = estimateAgent(A({ elapsedSec: 200, phaseSize: 3 }), null); assert.notEqual(normal.kind, 'late');
});
test('a narrow span becomes one number: "Fertig in ca. N Min."', () => {
  // five finished siblings of identical duration and a phase of five: the span is tight
  const e = estimateAgent(A({ elapsedSec: 290, phaseSize: 6, siblingsDoneSec: [300, 300, 300, 300, 300], siblingsRunningSec: [] }), null); assertEta(e);
  assert.ok(e.kind === 'number' || e.kind === 'range');
  if (e.kind === 'number') assert.match(e.text, /^Fertig in (ca\. \d+ Min\.|unter 1 Min\.)$/);
});
test('task agents (Agent tool): no estimate without history, a span with enough of it', () => {
  const t = (o) => Object.assign({ state: 'running', elapsedSec: 100, kind: 'task', label: 'Look around', agentType: 'Explore', project: 'p' }, o);
  const none = estimateAgent(t(), mkHist([{ kind: 'task', agentType: 'Explore', runs: 3, per: 1, base: 200 }])); assertEta(none);
  assert.equal(none.kind, 'unknown'); assert.equal(none.text, 'Dauer unbekannt'); assert.match(none.tip, /mindestens 8 fertige Subagenten/);
  const some = estimateAgent(t(), mkHist([{ kind: 'task', agentType: 'Explore', runs: 12, per: 1, base: 300 }])); assertEta(some);
  assert.ok(['range', 'number', 'late'].includes(some.kind)); assert.equal(some.basis, 'history'); assert.equal(some.n, 12);
  assert.match(some.tip, /Basis: 12 Agenten im Verlauf \(alle Subagenten ohne Workflow\)\./);
});
test('label retry suffix and project spelling do not change the estimate', () => {
  const h = mkHist([{ runs: 12, per: 3, base: 300, np: 1, pos: 0.5 }]);
  const a = estimateAgent(A({ label: 'verify:a (retry 2)', project: 'C--X-Y' }), h), b = estimateAgent(A({ label: 'Verify:a', project: 'c--x-y' }), h);
  assert.deepEqual(a, b);
});
test('estimates are deterministic (no flicker between two refreshes with the same input)', () => {
  const x = A({ elapsedSec: 333, phaseSize: 6, siblingsDoneSec: [100, 220, 540], siblingsRunningSec: [333, 333] });
  assert.deepEqual(estimateAgent(x, null), estimateAgent(x, null));
  const w = { elapsedSec: 900, phasesAhead: 1, phaseSize: 4, phasePos: 0, runningSec: [300, 280], siblingsDoneSec: [200], otherPhases: [] };
  assert.deepEqual(estimateWorkflow(w, null), estimateWorkflow(w, null));
});
test('garbage input never throws and yields a valid Eta', () => {
  const junk = [undefined, null, 0, 42, 'x', [], {}, { state: 'running' }, { state: 'running', elapsedSec: 'abc' }, { state: 'running', elapsedSec: -5 }, { state: 'running', elapsedSec: Infinity, kind: 'wf' },
    A({ siblingsDoneSec: 'nope' }), A({ siblingsDoneSec: [NaN, 'a', null, -3, undefined, {}] }), A({ siblingsRunningSec: [NaN, 'x'] }), A({ otherPhases: 'x' }), A({ otherPhases: [null, 3, { size: 'a', pos: {}, doneSec: 'q' }] }),
    A({ label: 42, project: {}, phase: [], model: 1 }), A({ kind: 'weird' }), A({ phaseSize: 'big', phasePos: NaN })];
  const hists = [undefined, null, 5, 'h', {}, { agents: 'x' }, { agents: [null, 3, {}] }, { agents: [{ kind: 'wf' }, { kind: 'wf', dur: 5, np: 'x' }] }, { agents: [], phaseDurSec: 'x' }];
  for (const j of junk) for (const h of hists) { const e = estimateAgent(j, h); assert.ok(e && typeof e.text === 'string' && typeof e.tip === 'string'); }
  assertEta(estimateAgent(A({ siblingsDoneSec: [NaN, 'a', null, -3, undefined, {}] }), null));
});
test('pure: input and history are not modified', () => {
  const h = mkHist([{ runs: 12, per: 3, base: 300, np: 3, pos: 0.5 }]); const a = A({ siblingsDoneSec: [300, 320, 340], label: 'verify (retry 1)', project: 'P', otherPhases: [{ size: 2, pos: 0, doneSec: [10, 20] }] });
  const s = JSON.stringify([a, h]); estimateAgent(a, h); assert.equal(JSON.stringify([a, h]), s);
});
test('sweep over elapsed time, phase shapes and evidence keeps the Eta contract: German, no seconds, never a zero span', () => {
  const hists = [null, mkHist([{ runs: 12, per: 3, base: 300, np: 3, pos: 0.5 }]), mkHist([{ runs: 12, per: 8, base: 40, np: 8, pos: 1 }])];
  const shapes = [{ phaseSize: 1, phasePos: 0 }, { phaseSize: 4, phasePos: 0.5 }, { phaseSize: 30, phasePos: 1 }];
  const sibs = [[[], []], [[50], []], [[100, 110], [90, 90]], [[900, 1000, 1100], []], [[], [200, 200, 200]]];
  const seen = new Set();
  for (const h of hists) for (const sh of shapes) for (const [done, run] of sibs) for (const e of [0, 10, 15, 30, 45, 60, 99, 150, 400, 900, 2000, 5000, 20000, 100000]) for (const silentSec of [0, 700]) {
    const r = estimateAgent(A(Object.assign({ elapsedSec: e, silentSec, siblingsDoneSec: done, siblingsRunningSec: run }, sh)), h); assertEta(r, JSON.stringify({ e, sh, done, run, silentSec }));
    seen.add(r.kind);
    if (['range', 'number', 'late'].includes(r.kind)) assert.ok(r.lo > 0 && r.mid > 0 && r.hi > 0 && r.hi >= r.lo);
    if (r.kind === 'number') assert.doesNotMatch(r.text, /~0 Min|ca\. 0 Min/);
  }
  for (const want of ['number', 'range', 'late', 'unknown']) assert.ok(seen.has(want), 'branch not exercised: ' + want);
});

// ---- estimateWorkflow ---------------------------------------------------------------------------------------------------------

const W = (o) => Object.assign({ elapsedSec: 300, phasesAhead: 0, phaseSize: 1, phasePos: 0, runningSec: [], siblingsDoneSec: [], otherPhases: [] }, o);

test('workflow: one running agent -> "Fertig in ca. X–Y Min."; basis phases; seconds in lo/mid/hi', () => {
  const e = estimateWorkflow(W({ runningSec: [300] }), null); assertEta(e);
  assert.equal(e.basis, 'phases'); assert.ok(e.kind === 'range' || e.kind === 'number'); assert.match(e.text, /^Fertig in /);
  assert.match(e.tip, /Schätzung für den ganzen Workflow/); assert.match(e.tip, /6 von 10/);
});
test('workflow: phases that have not started yet add their typical duration', () => {
  const now = estimateWorkflow(W({ runningSec: [300] }), null), later = estimateWorkflow(W({ runningSec: [300], phasesAhead: 2 }), null);
  assertEta(later); assert.ok(later.mid > now.mid + 600, now.text + ' vs ' + later.text); assert.match(later.tip, /plus 2 Phasen, die noch nicht begonnen haben/);
  const one = estimateWorkflow(W({ runningSec: [300], phasesAhead: 1 }), null); assert.match(one.tip, /plus 1 Phase, die noch nicht begonnen hat/);
});
test('workflow: nothing running and nothing ahead -> no chip; nothing running but a phase ahead -> its typical duration', () => {
  assert.equal(estimateWorkflow(W({}), null).kind, 'none');
  const e = estimateWorkflow(W({ phasesAhead: 1 }), null); assertEta(e); assert.ok(e.mid > 120); assert.match(e.tip, /Wartezeit bis zur nächsten Phase/);
});
test('workflow: the long-running last agent of the user screenshot (26 min, single agent in the last phase) is not "bis ~3 Min."', () => {
  const others = [{ size: 1, pos: 0, doneSec: [2400] }, { size: 2, pos: 0.33, doneSec: [700, 820] }, { size: 1, pos: 0.67, doneSec: [900] }];
  const e = estimateWorkflow(W({ elapsedSec: 7596, phaseSize: 1, phasePos: 1, runningSec: [1568], otherPhases: others }), null); assertEta(e);
  assert.ok(e.hi > 1500, 'the upper end allows for a long wait: ' + e.text); assert.doesNotMatch(e.text, /unter [1-4] Min|ca\. 1–[1-4] Min/);
  const a = estimateAgent({ state: 'running', elapsedSec: 1568, kind: 'wf', label: 'gatekeeper', phase: 'Gate', phaseSize: 1, phasePos: 1, siblingsDoneSec: [], siblingsRunningSec: [], otherPhases: others }, null);
  assertEta(a); assert.ok(a.hi > 1500, a.text);
});
test('workflow: "länger als üblich" when the longest-running agent outlasts almost all comparable ones', () => {
  const e = estimateWorkflow(W({ runningSec: [50000] }), null); assertEta(e); assert.equal(e.kind, 'late'); assert.match(e.tip, /Mindestens ein Agent läuft schon länger/);
});
test('workflow: warm-up and the old v0.9.4 field names', () => {
  const w = estimateWorkflow(W({ runningSec: [4] }), null); assertEta(w); assert.equal(w.kind, 'unknown'); assert.equal(w.text, 'Dauer noch unbekannt');
  const legacy = estimateWorkflow({ elapsedSec: 400, phasesAhead: 0, currentPhaseElapsedSecs: [300], currentPhaseSiblingsDoneSec: [] }, null), now = estimateWorkflow(W({ runningSec: [300] }), null);
  assert.deepEqual([legacy.lo, legacy.mid, legacy.hi], [now.lo, now.mid, now.hi]);
});
test('workflow: history phase durations are used for phases that have not started only with >= 20 samples', () => {
  const input = W({ runningSec: [100], phasesAhead: 1 });
  const few = estimateWorkflow(input, { agents: [], phaseDurSec: new Array(5).fill(3000) }), many = estimateWorkflow(input, { agents: [], phaseDurSec: new Array(25).fill(3000) });
  assertEta(few); assertEta(many); assert.ok(many.mid > 2 * few.mid, few.text + ' vs ' + many.text);
});
test('workflow: garbage input never throws; the Eta contract holds over a sweep', () => {
  for (const j of [undefined, null, 5, 'x', [], {}, W({ siblingsDoneSec: 'x', runningSec: [NaN, 'a'], otherPhases: [null, 1, {}], phasesAhead: 'many', elapsedSec: 'x' })])
    for (const h of [undefined, null, 3, {}, { phaseDurSec: 'x' }]) { const e = estimateWorkflow(j, h); assert.ok(e && typeof e.text === 'string' && typeof e.tip === 'string'); }
  for (const ahead of [0, 1, 2, 3, 30]) for (const done of [[], [30], [200, 260], [3000, 4000]]) for (const run of [[], [10], [100, 400], [60, 70, 80], Array(30).fill(500)]) for (const size of [1, 5, 40]) {
    const e = estimateWorkflow(W({ phasesAhead: ahead, siblingsDoneSec: done, runningSec: run, phaseSize: size }), { agents: [], phaseDurSec: new Array(30).fill(400) });
    assertEta(e, JSON.stringify({ ahead, done, run, size }));
    if (['range', 'number', 'late'].includes(e.kind)) assert.ok(e.lo > 0 && e.hi >= e.lo);
  }
});
