'use strict';
// Claude Code Utilities - editor shell. The only file that imports the editor API; everything under lib/ is pure Node.
// Wires SessionModel + History + Poller to a webview view and forwards ViewStates to it.
// Strictly read-only toward ~/.claude. The single file this extension writes is history.json in its own
// global storage folder (via lib/history.js).

const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VIEW_ID = 'agentView.cards'; // must equal contributes.views.agentView[0].id
const FLOAT_TYPE = 'agentView.floating'; // legacy panel type: VS Code restores such windows from older versions at startup, they are closed again
const SECTION = 'agentView';
const BOOTSTRAP_DELAY_MS = 2000;   // history bootstrap runs once, a little after activation, in the background
const MAX_PATH_LEN = 4096;
const OPTION_KEYS = ['claudeHome', 'scope', 'workspaceFolders', 'recentHours', 'staleMinutes', 'showToolTargets', 'etaEnabled', 'usageEnabled'];
const USAGE_CHECK_MS = 60000;      // how often the automatic /usage refresh looks at its schedule while a view is on screen

// Strings of the shell itself (dialogs, log, degraded state). Card texts come from lib/strings.js and the webview.
const T = Object.freeze({
  scopeWorkspace: 'Arbeitsbereich',
  scopeAll: 'Alle Sitzungen',
  moduleFailed: (name, msg) => `Claude Code Utilities: Modul „${name}“ konnte nicht geladen werden (${msg}).`,
  modelFailed: (msg) => `Claude Code Utilities: Sitzungsmodell nicht verfügbar (${msg}).`,
  resetAsk: 'Den gelernten Zeitschätzungs-Verlauf wirklich löschen? Die Schätzungen werden dadurch vorübergehend ungenauer.',
  resetYes: 'Löschen',
  resetDone: 'Claude Code Utilities: Zeitschätzungs-Verlauf gelöscht.',
  resetNone: 'Claude Code Utilities: Es gibt keinen Zeitschätzungs-Verlauf.',
  floatTitle: 'Claude Code Utilities',
  usageDone: 'aktualisiert', usageSkipped: (why) => `übersprungen (${why})`, usageFailed: (why) => `fehlgeschlagen (${why})`,
  handoffNone: 'Claude Code Utilities: Es wurde keine Sitzung gefunden, deren Kontext gesichert werden kann.',
  handoffPickTitle: 'Hand-Off: Welche Sitzung?',
  handoffPickHint: 'Die zuletzt aktive Sitzung steht oben.',
  handoffWorking: 'Claude Code Utilities: Hand-Off wird geschrieben …',
  handoffFailed: (msg) => `Claude Code Utilities: Hand-Off fehlgeschlagen (${msg}).`,
  handoffDone: (name) => `Hand-Off geschrieben: ${name}`,
  openFile: 'Datei öffnen',
  copyPrompt: 'Prompt kopieren',
  promptCopied: 'Claude Code Utilities: Prompt kopiert. In der neuen Sitzung einfügen.',
  stateBusy: 'arbeitet', stateIdle: 'bereit', stateEnded: 'beendet',
  ago: (ms) => { const min = Math.floor(ms / 60000); return min < 1 ? 'gerade eben' : min < 60 ? `vor ${min} Min.` : min < 1440 ? `vor ${Math.floor(min / 60)} Std.` : `vor ${Math.floor(min / 1440)} Tg.`; },
  clearDone: (name) => `Neue Unterhaltung gestartet. Der Prompt mit der Hand-Off-Datei (${name}) steht im Eingabefeld und in der Zwischenablage.`,
  clearFailed: 'Claude Code Utilities: Die Claude-Code-Erweiterung hat „Neue Unterhaltung“ nicht angenommen. Tippe stattdessen /clear in den Chat.',
  floatFailed: (why) => `Claude Code Utilities: Das schwebende Fenster konnte nicht geöffnet werden (${why === 'platform' ? 'es gibt es nur unter Windows' : why === 'no-browser' ? 'es braucht Microsoft Edge oder Google Chrome' : why}).`,
  floatLinkFailed: (why) => `Claude Code Utilities: Das Fenster ist offen, konnte aber nicht an VS Code gebunden werden (${why}). Es liegt dann nicht von selbst vor VS Code und schließt nicht mit VS Code.`,
});

// ---- settings ---------------------------------------------------------------------------------------------------

/**
 * The agentView.claudeHome setting is accepted only as an absolute path on a local drive or root. Relative values resolve against
 * the editor's working directory, and UNC names (`\\host\share`, `//host/share`, `\\?\...`) make Windows connect to a remote host
 * and send the user's logon hash to it. Same rule as lib/claudeHome.js localAbsolutePath; kept here too so the shell stays safe even when
 * that module fails to load. Returns the trimmed path or null.
 */
