# Agent View - module contract (binding for all builders)

Source of truth for behaviour: `docs/SPEC.md` (read the sections named for your module). This file fixes the
**interfaces between modules** so five builders can work in parallel on separate files.
If you find a contradiction, adapt YOUR side to this contract and report it in your final answer. Do not edit files you do not own
(exception: the integration agent may edit anything).

Reference code from the research phase (copy, adapt, do not import from there at runtime):
`SCRATCH = C:/Users/jansm/AppData/Local/Temp/claude/C--Unternehmung-Technik-claude-GUI/e5ce9d45-addc-4585-9608-4c76c0596a7b/scratchpad`
(parseAgentTranscript.js, classify_end.js, safe_meta.js, t1_session_model.js, estimate.js, estimate.test.js, hello/, harness/, vsix-tools/).

## Global rules

* Plain JavaScript, CommonJS (`require`), no npm dependencies, runs on Node 18+ (VS Code 1.139 extension host is Node 22). UTF-8 files, no BOM, LF.
* Only `extension.js` may `require('vscode')`. Everything in `lib/` is pure Node and unit-testable.
* Read-only toward `~/.claude`. Never open `*.key`, `ide/*.lock`, `.credentials.json`, the main transcript `<sid>.jsonl` (stat only).
* Forbidden in `lib/`, `extension.js`, `media/`: `eval`, `new Function`, `vm`, `child_process`, `http`/`https`, `innerHTML`, `outerHTML`, `document.write`.
* UI language German **with proper umlauts** (Läuft, Öffnen, Schätzung ...). Numbers formatted German-neutral as in SPEC 8.4 (`380.2k`, `1.1M`, `mm:ss`).
* Tests: Node built-in runner (`node --test`), files `test/<module>.test.js`. Tests that read the real tree are named `*.integration.test.js` and skip when `~/.claude/projects` is missing.
* Every exported function must tolerate ENOENT/torn/garbage input without throwing (return empty/neutral values).
* Time = epoch ms (numbers). `now` is always passed in (never call `Date.now()` inside pure functions except in the shell/poller).
* Keep each file under ~700 lines; comments only where the *why* is not obvious.

## File ownership

