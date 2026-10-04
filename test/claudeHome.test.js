'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CH = require('../lib/claudeHome');

const WIN = process.platform === 'win32';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'av-home-'));
const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const SID = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

test('claudeHome: override, then env CLAUDE_CONFIG_DIR, then ~/.claude', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  try {
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.equal(CH.claudeHome(), path.join(os.homedir(), '.claude'));
    assert.equal(CH.claudeHome(''), path.join(os.homedir(), '.claude'));
    process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), 'env-home');
    assert.equal(CH.claudeHome(), path.join(os.tmpdir(), 'env-home'));
    assert.equal(CH.claudeHome('/x/override'), '/x/override');
    assert.equal(CH.claudeHome('   '), path.join(os.tmpdir(), 'env-home'));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test('encodeCwd: every non-alphanumeric becomes "-"', () => {
  assert.equal(CH.encodeCwd('C:\\Unternehmung\\Technik\\claude\\GUI'), 'C--Unternehmung-Technik-claude-GUI');
  assert.equal(CH.encodeCwd('c:\\Unternehmung\\Technik\\claude\\GUI'), 'c--Unternehmung-Technik-claude-GUI');
  assert.equal(CH.encodeCwd('C:\\Unternehmung\\Kundenprojekte\\05_Leo_Xalter_Moebel_Karmann'), 'C--Unternehmung-Kundenprojekte-05-Leo-Xalter-Moebel-Karmann');
  assert.equal(CH.encodeCwd('/Users/jan/my proj/\u00e4\u00f6.x'), '-Users-jan-my-proj----x');
  assert.equal(CH.encodeCwd(''), '');
  assert.equal(CH.encodeCwd(null), '');
});

// Source-derived: the expected values below were produced by running the algorithm verbatim from the installed Claude Code
// extension.js (2.1.287: function NB = replace(/[^a-zA-Z0-9]/g,"-"), rP = names > 200 become slice(0,200)+"-"+abs(Hr4(cwd)).toString(36)
// with Hr4 = Java-31 string hash over the ORIGINAL cwd). It cannot be checked against a real folder on this machine.
test('encodeCwd: > 200 characters appends the Java-31 hash of the original cwd (source-derived)', () => {
  const a = CH.encodeCwd('C:\\' + 'a'.repeat(230));
  assert.equal(a.length, 207);
  assert.equal(a.slice(0, 200), 'C--' + 'a'.repeat(197));
  assert.equal(a.slice(195), 'aaaaa-xecz23');
  const b = CH.encodeCwd('/home/u/' + 'proj dir \u00f6/'.repeat(30));
  assert.equal(b.length, 207);
  assert.equal(b.slice(195), 'proj--yxtt7f');
  assert.equal(CH.encodeCwd('x'.repeat(200)), 'x'.repeat(200));          // exactly 200: no hash
  assert.equal(CH.encodeCwd('x'.repeat(201)).length, 200 + 1 + CH.encodeCwd('x'.repeat(201)).split('-').pop().length);
});

test('findProjectDirs: exact name, case-insensitive on win32, tolerant of a missing projects dir', () => {
  const home = tmp(), projects = path.join(home, 'projects');
  // NTFS cannot hold 'c--X' and 'C--X' side by side, so the drive-letter spelling variants only coexist on case-sensitive file systems
  const names = ['c--Unternehmung-Technik-claude-GUI', 'C--Unternehmung-Technik-claude-GUI-sub', 'other'];
  if (!WIN) names.push('C--Unternehmung-Technik-claude-GUI');
  for (const n of names) fs.mkdirSync(path.join(projects, n), { recursive: true });
  put(path.join(projects, 'C--Unternehmung-Technik-claude'), 'a file with a matching name is not a dir');
  const got = CH.findProjectDirs(projects, 'C:\\Unternehmung\\Technik\\claude\\GUI').map(d => path.basename(d)).sort();
  if (WIN) assert.deepEqual(got, ['c--Unternehmung-Technik-claude-GUI']);          // Desktop-style cwd finds the VS Code-style folder
  else assert.deepEqual(got, ['C--Unternehmung-Technik-claude-GUI']);
  assert.deepEqual(CH.findProjectDirs(projects, 'D:\\nothing'), []);
  assert.deepEqual(CH.findProjectDirs(path.join(home, 'missing'), 'C:\\x'), []);
  assert.deepEqual(CH.findProjectDirs('', 'C:\\x'), []);
  assert.deepEqual(CH.findProjectDirs(projects, null), []);
});

