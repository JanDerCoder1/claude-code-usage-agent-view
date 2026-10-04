'use strict';
// Where Claude Code keeps its files: <claudeHome>/projects/<enc(cwd)>/<sid>.jsonl + <sid>/..., <claudeHome>/sessions/<pid>.json.
// Strictly read-only. Only <pid>.json registry files, project listings and agent files are opened; the main transcript
// <sid>.jsonl is stat'ed only, and secret-bearing files (token, IDE lock and login files) are never touched.
const fs = require('fs');
const os = require('os');
const path = require('path');

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REGISTRY_FILE = /^\d+\.json$/;            // nothing else in sessions/ is opened (the folder also holds secrets)
const REGISTRY_MAX_BYTES = 64 * 1024;
const PATH_MAX = 4096;                          // longer than any real path; registry cwd values beyond this are garbage
const FIELD_MAX = 200;                          // registry text fields (name, entrypoint, status) are shown or compared, never long
const isWin = () => process.platform === 'win32';
const fold = s => (isWin() ? String(s).toLowerCase() : String(s));

/**
 * A setting value that may name the Claude directory: an absolute path on a local drive or root. Relative paths (they would
 * resolve against the editor's working directory), UNC names (opening one makes Windows talk to a remote host and send the
 * user's logon hash to it: `\\host\share`, `//host/share`, `\\?\UNC\...`, `\\.\...`) and NUL bytes are refused. Returns the trimmed path or null.
 */
function localAbsolutePath(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > PATH_MAX || s.indexOf('\0') !== -1) return null;
  if (isWin() && /^[\\/]{2}/.test(s)) return null;
  return path.isAbsolute(s) ? s : null;
}

/**
 * CLAUDE_CONFIG_DIR from the Claude Code extension's own setting `claudeCode.environmentVariables` (array of {name, value} or a
 * plain name -> value object). Same rules as that extension: the name is case-insensitive on win32, only absolute values count
 * and the last valid entry wins. Our extra rule: no UNC names (see localAbsolutePath).
 */
function configDirFromEnvSetting(list) {
  let entries = [];
  if (Array.isArray(list)) entries = list.filter(e => e && typeof e === 'object' && typeof e.name === 'string').map(e => [e.name, e.value]);
  else if (list && typeof list === 'object') entries = Object.entries(list);
  let found = null;
  for (const [name, value] of entries) {
    if ((isWin() ? name.toUpperCase() : name) !== 'CLAUDE_CONFIG_DIR') continue;
    const p = localAbsolutePath(value);
    if (p) found = p;
  }
  return found;
}

/** override (setting agentView.claudeHome, local absolute paths only) || env CLAUDE_CONFIG_DIR || ~/.claude (same expression as the Claude Code extension). */
function claudeHome(override) {
  const o = localAbsolutePath(override);
  if (o) return o;
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (typeof env === 'string' && env.trim()) return env.trim();
  return path.join(os.homedir(), '.claude');
}

/**
 * Project folder name of a cwd. Source-derived from the Claude Code extension (extension.js: replace(/[^a-zA-Z0-9]/g,'-'),
 * names longer than 200 get `slice(0,200)-abs(h).toString(36)` with the Java-31 hash h over the ORIGINAL cwd).
 */
function encodeCwd(cwd) {
  const s = String(cwd == null ? '' : cwd);
  const enc = s.replace(/[^a-zA-Z0-9]/g, '-');
  if (enc.length <= 200) return enc;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return enc.slice(0, 200) + '-' + Math.abs(h).toString(36);
}

// ---------------------------------------------------------------- tolerant fs helpers (every one swallows ENOENT & co)
const statMs = p => { try { return fs.statSync(p).mtimeMs; } catch (_) { return 0; } };
function dirents(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch (_) { return []; } }
function entKind(parent, e) {                    // 'dir' | 'file' | null; follows symlinks/junctions
  if (e.isDirectory()) return 'dir';
  if (e.isFile()) return 'file';
  if (e.isSymbolicLink()) {
    try { const st = fs.statSync(path.join(parent, e.name)); return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null; } catch (_) { return null; }
  }
  return null;
}
const dirNames = p => dirents(p).filter(e => entKind(p, e) === 'dir').map(e => e.name);
const fileNames = p => dirents(p).filter(e => entKind(p, e) === 'file').map(e => e.name);

/** Project dirs whose name equals enc(cwd) (case-insensitive on win32: VS Code writes `c--...`, Claude Desktop `C--...`). */
function findProjectDirs(projectsDir, cwd) {
  if (typeof projectsDir !== 'string' || !projectsDir) return [];
  const want = fold(encodeCwd(cwd));
  return dirNames(projectsDir).filter(n => fold(n) === want).map(n => path.join(projectsDir, n));
}

// ---------------------------------------------------------------- liveness registry
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }     // EPERM: exists, not ours
}

/** SPEC 3.7: registryAvailable = the sessions dir exists (without it liveness cannot be judged and the stale heuristic applies). */
function registryAvailable(home) {
  try { return fs.statSync(path.join(String(home || ''), 'sessions')).isDirectory(); } catch (_) { return false; }
}

/**
 * <home>/sessions/<pid>.json (only `^\d+\.json$`). `version` is an addition to the contract (used for the format note).
 * @returns {{pid:number, sessionId:string, cwd:string, entrypoint:string|null, status:string|null, name:string|null, updatedAt:number|null, version:string|null, alive:boolean}[]}
 */
