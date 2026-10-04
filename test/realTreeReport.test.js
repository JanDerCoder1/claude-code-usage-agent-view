'use strict';
// Smoke test of tools/real-tree-report.js on a small synthetic tree (the tool itself is run against the real tree by hand,
// SPEC 11.3): it must run, count the cards, report performance numbers and never write below the Claude home.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOL = path.join(__dirname, '..', 'tools', 'real-tree-report.js');
const SID = '00000000-0000-4000-8000-0000000000bb';

function tree(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'av-report-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = Date.now();
  const sd = path.join(home, 'projects', 'c--proj', SID);
  fs.mkdirSync(path.join(sd, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(home, 'projects', 'c--proj', SID + '.jsonl'), '{}\n');
  const agent = { type: 'workflow_agent', index: 1, label: 'a', phaseIndex: 1, phaseTitle: 'Research', agentId: 'x1', model: 'claude-sonnet-5-5', state: 'done', startedAt: now - 120e3, queuedAt: now - 121e3, attempt: 1, lastProgressAt: now - 60e3, tokens: 4200, toolCalls: 7, durationMs: 60e3, resultPreview: 'ok' };
  fs.writeFileSync(path.join(sd, 'workflows', 'wf_report1.json'), JSON.stringify({
    runId: 'wf_report1', timestamp: new Date(now - 60e3).toISOString(), workflowName: 'report-demo', summary: 'demo', status: 'completed', startTime: now - 120e3, durationMs: 60e3,
    phases: [{ title: 'Research', detail: 'read' }], defaultModel: 'claude-sonnet-5-5', workflowProgress: [agent], totalTokens: 4200, totalToolCalls: 7,
  }));
  return home;
}

test('real-tree-report: runs on a synthetic home, lists the finished run and prints the performance numbers (JSON mode)', (t) => {
  const home = tree(t);
  const r = spawnSync(process.execPath, [TOOL, '--home', home, '--session', 'none', '--warm', '3', '--no-history', '--json'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.scope, 'all');
  assert.deepEqual([j.counts.running, j.counts.recent], [0, 1]);
  assert.equal(j.rows.recent[0].name, 'report-demo');
  assert.equal(j.rows.recent[0].status, 'completed');
  assert.equal(j.rows.recent[0].agents, '1/1');
  assert.equal(j.rows.recent[0].phases, '1/1');
  for (const k of ['coldMs', 'warmMedianMs', 'forcedMedianMs', 'discoveryMedianMs']) assert.ok(Number.isFinite(j.perf[k]) && j.perf[k] >= 0, k);
  assert.deepEqual(j.warnings, []);
  assert.deepEqual(j.session.checks, [], 'the acceptance expectations apply only to the build session of this machine');
});

test('real-tree-report: text mode prints the sections; a missing projects dir is a clear error', (t) => {
  const home = tree(t);
  const r = spawnSync(process.execPath, [TOOL, '--home', home, '--session', 'none', '--warm', '2'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  for (const part of ['Claude Code Utilities real-tree report', 'RUNNING (0)', 'RECENT (1)', 'report-demo', 'perf ', 'warnings (0)']) assert.ok(r.stdout.includes(part), part);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'av-report-empty-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const e = spawnSync(process.execPath, [TOOL, '--home', empty], { encoding: 'utf8', timeout: 60000 });
  assert.equal(e.status, 2);
  assert.match(e.stderr, /no projects dir/);
});
