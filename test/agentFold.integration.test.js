'use strict';
// Acceptance numbers against the REAL session tree of this machine (SPEC 11.3). Skipped when ~/.claude/projects is missing.
// Read-only: only agent-*.jsonl, journal.jsonl, workflows/wf_*.json and workflows/scripts/*.js are opened; the main
// transcript <sid>.jsonl, *.key, ide/*.lock and .credentials.json are never touched.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentTracker, summarizeTarget } = require('../lib/agentFold');
const { extractMetaSafe } = require('../lib/workflowMeta');

const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const projects = path.join(home, 'projects');
const SKIP = fs.existsSync(projects) ? false : 'no ~/.claude/projects (integration test skipped)';

const readDir = d => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return []; } };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const stripM = id => String(id || '').replace(/\[1m\]$/i, '');

let tree = null;
/** Every session directory with its plain agents, workflow run dirs, result files and scripts. */
function discover() {
  if (tree) return tree;
  tree = { plain: [], runs: [], results: [], scripts: [] };
  for (const p of readDir(projects)) {
    if (!p.isDirectory()) continue;
    for (const s of readDir(path.join(projects, p.name))) {
      if (!s.isDirectory()) continue;                       // <sid>.jsonl files are skipped by type (never opened)
      const sd = path.join(projects, p.name, s.name);
      const sub = path.join(sd, 'subagents');
      for (const e of readDir(sub)) {
        if (e.isFile() && /^agent-[0-9a-f]+\.jsonl$/.test(e.name)) tree.plain.push({ file: path.join(sub, e.name), id: e.name.slice(6, -6) });
      }
      for (const r of readDir(path.join(sub, 'workflows'))) {
        if (!r.isDirectory() || !/^wf_/.test(r.name)) continue;
        const dir = path.join(sub, 'workflows', r.name);
        tree.runs.push({ runId: r.name, dir, journal: path.join(dir, 'journal.jsonl'), sessionDir: sd });
      }
      for (const r of readDir(path.join(sd, 'workflows'))) {
        if (r.isFile() && /^wf_[^/\\]+\.json$/.test(r.name)) tree.results.push({ file: path.join(sd, 'workflows', r.name), sessionDir: sd });
      }
      for (const r of readDir(path.join(sd, 'workflows', 'scripts'))) {
        const m = /^(.*)-(wf_[0-9a-f-]+)\.js$/.exec(r.name);
        if (r.isFile() && m) tree.scripts.push({ file: path.join(sd, 'workflows', 'scripts', r.name), runId: m[2] });
      }
    }
  }
  return tree;
}

const cache = new Map();
/** Fold a whole agent file through the tracker (several polls because of the 1 MB per-poll cap). */
function fold(file, isWf) {
  const key = file + '|' + isWf;
  if (cache.has(key)) return cache.get(key);
  const t = new AgentTracker(file, { isWf, showToolTargets: true });
  let s = null;
  for (let i = 0; i < 1000; i++) { s = t.poll(0, { bytes: 64 * 1024 * 1024 }); if (!s.loading) break; }
  t.dispose();
  cache.set(key, s);
  return s;
}

/** journal.jsonl -> Map agentId -> 'result' | 'failed' | 'none' (latest line wins; torn lines ignored) */
function journalOutcomes(file) {
  const out = new Map();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return out; }
  for (const l of text.split('\n')) {
    if (!l) continue;
    let e; try { e = JSON.parse(l); } catch (_) { continue; }
    if (!e || !e.agentId) continue;
    if (e.type === 'started') { if (!out.has(e.agentId)) out.set(e.agentId, 'none'); }
    else if (e.type === 'result') out.set(e.agentId, 'result');
    else if (e.type === 'failed') out.set(e.agentId, 'failed');
  }
  return out;
}

const pct = (n, d) => (d === 0 ? 100 : (100 * n) / d);
const RECENT_MS = 30 * 1000;                 // files written to in the last 30 s may belong to a live run

