'use strict';
// Poller (SPEC 9): chained timers + fs.watch as a change hint. Pure Node, no editor import.
//
// The stat poll is the correctness net (writers that keep the file descriptor open produce late or missing
// watch events); fs.watch only shortens the latency. Everything time- or fs-related can be injected so the
// cadence is testable with a fake clock: opts.timers {setTimeout, clearTimeout}, opts.now, opts.fs {watch}.
//
// Cadence: pollMs while model.hasActivity(now), else 5 s. A tick is synchronous (model.refresh is), guarded
// against re-entrancy, never closer than 250 ms to the previous tick, and watch events are coalesced into one
// tick 150 ms after the first event of a burst.

const nodeFs = require('fs');

const DEBOUNCE_MS = 150;      // watch events of one burst -> one tick
const MIN_TICK_GAP_MS = 250;  // never tick more often than this
const IDLE_POLL_MS = 5000;    // nothing running, nothing changed lately
const HEARTBEAT_MS = 10000;   // push an unchanged state at least this often (webview liveness)
const WATCH_SYNC_MS = 5000;   // how often model.watchRoots() is re-read
const WATCH_RETRY_MS = 30000; // retry a watch that failed or whose directory did not exist yet
const MIN_POLL_MS = 250;
const DEFAULT_POLL_MS = 1500;
const WATCH_FILE = /\.jsonl?$/i;
// The name a watch event reports for the watched directory ITSELF (Windows, after it was deleted or renamed): an absolute path,
// where every real event carries a name relative to the directory.
const ROOT_NAME = /^(?:[a-zA-Z]:[\\/]|[\\/])/;

function clampPoll(n) {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(MIN_POLL_MS, Math.round(n)) : DEFAULT_POLL_MS;
}

function errText(e) {
  if (e && typeof e === 'object') return String(e.code || e.message || e);
  return String(e);
}

