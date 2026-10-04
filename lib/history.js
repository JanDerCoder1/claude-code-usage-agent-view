'use strict';
// Persistent ETA history (SPEC 6.7): compact records of finished, successful agents plus phase durations.
// File: <globalStorage>/history.json = { v:2, agents:[{kind,prefix,phase,model,proj,run,dur,np,pos}], phaseDurSec:[], ingestedRuns:[], ingestedAgents:[] }
//
// Sources: the result files <claudeHome>/projects/<proj>/<sid>/workflows/wf_<run>.json (bootstrap, in the background
// in small async batches) and the live ingest calls of the session model. No transcript is ever read. Read-only
// toward ~/.claude; the only file written is the history file itself (temp file + rename).

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { makeRecord, projectKey, stripRetry } = require('./eta');

const FORMAT = 2;   // v2: wf records carry np (agents in the phase) and pos (position of the phase); a v1 file is dropped and rebuilt from the result files
const CAPS = Object.freeze({ agents: 3000, phases: 500, ids: 2000 });   // ~0.5 MB at the caps
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;     // the file is ~0.5 MB at the caps; anything larger is not ours
const MAX_RESULT_BYTES = 32 * 1024 * 1024;     // result files are 0.1-1 MB (they embed the script and result previews)
const MAX_DUR_SEC = 7 * 24 * 3600;             // longer "durations" are garbage
const DEBOUNCE_MS = 2000;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = v => (typeof v === 'string' ? v.slice(0, 300) : '');
const okDur = v => typeof v === 'number' && isFinite(v) && v > 0 && v <= MAX_DUR_SEC;
const noBom = t => (t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t);
const yieldLoop = () => new Promise(resolve => setImmediate(resolve));
// run ids are stored without the "wf_" prefix so that 'wf_abc-123' and 'abc-123' dedupe to one run
const runKey = id => { const s = typeof id === 'string' ? id.trim().replace(/^wf_/, '') : ''; return /^[\w.-]{1,80}$/.test(s) ? s : ''; };
const noOneM = m => (typeof m === 'string' ? m.replace(/\[1m\]$/i, '') : '');   // history keys never carry the 1M-context flag (result files do, the API messages do not, the live label may)
// Run group of a plain agent: workflow run ids as in runKey, or 's:<sessionId>' (the session model groups plain agents by
// session, so the "distinct runs" threshold of eta.js counts sessions, not agents). Without either, the agent is its own group.
const agentRunKey = (run, agentKey) => {
  const s = typeof run === 'string' ? run.trim() : '';
  return /^s:[\w.-]{1,80}$/.test(s) ? s : (runKey(s) || 'a:' + agentKey);
};

function cleanRecord(r) {
  if (!isObj(r) || (r.kind !== 'wf' && r.kind !== 'task') || typeof r.prefix !== 'string' || !okDur(r.dur)) return null;
  const np = Number.isFinite(r.np) && r.np >= 1 ? Math.min(500, Math.round(r.np)) : 1;
  const pos = Number.isFinite(r.pos) ? Math.round(Math.min(1, Math.max(0, r.pos)) * 100) / 100 : 0;
  return { kind: r.kind, prefix: str(r.prefix), phase: str(r.phase), model: str(r.model), proj: str(r.proj), run: str(r.run), dur: Math.round(r.dur * 10) / 10, np, pos };
}

