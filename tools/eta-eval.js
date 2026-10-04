#!/usr/bin/env node
'use strict';
// Replays the finished workflow runs under <claudeHome>/projects and measures how good the remaining-time estimate (lib/eta.js) would
// have been at many moments of every agent's and every run's life. At each moment only what was known then is used: the history of
// EARLIER runs and the siblings that had finished by then. Read-only; prints calibration tables.
//
//   node tools/eta-eval.js [claudeHome]            (default: ~/.claude)
//
// "time-weighted" is the number that matches what you see: an agent that runs longer is on screen longer, so it counts with its duration.
// "above" = the agent was still running after the upper end of the shown span (the case the span is meant to make rare).
// "below" = it finished before the lower end.

const fs = require('fs');
const os = require('os');
const path = require('path');
const eta = require('../lib/eta');
const History = require('../lib/history');

const home = process.argv[2] || path.join(os.homedir(), '.claude');

function loadRuns() {
  const out = [];
  const root = path.join(home, 'projects');
  let projs = [];
  try { projs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch (e) { return out; }
  for (const pd of projs) {
    let sess = [];
    try { sess = fs.readdirSync(path.join(root, pd.name), { withFileTypes: true }).filter(d => d.isDirectory()); } catch (e) { continue; }
    for (const sd of sess) {
      const wdir = path.join(root, pd.name, sd.name, 'workflows');
      let files = [];
      try { files = fs.readdirSync(wdir).filter(f => /^wf_.+\.json$/.test(f)); } catch (e) { continue; }
      for (const f of files) {
        let j;
        try { j = JSON.parse(fs.readFileSync(path.join(wdir, f), 'utf8')); } catch (e) { continue; }
        if (!j || !Array.isArray(j.workflowProgress) || !Number.isFinite(j.startTime)) continue;
        out.push({ json: j, run: f.replace(/\.json$/, ''), proj: pd.name.toLowerCase() });
      }
    }
  }
  return out.sort((a, b) => a.json.startTime - b.json.startTime);
}

const endOf = a => (a.cached ? a.startedAt : Number.isFinite(a.durationMs) ? a.startedAt + a.durationMs : Number.isFinite(a.lastProgressAt) ? a.lastProgressAt : a.startedAt);
const isDone = a => a.state === 'done' && !a.cached && a.durationMs > 0 && Number.isFinite(a.startedAt);

function prepare(r) {
  const j = r.json;
  const agents = j.workflowProgress.filter(w => w && w.type === 'workflow_agent').map(w => ({
    label: String(w.label || ''), phaseIndex: w.phaseIndex, phase: String(w.phaseTitle || ''), state: w.state, model: w.model || null, startedAt: w.startedAt,
    durationMs: w.durationMs, lastProgressAt: w.lastProgressAt, attempt: w.attempt || 1, cached: !!w.cached,
  })).filter(a => Number.isFinite(a.startedAt) || a.cached);
  const titles = (Array.isArray(j.phases) ? j.phases : []).map(p => (p && p.title) || '');
  return { run: r.run, proj: r.proj, status: j.status, titles, agents };
}

// what the card knows about the run at absolute time t (ms)
function stateAt(r, t) {
  const ph = r.titles.map((title, i) => ({ idx: i + 1, title, agents: [] }));
  for (const a of r.agents) {
    if (!Number.isFinite(a.startedAt) || a.startedAt > t) continue;
    const p = ph.find(x => x.idx === a.phaseIndex) || ph[ph.length - 1];
    if (!p) continue;
    const end = endOf(a);
    const running = !(a.state === 'done' || a.state === 'error') || end > t;
    p.agents.push({ a, running, done: !running && a.state === 'done', end });
  }
  for (const p of ph) p.running = p.agents.some(x => x.running);
  return ph;
}
const donesOf = ag => ag.filter(x => x.done && !x.a.cached && x.a.durationMs > 0).map(x => x.a.durationMs / 1000);

function agentSamples(r, snapshot, rows) {
  const n = Math.max(1, r.titles.length);
  const pos = idx => (n > 1 ? (idx - 1) / (n - 1) : 0);
  for (const a of r.agents) {
    if (!isDone(a) || a.attempt > 1) continue;
    const dur = a.durationMs / 1000;
    for (let f = 0.1; f < 0.95; f += 0.1) {
      const e = dur * f;
      if (e < 1) continue;
      const t = a.startedAt + e * 1000;
      const ph = stateAt(r, t);
      const mine = ph.find(x => x.idx === a.phaseIndex) || ph[ph.length - 1];
      const sibs = mine.agents.filter(x => x.a !== a);
      const est = eta.estimateAgent({
        state: 'running', elapsedSec: e, silentSec: 0, kind: 'wf', label: a.label, phase: a.phase, model: a.model, project: r.proj, runId: r.run,
        phaseSize: mine.agents.length, phasePos: pos(mine.idx), siblingsDoneSec: donesOf(sibs), siblingsRunningSec: sibs.filter(x => x.running).map(x => (t - x.a.startedAt) / 1000),
        otherPhases: ph.filter(p => p !== mine && p.agents.length).map(p => ({ size: p.agents.length, pos: pos(p.idx), doneSec: donesOf(p.agents) })),
      }, snapshot);
      rows.push({ est, truth: dur - e, weight: dur, e, size: mine.agents.length });
    }
  }
}

function workflowSamples(r, snapshot, rows) {
  const starts = r.agents.filter(a => Number.isFinite(a.startedAt)).map(a => a.startedAt);
  if (!starts.length) return;
  const t0 = Math.min(...starts), t1 = Math.max(...r.agents.map(endOf)), total = t1 - t0;
  if (!(total > 60000)) return;
  const n = Math.max(1, r.titles.length);
  const pos = idx => (n > 1 ? (idx - 1) / (n - 1) : 0);
  for (let f = 0.05; f < 0.96; f += 0.05) {
    const t = t0 + total * f;
    const ph = stateAt(r, t);
    let cur = -1;
    ph.forEach((p, i) => { if (p.running) cur = i; });
    if (cur < 0) ph.forEach((p, i) => { if (p.agents.length) cur = i; });
    if (cur < 0) continue;
    const cp = ph[cur];
    const est = eta.estimateWorkflow({
      elapsedSec: (t - t0) / 1000, phasesAhead: ph.slice(cur + 1).filter(p => p.agents.length === 0).length, phaseSize: cp.agents.length, phasePos: pos(cp.idx),
      runningSec: cp.agents.filter(x => x.running).map(x => (t - x.a.startedAt) / 1000), siblingsDoneSec: donesOf(cp.agents),
      otherPhases: ph.filter((p, i) => i !== cur && p.agents.length).map(p => ({ size: p.agents.length, pos: pos(p.idx), doneSec: donesOf(p.agents) })),
    }, snapshot);
    rows.push({ est, truth: (t1 - t) / 1000, weight: total / 1000 });
  }
}

function report(title, rows) {
  const have = rows.filter(x => Number.isFinite(x.est.lo) && Number.isFinite(x.est.hi));
  const kinds = {};
  for (const x of rows) kinds[x.est.kind] = (kinds[x.est.kind] || 0) + 1;
  let n = 0, cov = 0, above = 0, below = 0, w = 0, wc = 0, wa = 0, wb = 0;
  for (const x of have) {
    n++; w += x.weight;
    if (x.truth < x.est.lo) { below++; wb += x.weight; } else if (x.truth > x.est.hi) { above++; wa += x.weight; } else { cov++; wc += x.weight; }
  }
  const pct = (a, b) => (b ? Math.round(100 * a / b) + ' %' : '-');
  console.log('\n' + title);
  console.log('  samples ' + rows.length + ', with a span ' + have.length + ' (' + pct(have.length, rows.length) + '), kinds ' + JSON.stringify(kinds));
  console.log('  per sample:    inside ' + pct(cov, n) + ', above the span ' + pct(above, n) + ', below ' + pct(below, n));
  console.log('  time-weighted: inside ' + pct(wc, w) + ', above the span ' + pct(wa, w) + ', below ' + pct(wb, w));
  const widths = have.map(x => x.est.hi / Math.max(1, x.est.lo)).sort((a, b) => a - b);
  if (widths.length) console.log('  median hi/lo of the span: ' + widths[Math.floor(widths.length / 2)].toFixed(1));
  return { n, wa, wb, w };
}

function main() {
  const runs = loadRuns();
  if (!runs.length) { console.log('no workflow result files under ' + path.join(home, 'projects')); return; }
  const hist = new History('');
  const agentRows = [], wfRows = [];
  for (const r of runs) {
    if (r.json.status === 'completed') {
      const p = prepare(r), snap = hist.snapshot();
      agentSamples(p, snap, agentRows);
      workflowSamples(p, snap, wfRows);
    }
    hist.ingestRun(r.run, r.json, r.proj);
  }
  console.log(runs.length + ' runs replayed in the order they started; each estimate only knows the runs before it.');
  report('AGENT estimate (span = 20th to 85th percentile of the remaining time)', agentRows);
  for (const basis of ['siblings', 'run', 'history', 'prior']) {
    const part = agentRows.filter(x => x.est.basis === basis);
    if (part.length >= 30) report('  of which built on: ' + basis, part);
  }
  for (const [name, test] of [['single agent in its phase', x => x.size === 1], ['phase with 2 to 5 agents', x => x.size >= 2 && x.size <= 5], ['phase with 6 or more agents', x => x.size >= 6]]) {
    const part = agentRows.filter(test);
    if (part.length >= 30) report('  of which: ' + name, part);
  }
  report('WORKFLOW estimate', wfRows);
  const late = agentRows.filter(x => x.est.kind === 'late');
  if (late.length) console.log('\n"länger als üblich" was shown in ' + Math.round(100 * late.length / agentRows.length) + ' % of the agent samples.');
}

main();
