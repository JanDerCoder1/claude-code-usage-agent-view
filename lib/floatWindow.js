'use strict';
// The floating window: a real, stand-alone Windows window (Edge or Chrome in app mode: no tabs, no address bar, nothing of VS Code)
// that shows the cards from a local page server (lib/floatServer.js). The window is linked to the VS Code window it was opened from
// (lib/windowLink.js): it is an OWNED window, so it stays in front of VS Code but behind any other program, exactly like VS Code
// itself; a watcher closes it when that VS Code window goes away.
// The only other place that starts a process besides lib/usageRefresh.js and lib/windowLink.js: execFile of the browser, fixed arguments.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { FloatServer } = require('./floatServer');
const { WindowLinker } = require('./windowLink');

const NO_CLIENT_GRACE_MS = 45000;     // a window whose page never connected, or lost every connection, counts as closed after this

/** Edge first (it is part of Windows 11), then Chrome. Returns { exe, proc } or null. */
function findBrowser(env, exists) {
  const e = env || process.env;
  const ex = exists || ((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
  const pf = e['ProgramFiles'], pf86 = e['ProgramFiles(x86)'], local = e['LOCALAPPDATA'];
  const list = [];
  for (const base of [pf86, pf, local]) if (base) list.push({ exe: path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), proc: 'msedge' });
  for (const base of [pf, pf86, local]) if (base) list.push({ exe: path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), proc: 'chrome' });
  return list.find((c) => ex(c.exe)) || null;
}

class FloatWindow {
  /**
   * @param {{ mediaDir: string, profileDir: string, editorProc: string, theme: () => string, size: () => {width:number,height:number},
   *           watchOwner: () => boolean, onMessage: (m: object) => void, onChange: () => void, log?: (s: string) => void,
   *           platform?: string, env?: object, exists?: Function, execFile?: Function, makeServer?: Function, makeLinker?: Function,
   *           graceMs?: number }} opts
   */
  constructor(opts) {
    const o = opts || {};
    this.o = o;
    this.platform = o.platform || process.platform;
    this.log = typeof o.log === 'function' ? o.log : () => {};
    this._exec = o.execFile || execFile;
    this._makeServer = o.makeServer || ((x) => new FloatServer(x));
    this._makeLinker = o.makeLinker || ((auxProc) => new WindowLinker({ procName: o.editorProc, auxProc, retries: 14 }));
    this.graceMs = typeof o.graceMs === 'number' ? o.graceMs : NO_CLIENT_GRACE_MS;
    this._reset();
  }

  _reset() { this.server = null; this.child = null; this.linker = null; this.watcher = null; this.aux = 0; this._graceTimer = null; this._opening = null; }

  get isOpen() { return !!this.server; }
  get visible() { return !!(this.server && this.server.clients > 0); }

  broadcast(msg) { if (this.server) this.server.broadcast(msg); }

  /** Opens the window (or brings an open one forward). Resolves { ok, already?, linked, linkWhy? } | { ok:false, why }; never rejects. */
  open() {
    if (this._opening) return this._opening;
    this._opening = this._open().catch((e) => ({ ok: false, why: String((e && (e.code || e.message)) || 'error').slice(0, 60) })).then((r) => { this._opening = null; return r; });
    return this._opening;
  }

  async _open() {
    if (this.platform !== 'win32') return { ok: false, why: 'platform' };
    if (this.server) {
      if (this.aux && this.linker) await this.linker.activate(this.aux);
      return { ok: true, already: true, linked: true };
    }
    const browser = findBrowser(this.o.env, this.o.exists);
    if (!browser) return { ok: false, why: 'no-browser' };
    const size = this.o.size();
    const w = size.width > 0 ? size.width : 380, h = size.height > 0 ? size.height : 480;
    const linker = this._makeLinker(browser.proc);
    const snap = await linker.snapshot();           // while this VS Code window is still the foreground window
    const server = this._makeServer({
      mediaDir: this.o.mediaDir, theme: this.o.theme(), log: this.log,
      onMessage: (m) => this.o.onMessage(m),
      onClients: (n) => { this._onClients(n); this.o.onChange(); },
    });
    let started;
    try { started = await server.start(); } catch (e) { return { ok: false, why: 'server' }; }
    this.server = server;
    this.linker = linker;
    try { fs.mkdirSync(this.o.profileDir, { recursive: true }); } catch (_) { /* the browser creates it */ }
    const args = ['--app=' + started.url, '--user-data-dir=' + this.o.profileDir, '--no-first-run', '--no-default-browser-check', '--window-size=' + w + ',' + h];
    try {
      this.child = this._exec(browser.exe, args, { maxBuffer: 1024 * 1024 }, () => { this._childExited(); });   // not hidden: the window is the point
    } catch (e) {
      await this.close();
      return { ok: false, why: String((e && (e.code || e.message)) || 'start').slice(0, 60) };
    }
    this._armGrace();
    this.o.onChange();

    const r = await linker.link(snap, { owner: true, width: w, height: h });
    if (!this.server) return { ok: false, why: 'closed' };      // closed while we were looking for it
    if (r.ok && r.aux) {
      this.aux = r.aux;
      if (this.o.watchOwner() && snap && snap.ok) this.watcher = linker.watch(snap.main, r.aux, () => { this.log('Fenster geschlossen'); this.close(); });
      return { ok: true, linked: true };
    }
    this.log('Fenster nicht verknüpft (' + (r.why || 'unbekannt') + ')');
    return { ok: true, linked: false, linkWhy: r.why || 'unbekannt' };
  }

  _onClients(n) { if (n > 0) this._clearGrace(); else this._armGrace(); }
  _clearGrace() { if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null; } }
  _armGrace() {
    this._clearGrace();
    if (!this.server || this.server.clients > 0) return;
    // safety net when no watcher exists (no link): a page that never connected or lost its connection means the window is gone
    this._graceTimer = setTimeout(() => { this._graceTimer = null; if (this.server && this.server.clients === 0 && !this.aux) { this.log('Fenster ohne Verbindung, wird beendet'); this.close(); } }, this.graceMs);
    if (this._graceTimer.unref) this._graceTimer.unref();
  }

  _childExited() {
    // the browser process may hand over to a running instance and exit at once while the window lives on; only without a window handle is the exit the answer
    if (!this.aux && this.server && this.server.clients === 0) this._armGrace();
  }

  /** Closes the window (ends the browser process we started), stops the watcher and the server. */
  async close() {
    const { server, child, watcher } = this;
    this._clearGrace();
    this._reset();
    if (watcher) { try { watcher.stop(); } catch (_) { /* gone */ } }
    if (child && typeof child.kill === 'function') { try { child.kill(); } catch (_) { /* gone */ } }
    if (server) { try { await server.stop(); } catch (_) { /* closed */ } }
    this.o.onChange();
  }
}

module.exports = { FloatWindow, findBrowser, NO_CLIENT_GRACE_MS };
