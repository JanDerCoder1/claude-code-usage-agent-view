'use strict';
// Per-agent transcript fold (SPEC 4.2-4.5): tokens, tool count, model, current activity and end-state of ONE
// subagent transcript (agent-<id>.jsonl). Pure Node. State is folded incrementally; the snapshot never depends on `now`
// (quiet time, "idle for 60 s" and "stopped" are decided by the caller from firstTs/lastTs and the run's liveness).
const { Tail } = require('./tail');
const { prettyModel } = require('./format');

const TERMINAL_TOOLS = new Set(['SubagentHandback', 'StructuredOutput']);
const PREVIEW_MAX = 160;
const FILE_CAP = 1024 * 1024;            // SPEC 4.1: read cap per file per tick
// SPEC 4.4 lists `url` after `command`; the harness shows WebFetch's `prompt` instead of its `url` (2/2 in the result files), so `url` ranks after `prompt`.
const TARGET_KEYS = ['file_path', 'path', 'notebook_path', 'command', 'query', 'pattern', 'description', 'prompt', 'url', 'message', 'skill'];
const TARGET_MAX = 59;                   // the harness shows 59 characters + an ellipsis
const INTERRUPT_RE = /^\[Request interrupted by user/;
const ONE_M_RE = /\[1m\]$/i;
// Text copied out of a transcript is bounded as it is read: a hostile or corrupt file must not be able to grow the view state.
const ID_MAX = 64, MODEL_MAX = 80, TOOL_MAX = 64, ERROR_MAX = 160;
const SUCCESS_RE = /"success"\s*:\s*true/;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const firstLine = s => String(s).split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';   // first non-blank line

/**
 * Harness summary rule for the target of a tool call: first non-empty string of TARGET_KEYS, first line,
 * 59 chars + "…" (Grep/Glob: `path` wins over `pattern`, as in the harness). `detail` carries the Grep/Glob pattern.
 * @returns {{target:string, short:string, detail:string|undefined}}
 */
function summarizeTarget(name, input) {
  const inp = isObj(input) ? input : {};
  let target = '';
  for (const k of TARGET_KEYS) {
    if (typeof inp[k] === 'string' && inp[k].trim()) { target = firstLine(inp[k]); break; }
  }
  if (!target) {
    const v = Object.values(inp).find(x => typeof x === 'string' && x.trim());
    if (v) target = v.replace(/\s+/g, ' ').trim();   // harness: whole text, whitespace collapsed (StructuredOutput has no known key)
  }
  const detail = (name === 'Grep' || name === 'Glob') && typeof inp.pattern === 'string' ? inp.pattern : undefined;
  const short = target.length > TARGET_MAX + 1 ? target.slice(0, TARGET_MAX) + '…' : target;
  return { target, short, detail };
}

/** @returns a fresh fold state */
function newState() {
  return {
    lines: 0,
    id: null, model: null,
    attModel: null,              // model id of the newest {type:'model'} attachment (carries the [1m] flag the API messages lack)
    firstTs: null, lastTs: null,
    lastReq: null,               // {rid, ctx, firstOut, firstFinal, lines, final} of the newest API request
    toolIds: new Set(),          // every distinct tool_use id (fact 6)
    pending: new Map(),          // tool_use id -> {name, target}; insertion order = start order
    pendingTerminal: new Map(),  // SubagentHandback / StructuredOutput id -> message preview
    delivered: false,            // a terminal tool returned success
    workAfter: false,            // a non-terminal tool_use followed the delivery (agent was resumed)
    resultPreview: null,
    lastText: null,              // last assistant text block, <= 160 chars
    last: null,                  // summary of the newest NON-attachment line (see foldAssistant / foldUser)
  };
}

const ctxOf = u => num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);

function resultText(b) {
  const c = b.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => (x && typeof x.text === 'string' ? x.text : '')).join('');
  return '';
}