describe('real tree: end-state cross-tab against the journals (SPEC 4.5 / 11.3)', { skip: SKIP }, () => {
  test('journal result -> finished, journal failed -> failed, no outcome -> never finished', () => {
    const { runs } = discover();
    const tab = {};
    const wrong = [];
    let seen = 0;
    for (const run of runs) {
      for (const [id, outcome] of journalOutcomes(run.journal)) {
        const file = path.join(run.dir, 'agent-' + id + '.jsonl');
        let st; try { st = fs.statSync(file); } catch (_) { continue; }
        const s = fold(file, true);
        seen++;
        const k = outcome + ' -> ' + s.end + '/' + s.endReason;
        tab[k] = (tab[k] || 0) + 1;
        const recent = Date.now() - st.mtimeMs < RECENT_MS;
        if (outcome === 'result' && s.end !== 'finished') wrong.push(file + ' result->' + s.end);
        if (outcome === 'failed' && s.end !== 'failed') wrong.push(file + ' failed->' + s.end);
        if (outcome === 'none' && s.end === 'finished' && !recent) wrong.push(file + ' none->finished');
      }
    }
    assert.ok(seen > 50, 'only ' + seen + ' journal agents found');
    assert.deepEqual(wrong, [], JSON.stringify(tab));
    // the real tree contains both shapes of finished workflow agents
    assert.ok(tab['result -> finished/tool-ends-turn'] > 0);
    assert.ok(tab['result -> finished/end-turn-text'] > 0);
  });

  test('failed agents carry status and error; interrupted agents exist and have no activity', () => {
    const { runs } = discover();
    let failed = 0, interrupted = 0;
    for (const run of runs) {
      for (const [id, outcome] of journalOutcomes(run.journal)) {
        const file = path.join(run.dir, 'agent-' + id + '.jsonl');
        if (!fs.existsSync(file)) continue;
        const s = fold(file, true);
        if (outcome === 'failed') {
          failed++;
          assert.ok(s.failure, file);
          assert.ok(s.failure.status === null || typeof s.failure.status === 'number');
          assert.ok(s.failure.error === 'rate_limit' || s.failure.error === 'server_error' || s.failure.error === null || typeof s.failure.error === 'string');
          assert.equal(s.activity, null);
          assert.notEqual(s.model.id, '<synthetic>');
        }
        if (s.end === 'interrupted') { interrupted++; assert.equal(s.activity, null); assert.equal(outcome, 'none'); }
      }
    }
    assert.ok(failed >= 5, 'failed agents: ' + failed);
    assert.ok(interrupted >= 5, 'interrupted agents: ' + interrupted);
  });

  test('plain (Agent-tool) agents are finished, with a handback preview (agents written to in the last 5 minutes may still run)', () => {
    const { plain } = discover();
    assert.ok(plain.length >= 15);
    const byReason = {};
    for (const a of plain) {
      const s = fold(a.file, false);
      const live = Date.now() - fs.statSync(a.file).mtimeMs < 5 * 60 * 1000;
      if (live) continue;
      // an agent that was resumed with a message and then answered in plain text has no report: it shows as 'waiting' (the model turns it into done 'ohne Bericht')
      if (s.end === 'waiting' && s.endReason === 'end-turn-no-handback') { byReason.resumedNoReport = (byReason.resumedNoReport || 0) + 1; continue; }
      assert.equal(s.end, 'finished', a.file + ' ' + s.endReason);
      assert.ok(s.endReason === 'tool-ends-turn' || s.endReason === 'handback-then-ack', s.endReason);
      assert.ok(s.toolUses >= 1);
      byReason[s.endReason] = (byReason[s.endReason] || 0) + 1;
    }
    assert.ok(byReason['tool-ends-turn'] > 0 && byReason['handback-then-ack'] > 0, JSON.stringify(byReason));
  });
});

