'use strict';
// Refreshes Claude Code's own usage cache (the numbers lib/usage.js reads) by running its local command "/usage" headless:
//   claude -p /usage --no-session-persistence --setting-sources project
// Checked on this machine: the command is answered locally (no model call), takes a few seconds, and rewrites
// cachedUsageUtilization in ~/.claude.json. "--no-session-persistence" keeps it out of the session history, and
// "--setting-sources project" leaves the person's user hooks (for example a sound on Stop) out of it.
// The only place of the extension that starts a process: execFile (no shell), fixed arguments, no input from files or the view.
const os = require('os');
const { execFile } = require('child_process');

const ARGS = Object.freeze(['-p', '/usage', '--no-session-persistence', '--setting-sources', 'project']);
const TIMEOUT_MS = 45000;      // the call took 3.7-18 s here; beyond this the process is stopped
const MIN_GAP_MS = 10000;      // never start two runs within this gap, however often the button is pressed

class UsageRefresher {
  /**
   * @param {{ binary: string, cwd?: string, configDir?: string, log?: (m: string) => void, execFile?: Function, now?: () => number }} opts
   * binary: the claude executable; cwd: a stable folder (the run leaves an empty project folder named after it); configDir: CLAUDE_CONFIG_DIR to use
   */
  constructor(opts) {
    const o = opts || {};
    this.binary = o.binary;
    this.cwd = o.cwd || os.tmpdir();
    this.configDir = o.configDir || '';
    this.log = typeof o.log === 'function' ? o.log : () => {};
    this._exec = o.execFile || execFile;
    this._now = o.now || Date.now;
    this._inflight = null;
    this._lastStart = -Infinity;
  }

  /** Resolves { ok, ms } | { ok:false, skipped:'running'|'gap'|'no-binary' } | { ok:false, error }; never rejects, never throws. */
  refresh() {
    if (this._inflight) return this._inflight;
    if (typeof this.binary !== 'string' || !this.binary) return Promise.resolve({ ok: false, skipped: 'no-binary' });
    const t0 = this._now();
    if (t0 >= this._lastStart && t0 - this._lastStart < MIN_GAP_MS) return Promise.resolve({ ok: false, skipped: 'gap' });
    this._lastStart = t0;
    const env = Object.assign({}, process.env);
    delete env.ELECTRON_RUN_AS_NODE;                       // the editor's host sets it; a normal executable must not inherit it
    if (this.configDir) env.CLAUDE_CONFIG_DIR = this.configDir;
    this._inflight = new Promise((resolve) => {
      let child;
      const done = (res) => { this._inflight = null; resolve(res); };
      try {
        child = this._exec(this.binary, ARGS.slice(), { cwd: this.cwd, env, windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (err) => {
          const ms = this._now() - t0;
          if (err) done({ ok: false, ms, error: String((err && (err.code || err.signal || err.message)) || 'error').slice(0, 80) });
          else done({ ok: true, ms });
        });
        if (child && child.stdin && typeof child.stdin.end === 'function') child.stdin.end();   // nothing to read: never wait for input
      } catch (e) {
        done({ ok: false, ms: 0, error: String((e && (e.code || e.message)) || 'error').slice(0, 80) });
      }
    });
    return this._inflight;
  }
}

module.exports = { UsageRefresher, ARGS, TIMEOUT_MS, MIN_GAP_MS };
