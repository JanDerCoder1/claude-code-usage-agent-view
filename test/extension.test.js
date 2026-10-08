'use strict';
// extension.js under a stubbed editor API. The stub is injected through a Module._load hook (the real extension
// host provides 'vscode' the same way). Libraries of other modules are replaced by fakes through the same hook,
// so this file tests only the shell: registrations, view lifecycle, messages, settings wiring, dispose.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension.js');
const COMMAND_IDS = ['agentView.clearSession', 'agentView.handoff', 'agentView.open', 'agentView.openFloating', 'agentView.refresh', 'agentView.resetEtaHistory', 'agentView.toggleScope'];
const HTTP_EQUIV = 'http' + '-equiv';
const PRISTINE_LOAD = Module._load; // boot() may run twice in one test: always hook on top of the real loader

const Uri = {
  file: (p) => ({ scheme: 'file', fsPath: p, path: p.replace(/\\/g, '/'), toString() { return 'file:///' + this.path; } }),
  joinPath: (base, ...segs) => Uri.file(path.join(base.fsPath, ...segs)),
};

function makeVscode(st) {
  const mk = (label) => { const d = { label, disposed: 0, dispose() { d.disposed += 1; } }; st.disposables.push(d); return d; };
  const configListeners = [];
  st.fireConfig = (affects) => configListeners.forEach((fn) => fn({ affectsConfiguration: (s) => affects !== false && s === 'agentView' }));
  st.fireFolders = () => st.folderListeners.forEach((fn) => fn({}));
  return {
    Uri,
    ViewColumn: { Active: -1, Beside: -2 },
    ProgressLocation: { Notification: 15 },
    extensions: { getExtension: () => st.claudeExt },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    window: {
      createOutputChannel(name) {
        const ch = mk('channel');
        ch.name = name; ch.lines = []; ch.appendLine = (l) => ch.lines.push(l);
        st.channel = ch;
        return ch;
      },
      registerWebviewPanelSerializer(type, ser) { (st.serializers = st.serializers || {})[type] = ser; return mk('serializer'); },
      registerWebviewViewProvider(id, provider, options) { st.provider = { id, provider, options }; return mk('provider'); },
      createWebviewPanel(type, title, showOptions, options) {
        const h = { msg: [], state: [], gone: [] };
        const sub = (list, fn) => { list.push(fn); return { dispose() { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); } }; };
        const posted = [];
        const panel = {
          type, title, showOptions, options, posted, handlers: h, visible: true, active: true, revealed: 0, disposedCount: 0, iconPath: undefined,
          webview: {
            html: '', cspSource: 'vscode-webview-resource:',
            asWebviewUri: (u) => ({ toString: () => 'vscode-webview://ext' + u.path }),
            onDidReceiveMessage: (fn) => sub(h.msg, fn),
            postMessage: async (m) => { posted.push(m); return true; },
          },
          onDidChangeViewState: (fn) => sub(h.state, fn),
          onDidDispose: (fn) => sub(h.gone, fn),
          reveal() { panel.revealed += 1; },
          dispose() { panel.disposedCount += 1; h.gone.slice().forEach((f) => f()); },
          send: (m) => h.msg.slice().forEach((f) => f(m)),
          setVisible(v) { panel.visible = v; h.state.slice().forEach((f) => f({ webviewPanel: panel })); },
        };
        (st.panels = st.panels || []).push(panel);
        return panel;
      },
      showWarningMessage: async (...a) => { st.warnings.push(a); return st.warningAnswer; },
      showInformationMessage: async (...a) => { st.infos.push(a); return st.infoAnswer; },
      showQuickPick: async (items, o) => { st.picks.push({ items, o }); return st.pickCancel ? undefined : items[st.pickIndex]; },
      tabGroups: {
        get activeTabGroup() { return { viewColumn: 2, activeTab: st.activeTab }; },
        close: async (tab) => { st.closedTabs = (st.closedTabs || []).concat([tab]); return true; },
      },
      withProgress: async (o, fn) => { st.progress.push(o); return fn({ report() {} }, {}); },
    },
    commands: {
      registerCommand(id, fn) { st.commands[id] = fn; return mk('command:' + id); },
      executeCommand: async (id, ...args) => { st.executed.push({ id, args }); if (st.failCommands && st.failCommands.includes(id)) throw new Error('boom ' + id); },
    },
    env: { clipboard: { writeText: async (t) => { st.clipboard = t; } } },
    workspace: {
      get workspaceFolders() { return st.folders; },
      getConfiguration(section) {
        assert.equal(section, 'agentView');
        return {
          get: (k) => st.configValues[k],
          inspect: (k) => ({ key: k, workspaceValue: st.workspaceScope }),
          update: async (k, v, target) => { st.updates.push({ k, v, target }); st.configValues[k] = v; },
        };
      },
      onDidChangeConfiguration(fn) { configListeners.push(fn); return mk('onConfig'); },
      onDidChangeWorkspaceFolders(fn) { st.folderListeners.push(fn); return mk('onFolders'); },
    },
  };
}

function fakeSession(n) {
  return { sid: '00000000-0000-4000-8000-00000000000' + n, name: 'coding-0' + n, status: n === 1 ? 'busy' : 'idle', cwd: 'C:\\w', entrypoint: 'claude-vscode', alive: true, activeAt: Date.now() - n * 60000, transcript: path.join(os.tmpdir(), 'x' + n + '.jsonl'), title: 'Titel ' + n };
}

function makeView() {
  const h = { msg: [], vis: [], gone: [] };
  const sub = (list, fn) => { list.push(fn); return { dispose() { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); } }; };
  const posted = [];
  const view = {
    visible: true,
    webview: {
      options: null, html: '', cspSource: 'vscode-webview-resource:',
      asWebviewUri: (u) => ({ toString: () => 'vscode-webview://ext' + u.path }),
      onDidReceiveMessage: (fn) => sub(h.msg, fn),
      postMessage: async (m) => { posted.push(m); return true; },
    },
    onDidChangeVisibility: (fn) => sub(h.vis, fn),
    onDidDispose: (fn) => sub(h.gone, fn),
  };
  return {
    view, posted, handlers: h,
    send: (m) => h.msg.slice().forEach((f) => f(m)),
    setVisible(v) { view.visible = v; h.vis.slice().forEach((f) => f()); },
    close() { h.gone.slice().forEach((f) => f()); },
  };
}