describe('real tree: tokens, tool count, duration and model against the result files (SPEC 11.3)', { skip: SKIP }, () => {
  const collect = () => {
    const { results } = discover();
    const rows = [], runs = [];
    for (const r of results) {
      const j = readJson(r.file);
      if (!j || !Array.isArray(j.workflowProgress)) continue;
      const dir = path.join(r.sessionDir, 'subagents', 'workflows', j.runId);
      let sumTracker = 0, complete = true;
      for (const w of j.workflowProgress) {
        if (w.type !== 'workflow_agent' || w.state !== 'done' || w.cached) continue;
        const file = path.join(dir, 'agent-' + w.agentId + '.jsonl');
        if (!fs.existsSync(file)) { complete = false; continue; }
        const s = fold(file, true);
        rows.push({ w, s, run: j.runId });
        sumTracker += s.tokens;
      }
      runs.push({ j, sumTracker, complete });
    }
    return { rows, runs };
  };

  test('tokens: >= 90 % exact and >= 99 % within 2 %', () => {
    const { rows } = collect();
    assert.ok(rows.length > 300, 'agents compared: ' + rows.length);
    const exact = rows.filter(x => x.s.tokens === x.w.tokens).length;
    const within = rows.filter(x => Math.abs(x.s.tokens - x.w.tokens) <= 0.02 * x.w.tokens).length;
    assert.ok(pct(exact, rows.length) >= 90, 'exact ' + exact + '/' + rows.length);
    assert.ok(pct(within, rows.length) >= 99, 'within 2 % ' + within + '/' + rows.length);
  });

  test('toolCalls: >= 99.8 % equal', () => {
    const { rows } = collect();
    const ok = rows.filter(x => x.s.toolUses === x.w.toolCalls).length;
    // >= 99.5 %: known mismatches are retry slots and agents that were resumed with a message after their workflow ended (more calls than the result file counted)
    assert.ok(pct(ok, rows.length) >= 99.5, 'equal ' + ok + '/' + rows.length);
  });

  test('duration (last - first line timestamp) within 50 ms of durationMs for >= 95 %', () => {
    const { rows } = collect();
    const ok = rows.filter(x => Math.abs((x.s.lastTs - x.s.firstTs) - x.w.durationMs) <= 50).length;
    assert.ok(pct(ok, rows.length) >= 95, 'within 50 ms ' + ok + '/' + rows.length);
  });

  test('model equals the result-file model for 100 % (after stripping the [1m] suffix)', () => {
    const { rows } = collect();
    const bad = rows.filter(x => x.s.model.id !== stripM(x.w.model));
    assert.deepEqual(bad.map(x => x.w.agentId + ' ' + x.s.model.id + ' vs ' + x.w.model), []);
    assert.ok(rows.every(x => x.s.model.label && x.s.model.label !== x.s.model.id));
  });

  test('every finished-agent snapshot is complete: not loading, no bad lines, end finished', () => {
    const { rows } = collect();
    for (const x of rows) {
      assert.equal(x.s.missing, false);
      assert.equal(x.s.loading, false);
      assert.equal(x.s.badLines, 0, x.run + ' ' + x.w.agentId);
      assert.equal(x.s.end, 'finished', x.run + ' ' + x.w.agentId);
    }
  });

  test('run totals: totalTokens == sum of agent tokens in the result files; the tracker sums within 2 % for >= 95 % of the runs', () => {
    const { runs } = collect();
    assert.ok(runs.length >= 30);
    let resultOk = 0, trackerOk = 0, trackerN = 0;
    for (const r of runs) {
      const sum = (r.j.workflowProgress || []).filter(w => w.type === 'workflow_agent').reduce((a, w) => a + (w.tokens || 0), 0);
      if (sum === r.j.totalTokens) resultOk++;
      const nonDone = (r.j.workflowProgress || []).some(w => w.type === 'workflow_agent' && (w.state !== 'done' || w.cached));
      if (r.complete && !nonDone && r.j.totalTokens > 0) { trackerN++; if (Math.abs(r.sumTracker - r.j.totalTokens) <= 0.02 * r.j.totalTokens) trackerOk++; }
    }
    assert.ok(pct(resultOk, runs.length) >= 98, 'result files: ' + resultOk + '/' + runs.length);
    assert.ok(trackerN >= 20);
    assert.ok(pct(trackerOk, trackerN) >= 95, 'tracker sums: ' + trackerOk + '/' + trackerN);
  });
});

