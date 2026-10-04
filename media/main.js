'use strict';
// Claude Code Utilities: webview script (SPEC 8). Runs under the CSP of SPEC 8.3: no inline script or style attribute, all
// file-derived text goes through textContent. The pure helpers are exported at the bottom for test/webview.test.js;
// the DOM part boots only inside a real webview (acquireVsCodeApi present).
(function () {
  const T = Object.freeze({
    running: 'Läuft', recent: 'Zuletzt fertig', phases: 'Phasen', noPhase: 'Agenten', dash: '–',
    colAgent: 'Agent', colModel: 'Modell', colTokens: 'Tokens', colTime: 'Zeit',
    workflow: 'Workflow', agent: 'Agent', background: 'Hintergrund', foreground: 'Vordergrund', tool: 'Werkzeug',
    agentOne: 'Agent', agentMany: 'Agenten', toolOne: 'Tool', toolMany: 'Tools', tokens: 'Tokens',
    agentsDone: 'Agenten fertig', failedCount: 'fehlgeschlagen', phaseOf: 'Phase', phaseDone: 'fertig', of: 'von', noAgentsYet: 'Noch keine Agenten gestartet.',
    pillRunning: 'läuft', pillDone: 'fertig', pillFailed: 'Fehler', pillInterrupted: 'abgebrochen',
    pillStopped: 'gestoppt', pillWaiting: 'wartet',
    attempt: 'Versuch', cached: 'aus Cache', rest: 'Rest', restRough: 'Rest grob:',
    limit: 'Sitzungslimit erreicht', resets: 'Reset', failedPrefix: 'Fehler:', unknownError: 'unbekannt', status: 'Status',
    thinking: 'denkt nach …', writing: 'schreibt …', waiting: 'wartet …', parallel: 'parallel',
    result: 'Ergebnis', loadingFile: 'Datei wird noch gelesen',
    emptyText: 'Keine laufenden Agenten.',
    source: 'Quelle', showFolder: 'Ordner öffnen', loading: 'Lade …',
    refresh: 'Aktualisieren', scopeWorkspace: 'Arbeitsbereich', scopeAll: 'Alle Sitzungen',
    renderError: 'Anzeigefehler: ',
    floating: 'In schwebendem Fenster öffnen',
    handoff: 'Hand-Off', handoffTip: 'Kontext der Sitzung in eine Markdown-Datei im Temp-Ordner schreiben',
    clear: 'Clear', clearTip: 'Aktuelle Unterhaltung beenden und eine neue starten (spart Tokens)',
    usage: 'Nutzung', usageBusy: 'wird aktualisiert …', usageFive: '5-Stunden-Limit', usageWeek: 'Wochenlimit', usedUp: 'verbraucht',
    resetWord: 'Reset', resetDone: 'zurückgesetzt', resetUnknown: 'Reset-Zeit unbekannt',
    resetNext: 'neuer Stand folgt', today: 'heute', tomorrow: 'morgen', oClock: 'Uhr', asOf: 'Stand',
    expiredTip: 'Das Limit-Fenster ist inzwischen zurückgesetzt worden. Claude Code hat seitdem keinen neuen Stand gespeichert.',
    staleTip: (when) => 'Claude Code hat die Nutzung zuletzt ' + when + ' abgefragt. Der Wert kann veraltet sein.',
    more: (n) => '+' + n + ' weitere',
    hidden: (n) => n + ' ' + (n === 1 ? 'Agent' : 'Agenten') + ' ausgeblendet',
    quiet: (n) => 'ruhig seit ' + n + ' Min.',
    unknownFormat: (v) => 'Unbekanntes Datenformat (v' + v + '): die Anzeige kann unvollständig sein.',
    ago: (ms) => {
      const m = Math.floor(ms / 60000);
      if (m < 1) return 'gerade eben';
      if (m < 60) return 'vor ' + m + ' Min.';
      const h = Math.floor(m / 60);
      return h < 24 ? 'vor ' + h + ' Std.' : 'vor ' + Math.floor(h / 24) + ' Tg.';
    },
  });

  const QUIET_SEC = 600; // SPEC 8.1: "ruhig seit N Min." only above 10 minutes of silence
  const KEY = 'key'; // ViewState card key, read via bracket access (see normCard)

  // ---- pure helpers ----
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  const num = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d === undefined ? 0 : d);
  const numOrNull = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const str = (x, d) => (typeof x === 'string' ? x : d === undefined ? '' : d);
  const arr = (x) => (Array.isArray(x) ? x : []);
  const isLive = (state) => state === 'running' || state === 'waiting';
  const plural = (n, one, many) => (n === 1 ? one : many);
  const clip = (s, n) => {
    s = String(s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };

  function fmtTokens(n) {
    n = Math.max(0, num(n));
    if (n < 999.5) return String(Math.round(n));
    if (n < 999950) return (n / 1e3).toFixed(1) + 'k';
    return (n / 1e6).toFixed(1) + 'M';
  }

  function fmtDur(ms) {
    const s = Math.floor(Math.max(0, num(ms)) / 1000);
    const p2 = (x) => String(x).padStart(2, '0');
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? h + ':' + p2(m) + ':' + p2(s % 60) : p2(m) + ':' + p2(s % 60);
  }

  // Copy of the lib/format.js rule: the host normally sends model.label already, this is only the fallback.
  function prettyModel(id) {
    const s = typeof id === 'string' ? id.trim() : '';
    if (!s || s === '<synthetic>') return null;
    const big = /\[1m\]$/i.test(s);
    const base = s.replace(/\[1m\]$/i, '');
    let m = /^claude-([a-z]+)((?:-\d{1,2})*)(?:-\d{8})?$/i.exec(base); // claude-<family>-<major>[-<minor>][-<date>]
    let fam, ver;
    if (m) { fam = m[1]; ver = m[2].split('-').filter(Boolean).join('.'); }
    else {
      m = /^claude-(\d{1,2}(?:-\d{1,2})?)-([a-z]+)(?:-\d{8})?$/i.exec(base); // legacy: claude-<major>[-<minor>]-<family>
      if (!m) return s;
      fam = m[2]; ver = m[1].split('-').join('.');
    }
    return fam[0].toUpperCase() + fam.slice(1).toLowerCase() + (ver ? ' ' + ver : '') + (big ? ' (1M)' : '');
  }

  const modelLabel = (a) => (a && a.model && (a.model.label || prettyModel(a.model.id))) || '';

  // Host and webview clocks normally agree; a remote window may not. Differences below 5 s are treated as zero so
  // the ticking elapsed time never jitters by message latency.
  function computeSkew(hostNow, localNow) {
    if (typeof hostNow !== 'number' || !Number.isFinite(hostNow)) return 0;
    const d = hostNow - localNow;
    return Math.abs(d) < 5000 ? 0 : d;
  }

  function elapsedMs(live, startedAt, endedAt, durationMs, now) {
    if (live) return typeof startedAt === 'number' ? Math.max(0, now - startedAt) : null;
    if (typeof durationMs === 'number') return durationMs;
    if (typeof startedAt === 'number' && typeof endedAt === 'number') return Math.max(0, endedAt - startedAt);
    return null;
  }

  function elapsedText(live, startedAt, endedAt, durationMs, now) {
    const ms = elapsedMs(live, startedAt, endedAt, durationMs, now);
    return ms === null ? T.dash : fmtDur(ms);
  }

  function failureText(f) {
    if (!isObj(f)) return T.pillFailed;
    const text = str(f.text).replace(/\s+/g, ' ').trim();
    // finished runs come from result files, which carry no status code: the limit is then recognised by error id or text
    const limit = f.status === 429 || /^rate[_ -]?limit/i.test(str(f.error)) || /\b(?:session|usage|rate)\s+limit\b/i.test(text);
    if (limit) {
      const m = /resets?\s+(.+?)\s*$/i.exec(text);
      return T.limit + (m ? ' – ' + T.resets + ' ' + clip(m[1], 60) : '');
    }
    const body = text || str(f.error) || (f.status ? T.status + ' ' + f.status : T.unknownError);
    return T.failedPrefix + ' ' + clip(body, 120);
  }

  function activityText(act) {
    if (!isObj(act)) return '';
    if (act.kind === 'thinking') return T.thinking;
    if (act.kind === 'writing') return T.writing;
    if (act.kind === 'waiting') return T.waiting;
    if (act.kind !== 'tool') return '';
    let s = str(act.tool) || T.tool;
    if (act.target) s += ' · ' + clip(act.target, 200);
    if (num(act.parallel) > 1) s += ' (' + act.parallel + ' ' + T.parallel + ')';
    return s;
  }

  const KNOWN_STATES = ['running', 'waiting', 'done', 'failed', 'interrupted', 'stopped'];
  const dotState = (a) => (isObj(a) && KNOWN_STATES.includes(a.state) ? a.state : 'pending');

  const isQuiet = (a) => isLive(a.state) && num(a.quietSec) > QUIET_SEC;

  function pillForAgent(a) {
    const s = isObj(a) ? a.state : null;
    if (isObj(a) && isQuiet(a)) return { cls: 'warn', text: T.quiet(Math.floor(num(a.quietSec) / 60)) };
    switch (s) {
      case 'running': return { cls: 'run', text: T.pillRunning };
      case 'waiting': return { cls: 'wait', text: T.pillWaiting };
      case 'done': return { cls: 'ok', text: T.pillDone };
      case 'failed': return { cls: 'err', text: T.pillFailed };
      case 'interrupted': return { cls: 'mute', text: T.pillInterrupted };
      case 'stopped': return { cls: 'mute', text: T.pillStopped };
      default: return { cls: 'mute', text: str(s) || T.dash };
    }
  }

  function allAgents(c) {
    return c.kind === 'workflow' ? arr(c.phases).flatMap((p) => arr(p.agents)) : isObj(c.agent) ? [c.agent] : [];
  }

  // A run is "quiet" only when every live agent has been silent for more than 10 minutes.
  function runQuietSec(c) {
    const live = allAgents(c).filter((a) => isLive(a.state));
    return live.length ? Math.min(...live.map((a) => num(a.quietSec))) : 0;
  }

  function pillForRun(c) {
    switch (c.status) {
      case 'running': {
        const q = runQuietSec(c);
        return q > QUIET_SEC ? { cls: 'warn', text: T.quiet(Math.floor(q / 60)) } : { cls: 'run', text: T.pillRunning };
      }
      case 'completed': return { cls: 'ok', text: T.pillDone };
      case 'killed': return { cls: 'mute', text: T.pillInterrupted };
      case 'stopped': return { cls: 'mute', text: T.pillStopped };
      default: return { cls: 'mute', text: str(c.status) || T.dash }; // unknown status: verbatim, neutral colour
    }
  }

  // Row-level state chip (the dot already shows done/running): waiting, quiet, failure detail, interrupted, stopped.
  function stateChip(a) {
    if (a.state === 'failed') return { cls: 'err', text: failureText(a.failure), tip: str(a.failure && a.failure.text) };
    if (isQuiet(a)) return { cls: 'warn', text: T.quiet(Math.floor(num(a.quietSec) / 60)) };
    if (a.state === 'waiting') return { cls: 'wait', text: T.pillWaiting };
    if (a.state === 'interrupted') return { cls: 'mute', text: T.pillInterrupted };
    if (a.state === 'stopped') return { cls: 'mute', text: T.pillStopped };
    return null;
  }

  // SPEC 6.5 honesty labels. level 'run' = workflow chip, 'agent' = per agent chip.
  function etaView(eta, level) {
    if (!isObj(eta) || eta.kind === 'none') return null;
    const text = str(eta.text);
    if (!text) return null;
    let cls = eta.kind === 'number' || eta.kind === 'range' || eta.kind === 'late' ? eta.kind : 'unknown';
    if (cls === 'unknown' && /keine\s+aktivit/i.test(text)) cls = 'stale';
    let label = text;
    if ((cls === 'number' || cls === 'range') && !/^rest/i.test(text)) {
      label = (level === 'run' && cls === 'range' ? T.restRough : T.rest) + ' ' + text;
    }
    return { cls, text: label, tip: str(eta.tip) };
  }

  function phaseSummary(phases) {
    const list = arr(phases);
    const n = list.length;
    const run = list.findIndex((p) => p.state === 'running');
    return { k: run >= 0 ? run + 1 : list.filter((p) => p.state === 'done').length, n };
  }

  const phaseDefaultOpen = (p) => p.state === 'running' || p.state === 'partial';

  // What a phase says when its list shows fewer agents than it counts: none started yet, or the host left them out (the
  // per-phase limit, or the size limit of the view state shedding the oldest cards).
  function phaseNote(ph) {
    const total = num(ph.total);
    const shown = arr(ph.agents).length;
    if (shown === 0) return total > 0 ? T.hidden(total) : T.noAgentsYet;
    return total > shown ? T.more(total - shown) : '';
  }

  function wfStatText(c) {
    const total = num(c.agentsTotal);
    const done = num(c.agentsDone);
    const tools = num(c.toolUses);
    return [
      c.status === 'running' && total > 0 && done < total
        ? done + '/' + total + ' ' + T.agentsDone
        : total + ' ' + plural(total, T.agentOne, T.agentMany),
      fmtTokens(c.tokens) + ' ' + T.tokens,
      tools + ' ' + plural(tools, T.toolOne, T.toolMany),
    ].join(' · ');
  }

  function agentStatText(a) {
    const parts = [];
    const m = modelLabel(a);
    if (m) parts.push(m);
    if (!a.cached) {
      parts.push(fmtTokens(a.tokens) + ' ' + T.tokens);
      const tools = num(a.toolUses);
      parts.push(tools + ' ' + plural(tools, T.toolOne, T.toolMany));
    }
    return parts.join(' · ');
  }

  const sessionText = (c) => str(c.sessionTitle) + (c.origin ? ' (' + c.origin + ')' : '');

  // ---- usage (5-hour / weekly limit): numbers come from Claude Code's own cache, so the age travels with them ----
  const USAGE_STALE_MS = 30 * 60e3;
  const SEV_RANK = { normal: 0, warning: 1, critical: 2 };

  function normalizeUsage(u) {
    if (!isObj(u)) return null;
    const windows = arr(u.windows).filter(isObj).slice(0, 8).map((w) => ({
      id: str(w.id).slice(0, 80), label: str(w.label).slice(0, 80),
      percent: Math.min(100, Math.max(0, num(w.percent))), resetsAt: numOrNull(w.resetsAt),
      severity: w.severity === 'normal' || w.severity === 'warning' || w.severity === 'critical' ? w.severity : null,
    })).filter((w) => w.id);
    return windows.length ? { fetchedAt: numOrNull(u.fetchedAt), windows } : null;
  }

  const usageLabel = (w) => (w.id === 'five_hour' ? T.usageFive : w.id === 'weekly' ? T.usageWeek : w.label || w.id);

  function fmtUntil(ms) {
    const m = Math.floor(Math.max(0, num(ms)) / 60000);
    if (m < 1) return 'in weniger als 1 Min.';
    const d = Math.floor(m / 1440);
    const hh = Math.floor((m % 1440) / 60);
    if (d > 0) return 'in ' + d + ' Tg ' + hh + ' Std';
    if (hh > 0) return 'in ' + hh + ' Std ' + (m % 60) + ' Min';
    return 'in ' + m + ' Min';
  }

  // Local clock text of a reset time ("heute, 09:20 Uhr", "morgen, 03:00 Uhr", "Fr., 09.10., 11:59 Uhr"); tz only for tests.
  function fmtClock(ms, nowMs, tz, short) {
    const o = tz ? { timeZone: tz } : {};
    const fmt = (opts, t) => new Intl.DateTimeFormat('de-DE', Object.assign({}, opts, o)).format(t);
    const day = (t) => fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }, t);
    const time = fmt({ hour: '2-digit', minute: '2-digit', hour12: false }, ms);
    let prefix;
    if (day(ms) === day(nowMs)) prefix = T.today;
    else if (day(ms) === day(nowMs + 86400e3)) prefix = T.tomorrow;
    else prefix = fmt({ weekday: 'short', day: '2-digit', month: '2-digit' }, ms);
    return short ? prefix + ' ' + time : prefix + ', ' + time + ' ' + T.oClock;
  }

  // One row of the usage block. A window whose reset time has passed no longer says how full it is: show that instead of a stale number.
  function usageRowView(w, nowMs, tz) {
    if (w.resetsAt !== null && nowMs >= w.resetsAt) {
      return { pct: null, pctText: T.dash, sev: 'expired', resetText: T.resetDone + ' ' + fmtClock(w.resetsAt, nowMs, tz, true) + ' · ' + T.resetNext, tip: T.expiredTip };
    }
    const derived = w.percent >= 90 ? 'critical' : w.percent >= 75 ? 'warning' : 'normal';
    const sev = w.severity && SEV_RANK[w.severity] > SEV_RANK[derived] ? w.severity : derived; // never calmer than the percentage says
    const resetText = w.resetsAt === null ? T.resetUnknown : T.resetWord + ' ' + fmtClock(w.resetsAt, nowMs, tz, true) + ' · noch ' + fmtUntil(w.resetsAt - nowMs).replace(/^in /, '');
    return { pct: w.percent, pctText: w.percent + ' %', sev, resetText, tip: w.percent + ' % ' + T.usedUp };
  }

  function usageAge(u, nowMs) {
    if (!u || u.fetchedAt === null) return null;
    const ms = Math.max(0, nowMs - u.fetchedAt);
    const when = T.ago(ms);
    const stale = ms > USAGE_STALE_MS;
    return { text: T.asOf + ' ' + when, stale, tip: stale ? T.staleTip(when) : null };
  }

  // ---- keyed reconciliation (pure plan, DOM applier below) -----------------------------------------------------
  function uniqueKeys(keys) {
    const seen = new Map();
    return keys.map((k) => {
      k = String(k);
      const n = (seen.get(k) || 0) + 1;
      seen.set(k, n);
      return n === 1 ? k : k + '#' + n;
    });
  }

  // Longest strictly increasing subsequence (indices): those items keep their DOM position.
  function lisIndices(seq) {
    const n = seq.length;
    const len = new Array(n).fill(1);
    const prev = new Array(n).fill(-1);
    let best = -1;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < i; j++) if (seq[j] < seq[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
      if (best < 0 || len[i] > len[best]) best = i;
    }
    const out = new Set();
    for (let i = best; i >= 0; i = prev[i]) out.add(i);
    return out;
  }

  // ops: {op:'remove',k} first, then (processed from the end of newKeys) {op:'insert'|'move', k, before:key|null}.
  function planReconcile(oldKeys, newKeys) {
    const pos = new Map(oldKeys.map((k, i) => [k, i]));
    const want = new Set(newKeys);
    const ops = oldKeys.filter((k) => !want.has(k)).map((k) => ({ op: 'remove', k }));
    const common = newKeys.filter((k) => pos.has(k));
    const lis = lisIndices(common.map((k) => pos.get(k)));
    const stay = new Set(common.filter((k, i) => lis.has(i)));
    for (let i = newKeys.length - 1; i >= 0; i--) {
      const k = newKeys[i];
      const before = i + 1 < newKeys.length ? newKeys[i + 1] : null;
      if (!pos.has(k)) ops.push({ op: 'insert', k, before });
      else if (!stay.has(k)) ops.push({ op: 'move', k, before });
    }
    return ops;
  }

  // ---- state normalisation: render never throws on host garbage ------------------------------------------------
  function normAgent(a, i) {
    if (!isObj(a)) return null;
    const m = isObj(a.model) ? a.model : {};
    return {
      id: str(a.id) || '#' + i, label: str(a.label) || str(a.id) || T.dash, phase: typeof a.phase === 'string' ? a.phase : null,
      kind: a.kind === 'task' ? 'task' : 'wf', agentType: typeof a.agentType === 'string' ? a.agentType : null,
      shape: a.shape === 'background' || a.shape === 'foreground' ? a.shape : null,
      model: { id: typeof m.id === 'string' ? m.id : null, label: typeof m.label === 'string' ? m.label : null },
      state: str(a.state), quietSec: num(a.quietSec), tokens: num(a.tokens), toolUses: num(a.toolUses),
      startedAt: numOrNull(a.startedAt), endedAt: numOrNull(a.endedAt), durationMs: numOrNull(a.durationMs),
      attempt: Math.max(1, num(a.attempt, 1)), cached: a.cached === true, loading: a.loading === true,
      activity: isObj(a.activity) ? a.activity : null, failure: isObj(a.failure) ? a.failure : null,
      resultPreview: typeof a.resultPreview === 'string' && a.resultPreview ? a.resultPreview : null,
      eta: isObj(a.eta) ? a.eta : null,
    };
  }

  function normPhase(p) {
    if (!isObj(p)) return null;
    const agents = arr(p.agents).map(normAgent).filter(Boolean);
    return {
      title: str(p.title), detail: typeof p.detail === 'string' ? p.detail : null, state: str(p.state, 'pending'),
      done: num(p.done), failed: num(p.failed), total: num(p.total, agents.length), agents,
    };
  }

  function normCard(c, i) {
    if (!isObj(c)) return null;
    const base = {
      [KEY]: str(c[KEY]) || str(c.runId) || '#' + i, sessionTitle: str(c.sessionTitle),
      origin: typeof c.origin === 'string' ? c.origin : null,
    };
    if (c.kind === 'workflow') {
      return Object.assign(base, {
        kind: 'workflow', runId: str(c.runId), name: str(c.name), description: typeof c.description === 'string' ? c.description : null,
        status: str(c.status), startedAt: numOrNull(c.startedAt), endedAt: numOrNull(c.endedAt), durationMs: numOrNull(c.durationMs),
        agentsTotal: num(c.agentsTotal), agentsDone: num(c.agentsDone), agentsFailed: num(c.agentsFailed),
        tokens: num(c.tokens), toolUses: num(c.toolUses), phases: arr(c.phases).map(normPhase).filter(Boolean),
        eta: isObj(c.eta) ? c.eta : null,
      });
    }
    const agent = c.kind === 'agent' ? normAgent(c.agent, 0) : null;
    return agent ? Object.assign(base, { kind: 'agent', agent }) : null;
  }

  function normalizeState(s) {
    if (!isObj(s)) return null;
    const cards = (list) => arr(list).map(normCard).filter(Boolean);
    return {
      v: s.v, now: num(s.now), scope: s.scope === 'all' ? 'all' : 'workspace', scopeLabel: str(s.scopeLabel),
      claudeHome: str(s.claudeHome), running: cards(s.running), recent: cards(s.recent),
      warnings: arr(s.warnings).filter((w) => typeof w === 'string' && w).slice(0, 8),
      formatNote: typeof s.formatNote === 'string' && s.formatNote ? s.formatNote : null,
      usage: normalizeUsage(s.usage),
    };
  }

  // ---- UI state kept in vscode.setState: explicit user toggles only (id -> boolean) ---------------------------
  // ids: 's:recent' (section), 'c:<key>' (compact card), 'p:<key>|<phase>' (phase), 'r:<key>' (result preview)
  function normalizeUi(u) {
    const out = { open: {} };
    if (!isObj(u) || !isObj(u.open)) return out;
    let n = 0;
    for (const [id, v] of Object.entries(u.open)) {
      if (typeof v !== 'boolean' || id === '__proto__' || id.length > 300 || n >= 500) continue;
      out.open[id] = v;
      n++;
    }
    return out;
  }

  const isOpen = (ui, id, dflt) => (Object.prototype.hasOwnProperty.call(ui.open, id) && typeof ui.open[id] === 'boolean' ? ui.open[id] : dflt);
  const setOpen = (ui, id, v) => ({ open: Object.assign({}, ui.open, { [id]: v }) });

  function collectIds(view) {
    const ids = new Set(['s:recent']);
    for (const list of [view.running, view.recent]) {
      const keys = uniqueKeys(list.map((c) => c[KEY]));
      list.forEach((c, i) => {
        ids.add('c:' + keys[i]);
        ids.add('r:' + keys[i]);
        if (c.kind === 'workflow') uniqueKeys(c.phases.map((p) => p.title)).forEach((pk) => ids.add('p:' + keys[i] + '|' + pk));
      });
    }
    return ids;
  }

  function pruneUi(ui, ids) {
    const kept = Object.entries(ui.open).filter(([id]) => ids.has(id));
    return kept.length === Object.entries(ui.open).length ? ui : { open: Object.fromEntries(kept) };
  }

  // ---- DOM (webview only) ----
  function h(tag, cls, text, attrs) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text; // textContent only: everything shown here is file-derived
    if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }
  const btn = (cls, text, attrs) => h('button', cls, text, Object.assign({ type: 'button' }, attrs));
  const chev = () => h('span', 'chev', undefined, { 'aria-hidden': 'true' });
  const cell = (cls, role) => h('span', cls, undefined, { role: role || 'cell' });
  const setText = (e, s) => { if (e._t !== s) { e._t = s; e.textContent = s; } };
  const setCls = (e, c) => { if (e._c !== c) { e._c = c; e.className = c; } };
  const setHidden = (e, v) => { if (e.hidden !== v) e.hidden = v; };
  function setAttr(e, name, v) {
    const k = '_a' + name;
    if (e[k] === v) return;
    e[k] = v;
    if (v === null || v === '' || v === undefined) e.removeAttribute(name); else e.setAttribute(name, v);
  }

  class KeyedList {
    constructor(parent) { this.parent = parent; this.items = new Map(); this.order = []; }
    // entries: [{k, data}] with unique k. create(k, data) -> item {el}; update(item, data); sigOf(data) -> identity.
    sync(entries, create, update, sigOf) {
      const keys = entries.map((e) => e.k);
      const byKey = new Map(entries.map((e) => [e.k, e]));
      if (sigOf) {
        for (const e of entries) {
          const it = this.items.get(e.k);
          if (it && it.sig !== sigOf(e.data)) { it.el.remove(); this.items.delete(e.k); this.order = this.order.filter((x) => x !== e.k); }
        }
      }
      for (const op of planReconcile(this.order, keys)) {
        if (op.op === 'remove') {
          const gone = this.items.get(op.k);
          if (gone) gone.el.remove();
          this.items.delete(op.k);
          continue;
        }
        let it = this.items.get(op.k);
        if (!it) {
          const data = byKey.get(op.k).data;
          it = create(op.k, data);
          it.sig = sigOf ? sigOf(data) : null;
          this.items.set(op.k, it);
        }
        this.parent.insertBefore(it.el, op.before === null ? null : this.items.get(op.before).el);
      }
      this.order = keys;
      for (const e of entries) update(this.items.get(e.k), e.data);
    }
  }

  function boot() {
    const vscode = acquireVsCodeApi(); // once per document
    const app = document.getElementById('app');
    let saved = null;
    try { saved = vscode.getState(); } catch (e) { saved = null; }
    let ui = normalizeUi(saved && saved.ui);
    let last = saved && isObj(saved.last) ? saved.last : null; // {seq, state}: the raw message payload
    let view = last ? normalizeState(last.state) : null;
    let skew = 0;
    let usageBusy = false; // the host is running /usage right now
    let ticks = [];
    const nowMs = () => Date.now() + skew;
    const post = (m) => { try { vscode.postMessage(m); } catch (e) { /* host gone */ } };
    const save = () => { try { vscode.setState({ v: 1, last, ui }); } catch (e) { /* state is a convenience */ } };

    // ---- static shell ----
    const scopeLabel = h('span', 'scope-label');
    const scopeBtn = btn('link-btn', undefined, { 'data-act': 'scope' });
    const bar = h('div', 'toolbar');
    const floatBtn = btn('icon-btn', undefined, { 'data-act': 'floating', 'aria-label': T.floating, title: T.floating });
    floatBtn.append(h('span', 'ico-float', undefined, { 'aria-hidden': 'true' }));
    floatBtn.hidden = app.getAttribute('data-mode') === 'floating'; // already floating
    bar.append(scopeLabel, scopeBtn, floatBtn, btn('icon-btn', '↻', { 'data-act': 'refresh', 'aria-label': T.refresh, title: T.refresh }));
    const usageAgeEl = h('span', 'usage-age');
    const usageRows = h('div', 'usage-rows');
    const usageSec = h('section', 'usage', undefined, { 'aria-label': T.usage });
    usageSec.append(usageRows);
    usageSec.hidden = true;
    const usageList = new KeyedList(usageRows);
    const actions = h('div', 'actions');
    actions.append(btn('act-btn', T.handoff, { 'data-act': 'handoff', title: T.handoffTip }), btn('act-btn', T.clear, { 'data-act': 'clear', title: T.clearTip }));
    actions.append(usageAgeEl);
    const strips = h('div', 'strips');
    const runTitle = h('h2', 'group-title');
    const runListEl = h('div', 'list');
    const runSec = h('section', 'group');
    runSec.append(runTitle, runListEl);
    const emptyText = h('p', 'empty-text');
    const emptySrc = h('p', 'empty-src');
    const emptyBtn = btn('link-btn', T.showFolder, { 'data-act': 'reveal' });
    const empty = h('div', 'empty');
    empty.append(emptyText, emptySrc, emptyBtn);
    const recTitle = h('span', 'group-label');
    const recToggle = btn('group-toggle', undefined, { 'data-toggle': 's:recent' });
    recToggle.append(chev(), recTitle);
    const recListEl = h('div', 'list');
    const recSec = h('section', 'group');
    recSec.append(recToggle, recListEl);
    app.append(bar, actions, strips, usageSec, runSec, empty, recSec);
    const runList = new KeyedList(runListEl);
    const recList = new KeyedList(recListEl);

    // ---- usage rows ----
    function createUsageRow() {
      const el = h('div', 'urow');
      const r = { el, label: h('span', 'u-label'), pct: h('span', 'u-pct'), reset: h('span', 'u-reset') };
      el.append(r.label, r.pct, r.reset);
      return r;
    }

    function updateUsageRow(r, w) {
      const v = usageRowView(w, nowMs());
      setAttr(r.el, 'data-sev', v.sev);
      setText(r.label, usageLabel(w) + ':');
      setText(r.pct, v.pctText);
      setText(r.reset, v.resetText);
      setAttr(r.el, 'title', usageLabel(w) + ': ' + v.pctText + ' · ' + v.resetText);
      ticks.push({ el: r.reset, f: (n) => usageRowView(w, n).resetText });
    }

    // ---- agent line (activity + chips), shared by table rows and plain agent cards ----
    function createLine(withModel) {
      const r = { el: h('div', 'line2'), modelInline: withModel ? h('span', 'model-inline') : null, activity: h('span', 'activity') };
      r.chips = { attempt: h('span'), cached: h('span'), state: h('span'), eta: h('span') };
      for (const c of Object.values(r.chips)) c.hidden = true;
      r.el.append(...[r.modelInline, r.activity].filter(Boolean), ...Object.values(r.chips));
      return r;
    }

    function chip(el, spec, noTip) {
      if (!spec) { setHidden(el, true); return false; }
      setHidden(el, false);
      setCls(el, 'chip chip-' + spec.cls);
      setText(el, spec.text);
      setAttr(el, 'title', spec.tip && !noTip ? spec.tip : null);
      return true;
    }

    function updateLine(r, a, cardLevel) {
      const live = isLive(a.state);
      const act = live ? activityText(a.activity) : '';
      setText(r.activity, act);
      setAttr(r.activity, 'title', act || null); // one line in the view, the full text in the hover tooltip
      setHidden(r.activity, !act);
      if (r.modelInline) setText(r.modelInline, modelLabel(a));
      let any = !!act;
      any = chip(r.chips.attempt, a.attempt > 1 ? { cls: 'mute', text: T.attempt + ' ' + a.attempt } : null) || any;
      any = chip(r.chips.cached, a.cached ? { cls: 'mute', text: T.cached } : null) || any;
      // the card pill already states the state of a plain agent; only the failure detail adds information there
      any = chip(r.chips.state, !cardLevel || a.state === 'failed' ? stateChip(a) : null) || any;
      const eta = live ? etaView(a.eta, 'agent') : null;
      any = chip(r.chips.eta, eta ? { cls: 'eta-' + eta.cls, text: eta.text, tip: eta.tip } : null) || any;
      setAttr(r.el, 'data-empty', any ? null : '1');
    }

    // ---- phase table ----
    function createRow() {
      const el = h('div', 'arow', undefined, { role: 'row' });
      const dot = h('span', 'dot', undefined, { role: 'img' });
      const row = { el, dot, label: cell('c-label'), model: cell('c-model'), tok: cell('c-tok'), time: cell('c-time'), line: createLine(true) };
      el.append(dot, row.label, row.model, row.tok, row.time, row.line.el);
      return row;
    }

    function updateRow(row, a) {
      const ds = dotState(a);
      setAttr(row.el, 'data-s', ds);
      setAttr(row.dot, 'data-s', ds);
      setAttr(row.dot, 'aria-label', pillForAgent(a).text);
      setText(row.label, a.label);
      setAttr(row.label, 'title', isLive(a.state) ? null : a.resultPreview ? a.label + '\n' + a.resultPreview : a.label);
      setText(row.model, modelLabel(a) || T.dash);
      setText(row.tok, a.cached ? T.dash : fmtTokens(a.tokens) + (a.loading ? ' …' : ''));
      setAttr(row.tok, 'title', a.loading && !isLive(a.state) ? T.loadingFile : null);
      const live = isLive(a.state);
      setText(row.time, a.cached ? T.dash : elapsedText(live, a.startedAt, a.endedAt, a.durationMs, nowMs()));
      if (live && a.startedAt !== null && !a.cached) {
        ticks.push({ el: row.time, f: (n) => elapsedText(true, a.startedAt, null, null, n) });
      }
      updateLine(row.line, a, false);
    }

    function createPhase(id) {
      const p = { id, head: btn('phase-head', undefined, { 'data-toggle': id }), title: h('span', 'ph-title'), count: h('span', 'ph-count'), dots: h('span', 'dots', undefined, { 'aria-hidden': 'true' }) };
      const top = h('span', 'ph-top');
      top.append(p.title, p.count, chev());
      p.head.append(top, p.dots);
      const header = h('div', 'arow head', undefined, { role: 'row' });
      header.append(h('span', undefined, undefined, { 'aria-hidden': 'true' }));
      for (const [cls, text] of [['c-label', T.colAgent], ['c-model', T.colModel], ['c-tok', T.colTokens], ['c-time', T.colTime]]) {
        header.append(Object.assign(cell(cls, 'columnheader'), { textContent: text }));
      }
      p.rows = h('div', 'rows', undefined, { role: 'rowgroup' });
      p.list = new KeyedList(p.rows);
      p.more = h('div', 'more');
      p.table = h('div', 'table', undefined, { role: 'table', 'aria-label': T.phases });
      p.table.append(header, p.rows);
      p.body = h('div', 'phase-body');
      p.body.append(p.table, p.more);
      p.el = h('section', 'phase');
      p.el.append(p.head, p.body);
      return p;
    }

    function updatePhase(p, ph) {
      const open = isOpen(ui, p.id, phaseDefaultOpen(ph));
      const name = ph.title || T.noPhase;
      setAttr(p.el, 'data-s', ph.state);
      setText(p.title, name);
      setAttr(p.title, 'title', ph.detail || null);
      setText(p.count, ph.state === 'pending' ? T.dash : ph.done + '/' + ph.total);
      setAttr(p.head, 'aria-expanded', String(open));
      setAttr(p.head, 'aria-label', name + (ph.state === 'pending' ? '' : ', ' + ph.done + ' ' + T.of + ' ' + ph.total + ' ' + T.phaseDone + (ph.failed ? ', ' + ph.failed + ' ' + T.failedCount : '')));
      while (p.dots.children.length < ph.agents.length) p.dots.append(h('span', 'dot'));
      while (p.dots.children.length > ph.agents.length) p.dots.lastChild.remove();
      ph.agents.forEach((a, i) => setAttr(p.dots.children[i], 'data-s', dotState(a)));
      setHidden(p.body, !open);
      if (!open) return; // collapsed rows are brought up to date when the phase is opened (re-render on toggle)
      const keys = uniqueKeys(ph.agents.map((a) => a.id));
      p.list.sync(ph.agents.map((a, i) => ({ k: keys[i], data: a })), createRow, updateRow);
      const note = phaseNote(ph);
      setText(p.more, note);
      setHidden(p.more, !note);
      setHidden(p.table, ph.agents.length === 0);
    }

    // ---- cards ----
    function createCard(k, data, compact) {
      const rec = { k, compact, kind: data.kind, title: h('span', 'card-title'), pill: h('span', 'pill'), body: h('div', 'card-body') };
      const head = h('div', 'card-head');
      if (compact) {
        rec.toggle = btn('card-toggle', undefined, { 'data-toggle': 'c:' + k });
        rec.toggle.append(chev(), rec.title);
        rec.ago = h('span', 'ago');
        head.append(rec.toggle, rec.ago, rec.pill);
      } else head.append(rec.title, rec.pill);
      rec.kindEl = h('span', 's-kind');
      rec.elapsed = h('span', 's-elapsed');
      rec.extra = h('span', 's-extra');
      const sub = h('div', 'sub');
      sub.append(rec.kindEl, rec.elapsed, rec.extra);
      rec.statText = h('span', 'stat-text');
      rec.statFail = h('span', 'stat-fail');
      rec.eta = h('span');
      rec.eta.hidden = true;
      const parts = h('span', 'stat-parts');
      parts.append(rec.statText, rec.statFail);
      const stats = h('div', 'stats');
      stats.append(parts, rec.eta);
      if (data.kind === 'workflow') {
        rec.desc = h('p', 'desc');
        rec.phSum = h('span', 'phases-sum');
        const pHead = h('div', 'phases-head');
        pHead.append(h('h3', 'phases-title', T.phases), rec.phSum);
        const pList = h('div', 'phase-list');
        rec.phaseList = new KeyedList(pList);
        rec.phases = h('div', 'phases');
        rec.phases.append(pHead, pList);
        rec.body.append(rec.desc, sub, stats, rec.phases); // the task description sits directly under the title
      } else {
        rec.line = createLine(false);
        rec.resBtn = btn('result-toggle', undefined, { 'data-toggle': 'r:' + k });
        rec.resBtn.append(chev(), h('span', undefined, T.result));
        rec.resText = h('p', 'result-text');
        rec.body.append(sub, stats, rec.line.el, rec.resBtn, rec.resText);
      }
      rec.el = h('article', 'card' + (compact ? ' compact' : ''));
      rec.el.append(head, rec.body);
      return rec;
    }

    function updateCard(rec, c) {
      const wf = c.kind === 'workflow';
      const a = wf ? null : c.agent;
      const live = wf ? c.status === 'running' : isLive(a.state);
      const title = wf ? c.name || c.runId || T.dash : a.label;
      const pill = wf ? pillForRun(c) : pillForAgent(a);
      const endedAt = wf ? c.endedAt : a.endedAt;
      setText(rec.title, title);
      setAttr(rec.title, 'title', live ? null : title);
      setCls(rec.pill, 'pill pill-' + pill.cls);
      setText(rec.pill, pill.text);
      setAttr(rec.el, 'data-s', wf ? c.status : a.state);
      let open = true;
      if (rec.compact) {
        open = isOpen(ui, 'c:' + rec.k, false);
        setAttr(rec.toggle, 'aria-expanded', String(open));
        if (endedAt !== null) {
          setText(rec.ago, T.ago(nowMs() - endedAt));
          ticks.push({ el: rec.ago, f: (n) => T.ago(n - endedAt) });
        }
        setHidden(rec.ago, endedAt === null);
      }
      setHidden(rec.body, !open);
      if (!open) return;
      const startedAt = wf ? c.startedAt : a.startedAt;
      const durationMs = wf ? c.durationMs : a.durationMs;
      setText(rec.kindEl, wf ? T.workflow : T.agent);
      setText(rec.elapsed, elapsedText(live, startedAt, endedAt, durationMs, nowMs()));
      if (live && startedAt !== null) ticks.push({ el: rec.elapsed, f: (n) => elapsedText(true, startedAt, null, null, n) });
      const extra = wf ? [sessionText(c)] : [a.agentType, a.shape === 'background' ? T.background : a.shape === 'foreground' ? T.foreground : null, sessionText(c)];
      const extraText = extra.filter(Boolean).join(' · ');
      setText(rec.extra, extraText);
      setAttr(rec.extra, 'title', !live && extraText ? extraText : null);
      setText(rec.statText, wf ? wfStatText(c) : agentStatText(a));
      const failed = wf ? c.agentsFailed : 0;
      setText(rec.statFail, failed > 0 ? ' · ' + failed + ' ' + T.failedCount : '');
      const eta = live ? etaView(wf ? c.eta : null, 'run') : null;
      chip(rec.eta, eta ? { cls: 'eta-' + eta.cls, text: eta.text, tip: eta.tip } : null, live);
      if (wf) {
        setText(rec.desc, c.description || '');
        setAttr(rec.desc, 'title', !live && c.description ? c.description : null);
        setHidden(rec.desc, !c.description);
        const sum = phaseSummary(c.phases);
        setText(rec.phSum, sum.n > 0 ? (live ? T.phaseOf + ' ' + sum.k + '/' + sum.n : sum.k + '/' + sum.n) : '');
        setHidden(rec.phases, sum.n === 0);
        const keys = uniqueKeys(c.phases.map((p) => p.title));
        rec.phaseList.sync(c.phases.map((p, i) => ({ k: keys[i], data: p })), (pk) => createPhase('p:' + rec.k + '|' + pk), updatePhase);
      } else {
        updateLine(rec.line, a, true);
        const rid = 'r:' + rec.k;
        const has = !!a.resultPreview && a.state === 'done';
        const ropen = has && isOpen(ui, rid, false);
        setHidden(rec.resBtn, !has);
        setAttr(rec.resBtn, 'aria-expanded', String(ropen));
        setText(rec.resText, has ? a.resultPreview : '');
        setHidden(rec.resText, !ropen);
      }
    }

    function syncCards(list, cards, compact) {
      const keys = uniqueKeys(cards.map((c) => c[KEY]));
      list.sync(cards.map((c, i) => ({ k: keys[i], data: c })), (k, c) => createCard(k, c, compact), updateCard, (c) => c.kind);
    }

    // ---- render ----
    let stripSig = '';
    function renderStrips(texts) {
      const sig = JSON.stringify(texts);
      if (sig === stripSig) return;
      stripSig = sig;
      strips.textContent = '';
      for (const t of texts) strips.append(h('div', 'strip', t, { role: 'status' }));
    }

    function render() {
      ticks = [];
      if (!view) {
        setText(emptyText, T.loading);
        setHidden(empty, false);
        setHidden(emptySrc, true);
        setHidden(emptyBtn, true);
        setHidden(runSec, true);
        setHidden(recSec, true);
        setHidden(usageSec, true);
        setHidden(usageAgeEl, true);
        setHidden(bar, true);
        return;
      }
      setHidden(bar, false);
      setText(scopeLabel, view.scopeLabel || (view.scope === 'all' ? T.scopeAll : T.scopeWorkspace));
      setText(scopeBtn, view.scope === 'all' ? T.scopeWorkspace : T.scopeAll);
      scopeBtn.setAttribute('data-scope', view.scope === 'all' ? 'workspace' : 'all');
      const notes = view.warnings.slice();
      if (view.v !== 1) notes.unshift(T.unknownFormat(view.v));
      if (view.formatNote) notes.push(view.formatNote);
      renderStrips(notes);

      setHidden(usageSec, !view.usage);
      setHidden(usageAgeEl, !view.usage);
      if (view.usage) {
        const age = usageAge(view.usage, nowMs());
        setText(usageAgeEl, usageBusy ? T.usageBusy : age ? age.text : '');
        setAttr(usageAgeEl, 'data-busy', usageBusy ? '1' : null);
        setAttr(usageAgeEl, 'data-stale', !usageBusy && age && age.stale ? '1' : null);
        setAttr(usageAgeEl, 'title', age ? age.tip : null);
        ticks.push({ el: usageAgeEl, f: (n) => { if (usageBusy) return T.usageBusy; const a = usageAge(view.usage, n); return a ? a.text : ''; } });
        const uk = uniqueKeys(view.usage.windows.map((w) => w.id));
        usageList.sync(view.usage.windows.map((w, i) => ({ k: uk[i], data: w })), createUsageRow, updateUsageRow);
      }

      setHidden(runSec, view.running.length === 0);
      setText(runTitle, T.running + ' (' + view.running.length + ')');
      syncCards(runList, view.running, false);

      setHidden(empty, view.running.length > 0);
      setText(emptyText, T.emptyText);
      setHidden(emptySrc, true); // the empty state is the one sentence only (no source path, no folder button)
      setHidden(emptyBtn, true);

      const recOpen = isOpen(ui, 's:recent', false);
      setHidden(recSec, view.recent.length === 0);
      setText(recTitle, T.recent + ' (' + view.recent.length + ')');
      setAttr(recToggle, 'aria-expanded', String(recOpen));
      setHidden(recListEl, !recOpen);
      if (recOpen) syncCards(recList, view.recent, true);
      ui = pruneUi(ui, collectIds(view));
    }

    function safeRender() {
      try {
        render();
        tick();
      } catch (e) {
        renderStrips([T.renderError + (e && e.message ? e.message : String(e))]);
        if (typeof console !== 'undefined') console.error(e);
      }
    }

    function tick() {
      const n = nowMs();
      for (const t of ticks) setText(t.el, t.f(n));
    }

    // ---- events ----
    app.addEventListener('click', (ev) => {
      const t = ev.target instanceof Element ? ev.target : null;
      const tog = t && t.closest('[data-toggle]');
      if (tog) {
        ui = setOpen(ui, tog.getAttribute('data-toggle'), tog.getAttribute('aria-expanded') !== 'true');
        safeRender();
        save();
        return;
      }
      const act = t && t.closest('[data-act]');
      if (!act) return;
      const what = act.getAttribute('data-act');
      if (what === 'refresh') post({ type: 'refresh' });
      else if (what === 'floating') post({ type: 'openFloating' });
      else if (what === 'handoff') post({ type: 'handoff' });
      else if (what === 'clear') post({ type: 'clearSession' });
      else if (what === 'scope') {
        const scope = act.getAttribute('data-scope');
        if (scope === 'workspace' || scope === 'all') post({ type: 'setScope', scope });
      } else if (what === 'reveal' && view && view.claudeHome) post({ type: 'reveal', path: view.claudeHome });
    });

    window.addEventListener('message', (ev) => {
      const m = ev.data;
      if (isObj(m) && m.type === 'usageBusy') { usageBusy = m.busy === true; safeRender(); return; }
      if (!isObj(m) || m.type !== 'state' || !isObj(m.state)) return;
      skew = computeSkew(m.hostNow, Date.now());
      last = { seq: num(m.seq, 0), state: m.state };
      view = normalizeState(m.state);
      safeRender();
      save();
    });

    setInterval(tick, 1000); // local 1 s tick from the absolute startedAt of each live item
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

    safeRender(); // instant paint from the restored state while the host answers 'ready'
    post({ type: 'ready', restoredSeq: last && typeof last.seq === 'number' ? last.seq : null });
  }

  if (typeof document !== 'undefined' && typeof acquireVsCodeApi === 'function') boot();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      T, QUIET_SEC, fmtTokens, fmtDur, prettyModel, modelLabel, plural, clip, computeSkew, elapsedMs, elapsedText,
      failureText, activityText, dotState, pillForAgent, pillForRun, runQuietSec, stateChip, etaView, phaseSummary,
      phaseDefaultOpen, phaseNote, wfStatText, agentStatText, sessionText, uniqueKeys, lisIndices, planReconcile,
      normalizeState, normalizeUi, isOpen, setOpen, collectIds, pruneUi,
      USAGE_STALE_MS, normalizeUsage, usageLabel, fmtUntil, fmtClock, usageRowView, usageAge,
    };
  }
})();