/** Installs the stubs, loads a fresh extension.js and returns handles for assertions. */
function boot(t, o) {
  const opts = o || {};
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-view-home-'));
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-view-storage-'));
  const wsDir = path.join(os.tmpdir(), 'agent-view-ws');
  const st = {
    disposables: [], commands: {}, executed: [], panels: [], failCommands: opts.failCommands || [], updates: [], warnings: [], infos: [], folderListeners: [],
    floatOpen: null, claudeExt: undefined, infoAnswer: undefined, picks: [], progress: [], clipboard: null, sessionsList: null, pickIndex: 0, pickCancel: false, listThrows: false, buildThrows: false,
    warningAnswer: 'Löschen', workspaceScope: undefined, folders: [{ uri: Uri.file(wsDir) }],
    configValues: Object.assign({ scope: 'workspace', recentHours: 24, claudeHome: '', showToolTargets: true, pollMs: 1500, staleMinutes: 10, 'eta.enabled': true, 'usage.autoRefreshMinutes': 0 }, opts.config),
  };
  const inst = {};

  class FakeModel {
    constructor(o2) { this.opts = Object.assign({}, o2); this.setOptionsCalls = []; this.disposeCount = 0; this.refreshCount = 0; inst.model = this; }
    refresh(now) {
      this.refreshCount += 1;
      return { v: 1, now, scope: this.opts.scope, scopeLabel: 'x', claudeHome: this.opts.claudeHome, running: [{ kind: 'agent' }], recent: [], warnings: [], formatNote: null };
    }
    setOptions(p) { this.setOptionsCalls.push(p); Object.assign(this.opts, p); }
    hasActivity() { return true; }
    watchRoots() { return []; }
    stateHash(vs) { return JSON.stringify([vs.scope, vs.running.length]); }
    dispose() { this.disposeCount += 1; }
  }
  class FakeHistory {
    constructor(file) { this.file = file; this.loaded = false; this.bootstrapArgs = []; this.flushes = 0; this.resets = 0; this.disposes = 0; inst.history = this; }
    load() { this.loaded = true; }
    snapshot() { return {}; }
    bootstrap(h) { this.bootstrapArgs.push(h); return opts.bootstrapResult || Promise.resolve(); }
    flush() { this.flushes += 1; }
    reset() { this.resets += 1; }
    dispose() { this.disposes += 1; }
  }
  class FakePoller {
    constructor(o2) { this.opts = o2; this.started = 0; this.stopped = 0; this.disposed = false; this.ticks = []; this.pollMs = o2.pollMs; this.running = false; inst.poller = this; }
    start() { this.started += 1; this.running = true; }
    stop() { this.stopped += 1; this.running = false; }
    requestTick(x) { this.ticks.push(x || {}); }
    setPollMs(n) { this.pollMs = n; }
    dispose() { this.disposed = true; this.running = false; }
  }
  const missing = (name) => Object.assign(new Error(`Cannot find module './lib/${name}'`), { code: 'MODULE_NOT_FOUND' });
  const handoffLib = opts.handoffLib || {
    listSessions: (home, folders) => { inst.handoffList = { home, folders }; if (st.listThrows) throw new Error('kaputt'); return st.sessionsList || [fakeSession(1)]; },
    buildHandoff: async (file, o) => { (inst.built = inst.built || []).push({ file, o }); if (st.buildThrows) throw new Error('nicht lesbar'); return { markdown: '# Hand-Off\n', stats: {} }; },
    writeHandoff: (md, sid) => { (inst.written = inst.written || []).push({ md, sid }); return path.join(os.tmpdir(), 'handoff-' + String(sid).slice(0, 8) + '-x.md'); },
  };
  class FakeFloat {
    constructor(o2) { this.opts = o2; this.isOpen = false; this.visible = false; this.sent = []; this.opens = 0; this.closes = 0; inst.float = this; }
    async open() { this.opens += 1; if (st.floatOpen && !st.floatOpen.ok) return st.floatOpen; this.isOpen = true; this.visible = true; return st.floatOpen || { ok: true, linked: true }; }
    broadcast(msg) { this.sent.push(msg); }
    async close() { this.closes += 1; this.isOpen = false; this.visible = false; }
  }
  class FakeRefresher {
    constructor(o2) { this.opts = o2; this.calls = 0; inst.refresher = this; }
    refresh(x) { this.calls += 1; (inst.refreshArgs = inst.refreshArgs || []).push(x); return st.refreshGate ? st.refreshGate.then(() => ({ ok: true })) : Promise.resolve(st.refreshResult || { ok: true }); }
  }
  const libs = {
    './lib/floatWindow': opts.noFloat ? missing('floatWindow') : { FloatWindow: FakeFloat },
    './lib/usageRefresh': opts.noRefresher ? missing('usageRefresh') : { UsageRefresher: FakeRefresher },
    './lib/handoff': opts.noHandoff ? missing('handoff') : handoffLib,
    './lib/claudeHome': opts.noClaudeHome ? missing('claudeHome') : { claudeHome: (override) => override || home },
    './lib/sessionModel': opts.noModel ? missing('sessionModel') : { SessionModel: FakeModel },
    './lib/history': opts.noHistory ? missing('history') : { History: FakeHistory },
  };
  if (!opts.realPoller) libs['./lib/poller'] = { Poller: FakePoller };
  if (opts.realLibs) { // the genuine lib/ modules, pointed at a synthetic claudeHome
    for (const k of Object.keys(libs)) delete libs[k];
    st.configValues.claudeHome = home;
    st.configValues['usage.enabled'] = false;           // never start the real claude from a test
    st.configValues['usage.autoRefreshMinutes'] = 0;
  }

  const vscode = makeVscode(st);
  const origLoad = PRISTINE_LOAD;
  Module._load = function (request, parent) {
    if (request === 'vscode') return vscode;
    if (parent && path.basename(parent.filename || '') === 'extension.js' && Object.prototype.hasOwnProperty.call(libs, request)) {
      const v = libs[request];
      if (v instanceof Error) throw v;
      return v;
    }
    return origLoad.apply(this, arguments);
  };
  delete require.cache[EXT];
  const ext = require(EXT);
  const context = { subscriptions: [], extensionUri: Uri.file(ROOT), globalStorageUri: Uri.file(path.join(storage, 'global')) };
  t.after(() => {
    try { ext.deactivate(); } catch (e) { /* ignore */ }
    Module._load = origLoad;
    delete require.cache[EXT];
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(storage, { recursive: true, force: true });
  });
  const resolve = () => {
    const v = makeView();
    st.provider.provider.resolveWebviewView(v.view, {}, {});
    return v;
  };
  return { ext, st, inst, context, home, storage, wsDir, resolve, activate: () => ext.activate(context) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(15); }
  return cond();
}

test('activate registers the view provider, the seven commands, both listeners and the output channel', (t) => {
  const e = boot(t);
  e.activate();
  assert.equal(e.st.provider.id, 'agentView.cards');
  assert.equal(typeof e.st.provider.provider.resolveWebviewView, 'function');
  const retain = e.st.provider.options && e.st.provider.options.webviewOptions && e.st.provider.options.webviewOptions.retainContextWhenHidden;
  assert.ok(!retain, 'retainContextWhenHidden must not be set');
  assert.deepEqual(Object.keys(e.st.commands).sort(), COMMAND_IDS);
  assert.equal(e.st.channel.name, 'Claude Code Utilities');
  assert.equal(e.st.folderListeners.length, 1);
  assert.ok(e.context.subscriptions.length >= 8);
  for (const s of e.context.subscriptions) assert.equal(typeof s.dispose, 'function');
  assert.equal(e.inst.poller, undefined, 'no poller before a view is resolved');
});

