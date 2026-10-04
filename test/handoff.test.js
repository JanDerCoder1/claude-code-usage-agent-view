'use strict';
// lib/handoff.js: transcript digest -> Markdown file in the temp folder; session discovery; redaction.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const H = require('../lib/handoff');

const SID = '11111111-2222-4333-8444-555555555555';
const SID2 = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const T0 = Date.parse('2026-10-03T08:00:00Z');
const ts = (min) => new Date(T0 + min * 60000).toISOString();

// ---- transcript builders (shapes copied from real transcripts: chat lines start with parentUuid, bookkeeping with "type")
const base = (o, min) => Object.assign({ parentUuid: 'p', isSidechain: false, timestamp: ts(min), userType: 'external', entrypoint: 'claude-vscode', cwd: 'C:\\proj', sessionId: SID, version: '2.1.288', gitBranch: 'main' }, o);
const human = (text, min, extra) => base(Object.assign({ type: 'user', message: { role: 'user', content: text }, origin: 'human' }, extra), min);
const humanBlocks = (text, min) => base({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }, min);
const toolResult = (id, min) => base({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }, min);
const asstText = (text, min, extra) => base({ type: 'assistant', message: { model: 'claude-sonnet-5-5', id: 'm' + min, role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20, output_tokens: 9 } }, requestId: 'r' + min }, min);
const toolUse = (id, name, input, min) => base({ type: 'assistant', message: { model: 'claude-sonnet-5-5', id: 'm' + id, role: 'assistant', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 3, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, output_tokens: 4 } }, requestId: 'r' + id }, min);
const noise = [
  { type: 'queue-operation', operation: 'enqueue', timestamp: ts(0), sessionId: SID, content: 'x' },
  { type: 'file-history-snapshot', messageId: 'm', snapshot: {}, isSnapshotUpdate: false },
  { type: 'atis-latch', atis: 1, sessionId: SID },
  { parentUuid: 'p', isSidechain: false, attachment: { type: 'skill_listing', content: 'x'.repeat(2000) }, type: 'attachment', timestamp: ts(0), sessionId: SID },
  { parentUuid: 'p', isSidechain: false, type: 'system', subtype: 'stop_hook_summary', timestamp: ts(0), sessionId: SID },
];

