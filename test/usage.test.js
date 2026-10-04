'use strict';
// lib/usage.js: the cache Claude Code keeps in its global config file -> usage windows for the view header.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { UsageReader, parseUsage, claudeJsonCandidates } = require('../lib/usage');
const SessionModel = require('../lib/sessionModel');

// the shape Claude Code writes (values from a real file; percentages are examples)
const sample = () => ({
  userID: 'not-this', oauthAccount: { emailAddress: 'must-never-leak@example.com' },
  cachedUsageUtilization: {
    fetchedAtMs: 1791010076522, accountUuid: 'abb078be-a6ca-40a2-9b96-de2e54cf01cd',
    utilization: {
      five_hour: { utilization: 94, resets_at: '2026-10-03T07:19:59.657367+00:00' },
      seven_day: { utilization: 27, resets_at: '2026-10-09T09:59:59.657392+00:00' },
      limits: [
        { kind: 'session', group: 'session', percent: 94, severity: 'critical', resets_at: '2026-10-03T07:19:59.657367+00:00', scope: null, is_active: true },
        { kind: 'weekly_all', group: 'weekly', percent: 27, severity: 'normal', resets_at: '2026-10-09T09:59:59.657392+00:00', scope: null, is_active: false },
        { kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal', resets_at: '2026-10-09T10:00:00+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
      ],
    },
  },
});

function tmpHome(t, json) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-view-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (json !== undefined) fs.writeFileSync(path.join(dir, '.claude.json'), typeof json === 'string' ? json : JSON.stringify(json));
  return dir;
}

test('parseUsage: five-hour and weekly window, reset rounded to the minute', () => {
  const u = parseUsage(sample());
  assert.equal(u.fetchedAt, 1791010076522);
  assert.deepEqual(u.windows.map((w) => w.id), ['five_hour', 'weekly']);
  assert.deepEqual(u.windows[0], { id: 'five_hour', label: '5-Stunden-Limit', percent: 94, resetsAt: Date.parse('2026-10-03T07:20:00Z'), severity: 'critical' });
  assert.equal(u.windows[1].percent, 27);
  assert.equal(u.windows[1].resetsAt, Date.parse('2026-10-09T10:00:00Z'));
});

test('parseUsage: a model-specific weekly limit (Fable and the like) is never shown, not even when it is in use', () => {
  const j = sample();
  j.cachedUsageUtilization.utilization.limits[2].percent = 12;
  const u = parseUsage(j);
  assert.deepEqual(u.windows.map((w) => w.id), ['five_hour', 'weekly']);
  assert.ok(!JSON.stringify(u).includes('Fable'));
  j.cachedUsageUtilization.utilization.limits = [j.cachedUsageUtilization.utilization.limits[2]];
  assert.equal(parseUsage(j).windows.map((w) => w.id).join(), 'five_hour,weekly', 'the fallback fields are used when only a scoped limit is listed');
});

test('parseUsage: falls back to five_hour / seven_day when limits[] is missing', () => {
  const j = sample();
  delete j.cachedUsageUtilization.utilization.limits;
  const u = parseUsage(j);
  assert.deepEqual(u.windows.map((w) => [w.id, w.percent]), [['five_hour', 94], ['weekly', 27]]);
  assert.equal(u.windows[0].severity, null);
});

test('parseUsage: garbage never throws and yields null or clamped values', () => {
  for (const bad of [null, undefined, 5, 'x', [], {}, { cachedUsageUtilization: 5 }, { cachedUsageUtilization: {} },
    { cachedUsageUtilization: { fetchedAtMs: 'x', utilization: {} } }, { cachedUsageUtilization: { fetchedAtMs: 1, utilization: { limits: 'x' } } },
    { cachedUsageUtilization: { fetchedAtMs: 1, utilization: { limits: [null, 1, 'x', {}, { kind: 'session' }] } } }]) {
    assert.equal(parseUsage(bad), null, JSON.stringify(bad));
  }
  const j = sample();
  j.cachedUsageUtilization.utilization.limits[0].percent = 1e9;
  j.cachedUsageUtilization.utilization.limits[0].resets_at = 'not a date';
  j.cachedUsageUtilization.utilization.limits[0].severity = '<script>';
  const w = parseUsage(j).windows[0];
  assert.equal(w.percent, 100);
  assert.equal(w.resetsAt, null);
  assert.equal(w.severity, null);
  const dupes = sample();
  dupes.cachedUsageUtilization.utilization.limits.push(JSON.parse(JSON.stringify(dupes.cachedUsageUtilization.utilization.limits[0])));
  assert.equal(parseUsage(dupes).windows.filter((x) => x.id === 'five_hour').length, 1);
});