test('activate builds History in globalStorage and SessionModel from the settings (history is passed to the model)', (t) => {
  const e = boot(t);
  e.activate();
  assert.equal(e.inst.history.file, path.join(e.context.globalStorageUri.fsPath, 'history.json'));
  assert.equal(e.inst.history.loaded, true);
  assert.ok(fs.existsSync(e.context.globalStorageUri.fsPath), 'storage directory created');
  const o = e.inst.model.opts;
  assert.equal(o.claudeHome, e.home);
  assert.equal(o.scope, 'workspace');
  assert.deepEqual(o.workspaceFolders, [e.wsDir]);
  assert.equal(o.recentHours, 24);
  assert.equal(o.staleMinutes, 10);
  assert.equal(o.showToolTargets, true);
  assert.equal(o.etaEnabled, true);
  assert.equal(o.history, e.inst.history);
  assert.ok(e.st.channel.lines.some((l) => l.includes(e.home)), 'log names the claudeHome path');
});

test('resolving the view writes the HTML shell: 32-hex nonce, strict CSP, media URIs, no inline code', (t) => {
  const e = boot(t);
  e.activate();
  const v = e.resolve();
  const html = v.view.webview.html;
  const m = /script-src 'nonce-([0-9a-f]{32})'/.exec(html);
  assert.ok(m, 'nonce of 32 hex characters in the CSP');
  const nonce = m[1];
  assert.ok(html.includes(`<meta ${HTTP_EQUIV}="Content-Security-Policy" content="default-src 'none'; style-src vscode-webview-resource:; script-src 'nonce-${nonce}'; img-src vscode-webview-resource: data:; font-src vscode-webview-resource:">`));
  const mediaUri = (f) => 'vscode-webview://ext' + path.join(ROOT, 'media', f).replace(/\\/g, '/');
  assert.ok(html.includes(`<script nonce="${nonce}" src="${mediaUri('main.js')}"></script>`));
  assert.ok(html.includes(`<link rel="stylesheet" href="${mediaUri('main.css')}">`));
  assert.ok(html.includes('<div id="app" data-mode="view"></div>'));
  assert.equal((html.match(/<script/g) || []).length, 1, 'exactly one script tag');
  assert.ok(!/\sstyle=/.test(html), 'no style attribute');
  assert.ok(!/\son[a-z]+=/.test(html), 'no inline event handlers');
  assert.ok(!/unsafe-/.test(html));
  const opts = v.view.webview.options;
  assert.equal(opts.enableScripts, true);
  assert.equal(opts.localResourceRoots.length, 1);
  assert.equal(opts.localResourceRoots[0].fsPath, path.join(ROOT, 'media'));
  const second = e.resolve();
  assert.notEqual(/nonce-([0-9a-f]{32})/.exec(second.view.webview.html)[1], nonce, 'fresh nonce per document');
});

test('poller lifecycle: created when the view resolves, stopped when hidden, restarted when shown, stopped on dispose', (t) => {
  const e = boot(t);
  e.activate();
  const v = e.resolve();
  const p = e.inst.poller;
  assert.ok(p, 'poller created on resolve');
  assert.equal(p.opts.model, e.inst.model);
  assert.equal(p.opts.pollMs, 1500);
  assert.equal(typeof p.opts.log, 'function');
  assert.equal(p.started, 1);
  assert.equal(p.opts.isVisible(), true);
  v.setVisible(false);
  assert.equal(p.stopped, 1);
  assert.equal(p.opts.isVisible(), false);
  v.setVisible(true);
  assert.equal(p.started, 2);
  assert.equal(p.opts.isVisible(), true);
  v.close();
  assert.equal(p.stopped, 2);
  assert.equal(p.opts.isVisible(), false);
  assert.equal(v.handlers.msg.length + v.handlers.vis.length + v.handlers.gone.length, 0, 'view subscriptions released');
});

test('a view that resolves hidden does not start the poller until it becomes visible', (t) => {
  const e = boot(t);
  e.activate();
  const v = makeView();
  v.view.visible = false;
  e.st.provider.provider.resolveWebviewView(v.view, {}, {});
  assert.ok(!e.inst.poller || e.inst.poller.started === 0, 'nothing runs while the only surface is hidden');
  v.setVisible(true);
  assert.equal(e.inst.poller.started, 1);
});

test('states are posted as {type, seq, hostNow, state} with a rising seq and only while visible; ready answers at once', (t) => {
  const e = boot(t);
  e.activate();
  const v = e.resolve();
  const p = e.inst.poller;
  const vs = { v: 1, now: 5, running: [], recent: [], warnings: [] };
  p.opts.push(vs, 123);
  p.opts.push(vs, 124);
  assert.deepEqual(v.posted.map((m) => [m.type, m.seq, m.hostNow]), [['state', 1, 123], ['state', 2, 124]]);
  assert.equal(v.posted[0].state, vs);
  v.view.visible = false;
  p.opts.push(vs, 125);
  assert.equal(v.posted.length, 2, 'nothing is posted to a hidden view');
  v.view.visible = true;
  v.send({ type: 'ready', restoredSeq: null });
  assert.deepEqual(p.ticks.pop(), { immediate: true, force: true });
  v.send({ type: 'ready', restoredSeq: 500 });
  p.opts.push(vs, 126);
  assert.equal(v.posted[2].seq, 501, 'seq continues above the restored one');
  v.send({ type: 'ready', restoredSeq: 'x' });
  v.send({ type: 'ready', restoredSeq: -3 });
  p.opts.push(vs, 127);
  assert.equal(v.posted[3].seq, 502);
});

test('ready restarts a poller that is not running while the view is visible', (t) => {
  const e = boot(t);
  e.activate();
  const v = e.resolve();
  e.inst.poller.running = false;
  v.send({ type: 'ready', restoredSeq: null });
  assert.equal(e.inst.poller.started, 2);
});

test('webview messages: only ready/refresh/setScope/reveal are honoured, garbage is ignored', (t) => {
  const e = boot(t);
  e.activate();
  const v = e.resolve();
  const p = e.inst.poller;
  const m = e.inst.model;
  for (const junk of [null, undefined, 42, 'refresh', [], [{ type: 'refresh' }], {}, { type: 5 }, { type: 'eval', code: '1' }, { type: 'openExternal', url: 'x' }, { type: 'setScope' }, { type: 'setScope', scope: 'everything' }, { type: 'setScope', scope: null }, { type: 'reveal' }, { type: 'reveal', path: 42 }]) {
    v.send(junk);
  }
  assert.equal(p.ticks.length, 0);
  assert.equal(m.setOptionsCalls.length, 0);
  assert.equal(e.st.updates.length, 0);
  assert.equal(e.st.executed.length, 0);
  v.send({ type: 'refresh' });
  assert.deepEqual(p.ticks, [{ immediate: true, force: true }]);
  v.send({ type: 'setScope', scope: 'all' });
  assert.deepEqual(m.setOptionsCalls, [{ scope: 'all' }]);
  assert.deepEqual(e.st.updates, [{ k: 'scope', v: 'all', target: 1 }]);
  v.send({ type: 'setScope', scope: 'all' });
  assert.equal(m.setOptionsCalls.length, 1, 'unchanged scope is not pushed again');
});

