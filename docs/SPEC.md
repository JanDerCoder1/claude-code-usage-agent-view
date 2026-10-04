# Agent View - Implementation Spec v0.1

Standalone VS Code extension (`local.agent-view`), plain JavaScript, zero npm dependencies, strictly read-only. It shows Claude Code agents and workflows as live cards (label, model, tokens, elapsed, phases n/m, honest remaining-time label, current activity) by reading the session files on disk.

Evidence tags used below: **[V]** = reproduced by the lead in this pass with a script in the scratchpad (`C:/Users/user/AppData/Local/Temp/claude/C--Unternehmung-Technik-claude-GUI/e5ce9d45-addc-4585-9608-4c76c0596a7b/scratchpad`), **[R]** = reported by an investigator and consistent with every spot check, **[U]** = unverified, treat as assumption. Where this spec contradicts a report, the correction is listed in the separate corrections list and marked "(C#)" here.

---

## 0. Scope and decisions

* Delivery form: separate extension that docks next to the Claude Code chat. The Claude Code extension itself exposes no API to add cards, so "the same view inside Claude Code" is not possible; a second extension is the option the user offered. Default placement: Activity Bar container, which the user can drag/move to the Secondary Side Bar (View: Move View -> New Secondary Side Bar Entry). Optional manifest variant with `secondarySidebar` needs `engines.vscode ^1.106.0` (Claude Code's own extension uses the same 1.106 threshold via its context key `claude-code:doesNotSupportSecondarySidebar` [V]).
* Read-only: no stop/kill button (the Desktop card has one, we do not), no message sending, no writing to `~/.claude`.
* Never opened: `~/.claude/sessions/*.key`, `~/.claude/ide/*.lock` (contains an auth token), `.credentials.json`, the main transcript `<sid>.jsonl` (up to 136 MB; only `stat` for mtime).
* UI language German (strings below follow the Desktop pane: "Laeuft", "Phasen", "Agent / Modell / Tokens / Zeit"). All strings live in one module `lib/strings.js`.
* Source of truth is the files; the extension itself writes only one file: the ETA history file (section 6.7). It holds label prefixes, lower-cased phase titles and encoded project directory names (plain text), and its bootstrap reads every project under `claudeHome`, whatever the scope. Besides that, the editor persists the webview's last state (`vscode.setState`, section 8.4) in its workspace storage: card texts, 160-char previews, tool targets, `claudeHome`.
* Out of scope for v0.1: remote windows beyond what `extensionKind: workspace` gives, status bar item, calibration log (format reserved in 6.8), reading prompts/results beyond a 160-char preview.

---

## 1. Verified ground truth (what the code may rely on)

| # | Fact | Tag / evidence |
|---|------|----------------|
| 1 | Layout: `<claudeHome>/projects/<enc(cwd)>/<sid>.jsonl` (main, sibling of the dir) and `<sid>/` with `subagents/agent-<id>.jsonl` + `.meta.json` (Agent-tool agents), `subagents/workflows/wf_<run>/{journal.jsonl, agent-<id>.jsonl, agent-<id>.meta.json}`, `workflows/wf_<run>.json` (result file, written only when the run ends: `completed` or `killed`), `workflows/scripts/<name>-wf_<run>.js`, `custom-title.json`. One sessionId can have dirs in several project folders (scripts land under the cwd at launch time: 27 of 66 runs). | [R], consistent with the live tree [V] |
| 2 | `claudeHome = settings override \|\| env CLAUDE_CONFIG_DIR \|\| ~/.claude` (identical expression in the installed Claude Code extension.js). | [V] |
| 3 | `enc(cwd)=cwd.replace(/[^a-zA-Z0-9]/g,'-')`; if length > 200: `slice(0,200)+'-'+abs(h).toString(36)` with Java-31 hash over the original cwd. 9/10 real cwds exact, the 10th differs only in drive-letter case: VS Code sessions live in `c--...`, Desktop sessions in `C--...`; compare case-insensitively on win32. Long-path branch copied from extension.js, not testable on real data. | [R], long branch [U] |
| 4 | Agent transcript lines: types `assistant`, `user`, `attachment` only (plus synthetic API-error assistant lines, see 8). **One content block per assistant line**; lines of one API response share `requestId`/`message.id`. Only the first line of a multi-line response keeps the message_start placeholder `output_tokens` (1..16); a single-line response carries the final output. | [R], reconfirmed in the token test [V] |
| 5 | **Token rule** (matches Claude Desktop's card figures and the result-file `workflowProgress[].tokens`): `tokens = ctx(last request) + (lastRequest.lines > 1 ? firstLine.output_tokens : 0)` with `ctx = input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. Over all 586 non-cached result-file agents: exact 533, within 30 tokens 581, within 2 % 584; the 2 outliers are -4118 and +50195 (a retry slot). The old rule `ctx+firstOut` gives 537 exact / 550 within 2 %; Report 1's `ctx+maxOut` gives only 67 within 2 % (C5). It is a context-window size, not cumulative; header total = sum of agent tokens (`totalTokens == sum` in 66/66 result files). **Refinement (integration, implemented in `lib/agentFold.js`, see 4.3):** the `output_tokens` placeholder of the first line counts when the last request has more than one line OR is not finalised yet (no `stop_reason` on its newest line: in flight or interrupted); a single-line request that already carries a `stop_reason` counts 0 for the output part. This makes the four killed agents of `wf_f558ff26-d2f` exact (109963/130441/123771/103937; the literal rule gave 123755 for `a68b90c71485c3e5b` against 123771 in the result file). **Second refinement (review):** when the FIRST line of the last request already carries a `stop_reason` (the writer wrote the lines after the response had ended, so every line holds the real output), the first line's `output_tokens` is no placeholder and counts 0; this removes the +4118 and +1189 outliers (`wf_d013edbb-3b0`, `wf_a3f9807b-ab1`), which are now within 3 to 8 tokens of the result file. Over the real tree: tokens exact 528/574 (92.0 %), within 2 % 572/574, toolCalls 573/574, `sum(agent tokens) == totalTokens` 67/67 runs. | [V] `v_tok3.js`, `v_misc.js`, `test/agentFold.integration.test.js` |
| 6 | Tool count = number of distinct `tool_use` ids over all assistant lines (SubagentHandback and StructuredOutput included); equals the result-file `toolCalls` for 585/586 agents. | [R] + `t1_test_model.js` rerun [V] |
| 7 | Duration = last line timestamp minus first line timestamp over ALL lines (attachments included); median diff to harness `durationMs` 9 ms. Running agent: `now - firstTs`. Queue wait before the first line is invisible (median 21 ms, p95 19 s). Run start for a live run = `min(first line ts of its agents)`; vs result-file `startTime` the difference is 0.03-0.31 s on 47/47 runs (script birthtime is wrong for resumed runs, C12). | [V] |
| 8 | **End state of an agent from the file tail** (cross-tab against the journal over 673 workflow agents and 18 Agent-tool agents, section 4.5): journal `result` + last line `user` with `toolEndsTurn:true` (StructuredOutput result) 590; journal `result` (string) + last line assistant text `end_turn` 24; journal `failed` + last line synthetic API-error assistant line (`isApiErrorMessage:true`, model `<synthetic>`, `apiErrorStatus` 429 `rate_limit` x9 or `server_error` x4) 13/13; no journal outcome + `[Request interrupted by user...]` 19; rest running/orphaned 30. Agent-tool agents: `toolEndsTurn` exists only from Claude Code 2.1.285; <= 2.1.284 (11 of 18 files) append a closing assistant text, sometimes thinking + a "[Your previous response had no visible output...]" nudge, AFTER the successful SubagentHandback result, so "last line is the tool result" is wrong for them. `[handback-send-enforce]` injection (2.1.286+) makes a bare `end_turn` transient for Agent-tool agents. | [V] `v_tails2.js`, `v_plain.js`, `classify_end.js` |
| 9 | Silence between lines (all 691 agent files): max-gap p50 72 s, p90 225 s, p99 486 s, max 1651 s; >180 s in 113 files, >300 s in 31, >600 s in only 3. So silence is a label ("ruhig seit N Min."), never proof of death. | [V] `v_gaps.js` |
| 10 | Models: take `message.model` from the transcript (`claude-sonnet-5-5` -> "Sonnet 5.5"); result-file model equals it for 586/586 after stripping the `[1m]` suffix (1M-context flag). The flag is not in the API messages but in the `{type:'model', identity:{modelId}}` attachment at the top of every agent transcript (`claude-opus-5[1m]`), which `lib/agentFold.js` uses for the model LABEL ("Opus 5 (1M)") while `model.id` stays the bare message id (the ETA history key). `<synthetic>` is never a model. | [V] `v_misc.js` |
| 11 | Workflow journal: `launched`, `started{key,agentId,label,phase}`, `result{key,agentId,result}`, `failed{key,agentId}`; no timestamps; no end marker. `key` = slot id (labels are not unique); a repeated `started` for the same key = retry/restart, latest attempt wins. A run is finished only when `workflows/wf_<run>.json` exists. Six of seven runs without result file on this machine are orphans. | [R] |
| 12 | Liveness registry: `<claudeHome>/sessions/<pid>.json` (`^\d+\.json$` only) with `sessionId, cwd, entrypoint, status 'idle'/'busy', name, updatedAt, pid`; all 5 present entries had a live pid. Entries seem removed on exit [U]; check `process.kill(pid,0)`. PID reuse not guarded. | [V] |
| 13 | ETA history: finished workflow agents p25/p50/p75/p90 = 105/287/524/885 s (n=595, transcripts) and 108/284/521/829 s (n=569, result-file `durationMs`); conditional remaining time is flat: median 277/268/297/234/285 s at elapsed 10/60/120/300/600 s. So a per-agent ETA is mostly unknowable; only finished same-phase siblings beat the prior (Report 4). | [V] `v_eta.js`, `v_boot.js` |
| 14 | All 26 `--vscode-*` color ids used by the CSS exist in the VS Code 1.139.1 workbench (foreground, descriptionForeground, widget.border, panel.border, badge.*, progressBar.background, scrollbarSlider.background, charts.blue/green/red/yellow/orange, errorForeground, focusBorder, contrastBorder, editorWidget.background, sideBar.*, list.hoverBackground, toolbar.hoverBackground, icon.foreground). Runtime injection into a webview inside the real window was never observed. | ids [V], runtime [U] |
| 15 | Packaging: dependency-free zip builder produces a vsix that the CLI installs (11 entries, 0 CRC errors, forward-slash names); only `extension/package.json` is strictly required. `Compress-Archive` writes backslash names - do not use. | [V] rebuilt `out/v_check.vsix` |
| 16 | A real VS Code window could not be started: a VS Code update installer (PIDs 16372/12580, started 23:22) still holds the mutex `vscode-updating` and waits for the user's windows to quit (processes still present at 00:1x). CLI actions (`--install-extension`, `--list-extensions`) are unaffected. | [V] |

---

## 2. Data model

All host-side modules are pure Node (no `vscode` import). Times are epoch ms, durations ms unless noted.

```js
/** @typedef {{kind:'number'|'range'|'late'|'unknown'|'none', basis:'siblings'|'key'|'global'|'phases'|'none',
 *            lo:number|null, mid:number|null, hi:number|null, text:string, tip:string, n?:number, runs?:number}} Eta */

/** @typedef {{ id:string, label:string, phase:string|null, kind:'wf'|'task',
 *   agentType:string|null, shape:'background'|'foreground'|null,
 *   model:{id:string|null, label:string|null},
 *   state:'running'|'waiting'|'done'|'failed'|'interrupted'|'stopped',
 *   quietSec:number,                 // now - last line ts (display "ruhig seit N Min." when > 600)
 *   tokens:number, toolUses:number,
 *   startedAt:number|null, endedAt:number|null, durationMs:number|null,
 *   attempt:number, cached:boolean, loading:boolean,   // loading = read budget not yet exhausted for this file
 *   activity:null|{kind:'tool'|'thinking'|'writing'|'waiting', tool?:string, target?:string, running:boolean, parallel?:number},
 *   failure:null|{status:number|null, error:string|null, text:string},
 *   resultPreview:string|null,       // <=160 chars of SubagentHandback.message or journal result string, textContent only
 *   eta:Eta|null }} AgentView */

/** @typedef {{ title:string, detail:string|null, state:'pending'|'running'|'done'|'partial',
 *   done:number, failed:number, total:number, agents:AgentView[] }} PhaseView */

/** @typedef {{ kind:'workflow', key:string, runId:string, sessionId:string, sessionTitle:string, origin:'VS Code'|'Desktop'|null,
 *   name:string, description:string|null, status:'running'|'completed'|'killed'|'stopped'|string,
 *   startedAt:number|null, endedAt:number|null, durationMs:number|null,
 *   agentsTotal:number, agentsDone:number, agentsFailed:number, tokens:number, toolUses:number,
 *   phases:PhaseView[], eta:Eta|null }} WorkflowCard */

/** @typedef {{ kind:'agent', key:string, sessionId:string, sessionTitle:string, origin:string|null,
 *   agent:AgentView }} AgentCard */   // plain Agent-tool subagent; agent.phase = null

/** @typedef {{ v:1, now:number, scope:'workspace'|'all', scopeLabel:string, claudeHome:string,
 *   running:(WorkflowCard|AgentCard)[], recent:(WorkflowCard|AgentCard)[],  // recent: finished within recentHours, newest first, max 20
 *   warnings:string[], formatNote:string|null }} ViewState */
```

Rules: `status` of a run and `state` of an agent are computed on the host only; the webview never infers state. Strings in `eta.text`/`tip` are produced on the host (`lib/eta.js` + `lib/strings.js`). A `ViewState` must stay below ~150 KB (cap 50 running + 20 recent cards; agents beyond 40 per phase collapse into "+N weitere").

---

## 3. File discovery and session selection

1. `claudeHome` (setting `agentView.claudeHome`, else `CLAUDE_CONFIG_DIR` of the Claude Code setting `claudeCode.environmentVariables` (user level; that extension starts its CLI with it), else the process environment `CLAUDE_CONFIG_DIR`, else `~/.claude`); `projectsDir = claudeHome/projects`. The setting has `scope: machine` (a repository's `.vscode/settings.json` cannot set it) and accepts only absolute local paths: relative and UNC values are ignored, because opening a UNC name makes Windows contact that host. Missing dir -> empty state with the hint text, never an error toast.
2. Scope `workspace` (default): `cwds = workspaceFolders(file:).fsPath`; project dirs = union of `findProjectDirs(cwd)` (case-insensitive on win32, exact encoding from fact 3). Additionally include every session whose registry entry (alive or not) has a `cwd` equal to or inside a workspace folder (normalised: lower-case on win32, trailing separator trimmed), even if its project folder differs; such a session is remembered for the lifetime of the host (its registry entry disappears when the process exits, its finished cards must not vanish with it). Limit: a sub-folder session of a previous host run, or a sibling session in that project folder that was never seen while it was alive, is only shown in scope `all`. No workspace folder (empty window) -> behave as `all`. Scope `all`: every directory under `projectsDir`.
3. Per project dir: one `readdir`; session refs = entries named like a GUID, with or without `.jsonl`. `lastActivityMs = max(mtime(<sid>.jsonl), newest mtime of subagents/agent-*.jsonl, newest mtime of every file in run dirs that have no result file yet)`. Finished runs no longer change and are skipped here. Directory mtimes are useless (appends do not bump them).
4. A session is *included* when it is live (registry alive) or `lastActivityMs >= now - recentHours` (default 24 h). Included sessions are *active* (polled every tick) if live or `now - lastActivityMs < 10 min`, otherwise *cold* (read once, re-checked at discovery cadence).
5. Same sessionId in several project folders: collect `<projectsDir>/*/<sid>` (dedupe case-insensitively) and union runs, scripts, subagents.
6. Session title: `custom-title.json.customTitle` -> registry `name` -> first 8 chars of the id. Origin: registry `entrypoint` or the `entrypoint` of any agent line (`claude-vscode` -> "VS Code", `claude-desktop` -> "Desktop").
7. Liveness: `live(sid) = registry has sid && process.kill(pid,0) ok (EPERM counts as alive)`. `registryAvailable = sessions dir exists`.
8. Run status without result file: `running` if `live` or newest activity < 60 s old (a live session keeps a quiet run running for at least 60 minutes, longer when `staleMinutes` is larger); if the registry is unavailable then `running` while newest activity < `staleMinutes` (10); otherwise `stopped` (orphan). `staleMinutes` is only this orphan threshold; the "ruhig seit" label is fixed at 10 minutes of quiet (section 8.1) and its unfinished agents become `stopped`. With a result file: the file's `status` (`completed`/`killed`; unknown values are shown verbatim, neutral colour).
9. Everything tolerates ENOENT (transcripts are deleted after `cleanupPeriodDays`, default 30) and torn last lines.

---

## 4. Per-agent parsing (`lib/tail.js`, `lib/agentFold.js`)

### 4.1 Incremental reading
`Tail(file)` keeps `offset` and `carry` (bytes after the last newline). Per poll: `statSync`; unchanged `(size, mtimeMs)` -> return cached snapshot (about 0.014 ms); `size < offset` -> reset state; otherwise read `offset..size` (cap per file per tick 1 MB, per tick overall 8 MB; remaining bytes next tick and `loading:true`), split on `\n`, JSON.parse each complete line, ignore a failing line (counts `badLines`). Never parse a line without trailing newline. Reference: `AgentTranscriptTracker` in `scratchpad/parseAgentTranscript.js` (verified: incremental result byte-identical to full parse). Full parse of a 565 KB file takes 4 ms.

### 4.2 Fold (per line)
* `ts = Date.parse(o.timestamp)`; track `firstTs = min`, `lastTs = max` over ALL line types (attachments included).
* Ignore for tokens/model/state: `o.isApiErrorMessage === true`, `message.model === '<synthetic>'`.
* assistant: `rid = o.requestId || message.id`. If `rid !== lastReq.rid` start `lastReq = {rid, ctx, firstOut: usage.output_tokens, lines:0}` (ctx from this first line; cache fields are identical on all lines of a request); `lastReq.lines++`. `model = message.model`. Block `tool_use` (dedupe by id; `wireToolInputs` is a duplicate carrier, ignore): add to `toolIds`, `pending.set(id,{name,input,at})`, `lastTool`; if `delivered` and the tool is not terminal (`SubagentHandback`, `StructuredOutput`): `workAfter = true`. Block `text`: `lastText = text` (kept truncated to 160). Remember last assistant block kind.
* user: for each `tool_result` block: `pending.delete(tool_use_id)`; if it belongs to a terminal tool, is not `is_error` and (`o.toolEndsTurn === true` or its text matches `/"success"\s*:\s*true/`): `delivered = true; workAfter = false` and keep the tool's `input.message` (first 160 chars) as `resultPreview`. Text block starting with `[Request interrupted by user` -> `interrupted` marker. String content (`isMeta`, e.g. `[handback-send-enforce]`, nudge) never changes state.
* attachment: only the timestamp counts. (`total_tokens_reminder` is NOT used: it only repairs the previous response's output tokens, which the token rule does not need.)

### 4.3 Outputs
`tokens = lastReq ? lastReq.ctx + (lastReq.lines > 1 || !lastReq.final ? lastReq.firstOut : 0) : 0` (fact 5, refined), where `lastReq.final` = the newest line of the last request has a `stop_reason` (a finalised single-line response already carries its real output count, which the placeholder rule must not add again; an unfinished one still carries the placeholder). `toolUses = toolIds.size`. `model` via `prettyModel`. `durationMs = (running ? now : lastTs) - firstTs`.

### 4.4 Current activity (`activity`)
Pending tools (tool_use without result): `kind:'tool'`, name and target of the newest pending, `parallel = pending.size`, `running:true`. No pending and last line is user/attachment: `thinking`. Last line is an assistant line: only thinking blocks -> `thinking`; text block -> `writing`; state `waiting` -> `waiting`. Target text = harness summary rule: first non-empty of `file_path, path, notebook_path, command, url, query, pattern, description, prompt, message, skill`, first line, truncated to 59 chars + "..." (matches the harness `lastToolSummary` 4/4; Grep uses `path` before `pattern`). Setting `agentView.showToolTargets=false` hides targets (Bash commands can contain secrets).

### 4.5 End-state classification (replaces Report 1's `finish()`; verified 100 %)
Reference implementation: `scratchpad/classify_end.js` (pure function; run as a script it prints the cross-tab). The extension folds the same flags incrementally (`delivered`, `workAfter`, last non-attachment line kind, `isWf` = file lives under `subagents/workflows/`).

```js
function classifyEnd(na /* non-attachment lines */, isWf) {
  const last = na[na.length-1];
  /* fold flags: pendingTerminal ids; delivered/workAfter as in 4.2 */
  if (last.type==='assistant' && last.isApiErrorMessage===true)
      return {state:'failed', reason:'api-error', status:last.apiErrorStatus, error:last.error, text:firstTextBlock.slice(0,160)};
  if (delivered && !workAfter && (last.type==='assistant' || last.toolEndsTurn===true))
      return {state:'finished'};                       // modern (toolEndsTurn) and legacy (closing ack text/thinking/nudge after the handback)
  if (last.type==='user') return /^\[Request interrupted by user/.test(firstText) ? {state:'interrupted'} : {state:'running'};
  if (last.type==='assistant' && proseOnly(last) && last.message.stop_reason==='end_turn')
      return isWf ? {state:'finished'}                 // workflow agent without output schema: free text IS the result (journal result:string)
                  : {state:'idle'};                    // plain agent: harness injects the enforce prompt within ~30 ms
  return {state:'running'};
}
```

Mapping to `AgentView.state`: `finished` -> `done`; `idle` -> `waiting` (if still idle after 60 s: `done` with note "ohne Bericht"); `failed` -> `failed` (+`failure`); `interrupted` -> `interrupted`; `running` -> `running`, but `stopped` when the owning run/session is not alive (section 3.8) and `quietSec > 60`. A resumed Agent-tool agent flips back to `running` at its new user prompt (a non-meta text line after the delivery) and stays running: that prompt resets `delivered`, `workAfter` and the old report preview, so a thinking line before the first tool call no longer shows the old report as finished. Harness nudges and reminders carry `isMeta` and do not reset it.

For workflow agents the journal is authoritative when present: `result` -> done, `failed` -> failed; the file tail is used only for `interrupted`, `activity`, `failure` details and as fallback when the journal slot is missing.

---

## 5. Workflow and phase reconstruction (`lib/journal.js`, `lib/workflowMeta.js`, `lib/sessionModel.js`)

### 5.1 Finished runs (result file exists): read only the result JSON
**Exception (found in the real-tree acceptance, implemented in `lib/sessionModel.js`):** a resumed run keeps its run directory and its result file, so the file then describes the earlier launch. If `journal.jsonl` is more than 10 s newer than the result file, the file is stale and the run is built by the live path (5.2) instead; once the resumed launch ends, the harness rewrites the file (newer than the journal) and 5.1 applies again. On the real tree 69 of 69 normal runs have a journal that is not newer than the result file (delta <= 0 s), the one resumed run `wf_70b51efe-65b` +13156 s. A stale file is neither shown nor ingested into the ETA history.
`workflowProgress[]` is authoritative: entries `workflow_phase{index,title}` and `workflow_agent{label,phaseTitle,agentId,model,state done|progress|error,startedAt,queuedAt,attempt,cached,lastToolName,lastToolSummary,lastProgressAt,tokens,toolCalls,durationMs,error|resultPreview}`. No transcript is read (cheap: 66 files / 7.5 MB parse in 81 ms). Map: `done`->done, `error`->failed, `progress` (only in killed runs)->interrupted, strip `" (retry N)"` from the label and show a chip "Versuch N", `cached:true` -> chip "aus Cache" (no tokens/durations). Run fields: `name = workflowName`, `description = summary`, `startedAt = startTime`, `endedAt = Date.parse(timestamp)`, `durationMs`, `tokens = totalTokens`, `toolUses = totalToolCalls`, phases from `phases` (title, detail).

### 5.2 Live runs (journal exists, no result file)
1. Parse the journal tolerant of a torn last line. `byKey`: on `started` create/update the slot (`label`, `phase`, `id = agentId`, `attempts++`, state `running`); on `result`/`failed` set the state of the slot only if `agentId` equals the slot's current id (a stalled earlier attempt never gets an outcome). Re-read the journal only when `(size, mtime)` changed (result lines can be 129 KB each).
2. Per slot read `agent-<id>.jsonl` incrementally (section 4); `meta.json` gives `description` (= label) and `workflowPhase`, not the model.
3. Name: `meta.name` of the script. Locate the script as `workflows/scripts/<name>-<runId>.js` in ANY of the session's folders (`*-<runId>.js`); custom scriptPath scripts (10 of 66 runs, in `%TEMP%`) are not found -> name falls back to the runId, description null [U]. `description = meta.description`.
4. Declared phases = `meta.phases` (title, detail), then any journal phase title not declared is appended. Phase counters: `total` = slots started so far in that phase (the planned total is not recorded anywhere), `done` = slots done. A declared phase without a slot is `pending` ("-", no dots).
5. `startedAt = min(agent firstTs)`; if no agent yet: script file birthtime. `status` per section 3.8; if not running, every `running` slot becomes `stopped`.
6. Header: `agentsTotal` = number of slots, `tokens = sum of agent tokens`, `toolUses = sum`.
7. **meta extraction must not execute anything.** Use `scratchpad/safe_meta.js` (`extractMetaSafe`: literal-only parser for objects/arrays/strings/numbers/booleans, comments, `"a" + "b"`; degraded regex fallback) instead of `vm.runInNewContext` (C7). Verified: 69/69 real scripts identical to the vm result, 0 degraded, a hostile literal `{name:(()=>{globalThis.PWNED=1})()}` is not executed.
8. Caveat (cannot be fixed from files): after `resume` with an edited script the journal also holds dead slots of the earlier launch (wf_d5f00fed-f46: 15 slots vs 9 in the result file). While the run is live these show as extra done/failed/stopped agents; once the result file exists case 5.1 takes over.

### 5.3 Phase state and dots
`pending` (no slot), `running` (any slot running), `done` (all slots done), `partial` (some failed/interrupted/stopped). One dot per slot ordered by start; the colours are those of the v0.9.4 addendum (done = filled grey, running = filled blue, not yet run = hollow blue, failed = red, interrupted/stopped = hollow grey). A phase without any slot gets one hollow blue dot. No "ghost" dots for single unstarted agents (the Desktop screenshot's extra faint dot is not reproducible from files: the planned number of agents is not recorded).

### 5.4 Plain (Agent-tool) subagents
`subagents/agent-<id>.jsonl` + `.meta.json {agentType, description, toolUseId, requestShape, model alias?}`. Card label = `description`; model from transcript (meta alias only as fallback); state per 4.5 (all 18 historical files classify `done`). Not linked to the main transcript (not needed).

---

## 6. Remaining-time estimate (ETA) - honest by construction

Principle: a reliable per-agent ETA is not derivable from this history (see fact 13); the UI shows a number only in the narrow regime where it was measured to beat the prior, otherwise a coarse range, "laenger als ueblich", or "unbekannt". Seconds are never shown. The tested implementation is `scratchpad/estimate.js` (+ `estimate.test.js`, 25 tests pass [V]); copy it into `lib/eta.js` unchanged, then wire the inputs below.

### 6.1 Inputs per running agent
`{state:'running', elapsedSec, silentSec, kind:'wf'|'task', label, phase, model, project (lower-case encoded project dir), runId, agentType, siblingsDoneSec[]}`. `siblingsDoneSec` = durations (lastTs-firstTs)/1000 of agents of the same run AND same phase that are `done`, not `cached`. No ETA (`kind:'none'`) for queued/finished/failed/interrupted/stopped.

### 6.2 Decision order and thresholds (`DEFAULTS`)
1. `elapsed < 15 s` -> unknown (warm-up). `silent > 600 s` -> unknown "keine Aktivitaet" (stale).
2. Siblings (>= 2 finished): survivors `R = {d - elapsed | d > elapsed}`. >= 2 survivors and `max-min <= max(45 s, 0.5*median)` -> **number** (`~N Min.`, `unter 1 Min.` below 45 s). Else >= 1 survivor -> **range** `[median/2, 2*median]`. No survivor (longer than every finished sibling) -> **late** "laenger als die anderen (meist < 4 Min. mehr)" (true remaining p25/p50/p75 = 30/78/210 s). Out-of-run accuracy: number MdAE 51 s (62 % within +-50 %), range covers 58 %, late range covers 49 %.
3. No siblings: key history only if project+label-prefix has >= 15 agents from >= 8 distinct runs and >= 5 survivors beyond `elapsed` -> **range** `[q25,q75]` of the conditional remaining (covers ~47 %). Else global pool of the same kind needs >= 30 agents from >= 8 runs; it yields only a prior -> **unknown**, with `[q25,q75]` in the tooltip.
4. `elapsed > p90` of the pool (global p90 = 870 s here) or < 5 survivors -> **late** "laenger als ueblich" (no number; true remaining there is still a median ~7 min).
5. Task-style (Agent-tool) agents: history has 18-23 agents -> always "unbekannt".

Rounding for text: < 45 s "unter 1 Min."; < 10 min whole minutes; >= 10 min steps of 5. Ranges render `a-b Min.`; the chip says "grob" in its tooltip with `Basis: n fertige Geschwister` / `n Agenten aus m Laeufen` / `nur Erfahrungswert`.

### 6.3 Workflow level
`estimateWorkflowRemaining` (current phase from siblings, never 0, plus phases ahead x median finished phase duration of this run or history with >= 20 phases) always yields a **range** `[c/2, 2c]`, only if `c >= 30 s`, rendered "Rest grob: a-b Min." (hit rate 60 %; with >= 2 phases ahead it is unreliable: show it only when `nAhead <= 1`, otherwise "unbekannt"). Primary progress is always "Phase k/n" and "x/y Agenten fertig".

### 6.4 Cadence
Recompute an agent's ETA when its sibling set changes or every 20 s; keep the previous text in between (no per-second countdown).

### 6.5 Honesty labels (UI)
number: `~N Min.` normal chip; range: `a-b Min.` dashed chip; late: amber outlined chip; unknown: muted `unbekannt` (tooltip may show the prior); stale: amber `keine Aktivitaet`. Tooltip always states basis and sample size.

### 6.6 What the numbers mean
All thresholds were tuned in-sample on 73 runs / 55 completed workflows from one user (leave-one-run-out and prequential checks, no held-out period). Effective sample size = distinct runs, not agents. A fresh install without history shows "unbekannt" almost everywhere; that is intended.

### 6.7 History store (`lib/history.js`)
File `globalStorageUri/history.json`, `{v:1, agents:[{kind,prefix,phase,model,proj,run,dur}], phaseDurSec:[], ingestedRuns:[], ingestedAgents:[]}`, atomic write (temp + rename), caps 3000 agents (~0.5 MB), 500 phases, 2000 ids. Bootstrap on first activation, in the background in batches: every `workflows/wf_*.json` -> records for `done`, non-cached agents (`durationMs/1000`) plus phase durations; plain agents from first/last line of finished files. Cost measured: 66 files, 7.5 MB, 81 ms, 569 agents; no transcript scan (the 5.3 s cold scan of 592 MB is unnecessary, C18). Afterwards ingest a run once when its result file appears and a plain agent once when it becomes `done`. Only successful agents are recorded. Command `agentView.resetEtaHistory` deletes the file.

### 6.8 Reserved for v1.1
Calibration log `{basis, kind, lo, mid, hi, actualRemaining}` sampled every 60 s with automatic demotion number->range->unknown when the rolling 50 % coverage of a basis falls below 30 % over >= 50 samples.

---

## 7. Extension structure

```
C:\Unternehmung\Technik\claude\GUI\agent-view\
  package.json
  README.md                      short user doc (install, move to right side bar, privacy)
  extension.js                   activate/deactivate only; the only file that imports 'vscode'
  lib\claudeHome.js              claudeHome(), encodeCwd(), findProjectDirs(), listSessions(), readRegistry()
  lib\tail.js                    incremental JSONL reader
  lib\agentFold.js               fold lines, token rule, activity, classifyEnd flags
  lib\journal.js                 journal parser (slots, attempts)
  lib\workflowMeta.js            extractMetaSafe (from scratchpad\safe_meta.js)
  lib\sessionModel.js            discovery + run/agent model + ViewState builder
  lib\eta.js                     estimate.js (unchanged logic) + German formatter
  lib\history.js                 history file (6.7)
  lib\format.js                  prettyModel, fmtTokens ("380.2k", "1.1M"), fmtDur (mm:ss, h:mm:ss)
  lib\strings.js                 German strings
  lib\poller.js                  timers + fs.watch hint (section 9)
  media\main.js  main.css  icon.svg
  test\*.test.js  test\fixtures\  test\e2e\
  tools\build-vsix.js  zip-list.js  make-fixtures.js  render-harness\ (server.js, stub.js)
```

Reuse map (copy, then change): `scratchpad\parseAgentTranscript.js` -> tail + fold ideas, `summarizeTarget`; replace its `finish()` state logic by 4.5, drop `tokensEstimated`/reminder repair/`tokensHarness` (C5). `scratchpad\t1_session_model.js` -> `encodeCwd`, `findProjectDirs`, `listSessions`, `readLiveSessions`, `prettyModel`, run building; replace `extractMeta` (C7), set tokens by 4.3, read finished runs from the result file (5.1), run start by 5.2.5. `scratchpad\hello\*` -> provider skeleton, CSP, state restore; rewrite `main.js`/`main.css`. `scratchpad\harness\*` -> render harness. `scratchpad\vsix-tools\build-vsix.js` -> add excludes (C9).

### 7.1 package.json (final)

```json
{
  "name": "agent-view",
  "displayName": "Agent View",
  "description": "Zeigt laufende Claude-Code-Agenten und Workflows als Karten (nur lesend, lokale Sitzungsdateien).",
  "version": "0.1.0",
  "publisher": "local",
  "license": "UNLICENSED",
  "private": true,
  "engines": { "vscode": "^1.94.0" },
  "categories": ["Other"],
  "extensionKind": ["workspace"],
  "main": "./extension.js",
  "activationEvents": ["onStartupFinished"],
  "capabilities": { "untrustedWorkspaces": { "supported": true }, "virtualWorkspaces": false },
  "contributes": {
    "viewsContainers": { "activitybar": [ { "id": "agentView", "title": "Agent View", "icon": "media/icon.svg" } ] },
    "views": { "agentView": [ { "type": "webview", "id": "agentView.cards", "name": "Agenten", "icon": "media/icon.svg" } ] },
    "commands": [
      { "command": "agentView.open", "title": "Agent View: Oeffnen" },
      { "command": "agentView.refresh", "title": "Agent View: Aktualisieren", "icon": "$(refresh)" },
      { "command": "agentView.toggleScope", "title": "Agent View: Arbeitsbereich / Alle Sitzungen", "icon": "$(filter)" },
      { "command": "agentView.resetEtaHistory", "title": "Agent View: Zeitschaetzungs-Verlauf loeschen" }
    ],
    "menus": { "view/title": [
      { "command": "agentView.refresh", "when": "view == agentView.cards", "group": "navigation@1" },
      { "command": "agentView.toggleScope", "when": "view == agentView.cards", "group": "navigation@2" } ] },
    "configuration": { "title": "Agent View", "properties": {
      "agentView.scope": { "type": "string", "enum": ["workspace", "all"], "default": "workspace", "description": "Welche Sitzungen angezeigt werden." },
      "agentView.recentHours": { "type": "number", "default": 24, "minimum": 1, "description": "Zuletzt fertige Eintraege der letzten N Stunden." },
      "agentView.claudeHome": { "type": "string", "default": "", "scope": "machine", "description": "Ueberschreibt CLAUDE_CONFIG_DIR / ~/.claude. Nur absolute lokale Pfade (keine Netzwerkpfade); gilt nur in den Benutzereinstellungen, nie aus einem Arbeitsbereich." },
      "agentView.showToolTargets": { "type": "boolean", "default": true, "description": "Ziel des aktuellen Tools (Pfad, Befehl) anzeigen." },
      "agentView.pollMs": { "type": "number", "default": 1500, "minimum": 500, "description": "Abfrageintervall bei laufenden Agenten." },
      "agentView.staleMinutes": { "type": "number", "default": 10, "minimum": 2, "description": "Ruhezeit, nach der ein Lauf als verwaist ('gestoppt') gilt, wenn das Sitzungsverzeichnis ~/.claude/sessions fehlt. Mit diesem Verzeichnis (Normalfall) gilt ein Lauf einer lebenden Sitzung erst nach mindestens 60 Minuten Ruhe als verwaist; dieser Wert wirkt dort nur, wenn er groesser ist. 'ruhig seit' erscheint unabhaengig davon fest nach 10 Minuten Ruhe." },
      "agentView.eta.enabled": { "type": "boolean", "default": true, "description": "Gesch\u00e4tzte Restzeit anzeigen." } } }
  }
}
```

Decisions vs Report 3: `extensionKind` is `workspace` (like Claude Code, so a remote window reads the remote `~/.claude`, C8); `activationEvents` contains `onStartupFinished` (cheap: no polling before the view resolves) so commands and the e2e test run without the view being opened; `virtualWorkspaces:false`. Secondary-side-bar variant: generated by `tools/build-vsix.js --secondary` which replaces `viewsContainers.activitybar` by `secondarySidebar` and sets `engines.vscode` to `^1.106.0`; builds and installs via CLI (verified), display unverified [U]. Never declare both containers without `when` clauses (reported layout disturbance on < 1.106).

### 7.2 extension.js responsibilities
Create the `AgentViewProvider` (webview view, `retainContextWhenHidden` NOT set), register commands, create the Poller only when the view resolves, dispose everything, react to `onDidChangeConfiguration` and `onDidChangeWorkspaceFolders`, create an OutputChannel "Agent View" (paths and counts only, never transcript content), pass `context.globalStorageUri.fsPath` to the history module. Webview messages are whitelisted: `ready`, `refresh`, `setScope`, `reveal` (host validates the path is inside `claudeHome` and calls `revealFileInOS`). Optional later: `view.badge = {value: running, tooltip}`.

---

## 8. Webview UI

### 8.1 Layout (reference: Desktop "Hintergrundaufgaben" screenshot `images/1.png`)

```
Agenten                                   [Filter: Arbeitsbereich]  [Aktualisieren]   (view title actions)
Laeuft (2)
+-------------------------------------------------------------+
| vscode-agent-view-research                      [ laeuft ]  |  title + status pill (replaces the stop button)
| Workflow  21:13  .  coding-92 (VS Code)                     |  type, ticking elapsed, session
| 5 Agenten  1.1M Tokens  .  327 Tools   Rest grob: 8-30 Min. |
| <description, muted, 2-line clamp>                          |
| Phasen                                                      |
| [v] Research                       4/4   o o o o            |  phase header = button (aria-expanded), dots
|     Agent          Modell      Tokens     Zeit   Rest       |  table (role=table)
|     research:eta   Sonnet 5.5  241.6k   21:44   -           |
|       Grep . C:/Users/.../x.js            laenger als ueblich|  2nd line: activity + ETA chip (muted)
| [>] Spec                           0/1   o                  |
+-------------------------------------------------------------+
Zuletzt fertig (5)  [>]   compact one-line cards, expand on click
```

* Plain agent card: title = description; subtitle `Agent . <agentType> . Hintergrund|Vordergrund  mm:ss`; line `Haiku 4.5 . 43.0k Tokens . 4 Tools`; activity line; ETA chip; for finished: 160-char result preview (collapsed, textContent).
* Pills: `laeuft` (accent), `fertig` (green), `Fehler: <text>` (red; for 429 "Sitzungslimit erreicht - <resets ...>"), `abgebrochen` (grey), `gestoppt` (grey, orphaned), `wartet` (idle <= 60 s), `ruhig seit N Min.` (amber, quiet > 10 min).
* Running phases expanded by default, finished phases collapsed; user toggles are stored in `vscode.setState`.
* Container query: below 360 px the "Modell" column hides and the row becomes two-line; no horizontal page scroll at 300 px.
* Empty state: "Keine laufenden Agenten. Starte in Claude Code einen Workflow oder Subagent." plus the source path (muted). Warning strip for `warnings` and for an unknown Claude Code version ("Format getestet mit Claude Code 2.1.263-2.1.287").

### 8.2 Theming and CSS rules
Only `--vscode-*` variables, transparent `body` (so it fits the side bar, secondary side bar or panel); card background `color-mix(in srgb, var(--vscode-foreground) 6%, transparent)`; border `var(--vscode-widget-border, transparent)`; accent `--vscode-charts-blue`, done `--vscode-charts-green`, failed `--vscode-charts-red`, warn `--vscode-charts-yellow`, muted `--vscode-descriptionForeground`; fonts `--vscode-font-family/--vscode-font-size`; `body.vscode-high-contrast(-light)` uses `--vscode-contrastBorder`. VS Code's own webview defaults sit in `@layer vscode-default`, unlayered CSS wins. Honour `prefers-reduced-motion` (no pulsing). Focus rings via `--vscode-focusBorder`.

### 8.3 CSP and DOM rules (verified in a Chromium harness [R])
`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-<32 hex>'; img-src ${cspSource} data:; font-src ${cspSource}">`, `localResourceRoots=[extension/media]`. No inline script, no `style=""` attribute (blocked: `style-src-attr`); dynamic widths via CSSOM (`el.style.width = ...`, allowed). All file-derived text goes through `textContent`, never `innerHTML`. No network.

### 8.4 State and protocol
* Host -> webview: `{type:'state', seq, hostNow, state: ViewState}` pushed when the state hash (without `now`) changed or every 10 s as heartbeat; immediate push on `ready` and when the view becomes visible again.
* Webview -> host: `ready{restoredSeq}`, `refresh`, `setScope{scope}`, `reveal{path}`.
* On every state message the webview calls `vscode.setState({last})` and renders from `getState()` immediately after the document is recreated (hiding the view destroys the document; no `retainContextWhenHidden`). The editor stores that state in its workspace storage (the last ViewState with card texts, previews and, unless `agentView.showToolTargets` is off, tool targets), so the privacy statements must say so.
* Elapsed per running agent/run ticks locally every second from absolute `startedAt`; finished items show `durationMs`. Keyed DOM reconciliation (by card key, phase title, agent id), no full re-render per tick.
* Number formats: tokens `380.2k` / `1.1M` / `999`, times `mm:ss` and `h:mm:ss`, model labels via `prettyModel` (`claude-sonnet-5-5` -> "Sonnet 5.5", `claude-opus-5[1m]` -> "Opus 5 (1M)", `claude-haiku-4-5-20251001` -> "Haiku 4.5").

---

## 9. Polling and watching

* Mechanism: **Node `fs.watch(dir,{recursive:true,persistent:false})` as a change hint + a stat poll of the active sessions as the correctness net.** Rejected: `vscode.workspace.createFileSystemWatcher` (same OS mechanism, +~130 ms through the shared parcel watcher, silently dead for non-recursive patterns outside the workspace, depends on user watcher excludes).
* Watch roots: each matched project dir (scope workspace) or `projectsDir` (scope all). Filter `*.jsonl` / `*.json`, ignore `null` filenames, debounce 150 ms, never tick more often than every 250 ms. Every accepted event calls `model.invalidate()` (optional-safe) before it requests the tick, so the tick rediscovers (a forced rediscovery costs about 5 ms on the real tree, scope all) and a new session or agent card shows up within ~2 s instead of at the 5 s discovery cadence. If `fs.watch` throws or the dir does not exist yet: poll only and retry the watch every 30 s.
* Why the poll is mandatory: writers that keep the file descriptor open produce late or missing ReadDirectoryChangesW events (measured: 6 of 12 writes without an event within 3 s); Claude Code mostly writes open/append/close (live: 12/12 events, one 570 ms late).
* Cadence: `pollMs` (default 1500) while the view is visible and any item is running or changed within 30 s; 5000 ms otherwise; discovery (readdir of project dirs + registry) every 5 s or when the watcher reports a new file/dir. View hidden -> stop timers and watcher; visible -> restart and tick immediately. A tick is re-entrancy-guarded and wrapped in try/catch per session (error -> `warnings`, max 5).
* Budgets: per tick read cap 8 MB (1 MB per file), max 40 agent files read per tick; unchanged `(size, mtime)` -> no read. Measured: warm model build for this session 6.7 ms, idle poll of one transcript 0.014 ms, targeted sweep of one session dir 0.7-1.2 ms (0.15 % of a core at 1 s), whole-tree sweep 34 ms (6.6 % at 1 s: avoid), `fs.watch` on the whole tree 0.39 % CPU. Target: warm tick <= 15 ms for 3 sessions / 10 agents.
* Never read the whole 960 MB tree and never open `<sid>.jsonl`.

---

## 10. Packaging and installation (commands verified as noted)

Build (dependency-free; Node >= 14; verified on this machine for the skeleton, the real tree needs the exclude list of C9: `test/`, `tools/`, `dist/`, `fixtures`, `*.md` except README, `.tmp/`). The three steps below were run in this form against the skeleton and a throwaway profile; the real-profile install itself was NOT run (needs a reload; VS Code is mid-update).

Reihenfolge: bauen, Inhalt pruefen (0 CRC-Fehler, keine Backslash-Namen), installieren, Installation pruefen, danach in VS Code `Developer: Reload Window` (Strg+Umschalt+P).

```powershell
node C:\Unternehmung\Technik\claude\GUI\agent-view\tools\build-vsix.js C:\Unternehmung\Technik\claude\GUI\agent-view C:\Unternehmung\Technik\claude\GUI\agent-view\dist\agent-view-0.1.0.vsix
```

```powershell
node C:\Unternehmung\Technik\claude\GUI\agent-view\tools\zip-list.js C:\Unternehmung\Technik\claude\GUI\agent-view\dist\agent-view-0.1.0.vsix
```

```powershell
& 'C:\Users\user\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd' --install-extension 'C:\Unternehmung\Technik\claude\GUI\agent-view\dist\agent-view-0.1.0.vsix'
```

```powershell
& 'C:\Users\user\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd' --list-extensions --show-versions
```

Erwartete letzte Ausgabe der Liste: `local.agent-view@0.1.0`. Facts: reinstalling the same version replaces in place (with or without `--force`); the engines check is enforced; no auto-update for a local vsix, so bump `version` for every change. The CLI prints a harmless DEP0169 warning.

Deinstallieren:

```powershell
& 'C:\Users\user\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd' --uninstall-extension local.agent-view
```

Entwicklungsschleife ohne Installation (hidden flag `--extensionDevelopmentPath`, repeatable; inferred from main.js to work against the running instance, NOT executed because it opens a window in the user's profile); in that window `Strg+R` reloads the extension:

```powershell
& 'C:\Users\user\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd' --extensionDevelopmentPath='C:\Unternehmung\Technik\claude\GUI\agent-view'
```

Isolated verification profile (this exact syntax with `--extensions-dir` and `--user-data-dir` was run in the scratchpad and touches none of the user's extensions); first block installs, second lists:

```powershell
& 'C:\Users\user\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd' --install-extension 'C:\Unternehmung\Technik\claude\GUI\agent-view\dist\agent-view-0.1.0.vsix' --extensions-dir 'C:\Unternehmung\Technik\claude\GUI\agent-view\.tmp\ext' --user-data-dir 'C:\Unternehmung\Technik\claude\GUI\agent-view\.tmp\ud'
```

```powershell
& 'C:\Users\user\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd' --list-extensions --show-versions --extensions-dir 'C:\Unternehmung\Technik\claude\GUI\agent-view\.tmp\ext' --user-data-dir 'C:\Unternehmung\Technik\claude\GUI\agent-view\.tmp\ud'
```

Blocker for anything that starts a window (including a second instance with its own `--user-data-dir`): while the `CodeSetup-stable-07f806f9...` installer is running, a second main process dies after ~31 s with "Code is currently being updated". The user must close all VS Code windows once so the update finishes, or the GUI tests wait.

---

## 11. Test plan

Runner: Node's built-in `node --test` (no dependencies). Pass the quoted glob, not the bare directory: `node --test test` fails on Node 22.17 ("not ok 1 - test"), the glob works and includes the `*.integration.test.js` files. Tests that read the real tree are tagged `integration` and skip when `~/.claude/projects` is missing.

Alle Unit- und Integrationstests:

```powershell
node --test "C:\Unternehmung\Technik\claude\GUI\agent-view\test\*.test.js"
```

### 11.1 Fixtures (sanitised copies of real files)
`tools/make-fixtures.js` copies selected agent transcripts and keeps only structure: `type, uuid, parentUuid, timestamp, agentId, requestId, isApiErrorMessage, apiErrorStatus, error, toolEndsTurn, sourceToolAssistantUUID, version, entrypoint`; `message.{id,model,stop_reason,usage}`; content blocks reduced (thinking -> signature stub, text -> first 40 chars, tool_use -> id, name and short `file_path/command/pattern/description` <= 80 chars, tool_result -> id, `is_error`, first 80 chars); user strings truncated; attachments dropped except `total_tokens_reminder` and two stubs (`environment`, `prompt_snapshot`) to prove they are ignored. Never commit prompts, system prompts or file contents. Sources:

| Fixture | Real source (agent id, session/run) | Golden values |
|---|---|---|
| plain-modern-A/B/C | `a8812707...`, `aeecace9...`, `a5dce7fe...` (session e5ce9d45, v2.1.286) | finished/tool-ends-turn; toolUses 1/3/4; durationMs 18622/28935/14308 (+-15 ms vs harness 18630/28947/14320); tokens 39070/42980/42983 (+-4), notification values 39494/43351/43531 are 0.9-1.3 % higher and use a different counter |
| plain-legacy-ack | `a2212fa1...` (v2.1.284), `a4a5aaee...` (v2.1.283) | finished/handback-then-ack |
| plain-legacy-nudge | `acd8ca9c...` (v2.1.278: thinking + "[Your previous response had no visible output" + text after the handback), `a4090f19...` | finished |
| wf-done-structured | `a286c2aae7c5e4f0f` (run wf_5281790c-ce8) and any done agent of wf_afd16ef8-1f1 | finished/tool-ends-turn; tokens == result-file value within 30 |
| wf-done-freetext | `a0ce9a0453614f202` (session 043be2e6, wf_07a35b55-5c4; journal `result` is a string) | finished/end-turn-text |
| wf-failed-429 | `aaf82589f3eca46c1` (ca63ee7a, wf_b324854d-978) | failed; status 429; text "You've hit your session limit..." |
| wf-failed-server | `ae09c7d756cec8675` (fc3f17c4, wf_a3f9807b-ab1) | failed; error `server_error` |
| wf-killed | the 4 agents of `wf_f558ff26-d2f` + its result file | interrupted; tokens 109963/130441/123771/103937 exact; toolCalls 29/30/29/30; run `killed`, totalTokens 468112, durationMs 64037, name `agent-rail-research` |
| wf-live | journal + agents of `wf_5281790c-ce8` captured while running; golden values taken from its result file after the run ended | phases Research 4/4, Spec 0/1; run start within 0.5 s of `startTime` |
| journal-retry / resume / duplicate-label | `wf_18d7ece8-683` (verify:batch2 retry), `wf_d5f00fed-f46` (15 slots vs 9), `wf_d976ccfb-35b` | slot logic: latest attempt wins; resume case equals the result file once it exists |
| synthetic | generated: torn last line, truncation reset, resume after handback, cut after each line of plain-modern-A | incremental == full parse; torn line ignored until completed |
| tree | generated dirs: `c--X` vs `C--X` spelling, one sessionId in 3 project folders, session without transcript | discovery union and case-insensitive match |

### 11.2 Unit tests
* `encodeCwd` incl. non-alphanumerics (`05_Leo_Xalter_Moebel_Karmann` -> `05-Leo-Xalter-Moebel-Karmann`), the >200 branch checked against the algorithm in the installed extension.js (mark as source-derived).
* `classifyEnd` truth table (section 4.5) incl. resumed agent, idle -> done after 60 s, API error mid-file is not `failed` (13/13 real errors are the last line).
* Token rule: multi-line vs single-line response, synthetic line ignored, `lastReq` replaced on new `requestId`.
* Tail: torn line, rotation (size shrinks), UTF-8 split across chunks, read budget -> `loading`.
* `extractMetaSafe`: 69 real scripts + hostile literals (no execution), template without `${}`, string concatenation.
* Journal slots: retry, orphan result of a superseded attempt ignored, torn last line.
* ETA: the 25 tests of `estimate.test.js` plus: contract (`lo<=mid<=hi`, finite) over real history, text formatting table, "never 0".
* Format: `fmtTokens`, `fmtDur`, `prettyModel` cases from fact 10.
* View-state size cap and card ordering.

### 11.3 Integration tests against the real tree (acceptance numbers on this machine; thresholds, not exact)
* End-state cross-tab (`classify_end.js` logic): every journal `result` agent -> finished (614/614), every journal `failed` -> failed (13/13), no agent without journal outcome classified finished, all 18 plain agents finished.
* Tokens vs result files: >= 90 % exact, >= 99 % within 2 % (measured 533 / 584 of 586); `sum(agent tokens) == totalTokens` for 66/66 runs.
* toolCalls equal >= 99.8 % (585/586); model equal 100 % after stripping `[1m]`; duration within 50 ms of `durationMs` for >= 95 %.
* Workflow model vs result files (status, name, phase titles, per-phase done/total, agent set, agent states) 66/66 (as `t1_test_model.js`, but compare model ids with `[1m]` stripped - its `modelOK` counter is strict and prints 348/586, C6).
* Live check on the running session: the running `spec` agent appears with state running and activity; the four finished research agents are done.

### 11.4 Webview tests (Chromium harness, Browser pane)
`tools/render-harness/server.js` serves the REAL `media/main.js` + `main.css` with a stub `acquireVsCodeApi` and injects `--vscode-*` variables from Dark Modern and Light Modern (+ a high-contrast set); fed with fixture ViewStates. Check: 300 / 420 / 700 px width without horizontal scroll, light/dark/high-contrast screenshots, CSP violation list empty, no `style=""` attribute, hide/show round trip (`getState` restore), keyboard operation of phase toggles, reduced-motion. This is NOT a test inside VS Code.

### 11.5 Real-window smoke test (mandatory before declaring v0.1 done; blocked until the VS Code update finished)
1. Install via CLI into the real profile, Reload Window, Activity Bar icon appears, view opens, demo/real data renders.
2. View: Move View -> New Secondary Side Bar Entry; reload; position persists; hide/show restores state.
3. Developer: Toggle Developer Tools -> no CSP errors, `--vscode-*` variables resolved (computed colours match theme), light and dark theme switch live.
4. Start a real Workflow in a Claude Code session in the same window: card appears within 2 s, phases/tokens/elapsed update, finished state after the result file is written; kill it -> `abgebrochen`.
5. Repeat with the optional secondarySidebar manifest variant (engines ^1.106).
6. Optional automated variant: `test/e2e` self-test driven by env `AGENTVIEW_SELFTEST=<result.json>` (prepared in `scratchpad/hello/selftest.js` + `vsix-tools/run-selftest.ps1`; excluded from the vsix).

### 11.6 Non-functional and security checks
`grep` gate: no `eval`, `new Function`, `vm`, `child_process`, `http(s)`, `innerHTML`, `.key`, `.lock`, `credentials` in `lib/`, `extension.js`, `media/`; perf test (warm tick <= 15 ms, idle poll <= 1 ms); memory cache eviction for files unseen for 10 min; 100-agent synthetic session stays under the 150 KB state cap.

---

## 12. Milestones

* M0 (10 min, needs the update finished): real-window smoke test of the existing skeleton `scratchpad/hello` (view appears, variables, Move View). Decides placement default.
* M1: `lib/*` + tests 11.2/11.3 against the real tree, no UI.
* M2: webview UI + render harness (11.4) with fixture states.
* M3: ETA module wiring, history bootstrap/ingest.
* M4: packaging (exclude list), install, real-window tests 11.5.
* M5: polish (badge, status bar, v1.1 calibration log).

---

## 13. Explicit open items (not blockers)

Real-window behaviour of container, webview, variables and secondary side bar (fact 14/16); normal-completion marker of Agent-tool agents in other versions; behaviour of `~/.claude/sessions` entries after a crash; `>200` char folder-name hash; custom `scriptPath` runs without a located script; stale slots in live resumed runs; Remote (WSL/SSH) windows; planned (not yet started) agents per phase and queued agents are not recorded in any file; whether VS Code 07f806f999 (pending update) changes the secondarySidebar contribution.


---

## 14. Addendum v0.2.0/0.2.1 (2026-10-03): Nutzungsblock, schwebendes Fenster, Beschreibungen

* **Nutzungsblock** (`lib/usage.js`, `ViewState.usage`): 5-Stunden-Limit und Wochenlimit (modellbezogene Wochenlimits wie das für Fable werden bewusst nicht angezeigt) mit Prozent, Reset-Zeit und Alter der Zahlen. Quelle ist ausschließlich der Schlüssel `cachedUsageUtilization` in Claude Codes globaler Konfigurationsdatei (`~/.claude.json`, bei benutzerdefiniertem `CLAUDE_CONFIG_DIR` die Datei darin; nie ein Rückfall auf die echte Home-Datei). Kein Netzwerk, keine Zugangsdaten; alles außer dem einen Schlüssel wird sofort verworfen. Die Datei wird höchstens alle 3 s neu geparst (Cache nach Größe und Änderungszeit). `ViewState.usage = { fetchedAt, windows:[{ id:'five_hour'|'weekly', label, percent 0-100, resetsAt (auf die Minute gerundet) | null, severity 'normal'|'warning'|'critical' | null }] }`, fehlt der Schlüssel, fehlt das Feld. Schalter: `agentView.usage.enabled`.
* **Ehrlichkeit der Zahlen:** der Zwischenspeicher ist nur so frisch wie Claude Codes letzte Abfrage. Die Weboberfläche zeigt "Stand vor N Min." (ab 30 Minuten amber, mit Hinweis). Ist die Reset-Zeit eines Fensters vorbei, steht dort "zurückgesetzt …" statt einer veralteten Zahl. Der Schweregrad ist nie ruhiger als der Prozentwert (ab 75 % warning, ab 90 % critical). Restzeit bis zum Reset und Uhrzeit werden lokal jede Sekunde aus dem absoluten `resetsAt` berechnet.
* **Schwebendes Fenster** (`FloatingSurface` in `extension.js`, Befehl `agentView.openFloating`, Knopf in der Titelleiste und in der Kopfzeile der Ansicht, Nachricht `openFloating`): ein Webview-Panel (`createWebviewPanel`, ohne Serializer, `data-mode="floating"`) wird mit `workbench.action.moveEditorToNewWindow` in ein eigenes Editor-Fenster verschoben und mit `workbench.action.enableWindowAlwaysOnTop` (zweimal, 1 s Abstand; wirkt nur auf das fokussierte Fenster) im Vordergrund gehalten, solange `agentView.floating.alwaysOnTop` an ist. Beide Befehle gibt es in VS Code 1.139 (im Workbench-Bundle geprüft, Wirkung im echten Fenster ungeprüft). Seitenleiste und Fenster werden aus demselben Modell bedient, jedes mit eigener `seq`; der Poller läuft, solange eines von beiden sichtbar ist. Schlägt das Verschieben fehl, nennt eine Meldung den manuellen Weg und das Panel bleibt ein normaler Editor-Tab.
* **Beschreibungen:** die Beschreibung eines Workflows steht ungekürzt direkt unter dem Titel (kein Zeilenlimit, `white-space: pre-line`, Tooltip mit dem ganzen Text); Obergrenzen im Modell: Beschreibung 2000 Zeichen, Phasen-Detail 600. Tätigkeitszeilen laufen über bis zu drei Zeilen (Tooltip mit dem Rest). Übersetzt wird nichts: die Anzeige zeigt, was im Workflow-Skript steht.

* **v0.4.0, /usage-Auffrischung** (`lib/usageRefresh.js`): die Erweiterung führt `claude -p /usage --no-session-persistence --setting-sources project` aus (Binary: `resources/native-binary/claude(.exe)` der Claude-Code-Erweiterung, sonst `claude` im PATH; `execFile`, keine Shell, feste Argumente, `windowsHide`, 45 s Zeitlimit, Mindestabstand 10 s, ein Lauf zur Zeit, Arbeitsordner = Speicherordner der Erweiterung). Geprüft: lokaler Befehl ohne Modellaufruf, 3,7 bis 18 s, schreibt `cachedUsageUtilization` in `~/.claude.json` neu; ohne `--no-session-persistence` entstehen Sitzungsdateien, ohne `--setting-sources project` laufen die Benutzer-Hooks. Auslöser: Aktualisieren-Knopf/-Befehl/-Nachricht (sofort), Sichtbarwerden der Ansicht und danach alle `agentView.usage.autoRefreshMinutes` (Standard 5, 0 = nie; Prüftakt 60 s, nur solange eine Ansicht sichtbar ist). Der Host meldet `{type:'usageBusy', busy}` an die Ansicht ("wird aktualisiert …"). Versionshinweis: Patch-Versionen der getesteten Reihe (2.1.x) lösen keinen Hinweis mehr aus.

* **v0.5.0, Vordergrund nur vor VS Code** (`lib/windowLink.js`, Einstellung `agentView.floating.front` = `vscode`|`all`|`off`, Standard `vscode`; ersetzt `floating.alwaysOnTop`): VS Code kennt nur "vor allen Programmen" (`enableWindowAlwaysOnTop`, jetzt der Modus `all`). Für `vscode` wird das neue Editor-Fenster unter Windows ein Besitzer-Fenster ("owned window", `SetWindowLongPtr(GWLP_HWNDPARENT)`) des VS-Code-Fensters, das beim Klick im Vordergrund war: ein Besitzer-Fenster liegt immer vor seinem Besitzer und nicht vor fremden Programmen. Ablauf: `snapshot()` vor dem Anlegen des Panels (Vordergrundfenster, das zum Prozess des Editors gehört, plus alle sichtbaren Fenster dieses Prozesses), nach dem Verschieben `link()` (das eine neue Fenster, bei Mehrdeutigkeit das mit Titel "Agent View*", wird Besitzer-gebunden und das Ergebnis geprüft; bis zu 6 Versuche im Abstand von 0,5 s). Zwei `powershell.exe`-Läufe mit festen Skripten, übergeben werden nur ganze Zahlen und der Prozessname per Umgebung. Geprüft zwischen zwei Testfenstern verschiedener Prozesse; nicht in einem echten VS-Code-Fenster. Fehlschlag: normales Fenster plus Meldung.

* **v0.6.0, Größe des schwebenden Fensters** (`agentView.floating.width`/`height`, Standard 380x480 in geräteunabhängigen Pixeln, 0 = aus; `WindowLinker.link(snap, { owner, width, height })`): das gefundene Fenster wird oben rechts im VS-Code-Fenster platziert (Abstand 24/90 px, skaliert mit `GetDpiForWindow`, `SetWindowPos` ohne Z-Order-Änderung und ohne Aktivierung); Größen außerhalb 200..4000 werden verworfen. Ohne Besitzer-Verknüpfung (Modi `all`, `off`) nur die Größe, Fehler dabei werden nur ins Protokoll geschrieben. Titelzeile und Tab-Leiste eines VS-Code-Fensters sind nicht pro Fenster abschaltbar. `/handoff` (Claude-Code-Befehl, `~/.claude/commands/handoff.md`): Prompt, der Claude die Übergabe selbst schreiben lässt; Kopie in `docs/handoff-command.md`.

* **v0.7.0, Mitschließen** (`WindowLinker.watch(main, aux)`, `PS_WATCH`, Einstellung `agentView.floating.closeWithVscode`, Standard an): ein Besitzer-Fenster eines anderen Prozesses überlebt seinen Besitzer (an Testfenstern geprüft), deshalb läuft nach dem Verknüpfen ein `powershell.exe`-Wächter mit festem Skript (nur die zwei Fenster-Handles per Umgebung): jede Sekunde `IsWindow`; ist das schwebende Fenster weg, endet er; ist das Hauptfenster weg, schickt er `WM_CLOSE` an das schwebende und endet; Obergrenze 12 h. Der Linker (Snapshot und Link) läuft jetzt in jedem Modus, weil der Wächter das Handle braucht; `link()` liefert `aux`. `dispose()` der Erweiterung beendet den Wächter.

* **v0.7.1, kein wiederhergestelltes Fenster**: VS Code stellt beim Start abgetrennte Editor-Fenster wieder her; ohne Serializer bleibt ein leeres Fenster mit der Willkommensseite. `registerWebviewPanelSerializer('agentView.floating')` schließt ein wiederhergestelltes Panel sofort (`dispose`), Aktivierung zusätzlich über `onWebviewPanel:agentView.floating`.

* **v0.8.0, eigenständiges Fenster statt VS-Code-Panel** (`lib/floatServer.js`, `lib/floatWindow.js`, `lib/floatTheme.js`; ersetzt `FloatingSurface`, `moveEditorToNewWindow` und die Einstellung `floating.front`): VS-Code-Fenster zeigen immer Titelzeile und Tab-Leiste und nehmen Dateien aus VS Code auf. Das schwebende Fenster ist jetzt Edge (sonst Chrome) im App-Modus (`--app=<URL> --user-data-dir=<Speicherordner>/float-profile --no-first-run --no-default-browser-check --window-size`), das dieselbe `media/main.js` aus einem lokalen Seitenserver lädt: `http.createServer` nur auf `127.0.0.1`, zufälliger Port, URL-Pfad mit 128-Bit-Kennwort, Host-Header auf `127.0.0.1:<port>`/`localhost:<port>` geprüft, `Origin` bei POST geprüft, Body höchstens 64 KB, nur `main.js`, `main.css`, `icon.svg`, `bridge.js`, `theme.css`, `events` (Server-Sent-Events, Host an Seite; das jeweils letzte `state` und `usageBusy` wird beim Verbinden nachgeliefert) und `msg` (POST, Seite an Host, dieselbe Nachrichtenliste wie die Ansicht); strenge CSP, kein CORS. `bridge.js` stellt `acquireVsCodeApi()` bereit (fetch/EventSource/localStorage), `theme.css` die `--vscode-*`-Variablen nach Theme-Art. Verknüpfung mit dem VS-Code-Fenster unverändert (`WindowLinker` mit `auxProc` = Browserprozess, `retries` 14; `snapshot` vor dem Start, danach `link` mit Besitzer, Größe und Platz, `watch` mit Rückruf beim Ende). Schließen: Wächter meldet das Ende des Fensters, `close()` beendet Server, Browserprozess und Wächter; ohne Verknüpfung gilt ein Fenster ohne verbundene Seite nach 45 s als geschlossen. Das alte Panel-Format wird nur noch über den Serializer sofort geschlossen.

* **v0.9.0, Umbenennung**: der sichtbare Name ist jetzt "Claude Code Utilities" (Anzeigename, Titel der Aktivitätsleiste, Befehlstitel, Meldungen, Fenstertitel, Ausgabekanal). Die technischen Namen bleiben (Erweiterungs-ID `local.agent-view`, Einstellungen `agentView.*`, Befehls-IDs `agentView.*`, Ordner `agent-view`, Temp-Ordner `agent-view-handoff`), damit Einstellungen und Installation erhalten bleiben. Die älteren Abschnitte dieses Dokuments sprechen noch vom "Agent View".

* **v0.9.1, Paketname wie das Repository**: `name` ist `claude-code-usage-agent-view`, die Erweiterungs-ID damit `local.claude-code-usage-agent-view` (die alte ID `local.agent-view` wird deinstalliert), die Datei `claude-code-usage-agent-view-<Version>.vsix`. Einstellungen und Befehle (`agentView.*`) bleiben.

* **v0.9.2, Clear mit Hand-Off**: der Clear-Knopf schreibt zuerst ein Hand-Off (ohne Hand-Off geschieht nichts), öffnet dann mit `claude-vscode.editor.open(undefined, prompt, viewColumn)` eine neue Unterhaltung, deren Eingabefeld den Prompt mit dem Dateipfad schon enthält (nicht abgeschickt, zusätzlich in der Zwischenablage), und schließt danach den alten Chat-Tab (`tabGroups.close`, nur wenn der aktive Tab ein Claude-Code-Editor-Tab ist, Webview-Typ enthält `claudeVSCodePanel`). Fallback: `claude-vscode.newConversation`.

* **v0.9.3, kompakte Ansicht**: Nutzung als zwei Textzeilen (Label, Prozent, `Reset <Tag> <Uhrzeit> · noch <Dauer>`), der "Stand" steht rechts neben Hand-Off/Clear; die Tätigkeit eines laufenden Agenten ist genau eine Zeile (Ellipse, voller Text als Tooltip), Chips bleiben in derselben Zeile (`.line2` ohne Umbruch); kein Hover-Hintergrund auf Agentenzeilen, laufende Karten haben außer der Tätigkeit keine Tooltips.

* **v0.9.4, eindeutige Statuspunkte**: ein Farbschema für die Punkte vor den Agenten, im Phasenkopf und in der Status-Pille. Fertig = grau ausgefüllt (`--av-muted`), laufend/wartend = blau ausgefüllt (pulsiert nur beim laufenden Agenten), noch nicht gelaufen = leerer blauer Kreis (`pending`), fehlgeschlagen = rot ausgefüllt, abgebrochen/gestoppt = leerer grauer Kreis. Die Sonderregel "fertig = blau" im Phasenkopf entfällt, Grün (`--av-ok`) gibt es nicht mehr; `.pill-ok` ist grau, `.pill-mute` hat einen hohlen Punkt. Eine Phase ohne Agenten zeigt einen leeren blauen Kreis (`phaseDotStates`). `background-clip: padding-box`, damit eine durchscheinende Theme-Farbe unter dem Rand nicht doppelt deckt.
