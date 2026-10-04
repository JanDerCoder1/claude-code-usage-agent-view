'use strict';
// Regression tests for the findings of the independent review (security / vscode-runtime / data-fidelity). Every test here fails
// on the code as reviewed and passes with the fixes. Names carry the lens and the finding id ("sec F1" = security F1, ...).
// Timing assertions use inputs that cost seconds on the old quadratic code and milliseconds on the fixed code.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CH = require('../lib/claudeHome');
const eta = require('../lib/eta');
const { History } = require('../lib/history');
const { parseJournal } = require('../lib/journal');
const { Tail } = require('../lib/tail');
const { AgentTracker, foldLines } = require('../lib/agentFold');
const SessionModel = require('../lib/sessionModel');
const S = require('../lib/strings');
const W = require('../media/main.js');

const ROOT = path.join(__dirname, '..');
const PRISTINE_LOAD = Module._load;   // the editor stub of bootShell is always hooked on top of the real loader
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const WIN = process.platform === 'win32';
const NOW = Date.now();
const MIN = 60e3;
const SID = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const J = (o) => JSON.stringify(o);
const timed = (fn) => { const t0 = process.hrtime.bigint(); const r = fn(); return { r, ms: Number(process.hrtime.bigint() - t0) / 1e6 }; };

// ---------------------------------------------------------------- synthetic tree + model helpers
const trees = [];
test.after(() => { for (const d of trees) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } } });
function touch(file, text, ageMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const t = (NOW - (ageMs || 0)) / 1000;
  fs.utimesSync(file, t, t);
}
class Tree {
  constructor() { this.home = fs.mkdtempSync(path.join(os.tmpdir(), 'av-rg-')); trees.push(this.home); this.projects = path.join(this.home, 'projects'); fs.mkdirSync(this.projects); }
  sd(proj, sid) { return path.join(this.projects, proj, sid); }
  transcript(proj, sid, ageMs, text) { touch(path.join(this.projects, proj, sid + '.jsonl'), text || '{}\n', ageMs); }
  runDir(proj, sid, run) { return path.join(this.sd(proj, sid), 'subagents', 'workflows', run); }
  journal(proj, sid, run, rows, ageMs, raw) { touch(path.join(this.runDir(proj, sid, run), 'journal.jsonl'), raw !== undefined ? raw : rows.map(J).join('\n') + '\n', ageMs); }
  agent(proj, sid, run, id, spec, ageMs) { touch(path.join(this.runDir(proj, sid, run), 'agent-' + id + '.jsonl'), typeof spec === 'string' ? spec : J(spec || {}), ageMs); }
  result(proj, sid, run, obj, ageMs) { touch(path.join(this.sd(proj, sid), 'workflows', run + '.json'), typeof obj === 'string' ? obj : J(obj), ageMs); }
  plain(proj, sid, id, spec, meta, ageMs) {
    const d = path.join(this.sd(proj, sid), 'subagents');
    touch(path.join(d, 'agent-' + id + '.jsonl'), typeof spec === 'string' ? spec : J(spec || {}), ageMs);
    if (meta) touch(path.join(d, 'agent-' + id + '.meta.json'), J(meta), ageMs);
  }
  registry(...entries) {
    fs.mkdirSync(path.join(this.home, 'sessions'), { recursive: true });
    entries.forEach((e, i) => { const pid = e.pid || process.pid + i; touch(path.join(this.home, 'sessions', pid + '.json'), J(Object.assign({ pid, sessionId: e.sid, cwd: '', entrypoint: 'claude-vscode', status: 'busy', name: null, version: '2.1.287' }, e.over || {}, { pid }))); });
  }
}
const tree = () => new Tree();