test('reveal: only existing entries inside claudeHome (symlinks resolved) reach revealFileInOS', (t) => {
  const e = boot(t);
  e.activate();
  const v = e.resolve();
  const file = path.join(e.home, 'projects', 'p1', 'agent-a.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n');
  const evil = e.home + '-evil';
  fs.mkdirSync(evil, { recursive: true });
  fs.writeFileSync(path.join(evil, 'x.txt'), 'x');
  t.after(() => fs.rmSync(evil, { recursive: true, force: true }));
  const reveals = () => e.st.executed.filter((x) => x.id === 'revealFileInOS');

  v.send({ type: 'reveal', path: file });
  assert.equal(reveals().length, 1);
  assert.equal(reveals()[0].args[0].fsPath, file);
  v.send({ type: 'reveal', path: path.join(e.home, 'projects') });
  assert.equal(reveals().length, 2, 'a directory inside claudeHome is fine');
  v.send({ type: 'reveal', path: path.join(e.home, 'projects', 'p1', '..', 'p1', 'agent-a.jsonl') });
  assert.equal(reveals().length, 3, 'normalised paths inside are fine');
  v.send({ type: 'reveal', path: e.home }); // the webview's "show source folder" link sends claudeHome itself
  assert.equal(reveals().length, 4, 'claudeHome itself is fine');
  if (process.platform === 'win32') {
    v.send({ type: 'reveal', path: file.toUpperCase() });
    assert.equal(reveals().length, 5, 'case-insensitive on win32');
  }
  const accepted = reveals().length;

  const bad = [
    path.join(e.home, '..', path.basename(evil), 'x.txt'),       // sibling that shares the prefix
    path.join(evil, 'x.txt'),
    path.join(e.home, 'projects', '..', '..', 'anything'),       // traversal out
    path.dirname(e.home),                                          // the parent itself
    path.join(e.home, 'does-not-exist.txt'),                     // inside but missing
    'projects/p1/agent-a.jsonl',                                   // relative
    '',
    file + '\0',
    path.join(e.home, 'x'.repeat(5000)),
    { path: file },
    123,
  ];
  for (const p of bad) v.send({ type: 'reveal', path: p });
  assert.equal(reveals().length, accepted, 'nothing else was revealed');

  const link = path.join(e.home, 'link-out');
  let linked = false;
  try { fs.symlinkSync(evil, link, 'junction'); linked = true; } catch (err) { /* no permission to link here */ }
  if (linked) {
    v.send({ type: 'reveal', path: path.join(link, 'x.txt') });
    assert.equal(reveals().length, accepted, 'a link that leaves claudeHome is refused');
  }
  assert.ok(e.st.channel.lines.some((l) => l.includes('abgelehnt')), 'rejections are logged without the path');
  assert.ok(!e.st.channel.lines.some((l) => l.includes(path.basename(evil))), 'rejected paths are not logged');
});

test('commands: open focuses the view, refresh asks the poller (or opens the view while nothing runs)', async (t) => {
  const e = boot(t);
  e.activate();
  await e.st.commands['agentView.open']();
  assert.deepEqual(e.st.executed.pop(), { id: 'agentView.cards.focus', args: [] });
  await e.st.commands['agentView.refresh']();
  assert.equal(e.st.executed.pop().id, 'agentView.cards.focus', 'no running poller: open the view');
  e.resolve();
  e.st.commands['agentView.refresh']();
  assert.deepEqual(e.inst.poller.ticks.pop(), { immediate: true, force: true });
});

test('toggleScope flips workspace/all in the model at once, persists it, and a later config event does not re-apply it', (t) => {
  const e = boot(t);
  e.activate();
  e.resolve();
  const m = e.inst.model;
  e.st.commands['agentView.toggleScope']();
  assert.deepEqual(m.setOptionsCalls, [{ scope: 'all' }]);
  assert.deepEqual(e.st.updates, [{ k: 'scope', v: 'all', target: 1 }], 'user setting by default');
  assert.deepEqual(e.inst.poller.ticks.pop(), { immediate: true, force: true });
  e.st.fireConfig();
  assert.equal(m.setOptionsCalls.length, 1, 'config echo of our own write changes nothing');
  e.st.commands['agentView.toggleScope']();
  assert.deepEqual(m.setOptionsCalls[1], { scope: 'workspace' });
  assert.equal(e.st.updates[1].v, 'workspace');
});

test('toggleScope writes to the workspace settings when the scope is set there', (t) => {
  const e = boot(t, { config: { scope: 'all' } });
  e.st.workspaceScope = 'all';
  e.activate();
  e.st.commands['agentView.toggleScope']();
  assert.deepEqual(e.st.updates, [{ k: 'scope', v: 'workspace', target: 2 }]);
});

test('resetEtaHistory asks first (modal) and only then resets and flushes the history', async (t) => {
  const e = boot(t);
  e.activate();
  e.st.warningAnswer = undefined;
  await e.st.commands['agentView.resetEtaHistory']();
  assert.equal(e.st.warnings.length, 1);
  assert.deepEqual(e.st.warnings[0][1], { modal: true });
  assert.equal(e.inst.history.resets, 0, 'cancelled');
  e.st.warningAnswer = 'Löschen';
  await e.st.commands['agentView.resetEtaHistory']();
  assert.equal(e.inst.history.resets, 1);
  assert.ok(e.inst.history.flushes >= 1);
  assert.equal(e.st.infos.length, 1);
});

test('resetEtaHistory without a history module only informs', async (t) => {
  const e = boot(t, { noHistory: true });
  e.activate();
  await e.st.commands['agentView.resetEtaHistory']();
  assert.equal(e.st.warnings.length, 0);
  assert.equal(e.st.infos.length, 1);
});

test('configuration changes reach the model as a partial update and the poller as a new interval', (t) => {
  const e = boot(t);
  e.activate();
  e.resolve();
  const m = e.inst.model;
  e.st.fireConfig(false);
  assert.equal(m.setOptionsCalls.length, 0, 'unrelated configuration events are ignored');
  e.st.fireConfig();
  assert.equal(m.setOptionsCalls.length, 0, 'unchanged values are not pushed');
  Object.assign(e.st.configValues, { pollMs: 3000, recentHours: 48 });
  e.st.fireConfig();
  assert.deepEqual(m.setOptionsCalls, [{ recentHours: 48 }]);
  assert.equal(e.inst.poller.pollMs, 3000);
  assert.deepEqual(e.inst.poller.ticks.pop(), { force: true });
  Object.assign(e.st.configValues, { scope: 'all', showToolTargets: false, 'eta.enabled': false, staleMinutes: 20, claudeHome: '  /custom/claude  ' });
  e.st.fireConfig();
  assert.deepEqual(m.setOptionsCalls[1], { claudeHome: '/custom/claude', scope: 'all', staleMinutes: 20, showToolTargets: false, etaEnabled: false });
  Object.assign(e.st.configValues, { pollMs: 100, recentHours: 'many', staleMinutes: -5, scope: 'bogus' });
  e.st.fireConfig();
  assert.equal(e.inst.poller.pollMs, 500, 'pollMs is clamped to its minimum');
  assert.equal(m.opts.recentHours, 24, 'invalid numbers fall back to the default');
  assert.equal(m.opts.staleMinutes, 2, 'numbers are clamped to their minimum');
  assert.equal(m.opts.scope, 'workspace', 'unknown scope falls back to workspace');
});

