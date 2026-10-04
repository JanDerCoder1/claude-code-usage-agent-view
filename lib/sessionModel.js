'use strict';
// Session discovery + run/agent model + ViewState builder (SPEC 2, 3, 5, 6.1, 9).
// Finished runs come from workflows/wf_<run>.json only (5.1); live runs from the journal + one AgentTracker per slot (5.2);
// plain Agent-tool subagents from subagents/agent-<id>.jsonl (5.4). Read-only; refresh() is synchronous and budgeted.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CH = require('./claudeHome');
const { parseJournal, SAFE_ID } = require('./journal');
const S = require('./strings');

const MB = 1024 * 1024;
const TICK_BYTES = 8 * MB, TICK_FILES = 40;               // SPEC 9 budgets per refresh
const DISCOVERY_MS = 5000, ACTIVE_MS = 10 * 60e3, RUNNING_MS = 60e3;
const LIVE_QUIET_MAX_MS = 60 * 60e3;                      // a "live" session never keeps a run running that was silent this long (orphan guard)
const OLD_RUN_GRACE_MS = 30 * 60e3, EVICT_MS = 10 * 60e3, ETA_EVERY_MS = 20e3, ACTIVITY_MS = 30e3;
const RESUME_SLACK_MS = 10e3;                             // journal newer than the result file by more than this = the run was resumed
const STALE = Symbol('stale result file');
const MAX_RUNNING = 50, MAX_RECENT = 20, MAX_AGENTS_PHASE = 40, MAX_PHASES = 200, STATE_CAP = 150e3, MAX_WARNINGS = 5;
// Whole-file reads (journal, result file, small JSON files) are refused above these sizes; real files are 0.01-1 MB.
const MAX_JOURNAL_BYTES = 32 * MB, MAX_RESULT_BYTES = 32 * MB, MAX_SMALL_BYTES = 256 * 1024;
// Text read from files is untrusted and bounded where it enters the model, so the ViewState stays small whatever a file holds.
const LABEL_MAX = 200, PHASE_MAX = 100, DETAIL_MAX = 600, DESC_MAX = 2000, ID_MAX = 64, MODEL_MAX = 80, TYPE_MAX = 80;
const NOPHASE = S.noPhase;
const OPTION_KEYS = ['claudeHome', 'scope', 'workspaceFolders', 'recentHours', 'staleMinutes', 'showToolTargets', 'etaEnabled', 'usageEnabled', 'history'];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fkey = f => (process.platform === 'win32' ? f.toLowerCase() : f);
const errMsg = e => String((e && e.message) || e).slice(0, 160);
const cap = (s, n) => (typeof s === 'string' && s ? s.slice(0, n) : null);
const cap160 = s => { const t = typeof s === 'string' ? s.slice(0, 4000).replace(/\s+/g, ' ').trim() : ''; return t ? t.slice(0, 160) : null; };
// Only strings and finite numbers become text: String(object) runs the toString of a parsed file and may throw.
const txt = v => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
// No leading \s* in the pattern: it makes the search quadratic on a long run of whitespace.
const RETRY_TAIL = /\(retry (\d+)\)\s*$/i;
const stripRetry = l => { const t = txt(l), m = RETRY_TAIL.exec(t); return m ? t.slice(0, m.index).trimEnd() : t; };
const fin = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const readJson = (f, max) => { try { if (fs.statSync(f).size > (max || MAX_SMALL_BYTES)) return null; return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const agentFile = (runDir, id) => (SAFE_ID.test(id) ? path.join(runDir, 'agent-' + id + '.jsonl') : null);
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
const fold = s => String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
const verOf = v => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); return m ? [+m[1], +m[2], +m[3]] : null; };
const verCmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const originOf = e => (/vscode/i.test(e || '') ? S.originVsCode : /desktop/i.test(e || '') ? S.originDesktop : null);
const live = a => a.state === 'running' || a.state === 'waiting';
// last sign of life of an agent file; while its read is incomplete the last PARSED line is older than the file, so use the mtime
const lastOf = (sn, now) => (sn.loading ? sn.mtimeMs || sn.lastTs : sn.lastTs || sn.mtimeMs) || now;

const EMPTY_SNAP = Object.freeze({ missing: true, loading: false, badLines: 0, size: 0, mtimeMs: 0, id: null, model: { id: null, label: null }, tokens: 0, toolUses: 0, firstTs: null, lastTs: null, end: 'running', activity: null, failure: null, resultPreview: null });

function agentView(o) {
  return Object.assign({ id: '', label: '', phase: null, kind: 'wf', agentType: null, shape: null, model: { id: null, label: null }, state: 'running', quietSec: 0, tokens: 0, toolUses: 0, startedAt: null, endedAt: null, durationMs: null, attempt: 1, cached: false, loading: false, activity: null, failure: null, resultPreview: null, eta: null }, o);
}