function tmpdir(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'agent-view-handoff-test-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function writeTranscript(dir, lines, name) {
  const f = path.join(dir, name || SID + '.jsonl');
  fs.writeFileSync(f, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return f;
}

async function digest(t, lines, info) {
  const f = writeTranscript(tmpdir(t), lines);
  return H.buildHandoff(f, { now: T0 + 3600e3, info });
}

// ---------------------------------------------------------------------------------------------------------------

test('digest: asks, last answer, to-dos, files, commands, agents, pending tool and the header facts', async (t) => {
  const lines = [
    ...noise,
    human('Baue bitte eine Ansicht für laufende Agenten.', 1),
    asstText('Ich schaue mir zuerst die Dateien an.', 2),
    toolUse('t1', 'TodoWrite', { todos: [{ content: 'Ansicht bauen', status: 'completed', activeForm: 'Baue' }, { content: 'Tests schreiben', status: 'in_progress', activeForm: 'Schreibe' }, { content: 'Paket bauen', status: 'pending', activeForm: 'Baue' }] }, 3),
    toolResult('t1', 3),
    toolUse('t2', 'Edit', { file_path: 'C:\\proj\\a.js', old_string: 'x', new_string: 'y' }, 4),
    toolResult('t2', 4),
    toolUse('t3', 'Edit', { file_path: 'C:\\proj\\a.js', old_string: 'x', new_string: 'y' }, 5),
    toolResult('t3', 5),
    toolUse('t4', 'Write', { file_path: 'C:\\proj\\b.js', content: 'zzz' }, 6),
    toolResult('t4', 6),
    toolUse('t5', 'PowerShell', { command: 'node --test test', description: 'Tests laufen lassen' }, 7),
    toolResult('t5', 7),
    toolUse('t6', 'Agent', { description: 'Testagent A', prompt: 'x' }, 8),
    toolUse('t7', 'Workflow', { script: 'x' }, 8),
    toolResult('t6', 9),
    toolResult('t7', 9),
    humanBlocks('Und jetzt noch ein Knopf für den Hand-Off.', 10),
    asstText('Der Knopf ist eingebaut, die Tests laufen grün.', 11),
    toolUse('t8', 'Bash', { command: 'npm run build' }, 12),
  ];
  const r = await digest(t, lines, { name: 'coding-c8' });
  const md = r.markdown;
  assert.match(md, /^# Hand-Off: Baue bitte eine Ansicht für laufende Agenten\./);
  assert.match(md, /\*\*Auszug, keine Zusammenfassung durch Claude\*\*/);
  assert.match(md, /## So machst du in einer neuen Sitzung weiter/);
  assert.match(md, /- Name: coding-c8/);
  assert.match(md, /- Arbeitsordner: `C:\\proj`/);
  assert.match(md, /- Git-Zweig: `main`/);
  assert.match(md, /- Modell: claude-sonnet-5-5 · Claude Code 2\.1\.288 · claude-vscode/);
  assert.match(md, /- Umfang: 2 Eingaben von dir, 8 Werkzeugaufrufe, Kontext zuletzt rund 2k Tokens/);
  assert.match(md, new RegExp('Sitzungs-ID: `' + SID + '`'));
  assert.match(md, /## Zuletzt gefragt\n\n> Baue bitte eine Ansicht[^\n]*\n\n> Und jetzt noch ein Knopf/);
  assert.match(md, /## Letzter Stand \(letzte Antwort von Claude\)\n\n> Der Knopf ist eingebaut, die Tests laufen grün\./);
  assert.match(md, /- \[x\] Ansicht bauen\n- \[~\] Tests schreiben\n- \[ \] Paket bauen/);
  assert.match(md, /- `C:\\proj\\b\.js` \(1x angelegt\/überschrieben\)/);
  assert.match(md, /- `C:\\proj\\a\.js` \(2x geändert\)/);
  assert.ok(md.indexOf('b.js') < md.indexOf('a.js'), 'most recently touched file first');
  assert.match(md, /- `node --test test` – Tests laufen lassen/);
  assert.match(md, /Agent-Aufrufe: 1, Workflows: 1/);
  assert.match(md, /- zuletzt: Testagent A/);
  assert.match(md, /## Beim Hand-Off noch ohne Ergebnis[\s\S]*- Bash: npm run build/);
  assert.equal(r.stats.prompts, 2);
  assert.equal(r.stats.bad, 0);
  assert.ok(!md.includes('x'.repeat(100)), 'attachment payloads never reach the digest');
});

test('digest: notifications, tool results, meta lines, interruptions and slash plumbing are not "what you asked"', async (t) => {
  const r = await digest(t, [
    human('Die echte Frage.', 1),
    base({ type: 'user', message: { role: 'user', content: '<task-notification>fertig</task-notification>' }, origin: { kind: 'task-notification' } }, 2),
    base({ type: 'user', message: { role: 'user', content: 'Nachricht einer anderen Sitzung' }, origin: 'peer', isMeta: true }, 3),
    base({ type: 'user', message: { role: 'user', content: 'meta' }, isMeta: true }, 4),
    human('[Request interrupted by user]', 5),
    human('<command-name>/clear</command-name>', 6),
    toolResult('zz', 7),
    humanBlocks('<system-reminder>Interne Erinnerung</system-reminder>', 8),
    human('Text vor <system-reminder>geheim\nzweite Zeile</system-reminder> und danach.', 9),
    human('Eingefügt: <pasted_content id="a1">riesiger Block</pasted_content id="a1"> ende', 10),
  ]);
  const md = r.markdown;
  assert.equal(r.stats.prompts, 3);
  assert.ok(md.includes('Die echte Frage.'));
  assert.ok(!md.includes('task-notification') && !md.includes('anderen Sitzung') && !md.includes('Request interrupted') && !md.includes('/clear'));
  assert.ok(!md.includes('Interne Erinnerung') && !md.includes('geheim'));
  assert.ok(md.includes('Text vor  und danach.') || md.includes('Text vor und danach.'));
  assert.ok(md.includes('[eingefügter Text]') && !md.includes('riesiger Block'));
});

test('digest: a compaction summary of Claude Code is carried over and not counted as an ask', async (t) => {
  const r = await digest(t, [
    human('This session is being continued from a previous conversation that ran out of context. Summary: Wir bauen X.', 1),
    human('Weiter.', 2),
  ]);
  assert.equal(r.stats.prompts, 1);
  assert.match(r.markdown, /## Zusammenfassung früherer Teile \(von Claude Code beim Verdichten erstellt\)\n\n> This session is being continued[^\n]*Wir bauen X\./);
});

test('digest: very long sessions keep the head and the tail of the asks and say how many were left out', async (t) => {
  const lines = [];
  for (let i = 1; i <= 120; i++) lines.push(human('Auftrag Nummer ' + i, i));
  const r = await digest(t, lines);
  const md = r.markdown;
  assert.equal(r.stats.prompts, 120);
  assert.match(md, /Auftrag Nummer 1\b/);
  assert.match(md, /Auftrag Nummer 120\b/);
  assert.match(md, /… 75 weitere Eingaben ausgelassen …/);
  assert.ok(!md.includes('Auftrag Nummer 60\n') && !/: Auftrag Nummer 60$/m.test(md));
});

test('digest: the title is the custom title, else the first ask, else the picked info', async (t) => {
  const withTitle = await digest(t, [{ type: 'custom-title', customTitle: 'Mein Titel', sessionId: SID }, human('Frage', 1)]);
  assert.match(withTitle.markdown, /^# Hand-Off: Mein Titel/);
  const none = await digest(t, [asstText('nur eine Antwort', 1)], { name: 'coding-42' });
  assert.match(none.markdown, /^# Hand-Off: coding-42/);
});

test('digest: garbage lines, torn last line, empty file and noise-only file never throw', async (t) => {
  const d = tmpdir(t);
  const f = path.join(d, SID + '.jsonl');
  fs.writeFileSync(f, [JSON.stringify(human('Heil.', 1)), 'kein json', '{"type":"user","message":', JSON.stringify(asstText('Antwort', 2)), '{"parentUuid":"p","type":"user","mess'].join('\n'));
  const r = await H.buildHandoff(f, { now: T0 });
  assert.equal(r.stats.prompts, 1);
  assert.ok(r.stats.bad >= 2);
  assert.match(r.markdown, /Antwort/);
  fs.writeFileSync(f, '');
  assert.match((await H.buildHandoff(f, { now: T0 })).markdown, /^# Hand-Off: /);
  fs.writeFileSync(f, noise.map((x) => JSON.stringify(x)).join('\n'));
  assert.equal((await H.buildHandoff(f, { now: T0 })).stats.prompts, 0);
  await assert.rejects(H.buildHandoff(path.join(d, 'gibt-es-nicht.jsonl'), { now: T0 }), /ENOENT/);
});

test('streaming: lines are split correctly across chunk borders, with multi-byte characters', async (t) => {
  const d = tmpdir(t);
  const lines = [];
  const n = 900;
  for (let i = 0; i < n; i++) lines.push(JSON.stringify(human('Zeile ' + i + ' äöü€😀 ' + 'ß'.repeat(1500), i)));
  const f = path.join(d, SID + '.jsonl');
  fs.writeFileSync(f, lines.join('\n') + '\n');
  assert.ok(fs.statSync(f).size > 2 * 1048576, 'spans several 1 MB chunks');
  let seen = 0;
  await H.eachLine(f, (l) => { seen++; JSON.parse(l); });
  assert.equal(seen, n);
  const r = await H.buildHandoff(f, { now: T0 });
  assert.equal(r.stats.prompts, n);
  assert.equal(r.stats.bad, 0);
  assert.ok(r.markdown.includes('äöü€😀'));
});

// ---------------------------------------------------------------------------------------------------------------

test('redaction: keys, tokens, passwords and bearer headers never reach the file', async (t) => {
  const secrets = ['sk-ant-api03-ABCDEFGHIJKLMNOP', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'AKIAABCDEFGHIJKLMNOP', 'hunter2hunter2', 'Zm9vOmJhcg0123456789abcdef', 'geheimespasswort', 'abcdefghijklmnop1234', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'];
  const r = await digest(t, [
    human('Mein Schlüssel ist sk-ant-api03-ABCDEFGHIJKLMNOP und password=hunter2hunter2 bitte nutzen.', 1),
    toolUse('a', 'Bash', { command: 'curl -H "Authorization: Bearer abcdefghijklmnop1234" https://x --user me --password geheimespasswort' }, 2),
    toolUse('b', 'Bash', { command: 'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 AWS=AKIAABCDEFGHIJKLMNOP' }, 3),
    toolUse('c', 'Bash', { command: 'echo "Basic Zm9vOmJhcg0123456789abcdef" ; echo eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r' }, 4),
    asstText('Ich habe api_key: "geheimespasswort" gesehen.', 5),
  ]);
  for (const s of secrets) assert.ok(!r.markdown.includes(s), 'leaked: ' + s);
  assert.match(r.markdown, /\[entfernt\]/);
  assert.match(r.markdown, /Mein Schlüssel ist/);
});

test('redaction is linear: hostile long inputs are handled quickly', () => {
  const t0 = Date.now();
  H.redact(' '.repeat(5e5));
  H.redact('a'.repeat(5e5));
  H.redact('token='.repeat(40000));
  H.redact('password: ' + '"'.repeat(1e5));
  H.redact('Bearer ' + 'a'.repeat(1e5));
  H.cleanText('<system-reminder>' + 'x'.repeat(5e5));
  H.cleanText('<pasted_content>'.repeat(20000));
  assert.ok(Date.now() - t0 < 4000, 'took ' + (Date.now() - t0) + ' ms');
  assert.equal(H.redact(12345), '');
});

// ---------------------------------------------------------------------------------------------------------------

function withTempEnv(t) {
  const d = tmpdir(t, 'agent-view-tmpenv-');
  const keep = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = d;
  t.after(() => { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  return d;
}

test('writeHandoff: own file name in agent-view-handoff, private mode, content intact, only own old files are pruned', (t) => {
  const tmp = withTempEnv(t);
  const dir = path.join(tmp, 'agent-view-handoff');
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, 'handoff-aaaaaaaa-20200101T000000.md');
  const foreign = path.join(dir, 'notizen.md');
  const young = path.join(dir, 'handoff-bbbbbbbb-20261001T000000.md');
  for (const f of [old, foreign, young]) fs.writeFileSync(f, 'x');
  const now = T0 + 3600e3;
  fs.utimesSync(old, new Date(now - 8 * 86400e3), new Date(now - 8 * 86400e3));
  fs.utimesSync(foreign, new Date(now - 30 * 86400e3), new Date(now - 30 * 86400e3));
  fs.utimesSync(young, new Date(now - 1 * 86400e3), new Date(now - 1 * 86400e3));
  const file = H.writeHandoff('# Inhalt ä\n', SID, now);
  assert.equal(path.dirname(file), dir);
  assert.match(path.basename(file), /^handoff-11111111-20261003T090000\.md$/);
  assert.ok(H.FILE_RE.test(path.basename(file)));
  assert.equal(fs.readFileSync(file, 'utf8'), '# Inhalt ä\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0, 'readable for the owner only');
  assert.equal(fs.existsSync(old), false, 'an own file older than 7 days is removed');
  assert.equal(fs.existsSync(foreign), true, 'a foreign file is never touched');
  assert.equal(fs.existsSync(young), true);
});

test('writeHandoff: the session id cannot steer the path', (t) => {
  const tmp = withTempEnv(t);
  const file = H.writeHandoff('x', '..\\..\\evil/../' + SID, T0);
  assert.equal(path.dirname(file), path.join(tmp, 'agent-view-handoff'));
  assert.ok(H.FILE_RE.test(path.basename(file)));
});

// ---------------------------------------------------------------------------------------------------------------

function fakeHome(t, spec) {
  const home = tmpdir(t, 'agent-view-home-');
  const projects = path.join(home, 'projects');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  for (const s of spec) {
    const enc = s.enc || 'C--proj';
    fs.mkdirSync(path.join(projects, enc), { recursive: true });
    if (s.lines !== false) {
      const f = writeTranscript(path.join(projects, enc), s.lines || [human('Erste Frage ' + s.sid.slice(0, 4), 1)], s.sid + '.jsonl');
      const m = new Date(s.mtime || Date.now());
      fs.utimesSync(f, m, m);
    }
    if (s.reg) fs.writeFileSync(path.join(home, 'sessions', (s.pid || process.pid) + '.json'), JSON.stringify({ pid: s.pid || process.pid, sessionId: s.sid, cwd: s.cwd || 'C:\\proj', entrypoint: 'claude-vscode', status: s.status || 'idle', name: s.name || null, updatedAt: s.updatedAt || Date.now() }));
  }
  return home;
}

test('listSessions: live session of the workspace with its title, newest first, transcripts of ended sessions only when younger than 24 h', (t) => {
  const now = Date.now();
  const home = fakeHome(t, [
    { sid: SID, reg: true, name: 'coding-c8', status: 'busy', lines: [{ type: 'custom-title', customTitle: 'Titel A', sessionId: SID }, human('x', 1)], mtime: now - 5 * 60000 },
    { sid: SID2, reg: false, mtime: now - 3600e3, lines: [human('Wie wird das Wetter?', 1)] },
    { sid: '99999999-0000-4000-8000-000000000001', reg: false, mtime: now - 30 * 3600e3 },
  ]);
  const list = H.listSessions(home, [], now);
  assert.deepEqual(list.map((s) => s.sid), [SID, SID2]);
  assert.equal(list[0].alive, true);
  assert.equal(list[0].status, 'busy');
  assert.equal(list[0].name, 'coding-c8');
  assert.equal(list[0].title, 'Titel A');
  assert.equal(list[1].alive, false);
  assert.equal(list[1].title, 'Wie wird das Wetter?');
  assert.ok(list[0].transcript.endsWith(SID + '.jsonl'));
  assert.ok(list[0].activeAt >= now - 6 * 60000);
});

test('listSessions: a workspace folder filters, and falls back to everything when nothing matches', (t) => {
  const now = Date.now();
  const home = fakeHome(t, [
    { sid: SID, reg: true, cwd: 'C:\\proj\\sub', enc: 'C--proj-sub' },
    { sid: SID2, reg: true, pid: process.ppid || 1, cwd: 'C:\\andere', enc: 'C--andere' },
  ]);
  const only = H.listSessions(home, ['C:\\proj'], now).map((s) => s.sid);
  assert.ok(only.includes(SID));
  const none = H.listSessions(home, ['D:\\nirgendwo'], now).map((s) => s.sid);
  assert.ok(none.includes(SID), 'fallback shows the sessions that exist');
});

test('listSessions: no sessions, missing folders, garbage registry and ids that are not GUIDs never throw', (t) => {
  const home = tmpdir(t);
  assert.deepEqual(H.listSessions(home, [], Date.now()), []);
  assert.deepEqual(H.listSessions(path.join(home, 'gibt-es-nicht'), ['C:\\x'], Date.now()), []);
  fs.mkdirSync(path.join(home, 'sessions'));
  fs.writeFileSync(path.join(home, 'sessions', process.pid + '.json'), '{ kaputt');
  assert.deepEqual(H.listSessions(home, [], Date.now()), []);
  assert.equal(H.findTranscript(home, '../../etc/passwd'), null);
  assert.equal(H.findTranscript(home, 'nicht-guid'), null);
});

test('peekTitle: custom title from the end of the file (with escapes), else the first real ask without reminders', (t) => {
  const d = tmpdir(t);
  const a = writeTranscript(d, [human('Frage eins', 1), { type: 'custom-title', customTitle: 'Alt', sessionId: SID }, { type: 'custom-title', customTitle: 'Neu \u00e4\u00f6 "x"', sessionId: SID }], 'a.jsonl');
  assert.equal(H.peekTitle(a), 'Neu äö "x"');
  const b = writeTranscript(d, [base({ type: 'user', message: { role: 'user', content: 'Meta' }, isMeta: true }, 0), humanBlocks('<system-reminder>x</system-reminder>', 1), human('Die erste echte Frage', 2)], 'b.jsonl');
  assert.equal(H.peekTitle(b), 'Die erste echte Frage');
  assert.equal(H.peekTitle(path.join(d, 'weg.jsonl')), '');
});

test('shipped module obeys the global rules (no forbidden API, only fs/path/os and relative requires)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'handoff.js'), 'utf8');
  assert.ok(!/\beval\b|new\s+Function|\bvm\b|child_process|https?|innerHTML|outerHTML|document\.write/.test(src));
  assert.deepEqual([...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort(), ['./claudeHome', 'fs', 'os', 'path']);
  assert.ok(!src.includes('\r'));
});