test('workspace folder changes reach the model (only file: folders)', (t) => {
  const e = boot(t);
  e.activate();
  e.st.folders = [{ uri: Uri.file(path.join(os.tmpdir(), 'ws-a')) }, { uri: { scheme: 'vscode-vfs', fsPath: '/remote', path: '/remote' } }, { uri: Uri.file(path.join(os.tmpdir(), 'ws-b')) }];
  e.st.fireFolders();
  assert.deepEqual(e.inst.model.setOptionsCalls, [{ workspaceFolders: [path.join(os.tmpdir(), 'ws-a'), path.join(os.tmpdir(), 'ws-b')] }]);
  e.st.folders = undefined; // empty window
  e.st.fireFolders();
  assert.deepEqual(e.inst.model.setOptionsCalls[1], { workspaceFolders: [] });
});

test('history bootstrap starts once, in the background, a little after activation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const e = boot(t);
  e.activate();
  e.resolve();
  assert.equal(e.inst.history.bootstrapArgs.length, 0, 'not during activation');
  t.mock.timers.tick(1999);
  assert.equal(e.inst.history.bootstrapArgs.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(e.inst.history.bootstrapArgs, [e.home]);
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(e.inst.poller.ticks.some((x) => x.force), 'a refresh is requested when the bootstrap finished');
  t.mock.timers.tick(60000);
  e.st.fireConfig();
  t.mock.timers.tick(60000);
  assert.equal(e.inst.history.bootstrapArgs.length, 1, 'idempotent for the same claudeHome');
  e.st.configValues.claudeHome = '/other/claude';
  e.st.fireConfig();
  t.mock.timers.tick(2000);
  assert.deepEqual(e.inst.history.bootstrapArgs, [e.home, '/other/claude']);
});

test('history bootstrap is skipped when the estimate is disabled and survives a failing bootstrap', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const off = boot(t, { config: { 'eta.enabled': false } });
  off.activate();
  t.mock.timers.tick(10000);
  assert.equal(off.inst.history.bootstrapArgs.length, 0);
  off.ext.deactivate();

  const bad = boot(t, { bootstrapResult: Promise.reject(new Error('disk full')) });
  bad.activate();
  bad.resolve();
  t.mock.timers.tick(2000);
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(bad.st.channel.lines.some((l) => l.includes('disk full')));
});

test('deactivate disposes the poller, the model, flushes the history; disposing the subscriptions releases every registration', (t) => {
  const e = boot(t);
  e.activate();
  const v = e.resolve();
  e.ext.deactivate();
  assert.equal(e.inst.poller.disposed, true);
  assert.equal(e.inst.model.disposeCount, 1);
  assert.ok(e.inst.history.flushes >= 1, 'history flushed on deactivate');
  assert.equal(e.inst.history.disposes, 1, 'history released');
  assert.equal(v.handlers.msg.length, 0, 'webview listeners released');
  for (const s of e.context.subscriptions) s.dispose();
  assert.ok(e.st.disposables.length >= 8);
  for (const d of e.st.disposables) assert.equal(d.disposed, 1, `${d.label} disposed exactly once`);
  assert.equal(e.inst.model.disposeCount, 1, 'dispose is idempotent');
  e.ext.deactivate();
  const n = v.posted.length;
  e.st.commands['agentView.refresh'](); // late call after dispose must not throw or post
  assert.equal(v.posted.length, n);
});

test('disposing through the subscriptions alone (no deactivate call) also tears everything down', (t) => {
  const e = boot(t);
  e.activate();
  e.resolve();
  for (const s of e.context.subscriptions) s.dispose();
  assert.equal(e.inst.poller.disposed, true);
  assert.equal(e.inst.model.disposeCount, 1);
  assert.ok(e.inst.history.flushes >= 1);
});

test('activating twice disposes the first instance', (t) => {
  const e = boot(t);
  e.activate();
  const firstModel = e.inst.model;
  e.ext.activate({ subscriptions: [], extensionUri: e.context.extensionUri, globalStorageUri: e.context.globalStorageUri });
  assert.equal(firstModel.disposeCount, 1);
  assert.notEqual(e.inst.model, firstModel);
});

test('missing library modules do not crash activation: commands exist and the view shows a warning', async (t) => {
  const e = boot(t, { noModel: true, noHistory: true, noClaudeHome: true, realPoller: true });
  e.activate();
  assert.deepEqual(Object.keys(e.st.commands).sort(), COMMAND_IDS);
  assert.ok(e.st.channel.lines.some((l) => l.includes('konnte nicht geladen werden')));
  const v = e.resolve();
  assert.ok(await waitFor(() => v.posted.length >= 1, 1500), 'a state arrives');
  const st = v.posted[0].state;
  assert.equal(st.v, 1);
  assert.equal(st.running.length + st.recent.length, 0);
  assert.ok(/Sitzungsmodell nicht verfügbar/.test(st.warnings[0]));
  assert.equal(st.claudeHome, process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  await e.st.commands['agentView.resetEtaHistory']();
  e.st.commands['agentView.toggleScope']();
  assert.equal(e.st.provider.id, 'agentView.cards');
});

test('end to end with the real Poller: first state arrives, ready triggers a fresh push, deactivate silences everything', async (t) => {
  const e = boot(t, { realPoller: true });
  e.activate();
  const v = e.resolve();
  assert.ok(await waitFor(() => v.posted.length >= 1, 2000), 'first state');
  const first = v.posted[0];
  assert.equal(first.type, 'state');
  assert.equal(typeof first.seq, 'number');
  assert.equal(typeof first.hostNow, 'number');
  assert.equal(first.state.v, 1);
  assert.equal(first.state.running.length, 1);
  v.send({ type: 'ready', restoredSeq: null });
  assert.ok(await waitFor(() => v.posted.length >= 2, 2000), 'ready is answered with a state');
  assert.ok(v.posted[1].seq > first.seq);
  v.setVisible(false);
  const n = v.posted.length;
  await sleep(300);
  assert.equal(v.posted.length, n, 'hidden view: no pushes');
  e.ext.deactivate();
  assert.equal(e.inst.model.disposeCount, 1);
});

test('with the genuine lib modules and a synthetic claudeHome: real model + real poller deliver a valid state, scope switch works, history is saved', async (t) => {
  const e = boot(t, { realLibs: true, config: { scope: 'all', recentHours: 24 * 3650 } });
  const sid = '11111111-2222-4333-8444-555555555555';
  const dir = path.join(e.home, 'projects', 'c--tmp-ws', sid, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'agents', 'plain-modern-A.jsonl'), path.join(dir, 'agent-a881270752ce573c6.jsonl'));
  e.activate();
  const v = e.resolve();
  assert.ok(await waitFor(() => v.posted.length >= 1, 3000), 'first state');
  const s = v.posted[0].state;
  assert.equal(s.v, 1);
  assert.equal(s.scope, 'all');
  assert.equal(s.claudeHome, e.home);
  assert.deepEqual(s.warnings, []);
  assert.equal(s.recent.length, 1);
  assert.equal(s.recent[0].sessionId, sid);
  assert.ok(JSON.stringify(s).length < 150 * 1024, 'state stays below the size cap');

  v.send({ type: 'reveal', path: path.join(e.home, 'projects') });
  assert.equal(e.st.executed.filter((x) => x.id === 'revealFileInOS').length, 1, 'the real claudeHome() agrees with the shell about the root');

  v.send({ type: 'setScope', scope: 'workspace' }); // the stub workspace folder matches no project directory
  assert.ok(await waitFor(() => v.posted.some((m) => m.state.scope === 'workspace' && m.state.recent.length === 0), 3000), 'scope switch reaches the model and the webview');
  assert.deepEqual(e.st.updates.map((u) => u.v), ['workspace']);

  e.ext.deactivate();
  assert.ok(fs.existsSync(path.join(e.context.globalStorageUri.fsPath, 'history.json')), 'the finished agent was learned and flushed on deactivate');
});

