'use strict';
// Usage windows (5-hour and weekly limit) for the view header. Model-specific weekly limits are deliberately not shown.
// Source: the cache Claude Code keeps itself in its global config file (~/.claude.json, key "cachedUsageUtilization").
// Nothing is fetched from the network and no credential is read: the file is parsed in memory, ONLY that one key is taken,
// everything else is dropped at once and never logged. Read-only. The cache is only as fresh as Claude Code's last query, so
// `fetchedAt` travels with the numbers and the webview shows the age.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_FILE_BYTES = 8 * 1024 * 1024;   // the real file is ~70 KB; anything this large is not read
const MIN_PARSE_GAP_MS = 3000;            // the file is rewritten often (every session touches it): parse at most every 3 s
const MAX_LIMITS = 20;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fin = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fold = s => (process.platform === 'win32' ? s.toLowerCase() : s);
const SEVERITIES = new Set(['normal', 'warning', 'critical']);

/**
 * The global config file Claude Code uses for this config directory: <dir>/.claude.json when a custom directory (CLAUDE_CONFIG_DIR)
 * is in use, else ~/.claude.json next to the default ~/.claude. A custom directory never falls back to the real home file, so a
 * synthetic or foreign claudeHome cannot pick up someone else's numbers.
 */
function claudeJsonCandidates(claudeHome) {
  const home = os.homedir();
  const cfg = typeof claudeHome === 'string' && claudeHome ? path.resolve(claudeHome) : '';
  if (cfg && fold(cfg) !== fold(path.resolve(path.join(home, '.claude')))) return [path.join(cfg, '.claude.json')];
  return [path.join(home, '.claude.json')];
}

/** Pure: the parsed global config -> { fetchedAt, windows:[{id,label,percent,resetsAt,severity}] } or null. */
function parseUsage(root) {
  const c = isObj(root) ? root.cachedUsageUtilization : null;
  if (!isObj(c)) return null;
  const fetchedAt = fin(c.fetchedAtMs);
  const u = isObj(c.utilization) ? c.utilization : null;
  if (fetchedAt === null || !u) return null;

  const windows = [];
  const seen = new Set();
  const add = (id, label, percent, resetsIso, severity) => {
    const p = fin(percent);
    if (p === null || seen.has(id)) return;
    seen.add(id);
    const t = typeof resetsIso === 'string' ? Date.parse(resetsIso) : NaN;
    windows.push({
      id, label, percent: Math.min(100, Math.max(0, Math.round(p))),
      resetsAt: Number.isFinite(t) ? Math.round(t / 60000) * 60000 : null,   // the API reports ...:59.657; people read the next minute
      severity: SEVERITIES.has(severity) ? severity : null,
    });
  };

  if (Array.isArray(u.limits)) {
    for (const l of u.limits.slice(0, MAX_LIMITS)) {
      if (!isObj(l)) continue;
      if (l.kind === 'session') add('five_hour', '5-Stunden-Limit', l.percent, l.resets_at, l.severity);
      else if (l.kind === 'weekly_all') add('weekly', 'Wochenlimit', l.percent, l.resets_at, l.severity);
    }
  }
  if (!seen.has('five_hour') && isObj(u.five_hour)) add('five_hour', '5-Stunden-Limit', u.five_hour.utilization, u.five_hour.resets_at, null);
  if (!seen.has('weekly') && isObj(u.seven_day)) add('weekly', 'Wochenlimit', u.seven_day.utilization, u.seven_day.resets_at, null);
  if (!windows.length) return null;

  windows.sort((a, b) => (a.id === 'five_hour' ? 0 : 1) - (b.id === 'five_hour' ? 0 : 1));
  return { fetchedAt, windows };
}

class UsageReader {
  constructor() { this._cache = new Map(); }

  /** Returns the parsed usage or null; never throws. Re-parses only when the file changed and at most every MIN_PARSE_GAP_MS. */
  read(claudeHome, now) {
    for (const f of claudeJsonCandidates(claudeHome)) {
      const u = this._readFile(f, now);
      if (u) return u;
    }
    return null;
  }

  _readFile(file, now) {
    let st;
    try { st = fs.statSync(file); } catch (_) { this._cache.delete(file); return null; }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const sig = st.size + ':' + st.mtimeMs;
    const hit = this._cache.get(file);
    if (hit && (hit.sig === sig || (now >= hit.at && now - hit.at < MIN_PARSE_GAP_MS))) return hit.usage;
    let usage = null;
    try { usage = parseUsage(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (_) { usage = null; }
    this._cache.set(file, { sig, at: now, usage });
    return usage;
  }
}

module.exports = { UsageReader, parseUsage, claudeJsonCandidates, MIN_PARSE_GAP_MS };
