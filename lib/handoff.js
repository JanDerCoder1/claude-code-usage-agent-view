'use strict';
// Hand-off: a digest of one session's main transcript, written as a Markdown file into the temp folder, so a fresh session can
// pick the work up. Mechanical on purpose: no model call, no summary by Claude. It collects what was asked, where the session
// stood, open to-dos, files touched and the last commands, and says so in the file.
// This is the one place that opens a main transcript (<sid>.jsonl), and only for the session the person picked, on request.
// The transcript is streamed (files reach >100 MB) and only bounded extracts are kept. Passwords and keys are redacted best effort.
const fs = require('fs');
const os = require('os');
const path = require('path');
const CH = require('./claudeHome');

const DIR_NAME = 'agent-view-handoff';
const KEEP_MS = 7 * 24 * 3600e3;            // own hand-off files older than this are removed on the next write
const RECENT_MS = 24 * 3600e3;              // sessions whose process ended but whose transcript is newer than this are offered too
const MAX_LINE = 64 * 1024 * 1024;          // a single transcript line larger than this is skipped
const MAX_SESSIONS = 20;
const HEAD_BYTES = 256 * 1024, TAIL_BYTES = 192 * 1024;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIM = { prompt: 600, lastPrompt: 3000, answer: 4000, summary: 8000, cmd: 220, target: 160, raw: 200000, headPrompts: 5, tailPrompts: 40, lastFull: 3, files: 150, cmds: 25, agents: 10, texts: 2 };

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const one = s => String(s).replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- redaction (best effort, linear patterns)
const SECRETS = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, 'sk-ant-[entfernt]'],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/g, '[GitHub-Token entfernt]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[AWS-Schlüssel entfernt]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[JWT entfernt]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [entfernt]'],
  [/((?:password|passwort|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|authorization)\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"'&;,]+)/gi, '$1[entfernt]'],
  [/(--?(?:password|passwd|token|secret|api-key|apikey)[= ])(\S+)/gi, '$1[entfernt]'],
];
function redact(text) {
  let s = typeof text === 'string' ? text.slice(0, LIM.raw) : '';
  for (const [re, to] of SECRETS) s = s.replace(re, to);
  return s;
}

// ---------------------------------------------------------------- text helpers
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const b of content) if (isObj(b) && b.type === 'text' && typeof b.text === 'string') out.push(b.text);
  return out.join('\n');
}

// Removes <tag ...>...</tag> blocks by index search (linear even for hostile input: a regex with a lazy middle is quadratic
// when many openers have no closer). An unterminated opener keeps the rest of the text as it is.
function stripBlocks(s, tag, replacement) {
  const open = '<' + tag, close = '</' + tag;
  let out = '', i = 0;
  for (;;) {
    const a = s.indexOf(open, i);
    if (a === -1) break;
    const b = s.indexOf(close, a + open.length);
    if (b === -1) break;
    out += s.slice(i, a) + replacement;
    const e = s.indexOf('>', b);
    i = e === -1 ? b + close.length : e + 1;
  }
  return out + s.slice(i);
}

// reminders and pasted blocks are harness plumbing, not what the person wrote
function cleanText(raw) {
  let s = typeof raw === 'string' ? raw.slice(0, LIM.raw) : '';
  s = stripBlocks(s, 'system-reminder', '');
  s = stripBlocks(s, 'pasted_content', '[eingefügter Text]');
  return s.trim();
}