const baseSnap = () => ({ missing: false, loading: false, badLines: 0, size: 0, mtimeMs: 0, id: null, model: { id: null, label: null }, tokens: 0, toolUses: 0, firstTs: null, lastTs: null, end: 'running', activity: null, failure: null, resultPreview: null });
class FakeTracker {      // an agent file is a JSON object that becomes the snapshot
  constructor(file) { this.file = file; }
  poll() {
    let st;
    try { st = fs.statSync(this.file); } catch (_) { return Object.assign(baseSnap(), { missing: true }); }
    let spec = {};
    try { spec = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { /* default snapshot */ }
    return Object.assign(baseSnap(), spec, { size: st.size, mtimeMs: st.mtimeMs });
  }
  dispose() {}
}
const quietEta = { estimateAgent: () => ({ kind: 'none', basis: 'none', lo: null, mid: null, hi: null, text: '', tip: '' }), estimateWorkflow: () => ({ kind: 'none', basis: 'none', lo: null, mid: null, hi: null, text: '', tip: '' }) };
function mk(t, over) {
  const o = Object.assign({ claudeHome: t.home, scope: 'all', workspaceFolders: [], recentHours: 24, staleMinutes: 10, showToolTargets: true, etaEnabled: false, history: null }, over);
  const deps = Object.assign({ AgentTracker: FakeTracker, extractMetaSafe: () => null, eta: quietEta, prettyModel: (id) => (id ? 'P:' + id : null) }, o.deps);
  delete o.deps;
  return new SessionModel(Object.assign(o, { deps }));
}
const snap = (over, ageStartMs, ageLastMs) => Object.assign({ firstTs: NOW - (ageStartMs || 0), lastTs: NOW - (ageLastMs === undefined ? 1000 : ageLastMs), tokens: 1000, toolUses: 2, model: { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' } }, over);
const resultFile = (over, agents) => Object.assign({
  runId: 'wf_r', timestamp: new Date(NOW - 10 * MIN).toISOString(), durationMs: 120e3, summary: 'What the run did', workflowName: 'demo', status: 'completed', startTime: NOW - 12 * MIN, defaultModel: 'claude-opus-5',
  phases: [{ title: 'Research', detail: 'read' }],
  workflowProgress: [{ type: 'workflow_phase', index: 1, title: 'Research' }].concat(agents), totalTokens: 5000, totalToolCalls: 40,
}, over);
const wa = (o) => Object.assign({ type: 'workflow_agent', index: 1, label: 'a', phaseIndex: 1, phaseTitle: 'Research', agentId: 'x1', model: 'claude-opus-5', state: 'done', startedAt: NOW - 700e3, attempt: 1, lastProgressAt: NOW - 600e3, tokens: 1000, toolCalls: 10, durationMs: 100e3, resultPreview: '{"a":1}' }, o);
const allCards = (vs) => vs.running.concat(vs.recent);
const wfCards = (vs) => allCards(vs).filter((c) => c.kind === 'workflow');

/** Counts the whole-file reads and opens of paths matching `re` while `fn` runs. */
function spyFs(re, fn) {
  const reads = [], opens = [];
  const rf = fs.readFileSync, of = fs.openSync;
  fs.readFileSync = function (f, ...r) { if (typeof f === 'string' && re.test(f)) reads.push(f); return rf.call(this, f, ...r); };
  fs.openSync = function (f, ...r) { if (typeof f === 'string' && re.test(f)) opens.push(f); return of.call(this, f, ...r); };
  try { fn(); } finally { fs.readFileSync = rf; fs.openSync = of; }
  return { reads, opens };
}

// ================================================================ security F1 + vscode-runtime F4: agentView.claudeHome from a workspace

test('sec F1 / rt F4: claudeHome is machine-scoped, so a repository cannot set it', () => {
  const p = pkg.contributes.configuration.properties['agentView.claudeHome'];
  assert.equal(p.scope, 'machine', 'machine-overridable would still let a workspace override it');
  assert.match(p.description, /absolute/i);
});

test('sec F1: localAbsolutePath / claudeHome refuse UNC, relative and malformed values', () => {
  const abs = WIN ? 'C:\\Users\\x\\.claude' : '/home/x/.claude';
  assert.equal(CH.localAbsolutePath('  ' + abs + '  '), abs);
  assert.equal(CH.localAbsolutePath('rel/dir'), null);
  assert.equal(CH.localAbsolutePath('.claude'), null);
  assert.equal(CH.localAbsolutePath(''), null);
  assert.equal(CH.localAbsolutePath(null), null);
  assert.equal(CH.localAbsolutePath({ toString: () => abs }), null);
  assert.equal(CH.localAbsolutePath(abs + '\0'), null);
  assert.equal(CH.localAbsolutePath(abs + 'x'.repeat(5000)), null);
  if (WIN) {
    for (const unc of ['\\\\attacker.invalid\\share', '//attacker.invalid/share', '\\\\attacker.invalid@80\\share', '\\\\?\\UNC\\host\\share', '\\\\.\\C:', 'C:relative']) {
      assert.equal(CH.localAbsolutePath(unc), null, unc);
    }
  }
  const saved = process.env.CLAUDE_CONFIG_DIR;
  try {
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.equal(CH.claudeHome(abs), abs);
    assert.equal(CH.claudeHome('rel/dir'), path.join(os.homedir(), '.claude'));
    if (WIN) assert.equal(CH.claudeHome('\\\\attacker.invalid\\share'), path.join(os.homedir(), '.claude'));
  } finally { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved; }
});

// A compact editor stub (the shell of extension.js with the genuine claudeHome module and fake model / history / poller).
function bootShell(t, cfg) {
  const st = { agentView: Object.assign({ scope: 'workspace', recentHours: 24, claudeHome: '', showToolTargets: true, pollMs: 1500, staleMinutes: 10, 'eta.enabled': true }, cfg.agentView),
    claudeCode: cfg.claudeCode || {}, lines: [], listeners: [], models: [], bootstrapped: [] };
  const mkd = () => ({ dispose() {} });
  const vscode = {
    Uri: { file: (p) => ({ scheme: 'file', fsPath: p, path: p }), joinPath: (b, ...s) => ({ scheme: 'file', fsPath: path.join(b.fsPath, ...s), path: path.join(b.fsPath, ...s) }) },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    window: { createOutputChannel: () => ({ appendLine: (l) => st.lines.push(l), dispose() {} }), registerWebviewViewProvider: () => mkd(), showWarningMessage: async () => undefined, showInformationMessage: async () => undefined },
    commands: { registerCommand: () => mkd(), executeCommand: async () => undefined },
    workspace: {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: path.join(os.tmpdir(), 'rg-ws') } }],
      getConfiguration(section) {
        if (section === 'agentView') return { get: (k) => st.agentView[k], inspect: () => ({}), update: async () => undefined };
        // claudeCode: the stub returns the workspace value from get() too, like VS Code does for a setting nobody registered
        return { get: (k) => (st.claudeCode.workspaceValue !== undefined ? st.claudeCode.workspaceValue : st.claudeCode.globalValue), inspect: (k) => ({ key: k, globalValue: st.claudeCode.globalValue, workspaceValue: st.claudeCode.workspaceValue }) };
      },
      onDidChangeConfiguration(fn) { st.listeners.push(fn); return mkd(); },
      onDidChangeWorkspaceFolders() { return mkd(); },
    },
  };
  class FakeModel { constructor(o) { this.opts = Object.assign({}, o); this.calls = []; st.models.push(this); } refresh() { return { v: 1, now: 0, scope: 'all', scopeLabel: '', claudeHome: '', running: [], recent: [], warnings: [], formatNote: null }; } setOptions(p) { this.calls.push(p); Object.assign(this.opts, p); } hasActivity() { return false; } watchRoots() { return []; } stateHash() { return 'h'; } dispose() {} }
  class FakeHistory { constructor() {} load() {} snapshot() { return {}; } bootstrap(h) { st.bootstrapped.push(h); return Promise.resolve(); } flush() {} reset() {} dispose() {} }
  class FakePoller { constructor() { this.running = false; } start() {} stop() {} requestTick() {} setPollMs() {} dispose() {} }
  const libs = { './lib/sessionModel': { SessionModel: FakeModel }, './lib/history': { History: FakeHistory }, './lib/poller': { Poller: FakePoller } };
  const pristine = PRISTINE_LOAD;
  Module._load = function (request, parent) {
    if (request === 'vscode') return vscode;
    if (parent && path.basename(parent.filename || '') === 'extension.js' && Object.prototype.hasOwnProperty.call(libs, request)) return libs[request];
    return pristine.apply(this, arguments);
  };
  const EXT = path.join(ROOT, 'extension.js');
  delete require.cache[EXT];
  const ext = require(EXT);
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'av-rg-st-'));
  trees.push(storage);
  t.after(() => { try { ext.deactivate(); } catch (_) { /* ignore */ } Module._load = pristine; delete require.cache[EXT]; });
  const context = { subscriptions: [], extensionUri: vscode.Uri.file(ROOT), globalStorageUri: vscode.Uri.file(path.join(storage, 'g')) };
  return { st, ext, activate: () => ext.activate(context), fire: (affects) => st.listeners.forEach((fn) => fn({ affectsConfiguration: (s) => s === affects })), model: () => st.models[st.models.length - 1] };
}
function withEnv(value, fn) {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  if (value === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = value;
  try { return fn(); } finally { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved; }
}

test('sec F1: the shell ignores a UNC or relative agentView.claudeHome, never hands it to the model or the history bootstrap, and logs why (without the value)', (t) => {
  const bad = WIN ? '\\\\attacker.invalid\\share' : 'relative/dir';
  const home = path.join(os.tmpdir(), 'rg-fallback-home');
  withEnv(home, () => {
    const e = bootShell(t, { agentView: { claudeHome: bad } });
    e.activate();
    assert.equal(e.model().opts.claudeHome, home, 'falls back to the environment');
    assert.ok(e.st.lines.some((l) => /claudeHome ignoriert/.test(l)));
    assert.ok(!e.st.lines.some((l) => l.includes('attacker')), 'the refused value is not logged');
    assert.notEqual(e.model().opts.claudeHome, bad);
  });
});

test('rt F2: CLAUDE_CONFIG_DIR from the Claude Code setting claudeCode.environmentVariables moves the directory (user level only)', (t) => {
  const envHome = path.join(os.tmpdir(), 'rg-env-home'), ccHome = path.join(os.tmpdir(), 'rg-cc-home'), mine = path.join(os.tmpdir(), 'rg-own-home');
  withEnv(envHome, () => {
    const e = bootShell(t, { claudeCode: { globalValue: [{ name: 'FOO', value: 'x' }, { name: WIN ? 'claude_config_dir' : 'CLAUDE_CONFIG_DIR', value: ccHome }] } });
    e.activate();
    assert.equal(e.model().opts.claudeHome, ccHome, 'the setting beats the process environment, as it does for the Claude Code CLI');
    e.st.agentView.claudeHome = mine;
    e.fire('agentView');
    assert.equal(e.model().opts.claudeHome, mine, 'our own setting beats both');

    const e2 = bootShell(t, { claudeCode: { workspaceValue: [{ name: 'CLAUDE_CONFIG_DIR', value: ccHome }] } });
    e2.activate();
    assert.equal(e2.model().opts.claudeHome, envHome, 'a value from a repository (workspace level) is ignored');

    const e3 = bootShell(t, { claudeCode: { globalValue: [{ name: 'CLAUDE_CONFIG_DIR', value: 'relative' }] } });
    e3.activate();
    assert.equal(e3.model().opts.claudeHome, envHome, 'relative values are ignored, as in Claude Code');

    const e4 = bootShell(t, { claudeCode: { globalValue: [] } });
    e4.activate();
    e4.st.claudeCode.globalValue = [{ name: 'CLAUDE_CONFIG_DIR', value: ccHome }];
    e4.fire('claudeCode.environmentVariables');
    assert.equal(e4.model().opts.claudeHome, ccHome, 'a change of that setting is picked up');
  });
});

test('rt F2: configDirFromEnvSetting follows the Claude Code rules (array or object, last valid entry wins, absolute only)', () => {
  const a = WIN ? 'D:\\one' : '/one', b = WIN ? 'E:\\two' : '/two';
  assert.equal(CH.configDirFromEnvSetting([{ name: 'CLAUDE_CONFIG_DIR', value: a }, { name: 'CLAUDE_CONFIG_DIR', value: b }]), b);
  assert.equal(CH.configDirFromEnvSetting([{ name: 'CLAUDE_CONFIG_DIR', value: a }, { name: 'CLAUDE_CONFIG_DIR', value: 'relative' }]), a, 'an invalid later entry does not hide a valid one');
  assert.equal(CH.configDirFromEnvSetting({ CLAUDE_CONFIG_DIR: b }), b);
  assert.equal(CH.configDirFromEnvSetting([{ name: 'PATH', value: a }, null, 5, { value: a }]), null);
  assert.equal(CH.configDirFromEnvSetting('CLAUDE_CONFIG_DIR=' + a), null);
  assert.equal(CH.configDirFromEnvSetting(undefined), null);
  if (WIN) assert.equal(CH.configDirFromEnvSetting([{ name: 'CLAUDE_CONFIG_DIR', value: '\\\\host\\share' }]), null, 'no UNC');
});

// ================================================================ security F2: quadratic regular expressions

test('sec F2: stripRetry and labelPrefix are linear on long whitespace and digit runs, and keep their meaning', () => {
  const N = 60000;
  const spaces = ' '.repeat(N) + 'x', digits = '1'.repeat(N) + 'x';
  assert.ok(timed(() => eta.stripRetry(spaces)).ms < 400, 'stripRetry on whitespace');
  assert.ok(timed(() => eta.stripRetry('a' + ' '.repeat(N) + 'b')).ms < 400, 'stripRetry on an inner whitespace run');
  assert.ok(timed(() => eta.labelPrefix(digits)).ms < 400, 'labelPrefix on digits');
  assert.ok(timed(() => eta.labelPrefix(digits + ':y')).ms < 400);
  assert.equal(eta.stripRetry('name  (retry 2)  '), 'name');
  assert.equal(eta.stripRetry('name (RETRY 12)'), 'name');
  assert.equal(eta.stripRetry('a b  '), 'a b  ', 'a label without the suffix is returned unchanged');
  assert.equal(eta.stripRetry('(retry 1) middle'), '(retry 1) middle');
  assert.equal(eta.stripRetry(null), '');
  assert.equal(eta.labelPrefix('Prüfe:Foo'), 'pruefe');
  assert.equal(eta.labelPrefix('gegen2:x'), 'gegen');
  assert.equal(eta.labelPrefix('Fassung A 12'), 'fassung a ', 'trailing digits are cut, the space before them stays (as before)');
  assert.equal(eta.labelPrefix('x'.repeat(1000)).length, 300);
});

test('sec F2: cwdInside is linear on a long run of separators', () => {
  const run = '/'.repeat(60000) + 'x';
  assert.ok(timed(() => CH.cwdInside(run, '/a')).ms < 400);
  assert.equal(CH.cwdInside('/a/b///', '/a'), true);
  assert.equal(CH.cwdInside('/a///', '/a//'), true);
  assert.equal(CH.cwdInside('/ab', '/a'), false);
});

test('sec F2 / F3: a whitespace label of 80000 characters is cut at parse time and costs a refresh nothing', () => {
  const j = parseJournal(J({ type: 'started', key: 'k', agentId: 'a1', label: ' '.repeat(80000) + 'x', phase: ' '.repeat(80000) + 'p' }) + '\n');
  assert.ok(j.slots[0].label.length <= 200 && j.slots[0].phase.length <= 100);
  const t = tree(), P = 'c--p', sid = SID(1);
  t.transcript(P, sid, 1000); t.registry({ sid });
  t.journal(P, sid, 'wf_big', [{ type: 'started', key: 'k', agentId: 'a1', label: ' '.repeat(80000) + 'x', phase: 'P' }], 500);
  t.agent(P, sid, 'wf_big', 'a1', snap({}, 9e4, 1000));
  const m = mk(t);
  const { r: vs, ms } = timed(() => m.refresh(NOW));
  assert.ok(ms < 1000, 'refresh took ' + ms);
  assert.ok(JSON.stringify(vs).length < 20e3, 'the label did not reach the view state: ' + JSON.stringify(vs).length);
  assert.deepEqual(vs.warnings, []);
});

// ================================================================ security F3: no size bounds between disk and webview

test('sec F3: a journal with thousands of phases stays inside the state cap and the phase limit, in linear time', () => {
  const t = tree(), P = 'c--p', sid = SID(2);
  t.transcript(P, sid, 1000); t.registry({ sid });
  const n = 3000;
  t.journal(P, sid, 'wf_wide', Array.from({ length: n }, (_, i) => ({ type: 'started', key: 'k' + i, agentId: 'a' + i, label: 'l' + i, phase: 'Phase ' + i })), 500);
  const m = mk(t);
  const { r: vs, ms } = timed(() => m.refresh(NOW));
  const c = wfCards(vs)[0];
  assert.ok(c.phases.length <= 200, 'phases listed: ' + c.phases.length);
  assert.equal(c.agentsTotal, n, 'the counters still cover every agent');
  assert.ok(JSON.stringify(vs).length <= 150e3, 'state size ' + JSON.stringify(vs).length);
  assert.ok(ms < 3000, 'refresh took ' + ms);
});

test('sec F3: buildPhases groups in one pass (thousands of phases are not quadratic)', () => {
  const n = 20000;
  const agents = Array.from({ length: n }, (_, i) => ({ id: 'a' + i, phase: 'P' + i, state: 'done', startedAt: i }));
  const { r, ms } = timed(() => SessionModel.buildPhases([], agents, []));
  assert.ok(ms < 1500, 'buildPhases took ' + ms);
  assert.ok(r.length <= 200);
  assert.equal(r.reduce((s, p) => s + p.total, 0) > 0, true);
});

test('sec F3: huge texts are cut where they enter the model: result file labels, phases, models; journal and transcript fields', () => {
  const t = tree(), P = 'c--p', sid = SID(3);
  const big = 'Z'.repeat(2e6);
  t.transcript(P, sid, 5 * MIN);
  t.result(P, sid, 'wf_t', resultFile({ runId: 'wf_t', phases: [{ title: big, detail: big }] }, [wa({ label: big, agentId: big, phaseTitle: big, model: big, agentType: big })]), 5 * MIN);
  const vs = mk(t).refresh(NOW);
  const c = wfCards(vs)[0];
  const a = c.phases[0].agents[0];
  assert.ok(a.label.length <= 200 && a.id.length <= 64 && a.model.id.length <= 80 && a.agentType.length <= 80);
  assert.ok(c.phases[0].title.length <= 100 && c.phases[0].detail.length <= 600);
  assert.ok(JSON.stringify(vs).length < 20e3);
  const st = foldLines([{ type: 'assistant', agentId: big, message: { model: big, content: [{ type: 'tool_use', id: 't', name: big, input: {} }], usage: {} } },
    { type: 'assistant', isApiErrorMessage: true, error: big, apiErrorStatus: 500, message: { content: [] } }]);
  assert.ok(st.model.length <= 80 && st.id.length <= 64 && st.last.error.length <= 160);
  assert.ok([...st.pending.values()].every((p) => p.name.length <= 64));
});

test('sec F3: Tail never keeps more than CARRY_MAX bytes of a line without newline; the next line after the garbage is still read', () => {
  const { CARRY_MAX } = require('../lib/tail');
  assert.equal(typeof CARRY_MAX, 'number');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-rg-tail-'));
  trees.push(dir);
  const f = path.join(dir, 'x.jsonl');
  fs.writeFileSync(f, Buffer.alloc(CARRY_MAX + 1024 * 1024, 0x78));          // one endless line
  const tl = new Tail(f);
  let r;
  let maxCarry = 0;
  for (let i = 0; i < 40; i++) { r = tl.poll(1024 * 1024); maxCarry = Math.max(maxCarry, tl.carry.length); if (!r.loading) break; }
  assert.ok(!r.loading);
  assert.ok(maxCarry <= CARRY_MAX, 'carry grew to ' + maxCarry);
  assert.equal(tl.carry.length, 0, 'the over-long line is dropped, not buffered');
  assert.equal(r.badLines, 1, 'and counted once');
  fs.appendFileSync(f, 'more garbage of the same line\n' + J({ a: 1 }) + '\n');
  r = tl.poll(1024 * 1024);
  assert.deepEqual(r.lines, [{ a: 1 }], 'reading resumes at the next newline');
  assert.equal(r.badLines, 1);
  assert.ok(tl.carry.length === 0);
});

test('sec F3: files beyond the size guards are never read whole (journal, result file, small JSON), and a failing journal read is not retried on every tick', () => {
  const t = tree(), P = 'c--p', sid = SID(4);
  t.transcript(P, sid, 1000); t.registry({ sid });
  // a 33 MB "journal" and result file, a 300 KB custom-title.json
  const bigJournal = path.join(t.runDir(P, sid, 'wf_huge'), 'journal.jsonl');
  fs.mkdirSync(path.dirname(bigJournal), { recursive: true });
  fs.writeFileSync(bigJournal, Buffer.alloc(33 * 1024 * 1024, 0x20));
  t.agent(P, sid, 'wf_huge', 'a1', snap({}, 9e4, 1000));
  const bigResult = path.join(t.sd(P, sid), 'workflows', 'wf_old.json');
  fs.mkdirSync(path.dirname(bigResult), { recursive: true });
  fs.writeFileSync(bigResult, Buffer.alloc(33 * 1024 * 1024, 0x20));
  const bigTitle = path.join(t.sd(P, sid), 'custom-title.json');
  fs.writeFileSync(bigTitle, J({ customTitle: 'T'.repeat(300 * 1024) }));
  // a journal that cannot be read (a directory): stat works, the read fails
  const sid2 = SID(5);
  t.transcript(P, sid2, 1000); t.registry({ sid: sid2 });
  fs.mkdirSync(path.join(t.runDir(P, sid2, 'wf_dir'), 'journal.jsonl'), { recursive: true });
  t.agent(P, sid2, 'wf_dir', 'b1', snap({}, 9e4, 1000));
  const m = mk(t);
  let vs;
  const spy = spyFs(/journal\.jsonl$|wf_old\.json$|custom-title\.json$/, () => { for (let i = 0; i < 4; i++) vs = m.refresh(NOW + i * 100); });
  assert.ok(!spy.reads.some((f) => /wf_huge/.test(f)), 'the 33 MB journal was read');
  assert.ok(!spy.reads.some((f) => /wf_old\.json$/.test(f)), 'the 33 MB result file was read');
  assert.ok(!spy.reads.some((f) => /custom-title\.json$/.test(f)), 'the 300 KB title file was read');
  assert.ok(spy.reads.filter((f) => /wf_dir/.test(f)).length <= 1, 'a failing read was retried: ' + spy.reads.length);
  const huge = wfCards(vs).find((c) => c.runId === 'wf_huge');
  assert.ok(huge && huge.agentsTotal === 1, 'the run is still shown from its agent files');
  assert.ok(vs.running.some((c) => c.sessionId === sid2));
});

// ================================================================ security F4: one garbage result file

test('sec F4: hostile values in a result file (non-callable toString) neither throw nor hide the other cards of the session', () => {
  const hostile = '{"status":{"toString":1},"timestamp":{"toString":1,"valueOf":1},"workflowName":{"toString":1},"workflowProgress":[{"type":"workflow_agent","label":{"toString":1},"agentId":[{"toString":1}],"state":"done","phaseTitle":{"toString":1},"model":{"toString":1}}],"phases":[{"title":{"toString":1}}]}';
  assert.doesNotThrow(() => SessionModel.cardFromResult(JSON.parse(hostile), 'wf_bad', NOW, (x) => x));
  assert.equal(SessionModel.cardFromResult(null, 'wf_bad', NOW, (x) => x), null);
  assert.equal(SessionModel.cardFromResult(JSON.parse(hostile), 'wf_bad', NOW, (x) => x).status, 'completed');
  const t = tree(), P = 'c--p', sid = SID(6);
  t.transcript(P, sid, 1000); t.registry({ sid });
  t.journal(P, sid, 'wf_live', [{ type: 'started', key: 'k', agentId: 'a1', label: 'live', phase: 'P' }], 500);
  t.agent(P, sid, 'wf_live', 'a1', snap({}, 9e4, 1000));
  t.result(P, sid, 'wf_bad00000-001', hostile, 5 * MIN);
  const m = mk(t);
  let reads = 0;
  const spy = spyFs(/wf_bad00000-001\.json$/, () => {
    for (let i = 0; i < 4; i++) {
      const vs = m.refresh(NOW + i * 100);
      assert.equal(vs.running.length, 1, 'the healthy live run is shown on every tick');
      assert.deepEqual(vs.warnings, []);
    }
  });
  reads = spy.reads.length;
  assert.equal(reads, 1, 'the file is read once, not on every tick');
});

test('sec F4: a result file that cannot be turned into a card hides only its own run, warns, and is given up after a few reads', () => {
  const t = tree(), P = 'c--p', sid = SID(7);
  t.transcript(P, sid, 1000); t.registry({ sid });
  t.journal(P, sid, 'wf_live', [{ type: 'started', key: 'k', agentId: 'a1', label: 'live', phase: 'P' }], 500);
  t.agent(P, sid, 'wf_live', 'a1', snap({}, 9e4, 1000));
  t.result(P, sid, 'wf_boom', resultFile({ runId: 'wf_boom' }, [wa({ agentId: 'z', model: 'boom' })]), 5 * MIN);
  const m = mk(t, { deps: { prettyModel: (id) => { if (id === 'boom') throw new Error('kaputt'); return id; } } });
  let vs = m.refresh(NOW);
  assert.equal(vs.running.length, 1, 'the live run of the same session is still there');
  assert.equal(vs.warnings.length, 1);
  assert.match(vs.warnings[0], /kaputt/);
  const spy = spyFs(/wf_boom\.json$/, () => { for (let i = 1; i <= 40; i++) vs = m.refresh(NOW + i * 20e3); });
  assert.ok(spy.reads.length <= 4, 'the bad file was read ' + spy.reads.length + ' more times');
  assert.equal(vs.running.length, 1);
  assert.deepEqual(vs.recent, []);
});

// ================================================================ security F5: journal agent ids become file names

test('sec F5: a journal agent id with separators or dots is not a slot and never becomes a path', () => {
  const evil = ['x/../../../../../' + SID(8), 'x\\..\\..\\a', '..', 'a.b', 'C:\\x', 'a b', '', 'x'.repeat(65)];
  for (const id of evil) assert.deepEqual(parseJournal(J({ type: 'started', key: 'k', agentId: id, label: 'l', phase: 'P' }) + '\n').slots, [], JSON.stringify(id));
  assert.equal(parseJournal(J({ type: 'started', key: 'k', agentId: 'a160ccd73e63ff8f0', label: 'l' }) + '\n').slots.length, 1);
  assert.equal(parseJournal(J({ type: 'started', key: 'k', agentId: 'wf_old-a1', label: 'l' }) + '\n').slots.length, 1);
  const t = tree(), P = 'c--p', sid = SID(8);
  t.transcript(P, sid, 1000, J({ type: 'user', message: { content: 'MAIN TRANSCRIPT SECRET' } }) + '\n'); t.registry({ sid });
  t.journal(P, sid, 'wf_evil', [{ type: 'started', key: 'k', agentId: 'x/../../../../../' + sid, label: 'evil', phase: 'P' }, { type: 'started', key: 'k2', agentId: 'ok1', label: 'fine', phase: 'P' }], 500);
  t.agent(P, sid, 'wf_evil', 'ok1', snap({}, 9e4, 1000));
  const m = mk(t, { deps: { AgentTracker } });
  const spy = spyFs(new RegExp(sid + '\\.jsonl$'), () => { m.refresh(NOW); m.refresh(NOW + 6000); });
  assert.deepEqual(spy.opens.concat(spy.reads), [], 'the main transcript was opened through a journal id');
});

// ================================================================ security F6: the privacy statements

test('sec F6: history records are bounded at write time, and README / SPEC say that texts are stored', () => {
  const rec = eta.makeRecord({ kind: 'wf', label: 'L'.repeat(5000) + ':x', phase: 'P'.repeat(5000), model: 'm'.repeat(5000), project: 'p'.repeat(5000), runId: 'r'.repeat(5000), durationSec: 12 });
  for (const k of ['prefix', 'phase', 'model', 'proj', 'run']) assert.ok(rec[k].length <= 300, k + ' = ' + rec[k].length);
  assert.doesNotThrow(() => eta.makeRecord({ kind: 'wf', label: { toString: 1 }, phase: { toString: 1 }, model: { toString: 1 }, project: { toString: 1 }, durationSec: 1 }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-rg-hist-'));
  trees.push(dir);
  const h = new History(path.join(dir, 'history.json'), { debounceMs: 0 });
  assert.equal(h.ingestAgent('s:k', { kind: 'task', prefix: 'T'.repeat(5000), phase: null, model: 'claude-x', proj: 'p', run: 's:abc', durSec: 30 }), true);
  assert.ok(h.snapshot().agents[0].prefix.length <= 300);
  h.dispose();
  const md = read('docs/ANLEITUNG.md');
  assert.ok(!/keine Texte/.test(md), 'README still says that no texts are stored');
  assert.match(md, /Namensanfang des Labels/);
  assert.match(md, /Phasentitel/);
  assert.match(md, /\*\*aller\*\* Projekte/);
  assert.match(md, /Zustand der Ansicht/);
  assert.match(md, /Arbeitsbereich-Speicher/);
  assert.ok(!/only one persistent artifact/.test(read('docs/SPEC.md')));
});

// ================================================================ vscode-runtime F1 / data-fidelity F2: staleMinutes

test('rt F1 / df F2: agentView.staleMinutes is documented as the orphan threshold, which is what it does', () => {
  const d = pkg.contributes.configuration.properties['agentView.staleMinutes'].description;
  assert.ok(!/Ab dieser Ruhezeit wird 'ruhig seit' angezeigt/.test(d));
  assert.match(d, /verwaist/);
  assert.match(d, /10 Minuten/);
  const md = read('docs/ANLEITUNG.md');
  const row = md.split('\n').find((l) => l.includes('`agentView.staleMinutes`'));
  assert.ok(!/ab dieser Ruhezeit erscheint "ruhig seit"/.test(row));
  assert.match(row, /verwaist/);
  assert.equal(W.QUIET_SEC, 600, 'the label threshold the docs now state');
  // behaviour the description promises: with a session registry the value changes nothing below 60 minutes
  const t = tree(), P = 'c--p', sid = SID(9);
  t.transcript(P, sid, 5 * MIN); t.registry({ sid });
  t.journal(P, sid, 'wf_q', [{ type: 'started', key: 'k', agentId: 'a1', label: 'q', phase: 'P' }], 5 * MIN);
  t.agent(P, sid, 'wf_q', 'a1', snap({}, 9 * MIN, 5 * MIN), 5 * MIN);
  const states = [2, 3, 10, 30].map((staleMinutes) => wfCards(mk(t, { staleMinutes }).refresh(NOW))[0].phases[0].agents[0].state);
  assert.deepEqual(states, ['running', 'running', 'running', 'running']);
});

// ================================================================ vscode-runtime F3: what VS Code keeps of the view

test('rt F3: the webview does persist its last state, and the privacy text says so', () => {
  assert.match(read('media/main.js'), /vscode\.setState\(\{ v: 1, last, ui \}\)/, 'if this changes, the README paragraph "Zustand der Ansicht" must change with it');
  const md = read('docs/ANLEITUNG.md');
  const para = md.split('\n').find((l) => l.startsWith('- **Zustand der Ansicht:**'));
  assert.ok(para, 'paragraph exists');
  assert.match(para, /Werkzeug-Ziele/);
  assert.match(para, /160 Zeichen/);
  assert.match(para, /showToolTargets/);
});

// ================================================================ vscode-runtime F5: watcher of a deleted directory
// (the poller tests with the fake clock live in test/poller.test.js)

// ================================================================ data-fidelity F1: 1M-context label of live cards

const T0 = Date.UTC(2026, 9, 2, 12, 0, 0);
const iso = (ms) => new Date(T0 + ms).toISOString();
const att = (ms, modelId) => ({ type: 'attachment', uuid: 'u' + ms, timestamp: iso(ms), agentId: 'atest', attachment: { type: 'model', identity: { modelId, marketingName: 'x' } } });
const asst = (ms, rid, model, u, stop, blocks) => ({ type: 'assistant', uuid: 'a' + ms, timestamp: iso(ms), agentId: 'atest', requestId: rid,
  message: { id: 'msg_' + rid, model, role: 'assistant', stop_reason: stop || null, usage: { input_tokens: u[0], cache_creation_input_tokens: u[1], cache_read_input_tokens: u[2], output_tokens: u[3] }, content: blocks || [] } });
const usr = (ms, content, extra) => Object.assign({ type: 'user', uuid: 'r' + ms, timestamp: iso(ms), agentId: 'atest', message: { role: 'user', content } }, extra || {});
const SUCCESS = '{"success":true,"message":"Report delivered to your caller."}';
const snapOf = (objs, opts) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-rg-fold-'));
  trees.push(dir);
  const f = path.join(dir, 'agent-atest.jsonl');
  fs.writeFileSync(f, objs.map((o) => J(o) + '\n').join(''));
  const tr = new AgentTracker(f, opts || { isWf: false });
  const s = tr.poll(0, { bytes: 1e8 });
  tr.dispose();
  return s;
};

test('df F1: the model label of a live agent carries the 1M flag of the model attachment, the id stays the bare message id', () => {
  const lines = [att(0, 'claude-opus-5[1m]'), usr(10, 'go'), asst(100, 'r1', 'claude-opus-5', [1, 10, 20, 5], null, [{ type: 'thinking', thinking: '' }])];
  const s = snapOf(lines);
  assert.equal(s.model.label, 'Opus 5 (1M)');
  assert.equal(s.model.id, 'claude-opus-5', 'the ETA history is keyed by the bare id');
  assert.equal(snapOf([att(0, 'claude-opus-5-5[1m]')].concat(lines.slice(1).map((l) => (l.message && l.message.model ? Object.assign({}, l, { message: Object.assign({}, l.message, { model: 'claude-opus-5-5' }) }) : l)))).model.label, 'Opus 5.5 (1M)');
  // an agent that really ran another model keeps what the messages say
  assert.equal(snapOf([att(0, 'claude-sonnet-5')].concat(lines.slice(1))).model.label, 'Opus 5');
  // no attachment: as before; only the attachment (no response yet): its label, no id
  assert.equal(snapOf(lines.slice(1)).model.label, 'Opus 5');
  const early = snapOf([att(0, 'claude-opus-5[1m]'), usr(10, 'go')]);
  assert.equal(early.model.label, 'Opus 5 (1M)');
  assert.equal(early.model.id, null);
  // finished card (result file) and live card now agree
  assert.equal(W.prettyModel('claude-opus-5[1m]'), s.model.label);
});

test('df F1: the live card of a run shows the flag; the ETA still receives the bare model id', () => {
  const t = tree(), P = 'c--p', sid = SID(10), run = 'wf_m';
  const dir = t.runDir(P, sid, run);
  t.transcript(P, sid, 1000); t.registry({ sid });
  t.journal(P, sid, run, [{ type: 'started', key: 'k', agentId: 'ab12', label: 'work', phase: 'P' }], 500);
  const rows = [att(0, 'claude-opus-5[1m]'), usr(0, 'go'), asst(0, 'r1', 'claude-opus-5', [1, 10, 20, 5], null, [{ type: 'thinking', thinking: '' }])].map((o, i) => Object.assign({}, o, { timestamp: new Date(NOW - 20e3 + i * 1000).toISOString() }));
  touch(path.join(dir, 'agent-ab12.jsonl'), rows.map((o) => J(o) + '\n').join(''), 1000);
  const calls = [];
  const m = mk(t, { etaEnabled: true, deps: { AgentTracker, prettyModel: require('../lib/format').prettyModel, eta: { estimateAgent: (i) => { calls.push(i); return quietEta.estimateAgent(); }, estimateWorkflow: () => quietEta.estimateWorkflow() } } });
  const a = wfCards(m.refresh(NOW))[0].phases[0].agents[0];
  assert.equal(a.model.label, 'Opus 5 (1M)');
  assert.equal(a.model.id, 'claude-opus-5');
  assert.ok(calls.every((i) => !/\[1m\]/.test(i.model || '')));
  assert.equal(eta.estimateAgent({ state: 'running', elapsedSec: 100, kind: 'wf', label: 'a:b', model: 'claude-opus-5[1m]' }, null).kind, 'unknown', 'a flagged model id does not break the estimate');
});

// ================================================================ data-fidelity F3: token rule

test('df F3: a multi-line request whose FIRST line already carries stop_reason does not count its output twice', () => {
  const ctx = [2, 19333, 116466];
  const backfilled = [usr(0, 'go'), asst(100, 'r1', 'claude-opus-5', ctx.concat([4121]), 'tool_use', [{ type: 'thinking', thinking: '' }]),
    asst(110, 'r1', 'claude-opus-5', ctx.concat([4121]), 'tool_use', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }])];
  assert.equal(snapOf(backfilled).tokens, ctx[0] + ctx[1] + ctx[2], 'both lines carry the real output: ctx only');
  const placeholder = [usr(0, 'go'), asst(100, 'r1', 'claude-opus-5', ctx.concat([3]), null, [{ type: 'thinking', thinking: '' }]),
    asst(110, 'r1', 'claude-opus-5', ctx.concat([4121]), 'tool_use', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }])];
  assert.equal(snapOf(placeholder).tokens, ctx[0] + ctx[1] + ctx[2] + 3, 'first line still carries the placeholder: it counts');
  const single = [usr(0, 'go'), asst(100, 'r1', 'claude-opus-5', ctx.concat([4121]), 'end_turn', [{ type: 'text', text: 'x' }])];
  assert.equal(snapOf(single).tokens, ctx[0] + ctx[1] + ctx[2], 'single finalised line: 0 (unchanged)');
  const inflight = [usr(0, 'go'), asst(100, 'r1', 'claude-opus-5', ctx.concat([7]), null, [{ type: 'thinking', thinking: '' }])];
  assert.equal(snapOf(inflight).tokens, ctx[0] + ctx[1] + ctx[2] + 7, 'in flight: the placeholder counts (unchanged)');
});