function foldAssistant(st, o, m) {
  const content = Array.isArray(m.content) ? m.content : [];
  const textBlock = content.find(b => b && b.type === 'text' && typeof b.text === 'string');
  let hasText = false, hasTool = false, hasOther = false;
  for (const b of content) {
    const t = b && b.type;
    if (t === 'text') hasText = true;
    else if (t === 'tool_use') hasTool = true;
    else if (t !== 'thinking' && t !== 'redacted_thinking') hasOther = true;
  }
  const last = {
    type: 'assistant', apiError: false, status: null, error: null, text: '',
    stop: typeof m.stop_reason === 'string' ? m.stop_reason : null,
    proseOnly: content.length > 0 && !hasTool && !hasOther,     // only text/thinking blocks
    hasText,
  };
  st.last = last;
  // API-error and synthetic lines are the file's last line when the request failed (429, server_error); they never
  // count for tokens, model, tools or delivery state (SPEC 4.2).
  if (o.isApiErrorMessage === true || m.model === '<synthetic>') {
    if (o.isApiErrorMessage === true) {
      last.apiError = true;
      last.status = typeof o.apiErrorStatus === 'number' ? o.apiErrorStatus : null;
      last.error = typeof o.error === 'string' ? o.error.slice(0, ERROR_MAX) : null;
      last.text = textBlock ? textBlock.text.slice(0, PREVIEW_MAX) : '';
    }
    return;
  }
  if (typeof m.model === 'string' && m.model) st.model = m.model.slice(0, MODEL_MAX);
  const u = m.usage;
  if (isObj(u)) {
    const rid = o.requestId || m.id || null;
    const stopped = typeof m.stop_reason === 'string' && m.stop_reason !== '';
    // firstFinal: the writer already back-filled stop_reason and the real output_tokens into the FIRST line of the request
    if (rid === null || !st.lastReq || st.lastReq.rid !== rid) st.lastReq = { rid, ctx: ctxOf(u), firstOut: num(u.output_tokens), firstFinal: stopped, lines: 0, final: false };
    st.lastReq.lines++;
    st.lastReq.final = stopped;                               // message_delta merged into the newest line
  }
  for (let i = 0; i < content.length; i++) {
    const b = content[i];
    if (!b) continue;
    if (b.type === 'text' && typeof b.text === 'string') st.lastText = b.text.slice(0, PREVIEW_MAX);
    else if (b.type === 'tool_use') {
      const id = typeof b.id === 'string' && b.id ? b.id : '#' + st.lines + '/' + i;
      if (st.toolIds.has(id)) continue;                       // wireToolInputs / re-written lines carry the same id again
      st.toolIds.add(id);
      const name = typeof b.name === 'string' ? b.name.slice(0, TOOL_MAX) : '?';
      st.pending.set(id, { name, target: summarizeTarget(name, b.input).short });
      if (TERMINAL_TOOLS.has(name)) {
        const msg = isObj(b.input) && typeof b.input.message === 'string' ? b.input.message.slice(0, PREVIEW_MAX) : null;
        st.pendingTerminal.set(id, msg);
      } else if (st.delivered) st.workAfter = true;
    }
  }
}

function foldUser(st, o, m) {
  const c = m.content;
  let first = null;                                           // first text of the line
  let hasResult = false;                                      // the line carries tool results
  if (typeof c === 'string') first = c;
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (!b) continue;
      if (b.type === 'tool_result') {
        hasResult = true;
        const id = b.tool_use_id;
        st.pending.delete(id);
        if (st.pendingTerminal.has(id)) {
          const msg = st.pendingTerminal.get(id);
          st.pendingTerminal.delete(id);
          if (b.is_error !== true && (o.toolEndsTurn === true || SUCCESS_RE.test(resultText(b)))) {
            st.delivered = true; st.workAfter = false; st.resultPreview = msg;
          }
        }
      } else if (b.type === 'text' && first === null && typeof b.text === 'string') first = b.text;
    }
  }
  const interrupted = typeof first === 'string' && INTERRUPT_RE.test(first);
  // A real prompt after a delivered report resumes the agent (SendMessage to the same task id): the old report no longer
  // describes it. The harness' own nudges and reminders carry isMeta and keep the legacy "finished" behaviour; an
  // interrupt is classified from its own line.
  if (st.delivered && !hasResult && typeof first === 'string' && o.isMeta !== true && !interrupted) {
    st.delivered = false; st.workAfter = false; st.resultPreview = null;
  }
  st.last = { type: 'user', toolEndsTurn: o.toolEndsTurn === true, interrupted };
}