const NOISE_PROMPT = /^(\[Request interrupted|<local-command-|<command-name>|<command-message>|Caveat: The messages below)/;
const COMPACT = /^This session is being continued from a previous conversation/;

function targetOf(name, input) {
  if (!isObj(input)) return '';
  for (const k of ['file_path', 'notebook_path', 'path', 'command', 'url', 'query', 'pattern', 'description', 'prompt']) {
    if (typeof input[k] === 'string' && input[k].trim()) return clip(one(redact(input[k])), LIM.target);
  }
  return '';
}

// ---------------------------------------------------------------- streaming line reader
function eachLine(file, onLine) {
  return new Promise((resolve, reject) => {
    let carry = '', skipping = false;
    const rs = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
    rs.on('data', chunk => {
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf('\n', start);
        if (nl === -1) {
          if (!skipping) { carry += chunk.slice(start); if (carry.length > MAX_LINE) { carry = ''; skipping = true; } }
          break;
        }
        if (skipping) skipping = false;
        else { const line = carry + chunk.slice(start, nl); carry = ''; if (line) onLine(line); }
        start = nl + 1;
      }
    });
    rs.on('end', () => { if (!skipping && carry) onLine(carry); resolve(); });
    rs.on('error', reject);
  });
}

// ---------------------------------------------------------------- the fold
function newAcc() {
  return {
    sessionId: null, cwd: null, branch: null, version: null, entrypoint: null, model: null, title: null, lastPrompt: null,
    firstTs: null, lastTs: null, ctxTokens: null, bad: 0, lines: 0,
    prompts: [], humanCount: 0, compact: null, summaries: [], texts: [], todos: null,
    files: new Map(), cmds: [], agents: [], agentCalls: 0, workflows: 0, toolCalls: 0, pending: new Map(), seenTool: new Set(),
  };
}

