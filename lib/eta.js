'use strict';
// Remaining-time estimates (SPEC 6). Pure functions: no I/O, no clock, seconds everywhere.
//
// Layout of this file
//   1. DEFAULTS + the tested core (copied from the research phase `estimate.js`, estimation logic unchanged).
//   2. Adapters estimateAgent / estimateWorkflow: sanitise the input, call the core, return the Eta object of
//      SPEC 2 with German `text` and `tip` (seconds are never shown; rounding per SPEC 6.2).
//
// Eta.lo / mid / hi are SECONDS of remaining time (the module's unit; the typedef in SPEC 2 does not say).
// They are null for kinds without a number (late except for the sibling case, unknown, none).

const DEFAULTS = Object.freeze({
  minElapsed: 15,          // s   below this the agent is still warming up (first answer after median 1.8 s, p90 4.1 s; cache build can take 13 s)
  sibMinDone: 2,           // >= 2 finished same-phase siblings before sibling information is used
  numberSpreadAbs: 45,     // s   survivors "agree" if max-min <= max(45 s, 0.5 * mid) ...
  numberSpreadRel: 0.5,    //     ... only then a single number is shown
  rangeFactor: 2,          // range = [mid/2, 2*mid] when siblings disagree / only 1 survivor (covers 58% out-of-run)
  exceededLo: 30,          // s   agent already longer than ALL finished siblings: true remaining p25 = 30 s ...
  exceededHi: 210,         // s   ... p75 = 210 s (leave-one-run-out coverage 49%, median 78 s)
  keyOrder: Object.freeze(['project_prefix']), // key-specific history = same project (cwd) + same label prefix; the only key whose out-of-run MdAE was clearly lower (112-116 s vs 180-206 s)
  keyMinAgents: 15,        // key-specific history needs >= 15 agents ...
  keyMinRuns: 8,           //     ... from >= 8 DISTINCT workflow runs (below that its intervals are over-confident: 25-32% instead of 50%)
  minHistAgents: 30,       // global history needs >= 30 finished agents ...
  minHistRuns: 8,          //     ... from >= 8 distinct runs
  minSurvivors: 5,         // conditional remaining needs >= 5 history agents that ran longer than `elapsed`
  lateQuantile: 0.9,       // elapsed > p90 of the relevant duration distribution => "longer than usual"
  staleSilenceSec: 600,    // no new record in the agent file for 10 min => 'stale' (only 3 of 684 agents ever had such a gap)
  // workflow level (SPEC 6.3)
  wfFactor: 2,             // range = [c/2, 2c]
  wfMinSec: 30,            // no estimate for a remainder below 30 s
  wfMinHistPhases: 20,     // history phase durations are used only with >= 20 samples
  wfMaxAhead: 1,           // with >= 2 phases still ahead the range is unreliable -> unknown (estimateWorkflow only)
});