// ---- hand-off and clear -------------------------------------------------------------------------------------------

test('handoff with one session: no question, progress shown, file written, message offers open and copy', async (t) => {
  const e = boot(t);
  e.activate();
  await e.st.commands['agentView.handoff']();
  assert.equal(e.st.picks.length, 0);
  assert.equal(e.st.progress.length, 1);
  assert.equal(e.st.progress[0].location, 15);
  assert.equal(e.inst.built.length, 1);
  assert.equal(e.inst.built[0].file, fakeSession(1).transcript);
  assert.equal(e.inst.built[0].o.info.title, 'Titel 1');
  assert.equal(e.inst.written.length, 1);
  assert.equal(e.inst.written[0].sid, fakeSession(1).sid);
  const last = e.st.infos[e.st.infos.length - 1];
  assert.match(String(last[0]), /^Hand-Off geschrieben: handoff-00000000-x\.md$/);
  assert.deepEqual(last.slice(1), ['Datei öffnen', 'Prompt kopieren']);
  assert.equal(path.dirname(e.inst.handoffList.home) === path.dirname(e.home) || e.inst.handoffList.home === e.home, true, 'the configured claude home is used');
  assert.deepEqual(e.inst.handoffList.folders, [e.wsDir]);
});

test('handoff: "Datei öffnen" opens the written file in the editor', async (t) => {
  const e = boot(t);
  e.activate();
  e.st.infoAnswer = 'Datei öffnen';
  await e.st.commands['agentView.handoff']();
  const open = e.st.executed.find((x) => x.id === 'vscode.open');
  assert.ok(open, 'vscode.open was run');
  assert.equal(open.args[0].fsPath, path.join(os.tmpdir(), 'handoff-00000000-x.md'));
});

test('handoff: "Prompt kopieren" puts a ready prompt with the file path into the clipboard', async (t) => {
  const e = boot(t);
  e.activate();
  e.st.infoAnswer = 'Prompt kopieren';
  await e.st.commands['agentView.handoff']();
  assert.ok(e.st.clipboard.includes(path.join(os.tmpdir(), 'handoff-00000000-x.md')));
  assert.match(e.st.clipboard, /Letzter Stand/);
  assert.match(e.st.clipboard, /Offene Aufgaben/);
  assert.match(String(e.st.infos[e.st.infos.length - 1][0]), /Prompt kopiert/);
});

test('handoff with several sessions asks which one (newest first) and uses the pick', async (t) => {
  const e = boot(t);
  e.activate();
  e.st.sessionsList = [fakeSession(1), fakeSession(2), fakeSession(3)];
  e.st.pickIndex = 1;
  await e.st.commands['agentView.handoff']();
  assert.equal(e.st.picks.length, 1);
  const items = e.st.picks[0].items;
  assert.equal(items.length, 3);
  assert.equal(items[0].label, 'Titel 1');
  assert.match(items[0].description, /arbeitet/);
  assert.match(items[0].description, /vor 1 Min\./);
  assert.match(items[1].description, /bereit/);
  assert.equal(items[0].detail, 'C:\\w');
  assert.equal(e.inst.built[0].file, fakeSession(2).transcript);
});

test('handoff: cancelling the question writes nothing', async (t) => {
  const e = boot(t);
  e.activate();
  e.st.sessionsList = [fakeSession(1), fakeSession(2)];
  e.st.pickCancel = true;
  await e.st.commands['agentView.handoff']();
  assert.ok(!e.inst.built && !e.inst.written);
  assert.equal(e.st.progress.length, 0);
});

test('handoff without any session says so and writes nothing', async (t) => {
  const e = boot(t);
  e.activate();
  e.st.sessionsList = [];
  await e.st.commands['agentView.handoff']();
  assert.match(String(e.st.infos[0][0]), /keine Sitzung gefunden/);
  assert.ok(!e.inst.built);
});

test('handoff failures (unreadable list, unreadable transcript, missing module) become a message, never an exception', async (t) => {
  const a = boot(t);
  a.activate();
  a.st.listThrows = true;
  await a.st.commands['agentView.handoff']();
  assert.match(String(a.st.warnings[0][0]), /Hand-Off fehlgeschlagen \(kaputt\)/);
  const b = boot(t);
  b.activate();
  b.st.buildThrows = true;
  await b.st.commands['agentView.handoff']();
  assert.match(String(b.st.warnings[0][0]), /Hand-Off fehlgeschlagen \(nicht lesbar\)/);
  assert.ok(!b.inst.written);
  const c = boot(t, { noHandoff: true });
  c.activate();
  await c.st.commands['agentView.handoff']();
  assert.match(String(c.st.warnings[0][0]), /Modul fehlt/);
  assert.deepEqual(Object.keys(c.st.commands).sort(), COMMAND_IDS);
});

const CLAUDE_TAB = { input: { viewType: 'mainThreadWebview-claudeVSCodePanel' }, label: 'Alter Chat' };
const HANDOFF_FILE = path.join(os.tmpdir(), 'handoff-00000000-x.md');

test('clear: writes the hand-off, opens a new conversation with the prompt (file path inside), closes the old tab', async (t) => {
  const e = boot(t);
  e.activate();
  e.st.activeTab = CLAUDE_TAB;
  await e.st.commands['agentView.clearSession']();
  assert.equal(e.inst.written.length, 1, 'hand-off written first');
  const open = e.st.executed.find((x) => x.id === 'claude-vscode.editor.open');
  assert.ok(open, 'new tab opened');
  assert.equal(open.args[0], undefined, 'no session id: a fresh conversation');
  assert.ok(open.args[1].includes(HANDOFF_FILE), 'the prompt names the hand-off file');
  assert.match(open.args[1], /Letzter Stand/);
  assert.equal(open.args[2], 2, 'opens in the column of the old tab');
  assert.deepEqual(e.st.closedTabs, [CLAUDE_TAB], 'old tab closed after the new one opened');
  assert.ok(e.st.clipboard.includes(HANDOFF_FILE), 'prompt also in the clipboard');
  assert.ok(!e.st.executed.some((x) => x.id === 'claude-vscode.newConversation'));
  assert.match(String(e.st.infos[e.st.infos.length - 1][0]), /Neue Unterhaltung gestartet/);
});