/** The model of an attachment line {type:'model', identity:{modelId}} (the newest one wins). */
function foldModelAttachment(st, att) {
  const id = isObj(att.identity) && typeof att.identity.modelId === 'string' ? att.identity.modelId.slice(0, MODEL_MAX) : '';
  if (id) st.attModel = id;
}

/**
 * The model to show. The API messages carry the bare id ('claude-opus-5'); only the model attachment at the top of the
 * transcript knows the 1M-context flag ('claude-opus-5[1m]'), which the finished card (result file) shows. Take the
 * attachment's id when it names the same model, and the messages' id when the agent really ran another one.
 */
function effectiveModel(st) {
  const a = st.attModel, m = st.model;
  if (!a) return m;
  if (!m) return a;
  return a.replace(ONE_M_RE, '') === m ? a : m;
}

function foldLine(st, o) {
  if (!isObj(o)) return;
  st.lines++;
  const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  if (!Number.isNaN(ts)) {
    if (st.firstTs === null || ts < st.firstTs) st.firstTs = ts;
    if (st.lastTs === null || ts > st.lastTs) st.lastTs = ts;
  }
  if (st.id === null && typeof o.agentId === 'string' && o.agentId) st.id = o.agentId.slice(0, ID_MAX);
  const m = o.message;
  if (o.type === 'assistant' && isObj(m)) foldAssistant(st, o, m);
  else if (o.type === 'user' && isObj(m)) foldUser(st, o, m);
  else if (o.type === 'attachment' && isObj(o.attachment) && o.attachment.type === 'model') foldModelAttachment(st, o.attachment);
  // other attachments and unknown line types: only the timestamp counts
}

/**
 * Fold parsed transcript lines into a state (a fresh one, or `prevState` for incremental use). Mutates and returns it.
 * @param {object[]} lines parsed JSONL objects in file order
 */
function foldLines(lines, prevState) {
  const st = prevState && prevState.toolIds instanceof Set ? prevState : newState();   // a foreign object is never folded into
  if (Array.isArray(lines)) for (const o of lines) foldLine(st, o);
  return st;
}

/**
 * End-state of an agent (SPEC 4.5, verified 100 % against 673 workflow agents and 18 plain agents).
 * @param {object[]|object} x parsed lines (attachments allowed) or an already folded state
 * @param {boolean} isWf agent lives under subagents/workflows/ (free text then IS the result)
 * @returns {{state:'running'|'finished'|'failed'|'interrupted'|'idle', reason:string, status?:number|null, error?:string|null, text?:string}}
 */
function classifyEnd(x, isWf) {
  const st = Array.isArray(x) ? foldLines(x) : (x || newState());
  const last = st.last;
  if (!last) return { state: 'running', reason: 'empty' };
  if (last.type === 'assistant' && last.apiError) return { state: 'failed', reason: 'api-error', status: last.status, error: last.error, text: last.text };
  if (st.delivered && !st.workAfter && (last.type === 'assistant' || last.toolEndsTurn === true)) {
    return { state: 'finished', reason: last.toolEndsTurn === true ? 'tool-ends-turn' : 'handback-then-ack' };
  }
  if (last.type === 'user') return last.interrupted ? { state: 'interrupted', reason: 'user-interrupt' } : { state: 'running', reason: 'user-line' };
  if (last.proseOnly && last.stop === 'end_turn') {
    return isWf ? { state: 'finished', reason: 'end-turn-text' } : { state: 'idle', reason: 'end-turn-no-handback' };
  }
  return { state: 'running', reason: 'in-flight' };
}

/** SPEC 4.4: what the agent is doing right now; null when it is not running. */
function currentActivity(st, endState, showToolTargets) {
  if (endState === 'idle') return { kind: 'waiting', running: false };
  if (endState !== 'running' || st.lines === 0) return null;
  if (st.pending.size > 0) {
    let newest = null;
    for (const p of st.pending.values()) newest = p;          // Map keeps insertion order
    const a = { kind: 'tool', tool: newest.name, running: true, parallel: st.pending.size };
    if (showToolTargets && newest.target) a.target = newest.target;
    return a;
  }
  const last = st.last;
  if (last && last.type === 'assistant' && last.hasText) return { kind: 'writing', running: true };
  return { kind: 'thinking', running: true };
}