// ================================================================ data-fidelity F4: sessions in a sub-folder of the workspace

test('df F4: a session started in a sub-folder keeps its finished cards when its process exits, also via a dead registry entry', () => {
  const WS = WIN ? 'C:\\rgws\\app' : '/rgws/app';
  const sub = WIN ? 'c:\\rgws\\app\\sub' : '/rgws/app/sub';
  const enc = (s) => s.replace(/[^a-zA-Z0-9]/g, '-');
  const t = tree(), P = enc(WS) + '-sub', sid = SID(11), other = SID(12);
  t.transcript(P, sid, 1000); t.plain(P, sid, 'inB', snap({ end: 'finished' }, 9e4, 5e4), { description: 'inB' }, 5e4);
  t.transcript(P, other, 1000); t.plain(P, other, 'sibling', snap({ end: 'finished' }, 9e4, 5e4), { description: 'sibling' }, 5e4);
  t.registry({ sid, over: { cwd: sub } });
  const ids = (vs) => allCards(vs).map((c) => c.agent.id).sort();
  const m = mk(t, { scope: 'workspace', workspaceFolders: [WS] });
  assert.deepEqual(ids(m.refresh(NOW)), ['inB'], 'while the process lives');
  fs.rmSync(path.join(t.home, 'sessions'), { recursive: true, force: true });  // the process exits: Claude Code removes its registry entry
  m.invalidate();
  assert.deepEqual(ids(m.refresh(NOW + 1000)), ['inB'], 'the finished card stays');
  m.setOptions({ workspaceFolders: [path.join(os.tmpdir(), 'elsewhere')] });
  assert.deepEqual(ids(m.refresh(NOW + 2000)), [], 'another workspace folder forgets it');
  // a registry entry of a dead process still tells where the session ran (fresh model, nothing remembered)
  t.registry({ sid, pid: 2147483646, over: { cwd: sub } });
  assert.deepEqual(ids(mk(t, { scope: 'workspace', workspaceFolders: [WS] }).refresh(NOW)), ['inB']);
  // without any registry information a sub-folder session stays a documented limit (scope "all" shows it)
  fs.rmSync(path.join(t.home, 'sessions'), { recursive: true, force: true });
  assert.deepEqual(ids(mk(t, { scope: 'workspace', workspaceFolders: [WS] }).refresh(NOW)), []);
  assert.deepEqual(ids(mk(t, { scope: 'all' }).refresh(NOW)), ['inB', 'sibling']);
  assert.match(read('docs/ANLEITUNG.md'), /Sitzungen in Unterordnern des Arbeitsbereichs/);
});

