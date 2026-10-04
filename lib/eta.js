'use strict';
// Remaining-time estimates (SPEC 6). Pure functions: no I/O, no clock, seconds everywhere.
//
//   lib/etaModel.js  the statistics (hierarchical log-normal model, see there)
//   lib/eta.js       this file: sanitises the input, calls the model, returns the Eta object of SPEC 2 with German text and tooltip
//
// Eta.lo / mid / hi are SECONDS of remaining time: the 20th, 50th and 85th percentile of the model's predictive distribution. The
// text names the span lo..hi ("Fertig in ca. 3-25 Min."), so an agent that is still running after the upper end is the exception
// (measured: about 1 in 10 of the time an agent is on screen). Seconds are never shown.

const M = require('./etaModel');

const DEFAULTS = Object.freeze({
  minElapsed: 15,          // s   below this the agent is still warming up (first answer after median 1.8 s, p90 4.1 s; cache build can take 13 s)
  staleSilenceSec: 600,    // no new record in the agent file for 10 min => 'stale' (only 3 of 684 agents ever had such a gap)
  loQ: 0.2, midQ: 0.5, hiQ: 0.85,   // the shown span and the middle (agent)
  wfHiQ: 0.9,              // upper end for a whole workflow: the slowest of several agents is the heavy tail, so it gets more room
  lateSurvive: 0.1,        // below this probability an agent that lasts as long as this one counts as "longer than usual"
  numberRatio: 1.6,        // hi/lo below this: one number instead of a span
  numberSpreadSec: 60,     // ... or a span narrower than this
  taskMinRecords: 8,       // Agent-tool subagents have no phases or siblings: their own history needs this many finished agents ...
  taskMinRuns: 3,          // ... from at least this many sessions (agents of one session are alike: the sample size is the number of sessions)
  taskMinSd: 0.9,          // and never claims to know better than this spread of ln(duration)
  phaseMinSamples: 20,     // history phase durations are used for phases that have not started only with this many samples
  phaseSdMin: 0.6, phaseSdMax: 1.0,
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

const clampInt = (v, lo, hi, dflt) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt);
const clamp01 = v => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

// compact record to persist for every FINISHED, SUCCESSFUL agent. np = agents of its phase, pos = position of the phase in the run
// (0 first .. 1 last): the two things the duration depends on besides the run itself.
function makeRecord(a) {
  const str = v => txt(v).slice(0, TEXT_MAX);
  return {
    kind: a.kind, prefix: a.kind === 'wf' ? labelPrefix(a.label) : cut(a.agentType || a.label), phase: cut(a.phase), model: str(a.model), proj: str(a.project),
    run: str(a.runId) || ('s:' + str(a.sessionId)), dur: Math.round(a.durationSec * 10) / 10,
    np: clampInt(a.phaseSize, 1, 500, 1), pos: Math.round(clamp01(a.phasePos) * 100) / 100,
  };
}

// ---- per history snapshot: regression rows, fitted coefficients, phase statistics, task statistics -----------------------------
const _idx = new WeakMap();
function indexOf(history) {
  const src = history && Array.isArray(history.agents) ? history.agents : [];
  const phases = history && Array.isArray(history.phaseDurSec) ? history.phaseDurSec : [];
  const cached = _idx.get(history);
  if (cached && cached.len === src.length && cached.plen === phases.length) return cached;
  const rows = [], taskLn = [], runs = new Set(), taskRuns = new Set();
  for (const h of src) {
    if (!h || typeof h !== 'object' || !(h.dur > 0) || !Number.isFinite(h.dur)) continue;
    if (h.kind === 'wf' && Number.isFinite(h.np) && h.np >= 1) { rows.push({ ln: Math.log(Math.max(1, h.dur)), np: h.np, pos: clamp01(h.pos) }); runs.add(txt(h.run)); }
    else if (h.kind === 'task') { taskLn.push(Math.log(Math.max(1, h.dur))); taskRuns.add(txt(h.run)); }
  }
  const beta = M.fitBeta(rows, M.PARAMS);
  let phase = null;
  const pl = phases.filter(d => typeof d === 'number' && isFinite(d) && d > 0).map(d => Math.log(Math.max(5, d)));
  if (pl.length >= DEFAULTS.phaseMinSamples) {
    const m = pl.reduce((s, v) => s + v, 0) / pl.length;
    const sd = Math.sqrt(pl.reduce((s, v) => s + (v - m) * (v - m), 0) / (pl.length - 1));
    phase = { phaseMean: m, phaseSd: Math.min(DEFAULTS.phaseSdMax, Math.max(DEFAULTS.phaseSdMin, sd)) };
  }
  let task = null;
  if (taskLn.length >= DEFAULTS.taskMinRecords && taskRuns.size >= DEFAULTS.taskMinRuns) {
    const m = taskLn.reduce((s, v) => s + v, 0) / taskLn.length;
    const sd = Math.sqrt(taskLn.reduce((s, v) => s + (v - m) * (v - m), 0) / (taskLn.length - 1));
    task = { mean: m, sd: Math.max(DEFAULTS.taskMinSd, sd), n: taskLn.length };
  }
  const idx = { len: src.length, plen: phases.length, rows: rows.length, runs: runs.size, beta, phase, task };
  _idx.set(history, idx);
  return idx;
}

// ---- German display strings (rounding = honesty: seconds are never shown; the span is rounded outward) ----------------------------
const stepFor = m => (m < 10 ? 1 : m < 30 ? 5 : m < 90 ? 10 : 30);
const down = m => { const s = stepFor(m); return Math.floor(m / s) * s; };
const up = m => { const s = stepFor(m); return Math.ceil(m / s) * s; };
const hours = m => { const h = m / 60; return (Number.isInteger(h) ? String(h) : h.toFixed(1)).replace('.', ','); };

/** "ca. 3–25 Min." / "unter 12 Min." / "unter 1 Min." / "ca. 1,5–3 Std."; '' for garbage. lo, hi in seconds. */
function formatSpan(lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi < 0) return '';
  const l = down(Math.min(lo, hi) / 60), h = up(Math.max(lo, hi) / 60);
  if (h <= 1) return 'unter 1 Min.';
  if (l >= 60) {   // hours only when even the lower end is an hour or more: "ca. 0–2 Std." would be nonsense
    const lh = Math.floor(l / 30) * 30, hh = Math.ceil(h / 30) * 30;
    return lh === hh ? 'ca. ' + hours(lh) + ' Std.' : 'ca. ' + hours(lh) + '–' + hours(hh) + ' Std.';
  }
  if (l < 1) return 'unter ' + h + ' Min.';
  return l === h ? 'ca. ' + l + ' Min.' : 'ca. ' + l + '–' + h + ' Min.';
}
/** One number: "ca. 6 Min." (rounded to the nearest step), "unter 1 Min." below one minute. */
function formatOne(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  const m = sec / 60;
  if (m < 0.75) return 'unter 1 Min.';
  const s = stepFor(m), r = Math.round(m / s) * s;
  if (r >= 60) return 'ca. ' + hours(Math.round(r / 30) * 30) + ' Std.';
  return 'ca. ' + Math.max(1, r) + ' Min.';
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
const unknownEta = (text, tip, basis) => ({ kind: 'unknown', basis: basis || 'none', lo: null, mid: null, hi: null, text, tip });
const finiteList = v => (Array.isArray(v) ? v.filter(x => typeof x === 'number' && isFinite(x) && x >= 0) : []);

// kind of a finished estimate: late (unusually long already) > number (narrow) > range
function kindOf(lo, mid, hi, survive) {
  if (survive < DEFAULTS.lateSurvive) return 'late';
  return hi / Math.max(1, lo) <= DEFAULTS.numberRatio || hi - lo <= DEFAULTS.numberSpreadSec ? 'number' : 'range';
}
function textOf(kind, lo, mid, hi) {
  if (kind === 'late') return 'länger als üblich: ' + formatSpan(lo, hi);
  if (kind === 'number') return 'Fertig in ' + formatOne(mid);
  return 'Fertig in ' + formatSpan(lo, hi);
}

const agentsWord = n => n + ' ' + (n === 1 ? 'Agent' : 'Agenten');
const runsWord = n => n + ' ' + (n === 1 ? 'Lauf' : 'Läufen');

// "Basis: ..." line: what this estimate is built on
function basisLine(ev) {
  const parts = [];
  if (ev.sibDone > 0) parts.push(ev.sibDone + ' ' + (ev.sibDone === 1 ? 'fertiges Geschwister' : 'fertige Geschwister') + ' dieser Phase');
  if (ev.sibRunning > 0) parts.push(ev.sibRunning + ' ' + (ev.sibRunning === 1 ? 'Geschwister läuft' : 'Geschwister laufen') + ' noch');
  if (ev.earlier > 0) parts.push(ev.earlier + ' fertige ' + (ev.earlier === 1 ? 'Agent' : 'Agenten') + ' früherer Phasen dieses Laufs');
  if (ev.histRows >= M.PARAMS.minRows) parts.push('Verlauf: ' + agentsWord(ev.histRows) + ' aus ' + runsWord(ev.histRuns));
  else parts.push('noch wenig eigener Verlauf, typische Werte als Näherung');
  return 'Basis: ' + parts.join('; ') + '.';
}
const COVERAGE = 'In unseren Tests waren vergleichbare Agenten in etwa 7 von 10 Fällen innerhalb dieser Spanne fertig, in etwa 1 von 10 später und in etwa 2 von 10 früher.';

function agentTip(kind, ev) {
  if (kind === 'late') return 'Dieser Agent läuft schon länger als etwa 9 von 10 vergleichbaren Agenten. Die Spanne gilt trotzdem, ist aber breit, weil das Ende nicht absehbar ist. ' + basisLine(ev);
  if (kind === 'number') return 'Näherung für die Restzeit: Die Vergleichswerte liegen eng zusammen. ' + COVERAGE + ' ' + basisLine(ev);
  return 'Schätzung für die Restzeit, bewusst als Spanne. ' + COVERAGE + ' ' + basisLine(ev);
}

const sanitizeOthers = v => (Array.isArray(v) ? v.filter(o => o && typeof o === 'object').slice(0, 40).map(o => ({
  size: clampInt(o.size, 1, 500, 1), pos: clamp01(o.pos), doneSec: finiteList(o.doneSec),
})) : []);

/** EtaInput (SPEC 6.1) + HistorySnapshot (History.snapshot()) -> Eta (SPEC 2). Never throws. */
function estimateAgent(input, hist) {
  try {
    if (!input || typeof input !== 'object') return noneEta();
    if (input.state && input.state !== 'running') return noneEta();
    const e = input.elapsedSec;
    if (!(typeof e === 'number' && Number.isFinite(e) && e >= 0)) return noneEta();
    if (input.silentSec > DEFAULTS.staleSilenceSec) {
      return unknownEta('keine Aktivität', 'Seit über ' + Math.round(DEFAULTS.staleSilenceSec / 60) + ' Min. wurde nichts mehr in die Agentendatei geschrieben. Das kann eine lange Denkpause sein, ist aber kein Beweis, dass der Agent noch arbeitet. Keine Schätzung möglich.');
    }
    if (e < DEFAULTS.minElapsed) return unknownEta('Dauer noch unbekannt', 'Der Agent ist gerade erst gestartet. Eine Schätzung folgt, sobald er etwas länger läuft.');
    const h = indexOf(hist && typeof hist === 'object' ? hist : EMPTY_HIST);
    const q = DEFAULTS;

    if (input.kind === 'task') {   // Agent-tool subagent: no phase, no siblings, only its own history
      if (!h.task) return unknownEta('Dauer unbekannt', 'Für Subagenten ohne Workflow gibt es noch zu wenig Vergleichswerte: Die Schätzung braucht mindestens ' + q.taskMinRecords + ' fertige Subagenten aus ' + q.taskMinRuns + ' Sitzungen im Verlauf. Das ist normal, solange die Erfahrung fehlt.');
      const rem = p => M.lognormalRemaining(h.task.mean, h.task.sd, e, p);
      const lo = rem(q.loQ), mid = rem(q.midQ), hi = rem(q.hiQ);
      const survive = M.surv((Math.log(Math.max(1, e)) - h.task.mean) / h.task.sd);
      const kind = kindOf(lo, mid, hi, survive);
      const ev = { sibDone: 0, sibRunning: 0, earlier: 0, histRows: h.task.n, histRuns: h.task.n };
      const tip = agentTip(kind, ev).replace(/Basis: .*$/, 'Basis: ' + agentsWord(h.task.n) + ' im Verlauf (alle Subagenten ohne Workflow).');
      return toEta({ kind, basis: 'history', lo, mid, hi, n: h.task.n }, textOf(kind, lo, mid, hi), tip);
    }

    const done = finiteList(input.siblingsDoneSec), running = finiteList(input.siblingsRunningSec);
    const others = sanitizeOthers(input.otherPhases);
    const earlier = others.reduce((s, o) => s + o.doneSec.length, 0);
    const size = Math.max(1, clampInt(input.phaseSize, 1, 500, 1), done.length + running.length + 1);
    const pr = M.predictAgent({ size, pos: clamp01(input.phasePos), elapsedSec: e, doneSec: done, runningSec: running, others }, h.beta, null);
    const lo = pr.quantile(q.loQ), mid = pr.quantile(q.midQ), hi = pr.quantile(q.hiQ);
    if (![lo, mid, hi].every(Number.isFinite)) return unknownEta('Dauer unbekannt', 'Für diesen Agenten lässt sich keine Restzeit berechnen.');
    const kind = kindOf(lo, mid, hi, pr.survive);
    const ev = { sibDone: done.length, sibRunning: running.length, earlier, histRows: h.rows, histRuns: h.runs };
    const basis = done.length ? 'siblings' : earlier ? 'run' : h.rows >= M.PARAMS.minRows ? 'history' : 'prior';
    return toEta({ kind, basis, lo, mid, hi, n: done.length + earlier, runs: h.rows >= M.PARAMS.minRows ? h.runs : 0 }, textOf(kind, lo, mid, hi), agentTip(kind, ev));
  } catch (err) {
    return noneEta();
  }
}

const EMPTY_HIST = Object.freeze({ agents: Object.freeze([]), phaseDurSec: Object.freeze([]) });

/**
 * Remaining time of the whole workflow (SPEC 6.3): the slowest running agent of the current phase plus every phase that has not
 * started yet (typical duration, adjusted by how slow or fast this run has been so far).
 * input = { elapsedSec, phasesAhead, phaseSize, phasePos, runningSec, siblingsDoneSec, otherPhases }
 *   runningSec:      elapsed seconds of the agents of the current phase that are still running
 *   siblingsDoneSec: durations of the finished agents of the current phase
 *   otherPhases:     [{ size, pos, doneSec }] the other phases that have agents (size = agents started, pos = 0..1)
 *   phasesAhead:     phases that have not started yet
 * (currentPhaseElapsedSecs / currentPhaseSiblingsDoneSec of v0.9.4 are accepted as aliases.)
 */
function estimateWorkflow(input, hist) {
  try {
    if (!input || typeof input !== 'object') return noneEta();
    const running = finiteList(input.runningSec !== undefined ? input.runningSec : input.currentPhaseElapsedSecs);
    const done = finiteList(input.siblingsDoneSec !== undefined ? input.siblingsDoneSec : input.currentPhaseSiblingsDoneSec);
    const ahead = Number.isFinite(input.phasesAhead) && input.phasesAhead > 0 ? Math.min(20, Math.floor(input.phasesAhead)) : 0;
    if (!running.length && ahead === 0) return noneEta();
    const q = DEFAULTS;
    const maxRun = running.length ? Math.max.apply(null, running) : Infinity;
    if (ahead === 0 && maxRun < q.minElapsed && !done.length) return unknownEta('Dauer noch unbekannt', 'Der Workflow ist gerade erst gestartet. Eine Schätzung folgt, sobald seine Agenten etwas länger laufen.');
    const h = indexOf(hist && typeof hist === 'object' ? hist : EMPTY_HIST);
    const others = sanitizeOthers(input.otherPhases);
    const size = Math.max(1, clampInt(input.phaseSize, 1, 500, 1), done.length + running.length);
    const ctx = Object.assign({ size, pos: clamp01(input.phasePos), runningSec: running, doneSec: done, others, ahead }, h.phase || {});
    const pr = M.predictWorkflow(ctx, h.beta, null);
    const lo = pr.quantile(q.loQ), mid = pr.quantile(q.midQ), hi = pr.quantile(q.wfHiQ);
    if (![lo, mid, hi].every(Number.isFinite)) return unknownEta('Restzeit unbekannt', 'Für diesen Workflow lässt sich keine Restzeit berechnen.');
    // "longer than usual": the longest-running agent already outlasts 9 of 10 comparable agents
    let survive = 1;
    if (running.length) {
      const longest = running.indexOf(maxRun);
      const rest = running.slice(0, longest).concat(running.slice(longest + 1));
      survive = M.predictAgent({ size, pos: clamp01(input.phasePos), elapsedSec: maxRun, doneSec: done, runningSec: rest, others }, h.beta, null).survive;
    }
    const kind = kindOf(lo, mid, hi, survive);
    return toEta({ kind, basis: 'phases', lo, mid, hi }, textOf(kind, lo, mid, hi), workflowTip(kind, ahead, running.length > 0, done.length, others.reduce((s, o) => s + o.doneSec.length, 0), h));
  } catch (err) {
    return noneEta();
  }
}

function workflowTip(kind, ahead, hasRunning, sibDone, earlier, h) {
  const what = (hasRunning ? 'der langsamste noch laufende Agent der aktuellen Phase' : 'die Wartezeit bis zur nächsten Phase')
    + (ahead > 0 ? ' plus ' + ahead + ' ' + (ahead === 1 ? 'Phase, die' : 'Phasen, die') + ' noch nicht begonnen ' + (ahead === 1 ? 'hat' : 'haben') + ' (Dauer typisch, angepasst an das bisherige Tempo dieses Laufs)' : '');
  const lead = kind === 'late' ? 'Mindestens ein Agent läuft schon länger als etwa 9 von 10 vergleichbaren Agenten; die Spanne ist deshalb breit. ' : 'Schätzung für den ganzen Workflow, bewusst als Spanne. ';
  const cov = 'In unseren Tests war ein Workflow in etwa 6 von 10 Fällen innerhalb dieser Spanne fertig, in etwa 1 von 10 später und in etwa 3 von 10 früher. ';
  return lead + cov + 'Berechnet aus: ' + what + '. ' + basisLine({ sibDone, sibRunning: 0, earlier, histRows: h.rows, histRuns: h.runs });
}

module.exports = {
  // contract
  DEFAULTS, estimateAgent, estimateWorkflow,
  // helpers (history.js and the tests use these)
  makeRecord, labelPrefix, stripRetry, projectKey, fold, quantile, median, formatSpan, formatOne,
};