class Poller {
  /** @param {{ model: object, push: (viewState: object, hostNow: number) => void, isVisible: () => boolean,
   *   pollMs: number, log: (msg: string) => void, fs?: object, timers?: object, now?: () => number }} opts */
  constructor(opts) {
    const o = opts || {};
    this.model = o.model;
    this.pollMs = clampPoll(o.pollMs);
    this._push = typeof o.push === 'function' ? o.push : () => {};
    this._isVisible = typeof o.isVisible === 'function' ? o.isVisible : () => true;
    this._log = typeof o.log === 'function' ? o.log : () => {};
    this._fs = o.fs || nodeFs;
    // looked up at call time so that a test runner replacing the global timers is honoured
    this._timers = o.timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) };
    this._now = typeof o.now === 'function' ? o.now : Date.now;

    this._running = false;
    this._disposed = false;
    this._ticking = false;
    this._pending = false;          // a request arrived while a tick was running
    this._pendingImmediate = false;
    this._force = false;            // next tick pushes even if the hash is unchanged
    this._activeNow = false;        // model.hasActivity() of the last tick (cadence choice)
    this._pollTimer = null;
    this._reqTimer = null;
    this._reqDue = 0;
    this._lastTickAt = -Infinity;
    this._lastPushAt = 0;
    this._lastHash = null;
    this._lastSyncAt = -Infinity;
    this._needSync = false;
    this._lastErr = null;
    this._watchers = new Map();     // dir -> FSWatcher
    this._ids = new Map();          // dir -> identity of the directory the watcher was opened on (see _identity)
    this._retryAt = new Map();      // dir -> epoch ms of the next attempt
  }

  get running() { return this._running; }

  /** Directories that currently have a live fs.watch (for diagnostics and tests). */
  get watching() { return Array.from(this._watchers, (e) => e[0]); }

  start() {
    if (this._disposed || this._running) return;
    if (!this._safeVisible()) return;
    this._running = true;
    this._force = true;
    this._lastHash = null;
    this._lastErr = null;
    this._lastTickAt = -Infinity;
    this._needSync = true;
    this._syncWatchers(this._now());
    this._scheduleRequest(true);
    this._say('Abfrage gestartet');
  }

  stop() {
    const was = this._running;
    this._running = false;
    this._pending = false;
    this._pendingImmediate = false;
    this._clearTimer('_pollTimer');
    this._clearTimer('_reqTimer');
    for (const w of this._watchers.values()) this._closeQuiet(w);
    this._watchers.clear();
    this._ids.clear();
    this._retryAt.clear();
    if (was) this._say('Abfrage gestoppt');
  }

  /** Ask for a tick soon. opts.immediate skips the debounce, opts.force pushes even an unchanged state. */
  requestTick(opts) {
    if (!this._running || this._disposed) return;
    const o = opts || {};
    if (o.force) this._force = true;
    if (this._ticking) {
      this._pending = true;
      this._pendingImmediate = this._pendingImmediate || !!o.immediate;
      return;
    }
    this._scheduleRequest(!!o.immediate);
  }

  setPollMs(n) {
    const v = clampPoll(n);
    if (v === this.pollMs) return;
    this.pollMs = v;
    if (this._running && !this._ticking) this._schedulePoll();
  }

  dispose() {
    this._disposed = true;
    this.stop();
  }

  // ---- scheduling -------------------------------------------------------------------------------------------

  _scheduleRequest(immediate) {
    const now = this._now();
    const due = Math.max(now + (immediate ? 0 : DEBOUNCE_MS), this._lastTickAt + MIN_TICK_GAP_MS);
    if (this._reqTimer) {
      if (due >= this._reqDue) return; // an earlier (or equal) tick is already queued: coalesce
      this._clearTimer('_reqTimer');
    }
    this._reqDue = due;
    this._reqTimer = this._timers.setTimeout(() => { this._reqTimer = null; this._runTick(); }, Math.max(0, due - now));
  }

  _schedulePoll() {
    this._clearTimer('_pollTimer');
    if (!this._running) return;
    const delay = this._activeNow ? this.pollMs : Math.max(this.pollMs, IDLE_POLL_MS);
    this._pollTimer = this._timers.setTimeout(() => { this._pollTimer = null; this._runTick(); }, delay);
  }

  _clearTimer(name) {
    if (this[name] !== null) {
      try { this._timers.clearTimeout(this[name]); } catch (e) { /* ignore */ }
      this[name] = null;
    }
  }

  // ---- the tick ---------------------------------------------------------------------------------------------

  _runTick() {
    if (!this._running) return;
    if (this._ticking) { this._pending = true; return; }
    if (!this._safeVisible()) { this.stop(); return; }
    this._ticking = true;
    const t0 = this._now();
    this._lastTickAt = t0;
    this._clearTimer('_pollTimer');
    this._clearTimer('_reqTimer'); // this tick answers every request queued so far
    let active = false;
    try {
      const vs = this.model.refresh(t0);
      if (this._running) { // the model may have stopped us meanwhile
        if (this._needSync || t0 - this._lastSyncAt >= WATCH_SYNC_MS) { this._needSync = false; this._syncWatchers(t0); }
        active = this._safeActive(t0);
        this._deliver(vs, t0);
      }
      this._lastErr = null;
    } catch (e) {
      const msg = errText(e);
      if (msg !== this._lastErr) { this._lastErr = msg; this._say('Fehler beim Aktualisieren: ' + msg); }
    } finally {
      this._ticking = false;
    }
    if (!this._running) return; // stop()/dispose() was called from inside the model or the push callback
    this._activeNow = active;
    if (this._pending) {
      const immediate = this._pendingImmediate;
      this._pending = false;
      this._pendingImmediate = false;
      this._scheduleRequest(immediate);
    }
    this._schedulePoll();
  }

  _deliver(vs, t0) {
    if (!vs) return;
    let hash = null;
    try { hash = this.model.stateHash(vs); } catch (e) { hash = null; }
    const due = this._force || hash === null || hash !== this._lastHash || t0 - this._lastPushAt >= HEARTBEAT_MS - 100;
    if (!due) return;
    this._force = false;
    this._lastHash = hash;
    this._lastPushAt = t0;
    try { this._push(vs, this._now()); } catch (e) { this._say('Fehler beim Senden: ' + errText(e)); }
  }

  _safeVisible() {
    try { return !!this._isVisible(); } catch (e) { return false; }
  }

  _safeActive(now) {
    try { return !!this.model.hasActivity(now); } catch (e) { return false; }
  }

  // ---- fs.watch hint ----------------------------------------------------------------------------------------

  _syncWatchers(now) {
    if (!this._running) return;
    this._lastSyncAt = now;
    let roots = [];
    try {
      const r = this.model.watchRoots();
      if (Array.isArray(r)) roots = r.filter((s) => typeof s === 'string' && s.length > 0);
    } catch (e) { roots = []; }
    const want = new Set(roots);
    for (const [dir, w] of this._watchers) {
      // A handle follows the directory it was opened on: after that one was deleted (or renamed away) and a new one took its
      // name, it never sees the new one. Replaced under the same name = new identity: drop it, it is re-opened below.
      const id = this._ids.get(dir);
      if (!want.has(dir) || (id && this._identity(dir) !== id)) this._release(dir, w);
    }
    for (const [dir] of this._retryAt) {
      if (!want.has(dir)) this._retryAt.delete(dir);
    }
    for (const dir of want) {
      if (this._watchers.has(dir)) continue;
      const next = this._retryAt.get(dir);
      if (next !== undefined && now < next) continue;
      this._openWatcher(dir, now);
    }
  }

  _openWatcher(dir, now) {
    let w;
    try {
      w = this._fs.watch(dir, { recursive: true, persistent: false }, (evt, name) => this._onWatch(name, dir, w));
    } catch (e) {
      // Directory missing or recursive watching unavailable: polling carries on, the watch is retried later.
      if (!this._retryAt.has(dir)) this._say('Verzeichnis wird nur per Abfrage beobachtet (' + errText(e) + '): ' + dir);
      this._retryAt.set(dir, now + WATCH_RETRY_MS);
      return;
    }
    if (!w) { this._retryAt.set(dir, now + WATCH_RETRY_MS); return; }
    if (typeof w.on === 'function') {
      w.on('error', (err) => {
        this._release(dir, w);
        this._retryAt.set(dir, this._now() + WATCH_RETRY_MS);
        this._say('Beobachtung beendet (' + errText(err) + '): ' + dir);
      });
    }
    this._watchers.set(dir, w);
    this._ids.set(dir, this._identity(dir));
    this._retryAt.delete(dir);
    this._say('Beobachte ' + dir);
  }

  /** Same value while the directory stays the same one; null when it cannot be stat'ed (then no comparison is made). */
  _identity(dir) {
    try {
      const st = (this._fs.statSync || nodeFs.statSync)(dir);   // an injected fs may offer only watch()
      return st.ino + ':' + st.birthtimeMs;
    } catch (e) {
      return null;
    }
  }

  _release(dir, w) {
    this._closeQuiet(w);
    if (this._watchers.get(dir) === w) this._watchers.delete(dir);
    this._ids.delete(dir);
  }

  _onWatch(name, dir, w) {
    if (name === null || name === undefined) return;
    // On Windows a watched directory that was deleted or renamed keeps reporting its OWN absolute path, hundreds of thousands
    // of times per second, and never recovers. Close the handle at once; the next tick re-opens a live one on the new directory.
    if (dir !== undefined && ROOT_NAME.test(String(name))) {
      if (this._watchers.get(dir) !== w) return;                // already released: late events of a closing handle
      this._release(dir, w);
      this._needSync = true;
      this.requestTick();
      return;
    }
    if (!WATCH_FILE.test(String(name))) return;
    // A watch event can mean a new session, run or agent file: make the next tick rediscover instead of waiting for the
    // 5 s discovery cadence (a rediscovery costs about 5 ms on the real tree). Optional on the model, never fatal.
    if (this._running && !this._disposed && this.model && typeof this.model.invalidate === 'function') {
      try { this.model.invalidate(); } catch (e) { /* the watch is only a hint */ }
    }
    this.requestTick();
  }

  _closeQuiet(w) {
    try { if (w && typeof w.close === 'function') w.close(); } catch (e) { /* already closed */ }
  }

  _say(msg) {
    try { this._log(msg); } catch (e) { /* logging must never break polling */ }
  }
}

module.exports = {
  Poller, DEBOUNCE_MS, MIN_TICK_GAP_MS, IDLE_POLL_MS, HEARTBEAT_MS, WATCH_SYNC_MS, WATCH_RETRY_MS,
};