test('clear: when the active tab is not a Claude conversation nothing is closed', async (t) => {
  const e = boot(t);
  e.activate();
  e.st.activeTab = { input: { viewType: 'something.else' } };
  await e.st.commands['agentView.clearSession']();
  assert.ok(e.st.executed.some((x) => x.id === 'claude-vscode.editor.open'));
  assert.equal(e.st.closedTabs, undefined);
});

test('clear without a hand-off (no session, cancelled, failed) clears nothing', async (t) => {
  const e = boot(t);
  e.activate();
  e.st.activeTab = CLAUDE_TAB;
  e.st.sessionsList = [];
  await e.st.commands['agentView.clearSession']();
  const f = boot(t);
  f.activate();
  f.st.activeTab = CLAUDE_TAB;
  f.st.buildThrows = true;
  await f.st.commands['agentView.clearSession']();
  for (const x of [e, f]) {
    assert.ok(!x.st.executed.some((c) => c.id.startsWith('claude-vscode.')));
    assert.equal(x.st.closedTabs, undefined);
  }
});

test('clear: when the new tab cannot be opened it falls back to "Neue Unterhaltung", and if that fails too the old tab stays and /clear is suggested', async (t) => {
  const a = boot(t, { failCommands: ['claude-vscode.editor.open'] });
  a.activate();
  a.st.activeTab = CLAUDE_TAB;
  await a.st.commands['agentView.clearSession']();
  assert.ok(a.st.executed.some((x) => x.id === 'claude-vscode.newConversation'));
  const b = boot(t, { failCommands: ['claude-vscode.editor.open', 'claude-vscode.newConversation'] });
  b.activate();
  b.st.activeTab = CLAUDE_TAB;
  await b.st.commands['agentView.clearSession']();
  assert.match(String(b.st.infos[b.st.infos.length - 1][0]), /\/clear/);
  assert.equal(b.st.closedTabs, undefined, 'old tab kept');
});

test('the webview messages handoff and clearSession run the commands; unknown messages are ignored', async (t) => {
  const e = boot(t);
  e.activate();
  const v = e.resolve();
  v.send({ type: 'clearSession' });
  v.send({ type: 'handoff' });
  v.send({ type: 'format-disk' });
  await sleep(40);
  assert.ok(e.st.executed.some((x) => x.id === 'claude-vscode.editor.open'));
  assert.equal(e.inst.written.length, 2, 'clear and the hand-off button each wrote one');
});

// ---- /usage refresh -------------------------------------------------------------------------------------------------

test('becoming visible refreshes the usage once (auto refresh on), then waits for the schedule', async (t) => {
  const e = boot(t, { config: { 'usage.autoRefreshMinutes': 5 } });
  e.activate();
  e.resolve();
  await sleep(20);
  assert.equal(e.inst.refresher.calls, 1);
  assert.ok(e.inst.refresher.opts.binary, 'a binary is named');
  assert.ok(e.inst.refresher.opts.cwd.startsWith(path.join(e.storage, 'global')), 'runs from a stable folder of the extension');
  e.resolve(); // another view document: still inside the 5 minute schedule
  await sleep(20);
  assert.equal(e.inst.refresher.calls, 1);
});

test('autoRefreshMinutes = 0 or usage.enabled = false never starts /usage by itself', async (t) => {
  for (const config of [{ 'usage.autoRefreshMinutes': 0 }, { 'usage.enabled': false, 'usage.autoRefreshMinutes': 5 }]) {
    const e = boot(t, { config });
    e.activate();
    e.resolve();
    await sleep(20);
    assert.equal(e.inst.refresher, undefined, JSON.stringify(config));
  }
});

test('the refresh button (command and webview message) runs /usage and re-reads, with a busy state in between', async (t) => {
  const e = boot(t, { config: { 'usage.autoRefreshMinutes': 0 } });
  e.activate();
  const v = e.resolve();
  let release;
  e.st.refreshGate = new Promise((r) => { release = r; });
  v.send({ type: 'refresh' });
  await sleep(20);
  assert.deepEqual(v.posted.filter((m) => m.type === 'usageBusy'), [{ type: 'usageBusy', busy: true }]);
  assert.equal(e.inst.refresher.calls, 1);
  assert.deepEqual(e.inst.refreshArgs[0], { manual: true });
  const ticksBefore = e.inst.poller.ticks.length;
  release();
  await sleep(20);
  assert.deepEqual(v.posted.filter((m) => m.type === 'usageBusy').pop(), { type: 'usageBusy', busy: false });
  assert.ok(e.inst.poller.ticks.length > ticksBefore, 'the numbers are re-read afterwards');
  e.st.refreshGate = null;
  await e.st.commands['agentView.refresh']();
  assert.equal(e.inst.refresher.calls, 2);
});

test('a webview that appears while /usage runs is told it is busy', async (t) => {
  const e = boot(t, { config: { 'usage.autoRefreshMinutes': 0 } });
  e.activate();
  const v = e.resolve();
  e.st.refreshGate = new Promise(() => {});
  v.send({ type: 'refresh' });
  await sleep(20);
  const w = e.resolve();
  w.send({ type: 'ready', restoredSeq: null });
  assert.deepEqual(w.posted.filter((m) => m.type === 'usageBusy'), [{ type: 'usageBusy', busy: true }]);
});

test('a failed or skipped /usage never breaks the view; the log names the reason, never the output', async (t) => {
  const e = boot(t, { config: { 'usage.autoRefreshMinutes': 0 } });
  e.activate();
  const v = e.resolve();
  e.st.refreshResult = { ok: false, error: 'ENOENT' };
  v.send({ type: 'refresh' });
  await sleep(20);
  e.st.refreshResult = { ok: false, skipped: 'gap' };
  v.send({ type: 'refresh' });
  await sleep(20);
  assert.ok(e.st.channel.lines.some((l) => /\/usage: fehlgeschlagen \(ENOENT\)/.test(l)));
  assert.ok(e.st.channel.lines.some((l) => /\/usage: übersprungen \(gap\)/.test(l)));
  assert.equal(v.posted.filter((m) => m.type === 'usageBusy').pop().busy, false);
});

test('the Claude Code extension binary is preferred when it exists, else the one on the PATH', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-view-claudeext-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '');
  const a = boot(t, { config: { 'usage.autoRefreshMinutes': 5 } });
  a.st.claudeExt = { extensionPath: dir };
  a.activate();
  a.resolve();
  await sleep(20);
  assert.equal(a.inst.refresher.opts.binary, bin);
  const b = boot(t, { config: { 'usage.autoRefreshMinutes': 5 } });
  b.activate();
  b.resolve();
  await sleep(20);
  assert.equal(b.inst.refresher.opts.binary, process.platform === 'win32' ? 'claude.exe' : 'claude');
});

test('the usage timer stops when no view is visible and a missing refresher module changes nothing else', async (t) => {
  const e = boot(t, { noRefresher: true });
  e.activate();
  const v = e.resolve();
  v.setVisible(false);
  await e.st.commands['agentView.refresh']();
  assert.deepEqual(Object.keys(e.st.commands).sort(), COMMAND_IDS);
});