// ---------------------------------------------------------------- phases (SPEC 5.3)
function phaseState(ag) {
  if (!ag.length) return 'pending';
  if (ag.some(live)) return 'running';
  return ag.every(a => a.state === 'done') ? 'done' : 'partial';
}
/** The `max` most relevant entries of a list (lowest rank first, then list order), kept in their original order. */
function capKeep(list, max, rank) {
  if (list.length <= max) return list;
  const keep = new Set(list.map((a, i) => [a, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).slice(0, max).map(x => x[0]));
  return list.filter(a => keep.has(a));
}
const capAgents = list => capKeep(list, MAX_AGENTS_PHASE, a => (live(a) ? 0 : a.state === 'failed' ? 1 : a.state === 'done' ? 3 : 2));
const PHASE_RANK = { running: 0, partial: 1, pending: 2, done: 3 };
/**
 * declared = [{title, detail}] from the result file / script meta; journal-only titles are appended. Counters are over ALL agents,
 * the lists are capped (agents per phase, phases per card). One pass groups the agents: a run with thousands of phases stays linear.
 */
function buildPhases(declared, agents, extraTitles) {
  const titles = [], detail = new Map();
  const add = (t, d) => { const k = cap(t, PHASE_MAX); if (k && !detail.has(k)) { titles.push(k); detail.set(k, typeof d === 'string' ? d.slice(0, DETAIL_MAX) : null); } };
  for (const p of declared || []) if (isObj(p)) add(p.title, p.detail);
  for (const t of extraTitles || []) add(t, null);
  const byTitle = new Map();
  let noPhase = false;
  for (const a of agents) {
    const p = cap(a.phase, PHASE_MAX), k = p || NOPHASE;
    if (p) add(p, null); else noPhase = true;
    const g = byTitle.get(k);
    if (g) g.push(a); else byTitle.set(k, [a]);
  }
  if (noPhase) add(NOPHASE, null);
  const out = titles.map(title => {
    const ag = (byTitle.get(title) || []).sort((a, b) => (a.startedAt === null) - (b.startedAt === null) || (a.startedAt || 0) - (b.startedAt || 0));
    return { title, detail: detail.get(title), state: phaseState(ag), done: ag.filter(a => a.state === 'done').length, failed: ag.filter(a => a.state === 'failed').length, total: ag.length, agents: capAgents(ag) };
  });
  return capKeep(out, MAX_PHASES, p => PHASE_RANK[p.state]);
}

// ---------------------------------------------------------------- finished runs (SPEC 5.1)
function agentFromResult(w, i, endedAt, defaultModel, pretty) {
  const state = w.state === 'done' ? 'done' : w.state === 'error' ? 'failed' : 'interrupted';   // 'progress' = still running when the run was killed
  const cached = w.cached === true;
  const started = cached ? null : fin(w.startedAt);
  let ended = null, dur = null;
  if (!cached) {
    if (state === 'interrupted') { ended = endedAt; dur = started !== null && ended !== null && ended >= started ? ended - started : null; }
    else { dur = fin(w.durationMs); ended = started !== null && dur !== null ? started + dur : fin(w.lastProgressAt); }
  }
  const m = RETRY_TAIL.exec(txt(w.label));
  const mid = cap(w.model, MODEL_MAX) || cap(defaultModel, MODEL_MAX);
  const status = typeof w.error === 'string' ? /\b([45]\d\d)\b/.exec(w.error.slice(0, 1000)) : null;
  return agentView({
    id: (w.agentId && cap(txt(w.agentId), ID_MAX)) || 'agent-' + (fin(w.index) || i + 1), label: cap(stripRetry(w.label), LABEL_MAX) || 'Agent ' + (i + 1), phase: cap(w.phaseTitle, PHASE_MAX), kind: 'wf',
    agentType: cap(w.agentType, TYPE_MAX), model: { id: mid, label: pretty(mid) }, state,
    tokens: cached ? 0 : fin(w.tokens) || 0, toolUses: cached ? 0 : fin(w.toolCalls) || 0, startedAt: started, endedAt: ended, durationMs: dur,
    attempt: fin(w.attempt) || (m ? +m[1] + 1 : 1), cached,
    failure: state === 'failed' ? { status: status ? +status[1] : null, error: null, text: cap160(w.error) || '' } : null,
    resultPreview: cap160(w.resultPreview),
  });
}
/** Card of a parsed result file; null when `res` is not an object. Values are read by type (strings, finite numbers), never coerced. */
function cardFromResult(res, runId, fallbackEnd, pretty) {
  if (!isObj(res)) return null;
  const wp = Array.isArray(res.workflowProgress) ? res.workflowProgress : [];
  const t = typeof res.timestamp === 'string' ? Date.parse(res.timestamp) : NaN;
  const endedAt = Number.isFinite(t) ? t : fallbackEnd;
  const agents = wp.filter(w => isObj(w) && w.type === 'workflow_agent').map((w, i) => agentFromResult(w, i, endedAt, res.defaultModel, pretty));
  let declared = Array.isArray(res.phases) ? res.phases : [];
  if (!declared.length) declared = wp.filter(w => isObj(w) && w.type === 'workflow_phase').map(w => ({ title: w.title, detail: null }));
  const sum = k => agents.reduce((s, a) => s + a[k], 0);
  return {
    kind: 'workflow', runId, name: cap(res.workflowName, 200) || runId, description: cap(res.summary, DESC_MAX), status: txt(res.status).slice(0, 40) || 'completed',
    startedAt: fin(res.startTime), endedAt, durationMs: fin(res.durationMs),
    agentsTotal: agents.length, agentsDone: agents.filter(a => a.state === 'done').length, agentsFailed: agents.filter(a => a.state === 'failed').length,
    tokens: fin(res.totalTokens) !== null ? res.totalTokens : sum('tokens'), toolUses: fin(res.totalToolCalls) !== null ? res.totalToolCalls : sum('toolUses'),
    phases: buildPhases(declared, agents), eta: null,
  };
}

// ---------------------------------------------------------------- the model
class SessionModel {
  /** @param {{claudeHome:string, scope:'workspace'|'all', workspaceFolders:string[], recentHours:number, staleMinutes:number, showToolTargets:boolean, etaEnabled:boolean, history:object|null, deps?:object}} opts */
  constructor(opts) {
    const o = opts || {};
    this.o = { claudeHome: '', scope: 'workspace', workspaceFolders: [], recentHours: 24, staleMinutes: 10, showToolTargets: true, etaEnabled: true, usageEnabled: true, history: null };
    for (const k of OPTION_KEYS) if (o[k] !== undefined) this.o[k] = o[k];
    const d = o.deps || {};
    this.d = {   // injectable for unit tests; the real modules are required lazily
      AgentTracker: d.AgentTracker || require('./agentFold').AgentTracker,
      extractMetaSafe: d.extractMetaSafe || require('./workflowMeta').extractMetaSafe,
      eta: d.eta || require('./eta'),
      prettyModel: d.prettyModel || require('./format').prettyModel,
      UsageReader: d.UsageReader || require('./usage').UsageReader,
    };
    this._usage = new this.d.UsageReader();
    this._index = new CH.SessionIndex();
    this._clear();
  }

  _clear() {
    for (const t of (this._trackers || new Map()).values()) { try { t.tr.dispose(); } catch (_) { /* ignore */ } }
    this._trackers = new Map(); this._journals = new Map(); this._results = new Map(); this._metas = new Map(); this._plain = new Map(); this._etaCache = new Map();
    this._sess = new Map(); this._ordered = [];
    this._gen = (this._gen || 0) + 1; this._needDisc = true; this._lastDisc = -Infinity; this._lastEvict = 0;
    this._reg = []; this._regAvail = false; this._projectsMissing = false; this._effScope = 'all'; this._watch = []; this._formatNote = null;
    this._seenInside = new Set();   // sessions known to have run inside a workspace folder (their registry entry vanishes when the process exits)
    this._lastHash = null; this._lastChangeAt = -Infinity; this._runningN = 0; this._hashed = null;
  }

  setOptions(p) {
    if (!isObj(p)) return;
    const o = this.o, before = Object.assign({}, o);
    for (const k of OPTION_KEYS) if (p[k] !== undefined) o[k] = p[k];
    if (o.claudeHome !== before.claudeHome) { this._clear(); return; }
    if (JSON.stringify(o.workspaceFolders) !== JSON.stringify(before.workspaceFolders)) this._seenInside.clear();
    if (o.showToolTargets !== before.showToolTargets) {
      for (const t of this._trackers.values()) { try { t.tr.dispose(); } catch (_) { /* ignore */ } }
      this._trackers = new Map();
    }
    if (o.recentHours !== before.recentHours) for (const [k, c] of this._results) if (c.skipped) this._results.delete(k);
    if (o.etaEnabled !== before.etaEnabled) this._etaCache.clear();
    this._gen++; this._needDisc = true;
  }

  dispose() { this._clear(); }
  /** Forces a rediscovery on the next refresh() (the poller calls it on fs.watch events, so a new agent card shows up within ~2 s instead of at the 5 s discovery cadence). */
  invalidate() { this._needDisc = true; }
  hasActivity(now) { return this._runningN > 0 || now - this._lastChangeAt < ACTIVITY_MS; }
  watchRoots() { return this._watch.slice(); }

  /** Hash of the ViewState without `now` and with `quietSec` bucketed, so an idle state does not look "changed" every tick. */
  stateHash(vs) {
    if (this._hashed && this._hashed.vs === vs) return this._hashed.h;
    const json = JSON.stringify(vs, function (k, v) {
      if (k === 'now' && this === vs) return undefined;
      if (k === 'quietSec' && typeof v === 'number') return Math.floor(v / 30);
      return v;
    });
    const h = crypto.createHash('sha1').update(json).digest('hex');
    this._hashed = { vs, h };
    return h;
  }

  // ---------------------------------------------------------------- refresh
  /** `limits` ({maxRunning, maxRecent, noSizeCap}) is for tests and tools that need every card; the extension calls refresh(now). */
  refresh(now, limits) {
    this._budget = { bytes: TICK_BYTES }; this._reads = 0;
    const warnings = [];
    const home = CH.claudeHome(this.o.claudeHome);
    if (this._needDisc || now - this._lastDisc >= DISCOVERY_MS || now < this._lastDisc) {
      try { this._discover(now, home); } catch (e) { warnings.push(S.warnDiscovery(errMsg(e))); }
    }
    if (this._projectsMissing) warnings.push(S.projectsMissing(path.join(home, 'projects')));
    const hist = this.o.history && typeof this.o.history.snapshot === 'function' ? this.o.history.snapshot() : null;
    const cards = [];
    for (const ss of this._ordered) {
      try { cards.push(...this._sessionCards(ss, now, hist, warnings)); } catch (e) { warnings.push(S.warnSession(ss.sid, errMsg(e))); }
    }
    if (now - this._lastEvict >= 30e3) this._evict(now);
    let usage = null;
    if (this.o.usageEnabled !== false) { try { usage = this._usage.read(home, now); } catch (_) { usage = null; } }
    const vs = this._assemble(cards, now, warnings, home, limits || {}, usage);
    const h = this.stateHash(vs);
    if (h !== this._lastHash) { this._lastHash = h; this._lastChangeAt = now; }
    this._runningN = vs.running.length;
    return vs;
  }

  // ---------------------------------------------------------------- discovery (SPEC 3.1-3.7)
  _discover(now, home) {
    this._needDisc = false; this._lastDisc = now;
    const projectsDir = path.join(home, 'projects');
    this._reg = CH.readRegistry(home); this._regAvail = CH.registryAvailable(home);
    this._projectsMissing = !isDir(projectsDir);
    const liveBy = new Map(), regBy = new Map();
    for (const r of this._reg) {
      const k = r.sessionId.toLowerCase();
      if (r.alive) liveBy.set(k, r);
      if (!regBy.has(k) || r.alive) regBy.set(k, r);
    }
    const folders = (Array.isArray(this.o.workspaceFolders) ? this.o.workspaceFolders : []).filter(f => typeof f === 'string' && f);
    const ws = this.o.scope !== 'all' && folders.length > 0;
    this._effScope = ws ? 'workspace' : 'all';
    const matched = new Set();
    if (ws) for (const f of folders) for (const d of CH.findProjectDirs(projectsDir, f)) matched.add(d);
    const byId = this._index.scan(projectsDir, now);
    const cutoff = now - Math.max(1, +this.o.recentHours || 24) * 3600e3;
    const roots = new Set(ws ? matched : []);
    const next = new Map();
    for (const [k, ref] of byId) {
      const reg = regBy.get(k) || null, lv = liveBy.get(k) || null;
      // A session started in a sub-folder of the workspace folder lives in another project directory (named after ITS cwd),
      // so only the registry tells that it belongs here. An entry of an exited process still has the cwd, and a session seen
      // inside once stays ours after its entry is gone: its finished cards must not vanish when the process ends.
      if (ws && reg && folders.some(f => CH.cwdInside(reg.cwd, f))) {
        if (!this._seenInside.has(k) && this._seenInside.size >= 500) this._seenInside.delete(this._seenInside.values().next().value);
        this._seenInside.add(k);
      }
      const viaReg = ws && this._seenInside.has(k);
      if (ws && !viaReg && !ref.entries.some(e => matched.has(e.projDir))) continue;
      const act = lv || CH.cheapActivity(ref.entries) >= cutoff ? CH.sessionActivity(ref.entries) : 0;
      if (!lv && act < cutoff) continue;
      if (viaReg) for (const e of ref.entries) roots.add(e.projDir);
      let ss = this._sess.get(k);
      if (!ss) { ss = { key: k, sid: ref.sid, built: null, originTries: 0, origin: null }; }
      Object.assign(ss, { entries: ref.entries, live: !!lv, reg, lastActivity: act, active: !!lv || now - act < ACTIVE_MS });
      ss.customTitle = null;
      for (const e of ref.entries) {
        const t = e.sessionDir && readJson(path.join(e.sessionDir, 'custom-title.json'));
        if (t && typeof t.customTitle === 'string' && t.customTitle.trim()) { ss.customTitle = t.customTitle.trim().slice(0, 200); break; }
      }
      next.set(k, ss);
    }
    this._sess = next;
    this._ordered = [...next.values()].sort((a, b) => (b.live - a.live) || (b.active - a.active) || (b.lastActivity - a.lastActivity));
    this._watch = ws ? [...roots].filter(isDir) : (isDir(projectsDir) ? [projectsDir] : []);
    // format note: only for Claude Code versions of the sessions shown that are older than the tested range or from a newer minor series
    // (Claude Code ships patch releases almost daily and the real-tree tests guard the format; a new minor or major series is what may change it)
    const from = verOf(S.testedFrom), to = verOf(S.testedTo);
    const tooNew = v => v[0] > to[0] || (v[0] === to[0] && v[1] > to[1]);
    const bad = this._ordered.filter(s => s.live && s.reg && verOf(s.reg.version) && (verCmp(verOf(s.reg.version), from) < 0 || tooNew(verOf(s.reg.version)))).map(s => s.reg.version).sort((a, b) => verCmp(verOf(b), verOf(a)));
    this._formatNote = bad.length ? S.formatNote(bad[0]) : null;
  }

  _title(ss) { return ss.customTitle || (ss.reg && ss.reg.name) || S.sessionFallback(ss.sid); }
  _origin(ss) {
    if (ss.reg && ss.reg.entrypoint) return originOf(ss.reg.entrypoint);
    if (ss.origin === null && ss.originTries < 3 && ss.originFile) {       // not in the registry: entrypoint of the first agent line
      ss.originTries++;
      try {
        const fd = fs.openSync(ss.originFile, 'r');
        try {
          const b = Buffer.alloc(128 * 1024), n = fs.readSync(fd, b, 0, b.length, 0);
          const m = /"entrypoint"\s*:\s*"([^"]+)"/.exec(b.toString('utf8', 0, n));
          if (m) ss.origin = originOf(m[1]) || '';
        } finally { fs.closeSync(fd); }
      } catch (_) { /* file gone or locked */ }
    }
    return ss.origin || null;
  }

  // ---------------------------------------------------------------- per session
  _sessionCards(ss, now, hist, warnings) {
    const b = ss.built;
    let cards;
    if (ss.active || !b || b.gen !== this._gen || b.activity !== ss.lastActivity || !b.complete || b.live !== ss.live) {
      const cx = { ss, now, hist, complete: true, cutoff: now - Math.max(1, +this.o.recentHours || 24) * 3600e3, scriptDirs: [], cards: [], warns: [] };
      this._cx = cx;
      this._buildSession(cx);
      if (warnings) warnings.push(...cx.warns);
      cards = cx.cards;
      ss.built = { gen: this._gen, activity: ss.lastActivity, complete: cx.complete, live: ss.live, cards };
    } else cards = b.cards;
    const title = this._title(ss), origin = this._origin(ss);
    return cards.map(c => Object.assign({}, c, { sessionTitle: title, origin }));
  }

  _buildSession(cx) {
    const { ss } = cx;
    const runs = new Map(), plain = [];
    const run = id => { let r = runs.get(id); if (!r) { r = { runId: id, runDir: null, resultFile: null, projDir: null }; runs.set(id, r); } return r; };
    for (const en of ss.entries) {
      const sd = en.sessionDir;
      if (!sd) continue;
      const wfRoot = path.join(sd, 'subagents', 'workflows');
      for (const n of CH.dirNames(wfRoot)) if (/^wf_/.test(n)) { const r = run(n); if (!r.runDir) { r.runDir = path.join(wfRoot, n); r.projDir = en.projDir; } }
      for (const n of CH.fileNames(path.join(sd, 'workflows'))) {
        const m = /^(wf_.+)\.json$/.exec(n);
        if (m) { const r = run(m[1]); r.resultFile = path.join(sd, 'workflows', n); r.projDir = r.projDir || en.projDir; }
      }
      cx.scriptDirs.push(path.join(sd, 'workflows', 'scripts'));
      for (const n of CH.fileNames(path.join(sd, 'subagents'))) { const m = /^agent-([0-9A-Za-z]+)\.jsonl$/.exec(n); if (m) plain.push({ id: m[1], file: path.join(sd, 'subagents', n), projDir: en.projDir }); }
    }
    for (const r of runs.values()) {
      let card = r.resultFile ? this._finishedCard(cx, r) : r.runDir ? this._liveCard(cx, r) : null;
      if (card === STALE) card = this._liveCard(cx, r);     // resumed run: the result file is the one of the earlier launch
      if (card) { card.key = ss.sid + ':' + r.runId; card.sessionId = ss.sid; cx.cards.push(card); }
    }
    for (const p of plain) {
      const a = this._plainAgent(cx, p);
      if (a) cx.cards.push({ kind: 'agent', key: ss.sid + ':' + p.id, sessionId: ss.sid, agent: a });
    }
    if (!ss.originFile) ss.originFile = (plain[0] && plain[0].file) || null;
  }

  // ---------------------------------------------------------------- finished runs
  _finishedCard(cx, r) {
    const { now } = cx, key = fkey(r.resultFile);
    let c = this._results.get(key);
    if (!c || now - c.checkedAt >= DISCOVERY_MS) {
      let st = null;
      try { st = fs.statSync(r.resultFile); } catch (_) { /* vanished */ }
      if (!st) { this._results.delete(key); return null; }
      if (!c || c.size !== st.size || c.mtimeMs !== st.mtimeMs) c = { size: st.size, mtimeMs: st.mtimeMs, card: null, skipped: false, retryAt: 0 };
      // A resumed run keeps its directory and its result file: the journal then grows again after the file was written
      // (real tree: 69 of 69 normal runs end with delta <= 0 s, the one resumed run +13156 s), so the file describes the earlier launch.
      c.stale = !!r.runDir && CH.statMs(path.join(r.runDir, 'journal.jsonl')) > st.mtimeMs + RESUME_SLACK_MS;
      c.checkedAt = now;
      this._results.set(key, c);
    }
    c.used = now;
    if (c.stale) return STALE;
    if (!c.card) {
      if (c.bad) return null;
      if (c.mtimeMs < cx.cutoff) { c.skipped = true; return null; }          // finished long ago: not shown, not read
      if (c.size > MAX_RESULT_BYTES) { c.bad = true; return null; }          // not a result file: never read
      if (now < c.retryAt) { cx.complete = false; return null; }
      if (this._budget.bytes <= 0) { cx.complete = false; return null; }     // read budget spent: next tick
      let res = null, card = null, err = null;
      try {
        const text = fs.readFileSync(r.resultFile, 'utf8'); this._budget.bytes -= text.length; res = JSON.parse(text);
        if (isObj(res)) card = cardFromResult(res, r.runId, c.mtimeMs, this.d.prettyModel);
      } catch (e) { card = null; err = e; }
      if (!card) {                                                            // torn, unreadable or unbuildable: retry with back-off, give up until the file changes
        c.fails = (c.fails || 0) + 1;
        if (c.fails < 5) { c.retryAt = now + 1000 * 2 ** c.fails; cx.complete = false; } else c.bad = true;
        // a file that cannot be turned into a card hides only its own run: the other cards of the session stay, with a warning
        if (err && isObj(res)) cx.warns.push(S.warnSession(cx.ss.sid, errMsg(err)));
        return null;
      }
      c.card = card;
      const h = this.o.history;
      if (h && typeof h.ingestRun === 'function') { try { h.ingestRun(r.runId, res, r.projDir ? path.basename(r.projDir).toLowerCase() : undefined); } catch (_) { /* history is a cache */ } }
    }
    return Object.assign({}, c.card);
  }

  // ---------------------------------------------------------------- live runs
  _journal(file, now) {
    const k = fkey(file);
    let c = this._journals.get(k), st = null;
    try { st = fs.statSync(file); } catch (_) { /* no journal */ }
    if (!st) { this._journals.delete(k); return { slots: [], phasesSeen: [], mtimeMs: 0, exists: false }; }
    // an unchanged file is not read again; after a failed read it is retried only on the discovery cadence, not on every tick
    if (c && c.size === st.size && c.mtimeMs === st.mtimeMs && (!c.failedAt || now - c.failedAt < DISCOVERY_MS)) { c.used = now; return c; }
    if (c && this._budget.bytes <= 0) { this._cx.complete = false; c.used = now; return c; }
    if (st.size > MAX_JOURNAL_BYTES) {                                       // not a journal (real ones are < 1 MB): never read, remembered by size
      c = Object.assign(parseJournal(''), { size: st.size, mtimeMs: st.mtimeMs, exists: true, used: now });
      this._journals.set(k, c);
      return c;
    }
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); this._budget.bytes -= st.size; } catch (_) {
      c = Object.assign(c || parseJournal(''), { size: st.size, mtimeMs: st.mtimeMs, exists: true, used: now, failedAt: now });   // keeps the slots known so far
      this._journals.set(k, c);
      return c;
    }
    c = Object.assign(parseJournal(text), { size: st.size, mtimeMs: st.mtimeMs, exists: true, used: now });
    this._journals.set(k, c);
    return c;
  }

  _slotsFromFiles(runDir) {                  // journal missing: one slot per agent file, label/phase from its meta.json
    const out = [];
    for (const n of CH.fileNames(runDir)) {
      const m = /^agent-([0-9A-Za-z]+)\.jsonl$/.exec(n);
      if (!m) continue;
      const meta = readJson(path.join(runDir, 'agent-' + m[1] + '.meta.json')) || {};
      out.push({ key: 'id:' + m[1], id: m[1], label: cap(meta.description, LABEL_MAX) || m[1], phase: cap(meta.workflowPhase, PHASE_MAX), attempts: 1, state: 'running', resultText: null });
    }
    return out;
  }

  _runMeta(cx, r) {                          // script of the run -> name, description, declared phases (never executed)
    const key = cx.ss.key + '|' + r.runId;
    let m = this._metas.get(key);
    if (m && (m.file || cx.now - m.at < 15e3)) { m.used = cx.now; return m; }
    m = { file: null, meta: null, birth: null, name: null, at: cx.now, used: cx.now };
    for (const dir of cx.scriptDirs) {
      const n = CH.fileNames(dir).find(x => x.endsWith('-' + r.runId + '.js'));
      if (!n) continue;
      m.file = path.join(dir, n); m.name = n.slice(0, -(r.runId.length + 4)) || null;
      try {
        const st = fs.statSync(m.file);
        m.birth = Math.round(st.birthtimeMs) || null;
        if (st.size <= 2 * MB) m.meta = this.d.extractMetaSafe(fs.readFileSync(m.file, 'utf8'));
      } catch (_) { /* unreadable script: name from the file name */ }
      break;
    }
    this._metas.set(key, m);
    return m;
  }

  _isRunning(isLive, quietMs) {              // SPEC 3.8
    if (quietMs < RUNNING_MS) return true;
    const stale = Math.max(1, +this.o.staleMinutes || 10) * 60e3;
    return this._regAvail ? isLive && quietMs < Math.max(LIVE_QUIET_MAX_MS, stale) : quietMs < stale;
  }

  _poll(file, isWf, now) {
    const k = fkey(file);
    let t = this._trackers.get(k);
    if (!t) {
      try { t = { tr: new this.d.AgentTracker(file, { isWf, showToolTargets: this.o.showToolTargets }), used: now }; } catch (_) { return EMPTY_SNAP; }
      this._trackers.set(k, t);
    }
    t.used = now;
    const bud = this._reads >= TICK_FILES ? { bytes: 0 } : this._budget, before = bud.bytes;
    let snap;
    try { snap = t.tr.poll(now, bud) || EMPTY_SNAP; } catch (_) { snap = EMPTY_SNAP; }
    if (bud === this._budget && bud.bytes < before) this._reads++;
    if (snap.loading) this._cx.complete = false;
    return snap;
  }

  _etaCached(key, now, sig, fn) {
    const c = this._etaCache.get(key);
    if (c && c.sig === sig && now - c.at < ETA_EVERY_MS) { c.used = now; return c.eta; }
    let eta = null;
    try { eta = fn(); } catch (_) { eta = null; }
    this._etaCache.set(key, { at: now, sig, eta, used: now });
    return eta;
  }

  _liveCard(cx, r) {
    const { ss, now, hist } = cx;
    const j = this._journal(path.join(r.runDir, 'journal.jsonl'), now);
    if (Math.max(j.mtimeMs, CH.statMs(r.runDir)) < cx.cutoff - OLD_RUN_GRACE_MS) return null;   // ancient orphan: not shown, not read
    let slots = j.slots, fromFiles = false;
    if (!slots.length) { slots = this._slotsFromFiles(r.runDir); fromFiles = true; }
    if (!slots.length && !j.exists) return null;
    const meta = this._runMeta(cx, r);
    const snaps = slots.map(s => { const f = agentFile(r.runDir, s.id); return f ? this._poll(f, true, now) : EMPTY_SNAP; });   // an id that is not a plain name never becomes a path
    let newest = j.mtimeMs;
    for (const sn of snaps) newest = Math.max(newest, sn.mtimeMs || 0, sn.lastTs || 0);
    const running = this._isRunning(ss.live, newest ? now - newest : 0);
    const pretty = this.d.prettyModel;
    const agents = slots.map((s, i) => {
      const sn = snaps[i], end = sn.end;
      let state;
      if (s.state === 'done') state = 'done';
      else if (s.state === 'failed') state = 'failed';
      else if (end === 'interrupted') state = 'interrupted';
      else if (end === 'failed') state = 'failed';
      else if (fromFiles && end === 'finished') state = 'done';
      else if (!running) state = 'stopped';
      else state = end === 'waiting' ? 'waiting' : 'running';
      const lv = state === 'running' || state === 'waiting';
      const mid = sn.model && sn.model.id ? sn.model.id : null;
      return agentView({
        id: s.id, label: stripRetry(s.label) || s.id, phase: s.phase, kind: 'wf', model: { id: mid, label: (sn.model && sn.model.label) || pretty(mid) }, state,
        quietSec: lv ? Math.max(0, Math.round((now - lastOf(sn, now)) / 1000)) : 0,
        tokens: sn.tokens || 0, toolUses: sn.toolUses || 0, startedAt: sn.firstTs, endedAt: !lv ? sn.lastTs || sn.mtimeMs || null : null,
        durationMs: !lv && sn.firstTs !== null && sn.lastTs !== null ? Math.max(0, sn.lastTs - sn.firstTs) : null,
        attempt: s.attempts, loading: !!sn.loading, activity: lv ? sn.activity : null,
        failure: state === 'failed' ? (sn.failure || { status: null, error: null, text: '' }) : null,
        resultPreview: state === 'done' ? (sn.resultPreview || cap160(s.resultText)) : null,
      });
    });
    const declared = meta.meta && Array.isArray(meta.meta.phases) ? meta.meta.phases : [];
    const phases = buildPhases(declared, agents, j.phasesSeen);
    const starts = agents.map(a => a.startedAt).filter(t => t !== null);
    const startedAt = starts.length ? Math.min(...starts) : meta.birth;
    const settled = !agents.some(a => a.loading);       // no estimate from a half-read transcript: its times are wrong
    if (this.o.etaEnabled && running && settled) this._agentEtas(cx, r, agents);
    const card = {
      kind: 'workflow', runId: r.runId, name: (meta.meta && cap(meta.meta.name, 200)) || meta.name || r.runId, description: meta.meta ? cap(meta.meta.description, DESC_MAX) : null,
      status: running ? 'running' : 'stopped', startedAt, endedAt: running || !newest ? null : newest,
      durationMs: !running && newest && startedAt !== null ? Math.max(0, newest - startedAt) : null,
      agentsTotal: agents.length, agentsDone: agents.filter(a => a.state === 'done').length, agentsFailed: agents.filter(a => a.state === 'failed').length,
      tokens: agents.reduce((s, a) => s + a.tokens, 0), toolUses: agents.reduce((s, a) => s + a.toolUses, 0), phases, eta: null,
    };
    if (this.o.etaEnabled && running && settled) card.eta = this._workflowEta(cx, r, card, hist);
    return card;
  }

  // ETA inputs (SPEC 6.1): siblings = finished, non-cached agents of the same run and phase
  _agentEtas(cx, r, agents) {
    const { now, hist } = cx, e = this.d.eta;
    const proj = r.projDir ? path.basename(r.projDir).toLowerCase() : '';
    const sibs = new Map();
    for (const a of agents) if (a.state === 'done' && !a.cached && a.durationMs !== null) { const k = a.phase || ''; (sibs.get(k) || sibs.set(k, []).get(k)).push(a.durationMs / 1000); }
    for (const a of agents) {
      if (a.state !== 'running' || a.startedAt === null) continue;
      const sd = sibs.get(a.phase || '') || [];
      a.eta = this._etaCached(cx.ss.key + '|' + a.id, now, sd.length + '|' + a.state, () => e.estimateAgent({
        state: 'running', elapsedSec: Math.max(0, (now - a.startedAt) / 1000), silentSec: a.quietSec, kind: 'wf', label: a.label, phase: a.phase, model: a.model.id,
        project: proj, runId: r.runId, agentType: null, siblingsDoneSec: sd.slice(),
      }, hist));
    }
  }

  _workflowEta(cx, r, card, hist) {
    const { now } = cx, ph = card.phases;
    let cur = -1;
    ph.forEach((p, i) => { if (p.state === 'running') cur = i; });
    if (cur < 0) ph.forEach((p, i) => { if (p.total > 0) cur = i; });
    if (cur < 0 || card.startedAt === null) return null;
    const cp = ph[cur], all = ph.slice(0, cur).filter(p => p.state === 'done').map(p => {
      const ag = p.agents.filter(a => a.startedAt !== null && a.endedAt !== null);
      return ag.length ? (Math.max(...ag.map(a => a.endedAt)) - Math.min(...ag.map(a => a.startedAt))) / 1000 : null;
    }).filter(d => d !== null);
    const input = {
      elapsedSec: Math.max(0, (now - card.startedAt) / 1000), phasesAhead: ph.slice(cur + 1).filter(p => p.total === 0).length,
      currentPhaseSiblingsDoneSec: cp.agents.filter(a => a.state === 'done' && !a.cached && a.durationMs !== null).map(a => a.durationMs / 1000),
      currentPhaseElapsedSecs: cp.agents.filter(a => a.state === 'running' && a.startedAt !== null).map(a => Math.max(0, (now - a.startedAt) / 1000)),
      runPhaseDurSec: all,
    };
    const sig = ph.map(p => p.state + p.done + '/' + p.total).join(',');
    return this._etaCached(cx.ss.key + '|' + r.runId + '|wf', now, sig, () => this.d.eta.estimateWorkflow(input, hist));
  }

  // ---------------------------------------------------------------- plain (Agent-tool) subagents, SPEC 5.4 + 4.5
  _plainAgent(cx, p) {
    const { ss, now, hist } = cx, k = fkey(p.file);
    let e = this._plain.get(k);
    if (!e) { e = { tracked: false, skip: false, checkedAt: 0, meta: null, metaTries: 0, ingested: false }; this._plain.set(k, e); }
    e.used = now;
    if (e.skip && now - e.checkedAt < 30e3) return null;
    if (!e.tracked) {
      e.checkedAt = now;
      if (CH.statMs(p.file) < cx.cutoff) { e.skip = true; return null; }     // finished long ago: not shown, not read
      e.skip = false; e.tracked = true;
    }
    if (!e.meta && e.metaTries < 5) { e.metaTries++; e.meta = readJson(p.file.replace(/\.jsonl$/, '.meta.json')); }
    const meta = isObj(e.meta) ? e.meta : {};
    const sn = this._poll(p.file, false, now);
    const quietMs = now - lastOf(sn, now);
    let state, note = null;
    if (sn.end === 'finished') state = 'done';
    else if (sn.end === 'failed') state = 'failed';
    else if (sn.end === 'interrupted') state = 'interrupted';
    else if (sn.end === 'waiting') { if (quietMs > RUNNING_MS) { state = 'done'; note = S.noReport; } else state = 'waiting'; }
    else state = this._isRunning(ss.live, quietMs) ? 'running' : 'stopped';
    const lv = state === 'running' || state === 'waiting';
    const mid = (sn.model && sn.model.id) || cap(meta.model, MODEL_MAX) || null;
    const a = agentView({
      id: p.id, label: cap(meta.description, 200) || cap(meta.agentType, 80) || p.id.slice(0, 8), phase: null, kind: 'task', agentType: cap(meta.agentType, 80),
      shape: meta.requestShape === 'background' || meta.requestShape === 'foreground' ? meta.requestShape : null,
      model: { id: mid, label: (sn.model && sn.model.label) || this.d.prettyModel(mid) }, state,
      quietSec: lv ? Math.max(0, Math.round(quietMs / 1000)) : 0, tokens: sn.tokens || 0, toolUses: sn.toolUses || 0, startedAt: sn.firstTs,
      endedAt: !lv ? sn.lastTs || sn.mtimeMs || null : null, durationMs: !lv && sn.firstTs !== null && sn.lastTs !== null ? Math.max(0, sn.lastTs - sn.firstTs) : null,
      loading: !!sn.loading, activity: lv ? sn.activity : null,
      failure: state === 'failed' ? (sn.failure || { status: null, error: null, text: '' }) : null,
      resultPreview: state === 'done' ? (sn.resultPreview || note) : null,
    });
    if (this.o.etaEnabled && state === 'running' && a.startedAt !== null && !sn.loading) {
      a.eta = this._etaCached(ss.key + '|' + p.id, now, 'task|' + a.state, () => this.d.eta.estimateAgent({
        state: 'running', elapsedSec: Math.max(0, (now - a.startedAt) / 1000), silentSec: a.quietSec, kind: 'task', label: a.label, phase: null, model: mid,
        project: path.basename(p.projDir).toLowerCase(), runId: null, agentType: a.agentType, siblingsDoneSec: [],
      }, hist));
    }
    const h = this.o.history;
    if (state === 'done' && sn.end === 'finished' && !sn.loading && !e.ingested && a.durationMs && h && typeof h.ingestAgent === 'function') {
      e.ingested = true;
      try {
        h.ingestAgent(ss.sid + ':' + p.id, { kind: 'task', prefix: fold(a.agentType || a.label), phase: null, model: mid, proj: path.basename(p.projDir).toLowerCase(), run: 's:' + ss.sid, durSec: a.durationMs / 1000 });
      } catch (_) { /* history is a cache */ }
    }
    return a;
  }

  // ---------------------------------------------------------------- ViewState
  _assemble(cards, now, warnings, home, lim, usage) {
    const cutoff = now - Math.max(1, +this.o.recentHours || 24) * 3600e3;
    const endOf = c => (c.kind === 'agent' ? c.agent.endedAt : c.endedAt);
    const startOf = c => (c.kind === 'agent' ? c.agent.startedAt : c.startedAt) || 0;
    const isRun = c => (c.kind === 'agent' ? live(c.agent) : c.status === 'running');
    const run = [], rec = [];
    for (const c of cards) {
      if (isRun(c)) run.push(c);
      else if (endOf(c) !== null && endOf(c) >= cutoff) rec.push(c);
    }
    run.sort((a, b) => startOf(b) - startOf(a) || (a.key < b.key ? -1 : 1));
    rec.sort((a, b) => endOf(b) - endOf(a) || (a.key < b.key ? -1 : 1));
    const uniq = [...new Set(warnings)];
    const w = uniq.slice(0, MAX_WARNINGS);
    if (uniq.length > MAX_WARNINGS) w.push(S.warnMore(uniq.length - MAX_WARNINGS));
    const scopeLabel = this._effScope === 'workspace' ? S.scopeWorkspace : this.o.scope === 'all' ? S.scopeAll : S.scopeAllNoFolder;
    const vs = { v: 1, now, scope: this.o.scope === 'all' ? 'all' : 'workspace', scopeLabel, claudeHome: home, running: run.slice(0, lim.maxRunning || MAX_RUNNING), recent: rec.slice(0, lim.maxRecent || MAX_RECENT), warnings: w, formatNote: this._formatNote };
    if (usage) vs.usage = usage;
    return lim.noSizeCap ? vs : this._capState(vs);
  }

  /**
   * ViewState must stay below ~150 KB: shed detail card by card, the oldest first, and stop as soon as it fits; the counters
   * are never shed. The steps run from cheap to drastic and the last one drops whole cards, so the cap always holds.
   */
  _capState(vs) {
    const sizeOf = o => JSON.stringify(o).length;
    let total = sizeOf(vs);
    if (total <= STATE_CAP) return vs;
    // cards are shallow copies of cached ones: replace nested objects, never mutate them
    const dropAgents = c => { if (c.kind === 'workflow') c.phases = c.phases.map(p => (p.agents.length ? Object.assign({}, p, { agents: [] }) : p)); };
    const dropPreview = c => { if (c.kind === 'agent' && c.agent.resultPreview) c.agent = Object.assign({}, c.agent, { resultPreview: null }); };
    const dropPhases = c => { if (c.kind === 'workflow') c.phases = []; };
    const each = (list, fn, keep) => {                  // list ends = oldest; the first `keep` cards stay untouched
      for (let i = list.length - 1; i >= keep && total > STATE_CAP; i--) { const before = sizeOf(list[i]); fn(list[i]); total -= before - sizeOf(list[i]); }
    };
    const trim = (name, n) => { while (total > STATE_CAP && vs[name].length > n) total -= sizeOf(vs[name].pop()); };
    each(vs.recent, dropAgents, 0);
    each(vs.recent, dropPreview, 0);
    each(vs.running, dropAgents, 10);
    trim('recent', 5);
    trim('running', 20);
    each(vs.running, dropAgents, 0);
    each(vs.recent, dropPhases, 0);
    each(vs.running, dropPhases, 0);
    vs.warnings.push(S.warnCapped);
    while (sizeOf(vs) > STATE_CAP && (vs.recent.length || vs.running.length)) (vs.recent.length ? vs.recent : vs.running).pop();
    return vs;
  }

  _evict(now) {
    this._lastEvict = now;
    for (const [k, t] of this._trackers) if (now - t.used > EVICT_MS) { try { t.tr.dispose(); } catch (_) { /* ignore */ } this._trackers.delete(k); }
    for (const m of [this._journals, this._metas, this._plain, this._etaCache, this._results]) for (const [k, v] of m) if (now - (v.used || 0) > EVICT_MS) m.delete(k);
  }
}

module.exports = SessionModel;
module.exports.SessionModel = SessionModel;
module.exports.buildPhases = buildPhases;
module.exports.cardFromResult = cardFromResult;
