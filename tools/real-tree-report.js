#!/usr/bin/env node
'use strict';
// Real-tree acceptance report (SPEC 11.3): builds a SessionModel over the real Claude home and prints a compact summary.
//
//   node tools/real-tree-report.js [--home <dir>] [--scope all|workspace] [--folder <dir>] [--hours <n>]
//                                  [--session <sid>] [--warm <n>] [--no-history] [--json]
//
// Strictly read-only toward the Claude home (the model only reads). The ETA history is kept in a temp file that is
// deleted again. Exit code 1 when an acceptance check fails.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SessionModel = require(path.join(ROOT, 'lib', 'sessionModel.js'));
const { History } = require(path.join(ROOT, 'lib', 'history.js'));
const CH = require(path.join(ROOT, 'lib', 'claudeHome.js'));
const { fmtTokens, fmtDur } = require(path.join(ROOT, 'lib', 'format.js'));

const DEFAULT_SESSION = 'e5ce9d45-addc-4585-9608-4c76c0596a7b';
// SPEC 11.3: what the current session must show on this machine
const EXPECT = {
  workflows: [
    { name: 'agent-rail-research', status: 'killed' },
    { name: 'vscode-agent-view-research', status: 'completed', agents: 5 },
  ],
  plainLabels: ['A', 'B', 'C'],
};

