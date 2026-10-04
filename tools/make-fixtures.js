#!/usr/bin/env node
'use strict';
// Builds test/fixtures/agents/* from the real session tree: sanitised, STRUCTURE-ONLY copies of agent transcripts (SPEC 11.1).
// Kept: line types, ids, timestamps, request ids, usage numbers, stop reasons, tool names/ids, error markers.
// Dropped or stubbed: prompts, system prompts, reasoning text, tool inputs beyond short path/command fields, tool results
// (except the harness' own handback result), attachment bodies. Read-only toward ~/.claude.
//
//   node tools/make-fixtures.js [--home <claudeHome>] [--out <dir>]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentTracker } = require('../lib/agentFold');

const KEEP_TOP = ['type', 'uuid', 'parentUuid', 'timestamp', 'agentId', 'requestId', 'isApiErrorMessage', 'apiErrorStatus', 'error',
  'toolEndsTurn', 'sourceToolAssistantUUID', 'version', 'entrypoint', 'isMeta'];
const TERMINAL = new Set(['SubagentHandback', 'StructuredOutput']);
const SHORT_FIELDS = ['file_path', 'path', 'notebook_path', 'command', 'url', 'query', 'pattern', 'description', 'skill'];

/** Fixture list. `id` = agent id (full), `run` = workflow run id for workflow agents. */
const FIXTURES = [
  { name: 'plain-modern-A', id: 'a881270752ce573c6' },
  { name: 'plain-modern-B', id: 'aeecace96f1a2e00b' },
  { name: 'plain-modern-C', id: 'a5dce7fe12e98feea' },
  { name: 'plain-legacy-ack-1', id: 'a4a5aaeef92fe6ca8' },
  { name: 'plain-legacy-ack-2', id: 'a646e40c46e69be92' },
  { name: 'plain-legacy-nudge-1', id: 'acd8ca9cd6ba29bce' },
  { name: 'plain-legacy-nudge-2', id: 'a4090f193676b02a6' },
  { name: 'wf-done-structured', id: 'a286c2aae7c5e4f0f', run: 'wf_5281790c-ce8' },
  { name: 'wf-done-structured-2', run: 'wf_afd16ef8-1f1', pick: 'smallest-done' },
  { name: 'wf-done-freetext', id: 'a0ce9a0453614f202', run: 'wf_07a35b55-5c4' },
  { name: 'wf-failed-429', id: 'aaf82589f3eca46c1', run: 'wf_b324854d-978' },
  { name: 'wf-failed-server', id: 'ae09c7d756cec8675', run: 'wf_a3f9807b-ab1' },
  { name: 'wf-killed-1', run: 'wf_f558ff26-d2f', nth: 0 },
  { name: 'wf-killed-2', run: 'wf_f558ff26-d2f', nth: 1 },
  { name: 'wf-killed-3', run: 'wf_f558ff26-d2f', nth: 2 },
  { name: 'wf-killed-4', run: 'wf_f558ff26-d2f', nth: 3 },
];

// ---------------------------------------------------------------- sanitising
const scrub = s => String(s).replace(/jans[m]/gi, 'user').replace(/[A-Za-z0-9_+=-]{32,}/g, '<redacted>');
const clip = (s, n) => scrub(s).slice(0, n);