test('a floating panel that VS Code restores at startup is closed again at once (no empty restored window)', async (t) => {
  const e = boot(t);
  e.activate();
  const ser = e.st.serializers['agentView.floating'];
  assert.ok(ser, 'a serializer is registered for the floating panel type');
  let disposed = 0;
  await ser.deserializeWebviewPanel({ dispose() { disposed += 1; } }, undefined);
  assert.equal(disposed, 1);
  await ser.deserializeWebviewPanel({ dispose() { throw new Error('gone'); } }, undefined); // never throws
});

// ---- floating window (stand-alone, see lib/floatWindow.js) ---------------------------------------------------------------

test('openFloating opens the window through FloatWindow, starts the poller and asks for a fresh state', async (t) => {
  const e = boot(t);
  e.activate();
  await e.st.commands['agentView.openFloating']();
  assert.equal(e.inst.float.opens, 1);
  assert.equal(e.inst.poller.running, true, 'the poller runs although the sidebar view is hidden');
  assert.equal(e.inst.poller.opts.isVisible(), true);
  assert.ok(e.inst.poller.ticks.length >= 1);
  assert.equal(e.st.infos.length, 0);
});

test('FloatWindow gets media folder, profile folder, editor process, theme, size, watcher flag and its callbacks', async (t) => {
  const e = boot(t, { config: { 'floating.width': 300, 'floating.height': 410, 'floating.closeWithVscode': false } });
  e.activate();
  const o = e.inst.float.opts;
  assert.equal(o.mediaDir, path.join(ROOT, 'media'));
  assert.equal(o.profileDir, path.join(e.storage, 'global', 'float-profile'));
  assert.equal(o.editorProc, path.basename(process.execPath, '.exe'));
  assert.equal(o.theme(), 'dark');
  assert.deepEqual(o.size(), { width: 300, height: 410 });
  assert.equal(o.watchOwner(), false);
  assert.equal(typeof o.onMessage, 'function');
  assert.equal(typeof o.onChange, 'function');
  const d = boot(t);
  d.activate();
  assert.deepEqual(d.inst.float.opts.size(), { width: 380, height: 480 });
  assert.equal(d.inst.float.opts.watchOwner(), true);
});

test('states go to the sidebar view and to the floating window, each with its own rising seq', async (t) => {
  const e = boot(t);
  e.activate();
  const v = e.resolve();
  await e.st.commands['agentView.openFloating']();
  const push = e.inst.poller.opts.push;
  push({ v: 1, running: [], recent: [], warnings: [] }, 1000);
  push({ v: 1, running: [], recent: [], warnings: [] }, 2000);
  assert.deepEqual(v.posted.filter((m) => m.type === 'state').map((m) => m.seq), [1, 2]);
  const sent = e.inst.float.sent.filter((m) => m.type === 'state');
  assert.deepEqual(sent.map((m) => m.seq), [1, 2]);
  assert.equal(sent[0].hostNow, 1000);
  assert.equal(sent[0].state.v, 1);
});

test('nothing is broadcast while the floating window is not open', async (t) => {
  const e = boot(t);
  e.activate();
  e.resolve();
  e.inst.poller.opts.push({ v: 1, running: [], recent: [], warnings: [] }, 1000);
  assert.deepEqual(e.inst.float.sent, []);
});

test('messages from the floating page are handled like those of the view: refresh, scope, reveal, hand-off', async (t) => {
  const e = boot(t, { config: { 'usage.autoRefreshMinutes': 0 } });
  e.activate();
  await e.st.commands['agentView.openFloating']();
  const send = e.inst.float.opts.onMessage;
  const before = e.inst.poller.ticks.length;
  send({ type: 'ready', restoredSeq: 3 });
  assert.ok(e.inst.poller.ticks.length > before, 'ready answers with a fresh state');
  send({ type: 'setScope', scope: 'all' });
  assert.equal(e.inst.model.opts.scope, 'all');
  send({ type: 'refresh' });
  await sleep(20);
  assert.equal(e.inst.refresher.calls, 1);
  send({ type: 'handoff' });
  await sleep(40);
  assert.equal(e.inst.written.length, 1);
  send({ type: 'eval', code: '1' });                    // unknown types are ignored
});

test('the usage busy state reaches the floating window, also for a page that connects while /usage runs', async (t) => {
  const e = boot(t, { config: { 'usage.autoRefreshMinutes': 0 } });
  e.activate();
  e.resolve();
  await e.st.commands['agentView.openFloating']();
  e.st.refreshGate = new Promise(() => {});
  e.inst.float.opts.onMessage({ type: 'refresh' });
  await sleep(20);
  assert.deepEqual(e.inst.float.sent.filter((m) => m.type === 'usageBusy'), [{ type: 'usageBusy', busy: true }]);
  e.inst.float.opts.onMessage({ type: 'ready', restoredSeq: null });
  assert.equal(e.inst.float.sent.filter((m) => m.type === 'usageBusy').length, 2, 'a page that says ready is told it is busy');
});

test('the poller follows the floating window: it stops when the window closes and no view is visible', async (t) => {
  const e = boot(t);
  e.activate();
  await e.st.commands['agentView.openFloating']();
  assert.equal(e.inst.poller.running, true);
  e.inst.float.visible = false;
  e.inst.float.opts.onChange();
  assert.equal(e.inst.poller.running, false);
});

test('opening fails gracefully: no Windows, no browser, any other reason is a message, never an exception', async (t) => {
  for (const [why, text] of [['platform', /nur unter Windows/], ['no-browser', /Edge oder Google Chrome/], ['server', /\(server\)/]]) {
    const e = boot(t);
    e.st.floatOpen = { ok: false, why };
    e.activate();
    await e.st.commands['agentView.openFloating']();
    assert.match(String(e.st.infos[0][0]), /konnte nicht geöffnet werden/);
    assert.match(String(e.st.infos[0][0]), text);
    assert.equal(e.inst.poller, undefined, 'no poller for a window that did not open');
  }
});

test('a window that opened but could not be linked is reported (it does not stay in front of VS Code and does not close with it)', async (t) => {
  const e = boot(t);
  e.st.floatOpen = { ok: true, linked: false, linkWhy: 'ambiguous' };
  e.activate();
  await e.st.commands['agentView.openFloating']();
  assert.match(String(e.st.infos[0][0]), /nicht an VS Code gebunden werden \(ambiguous\)/);
  assert.match(String(e.st.infos[0][0]), /schließt nicht mit VS Code/);
});

test('a missing floatWindow module changes nothing else and the command says so', async (t) => {
  const e = boot(t, { noFloat: true });
  e.activate();
  await e.st.commands['agentView.openFloating']();
  assert.match(String(e.st.infos[0][0]), /Modul fehlt/);
  assert.deepEqual(Object.keys(e.st.commands).sort(), COMMAND_IDS);
});

test('deactivate closes the floating window', async (t) => {
  const e = boot(t);
  e.activate();
  await e.st.commands['agentView.openFloating']();
  e.ext.deactivate();
  assert.equal(e.inst.float.closes, 1);
});