test('only the one key is taken: nothing else of the config file reaches the result', () => {
  const u = parseUsage(sample());
  const json = JSON.stringify(u);
  assert.ok(!json.includes('must-never-leak'));
  assert.ok(!json.includes('not-this'));
  assert.ok(!json.includes('abb078be'), 'the account id is dropped too');
  assert.deepEqual(Object.keys(u).sort(), ['fetchedAt', 'windows']);
});

test('claudeJsonCandidates: default home -> ~/.claude.json; custom config dir -> <dir>/.claude.json and never the real home file', () => {
  assert.deepEqual(claudeJsonCandidates(path.join(os.homedir(), '.claude')), [path.join(os.homedir(), '.claude.json')]);
  assert.deepEqual(claudeJsonCandidates(''), [path.join(os.homedir(), '.claude.json')]);
  const custom = path.join(os.tmpdir(), 'somewhere-else');
  assert.deepEqual(claudeJsonCandidates(custom), [path.join(custom, '.claude.json')]);
});

test('UsageReader: reads the file, caches by size+mtime, parses again only after the minimum gap', (t) => {
  const dir = tmpHome(t, sample());
  const r = new UsageReader();
  const a = r.read(dir, 1000);
  assert.equal(a.windows.length, 2);
  assert.equal(r.read(dir, 1500), a, 'same object while nothing changed');
  const j = sample();
  j.cachedUsageUtilization.fetchedAtMs = 5;
  j.cachedUsageUtilization.utilization.limits[0].percent = 50;
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(j) + ' ');
  assert.equal(r.read(dir, 2000), a, 'within the 3 s gap the previous parse is kept');
  const b = r.read(dir, 4500);
  assert.equal(b.fetchedAt, 5);
  assert.equal(b.windows[0].percent, 50);
});

test('UsageReader: missing, empty, corrupt, directory and oversized files give null and never throw', (t) => {
  const r = new UsageReader();
  assert.equal(r.read(tmpHome(t), 0), null, 'missing');
  assert.equal(r.read(tmpHome(t, ''), 0), null, 'empty');
  assert.equal(r.read(tmpHome(t, '{ not json'), 0), null, 'corrupt');
  assert.equal(r.read(tmpHome(t, '{}'), 0), null, 'no usage key');
  const d = tmpHome(t);
  fs.mkdirSync(path.join(d, '.claude.json'));
  assert.equal(r.read(d, 0), null, 'a directory');
});

test('SessionModel: usage is part of the ViewState, hashed, and switched off by usageEnabled=false', (t) => {
  const dir = tmpHome(t, sample());
  const m = new SessionModel({ claudeHome: dir, scope: 'all', workspaceFolders: [], recentHours: 24, staleMinutes: 10, showToolTargets: true, etaEnabled: false, usageEnabled: true, history: null });
  t.after(() => m.dispose());
  const vs = m.refresh(1000);
  assert.equal(vs.usage.windows[0].id, 'five_hour');
  const h1 = m.stateHash(vs);
  const j = sample();
  j.cachedUsageUtilization.utilization.limits[0].percent = 40;
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(j));
  const vs2 = m.refresh(9000);
  assert.equal(vs2.usage.windows[0].percent, 40);
  assert.notEqual(m.stateHash(vs2), h1, 'a changed percentage is a changed state (it gets pushed)');
  m.setOptions({ usageEnabled: false });
  assert.equal('usage' in m.refresh(20000), false);
});

test('SessionModel without any usage file has no usage key', (t) => {
  const m = new SessionModel({ claudeHome: tmpHome(t), scope: 'all', workspaceFolders: [], recentHours: 24, staleMinutes: 10, showToolTargets: true, etaEnabled: false, history: null });
  t.after(() => m.dispose());
  assert.equal('usage' in m.refresh(1000), false);
});