test('readRegistry: only ^\\d+\\.json$, never opens *.key, garbage tolerated, liveness via kill(pid,0)', () => {
  const home = tmp(), dir = path.join(home, 'sessions');
  const mk = (pid, over) => put(path.join(dir, pid + '.json'), JSON.stringify(Object.assign({ pid, sessionId: SID(pid), cwd: 'c:\\x', entrypoint: 'claude-vscode', status: 'busy', name: 'n' + pid, updatedAt: 1234, version: '2.1.287' }, over)));
  mk(process.pid);
  mk(2147483646);
  put(path.join(dir, '4242.key'), 'SECRET-TOKEN');
  put(path.join(dir, 'abc.json'), JSON.stringify({ pid: 1, sessionId: SID(1) }));
  put(path.join(dir, '77.json'), '{not json');
  put(path.join(dir, '78.json'), JSON.stringify({ pid: 78 }));             // no sessionId
  put(path.join(dir, '79.json'), JSON.stringify([1, 2]));
  put(path.join(dir, '80.json.bak'), JSON.stringify({ pid: 80, sessionId: SID(80) }));
  const opened = [];
  const orig = fs.readFileSync;
  fs.readFileSync = function (f, ...rest) { opened.push(String(f)); return orig.call(this, f, ...rest); };
  let reg;
  try { reg = CH.readRegistry(home); } finally { fs.readFileSync = orig; }
  assert.ok(opened.length > 0);
  assert.ok(!opened.some(f => /\.key$/i.test(f)), 'a .key file was opened');
  assert.deepEqual(reg.map(r => r.pid).sort((a, b) => a - b), [process.pid, 2147483646].sort((a, b) => a - b));
  const me = reg.find(r => r.pid === process.pid), dead = reg.find(r => r.pid === 2147483646);
  assert.equal(me.alive, true);
  assert.equal(dead.alive, false);
  assert.deepEqual(Object.keys(me).sort(), ['alive', 'cwd', 'entrypoint', 'name', 'pid', 'sessionId', 'status', 'updatedAt', 'version']);
  assert.equal(me.entrypoint, 'claude-vscode');
  assert.equal(me.updatedAt, 1234);
  assert.deepEqual(CH.readRegistry(path.join(home, 'nope')), []);
  assert.equal(CH.registryAvailable(home), true);
  assert.equal(CH.registryAvailable(path.join(home, 'nope')), false);
});

test('isAlive: EPERM counts as alive, ESRCH and nonsense as dead', () => {
  const orig = process.kill;
  try {
    process.kill = () => { const e = new Error('perm'); e.code = 'EPERM'; throw e; };
    assert.equal(CH.isAlive(123), true);
    process.kill = () => { const e = new Error('gone'); e.code = 'ESRCH'; throw e; };
    assert.equal(CH.isAlive(123), false);
  } finally { process.kill = orig; }
  assert.equal(CH.isAlive(0), false);
  assert.equal(CH.isAlive(-5), false);
  assert.equal(CH.isAlive(NaN), false);
  assert.equal(CH.isAlive('12'), false);
  assert.equal(CH.isAlive(process.pid), true);
});

test('cwdInside: equal or below, separators and trailing slash normalised', () => {
  const f = WIN ? 'C:\\Work\\proj\\' : '/work/proj/';
  const sub = WIN ? 'c:/work/PROJ/sub/dir' : '/work/proj/sub/dir';
  const same = WIN ? 'c:\\work\\proj' : '/work/proj';
  const sibling = WIN ? 'c:\\work\\proj2' : '/work/proj2';
  assert.equal(CH.cwdInside(sub, f), true);
  assert.equal(CH.cwdInside(same, f), true);
  assert.equal(CH.cwdInside(sibling, f), false);
  assert.equal(CH.cwdInside('', f), false);
  assert.equal(CH.cwdInside(same, ''), false);
  assert.equal(CH.cwdInside(null, null), false);
});