| Builder | Files |
|---|---|
| A core-parse | `lib/format.js`, `lib/tail.js`, `lib/agentFold.js`, `lib/workflowMeta.js`, `tools/make-fixtures.js`, `test/fixtures/agents/*`, `test/format.test.js`, `test/tail.test.js`, `test/agentFold.test.js`, `test/workflowMeta.test.js`, `test/agentFold.integration.test.js` |
| B model | `lib/claudeHome.js`, `lib/journal.js`, `lib/sessionModel.js`, `lib/strings.js`, `test/claudeHome.test.js`, `test/journal.test.js`, `test/sessionModel.test.js`, `test/sessionModel.integration.test.js` |
| C eta+history | `lib/eta.js`, `lib/history.js`, `test/eta.test.js`, `test/history.test.js` |
| D webview | `media/main.js`, `media/main.css`, `media/icon.svg`, `tools/render-harness/*` (server.js, stub.js, fixtures/*.json), `test/webview.test.js` |
| E shell | `package.json`, `extension.js`, `lib/poller.js`, `README.md`, `.vscodeignore`-equivalent exclude list inside `tools/build-vsix.js`, `tools/build-vsix.js`, `tools/zip-list.js`, `test/poller.test.js`, `test/package.test.js` |

## lib/format.js (A)

```js
prettyModel(id: string|null) -> string|null   // 'claude-sonnet-5-5'->'Sonnet 5.5', 'claude-haiku-4-5-20251001'->'Haiku 4.5', 'claude-opus-5[1m]'->'Opus 5 (1M)'; unknown -> the id unchanged; '<synthetic>'/null -> null
fmtTokens(n: number) -> string                // 999 -> '999', 380234 -> '380.2k', 1_100_000 -> '1.1M'
fmtDur(ms: number) -> string                  // 'mm:ss' below 1 h, 'h:mm:ss' from 1 h; negative/NaN -> '00:00'
```

## lib/tail.js (A)

```js
class Tail { constructor(file: string);
  poll(maxBytes: number) -> { lines: object[], loading: boolean, reset: boolean, badLines: number, missing: boolean, size: number, mtimeMs: number, changed: boolean }
}
```
Incremental, byte-offset, complete lines only (SPEC 4.1). A line longer than `CARRY_MAX` (8 MB, exported) is dropped up to its newline and counted once in `badLines`, so a file without newlines cannot grow the carry. `reset:true` when the file shrank (caller must refold from scratch). `changed:false` when (size,mtime) unchanged (then `lines` is empty).

## lib/agentFold.js (A)

```js
class AgentTracker { constructor(file: string, opts: { isWf: boolean, showToolTargets: boolean });
  poll(now: number, budget: { bytes: number }) -> AgentSnapshot   // decrements budget.bytes; never throws
  dispose() -> void
}
/** @typedef {{ missing:boolean, loading:boolean, badLines:number, size:number, mtimeMs:number,
 *   id:string|null, model:{id:string|null,label:string|null}, tokens:number, toolUses:number,
 *   firstTs:number|null, lastTs:number|null,
 *   end:'running'|'waiting'|'finished'|'failed'|'interrupted',   // SPEC 4.5 classifyEnd; 'idle' maps to 'waiting'
 *   activity:null|{kind:'tool'|'thinking'|'writing'|'waiting', tool?:string, target?:string, running:boolean, parallel?:number},
 *   failure:null|{status:number|null,error:string|null,text:string}, resultPreview:string|null }} AgentSnapshot */
// also exported for tests: foldLines(lines, prevState?) , classifyEnd, summarizeTarget
```
`tokens` per SPEC fact 5 / 4.3 (context-window rule), `toolUses` distinct tool_use ids, durations are computed by the caller from `firstTs/lastTs`.
`showToolTargets:false` -> `activity.target` omitted.

## lib/workflowMeta.js (A)

```js
extractMetaSafe(source: string) -> { name:string|null, description:string|null, phases:{title:string,detail:string|null}[], degraded:boolean } | null
```
Literal-only parser from `scratchpad/safe_meta.js`; never executes anything.

## lib/claudeHome.js (B)

```js
claudeHome(override?: string) -> string                    // override (absolute local path only) || env CLAUDE_CONFIG_DIR || ~/.claude
encodeCwd(cwd: string) -> string                           // SPEC fact 3 incl. >200 branch
findProjectDirs(projectsDir: string, cwd: string) -> string[]   // absolute dirs, case-insensitive on win32
readRegistry(claudeHome: string) -> { pid:number, sessionId:string, cwd:string, entrypoint:string|null, status:string|null, name:string|null, updatedAt:number|null, alive:boolean }[]
```
Registry: only `^\d+\.json$`; never read `*.key`; liveness via `process.kill(pid,0)` (EPERM = alive).
Review additions: `localAbsolutePath(raw) -> string|null` (absolute local path only: no relative, no UNC, no NUL; used for the setting `agentView.claudeHome`, which also has `scope: machine`) and `configDirFromEnvSetting(list) -> string|null` (CLAUDE_CONFIG_DIR of the Claude Code setting `claudeCode.environmentVariables`: user level, last valid entry wins).

## lib/journal.js (B)

```js
parseJournal(text: string) -> { slots: { key:string, id:string, label:string, phase:string|null, attempts:number, state:'running'|'done'|'failed', resultText:string|null }[], phasesSeen: string[] }
```
SPEC 5.2 step 1 (latest attempt wins; torn last line tolerated). Untrusted text is bounded here (label 200, phase 100, key 200 characters) and an agent id must match `SAFE_ID` (`^[\w-]{1,64}$`, exported): it becomes the file name `agent-<id>.jsonl`, so a line with any other id is not a slot.

## lib/strings.js (B)

Host-side German strings only (warnings, empty-state hint, session-title fallbacks, format note). Frozen object `S`.

## lib/eta.js (C)

```js
DEFAULTS
estimateAgent(input: EtaInput, hist: HistorySnapshot|null) -> Eta
estimateWorkflow(input: { elapsedSec:number, phasesAhead:number, currentPhaseSiblingsDoneSec:number[], currentPhaseElapsedSecs:number[], runPhaseDurSec:number[] }, hist: HistorySnapshot|null) -> Eta
```
`EtaInput` exactly as SPEC 6.1 `{state, elapsedSec, silentSec, kind:'wf'|'task', label, phase, model, project, runId, agentType, siblingsDoneSec[]}`.
`Eta` exactly as SPEC 2 typedef `{kind:'number'|'range'|'late'|'unknown'|'none', basis, lo, mid, hi, text, tip, n?, runs?}`; `text`/`tip` are German strings produced here (never seconds, SPEC 6.2 rounding). Start from `scratchpad/estimate.js` (+ its 25 tests) and keep its logic unchanged.

## lib/history.js (C)

```js
class History { constructor(file: string);                 // file = <globalStorage>/history.json
  load() -> void                                           // tolerant of missing/corrupt file
  snapshot() -> HistorySnapshot                            // opaque to everybody except eta.js; cheap (cached until changed)
  bootstrap(claudeHome: string, opts?: { batch?: number }) -> Promise<void>     // SPEC 6.7: result files only, in the background in batches, idempotent
  ingestRun(runId: string, resultJson: object) -> boolean  // true if newly ingested (dedupe by ingestedRuns)
  ingestAgent(agentKey: string, rec: { kind:'wf'|'task', prefix:string, phase:string|null, model:string|null, proj:string, run:string|null, durSec:number }) -> boolean
  reset() -> void
  flush() -> void                                          // atomic write (temp + rename), debounced internally
}
```

## lib/sessionModel.js (B)

```js
class SessionModel {
  constructor(opts: { claudeHome:string, scope:'workspace'|'all', workspaceFolders:string[], recentHours:number,
                      staleMinutes:number, showToolTargets:boolean, etaEnabled:boolean, history:History|null })
  refresh(now: number) -> ViewState      // synchronous, budgeted (SPEC 9: 8 MB/tick, 1 MB/file, 40 files), per-session try/catch -> warnings
  setOptions(partial) -> void            // scope, recentHours, staleMinutes, showToolTargets, etaEnabled, workspaceFolders, claudeHome
  hasActivity(now: number) -> boolean    // any running item or any change within 30 s (poller cadence)
  watchRoots() -> string[]               // directories the poller should fs.watch (SPEC 9)
  stateHash(vs: ViewState) -> string     // hash without `now` (webview push dedupe)
  dispose() -> void
}
```
`ViewState`, `WorkflowCard`, `AgentCard`, `PhaseView`, `AgentView`, `Eta` exactly as SPEC 2. It uses `AgentTracker` (A), `extractMetaSafe` (A), `eta`+`history` (C; `history` may be null). Finished runs come from `workflows/wf_<run>.json` (SPEC 5.1); live runs from journal + trackers (5.2); plain agents 5.4; status rules 3.8; ETA inputs 6.1; `history.ingestRun/ingestAgent` called once per finished run/agent.

## lib/poller.js (E)

```js
class Poller { constructor(opts: { model: SessionModel, push: (viewState, hostNow) => void, isVisible: () => boolean, pollMs: number, log: (msg) => void })
  start() / stop() / requestTick() / setPollMs(n) / dispose()
}
```
SPEC 9 (fs.watch hint + mandatory stat poll, cadence, re-entrancy guard, debounce 150 ms).

## Webview protocol (D <-> E), SPEC 8.4

Host -> webview: `{ type:'state', seq:number, hostNow:number, state:ViewState }`.
Webview -> host: `{type:'ready', restoredSeq:number|null}`, `{type:'refresh'}`, `{type:'setScope', scope:'workspace'|'all'}`, `{type:'reveal', path:string}`.
HTML shell (written by `extension.js`): `<body><div id="app"></div><script nonce src="media/main.js"></script></body>` with `media/main.css`, CSP of SPEC 8.3. `main.js` renders into `#app`, uses `acquireVsCodeApi()` once.
All strings in the webview come from a `T` object at the top of `main.js` (German). Everything file-derived goes through `textContent`.

## Acceptance (each builder)

1. `node --test test/<your files>` passes (integration tests may skip only when the real tree is absent).
2. Your files satisfy the Global rules (grep gate for forbidden APIs is clean).
3. Final answer: files written, public API deviations (should be none), test counts, anything not done.