// The project dir a script lives in; used only when ingestRun is called without an explicit project.
function projFromScript(sp) {
  const m = /[\\/]projects[\\/]([^\\/]+)[\\/]/i.exec(String(sp || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * Records and phase durations of one finished run, from its result file (SPEC 5.1 / 6.7).
 * Agents: state done, not cached, finite durationMs. Phases: first start -> last end of a phase whose agents are all
 * finished; in a run that did not complete the last phase is skipped (it may have been cut short).
 */
function extractRun(j, run, proj) {
  const recs = [], groups = new Map();
  let lastIdx = -Infinity;
  // agents per phase (cached ones count: the live card counts them too) and the declared number of phases, for np / pos
  const sizes = new Map();
  const phaseKey = w => (Number.isFinite(w.phaseIndex) ? w.phaseIndex : 't:' + (typeof w.phaseTitle === 'string' ? w.phaseTitle : ''));
  let nPhases = Array.isArray(j.phases) ? j.phases.length : 0;
  for (const w of j.workflowProgress) {
    if (!isObj(w)) continue;
    if (w.type === 'workflow_agent') sizes.set(phaseKey(w), (sizes.get(phaseKey(w)) || 0) + 1);
    if (w.type === 'workflow_phase' && Number.isFinite(w.index)) nPhases = Math.max(nPhases, w.index);
  }
  for (const w of j.workflowProgress) {
    if (!isObj(w)) continue;
    if (w.type === 'workflow_phase' && Number.isFinite(w.index)) lastIdx = Math.max(lastIdx, w.index);
    if (w.type !== 'workflow_agent' || w.cached) continue;
    const idx = Number.isFinite(w.phaseIndex) ? w.phaseIndex : null;
    if (idx !== null) lastIdx = Math.max(lastIdx, idx);
    const gk = idx !== null ? idx : 't:' + (typeof w.phaseTitle === 'string' ? w.phaseTitle : '');   // never String(object): a hostile toString would throw
    let g = groups.get(gk);
    if (!g) { g = { idx, open: false, s: Infinity, e: -Infinity }; groups.set(gk, g); }
    if (w.state === 'progress') g.open = true;
    if ((w.state === 'done' || w.state === 'error') && Number.isFinite(w.startedAt)) {
      const d = Number.isFinite(w.durationMs) ? w.durationMs : (Number.isFinite(w.lastProgressAt) ? w.lastProgressAt - w.startedAt : NaN);
      if (d >= 0) { g.s = Math.min(g.s, w.startedAt); g.e = Math.max(g.e, w.startedAt + d); }
    }
    if (w.state === 'done' && okDur(w.durationMs / 1000)) {
      recs.push(makeRecord({ kind: 'wf', label: stripRetry(w.label), phase: w.phaseTitle, model: noOneM(w.model), project: proj, runId: run, durationSec: w.durationMs / 1000,
        phaseSize: sizes.get(gk), phasePos: idx !== null && nPhases > 1 ? (idx - 1) / (nPhases - 1) : 0 }));
    }
  }
  const complete = j.status === 'completed';
  const phases = [];
  for (const g of groups.values()) {
    if (g.open || !(g.e > g.s)) continue;
    if (!complete && g.idx !== null && g.idx >= lastIdx) continue;
    const d = (g.e - g.s) / 1000;
    if (okDur(d)) phases.push(Math.round(d * 10) / 10);
  }
  return { recs, phases };
}

class History {
  /** @param {string} file  <globalStorage>/history.json   @param {{debounceMs?:number}} [opts] */
  constructor(file, opts) {
    this.file = String(file || '');
    this._debounceMs = opts && Number.isFinite(opts.debounceMs) && opts.debounceMs >= 0 ? opts.debounceMs : DEBOUNCE_MS;
    this._agents = []; this._phases = []; this._runs = []; this._agentIds = [];
    this._runSet = new Set(); this._agentSet = new Set();
    this._dirty = false; this._snap = null; this._timer = null; this._boot = null; this._tmpN = 0;
    this.lastBootstrap = null;   // { files, runs, agents } of the last bootstrap, for logging
    this.lastError = null;       // last write error (the history is a cache: failures are never thrown)
  }

  /** Read the file; missing, corrupt or foreign content leaves the history empty. Never throws. */
  load() {
    this._clearMemory();
    if (!this.file) return;
    let j;
    try {
      const st = fs.statSync(this.file);
      if (!st.isFile() || st.size > MAX_HISTORY_BYTES) return;
      j = JSON.parse(noBom(fs.readFileSync(this.file, 'utf8')));
    } catch (e) { return; }
    if (!isObj(j) || j.v !== FORMAT) return;
    for (const r of Array.isArray(j.agents) ? j.agents : []) { const c = cleanRecord(r); if (c) this._agents.push(c); }
    for (const d of Array.isArray(j.phaseDurSec) ? j.phaseDurSec : []) if (okDur(d)) this._phases.push(d);
    for (const id of Array.isArray(j.ingestedRuns) ? j.ingestedRuns : []) this._addId(this._runs, this._runSet, runKey(id));
    for (const id of Array.isArray(j.ingestedAgents) ? j.ingestedAgents : []) this._addId(this._agentIds, this._agentSet, typeof id === 'string' && id.length <= 300 ? id : '');
    if (this._agents.length > CAPS.agents) this._agents.splice(0, this._agents.length - CAPS.agents);
    if (this._phases.length > CAPS.phases) this._phases.splice(0, this._phases.length - CAPS.phases);
  }

  /**
   * What lib/eta.js expects as its history argument: { agents:[{kind,prefix,phase,model,proj,run,dur,np,pos}], phaseDurSec:number[] }.
   * The only place that knows this shape. The same (frozen) object is returned until the content changes, so the
   * estimator's per-snapshot index is built once per change.
   */
  snapshot() {
    if (!this._snap) this._snap = Object.freeze({ agents: Object.freeze(this._agents.slice()), phaseDurSec: Object.freeze(this._phases.slice()) });
    return this._snap;
  }

  stats() { return { agents: this._agents.length, phases: this._phases.length, runs: this._runs.length, agentIds: this._agentIds.length }; }

  /**
   * Ingest one finished run from its parsed result file. true = newly ingested (deduped by run id, with or without "wf_").
   * `proj` (optional, a project dir name or path) is the key of the project the run belongs to; without it the project dir
   * of resultJson.scriptPath is used (empty if the script lives elsewhere).
   */
  ingestRun(runId, resultJson, proj) {
    try {
      const key = runKey(runId);
      if (!key || !isObj(resultJson) || !Array.isArray(resultJson.workflowProgress) || this._runSet.has(key)) return false;
      const p = projectKey(proj) || projFromScript(resultJson.scriptPath);
      const { recs, phases } = extractRun(resultJson, key, p);
      for (const r of recs) this._agents.push(r);
      if (this._agents.length > CAPS.agents) this._agents.splice(0, this._agents.length - CAPS.agents);
      for (const d of phases) this._phases.push(d);
      if (this._phases.length > CAPS.phases) this._phases.splice(0, this._phases.length - CAPS.phases);
      this._addId(this._runs, this._runSet, key);
      this._touch();
      return true;
    } catch (e) { return false; }
  }

  /** Ingest one finished plain agent. rec.prefix may be a raw label/agent type: it is normalised exactly like eta.js does. */
  ingestAgent(agentKey, rec) {
    try {
      const key = String(agentKey == null ? '' : agentKey);
      if (!key || key.length > 300 || !isObj(rec) || this._agentSet.has(key)) return false;
      if ((rec.kind !== 'wf' && rec.kind !== 'task') || !okDur(rec.durSec)) return false;
      const r = makeRecord({ kind: rec.kind, label: stripRetry(rec.prefix), agentType: rec.prefix, phase: rec.phase, model: noOneM(rec.model), project: projectKey(rec.proj), runId: agentRunKey(rec.run, key), durationSec: rec.durSec });
      this._agents.push(r);
      if (this._agents.length > CAPS.agents) this._agents.splice(0, this._agents.length - CAPS.agents);
      this._addId(this._agentIds, this._agentSet, key);
      this._touch();
      return true;
    } catch (e) { return false; }
  }

  /**
   * SPEC 6.7: ingest every workflows/wf_*.json of every project dir under claudeHome. Result files only, oldest first (the
   * newest survive the caps), small async batches that yield to the event loop, known runs are skipped without reading.
   * Idempotent; concurrent calls share one run. Never rejects.
   */
  bootstrap(claudeHome, opts) {
    if (this._boot) return this._boot;
    const p = this._bootstrap(String(claudeHome || ''), opts || {}).catch(() => {}).then(() => { this._boot = null; });
    this._boot = p;
    return p;
  }

  async _bootstrap(home, opts) {
    if (!home) return;
    const batch = Math.max(1, Math.min(200, Math.floor(opts.batch) || 8));
    const root = path.join(home, 'projects');
    const list = [];
    let ops = 0;
    const tick = async () => { if (++ops % batch === 0) await yieldLoop(); };
    const entries = async dir => { try { return await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return []; } };

    for (const pd of await entries(root)) {
      if (!pd.isDirectory()) continue;
      const proj = projectKey(pd.name), projPath = path.join(root, pd.name);
      const sessions = await entries(projPath);
      await tick();
      for (const s of sessions) {
        if (!s.isDirectory()) continue;
        const wdir = path.join(projPath, s.name, 'workflows');
        const files = await entries(wdir);
        await tick();
        for (const f of files) {
          const m = f.isFile() ? /^wf_(.+)\.json$/.exec(f.name) : null;
          const key = m ? runKey(m[1]) : '';
          if (key && !this._runSet.has(key)) list.push({ file: path.join(wdir, f.name), key, proj });
        }
      }
    }

    const sized = [];
    for (let i = 0; i < list.length; i += batch) {
      const res = await Promise.all(list.slice(i, i + batch).map(f => fsp.stat(f.file).then(st => (st.size <= MAX_RESULT_BYTES ? Object.assign({ mtimeMs: st.mtimeMs }, f) : null), () => null)));
      for (const r of res) if (r) sized.push(r);
      await yieldLoop();
    }
    sized.sort((a, b) => a.mtimeMs - b.mtimeMs);

    let runs = 0;
    const before = this._agents.length;
    for (let i = 0; i < sized.length; i += batch) {
      const chunk = sized.slice(i, i + batch);
      const parsed = await Promise.all(chunk.map(f => fsp.readFile(f.file, 'utf8').then(t => JSON.parse(noBom(t)), () => null).catch(() => null)));
      for (let k = 0; k < chunk.length; k++) if (parsed[k] && this.ingestRun(chunk[k].key, parsed[k], chunk[k].proj)) runs++;
      await yieldLoop();
    }
    this.lastBootstrap = { files: list.length, runs, agents: Math.max(0, this._agents.length - before) };
    this.flush();
  }

  /** Forget everything and delete the file (command agentView.resetEtaHistory). A later bootstrap() refills it. */
  reset() {
    this._clearMemory();
    this._cancelTimer();
    this._dirty = false;
    if (this.file) { try { fs.unlinkSync(this.file); } catch (e) { /* already gone */ } }
  }

  /**
   * Write now if something changed: temp file in the same directory, rename over the target. Ingest calls schedule
   * this through an unref'd debounce timer; call it directly on shutdown. Never throws; on failure the data stays dirty.
   */
  flush() {
    this._cancelTimer();
    if (!this._dirty || !this.file) return;
    const tmp = this.file + '.' + process.pid + '.' + (++this._tmpN) + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const body = JSON.stringify({ v: FORMAT, agents: this._agents, phaseDurSec: this._phases, ingestedRuns: this._runs, ingestedAgents: this._agentIds });
      fs.writeFileSync(tmp, body, 'utf8');   // no fsync: it would block the extension host, and a torn file after a crash is tolerated by load()
      try { fs.renameSync(tmp, this.file); } catch (e) { fs.renameSync(tmp, this.file); }   // Windows: one retry if a reader holds the target
      this._dirty = false;
      this.lastError = null;
    } catch (e) {
      this.lastError = e;
      try { fs.unlinkSync(tmp); } catch (e2) { /* never created */ }
    }
  }

  /** Flush and release the timer (extension deactivate). */
  dispose() { this.flush(); this._cancelTimer(); }

  _touch() {
    this._snap = null;
    this._dirty = true;
    if (this._timer) return;                       // at most one write per debounce window, however many ingests
    const t = setTimeout(() => { this._timer = null; this.flush(); }, this._debounceMs);
    if (t && typeof t.unref === 'function') t.unref();   // a pending write must never keep the extension host alive
    this._timer = t;
  }

  _cancelTimer() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }

  _addId(arr, set, id) {
    if (!id || set.has(id)) return;
    arr.push(id); set.add(id);
    while (arr.length > CAPS.ids) set.delete(arr.shift());
  }

  _clearMemory() {
    this._agents = []; this._phases = []; this._runs = []; this._agentIds = [];
    this._runSet = new Set(); this._agentSet = new Set();
    this._snap = null;
  }
}

module.exports = History;
module.exports.History = History;
module.exports.CAPS = CAPS;