const quantile = (arr, p) => {
  if (!arr.length) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const median = a => quantile(a, 0.5);
// Only strings and finite numbers are turned into text: String(object) runs the toString of a parsed file and may throw.
const txt = v => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const fold = s => txt(s).toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
const TEXT_MAX = 300;   // history.js cuts every stored string at 300 on load; cutting at write time keeps keys equal across a restart
// Trailing digits are cut with a loop: /\d+$/ is quadratic on a long digit run that does not end the string.
const labelPrefix = l => {
  const p = fold(txt(l).split(':')[0]).trim();
  let end = p.length;
  while (end > 0 && p.charCodeAt(end - 1) >= 48 && p.charCodeAt(end - 1) <= 57) end--;
  return p.slice(0, Math.min(end, TEXT_MAX));
};
// the result file labels a retried slot "name (retry 2)". No leading \s* in the pattern: it makes the search quadratic on whitespace.
const RETRY_TAIL = /\(retry \d+\)\s*$/i;
const stripRetry = l => { const t = txt(l), m = RETRY_TAIL.exec(t); return m ? t.slice(0, m.index).trimEnd() : t; };
const cut = v => fold(v).slice(0, TEXT_MAX);

// Project key shared by history records and estimate inputs: lower-case encoded project directory name
// (drive-letter case differs between VS Code `c--...` and Desktop `C--...`). A raw cwd or a path to the
// project directory is accepted too and reduced to the same key.
function projectKey(p) {
  const s = txt(p).trim();
  if (!s) return '';
  if (!/[\\/:]/.test(s)) return s.toLowerCase();
  const m = /[\\/]projects[\\/]([^\\/]+)/i.exec(s);
  if (m) return m[1].toLowerCase();
  return s.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
}

// compact record to persist for every FINISHED, SUCCESSFUL agent
function makeRecord(a) {
  const str = v => txt(v).slice(0, TEXT_MAX);
  return { kind: a.kind, prefix: a.kind === 'wf' ? labelPrefix(a.label) : cut(a.agentType || a.label), phase: cut(a.phase), model: str(a.model), proj: str(a.project), run: str(a.runId) || ('s:' + str(a.sessionId)), dur: Math.round(a.durationSec * 10) / 10 };
}

const _idx = new WeakMap();
function indexOf(history) {
  const src = history && history.agents ? history.agents : [];
  const cached = _idx.get(history);
  if (cached && cached.len === src.length) return cached;
  const groups = { kind: new Map(), prefix: new Map(), prefix_model: new Map(), project_prefix: new Map() };
  const add = (m, k, h) => { let g = m.get(k); if (!g) { g = { durs: [], runs: new Set() }; m.set(k, g); } g.durs.push(h.dur); g.runs.add(h.run); };
  for (const h of src) {
    add(groups.kind, h.kind, h);
    add(groups.prefix, h.kind + '|' + h.prefix, h);
    add(groups.prefix_model, h.kind + '|' + h.prefix + '|' + h.model, h);
    add(groups.project_prefix, h.kind + '|' + (h.proj || '') + '|' + h.prefix, h);
  }
  const idx = { len: src.length, groups };
  _idx.set(history, idx);
  return idx;
}

// agent = { state?, elapsedSec, silentSec?, kind: 'wf'|'task', label?, phase?, model?, project?, runId?, agentType?, siblingsDoneSec? }
// history = { agents: [ {kind, prefix, phase, model, proj, run, dur} ... ], phaseDurSec: number[] }
// result = { kind, basis, lo, mid, hi, n, runs, reason, typical?, p90? }   (seconds)
function estimateRemaining(agent, history, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const e = agent.elapsedSec;
  if (!(e >= 0) || (agent.state && agent.state !== 'running')) return { kind: 'none', basis: 'none', reason: 'not-running' };
  if (agent.silentSec > o.staleSilenceSec) return { kind: 'unknown', basis: 'none', reason: 'stale' };
  if (e < o.minElapsed) return { kind: 'unknown', basis: 'none', reason: 'warmup' };

  // 1) same-run, same-phase siblings that already finished (the only signal that beat the baseline out-of-run)
  const sib = agent.siblingsDoneSec || [];
  if (sib.length >= o.sibMinDone) {
    const R = sib.filter(d => d > e).map(d => d - e);
    if (R.length >= 1) {
      const mid = median(R), lo = Math.min.apply(null, R), hi = Math.max.apply(null, R);
      const agree = R.length >= 2 && (hi - lo) <= Math.max(o.numberSpreadAbs, o.numberSpreadRel * mid);
      if (agree) return { kind: 'number', basis: 'siblings', lo, mid, hi, n: sib.length };
      return { kind: 'range', basis: 'siblings', lo: mid / o.rangeFactor, mid, hi: mid * o.rangeFactor, n: sib.length };
    }
    // already longer than every finished sibling: finished siblings are biased short, so "median - elapsed" would be 0 -> do not show 0
    return { kind: 'late', basis: 'siblings', lo: o.exceededLo, mid: null, hi: o.exceededHi, n: sib.length, reason: 'longer-than-finished-siblings' };
  }

  // 2) history: key-specific only if it spans enough distinct runs, otherwise the global pool of the same kind
  const idx = indexOf(history || { agents: [] });
  const pre = agent.kind === 'wf' ? fold(labelPrefix(agent.label)) : cut(agent.agentType || agent.label);
  let g = null, basis = null;
  const allKeys = { project_prefix: agent.kind + '|' + (agent.project || '') + '|' + pre, prefix_model: agent.kind + '|' + pre + '|' + (agent.model || ''), prefix: agent.kind + '|' + pre };
  const kinds = o.keyOrder.map(n => [n, allKeys[n]]);
  for (const [name, key] of kinds) {
    const c = idx.groups[name].get(key);
    if (c && c.durs.length >= o.keyMinAgents && c.runs.size >= o.keyMinRuns) { g = c; basis = 'key'; break; }
  }
  if (!g) {
    const c = idx.groups.kind.get(agent.kind);
    if (c && c.durs.length >= o.minHistAgents && c.runs.size >= o.minHistRuns) { g = c; basis = 'global'; }
  }
  if (!g) return { kind: 'unknown', basis: 'none', reason: 'thin-history', n: 0 };

  const R = g.durs.filter(d => d > e).map(d => d - e);
  const p90 = quantile(g.durs, o.lateQuantile);
  const cond = R.length >= o.minSurvivors ? { lo: quantile(R, 0.25), mid: quantile(R, 0.5), hi: quantile(R, 0.75) } : null;
  // beyond p90 only 'longer than usual' is defensible: ranges there were mis-calibrated (30% coverage for key samples) and the true remaining is a median 7-9 min
  if (e > p90 || !cond) return { kind: 'late', basis, lo: null, mid: null, hi: null, n: g.durs.length, runs: g.runs.size, reason: 'longer-than-usual', p90 };
  // The global pool's conditional remaining is flat (~median 4.5 min whatever the elapsed time) -> it is a prior, not an estimate
  if (basis === 'global') return { kind: 'unknown', basis, reason: 'prior-only', n: g.durs.length, runs: g.runs.size, typical: cond, p90 };
  return { kind: 'range', basis, lo: cond.lo, mid: cond.mid, hi: cond.hi, n: g.durs.length, runs: g.runs.size, p90 };
}

// ---- whole workflow: current phase (finished siblings) + phases ahead * typical phase duration -> ALWAYS a coarse range ----
// run = { phasesDeclared: n,                       // length of meta.phases in the workflow script
//         phases: [ { startedSec, elapsedSec,      // seconds since workflow start / since this phase's first agent
//                     finished: bool, durSec?,     // finished phases: first start -> last end
//                     doneDurSec: number[],        // finished agents of this phase
//                     runningElapsedSec: number[]  // running agents of this phase
//                   } ] }                          // only phases that already started
// history.phaseDurSec = number[] (durations of finished phases of earlier runs; fallback when this run has no finished phase yet)
function estimateWorkflowRemaining(run, history, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const phases = run.phases || [];
  const nAhead = Math.max(0, (run.phasesDeclared || phases.length) - phases.length);
  const finished = phases.filter(p => p.finished && isFinite(p.durSec)).map(p => p.durSec);
  const hist = (history && history.phaseDurSec) || [];
  const pm = finished.length ? median(finished) : (hist.length >= o.wfMinHistPhases ? median(hist) : null);
  let cp = 0;
  for (const p of phases.filter(p => !p.finished)) {
    let est;
    if ((p.doneDurSec || []).length >= 1 && (p.runningElapsedSec || []).length >= 1) {
      const m = median(p.doneDurSec);
      const rem = Math.max.apply(null, p.runningElapsedSec.map(x => m - x));
      est = rem > 0 ? rem : 0.5 * m;                    // finished siblings are biased short: never say 0
    } else if (pm !== null) {
      est = (pm - p.elapsedSec) > 0 ? pm - p.elapsedSec : 0.5 * pm;
    } else return { kind: 'unknown', basis: 'none', reason: 'thin-history' };
    cp = Math.max(cp, est);
  }
  if (nAhead > 0 && pm === null) return { kind: 'unknown', basis: 'none', reason: 'thin-history' };
  const c = cp + nAhead * (pm || 0);
  if (!(c >= o.wfMinSec)) return { kind: 'unknown', basis: 'phases', reason: 'too-small' };
  return { kind: 'range', basis: 'phases', lo: c / o.wfFactor, mid: c, hi: c * o.wfFactor, nAhead };
}

// ---- German display strings (rounding = honesty: seconds are never shown, error is ~30 s even in the best regime) ----
function fmtMin(sec) {
  if (!isFinite(sec)) return '';
  if (sec < 45) return '< 1';
  const m = sec / 60;
  if (m < 10) return String(Math.max(1, Math.round(m)));
  return String(Math.round(m / 5) * 5);
}
function fmtRange(lo, hi) {
  const a = fmtMin(lo), b = fmtMin(hi);
  if (a === '' || b === '') return '';
  if (a === '< 1' && b === '< 1') return 'unter 1 Min.';
  if (a === b) return '~' + a + ' Min.';
  return a === '< 1' ? 'bis ~' + b + ' Min.' : a + '–' + b + ' Min.';
}
function formatEstimate(r) {
  switch (r.kind) {
    case 'number': { const t = fmtMin(r.mid); return t === '< 1' ? 'unter 1 Min.' : '~' + t + ' Min.'; }
    case 'range': return fmtRange(r.lo, r.hi);
    case 'late': return r.reason === 'longer-than-finished-siblings' ? 'länger als die anderen (meist < ' + fmtMin(r.hi) + ' Min. mehr)' : 'länger als üblich';
    case 'unknown': return r.reason === 'stale' ? 'keine Aktivität' : 'unbekannt';
    default: return '';
  }
}

// ---- tooltips (German; always name the basis and the sample size, never seconds) ----
const agentsFromRuns = (n, runs) => n + ' ' + (n === 1 ? 'Agent' : 'Agenten') + ' aus ' + runs + ' ' + (runs === 1 ? 'Lauf' : 'Läufen');

function basisLine(r, kind) {
  if (r.basis === 'siblings') return 'Basis: ' + r.n + ' ' + (r.n === 1 ? 'fertiges Geschwister' : 'fertige Geschwister') + ' (gleiche Phase, gleicher Lauf).';
  if (r.basis === 'key') return 'Basis: ' + agentsFromRuns(r.n, r.runs) + ' (gleiches Projekt, ' + (kind === 'task' ? 'gleicher Agententyp' : 'gleicher Namensanfang') + ').';
  if (r.basis === 'global') return 'Basis: ' + agentsFromRuns(r.n, r.runs) + ' (alle ' + (kind === 'task' ? 'Subagenten' : 'Workflow-Agenten') + ').';
  return '';
}

function agentTip(r, kind) {
  const D = DEFAULTS, basis = basisLine(r, kind);
  switch (r.kind) {
    case 'number': return 'Näherungswert: Die fertigen Geschwister haben ähnlich lange gebraucht. Typische Abweichung etwa 1 Min. ' + basis;
    case 'range': return 'Grobe Schätzung, die Spanne ist bewusst breit. ' + basis;
    case 'late':
      if (r.reason === 'longer-than-finished-siblings') return 'Läuft schon länger als alle fertigen Geschwister. Meist kommen noch weniger als ' + fmtMin(r.hi) + ' Min. dazu, verlässlich ist das aber nicht. ' + basis;
      return 'Läuft länger als fast alle vergleichbaren Agenten. Eine Restzeit lässt sich dafür nicht seriös schätzen. ' + basis;
    case 'unknown':
      if (r.reason === 'stale') return 'Seit über ' + Math.round(D.staleSilenceSec / 60) + ' Min. wurde nichts mehr in die Agentendatei geschrieben. Das kann eine lange Denkpause sein, ist aber kein Beweis, dass der Agent noch arbeitet. Keine Schätzung möglich.';
      if (r.reason === 'warmup') return 'Der Agent ist gerade erst gestartet. Eine Schätzung folgt, sobald er etwas länger läuft.';
      if (r.reason === 'prior-only') return 'Keine belastbare Restzeit, nur ein Erfahrungswert: Vergleichbare Agenten brauchten zu diesem Zeitpunkt meist noch ' + fmtRange(r.typical.lo, r.typical.hi).replace(/^~/, '') + ' ' + basis;
      return 'Noch zu wenig Vergleichswerte: weniger als ' + D.sibMinDone + ' fertige Geschwister in dieser Phase und weniger als ' + D.minHistAgents + ' fertige ' + (kind === 'task' ? 'Subagenten' : 'Agenten') + ' aus ' + D.minHistRuns + ' Läufen im Verlauf. Das ist normal, solange die Erfahrung fehlt.';
    default: return '';
  }
}

const NUMS = ['lo', 'mid', 'hi'];
function toEta(r, text, tip) {
  const eta = { kind: r.kind, basis: r.basis || 'none', lo: null, mid: null, hi: null, text, tip };
  for (const k of NUMS) if (Number.isFinite(r[k])) eta[k] = r[k];
  if (Number.isFinite(r.n) && r.n > 0) eta.n = r.n;
  if (Number.isFinite(r.runs) && r.runs > 0) eta.runs = r.runs;
  return eta;
}
const noneEta = () => ({ kind: 'none', basis: 'none', lo: null, mid: null, hi: null, text: '', tip: '' });
const finiteList = v => (Array.isArray(v) ? v.filter(x => typeof x === 'number' && isFinite(x) && x >= 0) : []);
const EMPTY_HIST = Object.freeze({ agents: Object.freeze([]), phaseDurSec: Object.freeze([]) });

/** EtaInput (SPEC 6.1) + HistorySnapshot (History.snapshot()) -> Eta (SPEC 2). Never throws. */
function estimateAgent(input, hist) {
  try {
    if (!input || typeof input !== 'object') return noneEta();
    // history records carry the model without the 1M-context flag; the live id may have it
    const a = Object.assign({}, input, { label: stripRetry(input.label), project: projectKey(input.project), model: typeof input.model === 'string' ? input.model.replace(/\[1m\]$/i, '') : input.model, siblingsDoneSec: finiteList(input.siblingsDoneSec) });
    const h = hist && Array.isArray(hist.agents) ? hist : EMPTY_HIST;
    const r = estimateRemaining(a, h, null);
    if (r.kind === 'none') return noneEta();
    return toEta(r, formatEstimate(r), agentTip(r, a.kind));
  } catch (e) {
    return noneEta();
  }
}

/**
 * Workflow-level remaining time (SPEC 6.3): always a coarse range or "unbekannt".
 * input = { elapsedSec, phasesAhead, currentPhaseSiblingsDoneSec, currentPhaseElapsedSecs, runPhaseDurSec }
 *   currentPhaseSiblingsDoneSec: durations of finished agents of the phase that is running now
 *   currentPhaseElapsedSecs:     elapsed seconds of the agents of that phase that are still running
 *   runPhaseDurSec:              durations of the phases of this run that are already finished
 *   phasesAhead:                 phases not started yet
 */
function estimateWorkflow(input, hist) {
  try {
    if (!input || typeof input !== 'object') return noneEta();
    const done = finiteList(input.currentPhaseSiblingsDoneSec);
    const running = finiteList(input.currentPhaseElapsedSecs);
    const fin = finiteList(input.runPhaseDurSec);
    const ahead = Number.isFinite(input.phasesAhead) && input.phasesAhead > 0 ? Math.floor(input.phasesAhead) : 0;
    const wfElapsed = Number.isFinite(input.elapsedSec) && input.elapsedSec > 0 ? input.elapsedSec : 0;
    const phases = fin.map(d => ({ finished: true, durSec: d, elapsedSec: d, doneDurSec: [], runningElapsedSec: [] }));
    if (done.length || running.length) {
      // phase elapsed: running agents of a phase without finished siblings all started with the phase; otherwise derive it from the run clock
      const sumFin = fin.reduce((s, d) => s + d, 0);
      const elapsed = running.length ? Math.max.apply(null, running) : Math.max(0, wfElapsed - sumFin);
      phases.push({ finished: false, elapsedSec: elapsed, doneDurSec: done, runningElapsedSec: running });
    }
    const h = hist && Array.isArray(hist.phaseDurSec) ? hist : EMPTY_HIST;
    let r = estimateWorkflowRemaining({ phasesDeclared: phases.length + ahead, phases }, h, null);
    // SPEC 6.3: with >= 2 phases ahead the range is unreliable (hit rate 60 % only up to one phase ahead)
    if (r.kind === 'range' && r.nAhead > DEFAULTS.wfMaxAhead) r = { kind: 'unknown', basis: 'phases', reason: 'too-many-phases-ahead' };
    if (r.kind === 'range') {
      return toEta(r, 'Rest grob: ' + fmtRange(r.lo, r.hi), workflowTip(r));
    }
    return toEta(r, 'Rest unbekannt', workflowTip(r));
  } catch (e) {
    return noneEta();
  }
}

function workflowTip(r) {
  if (r.kind === 'range') {
    const ahead = r.nAhead > 0 ? ' plus ' + r.nAhead + ' weitere Phase in typischer Länge' : '';
    return 'Grobe Schätzung. Basis: restliche Zeit der aktuellen Phase (aus fertigen Geschwistern oder typischer Phasendauer)' + ahead + '. Trefferquote nur etwa 60 %; verlässlich ist vor allem der Fortschritt in Phasen und Agenten.';
  }
  switch (r.reason) {
    case 'too-small': return 'Der Rest ist voraussichtlich sehr kurz (unter einer halben Minute); dafür gibt es keine sinnvolle Angabe.';
    case 'too-many-phases-ahead': return 'Mehrere Phasen stehen noch aus. Dafür ist keine verlässliche Schätzung möglich.';
    default: return 'Noch keine fertige Phase in diesem Lauf und zu wenig Verlauf (mindestens ' + DEFAULTS.wfMinHistPhases + ' Phasen früherer Läufe nötig).';
  }
}

module.exports = {
  // contract
  DEFAULTS, estimateAgent, estimateWorkflow,
  // core + helpers (history.js and the tests use these)
  estimateRemaining, estimateWorkflowRemaining, formatEstimate, makeRecord, labelPrefix, stripRetry, projectKey, fold, quantile, median, fmtMin, fmtRange,
};