// Tool inputs keep only what the activity line needs: the tail of a path, the executable of a command, short free text.
const PATH_FIELDS = new Set(['file_path', 'path', 'notebook_path']);
function sanitizeInput(name, input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const k of SHORT_FIELDS) {
    const v = input[k];
    if (typeof v !== 'string' || !v) continue;
    if (PATH_FIELDS.has(k)) out[k] = '<dir>/' + clip(v.split(/[\\/]+/).filter(Boolean).slice(-2).join('/'), 60);
    else if (k === 'command') out[k] = clip(v.trim().split(/\s+/)[0], 20) + ' <args>';
    else if (k === 'url') out[k] = clip(v.split(/[?#]/)[0], 80);
    else out[k] = clip(v, 40);
  }
  if (name === 'SubagentHandback' && typeof input.message === 'string') out.message = clip(input.message, 48);
  return out;
}

function sanitizeAssistantContent(content, ctx) {
  if (!Array.isArray(content)) return [];
  return content.map(b => {
    if (!b || typeof b !== 'object') return { type: 'unknown' };
    if (b.type === 'thinking') return { type: 'thinking', thinking: '', signature: 'stub' };
    if (b.type === 'text') return { type: 'text', text: clip(b.text || '', 40) };
    if (b.type === 'tool_use') {
      if (typeof b.id === 'string') ctx.toolNames.set(b.id, b.name);
      return { type: 'tool_use', id: b.id, name: b.name, input: sanitizeInput(b.name, b.input) };
    }
    return { type: String(b.type) };
  });
}

function sanitizeUsage(u) {
  if (!u || typeof u !== 'object') return undefined;
  const out = {};
  for (const k of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) {
    if (typeof u[k] === 'number') out[k] = u[k];
  }
  return out;
}

function sanitizeUserContent(content, ctx) {
  if (typeof content === 'string') {
    if (/^\[(handback-send-enforce|Your previous response had no visible output|Request interrupted)/.test(content)) return clip(content, 60);
    if (/^<system-reminder>/.test(content)) return '<system-reminder>';
    return '[prompt]';
  }
  if (!Array.isArray(content)) return '[prompt]';
  return content.map(b => {
    if (!b || typeof b !== 'object') return { type: 'unknown' };
    if (b.type === 'tool_result') {
      const out = { type: 'tool_result', tool_use_id: b.tool_use_id };
      if (b.is_error === true) out.is_error = true;
      if (TERMINAL.has(ctx.toolNames.get(b.tool_use_id))) {
        const text = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map(x => (x && typeof x.text === 'string' ? x.text : '')).join('') : '';
        out.content = [{ type: 'text', text: clip(text, 80) }];       // the harness' own answer ({"success":true,...}), no user data
      } else out.content = b.is_error === true ? '[error]' : '[result]';
      return out;
    }
    if (b.type === 'text') return { type: 'text', text: /^\[Request interrupted by user/.test(b.text || '') ? clip(b.text, 60) : '[text]' };
    return { type: String(b.type) };
  });
}

/** @returns the sanitised copy of one parsed transcript line (a new object). */
function sanitizeLine(o, ctx) {
  const out = {};
  for (const k of KEEP_TOP) if (o[k] !== undefined) out[k] = o[k];
  if (typeof out.version === 'string') out.version = clip(out.version, 20);
  if (o.type === 'attachment') {
    const a = o.attachment && typeof o.attachment === 'object' ? o.attachment : {};
    out.attachment = { type: String(a.type || 'unknown') };
    if (a.type === 'total_tokens_reminder' && /^<total_tokens>\d+ tokens left<\/total_tokens>$/.test(a.text || '')) out.attachment.text = a.text;
    // the model attachment carries the 1M-context flag the API messages lack; only a plain model id is kept
    if (a.type === 'model' && a.identity && typeof a.identity === 'object' && /^claude-[a-z0-9.-]{1,60}(\[1m\])?$/i.test(a.identity.modelId || '')) out.attachment.identity = { modelId: a.identity.modelId };
    return out;
  }
  const m = o.message;
  if (o.type === 'assistant' && m && typeof m === 'object') {
    out.message = { id: m.id, model: m.model, role: 'assistant', stop_reason: m.stop_reason === undefined ? null : m.stop_reason,
      usage: sanitizeUsage(m.usage), content: sanitizeAssistantContent(m.content, ctx) };
    if (out.message.usage === undefined) delete out.message.usage;
    if (out.message.id === undefined) delete out.message.id;
  } else if (o.type === 'user' && m && typeof m === 'object') {
    out.message = { role: 'user', content: sanitizeUserContent(m.content, ctx) };
  }
  return out;
}

/** Result file of a workflow run: numbers and structure only (no script, summary text, prompts, errors, previews). */
function sanitizeResult(j) {
  const keep = (o, keys) => { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; };
  const out = keep(j, ['runId', 'timestamp', 'durationMs', 'status', 'workflowName', 'startTime', 'defaultModel', 'agentCount', 'totalTokens', 'totalToolCalls']);
  out.phases = (j.phases || []).map(p => ({ title: clip(p.title || '', 60), detail: null }));
  out.workflowProgress = (j.workflowProgress || []).map(w => w.type === 'workflow_phase'
    ? keep(w, ['type', 'index', 'title'])
    : keep(w, ['type', 'index', 'label', 'phaseIndex', 'phaseTitle', 'agentId', 'model', 'state', 'startedAt', 'queuedAt', 'attempt',
      'lastToolName', 'lastProgressAt', 'tokens', 'toolCalls', 'durationMs', 'cached']));
  return out;
}

// ---------------------------------------------------------------- locating sources
const readDir = d => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return []; } };
const exists = p => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };

/** Every <projects>/<enc>/<sid> directory. */
function sessionDirs(projectsDir) {
  const out = [];
  for (const p of readDir(projectsDir)) if (p.isDirectory()) for (const s of readDir(path.join(projectsDir, p.name))) if (s.isDirectory()) out.push(path.join(projectsDir, p.name, s.name));
  return out;
}

function findAgent(dirs, id, run) {
  for (const d of dirs) {
    const f = run ? path.join(d, 'subagents', 'workflows', run, 'agent-' + id + '.jsonl') : path.join(d, 'subagents', 'agent-' + id + '.jsonl');
    if (exists(f)) return f;
  }
  return null;
}
function findResult(dirs, run) {
  for (const d of dirs) { const f = path.join(d, 'workflows', run + '.json'); if (exists(f)) return f; }
  return null;
}
function findRunDir(dirs, run) {
  for (const d of dirs) { const f = path.join(d, 'subagents', 'workflows', run); if (readDir(f).length) return f; }
  return null;
}

// ---------------------------------------------------------------- folding (goldens)
function foldFile(file, isWf) {
  const t = new AgentTracker(file, { isWf, showToolTargets: true });
  let s = null;
  for (let i = 0; i < 200; i++) { s = t.poll(0, { bytes: 8 * 1024 * 1024 }); if (!s.loading) break; }
  t.dispose();
  return s;
}
const expectOf = s => ({
  end: s.end, endReason: s.endReason, tokens: s.tokens, toolUses: s.toolUses, firstTs: s.firstTs, lastTs: s.lastTs,
  durationMs: s.firstTs !== null ? s.lastTs - s.firstTs : null, modelId: s.model.id, modelLabel: s.model.label,
  resultPreview: s.resultPreview, failure: s.failure,
});

function writeJsonl(file, lines) { fs.writeFileSync(file, lines.map(o => JSON.stringify(o)).join('\n') + '\n', 'utf8'); }

function build(opts) {
  const home = opts.home, out = opts.out;
  const dirs = sessionDirs(path.join(home, 'projects'));
  fs.mkdirSync(out, { recursive: true });
  const manifest = { v: 1, generatedBy: 'tools/make-fixtures.js', fixtures: {} };
  const report = [];
  const resultCache = new Map();
  const resultOf = run => {
    if (!resultCache.has(run)) {
      const f = findResult(dirs, run);
      let j = null; try { j = f ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch (_) { /* ignore */ }
      resultCache.set(run, j);
    }
    return resultCache.get(run);
  };
  const killedWritten = new Set();

  for (const fx of FIXTURES) {
    const isWf = !!fx.run;
    let id = fx.id || null;
    let wEntry = null;
    const res = isWf ? resultOf(fx.run) : null;
    if (isWf && !id) {                       // choose the agent from the run's result file
      const agents = ((res && res.workflowProgress) || []).filter(w => w.type === 'workflow_agent');
      if (fx.pick === 'smallest-done') {
        let best = null;
        for (const w of agents.filter(a => a.state === 'done' && !a.cached)) {
          const f = findAgent(dirs, w.agentId, fx.run); if (!f) continue;
          const size = fs.statSync(f).size; if (!best || size < best.size) best = { w, size };
        }
        wEntry = best && best.w;
      } else wEntry = agents[fx.nth];
      id = wEntry && wEntry.agentId;
    }
    if (!id) { report.push(fx.name + ': SKIPPED (agent not found)'); continue; }
    const src = findAgent(dirs, id, fx.run || null);
    if (!src) { report.push(fx.name + ': SKIPPED (' + id + ' not found)'); continue; }
    if (res && !wEntry) wEntry = (res.workflowProgress || []).find(w => w.agentId === id) || null;

    const ctx = { toolNames: new Map() };
    const rawLines = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const clean = rawLines.map(o => sanitizeLine(o, ctx));
    const dst = path.join(out, fx.name + '.jsonl');
    writeJsonl(dst, clean);

    const real = foldFile(src, isWf), fix = foldFile(dst, isWf);
    const a = expectOf(real), b = expectOf(fix);
    for (const k of ['end', 'endReason', 'tokens', 'toolUses', 'firstTs', 'lastTs', 'modelId']) {
      if (a[k] !== b[k]) throw new Error(fx.name + ': sanitising changed ' + k + ' (' + a[k] + ' -> ' + b[k] + ')');
    }
    const first = rawLines.find(o => o.version);
    manifest.fixtures[fx.name] = {
      source: { agentId: id, runId: fx.run || null, version: first ? first.version : null, lines: rawLines.length, isWf },
      expect: b,
      result: wEntry ? { state: wEntry.state, tokens: wEntry.tokens === undefined ? null : wEntry.tokens, toolCalls: wEntry.toolCalls === undefined ? null : wEntry.toolCalls,
        durationMs: wEntry.durationMs === undefined ? null : wEntry.durationMs, model: wEntry.model || null, cached: !!wEntry.cached } : null,
    };
    report.push(fx.name + ': ' + fs.statSync(dst).size + ' B, ' + clean.length + ' lines, ' + b.end + '/' + b.endReason + ', tokens ' + b.tokens);

    if (isWf && res && fx.name.startsWith('wf-killed') && !killedWritten.has(fx.run)) {
      killedWritten.add(fx.run);
      fs.writeFileSync(path.join(out, 'wf-killed.result.json'), JSON.stringify(sanitizeResult(res), null, 1) + '\n', 'utf8');
      report.push('wf-killed.result.json written');
    }
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n', 'utf8');
  return { manifest, report };
}

module.exports = { FIXTURES, sanitizeLine, sanitizeResult, build, findAgent, findResult, findRunDir, sessionDirs };

if (require.main === module) {
  const args = process.argv.slice(2);
  const arg = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const home = arg('--home') || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const out = arg('--out') || path.join(__dirname, '..', 'test', 'fixtures', 'agents');
  if (!fs.existsSync(path.join(home, 'projects'))) { console.error('no projects dir under ' + home); process.exit(1); }
  const { report } = build({ home, out });
  console.log(report.join('\n'));
}