function readRegistry(home) {
  const dir = path.join(String(home || ''), 'sessions');
  const out = [];
  for (const e of dirents(dir)) {
    if (!REGISTRY_FILE.test(e.name)) continue;
    const f = path.join(dir, e.name);
    let o;
    try {
      if (fs.statSync(f).size > REGISTRY_MAX_BYTES) continue;
      o = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (_) { continue; }
    if (!o || typeof o !== 'object' || typeof o.sessionId !== 'string' || !o.sessionId) continue;
    const pid = Number.isInteger(o.pid) ? o.pid : parseInt(e.name, 10);
    const str = v => (typeof v === 'string' && v ? v.slice(0, FIELD_MAX) : null);
    out.push({
      pid, sessionId: o.sessionId.slice(0, 64), cwd: typeof o.cwd === 'string' && o.cwd.length <= PATH_MAX ? o.cwd : '',
      entrypoint: str(o.entrypoint), status: str(o.status), name: str(o.name),
      updatedAt: Number.isFinite(o.updatedAt) ? o.updatedAt : null, version: str(o.version), alive: isAlive(pid),
    });
  }
  return out;
}

/** True when cwd equals folder or lies inside it (lower-case on win32, `\` = `/`, trailing separator ignored). */
function cwdInside(cwd, folder) {
  // trailing separators are cut with a loop: the regex /\/+$/ is quadratic on a long run of separators that does not end the string
  const n = s => {
    let x = String(s == null ? '' : s);
    if (isWin()) x = x.replace(/\\/g, '/').toLowerCase();
    let end = x.length;
    while (end > 0 && x.charCodeAt(end - 1) === 47) end--;
    return end === x.length ? x : x.slice(0, end);
  };
  const c = n(cwd), f = n(folder);
  if (!c || !f) return false;
  return c === f || c.startsWith(f + '/');
}

// ---------------------------------------------------------------- sessions
/**
 * Every session id found below <projectsDir>/*, joined across project folders (SPEC 3.5: one sessionId can have dirs in
 * several folders). A project dir's listing is cached by its mtime (a new session creates an entry there; appends never matter).
 */
class SessionIndex {
  constructor() { this._dirs = new Map(); }
  /** @returns {Map<string, {sid:string, entries:{projDir:string, sessionDir:string|null, transcript:string|null}[]}>} key = lower-case sid */
  scan(projectsDir, now) {
    const byId = new Map();
    const seen = new Set();
    for (const name of dirNames(projectsDir)) {
      const projDir = path.join(projectsDir, name);
      seen.add(projDir);
      const mt = statMs(projDir);
      let c = this._dirs.get(projDir);
      // trust the cache only when the listing was taken clearly after the last change (same-tick creations stay visible)
      if (!c || c.mtimeMs !== mt || c.at - mt < 2000) {
        const refs = new Map();
        for (const e of dirents(projDir)) {
          const m = /^([0-9a-f-]{36})(\.jsonl)?$/i.exec(e.name);
          if (!m || !GUID.test(m[1])) continue;
          const k = m[1].toLowerCase();
          const r = refs.get(k) || { sid: m[1], projDir, sessionDir: null, transcript: null };
          const kind = entKind(projDir, e);
          if (m[2]) { if (kind === 'file') r.transcript = path.join(projDir, e.name); } else if (kind === 'dir') r.sessionDir = path.join(projDir, e.name);
          refs.set(k, r);
        }
        c = { mtimeMs: mt, at: now, list: [...refs.values()] };
        this._dirs.set(projDir, c);
      }
      for (const r of c.list) {
        const k = r.sid.toLowerCase();
        let s = byId.get(k);
        if (!s) { s = { sid: r.sid, entries: [] }; byId.set(k, s); }
        s.entries.push(r);
      }
    }
    for (const k of [...this._dirs.keys()]) if (!seen.has(k)) this._dirs.delete(k);
    return byId;
  }
}

/** Newest mtime among the cheap indicators (transcripts, session dirs, their subagents/workflows dirs): a gate before the deep scan. */
function cheapActivity(entries) {
  let t = 0;
  for (const e of entries) {
    if (e.transcript) t = Math.max(t, statMs(e.transcript));
    if (e.sessionDir) {
      const d = e.sessionDir;
      t = Math.max(t, statMs(d), statMs(path.join(d, 'subagents')), statMs(path.join(d, 'subagents', 'workflows')), statMs(path.join(d, 'workflows')));
    }
  }
  return t;
}

/**
 * SPEC 3.3: max(mtime(<sid>.jsonl), newest subagents/agent-*.jsonl, newest file of every run dir WITHOUT a result file).
 * Finished runs no longer change and are skipped; directory mtimes are not used here (appends do not bump them).
 */
function sessionActivity(entries) {
  let newest = 0;
  const bump = t => { if (t > newest) newest = t; };
  const dirs = [];
  for (const e of entries) { if (e.transcript) bump(statMs(e.transcript)); if (e.sessionDir) dirs.push(e.sessionDir); }
  const finished = new Set();
  for (const d of dirs) for (const n of fileNames(path.join(d, 'workflows'))) { const m = /^(wf_.+)\.json$/.exec(n); if (m) finished.add(m[1]); }
  for (const d of dirs) {
    const sub = path.join(d, 'subagents');
    for (const n of fileNames(sub)) if (/^agent-.*\.jsonl$/.test(n)) bump(statMs(path.join(sub, n)));
    const wfRoot = path.join(sub, 'workflows');
    for (const run of dirNames(wfRoot)) {
      if (finished.has(run)) continue;
      for (const f of fileNames(path.join(wfRoot, run))) bump(statMs(path.join(wfRoot, run, f)));
    }
  }
  return newest;
}

module.exports = {
  claudeHome, localAbsolutePath, configDirFromEnvSetting, encodeCwd, findProjectDirs, readRegistry,
  // additions used by lib/sessionModel.js
  isAlive, registryAvailable, cwdInside, SessionIndex, cheapActivity, sessionActivity, statMs, dirents, dirNames, fileNames, entKind, GUID,
};