test('SessionIndex joins one sessionId across project folders; ignores non-guid names', () => {
  const home = tmp(), projects = path.join(home, 'projects');
  put(path.join(projects, 'pA', SID(1) + '.jsonl'), '{}\n');
  fs.mkdirSync(path.join(projects, 'pA', SID(1)), { recursive: true });
  fs.mkdirSync(path.join(projects, 'pB', SID(1), 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(projects, 'pB', SID(2)), { recursive: true });
  put(path.join(projects, 'pB', 'memory.md'), 'x');
  put(path.join(projects, 'pB', 'not-a-guid.jsonl'), '{}');
  put(path.join(projects, 'loose-file.jsonl'), '{}');
  const idx = new CH.SessionIndex();
  const m = idx.scan(projects, Date.now());
  assert.deepEqual([...m.keys()].sort(), [SID(1), SID(2)]);
  const e1 = m.get(SID(1)).entries;
  assert.equal(e1.length, 2);
  assert.ok(e1.some(e => e.transcript && e.sessionDir && path.basename(e.projDir) === 'pA'));
  assert.ok(e1.some(e => !e.transcript && e.sessionDir && path.basename(e.projDir) === 'pB'));
  assert.equal(m.get(SID(2)).entries[0].transcript, null);
  // a new session created right after the first scan is seen by the next one (listing cache is not trusted this early)
  put(path.join(projects, 'pB', SID(3) + '.jsonl'), '{}');
  assert.ok(idx.scan(projects, Date.now()).has(SID(3)));
  assert.equal(new CH.SessionIndex().scan(path.join(home, 'missing'), 0).size, 0);
});

test('sessionActivity: transcript, plain agents, unfinished run dirs; finished runs are skipped', () => {
  const home = tmp(), sd = path.join(home, 'projects', 'p', SID(1));
  const t0 = Date.now() / 1000;
  const touch = (f, ageSec) => { put(f, '{}\n'); fs.utimesSync(f, t0 - ageSec, t0 - ageSec); };
  const transcript = path.join(home, 'projects', 'p', SID(1) + '.jsonl');
  touch(transcript, 5000);
  touch(path.join(sd, 'subagents', 'agent-aaa.jsonl'), 4000);
  touch(path.join(sd, 'subagents', 'agent-aaa.meta.json'), 1);                        // meta files do not count
  touch(path.join(sd, 'subagents', 'workflows', 'wf_done', 'agent-d1.jsonl'), 10);       // finished run: skipped
  touch(path.join(sd, 'workflows', 'wf_done.json'), 9);
  touch(path.join(sd, 'subagents', 'workflows', 'wf_live', 'journal.jsonl'), 3000);
  touch(path.join(sd, 'subagents', 'workflows', 'wf_live', 'agent-l1.jsonl'), 2000);
  const entries = [{ projDir: path.dirname(sd), sessionDir: sd, transcript }];
  const age = ms => Math.round((Date.now() - ms) / 1000);
  assert.ok(Math.abs(age(CH.sessionActivity(entries)) - 2000) < 3);
  touch(path.join(sd, 'subagents', 'workflows', 'wf_live', 'agent-l1.jsonl'), 100);
  assert.ok(Math.abs(age(CH.sessionActivity(entries)) - 100) < 3);
  assert.ok(CH.cheapActivity(entries) > 0);
  assert.equal(CH.sessionActivity([{ projDir: 'x', sessionDir: null, transcript: null }]), 0);
  assert.equal(CH.sessionActivity([{ projDir: 'x', sessionDir: path.join(home, 'gone'), transcript: path.join(home, 'gone.jsonl') }]), 0);
});