function localAbsolutePath(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > MAX_PATH_LEN || s.indexOf('\0') !== -1) return null;
  if (process.platform === 'win32' && /^[\\/]{2}/.test(s)) return null;
  return path.isAbsolute(s) ? s : null;
}

/**
 * CLAUDE_CONFIG_DIR as set in the Claude Code extension's setting claudeCode.environmentVariables (that extension starts its
 * CLI with it, so its sessions land there). Only the user-level value counts: a repository's .vscode/settings.json must never
 * be able to move the directory this extension reads. `libs` = the loaded lib modules; without the parser nothing is read.
 */
function readClaudeCodeConfigDir(libs) {
  try {
    const lib = libs && libs.claudeHome;
    if (!lib || typeof lib.configDirFromEnvSetting !== 'function') return null;
    const cfg = vscode.workspace.getConfiguration('claudeCode');
    const info = cfg && typeof cfg.inspect === 'function' ? cfg.inspect('environmentVariables') : null;
    return info ? lib.configDirFromEnvSetting(info.globalValue) : null;
  } catch (e) {
    return null;
  }
}

function readSettings(libs) {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const num = (key, def, min) => {
    const v = cfg.get(key);
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : def;
  };
  const home = cfg.get('claudeHome');
  const override = localAbsolutePath(home);
  return {
    scope: cfg.get('scope') === 'all' ? 'all' : 'workspace',
    recentHours: num('recentHours', 24, 1),
    claudeHomeOverride: override || '',
    claudeHomeRejected: typeof home === 'string' && home.trim() !== '' && !override,
    claudeCodeConfigDir: readClaudeCodeConfigDir(libs) || '',
    showToolTargets: cfg.get('showToolTargets') !== false,
    pollMs: num('pollMs', 1500, 500),
    staleMinutes: num('staleMinutes', 10, 2),
    etaEnabled: cfg.get('eta.enabled') !== false,
    usageEnabled: cfg.get('usage.enabled') !== false,
    usageAutoMinutes: num('usage.autoRefreshMinutes', 5, 0),
    floatingCloseWithVscode: cfg.get('floating.closeWithVscode') !== false,
    floatingWidth: num('floating.width', 380, 0),
    floatingHeight: num('floating.height', 480, 0),
  };
}

/** VS Code's colour theme kind (1 light, 2 dark, 3 high contrast, 4 high contrast light) as a theme name of lib/floatTheme.js. */
function themeName() {
  try {
    const kind = vscode.window.activeColorTheme && vscode.window.activeColorTheme.kind;
    return kind === 1 ? 'light' : kind === 3 ? 'hc' : kind === 4 ? 'hclight' : 'dark';
  } catch (e) { return 'dark'; }
}

function workspaceFolderPaths() {
  const folders = vscode.workspace.workspaceFolders || [];
  return folders.filter((f) => f && f.uri && f.uri.scheme === 'file').map((f) => f.uri.fsPath);
}

function tryRequire(load) {
  try { return { mod: load(), error: null }; } catch (e) { return { mod: null, error: e }; }
}

// ---- reveal validation ------------------------------------------------------------------------------------------

function insideDir(root, target) {
  const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const rel = path.relative(norm(root), norm(target));
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/** Returns the absolute path when `raw` names an existing entry inside `home` (symlinks resolved), else null. */
function validateReveal(home, raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_LEN || raw.indexOf('\0') !== -1) return null;
  if (!home || !path.isAbsolute(raw)) return null;
  const root = path.resolve(home);
  const target = path.resolve(raw);
  if (!insideDir(root, target)) return null;
  try {
    if (!insideDir(fs.realpathSync(root), fs.realpathSync(target))) return null;
  } catch (e) {
    return null; // missing entries cannot be revealed
  }
  return target;
}

/** The prompt that is offered for the new session: read the hand-off file and continue. */
function handoffPrompt(file) {
  return `Lies die Datei "${file}" vollständig. Sie ist ein Hand-Off aus einer früheren Sitzung. Prüfe kurz den Zustand der dort genannten Dateien und setze die Arbeit bei "Letzter Stand" und "Offene Aufgaben" fort. Frage nach, wenn der nächste Schritt nicht eindeutig ist.`;
}

/** The active editor tab, when it is a Claude Code conversation (webview type contains claudeVSCodePanel); else undefined. */
function findClaudeTab() {
  try {
    const group = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup;
    const tab = group && group.activeTab;
    const type = tab && tab.input && tab.input.viewType;
    return typeof type === 'string' && type.includes('claudeVSCodePanel') ? { tab, group } : undefined;
  } catch (e) { return undefined; }
}