// ================================================================ data-fidelity F5: resumed plain agent

test('df F5: a resumed Agent-tool agent leaves "fertig" at its new prompt and does not show the old report again before its first tool call', () => {
  const modern = [usr(0, 'do it'), asst(100, 'r1', 'claude-haiku-4-5', [1, 5, 5, 5], 'tool_use', [{ type: 'tool_use', id: 't2', name: 'SubagentHandback', input: { message: 'OLD REPORT' } }]),
    usr(200, [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: SUCCESS }] }], { toolEndsTurn: true })];
  assert.equal(snapOf(modern).end, 'finished');
  assert.equal(snapOf(modern).resultPreview, 'OLD REPORT');
  const resumed = modern.concat([usr(600, 'please also check B')]);
  assert.equal(snapOf(resumed).end, 'running');
  const thinking = resumed.concat([asst(700, 'r2', 'claude-haiku-4-5', [1, 5, 5, 5], null, [{ type: 'thinking', thinking: '' }])]);
  const s = snapOf(thinking);
  assert.equal(s.end, 'running', 'the first thinking line of the resumed turn');
  assert.equal(s.resultPreview, null);
  assert.deepEqual(s.activity && s.activity.kind, 'thinking');
  const second = thinking.concat([asst(800, 'r3', 'claude-haiku-4-5', [1, 5, 5, 5], 'tool_use', [{ type: 'tool_use', id: 't9', name: 'SubagentHandback', input: { message: 'NEW REPORT' } }]),
    usr(900, [{ type: 'tool_result', tool_use_id: 't9', content: [{ type: 'text', text: SUCCESS }] }], { toolEndsTurn: true })]);
  assert.equal(snapOf(second).end, 'finished');
  assert.equal(snapOf(second).resultPreview, 'NEW REPORT');
  // harness reminders and nudges (isMeta) after the delivery keep the old behaviour; so does an interrupt line
  const reminder = modern.slice(0, 2).concat([usr(200, [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: SUCCESS }] }]),
    usr(250, '<system-reminder>x</system-reminder>', { isMeta: true }), asst(300, 'r2', 'claude-haiku-4-5', [1, 5, 5, 5], 'end_turn', [{ type: 'text', text: 'Report delivered.' }])]);
  assert.equal(snapOf(reminder).end, 'finished');
  assert.equal(snapOf(modern.concat([usr(300, '[Request interrupted by user]')])).end, 'interrupted');
});

