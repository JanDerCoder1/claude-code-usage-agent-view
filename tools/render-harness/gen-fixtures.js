'use strict';
// Generates fixtures/*.json (valid ViewState v:1, SPEC 2) for the render harness. Run: node tools/render-harness/gen-fixtures.js
// All times are absolute epoch ms around NOW; the harness stub shifts them to the load time, so timers look live.
const fs = require('fs');
const path = require('path');

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const OUT = path.join(__dirname, 'fixtures');
const HOME = 'C:\\Users\\user\\.claude';
const SEC = 1000;
const MIN = 60 * SEC;

const SONNET = { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' };
const HAIKU = { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' };
const OPUS = { id: 'claude-opus-5[1m]', label: 'Opus 5 (1M)' };

const eta = (kind, text, tip, basis, lo, mid, hi) => ({
  kind, basis: basis || 'none', lo: lo === undefined ? null : lo, mid: mid === undefined ? null : mid, hi: hi === undefined ? null : hi, text, tip,
});
const ETA = {
  number: eta('number', '~4 Min.', 'Basis: 3 fertige Geschwister (grob, getestet an 73 Läufen)', 'siblings', 200, 240, 280),
  range: eta('range', '2–8 Min.', 'Grobe Schätzung, die Spanne ist bewusst breit. Basis: 2 fertige Geschwister (gleiche Phase, gleicher Lauf).', 'siblings', 120, 300, 480),
  late: eta('late', 'länger als die anderen (meist < 4 Min. mehr)', 'Basis: 4 fertige Geschwister, dieser Agent läuft länger als alle', 'siblings'),
  unknown: eta('unknown', 'unbekannt', 'nur Erfahrungswert: 2-9 Min. (n = 595 Agenten aus 55 Läufen)', 'global'),
  stale: eta('unknown', 'keine Aktivität', 'Seit mehr als 10 Minuten keine neue Zeile im Protokoll', 'none'),
  none: eta('none', '', '', 'none'),
};

let seq = 0;
const agent = (o) => Object.assign({
  id: 'a' + String(++seq).padStart(4, '0') + 'f3c9d2', label: 'agent', phase: null, kind: 'wf', agentType: null, shape: null, model: SONNET,
  state: 'done', quietSec: 0, tokens: 0, toolUses: 0, startedAt: null, endedAt: null, durationMs: null, attempt: 1, cached: false, loading: false,
  activity: null, failure: null, resultPreview: null, eta: null,
}, o);

const live = (label, phase, elapsedMs, tokens, toolUses, activity, etaObj, extra) => agent(Object.assign({
  label, phase, state: 'running', tokens, toolUses, startedAt: NOW - elapsedMs, activity, eta: etaObj, quietSec: 3,
}, extra));
const done = (label, phase, durMs, endedAgoMs, tokens, toolUses, extra) => agent(Object.assign({
  label, phase, state: 'done', tokens, toolUses, startedAt: NOW - endedAgoMs - durMs, endedAt: NOW - endedAgoMs, durationMs: durMs,
}, extra));

function phase(title, detail, agents) {
  const nDone = agents.filter((a) => a.state === 'done').length;
  const failed = agents.filter((a) => ['failed', 'interrupted', 'stopped'].includes(a.state)).length;
  const running = agents.some((a) => a.state === 'running' || a.state === 'waiting');
  const state = agents.length === 0 ? 'pending' : running ? 'running' : nDone === agents.length ? 'done' : 'partial';
  return { title, detail, state, done: nDone, failed, total: agents.length, agents };
}

function workflow(o, phases) {
  const agents = phases.flatMap((p) => p.agents);
  const sum = (f) => agents.reduce((s, a) => s + a[f], 0);
  return Object.assign({
    kind: 'workflow', key: 'e5ce9d45:' + o.runId, runId: o.runId, sessionId: 'e5ce9d45-addc-4585-9608-4c76c0596a7b', sessionTitle: 'coding-92',
    origin: 'VS Code', name: 'workflow', description: null, status: 'running', startedAt: null, endedAt: null, durationMs: null,
    agentsTotal: agents.length, agentsDone: agents.filter((a) => a.state === 'done').length, agentsFailed: agents.filter((a) => a.state === 'failed').length,
    tokens: sum('tokens'), toolUses: sum('toolUses'), phases, eta: null,
  }, o);
}

const taskCard = (a, o) => Object.assign({
  kind: 'agent', key: 'e5ce9d45:' + a.id, sessionId: 'e5ce9d45-addc-4585-9608-4c76c0596a7b', sessionTitle: 'coding-92', origin: 'VS Code',
  agent: Object.assign(a, { kind: 'task' }),
}, o);

const state = (o) => Object.assign({
  v: 1, now: NOW, scope: 'workspace', scopeLabel: 'Arbeitsbereich: agent-view', claudeHome: HOME, running: [], recent: [], warnings: [], formatNote: null,
}, o);

// ---- wf-running: the Desktop screenshot (2 phases, 4 agents) plus a busy run with every agent state --------------
function wfRunning() {
  const a = workflow({
    runId: 'wf_5281790c-ce8', name: 'agent-rail-research',
    description: 'Parallele Recherche der Schnittstellen-Fakten, die für eine Live-Anzeige der Agenten als Karten nötig sind: Laufzeit, verbrauchte Tokens, geschätzte Restzeit und die aktuelle Tätigkeit jedes Agenten.\nVier Leser prüfen je ein Gebiet; danach vergleicht ein Kritiker die Berichte gegeneinander und schreibt die Bauanleitung.',
    status: 'running', startedAt: NOW - (6 * MIN + 12 * SEC), eta: eta('range', 'Rest grob: 8–30 Min.', 'Grobe Schätzung. Basis: restliche Zeit der aktuellen Phase plus 1 weitere Phase in typischer Länge. Trefferquote nur etwa 60 %.', 'phases', 480, 900, 1800),
  }, [
    phase('Research', 'Fakten zur Plugin-API sammeln', [
      live('research:usage', 'Research', 6 * MIN + 12 * SEC, 95900, 14, { kind: 'tool', tool: 'Grep', target: 'C:/Users/user/.claude/projects/my-project/e5ce9d45-addc-4585-9608-4c76c0596a7b/subagents/workflows/wf_5281790c-ce8/journal.jsonl', running: true }, ETA.number),
      live('research:lifecycle', 'Research', 6 * MIN + 12 * SEC, 94300, 12, { kind: 'tool', tool: 'Read', target: 'src/extension.ts', running: true, parallel: 3 }, ETA.range),
      live('research:pane', 'Research', 6 * MIN + 10 * SEC, 102400, 17, { kind: 'thinking', running: true }, ETA.late),
      live('research:state', 'Research', 6 * MIN + 9 * SEC, 87600, 9, { kind: 'writing', running: true }, ETA.unknown),
    ]),
    phase('Critic', null, []),
  ]);

  const b = workflow({
    runId: 'wf_b7710e2a-c41', name: 'verify:batch2', sessionTitle: 'fix-poller', origin: 'Desktop',
    description: 'Prüft die neue Abfrage-Schleife gegen den echten Sitzungsbaum: ein Agent je Modul, Wiederholung bei Ratenbegrenzung (429), die Ergebnisse sammelt der Kritiker am Ende.',
    status: 'running', startedAt: NOW - (23 * MIN + 41 * SEC),
  }, [
    phase('Plan', null, [
      done('plan:scope', 'Plan', 2 * MIN + 31 * SEC, 21 * MIN, 41200, 6, { resultPreview: 'Scope: poller.js, sessionModel.js, history.js; 14 modules affected, 3 risky.' }),
      done('plan:order', 'Plan', 3 * MIN + 2 * SEC, 20 * MIN, 52100, 8),
    ]),
    phase('Execute', 'Ein Agent pro Modul', [
      live('exec:parser', 'Execute', 9 * MIN + 4 * SEC, 61800, 22, { kind: 'tool', tool: 'Bash', target: 'node --test test/tail.test.js', running: true }, ETA.unknown),
      live('exec:fold', 'Execute', 17 * MIN + 55 * SEC, 78300, 31, { kind: 'tool', tool: 'Edit', target: 'lib/agentFold.js', running: false }, ETA.stale, { quietSec: 662 }),
      live('exec:model', 'Execute', 8 * MIN + 30 * SEC, 55000, 19, { kind: 'waiting', running: false }, null, { state: 'waiting', quietSec: 24 }),
      done('exec:eta', 'Execute', 11 * MIN + 7 * SEC, 3 * MIN, 83900, 40, { attempt: 2 }),
      done('exec:history', 'Execute', 0, 2 * MIN, 0, 0, { cached: true, durationMs: null, startedAt: null }),
      agent({
        label: 'exec:poller', phase: 'Execute', state: 'failed', tokens: 17400, toolUses: 5, startedAt: NOW - 14 * MIN, endedAt: NOW - 9 * MIN, durationMs: 5 * MIN,
        failure: { status: 429, error: 'rate_limit', text: "You've hit your session limit · resets 6pm (Europe/Berlin)" },
      }),
      agent({ label: 'exec:ui', phase: 'Execute', state: 'interrupted', tokens: 30100, toolUses: 11, startedAt: NOW - 12 * MIN, endedAt: NOW - 7 * MIN, durationMs: 5 * MIN }),
      agent({ label: 'exec:shell', phase: 'Execute', state: 'stopped', tokens: 9100, toolUses: 3, startedAt: NOW - 13 * MIN, endedAt: NOW - 10 * MIN, durationMs: 3 * MIN }),
    ]),
    phase('Report', null, []),
  ]);
  return state({ running: [a, b], usage: usage() });
}

// 5-hour window at 68 % (amber), weekly window at 27 %, numbers 12 minutes old
function usage() {
  return {
    fetchedAt: NOW - 12 * MIN,
    windows: [
      { id: 'five_hour', label: '5-Stunden-Limit', percent: 68, resetsAt: NOW + (1 * 60 + 53) * MIN, severity: 'warning' },
      { id: 'weekly', label: 'Wochenlimit', percent: 27, resetsAt: NOW + (6 * 24 + 4) * 60 * MIN, severity: 'normal' },
    ],
  };
}

// states of the usage block: critical, an expired window and old numbers
function usageStates() {
  return state({
    running: [],
    usage: {
      fetchedAt: NOW - 52 * MIN,
      windows: [
        { id: 'five_hour', label: '5-Stunden-Limit', percent: 94, resetsAt: NOW - 8 * MIN, severity: 'critical' },
        { id: 'weekly', label: 'Wochenlimit', percent: 93, resetsAt: NOW + (2 * 24 + 7) * 60 * MIN, severity: 'critical' },
      ],
    },
  });
}

// ---- wf-done --------------------------------------------------------------------------------------------------
function wfDone() {
  const research = [
    done('research:usage', 'Research', 8 * MIN + 2 * SEC, 13 * MIN, 241600, 61, { resultPreview: 'Usage figures confirmed.' }),
    done('research:lifecycle', 'Research', 7 * MIN + 40 * SEC, 13 * MIN, 233900, 58),
    done('research:pane', 'Research', 9 * MIN + 12 * SEC, 12 * MIN, 250200, 66),
    done('research:state', 'Research', 6 * MIN + 51 * SEC, 14 * MIN, 228000, 52),
  ];
  const a = workflow({
    runId: 'wf_afd16ef8-1f1', name: 'agent-rail-research', description: 'Parallel research of the plugin API facts needed for a live agent-cards pane.',
    status: 'completed', startedAt: NOW - 25 * MIN, endedAt: NOW - 4 * MIN, durationMs: 21 * MIN + 13 * SEC,
  }, [
    phase('Research', null, research),
    phase('Spec', null, [done('spec:write', 'Spec', 5 * MIN + 10 * SEC, 6 * MIN, 118000, 33, { model: OPUS })]),
    phase('Critic', null, [done('critic:a', 'Critic', 2 * MIN, 5 * MIN, 64000, 12, { model: HAIKU }), done('critic:b', 'Critic', 2 * MIN + 14 * SEC, 5 * MIN, 66100, 14, { model: HAIKU })]),
  ]);
  const b = workflow({
    runId: 'wf_18d7ece8-683', name: 'verify:batch1', sessionTitle: 'fix-poller', origin: 'Desktop', description: 'Retries and a rate limit hit in the middle.',
    status: 'completed', startedAt: NOW - 70 * MIN, endedAt: NOW - 41 * MIN, durationMs: 29 * MIN,
  }, [
    phase('Execute', null, [
      done('exec:a', 'Execute', 9 * MIN, 44 * MIN, 70100, 21, { attempt: 2 }),
      done('exec:b', 'Execute', 0, 42 * MIN, 0, 0, { cached: true, startedAt: null, durationMs: null }),
      agent({ label: 'exec:c', phase: 'Execute', state: 'failed', tokens: 8200, toolUses: 2, startedAt: NOW - 60 * MIN, endedAt: NOW - 55 * MIN, durationMs: 5 * MIN, failure: { status: 500, error: 'server_error', text: 'API Error: 500 Internal server error' } }),
    ]),
  ]);
  const c = workflow({
    runId: 'wf_d5f00fed-f46', name: 'resume-demo', sessionTitle: '7c1f0a2e', origin: null, description: null,
    status: 'paused', startedAt: NOW - 3 * 3600 * 1000, endedAt: NOW - 2 * 3600 * 1000, durationMs: 3600 * 1000 + 5 * SEC,
  }, [phase('Main', null, [done('main:a', 'Main', 3600 * 1000, 2 * 3600 * 1000, 910000, 120)])]);
  return state({ recent: [a, b, c] });
}

// ---- wf-killed ------------------------------------------------------------------------------------------------
function wfKilled() {
  const mk = (label, tokens, tools) => agent({ label, phase: 'Research', state: 'interrupted', tokens, toolUses: tools, startedAt: NOW - 70 * SEC, endedAt: NOW - 6 * SEC, durationMs: 64 * SEC });
  const a = workflow({
    runId: 'wf_f558ff26-d2f', name: 'agent-rail-research', description: 'Parallel research of the plugin API facts needed for a live agent-cards pane (elapsed, tokens, ETA).',
    status: 'killed', startedAt: NOW - 70 * SEC, endedAt: NOW - 6 * SEC, durationMs: 64037, tokens: 468112, toolUses: 118,
  }, [
    phase('Research', null, [mk('research:usage', 109963, 29), mk('research:lifecycle', 130441, 30), mk('research:pane', 123771, 29), mk('research:state', 103937, 30)]),
    phase('Critic', null, []),
  ]);
  return state({ recent: [a] });
}

// ---- task-agents ----------------------------------------------------------------------------------------------
function taskAgents() {
  const r1 = taskCard(agent({
    label: 'Explore plugin API docs', agentType: 'Explore', shape: 'background', model: HAIKU, state: 'running', tokens: 43000, toolUses: 4,
    startedAt: NOW - 43 * SEC, quietSec: 2, activity: { kind: 'tool', tool: 'Grep', target: 'C:/Users/user/AppData/Local/Programs/Microsoft VS Code/resources/app/extensions', running: true }, eta: ETA.unknown,
  }));
  const r2 = taskCard(agent({
    label: 'Review diff for regressions', agentType: 'general-purpose', shape: 'foreground', model: SONNET, state: 'waiting', tokens: 88200, toolUses: 17,
    startedAt: NOW - 4 * MIN, quietSec: 31, activity: { kind: 'waiting', running: false }, eta: null,
  }));
  const d = taskCard(agent({
    label: 'Summarise failing tests', agentType: 'general-purpose', shape: 'background', model: HAIKU, state: 'done', tokens: 39070, toolUses: 1,
    startedAt: NOW - 3 * MIN - 18622, endedAt: NOW - 3 * MIN, durationMs: 18622,
    resultPreview: 'Three tests fail in test/sessionModel.test.js: retry slot, orphan result, torn journal line. All three come from one off-by-one in the slot counter.',
  }));
  return state({ running: [r1, r2], recent: [d] });
}

// ---- failed-429 -----------------------------------------------------------------------------------------------
function failed429() {
  const f1 = taskCard(agent({
    label: 'Refactor poller cadence', agentType: 'general-purpose', shape: 'background', model: SONNET, state: 'failed', tokens: 21000, toolUses: 6,
    startedAt: NOW - 12 * MIN, endedAt: NOW - 9 * MIN, durationMs: 3 * MIN, failure: { status: 429, error: 'rate_limit', text: "You've hit your session limit · resets 6pm (Europe/Berlin)" },
  }));
  const f2 = taskCard(agent({
    label: 'Check CSP of the webview', agentType: 'Explore', shape: 'background', model: HAIKU, state: 'failed', tokens: 4100, toolUses: 1,
    startedAt: NOW - 30 * MIN, endedAt: NOW - 29 * MIN, durationMs: MIN,
    failure: { status: 500, error: 'server_error', text: 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}} - this is a server-side problem, retrying may help' },
  }));
  const w = workflow({
    runId: 'wf_b324854d-978', name: 'research:limits', description: 'Collects the rate limit facts.', status: 'killed',
    startedAt: NOW - 50 * MIN, endedAt: NOW - 44 * MIN, durationMs: 6 * MIN,
  }, [phase('Research', null, [
    agent({ label: 'research:a', phase: 'Research', state: 'failed', tokens: 9000, toolUses: 3, startedAt: NOW - 50 * MIN, endedAt: NOW - 45 * MIN, durationMs: 5 * MIN, failure: { status: 429, error: 'rate_limit', text: "You've hit your session limit · resets Oct 4, 9am (Europe/Berlin)" } }),
    agent({ label: 'research:b', phase: 'Research', state: 'interrupted', tokens: 12000, toolUses: 4, startedAt: NOW - 50 * MIN, endedAt: NOW - 44 * MIN, durationMs: 6 * MIN }),
  ])]);
  return state({
    recent: [f1, f2, w],
    warnings: ['Sitzung 7c1f0a2e: agent-a91c.jsonl konnte nicht gelesen werden (EBUSY).'],
    formatNote: 'Format getestet mit Claude Code 2.1.263-2.1.288; gefunden: 2.2.0.',
  });
}

// ---- many-cards (30 cards, deterministic) -----------------------------------------------------------------------
function manyCards() {
  let s = 12345;
  const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const names = ['research:api', 'verify:batch', 'plan:scope', 'exec:module', 'critic:review', 'spec:write', 'scan:tree', 'port:ui'];
  const wfCard = (i, status) => {
    const nPhases = 1 + Math.floor(rnd() * 3);
    const phases = [];
    for (let p = 0; p < nPhases; p++) {
      const n = 2 + Math.floor(rnd() * 5);
      const agents = [];
      for (let k = 0; k < n; k++) {
        const base = 'x' + i + '.' + p + '.' + k;
        const dur = (60 + Math.floor(rnd() * 800)) * SEC;
        const tok = 20000 + Math.floor(rnd() * 200000);
        const isLast = p === nPhases - 1;
        if (status === 'running' && isLast && k % 2 === 0) agents.push(live('agent:' + base, 'Phase ' + (p + 1), dur / 2, tok, 5 + Math.floor(rnd() * 40), { kind: 'tool', tool: pick(['Read', 'Grep', 'Edit', 'Bash']), target: 'lib/module' + k + '.js', running: true }, pick([ETA.number, ETA.range, ETA.late, ETA.unknown])));
        else agents.push(done('agent:' + base, 'Phase ' + (p + 1), dur, (3 + k) * MIN, tok, 5 + Math.floor(rnd() * 40)));
      }
      phases.push(phase('Phase ' + (p + 1), null, agents));
    }
    return workflow({
      runId: 'wf_m' + String(i).padStart(7, '0'), key: 'many:wf' + i, name: pick(names) + '-' + i, sessionTitle: pick(['coding-92', 'fix-poller', 'docs', '7c1f0a2e']), origin: pick(['VS Code', 'Desktop']),
      description: i % 2 ? 'Synthetic card number ' + i + ' to check list size, reconciliation and layout under load.' : null, status,
      startedAt: NOW - (5 + i) * MIN, endedAt: status === 'running' ? null : NOW - (2 + i) * MIN, durationMs: status === 'running' ? null : (3 + i) * MIN,
    }, phases);
  };
  const running = [];
  for (let i = 0; i < 6; i++) running.push(wfCard(i, 'running'));
  // a phase that exceeds the 40-agent cap collapses into "+N weitere"
  const big = [];
  for (let k = 0; k < 40; k++) big.push(done('big:' + k, 'Batch', (90 + k) * SEC, (5 + k % 7) * MIN, 30000 + k * 900, 10 + (k % 9)));
  const bigPhase = phase('Batch', 'cap 40', big);
  bigPhase.total = 45;
  bigPhase.done = 45;
  const bigCard = workflow({ runId: 'wf_big', key: 'many:big', name: 'verify:big-batch', status: 'running', startedAt: NOW - 90 * MIN }, [bigPhase, phase('Merge', null, [live('merge:all', 'Merge', 3 * MIN, 52000, 11, { kind: 'thinking', running: true }, ETA.unknown)])]);
  bigCard.agentsTotal = 46;
  bigCard.eta = eta('unknown', 'Rest unbekannt', 'Mehrere Phasen stehen noch aus. Dafür ist keine verlässliche Schätzung möglich.', 'phases');
  running.push(bigCard);
  for (let i = 0; i < 3; i++) {
    running.push(taskCard(agent({ label: 'Subagent task ' + i, agentType: pick(['Explore', 'general-purpose', 'Plan']), shape: pick(['background', 'foreground']), model: pick([HAIKU, SONNET]), state: 'running', tokens: 20000 + i * 7000, toolUses: 3 + i, startedAt: NOW - (i + 1) * 70 * SEC, quietSec: 4, activity: { kind: 'tool', tool: 'Read', target: 'docs/SPEC.md', running: true }, eta: ETA.unknown })));
  }
  const recent = [];
  for (let i = 0; i < 14; i++) recent.push(wfCard(100 + i, pick(['completed', 'completed', 'killed'])));
  for (let i = 0; i < 6; i++) {
    recent.push(taskCard(agent({ label: 'Finished task ' + i, agentType: 'general-purpose', shape: 'background', model: HAIKU, state: 'done', tokens: 30000 + i * 1111, toolUses: 2 + i, startedAt: NOW - (20 + i) * MIN, endedAt: NOW - (19 + i) * MIN, durationMs: MIN, resultPreview: 'Result of task ' + i + ': everything checked, nothing to report.' })));
  }
  return state({ running, recent, scope: 'all', scopeLabel: 'Alle Projekte' });
}

// ---- readme: the picture in README.md (one run with finished, running and not yet started parts) ---------------------------
function readmeView() {
  const w = workflow({
    runId: 'wf_5281790c-ce8', name: 'agent-rail-research',
    description: 'Parallele Recherche der Schnittstellen-Fakten, die für eine Live-Anzeige der Agenten als Karten nötig sind. Vier Leser prüfen je ein Gebiet, danach vergleicht ein Kritiker die Berichte.',
    status: 'running', startedAt: NOW - (9 * MIN + 12 * SEC),
    eta: eta('range', 'Rest grob: 3–9 Min.', 'Grobe Schätzung. Basis: restliche Zeit der aktuellen Phase plus 1 weitere Phase in typischer Länge.', 'siblings', 180, 360, 540),
  }, [
    phase('Research', 'Fakten zur Plugin-API sammeln', [
      done('research:usage', 'Research', 8 * MIN + 2 * SEC, 70 * SEC, 241600, 61),
      done('research:lifecycle', 'Research', 7 * MIN + 40 * SEC, 90 * SEC, 233900, 58),
      live('research:pane', 'Research', 9 * MIN + 10 * SEC, 102400, 17, { kind: 'tool', tool: 'Read', target: 'src/extension.ts', running: true, parallel: 3 }, ETA.number),
      live('research:state', 'Research', 9 * MIN + 9 * SEC, 87600, 9, { kind: 'writing', running: true }, ETA.range),
    ]),
    phase('Critic', null, []),
  ]);
  return state({ running: [w], usage: usage() });
}

// ---- empty ------------------------------------------------------------------------------------------------------
const empty = () => state({});

const FIXTURES = {
  'wf-running': wfRunning, 'usage-states': usageStates, 'wf-done': wfDone, 'wf-killed': wfKilled, 'task-agents': taskAgents, 'failed-429': failed429, 'many-cards': manyCards, readme: readmeView, empty,
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, build] of Object.entries(FIXTURES)) {
  const json = JSON.stringify(build(), null, 1) + '\n';
  fs.writeFileSync(path.join(OUT, name + '.json'), json);
  const compact = JSON.stringify(JSON.parse(json)).length;
  console.log(name.padEnd(12), String(compact).padStart(7), 'bytes (compact)');
}