function parseArgs(argv) {
  const a = { home: '', scope: 'all', folder: '', hours: 24, session: DEFAULT_SESSION, warm: 20, history: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => argv[++i];
    if (k === '--home') a.home = v();
    else if (k === '--scope') a.scope = v() === 'workspace' ? 'workspace' : 'all';
    else if (k === '--folder') a.folder = v();
    else if (k === '--hours') a.hours = Math.max(1, Number(v()) || 24);
    else if (k === '--session') a.session = String(v() || '').toLowerCase();
    else if (k === '--warm') a.warm = Math.max(1, parseInt(v(), 10) || 20);
    else if (k === '--no-history') a.history = false;
    else if (k === '--json') a.json = true;
    else if (k === '-h' || k === '--help') { a.help = true; }
  }
  return a;
}

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
const median = (xs) => { const s = xs.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const pct = (xs, p) => { const s = xs.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };

function cardRow(c) {
  if (c.kind === 'agent') {
    const a = c.agent;
    return {
      kind: 'agent', name: a.label, status: a.state, agents: '1/1', tokens: a.tokens, phases: '-',
      eta: a.eta ? a.eta.kind : '-', session: c.sessionId.slice(0, 8), dur: a.durationMs,
    };
  }
  const done = c.phases.filter(p => p.state === 'done').length;
  const kinds = {};
  for (const p of c.phases) for (const a of p.agents) if (a.eta) kinds[a.eta.kind] = (kinds[a.eta.kind] || 0) + 1;
  const ak = Object.keys(kinds).map(k => k + ':' + kinds[k]).join(',');
  return {
    kind: 'workflow', name: c.name, status: c.status, agents: c.agentsDone + '/' + c.agentsTotal + (c.agentsFailed ? ' (' + c.agentsFailed + ' failed)' : ''),
    tokens: c.tokens, phases: done + '/' + c.phases.length, eta: (c.eta ? c.eta.kind : '-') + (ak ? ' [agents ' + ak + ']' : ''),
    session: c.sessionId.slice(0, 8), dur: c.durationMs, runId: c.runId,
  };
}

function fmtRow(r) {
  return '  ' + [r.kind.padEnd(8), String(r.name).slice(0, 38).padEnd(38), String(r.status).padEnd(10), String(r.agents).padEnd(14),
    fmtTokens(r.tokens).padStart(7), String(r.phases).padStart(5), ' eta=' + r.eta, ' ' + r.session, r.dur != null ? fmtDur(r.dur) : ''].join(' ');
}

// Lists the cards of one session; the acceptance expectations (EXPECT) are specific to the machine's build session and only apply to it.
function sessionChecks(full, sid) {
  const checks = [];
  const mine = [...full.running, ...full.recent].filter(c => c.sessionId.toLowerCase() === sid);
  const wfs = mine.filter(c => c.kind === 'workflow');
  const plain = mine.filter(c => c.kind === 'agent');
  if (sid !== DEFAULT_SESSION) return { checks, wfs, plain };
  for (const e of EXPECT.workflows) {
    const c = wfs.find(x => x.name === e.name);
    let ok = !!c && c.status === e.status;
    if (ok && e.agents !== undefined) ok = c.agentsTotal === e.agents;
    checks.push({ ok, what: 'workflow ' + e.name + ' is ' + e.status + (e.agents ? ' with ' + e.agents + ' agents' : ''), got: c ? c.status + ', ' + c.agentsTotal + ' agents' : 'missing' });
  }
  const pstates = {};
  for (const c of plain) pstates[c.agent.label] = c.agent.state;
  for (const l of EXPECT.plainLabels) {
    const hit = plain.filter(c => new RegExp('^Testagent ' + l + '\\b').test(c.agent.label));
    const ok = hit.length > 0 && hit.every(c => c.agent.state === 'done');
    checks.push({ ok, what: 'plain test agent ' + l + ' is done', got: hit.length ? hit.map(c => c.agent.label + '=' + c.agent.state).join('; ') : 'missing (plain agents of the session: ' + Object.keys(pstates).join(' | ') + ')' });
  }
  return { checks, wfs, plain };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log('usage: node tools/real-tree-report.js [--home dir] [--scope all|workspace] [--folder dir] [--hours n] [--session sid] [--warm n] [--no-history] [--json]'); return 0; }
  const home = CH.claudeHome(args.home);
  const out = [];
  const log = (s) => out.push(s);
  if (!fs.existsSync(path.join(home, 'projects'))) { console.error('no projects dir below ' + home); return 2; }

  let history = null, histFile = null;
  const warnings = [];
  const t = { bootstrapMs: null };
  if (args.history) {
    histFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'av-report-')), 'history.json');
    history = new History(histFile);
    history.load();
  }
  const opts = { claudeHome: home, scope: args.scope, workspaceFolders: args.folder ? [args.folder] : [], recentHours: args.hours, staleMinutes: 10, showToolTargets: true, etaEnabled: true, history };

  const run = async () => {
    if (history) { const b0 = process.hrtime.bigint(); await history.bootstrap(home); t.bootstrapMs = ms(b0); }
    // cold refresh: fresh model, nothing cached
    const model = new SessionModel(opts);
    const now0 = Date.now();
    const c0 = process.hrtime.bigint();
    let vs = model.refresh(now0);
    const coldMs = ms(c0);
    // the model reads at most 8 MB per tick: keep ticking (as the poller would) until nothing is loading any more
    let settleTicks = 1, settleMs = coldMs;
    for (let i = 0; i < 40; i++) {
      const loading = [...vs.running, ...vs.recent].some(c => (c.kind === 'agent' ? c.agent.loading : c.phases.some(p => p.agents.some(a => a.loading))));
      if (!loading) break;
      const s0 = process.hrtime.bigint(); vs = model.refresh(now0 + 1500 * settleTicks); settleMs += ms(s0); settleTicks++;
    }
    // warm refreshes: same model, unchanged files, now advancing like the poller does
    // simulated clock: continues after the settle ticks so the model never sees time going backwards
    let clk = now0 + 1500 * settleTicks;
    const warm = [], forced = [], disc = [];
    model.refresh(clk);
    for (let i = 0; i < args.warm; i++) { clk += 50; const w0 = process.hrtime.bigint(); model.refresh(clk); warm.push(ms(w0)); }          // within one discovery period
    for (let i = 0; i < Math.min(args.warm, 10); i++) { clk += 50; model.invalidate(); const w0 = process.hrtime.bigint(); model.refresh(clk); forced.push(ms(w0)); }   // what a fs.watch event does
    for (let i = 0; i < 5; i++) { clk += 5000; const w0 = process.hrtime.bigint(); model.refresh(clk); disc.push(ms(w0)); }                 // the 5 s discovery cadence
    vs = model.refresh(clk + 50);
    const sizeKb = JSON.stringify(vs).length / 1024;
    // uncapped view for the session check (the UI shows at most 20 recent cards)
    const full = model.refresh(clk + 100, { maxRunning: 1000, maxRecent: 1000, noSizeCap: true });
    const rows = { running: vs.running.map(cardRow), recent: vs.recent.map(cardRow) };
    const sc = args.session ? sessionChecks(full, args.session) : { checks: [], wfs: [], plain: [] };
    const capped = [...vs.running, ...vs.recent].some(c => c.sessionId.toLowerCase() === args.session);

    // history ingestion is observable through the stats (runs ingested live while the model built cards)
    const hs = history && history.stats ? history.stats() : null;
    const res = {
      home, scope: vs.scope, scopeLabel: vs.scopeLabel, now: vs.now, recentHours: args.hours,
      counts: { running: vs.running.length, recent: vs.recent.length, recentAll: full.recent.length, runningAll: full.running.length },
      sizeKb: Math.round(sizeKb * 10) / 10,
      perf: { coldMs, coldSettleTicks: settleTicks, coldSettleMs: settleMs, warmMedianMs: median(warm), warmP95Ms: pct(warm, 0.95), warmMaxMs: Math.max(...warm), forcedMedianMs: median(forced), forcedMaxMs: forced.length ? Math.max(...forced) : 0, discoveryMedianMs: median(disc), discoveryMaxMs: Math.max(...disc), bootstrapMs: t.bootstrapMs },
      warnings: vs.warnings, formatNote: vs.formatNote, rows,
      session: { sid: args.session, shownInUiView: capped, checks: sc.checks },
      history: hs,
    };
    model.dispose();
    if (history) { try { history.dispose && history.dispose(); } catch (_) { /* ignore */ } }
    if (histFile) { try { fs.rmSync(path.dirname(histFile), { recursive: true, force: true }); } catch (_) { /* ignore */ } }

    if (args.json) { console.log(JSON.stringify(res, null, 2)); return res.session.checks.every(c => c.ok) ? 0 : 1; }

    log('Claude Code Utilities real-tree report');
    log('home      ' + home);
    log('scope     ' + res.scope + ' (' + res.scopeLabel + '), recentHours ' + args.hours + ', projects dirs ' + CH.dirNames(path.join(home, 'projects')).length);
    log('cards     running ' + res.counts.running + ', recent ' + res.counts.recent + ' shown (' + res.counts.recentAll + ' without the cap of 20), ViewState ' + f1(res.sizeKb) + ' KB');
    log('perf      cold refresh ' + f1(coldMs) + ' ms (+' + (settleTicks - 1) + ' follow-up ticks to finish loading, ' + f1(settleMs) + ' ms in total), warm median ' + f1(res.perf.warmMedianMs) + ' ms / p95 ' + f1(res.perf.warmP95Ms) + ' ms / max ' + f1(res.perf.warmMaxMs) + ' ms,'
      + ' forced rediscovery (watch event) median ' + f1(res.perf.forcedMedianMs) + ' ms / max ' + f1(res.perf.forcedMaxMs) + ' ms, 5 s discovery tick median ' + f1(res.perf.discoveryMedianMs) + ' ms / max ' + f1(res.perf.discoveryMaxMs) + ' ms' + (t.bootstrapMs !== null ? ', history bootstrap ' + f1(t.bootstrapMs) + ' ms' : ''));
    if (hs) log('history   ' + JSON.stringify(hs));
    log('');
    log('RUNNING (' + rows.running.length + ')');
    for (const r of rows.running) log(fmtRow(r));
    log('RECENT (' + rows.recent.length + ')');
    for (const r of rows.recent) log(fmtRow(r));
    log('');
    log('warnings (' + vs.warnings.length + ')' + (vs.formatNote ? ' + format note' : ''));
    for (const w of vs.warnings) log('  - ' + w);
    if (vs.formatNote) log('  - ' + vs.formatNote);
    if (args.session) {
      log('');
      log('session ' + args.session + ' (' + (capped ? 'visible in the capped UI view' : 'not in the capped UI view of 20 recent cards, taken from the uncapped list') + ')');
      for (const c of sc.wfs) log('  workflow ' + c.name + ' ' + c.status + ' ' + c.agentsDone + '/' + c.agentsTotal + ' agents, ' + fmtTokens(c.tokens) + ' tokens');
      for (const c of sc.plain) log('  plain    ' + c.agent.label + ' ' + c.agent.state + ' ' + fmtTokens(c.agent.tokens) + ' tokens ' + (c.agent.durationMs != null ? fmtDur(c.agent.durationMs) : ''));
      for (const c of sc.checks) log('  [' + (c.ok ? 'PASS' : 'FAIL') + '] ' + c.what + '  (' + c.got + ')');
    }
    console.log(out.join('\n'));
    return sc.checks.every(c => c.ok) ? 0 : 1;
  };
  return run();
}

Promise.resolve(main()).then((code) => { process.exitCode = code || 0; }, (e) => { console.error(e && e.stack || e); process.exitCode = 3; });