const MAP_END = { running: 'running', idle: 'waiting', finished: 'finished', failed: 'failed', interrupted: 'interrupted' };

/**
 * SPEC fact 5 / 4.3: context size of the newest request + the message_start placeholder of its output (what the harness shows).
 * The placeholder survives only on the FIRST line of a multi-line response. A single-line response either still carries it
 * (no stop_reason yet: in flight or interrupted, the 4 killed agents of wf_f558ff26-d2f) or was finalised by message_delta
 * (stop_reason set), which overwrote the placeholder with the real output: then it counts 0 (typically 20 tokens below the harness).
 * A multi-line response whose FIRST line was back-filled too (firstFinal: stop_reason on it, because the writer wrote the lines
 * after the response had ended) carries the real output there, not the placeholder: counting it would add the whole output.
 */
function tokensOf(st) {
  const q = st.lastReq;
  return q ? q.ctx + ((q.lines > 1 || !q.final) && !q.firstFinal ? q.firstOut : 0) : 0;
}

function snapshotOf(st, tail, isWf, showToolTargets, fallbackId) {
  const end = classifyEnd(st, isWf);
  const modelId = st.model;
  return {
    missing: tail.missing, loading: tail.loading, badLines: tail.badLines, size: tail.size, mtimeMs: tail.mtimeMs,
    id: st.id || fallbackId,
    // id = the bare id of the API messages (the key the ETA history uses); only the LABEL carries the 1M-context flag
    model: { id: modelId, label: prettyModel(effectiveModel(st)) },
    tokens: tokensOf(st),
    toolUses: st.toolIds.size,
    firstTs: st.firstTs, lastTs: st.lastTs,
    end: MAP_END[end.state],
    endReason: end.reason,
    activity: currentActivity(st, end.state, showToolTargets),
    failure: end.state === 'failed' ? { status: end.status === undefined ? null : end.status, error: end.error || null, text: end.text || '' } : null,
    resultPreview: end.state === 'finished' ? (st.resultPreview || (end.reason === 'end-turn-text' ? st.lastText : null)) : null,
  };
}

function idFromFile(file) {
  const m = /agent-([0-9a-zA-Z]+)\.jsonl$/.exec(String(file));
  return m ? m[1] : null;
}

const NEUTRAL_TAIL = { missing: true, loading: false, badLines: 0, size: 0, mtimeMs: 0 };

class AgentTracker {
  /** @param {string} file @param {{isWf?:boolean, showToolTargets?:boolean}} [opts] */
  constructor(file, opts) {
    const o = opts || {};
    this.file = file;
    this.isWf = !!o.isWf;
    this.showToolTargets = o.showToolTargets !== false;
    this._tail = new Tail(file);
    this._st = newState();
    this._snap = null;
    this._id = idFromFile(file);
  }

  /**
   * Read what was appended since the last call and return the current snapshot. Decrements `budget.bytes` by the bytes
   * read (at most 1 MB per call per file). Never throws. The returned object may be a shallow copy of a cached
   * snapshot: treat it as read-only.
   * @param {number} now epoch ms (the snapshot itself does not depend on it)
   * @param {{bytes:number}} [budget]
   */
  poll(now, budget) {
    try {
      const avail = budget && Number.isFinite(budget.bytes) ? Math.max(0, budget.bytes) : FILE_CAP;
      const r = this._tail.poll(Math.min(FILE_CAP, avail));
      if (budget && Number.isFinite(budget.bytes)) budget.bytes -= r.bytesRead;
      if (r.reset) this._st = newState();
      if (r.lines.length) foldLines(r.lines, this._st);
      if (r.changed || !this._snap) this._snap = snapshotOf(this._st, r, this.isWf, this.showToolTargets, this._id);
      return Object.assign({}, this._snap);
    } catch (_) {
      return this._snap ? Object.assign({}, this._snap) : snapshotOf(newState(), NEUTRAL_TAIL, this.isWf, this.showToolTargets, this._id);
    }
  }

  dispose() {
    this._tail = new Tail(this.file);       // drop buffers; a later poll would start over from byte 0
    this._st = newState();
    this._snap = null;
  }
}

module.exports = { AgentTracker, foldLines, classifyEnd, summarizeTarget, newState };