// ================================================================ data-fidelity F6: the state cap sheds card by card

test('df F6: the 150 KB cap sheds the oldest cards one at a time instead of all but the newest three', () => {
  const t = tree(), P = 'c--p', sid = SID(13);
  t.transcript(P, sid, 5 * MIN);
  const long = 'L'.repeat(150);
  const runs = 22, per = 12;
  for (let r = 0; r < runs; r++) {
    const agents = Array.from({ length: per }, (_, i) => wa({ index: i + 1, label: 'agent-' + i + '-' + long, agentId: 'r' + r + 'a' + i, resultPreview: long, phaseTitle: 'Research' }));
    t.result(P, sid, 'wf_c' + r, resultFile({ runId: 'wf_c' + r, summary: long, timestamp: new Date(NOW - (r + 1) * MIN).toISOString() }, agents), (r + 1) * MIN);
  }
  const m = mk(t);
  const uncapped = JSON.stringify(m.refresh(NOW, { noSizeCap: true, maxRecent: 20 })).length;
  assert.ok(uncapped > 150e3 && uncapped < 190e3, 'the scenario is only slightly over the cap: ' + uncapped);
  const vs = m.refresh(NOW + 1);
  assert.ok(JSON.stringify(vs).length <= 150e3);
  assert.ok(vs.warnings.includes(S.warnCapped));
  const kept = vs.recent.filter((c) => c.phases.some((p) => p.agents.length > 0)).length;
  assert.ok(kept >= 15, 'only ' + kept + ' of ' + vs.recent.length + ' cards kept their agents');
  assert.ok(vs.recent[0].phases[0].agents.length > 0, 'the newest card is whole');
  assert.ok(vs.recent.every((c) => c.agentsTotal === per && c.phases[0].total === per), 'the counters survive');
});