function foldLine(acc, line) {
  acc.lines++;
  let top = null;
  const m = /^\{"type":"([a-z-]+)"/.exec(line);
  if (m) {                                              // bookkeeping records start with "type"; only a few matter
    top = m[1];
    if (top !== 'custom-title' && top !== 'last-prompt' && top !== 'summary' && top !== 'user' && top !== 'assistant') return;
  } else {
    const head = line.slice(0, 600);
    if (head.includes('"attachment":{') || head.includes('"type":"system"')) return;
  }
  let o;
  try { o = JSON.parse(line); } catch (_) { acc.bad++; return; }
  if (!isObj(o)) return;
  if (o.type === 'custom-title') { if (typeof o.customTitle === 'string' && o.customTitle) acc.title = o.customTitle; return; }
  if (o.type === 'last-prompt') { if (typeof o.lastPrompt === 'string') acc.lastPrompt = o.lastPrompt; return; }
  if (o.type === 'summary') { if (typeof o.summary === 'string' && o.summary) { acc.summaries.push(clip(redact(o.summary), LIM.summary)); if (acc.summaries.length > 3) acc.summaries.shift(); } return; }
  if (o.isSidechain === true) return;
  if (o.type !== 'user' && o.type !== 'assistant') return;

  const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  if (Number.isFinite(ts)) { if (acc.firstTs === null || ts < acc.firstTs) acc.firstTs = ts; if (acc.lastTs === null || ts > acc.lastTs) acc.lastTs = ts; }
  if (typeof o.sessionId === 'string') acc.sessionId = o.sessionId;
  if (typeof o.cwd === 'string') acc.cwd = o.cwd;
  if (typeof o.gitBranch === 'string' && o.gitBranch) acc.branch = o.gitBranch;
  if (typeof o.version === 'string') acc.version = o.version;
  if (typeof o.entrypoint === 'string') acc.entrypoint = o.entrypoint;
  const msg = isObj(o.message) ? o.message : null;
  if (!msg) return;

  if (o.type === 'user') {
    if (Array.isArray(msg.content)) for (const b of msg.content) if (isObj(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string') acc.pending.delete(b.tool_use_id);
    const kind = typeof o.origin === 'string' ? o.origin : isObj(o.origin) ? o.origin.kind : null;
    const text = cleanText(textOf(msg.content));
    if (!text) return;
    if (COMPACT.test(text)) { acc.compact = clip(redact(text), LIM.summary); return; }
    if (o.isMeta === true || (kind && kind !== 'human' && kind !== 'user') || NOISE_PROMPT.test(text)) return;
    acc.humanCount++;
    acc.prompts.push({ ts: Number.isFinite(ts) ? ts : null, text: redact(text) });
    // bound memory on very long sessions: keep the head and the tail only
    if (acc.prompts.length > 400) acc.prompts.splice(LIM.headPrompts, acc.prompts.length - LIM.headPrompts - LIM.tailPrompts - LIM.lastFull);
    return;
  }

  // assistant
  if (typeof msg.model === 'string' && msg.model && msg.model !== '<synthetic>') acc.model = msg.model;
  if (isObj(msg.usage) && o.isApiErrorMessage !== true) {
    const u = msg.usage, n = x => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
    const ctx = n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
    if (ctx > 0) acc.ctxTokens = ctx;
  }
  if (!Array.isArray(msg.content)) return;
  for (const b of msg.content) {
    if (!isObj(b)) continue;
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() && o.isApiErrorMessage !== true) {
      acc.texts.push(clip(redact(b.text.trim()), LIM.answer));
      if (acc.texts.length > LIM.texts) acc.texts.shift();
    } else if (b.type === 'tool_use' && typeof b.id === 'string' && !acc.seenTool.has(b.id)) {
      if (acc.seenTool.size < 200000) acc.seenTool.add(b.id);
      const name = typeof b.name === 'string' ? b.name.slice(0, 64) : '?', input = isObj(b.input) ? b.input : {};
      acc.toolCalls++;
      acc.pending.set(b.id, { name, target: targetOf(name, input) });
      if (acc.pending.size > 500) acc.pending.delete(acc.pending.keys().next().value);
      if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') {
        const p = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : '';
        if (p && p.length < 1000) {
          const prev = acc.files.get(p) || { edits: 0, writes: 0, last: 0 };
          if (name === 'Write') prev.writes++; else prev.edits++;
          prev.last = Number.isFinite(ts) ? ts : prev.last;
          acc.files.delete(p); acc.files.set(p, prev);                     // most recently touched last
          if (acc.files.size > 2000) acc.files.delete(acc.files.keys().next().value);
        }
      } else if (name === 'Bash' || name === 'PowerShell') {
        if (typeof input.command === 'string') {
          acc.cmds.push({ name, cmd: clip(one(redact(input.command.slice(0, 2000))), LIM.cmd), why: typeof input.description === 'string' ? clip(one(redact(input.description)), 120) : '' });
          if (acc.cmds.length > LIM.cmds) acc.cmds.shift();
        }
      } else if (name === 'TodoWrite' && Array.isArray(input.todos)) {
        acc.todos = input.todos.filter(isObj).slice(0, 60).map(t => ({ text: clip(one(redact(String(t.content || t.activeForm || ''))), 200), status: typeof t.status === 'string' ? t.status : 'pending' }));
      } else if (name === 'Agent' || name === 'Task') {
        acc.agentCalls++;
        const d = typeof input.description === 'string' ? clip(one(redact(input.description)), 120) : '';
        if (d) { acc.agents.push(d); if (acc.agents.length > LIM.agents) acc.agents.shift(); }
      } else if (name === 'Workflow') {
        acc.workflows++;
      }
    }
  }
}

// ---------------------------------------------------------------- Markdown
const fmtTime = ms => (Number.isFinite(ms) ? new Date(ms).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : 'unbekannt');
const fmtTok = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' Mio.' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
const quote = s => s.split('\n').map(l => '> ' + l).join('\n');
const mdInline = s => String(s).replace(/`/g, "'");

function render(acc, info, now, transcript) {
  const i = info || {};
  const title = i.title || acc.title || (acc.prompts[0] ? clip(one(acc.prompts[0].text), 70) : '') || i.name || (acc.sessionId ? acc.sessionId.slice(0, 8) : 'Sitzung');
  const L = [];
  L.push('# Hand-Off: ' + mdInline(title), '');
  L.push('> Automatisch aus dem Sitzungsverlauf erstellt (Claude Code Utilities, ' + fmtTime(now) + '). Das ist ein **Auszug, keine Zusammenfassung durch Claude**: ' +
    'was gefragt wurde, wo die Sitzung stand, offene Aufgaben, bearbeitete Dateien und zuletzt ausgeführte Befehle. ' +
    'Passwörter und Schlüssel sind bestmöglich geschwärzt, eine Garantie ist das nicht. Die Datei liegt im Temp-Ordner und wird nach 7 Tagen entfernt.', '');

  L.push('## So machst du in einer neuen Sitzung weiter', '');
  L.push('1. Lies diese Datei vollständig.');
  L.push('2. Prüfe den Zustand der unten genannten Dateien (und `git status`), bevor du etwas änderst: seit dem Hand-Off kann sich etwas verändert haben.');
  L.push('3. Setze bei **Letzter Stand** und **Offene Aufgaben** fort. Frage nach, wenn der nächste Schritt nicht eindeutig ist.', '');

  L.push('## Sitzung', '');
  if (i.name && i.name !== title) L.push('- Name: ' + mdInline(i.name));
  L.push('- Arbeitsordner: `' + mdInline(acc.cwd || i.cwd || 'unbekannt') + '`');
  if (acc.branch) L.push('- Git-Zweig: `' + mdInline(acc.branch) + '`');
  L.push('- Modell: ' + (acc.model || 'unbekannt') + (acc.version ? ' · Claude Code ' + acc.version : '') + (acc.entrypoint ? ' · ' + acc.entrypoint : ''));
  L.push('- Beginn: ' + fmtTime(acc.firstTs) + ' · letzte Aktivität: ' + fmtTime(acc.lastTs));
  L.push('- Umfang: ' + acc.humanCount + ' Eingaben von dir, ' + acc.toolCalls + ' Werkzeugaufrufe' + (acc.ctxTokens ? ', Kontext zuletzt rund ' + fmtTok(acc.ctxTokens) + ' Tokens' : ''));
  if (acc.sessionId) L.push('- Sitzungs-ID: `' + acc.sessionId + '`');
  L.push('- Verlauf (Transkript): `' + mdInline(transcript) + '`', '');

  const last = acc.prompts.slice(-LIM.lastFull);
  if (last.length) {
    L.push('## Zuletzt gefragt', '');
    for (const p of last) L.push(quote(clip(p.text, LIM.lastPrompt)), '');
  }
  if (acc.texts.length) {
    L.push('## Letzter Stand (letzte Antwort von Claude)', '');
    L.push(quote(acc.texts[acc.texts.length - 1]), '');
  }
  if (acc.todos && acc.todos.length) {
    L.push('## Offene Aufgaben (letzte Aufgabenliste der Sitzung)', '');
    const mark = s => (s === 'completed' ? '[x]' : s === 'in_progress' ? '[~]' : '[ ]');
    for (const t of acc.todos) L.push('- ' + mark(t.status) + ' ' + mdInline(t.text));
    L.push('', '`[x]` erledigt, `[~]` in Arbeit, `[ ]` offen.', '');
  }
  const running = [...acc.pending.values()].slice(-5);
  if (running.length) {
    L.push('## Beim Hand-Off noch ohne Ergebnis', '', 'Diese Werkzeugaufrufe hatten kein Ergebnis im Verlauf (sie liefen noch oder die Sitzung wurde unterbrochen):', '');
    for (const r of running) L.push('- ' + mdInline(r.name) + (r.target ? ': ' + mdInline(r.target) : ''));
    L.push('');
  }
  if (acc.compact) {
    L.push('## Zusammenfassung früherer Teile (von Claude Code beim Verdichten erstellt)', '', quote(acc.compact), '');
  } else if (acc.summaries.length) {
    L.push('## Zusammenfassung früherer Teile (von Claude Code beim Verdichten erstellt)', '');
    for (const s of acc.summaries) L.push('- ' + mdInline(one(s)));
    L.push('');
  }

  if (acc.prompts.length) {
    L.push('## Verlauf deiner Aufträge', '');
    const all = acc.prompts;
    const head = LIM.headPrompts, tail = LIM.tailPrompts;
    const show = all.length > head + tail ? [...all.slice(0, head), null, ...all.slice(-tail)] : all;
    let n = 0;
    for (const p of show) {
      if (p === null) { L.push('- … ' + (all.length - head - tail) + ' weitere Eingaben ausgelassen …'); continue; }
      n++;
      L.push('- ' + (p.ts ? fmtTime(p.ts) + ': ' : '') + mdInline(clip(one(p.text), LIM.prompt)));
    }
    void n;
    L.push('');
  }

  if (acc.files.size) {
    L.push('## Bearbeitete oder angelegte Dateien', '');
    const list = [...acc.files.entries()].reverse().slice(0, LIM.files);
    for (const [p, v] of list) L.push('- `' + mdInline(p) + '` (' + [v.writes ? v.writes + 'x angelegt/überschrieben' : '', v.edits ? v.edits + 'x geändert' : ''].filter(Boolean).join(', ') + ')');
    if (acc.files.size > LIM.files) L.push('- … und ' + (acc.files.size - LIM.files) + ' ältere');
    L.push('');
  }
  if (acc.cmds.length) {
    L.push('## Zuletzt ausgeführte Befehle', '');
    for (const c of acc.cmds.slice().reverse()) L.push('- `' + mdInline(c.cmd) + '`' + (c.why ? ' – ' + mdInline(c.why) : ''));
    L.push('');
  }
  if (acc.agentCalls || acc.workflows) {
    L.push('## Agenten und Workflows dieser Sitzung', '', '- Agent-Aufrufe: ' + acc.agentCalls + ', Workflows: ' + acc.workflows);
    for (const a of acc.agents.slice().reverse()) L.push('- zuletzt: ' + mdInline(a));
    L.push('');
  }
  return L.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** Streams the transcript and returns { markdown, stats }. Rejects only when the file cannot be read at all. */
async function buildHandoff(file, opts) {
  const o = opts || {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const acc = newAcc();
  const t0 = Date.now();
  await eachLine(file, line => foldLine(acc, line));
  const markdown = render(acc, o.info, now, file);
  return { markdown, stats: { lines: acc.lines, prompts: acc.humanCount, toolCalls: acc.toolCalls, files: acc.files.size, bad: acc.bad, bytes: Buffer.byteLength(markdown), ms: Date.now() - t0 } };
}

// ---------------------------------------------------------------- files
const handoffDir = () => path.join(os.tmpdir(), DIR_NAME);
const FILE_RE = /^handoff-[0-9a-f]{8}-\d{8}T\d{6}\.md$/;

function writeHandoff(markdown, sid, now) {
  const dir = handoffDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!FILE_RE.test(name)) continue;                      // only files this module wrote
      const f = path.join(dir, name);
      try { if (now - fs.statSync(f).mtimeMs > KEEP_MS) fs.unlinkSync(f); } catch (_) { /* in use or gone */ }
    }
  } catch (_) { /* pruning is a courtesy */ }
  const id = String(sid || '').replace(/[^0-9a-f]/gi, '').slice(0, 8).padEnd(8, '0').toLowerCase();
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15);
  const file = path.join(dir, 'handoff-' + id + '-' + stamp + '.md');
  fs.writeFileSync(file, markdown, { mode: 0o600 });
  return file;
}

// ---------------------------------------------------------------- finding the session
function findTranscript(claudeHome, sid) {
  if (typeof sid !== 'string' || !GUID.test(sid)) return null;
  const projects = path.join(String(claudeHome || ''), 'projects');
  let names = [];
  try { names = fs.readdirSync(projects); } catch (_) { return null; }
  for (const n of names) {
    const f = path.join(projects, n, sid + '.jsonl');
    try { if (fs.statSync(f).isFile()) return f; } catch (_) { /* next */ }
  }
  return null;
}

function readSlice(file, start, len) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8', 0, n);
  } catch (_) { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
}

/** A short title: the session's custom title (last record near the end) or the first thing the person asked. */
function peekTitle(file) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch (_) { return ''; }
  const tail = readSlice(file, Math.max(0, size - TAIL_BYTES), TAIL_BYTES);
  let title = '';
  const re = /"type":"custom-title","customTitle":"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(tail))) { try { title = JSON.parse('"' + m[1] + '"'); } catch (_) { /* keep the previous one */ } }
  if (title) return clip(one(title), 70);
  const head = readSlice(file, 0, HEAD_BYTES);
  for (const line of head.split('\n').slice(0, 400)) {
    if (!line.includes('"type":"user"')) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    if (!isObj(o) || o.type !== 'user' || o.isMeta === true || !isObj(o.message)) continue;
    const kind = typeof o.origin === 'string' ? o.origin : isObj(o.origin) ? o.origin.kind : null;
    if (kind && kind !== 'human' && kind !== 'user') continue;
    const t = cleanText(textOf(o.message.content));
    if (t && !NOISE_PROMPT.test(t) && !COMPACT.test(t)) return clip(one(redact(t)), 70);
  }
  return '';
}

/**
 * Sessions the person may mean: live sessions of this workspace (registry), plus sessions of the workspace's project folders whose
 * transcript is newer than 24 h. Falls back to all of them when the workspace matches none. Newest first.
 */
function listSessions(claudeHome, folders, now) {
  const fl = Array.isArray(folders) ? folders.filter(f => typeof f === 'string' && f) : [];
  let reg = [];
  try { reg = CH.readRegistry(claudeHome); } catch (_) { reg = []; }
  const projects = path.join(String(claudeHome || ''), 'projects');
  const collect = (filter) => {
    const map = new Map();
    for (const r of reg) {
      if (!r || !r.alive || typeof r.sessionId !== 'string' || !GUID.test(r.sessionId)) continue;
      if (filter && !fl.some(f => CH.cwdInside(r.cwd, f))) continue;
      map.set(r.sessionId.toLowerCase(), { sid: r.sessionId, name: r.name || null, status: r.status || null, cwd: r.cwd || null, entrypoint: r.entrypoint || null, alive: true, activeAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0 });
    }
    let dirs = [];
    if (filter) for (const f of fl) { try { dirs.push(...CH.findProjectDirs(projects, f)); } catch (_) { /* skip */ } }
    else { try { dirs = fs.readdirSync(projects).map(n => path.join(projects, n)); } catch (_) { dirs = []; } }
    for (const d of [...new Set(dirs)]) {
      let names = []; try { names = fs.readdirSync(d); } catch (_) { continue; }
      for (const n of names) {
        const m = /^([0-9a-f-]{36})\.jsonl$/i.exec(n);
        if (!m || !GUID.test(m[1])) continue;
        let st; try { st = fs.statSync(path.join(d, n)); } catch (_) { continue; }
        if (!st.isFile()) continue;
        const key = m[1].toLowerCase(), prev = map.get(key);
        if (prev) { prev.activeAt = Math.max(prev.activeAt, st.mtimeMs); continue; }
        if (now - st.mtimeMs < RECENT_MS) map.set(key, { sid: m[1], name: null, status: null, cwd: null, entrypoint: null, alive: false, activeAt: st.mtimeMs });
      }
    }
    return [...map.values()];
  };
  let items = fl.length ? collect(true) : [];
  if (!items.length) items = collect(false);
  const out = [];
  for (const it of items) {
    const transcript = findTranscript(claudeHome, it.sid);
    if (!transcript) continue;
    try { it.activeAt = Math.max(it.activeAt, fs.statSync(transcript).mtimeMs); } catch (_) { /* keep */ }
    it.transcript = transcript;
    out.push(it);
  }
  out.sort((a, b) => b.activeAt - a.activeAt);
  const top = out.slice(0, MAX_SESSIONS);
  for (const it of top) it.title = peekTitle(it.transcript);
  return top;
}

module.exports = { buildHandoff, writeHandoff, listSessions, findTranscript, peekTitle, redact, cleanText, handoffDir, foldLine, newAcc, render, eachLine, FILE_RE };