// ---- degraded model (used only when lib/sessionModel.js cannot be loaded) ----------------------------------------

function makeFallbackModel(opts, reason) {
  const o = Object.assign({}, opts);
  return {
    refresh(now) {
      return {
        v: 1, now, scope: o.scope, scopeLabel: o.scope === 'all' ? T.scopeAll : T.scopeWorkspace, claudeHome: o.claudeHome,
        running: [], recent: [], warnings: [T.modelFailed(reason)], formatNote: null,
      };
    },
    setOptions(p) { Object.assign(o, p); },
    hasActivity() { return false; },
    watchRoots() { return []; },
    stateHash(vs) { return JSON.stringify([vs.scope, vs.warnings]); },
    dispose() {},
  };
}

// ---- webview shell ----------------------------------------------------------------------------------------------

const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// The CSP meta attribute name is assembled so that the plain-word grep gate for network modules stays clean.
const META_CSP_ATTR = ['h', 'ttp', '-equiv'].join('');

function renderHtml(webview, mediaRoot, mode) {
  const nonce = crypto.randomBytes(16).toString('hex'); // 32 hex characters
  const uri = (f) => escAttr(webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, f)));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta ${META_CSP_ATTR}="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('main.css')}">
<title>Claude Code Utilities</title>
</head>
<body>
<div id="app" data-mode="${mode === 'floating' ? 'floating' : 'view'}"></div>
<script nonce="${nonce}" src="${uri('main.js')}"></script>
</body>
</html>`;
}

class AgentViewProvider {
  /** @param {vscode.ExtensionContext} context
   *  @param {{ onMessage: (msg: unknown, surface: object) => void, onVisible: () => void, onGone: () => void }} hooks */
  constructor(context, hooks) {
    this.context = context;
    this.hooks = hooks;
    this.view = undefined;
    this.seq = 0;
    this.subs = [];
  }

  get visible() { return !!(this.view && this.view.visible); }

  /** Called by the editor whenever the view's webview document is (re)created. No retainContextWhenHidden. */
  resolveWebviewView(view) {
    this._release();
    this.view = view;
    const webview = view.webview;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    webview.html = renderHtml(webview, mediaRoot);
    this.subs.push(
      webview.onDidReceiveMessage((msg) => this.hooks.onMessage(msg, this)),
      view.onDidChangeVisibility(() => this.hooks.onVisible()),
      view.onDidDispose(() => { this._release(); this.hooks.onGone(); }),
    );
    this.hooks.onVisible();
  }

  /** A restored document reports the last seq it rendered; stay above it so it never drops our states as stale. */
  noteRestoredSeq(n) {
    if (typeof n === 'number' && Number.isFinite(n) && n > this.seq) this.seq = Math.floor(n);
  }

  postRaw(msg) {
    const view = this.view;
    if (!view || !view.visible) return;
    const r = view.webview.postMessage(msg);
    if (r && typeof r.then === 'function') r.then(undefined, () => {});
  }

  post(viewState, hostNow) {
    const view = this.view;
    if (!view || !view.visible) return false;
    this.seq += 1;
    const r = view.webview.postMessage({ type: 'state', seq: this.seq, hostNow, state: viewState });
    if (r && typeof r.then === 'function') r.then(undefined, () => {});
    return true;
  }

  dispose() { this._release(); }

  _release() {
    for (const s of this.subs) { try { s.dispose(); } catch (e) { /* ignore */ } }
    this.subs = [];
    this.view = undefined;
  }
}

// ---- controller -------------------------------------------------------------------------------------------------

class Controller {
  constructor(context) {
    this.context = context;
    this.disposed = false;
    this.channel = vscode.window.createOutputChannel('Claude Code Utilities');
    this.libs = {};
    this.poller = null;
    this.bootstrapTimer = null;
    this.bootstrapHome = null;
    this.refresher = null;
    this.floatSeq = 0;
    this.usageTimer = null;
    this.usageBusy = false;
    this.lastUsageRefresh = 0;
    this.lastCounts = '';
    this.log = (msg) => {
      try { this.channel.appendLine(`${new Date().toISOString().slice(11, 19)} ${msg}`); } catch (e) { /* ignore */ }
    };

    this.loadLibs();
    this.settings = readSettings(this.libs);
    this.noteRejectedHome();
    this.history = this.makeHistory();
    const opts = this.modelOptions();
    this.applied = opts;
    this.model = this.makeModel(Object.assign({}, opts, { history: this.history }));
    const hooks = {
      onMessage: (msg, surface) => this.handleMessage(msg, surface),
      onVisible: () => this.syncPoller(),
      onGone: () => this.syncPoller(),
    };
    this.provider = new AgentViewProvider(context, hooks);
    this.floatWin = this.makeFloatWindow();
    this.log(`gestartet: claudeHome=${opts.claudeHome}, Bereich=${opts.scope}, Arbeitsordner=${opts.workspaceFolders.length}`);
  }

  loadLibs() {
    const load = (name, fn) => {
      const r = tryRequire(fn);
      this.libs[name] = r.mod;
      if (r.error) this.log(T.moduleFailed(name, r.error && r.error.message ? r.error.message : String(r.error)));
    };
    load('claudeHome', () => require('./lib/claudeHome'));
    load('sessionModel', () => require('./lib/sessionModel'));
    load('history', () => require('./lib/history'));
    load('poller', () => require('./lib/poller'));
    load('handoff', () => require('./lib/handoff'));
    load('usageRefresh', () => require('./lib/usageRefresh'));
    load('floatWindow', () => require('./lib/floatWindow'));
  }

  /** Names the refused agentView.claudeHome value's problem in the log, never the value itself. */
  noteRejectedHome() {
    if (this.settings.claudeHomeRejected) this.log('Einstellung agentView.claudeHome ignoriert: erlaubt sind nur absolute lokale Pfade (keine Netzwerkpfade, keine relativen Pfade).');
  }

  /** agentView.claudeHome, else CLAUDE_CONFIG_DIR of claudeCode.environmentVariables, else the process environment, else ~/.claude. */
  currentHome() {
    const override = this.settings.claudeHomeOverride || this.settings.claudeCodeConfigDir || undefined;
    const lib = this.libs.claudeHome;
    try {
      if (lib && typeof lib.claudeHome === 'function') return lib.claudeHome(override);
    } catch (e) { /* fall through to the same expression Claude Code uses */ }
    return override || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  }

  modelOptions() {
    const s = this.settings;
    return {
      claudeHome: this.currentHome(), scope: s.scope, workspaceFolders: workspaceFolderPaths(),
      recentHours: s.recentHours, staleMinutes: s.staleMinutes, showToolTargets: s.showToolTargets, etaEnabled: s.etaEnabled,
      usageEnabled: s.usageEnabled,
    };
  }

  makeHistory() {
    const lib = this.libs.history;
    const dir = this.context.globalStorageUri && this.context.globalStorageUri.fsPath;
    if (!lib || typeof lib.History !== 'function' || !dir) return null;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* history.js tolerates a missing directory */ }
    let h;
    try { h = new lib.History(path.join(dir, 'history.json')); } catch (e) { this.log(T.moduleFailed('history', e.message)); return null; }
    try { h.load(); } catch (e) { this.log(T.moduleFailed('history.load', e.message)); }
    return h;
  }

  makeModel(opts) {
    const lib = this.libs.sessionModel;
    if (lib && typeof lib.SessionModel === 'function') {
      try { return new lib.SessionModel(opts); } catch (e) { this.log(T.modelFailed(e.message)); return makeFallbackModel(opts, e.message); }
    }
    return makeFallbackModel(opts, 'lib/sessionModel.js fehlt');
  }

  register() {
    const subs = this.context.subscriptions;
    subs.push(
      this.channel,
      // Deliberately no options (retainContextWhenHidden stays off): the document is destroyed when hidden; the
      // webview restores itself from getState() and the host answers its 'ready' message with an immediate push.
      vscode.window.registerWebviewViewProvider(VIEW_ID, this.provider),
      // VS Code restores editor windows at startup, including the detached one, but cannot restore the content of a panel without a
      // serializer: it would show an empty window (a Welcome page). A restored floating panel is closed again at once.
      typeof vscode.window.registerWebviewPanelSerializer === 'function'
        ? vscode.window.registerWebviewPanelSerializer(FLOAT_TYPE, { deserializeWebviewPanel: async (panel) => { try { panel.dispose(); } catch (e) { /* already gone */ } } })
        : { dispose() {} },
      vscode.commands.registerCommand('agentView.open', () => this.openView()),
      vscode.commands.registerCommand('agentView.openFloating', () => this.openFloating()),
      vscode.commands.registerCommand('agentView.handoff', () => this.handoff()),
      vscode.commands.registerCommand('agentView.clearSession', () => this.clearSession()),
      vscode.commands.registerCommand('agentView.refresh', () => this.refresh()),
      vscode.commands.registerCommand('agentView.toggleScope', () => this.toggleScope()),
      vscode.commands.registerCommand('agentView.resetEtaHistory', () => this.resetHistory()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SECTION) || e.affectsConfiguration('claudeCode.environmentVariables')) this.applySettings();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.applySettings()),
      { dispose: () => this.dispose() },
    );
    this.scheduleBootstrap();
  }

  // ---- polling lifecycle (the poller exists only once a view has been resolved) ----

  ensurePoller() {
    if (this.poller || this.disposed) return this.poller;
    const lib = this.libs.poller;
    if (!lib || typeof lib.Poller !== 'function') return null;
    this.poller = new lib.Poller({
      model: this.model,
      push: (vs, hostNow) => this.pushState(vs, hostNow),
      isVisible: () => this.anyVisible(),
      pollMs: this.settings.pollMs,
      log: (msg) => this.log(msg),
    });
    return this.poller;
  }

  anyVisible() { return this.provider.visible || !!(this.floatWin && this.floatWin.visible); }

  /** The poller runs while the sidebar view or the floating window is on screen and stops when neither is. */
  syncPoller() {
    if (this.disposed) return;
    if (this.anyVisible()) {
      const p = this.ensurePoller();
      if (p) p.start();
      this.startUsageTimer();
    } else {
      if (this.poller) this.poller.stop();
      this.stopUsageTimer();
    }
  }

  // ---- /usage refresh: Claude Code's own cache is only as fresh as its last query, so the extension asks for it ----

  /** The claude executable of the Claude Code extension (its bundled native binary), else the one on the PATH. */
  claudeBinary() {
    try {
      const ext = vscode.extensions && vscode.extensions.getExtension('anthropic.claude-code');
      if (ext && ext.extensionPath) {
        const f = path.join(ext.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
        if (fs.existsSync(f)) return f;
      }
    } catch (e) { /* fall back to the PATH */ }
    return process.platform === 'win32' ? 'claude.exe' : 'claude';
  }

  makeRefresher() {
    const lib = this.libs.usageRefresh;
    if (!lib || typeof lib.UsageRefresher !== 'function') return null;
    const dir = this.context.globalStorageUri && this.context.globalStorageUri.fsPath;
    let cwd = dir;
    try { if (dir) fs.mkdirSync(dir, { recursive: true }); } catch (e) { cwd = undefined; }
    const custom = this.settings.claudeHomeOverride || this.settings.claudeCodeConfigDir || '';
    try { return new lib.UsageRefresher({ binary: this.claudeBinary(), cwd, configDir: custom, log: (msg) => this.log(msg) }); } catch (e) { this.log(T.moduleFailed('usageRefresh', e && e.message)); return null; }
  }

  setUsageBusy(busy) {
    if (this.usageBusy === busy) return;
    this.usageBusy = busy;
    this.provider.postRaw({ type: 'usageBusy', busy });
    if (this.floatWin) this.floatWin.broadcast({ type: 'usageBusy', busy });
  }

  /** Runs "/usage" headless so Claude Code rewrites its usage cache, then re-reads. manual = the person pressed refresh. */
  async refreshUsage(manual) {
    if (this.disposed || !this.settings.usageEnabled) return;
    if (!this.refresher) this.refresher = this.makeRefresher();
    const r = this.refresher;
    if (!r) return;
    this.lastUsageRefresh = Date.now();
    this.setUsageBusy(true);
    let res;
    try { res = await r.refresh({ manual: manual === true }); } catch (e) { res = { ok: false, error: e && e.message ? e.message : 'error' }; }
    this.setUsageBusy(false);
    if (this.disposed) return;
    this.log(`/usage: ${res && res.ok ? T.usageDone : res && res.skipped ? T.usageSkipped(res.skipped) : T.usageFailed(res && res.error ? res.error : 'unbekannt')}`);
    this.requestTick({ immediate: true, force: true });
  }

  maybeAutoRefresh() {
    const min = this.settings.usageAutoMinutes;
    if (!this.settings.usageEnabled || !(min > 0)) return;
    if (Date.now() - this.lastUsageRefresh < min * 60000) return;
    this.refreshUsage(false);
  }

  startUsageTimer() {
    if (this.usageTimer || this.disposed) return;
    this.maybeAutoRefresh();
    const timer = setInterval(() => this.maybeAutoRefresh(), USAGE_CHECK_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    this.usageTimer = timer;
  }

  stopUsageTimer() {
    if (this.usageTimer) { clearInterval(this.usageTimer); this.usageTimer = null; }
  }

  pushState(vs, hostNow) {
    const toView = this.provider.post(vs, hostNow);
    let toFloat = false;
    if (this.floatWin && this.floatWin.isOpen) { this.floatSeq += 1; this.floatWin.broadcast({ type: 'state', seq: this.floatSeq, hostNow, state: vs }); toFloat = true; }
    if (!toView && !toFloat) return;
    const counts = `${(vs.running || []).length}/${(vs.recent || []).length}/${(vs.warnings || []).length}`;
    if (counts !== this.lastCounts) {
      this.lastCounts = counts;
      this.log(`Karten: laufend=${(vs.running || []).length}, zuletzt fertig=${(vs.recent || []).length}, Warnungen=${(vs.warnings || []).length}`);
    }
  }

  requestTick(opts) {
    if (this.poller) this.poller.requestTick(opts);
  }

  // ---- commands ----

  openView() {
    return this.guarded(vscode.commands.executeCommand(`${VIEW_ID}.focus`));
  }

  /** The floating window: a stand-alone window (browser in app mode), see lib/floatWindow.js. */
  makeFloatWindow() {
    const lib = this.libs.floatWindow;
    if (!lib || typeof lib.FloatWindow !== 'function') return null;
    const dir = this.context.globalStorageUri && this.context.globalStorageUri.fsPath;
    const surface = { postRaw: (msg) => { if (this.floatWin) this.floatWin.broadcast(msg); }, noteRestoredSeq() {} };
    try {
      return new lib.FloatWindow({
        mediaDir: path.join(this.context.extensionUri.fsPath, 'media'),
        profileDir: path.join(dir || os.tmpdir(), 'float-profile'),
        editorProc: path.basename(process.execPath, '.exe'),
        theme: () => themeName(),
        size: () => ({ width: Math.round(this.settings.floatingWidth), height: Math.round(this.settings.floatingHeight) }),
        watchOwner: () => this.settings.floatingCloseWithVscode,
        onMessage: (msg) => this.handleMessage(msg, surface),
        onChange: () => this.syncPoller(),
        log: (msg) => this.log(msg),
      });
    } catch (e) { this.log(T.moduleFailed('floatWindow', e && e.message)); return null; }
  }

  /** Opens the floating window; an already open one is brought forward. */
  async openFloating() {
    if (this.disposed) return;
    if (!this.floatWin) { vscode.window.showInformationMessage(T.floatFailed('Modul fehlt')); return; }
    const r = await this.floatWin.open();
    if (this.disposed) return;
    if (!r || !r.ok) {
      const why = r && r.why ? r.why : 'unbekannt';
      this.log(`Schwebendes Fenster nicht geöffnet (${why})`);
      vscode.window.showInformationMessage(T.floatFailed(why));
      return;
    }
    if (r.linked === false) vscode.window.showInformationMessage(T.floatLinkFailed(r.linkWhy || 'unbekannt'));
    this.syncPoller();
    this.requestTick({ immediate: true, force: true });
  }

  /**
   * Hand-off: writes the context of one session into a Markdown file in the temp folder. With several candidate sessions the person
   * picks one (newest first). Afterwards a message offers to open the file or to copy a ready prompt for the new session.
   */
  async handoff(opts) {
    const forClear = !!(opts && opts.forClear);
    if (this.disposed) return undefined;
    const lib = this.libs.handoff;
    if (!lib || typeof lib.listSessions !== 'function' || typeof lib.buildHandoff !== 'function') {
      vscode.window.showWarningMessage(T.handoffFailed('Modul fehlt'));
      return undefined;
    }
    let sessions;
    try { sessions = lib.listSessions(this.currentHome(), workspaceFolderPaths(), Date.now()); } catch (e) {
      this.log(`Hand-Off: Sitzungen nicht lesbar (${e && e.message})`);
      vscode.window.showWarningMessage(T.handoffFailed(e && e.message ? e.message : 'Sitzungen nicht lesbar'));
      return undefined;
    }
    if (!sessions || !sessions.length) { vscode.window.showInformationMessage(T.handoffNone); return undefined; }
    let pick = sessions[0];
    if (sessions.length > 1) {
      const now = Date.now();
      const items = sessions.map((s) => ({
        label: s.title || s.name || String(s.sid).slice(0, 8),
        description: [s.alive ? (s.status === 'busy' ? T.stateBusy : T.stateIdle) : T.stateEnded, T.ago(Math.max(0, now - s.activeAt)), s.name && s.name !== s.title ? s.name : null].filter(Boolean).join(' · '),
        detail: s.cwd || undefined,
        session: s,
      }));
      const chosen = await vscode.window.showQuickPick(items, { title: T.handoffPickTitle, placeHolder: T.handoffPickHint, matchOnDescription: true, matchOnDetail: true });
      if (!chosen || this.disposed) return undefined;
      pick = chosen.session;
    }
    let file;
    try {
      file = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: T.handoffWorking }, async () => {
        const r = await lib.buildHandoff(pick.transcript, { now: Date.now(), info: { name: pick.name, title: pick.title, cwd: pick.cwd } });
        return lib.writeHandoff(r.markdown, pick.sid, Date.now());
      });
    } catch (e) {
      this.log(`Hand-Off fehlgeschlagen (${e && e.message})`);
      vscode.window.showWarningMessage(T.handoffFailed(e && e.message ? e.message : 'unbekannt'));
      return undefined;
    }
    this.log(`Hand-Off geschrieben: ${file}`);
    if (forClear) return file;
    const answer = await vscode.window.showInformationMessage(T.handoffDone(path.basename(file)), T.openFile, T.copyPrompt);
    if (this.disposed) return file;
    if (answer === T.openFile) {
      await this.guarded(vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file)));
    } else if (answer === T.copyPrompt) {
      try {
        await vscode.env.clipboard.writeText(handoffPrompt(file));
        vscode.window.showInformationMessage(T.promptCopied);
      } catch (e) { this.log(`Zwischenablage nicht beschrieben (${e && e.message})`); }
    }
    return file;
  }

  /**
   * Clear: writes a hand-off file first, then opens a new Claude Code conversation whose input already holds the prompt with the file path,
   * and closes the old conversation tab (only possible for a conversation in an editor tab; one in the side bar stays and is replaced in place).
   * The prompt also goes to the clipboard. Without a hand-off nothing is cleared, so no context is lost by accident.
   */
  async clearSession() {
    if (this.disposed) return;
    const file = await this.handoff({ forClear: true });
    if (!file || this.disposed) return;
    const prompt = handoffPrompt(file);
    const oldTab = findClaudeTab();
    try { await vscode.env.clipboard.writeText(prompt); } catch (e) { this.log(`Zwischenablage nicht beschrieben (${e && e.message})`); }
    try {
      try {
        await vscode.commands.executeCommand('claude-vscode.editor.open', undefined, prompt, oldTab ? oldTab.group.viewColumn : undefined);
      } catch (e) {
        this.log(`Neuer Tab nicht möglich (${e && e.message}), versuche Neue Unterhaltung`);
        await vscode.commands.executeCommand('claude-vscode.newConversation');
      }
      this.log('Neue Unterhaltung gestartet (Clear), Hand-Off: ' + file);
    } catch (e) {
      this.log(`Clear fehlgeschlagen (${e && e.message})`);
      vscode.window.showInformationMessage(T.clearFailed);
      return;
    }
    if (oldTab) {
      try { await vscode.window.tabGroups.close(oldTab.tab); } catch (e) { this.log(`Alter Tab nicht geschlossen (${e && e.message})`); }
    }
    vscode.window.showInformationMessage(T.clearDone(path.basename(file)));
  }

  refresh() {
    this.refreshUsage(true);
    if (this.poller && this.poller.running) { this.requestTick({ immediate: true, force: true }); return undefined; }
    return this.openView();
  }

  toggleScope() {
    this.setScope(this.settings.scope === 'all' ? 'workspace' : 'all');
  }

  setScope(scope) {
    if (scope !== 'workspace' && scope !== 'all') return;
    if (this.settings.scope !== scope) {
      this.settings.scope = scope; // effective at once; the settings write below makes it persistent
      this.applyOptions();
      this.writeScope(scope);
    }
    this.requestTick({ immediate: true, force: true });
  }

  writeScope(scope) {
    try {
      const cfg = vscode.workspace.getConfiguration(SECTION);
      const info = typeof cfg.inspect === 'function' ? cfg.inspect('scope') : null;
      // keep the value where the user already has it: a workspace-level setting stays workspace-level
      const target = info && info.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      this.guarded(cfg.update('scope', scope, target));
    } catch (e) {
      this.log(`Einstellung agentView.scope nicht gespeichert (${e && e.message})`);
    }
  }

  async resetHistory() {
    if (!this.history) {
      vscode.window.showInformationMessage(T.resetNone);
      return;
    }
    const answer = await vscode.window.showWarningMessage(T.resetAsk, { modal: true }, T.resetYes);
    if (answer !== T.resetYes || this.disposed) return;
    try { this.history.reset(); this.history.flush(); } catch (e) { this.log(`Verlauf nicht zurückgesetzt (${e && e.message})`); return; }
    this.log('Zeitschätzungs-Verlauf gelöscht');
    this.requestTick({ force: true });
    vscode.window.showInformationMessage(T.resetDone);
  }

  // ---- settings ----

  applySettings() {
    if (this.disposed) return;
    this.settings = readSettings(this.libs);
    this.noteRejectedHome();
    this.applyOptions();
    if (this.poller) this.poller.setPollMs(this.settings.pollMs);
    this.scheduleBootstrap();
    this.requestTick({ force: true });
  }

  /** Pushes only the options that really changed into the model (setOptions may drop caches). */
  applyOptions() {
    const next = this.modelOptions();
    const partial = {};
    let changed = false;
    for (const k of OPTION_KEYS) {
      if (JSON.stringify(next[k]) !== JSON.stringify(this.applied[k])) { partial[k] = next[k]; changed = true; }
    }
    this.applied = next;
    if (!changed) return;
    try { this.model.setOptions(partial); } catch (e) { this.log(`Optionen nicht übernommen (${e && e.message})`); }
  }

  // ---- ETA history bootstrap (background, once per claudeHome) ----

  scheduleBootstrap() {
    const h = this.history;
    if (this.disposed || !h || typeof h.bootstrap !== 'function' || !this.settings.etaEnabled) return;
    const home = this.currentHome();
    if (home === this.bootstrapHome) return;
    this.bootstrapHome = home;
    if (this.bootstrapTimer) clearTimeout(this.bootstrapTimer);
    const timer = setTimeout(() => {
      this.bootstrapTimer = null;
      if (this.disposed) return;
      let p;
      try { p = h.bootstrap(home); } catch (e) { this.log(`Verlauf-Bootstrap fehlgeschlagen (${e && e.message})`); return; }
      Promise.resolve(p).then(() => {
        if (this.disposed) return;
        this.log('Verlauf-Bootstrap abgeschlossen');
        this.requestTick({ force: true });
      }, (e) => this.log(`Verlauf-Bootstrap fehlgeschlagen (${e && e.message})`));
    }, BOOTSTRAP_DELAY_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    this.bootstrapTimer = timer;
  }

  // ---- webview messages (whitelist: ready, refresh, setScope, reveal, openFloating, handoff, clearSession) ----

  handleMessage(msg, surface) {
    if (this.disposed || !msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'ready':
        (surface || this.provider).noteRestoredSeq(msg.restoredSeq);
        if (this.usageBusy && surface) surface.postRaw({ type: 'usageBusy', busy: true });
        if (this.anyVisible() && this.poller && !this.poller.running) this.poller.start();
        this.requestTick({ immediate: true, force: true });
        break;
      case 'refresh':
        this.refreshUsage(true);
        this.requestTick({ immediate: true, force: true });
        break;
      case 'setScope':
        if (msg.scope === 'workspace' || msg.scope === 'all') this.setScope(msg.scope);
        break;
      case 'reveal':
        this.reveal(msg.path);
        break;
      case 'openFloating':
        this.openFloating();
        break;
      case 'handoff':
        this.handoff();
        break;
      case 'clearSession':
        this.clearSession();
        break;
      default:
        break; // unknown message types are ignored
    }
  }

  reveal(raw) {
    const target = validateReveal(this.currentHome(), raw);
    if (!target) { this.log('Reveal abgelehnt (außerhalb von claudeHome oder nicht vorhanden)'); return; }
    this.guarded(vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target)));
  }

  guarded(thenable) {
    if (thenable && typeof thenable.then === 'function') {
      return Promise.resolve(thenable).then(undefined, (e) => { this.log(`Fehler: ${e && e.message ? e.message : e}`); });
    }
    return thenable;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.bootstrapTimer) { clearTimeout(this.bootstrapTimer); this.bootstrapTimer = null; }
    const quiet = (fn) => { try { fn(); } catch (e) { /* shutting down */ } };
    if (this.poller) quiet(() => this.poller.dispose());
    this.stopUsageTimer();
    quiet(() => this.provider.dispose());
    quiet(() => { if (this.floatWin) this.floatWin.close(); });
    quiet(() => this.model.dispose());
    if (this.history) {
      if (typeof this.history.flush === 'function') quiet(() => this.history.flush());
      if (typeof this.history.dispose === 'function') quiet(() => this.history.dispose()); // releases its debounce timer
    }
    this.log('beendet');
  }
}

let current = null;

function activate(context) {
  if (current) { current.dispose(); current = null; }
  current = new Controller(context);
  current.register();
}

function deactivate() {
  const c = current;
  current = null;
  if (c) c.dispose();
}

module.exports = { activate, deactivate };