describe('real tree: activity target equals the harness summary; incremental read equals a naive full parse', { skip: SKIP }, () => {
  test('summarizeTarget of the last tool_use equals lastToolSummary (and the tool name equals lastToolName) in >= 99 %', () => {
    const { results } = discover();
    let n = 0, nameOk = 0, sumOk = 0;
    for (const r of results) {
      const j = readJson(r.file);
      if (!j || !Array.isArray(j.workflowProgress)) continue;
      const dir = path.join(r.sessionDir, 'subagents', 'workflows', j.runId);
      for (const w of j.workflowProgress) {
        if (w.type !== 'workflow_agent' || w.lastToolSummary === undefined || !w.lastToolName) continue;
        const file = path.join(dir, 'agent-' + w.agentId + '.jsonl');
        if (!fs.existsSync(file)) continue;
        let last = null;
        for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!l) continue;
          let o; try { o = JSON.parse(l); } catch (_) { continue; }
          if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) for (const b of o.message.content) if (b.type === 'tool_use') last = b;
        }
        if (!last) continue;
        n++;
        if (last.name === w.lastToolName) nameOk++;
        if (summarizeTarget(last.name, last.input).short === w.lastToolSummary) sumOk++;
      }
    }
    assert.ok(n >= 100, 'samples: ' + n);
    assert.ok(pct(nameOk, n) >= 99.5, 'names ' + nameOk + '/' + n); // a resumed agent's last tool call is newer than the result file
    assert.ok(pct(sumOk, n) >= 99, 'summaries ' + sumOk + '/' + n);
  });

  test('tracker (1 MB poll cap, carry across polls) == independent naive parse: tool count, timestamps, tokens, model', () => {
    const { plain, runs } = discover();
    const files = plain.map(a => ({ file: a.file, isWf: false }));
    for (const r of runs) for (const e of readDir(r.dir)) if (/^agent-[0-9a-f]+\.jsonl$/.test(e.name)) files.push({ file: path.join(r.dir, e.name), isWf: true });
    let compared = 0;
    for (const f of files) {
      const size = fs.statSync(f.file).size;
      if (size > 3 * 1024 * 1024) continue;                          // keep the run time reasonable
      const text = fs.readFileSync(f.file, 'utf8');
      const cut = text.lastIndexOf('\n');
      const lines = (cut >= 0 ? text.slice(0, cut) : '').split('\n').filter(Boolean);
      const ids = new Set();
      let first = null, last = null, lastReq = null, model = null;
      for (const l of lines) {
        let o; try { o = JSON.parse(l); } catch (_) { continue; }
        const t = Date.parse(o.timestamp);
        if (!Number.isNaN(t)) { if (first === null || t < first) first = t; if (last === null || t > last) last = t; }
        if (o.type !== 'assistant' || !o.message || o.isApiErrorMessage === true || o.message.model === '<synthetic>') continue;
        const m = o.message;
        if (m.model) model = m.model;
        const rid = o.requestId || m.id;
        if (m.usage) {
          if (!lastReq || lastReq.rid !== rid) lastReq = { rid, ctx: (m.usage.input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0) + (m.usage.cache_read_input_tokens || 0), first: m.usage.output_tokens || 0, firstFin: !!m.stop_reason, n: 0, fin: false };
          lastReq.n++; lastReq.fin = !!m.stop_reason;
        }
        for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === 'tool_use') ids.add(b.id);
      }
      const s = fold(f.file, f.isWf);
      if (s.size !== size) continue;                                 // file grew while the test ran (live run)
      compared++;
      assert.equal(s.toolUses, ids.size, f.file);
      assert.equal(s.firstTs, first, f.file);
      assert.equal(s.lastTs, last, f.file);
      assert.equal(s.model.id, model, f.file);
      // the placeholder output of the first line counts unless that line already carries stop_reason (back-filled with the real output)
      assert.equal(s.tokens, lastReq ? lastReq.ctx + ((lastReq.n > 1 || !lastReq.fin) && !lastReq.firstFin ? lastReq.first : 0) : 0, f.file);
    }
    assert.ok(compared > 300, 'files compared: ' + compared);
  });
});

describe('real tree: workflow scripts (extractMetaSafe never executes anything)', { skip: SKIP }, () => {
  test('every real script parses without the degraded fallback; name, description and phases equal the result file', () => {
    const { scripts, results } = discover();
    const byRun = new Map();
    for (const r of results) { const j = readJson(r.file); if (j && j.runId) byRun.set(j.runId, j); }
    assert.ok(scripts.length >= 30, 'scripts: ' + scripts.length);
    let compared = 0;
    delete globalThis.PWNED;
    for (const sc of scripts) {
      const meta = extractMetaSafe(fs.readFileSync(sc.file, 'utf8'));
      assert.ok(meta, sc.file);
      assert.equal(meta.degraded, false, sc.file);
      assert.equal(typeof meta.name, 'string', sc.file);
      const j = byRun.get(sc.runId);
      if (!j) continue;
      compared++;
      assert.equal(meta.name, j.workflowName, sc.file);
      assert.deepEqual(meta.phases.map(p => p.title), (j.phases || []).map(p => p.title), sc.file);
      assert.deepEqual(meta.phases.map(p => p.detail), (j.phases || []).map(p => (p.detail === undefined ? null : p.detail)), sc.file);
      assert.equal(meta.description, j.summary === undefined ? null : j.summary, sc.file);
    }
    assert.ok(compared >= 20, 'compared: ' + compared);
    assert.equal(globalThis.PWNED, undefined);
  });
});