test('df F6: the state cap always holds, even when nothing but whole cards can be dropped', () => {
  const t = tree(), P = 'c--p';
  for (let s = 0; s < 8; s++) {
    const sid = SID(100 + s), run = 'wf_s' + s;
    t.transcript(P, sid, 1000);
    t.journal(P, sid, run, Array.from({ length: 300 }, (_, i) => ({ type: 'started', key: 'k' + i, agentId: 'a' + i, label: 'l' + i, phase: 'Phase ' + (i % 150) })), 500);
  }
  const vs = mk(t).refresh(NOW);
  assert.ok(JSON.stringify(vs).length <= 150e3, 'size ' + JSON.stringify(vs).length);
  assert.ok(vs.running.length >= 1);
});

test('df F6: a phase whose agents were shed says so instead of "Noch keine Agenten gestartet."', () => {
  assert.equal(W.phaseNote({ total: 12, agents: [] }), '12 Agenten ausgeblendet');
  assert.equal(W.phaseNote({ total: 1, agents: [] }), '1 Agent ausgeblendet');
  assert.equal(W.phaseNote({ total: 0, agents: [] }), W.T.noAgentsYet);
  assert.equal(W.phaseNote({ total: 50, agents: new Array(40).fill({}) }), '+10 weitere');
  assert.equal(W.phaseNote({ total: 3, agents: new Array(3).fill({}) }), '');
  assert.equal(W.phaseNote({}), W.T.noAgentsYet);
  const n = W.normalizeState({ v: 1, running: [], recent: [{ kind: 'workflow', key: 'k', runId: 'r', phases: [{ title: 'P', state: 'done', total: 12, done: 12, agents: [] }] }] });
  assert.equal(W.phaseNote(n.recent[0].phases[0]), '12 Agenten ausgeblendet');
});

// ================================================================ the registry fields are bounded too

test('sec F2 / F3: registry text fields and a huge cwd are bounded', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'av-rg-reg-'));
  trees.push(home);
  const dir = path.join(home, 'sessions');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, String(process.pid) + '.json'), J({ pid: process.pid, sessionId: SID(1), cwd: '/'.repeat(30000) + 'x', name: 'N'.repeat(30000), entrypoint: 'E'.repeat(500), status: 'busy' }));
  const [r] = CH.readRegistry(home);
  assert.equal(r.cwd, '');
  assert.ok(r.name.length <= 200 && r.entrypoint.length <= 200);
});
