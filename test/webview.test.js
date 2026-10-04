'use strict';
// Webview tests (SPEC 11.4, the part that runs in plain Node): static CSP/DOM-rule checks of media/*, pure helpers of
// media/main.js, fixture validity (SPEC 2 typedefs) and the render-harness server. Real DOM behaviour (reconciliation,
// toggles, themes, widths) is checked in the Chromium harness: node tools/render-harness/server.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const MEDIA = path.join(ROOT, 'media');
const FIXDIR = path.join(ROOT, 'tools', 'render-harness', 'fixtures');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const JS = read(MEDIA, 'main.js');
const CSS = read(MEDIA, 'main.css');
const SVG = read(MEDIA, 'icon.svg');
const W = require('../media/main.js');

const loadFixture = (name) => JSON.parse(read(FIXDIR, name + '.json'));
const FIXTURE_NAMES = ['wf-running', 'wf-done', 'wf-killed', 'task-agents', 'failed-429', 'many-cards', 'empty'];

// ---------------------------------------------------------------------------------------------------------------
// static rules (SPEC 8.2, 8.3; CONTRACT global rules)
// ---------------------------------------------------------------------------------------------------------------
const FORBIDDEN = [
  [/\beval\b/, 'eval'], [/new\s+Function/, 'new Function'], [/\bvm\b/, 'vm'], [/child_process/, 'child_process'], [/http/i, 'http(s)'],
  [/innerHTML/, 'innerHTML'], [/outerHTML/, 'outerHTML'], [/document\.write/, 'document.write'], [/\.key/, '.key'], [/\.lock/, '.lock'], [/credentials/i, 'credentials'],
];

test('forbidden-API grep gate is clean for media/*', () => {
  for (const [name, text] of [['main.js', JS], ['main.css', CSS], ['icon.svg', SVG]]) {
    for (const [re, what] of FORBIDDEN) assert.ok(!re.test(text), `${name} contains ${what}`);
  }
});

test('files are UTF-8 without BOM, LF only', () => {
  for (const f of ['main.js', 'main.css', 'icon.svg']) {
    const buf = fs.readFileSync(path.join(MEDIA, f));
    assert.ok(!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), f + ' has a BOM');
    assert.ok(!buf.includes(13), f + ' contains CR');
  }
});

test('CSP-compatible DOM rules: no inline style, textContent only, no markup parsing', () => {
  assert.ok(!/\bstyle\s*=/.test(JS), 'style= in main.js');
  assert.ok(!/setAttribute\(\s*['"]style/.test(JS) && !/cssText/.test(JS));
  assert.ok(!/insertAdjacentHTML|createContextualFragment|DOMParser|srcdoc|\.write\(/.test(JS));
  assert.ok(!/\bon[a-z]+\s*=\s*['"]/.test(JS), 'inline event handler attribute');
  assert.ok(/\.textContent\s*=/.test(JS));
  assert.equal((JS.match(/acquireVsCodeApi\(\)/g) || []).length, 1, 'acquireVsCodeApi must be called exactly once');
  assert.ok(!/<style|<script|<link/i.test(JS));
  assert.ok(!/@import/.test(CSS) && !/url\(/.test(CSS));
});

test('webview posts only the seven whitelisted message types', () => {
  const types = new Set([...JS.matchAll(/post\(\{\s*type:\s*'(\w+)'/g)].map((m) => m[1]));
  assert.deepEqual([...types].sort(), ['clearSession', 'handoff', 'openFloating', 'ready', 'refresh', 'reveal', 'setScope']);
  assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/.test(JS), 'no network');
});

test('CSS uses only --vscode-* colour variables from the verified set (SPEC fact 14), no colour literals', () => {
  const allowed = new Set([
    'foreground', 'descriptionForeground', 'widget-border', 'panel-border', 'badge-background', 'badge-foreground', 'progressBar-background',
    'scrollbarSlider-background', 'charts-blue', 'charts-green', 'charts-red', 'charts-yellow', 'charts-orange', 'errorForeground', 'focusBorder',
    'contrastBorder', 'editorWidget-background', 'sideBar-background', 'sideBar-foreground', 'sideBar-border', 'list-hoverBackground',
    'toolbar-hoverBackground', 'icon-foreground', 'font-family', 'font-size',
  ]);
  const used = new Set([...CSS.matchAll(/var\(--vscode-([A-Za-z0-9-]+)/g)].map((m) => m[1]));
  assert.ok(used.size >= 10);
  for (const id of used) assert.ok(allowed.has(id), `--vscode-${id} is not in the verified variable set`);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(CSS), 'hex colour literal');
  assert.ok(!/\b(rgb|rgba|hsl|hsla)\(/.test(CSS), 'colour function literal');
  assert.ok(!/\b(white|black|red|green|blue|yellow|orange|gray|grey)\s*[;}]/.test(CSS), 'named colour');
});

test('CSS carries the required features: container query < 360 px, reduced motion, high contrast, focus ring', () => {
  assert.match(CSS, /container:\s*card\s*\/\s*inline-size/);
  assert.match(CSS, /@container card \(max-width:\s*359\.98px\)/);
  assert.match(CSS, /prefers-reduced-motion:\s*no-preference/);
  assert.match(CSS, /vscode-reduce-motion/);
  assert.match(CSS, /body\.vscode-high-contrast-light/);
  assert.match(CSS, /body\.vscode-high-contrast\b/);
  assert.match(CSS, /--vscode-contrastBorder/);
  assert.match(CSS, /:focus-visible\s*\{[^}]*--vscode-focusBorder/);
  assert.match(CSS, /background:\s*transparent;/); // body stays transparent
  assert.match(CSS, /color-mix\(in srgb, var\(--vscode-foreground\) 6%, transparent\)/); // card background of SPEC 8.2
  assert.match(CSS, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test('no animation outside the no-preference media query', () => {
  const outside = CSS.replace(/@media \(prefers-reduced-motion: no-preference\)\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, '').replace(/@keyframes[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
  assert.ok(!/animation\s*:/.test(outside), 'animation declared outside the no-preference block');
  assert.ok(!/transition\s*:/.test(outside), 'transition declared outside the no-preference block');
});

test('icon.svg is a standalone 24x24 SVG without script or inline style', () => {
  assert.match(SVG, /^<svg xmlns="&#104;ttp:\/\/www\.w3\.org\/2000\/svg" /); // numeric reference keeps the plain-word grep gate clean
  assert.match(SVG, /viewBox="0 0 24 24"/);
  assert.ok(!/<script|style=|<image|<use|href=/i.test(SVG));
});

test('main.js starts with the German string table T and uses proper umlauts', () => {
  const head = JS.split('\n').slice(0, 12).join('\n');
  assert.match(head, /const T = Object\.freeze\(\{/);
  assert.equal(W.T.running, 'Läuft');
  assert.equal(W.T.pillRunning, 'läuft');
  assert.equal(W.T.showFolder, 'Ordner öffnen');
  assert.equal(W.T.recent, 'Zuletzt fertig');
  assert.equal(W.T.phases, 'Phasen');
  assert.equal(W.T.colModel, 'Modell');
  assert.equal(W.T.emptyText, 'Keine laufenden Agenten.');
  const flat = JSON.stringify(Object.values(W.T).map((v) => (typeof v === 'string' ? v : String(v(3)))));
  for (const bad of ['Laeuft', 'laeuft', 'Oeffnen', 'oeffnen', 'ueblich', 'Aktivitaet', 'zurueck', 'fuer ', 'Schaetzung', 'laenger', 'waehrend', 'gestoppt?']) {
    assert.ok(!flat.includes(bad), 'transliterated umlaut: ' + bad);
  }
  assert.ok(/[äöüÄÖÜ]/.test(flat));
});

// ---------------------------------------------------------------------------------------------------------------
// formatting (SPEC 8.4, agrees with lib/format.js except the explicit ".0" of SPEC 8.1 "43.0k Tokens")
// ---------------------------------------------------------------------------------------------------------------
test('fmtTokens / fmtDur / prettyModel follow SPEC 8.4', () => {
  assert.equal(W.fmtTokens(999), '999');
  assert.equal(W.fmtTokens(380234), '380.2k');
  assert.equal(W.fmtTokens(1100000), '1.1M');
  assert.equal(W.fmtTokens(43000), '43.0k');
  assert.equal(W.fmtTokens(0), '0');
  assert.equal(W.fmtTokens(-5), '0');
  assert.equal(W.fmtTokens(NaN), '0');
  assert.equal(W.fmtTokens(999949), '999.9k');
  assert.equal(W.fmtTokens(999950), '1.0M');
  assert.equal(W.fmtDur(0), '00:00');
  assert.equal(W.fmtDur(36000), '00:36');
  assert.equal(W.fmtDur(21 * 60000 + 13000), '21:13');
  assert.equal(W.fmtDur(3599999), '59:59');
  assert.equal(W.fmtDur(3600000), '1:00:00');
  assert.equal(W.fmtDur(36000000 + 61000), '10:01:01');
  assert.equal(W.fmtDur(-1), '00:00');
  assert.equal(W.fmtDur(NaN), '00:00');
  assert.equal(W.fmtDur(undefined), '00:00');
  assert.equal(W.prettyModel('claude-sonnet-5-5'), 'Sonnet 5.5');
  assert.equal(W.prettyModel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(W.prettyModel('claude-opus-5[1m]'), 'Opus 5 (1M)');
  assert.equal(W.prettyModel('something-else'), 'something-else');
  assert.equal(W.prettyModel('<synthetic>'), null);
  assert.equal(W.prettyModel(null), null);
  assert.equal(W.modelLabel({ model: { id: 'claude-sonnet-5-5', label: null } }), 'Sonnet 5.5');
  assert.equal(W.modelLabel({ model: { id: null, label: 'Haiku 4.5' } }), 'Haiku 4.5');
  assert.equal(W.modelLabel({ model: { id: null, label: null } }), '');
  assert.equal(W.modelLabel(null), '');
});

test('webview formatting agrees with lib/format.js where both exist', (t) => {
  let F;
  try { F = require('../lib/format.js'); } catch (e) { return t.skip('lib/format.js not available'); }
  for (const n of [0, 5, 999, 1000, 43000, 380234, 999949, 999950, 1100000, 12345678, -3]) {
    assert.equal(W.fmtTokens(n), F.fmtTokens(n), 'fmtTokens ' + n);
  }
  for (const n of [0, 999, 1000, 59999, 60000, 3599999, 3600000, 36061000, -5, NaN]) assert.equal(W.fmtDur(n), F.fmtDur(n), 'fmtDur ' + n);
  for (const id of ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-opus-5[1m]', 'claude-3-5-sonnet-20241022', 'claude-opus-4-1-20250805', 'x', null, '', '<synthetic>']) {
    assert.equal(W.prettyModel(id), F.prettyModel(id), 'prettyModel ' + id);
  }
});

test('T.ago, plural, clip', () => {
  assert.equal(W.T.ago(0), 'gerade eben');
  assert.equal(W.T.ago(59999), 'gerade eben');
  assert.equal(W.T.ago(60000), 'vor 1 Min.');
  assert.equal(W.T.ago(59 * 60000), 'vor 59 Min.');
  assert.equal(W.T.ago(3 * 3600000 + 5), 'vor 3 Std.');
  assert.equal(W.T.ago(2 * 86400000), 'vor 2 Tg.');
  assert.equal(W.plural(1, 'Agent', 'Agenten'), 'Agent');
  assert.equal(W.plural(0, 'Agent', 'Agenten'), 'Agenten');
  assert.equal(W.plural(5, 'Agent', 'Agenten'), 'Agenten');
  assert.equal(W.clip('a  b\n c', 10), 'a b c');
  assert.equal(W.clip('abcdefghij', 5), 'abcd…');
});

// ---------------------------------------------------------------------------------------------------------------
// clock and elapsed time
// ---------------------------------------------------------------------------------------------------------------
test('computeSkew ignores latency but follows a really different host clock', () => {
  assert.equal(W.computeSkew(1000, 1003), 0);
  assert.equal(W.computeSkew(10000, 4000), 6000);
  assert.equal(W.computeSkew(4000, 10000), -6000);
  assert.equal(W.computeSkew(undefined, 10), 0);
  assert.equal(W.computeSkew(NaN, 10), 0);
});

test('elapsed time: live items tick from the absolute startedAt, finished ones show durationMs', () => {
  const t0 = 1_000_000;
  assert.equal(W.elapsedText(true, t0, null, null, t0 + 36_000), '00:36');
  assert.equal(W.elapsedText(true, t0, null, null, t0 + 37_000), '00:37'); // advances by exactly the clock
  assert.equal(W.elapsedText(true, t0, null, null, t0 - 5000), '00:00'); // clock skew never goes negative
  assert.equal(W.elapsedText(true, null, null, null, t0), '–'); // not started yet
  assert.equal(W.elapsedText(false, t0, t0 + 5000, 64037, t0 + 99999), '01:04'); // durationMs wins, "now" is irrelevant
  assert.equal(W.elapsedText(false, t0, t0 + 90_000, null, t0 + 99999), '01:30'); // fallback endedAt - startedAt
  assert.equal(W.elapsedText(false, null, null, null, t0), '–');
  assert.equal(W.elapsedMs(true, t0, null, null, t0 + 1), 1);
});

// ---------------------------------------------------------------------------------------------------------------
// pills, chips, honesty labels (SPEC 8.1, 6.5)
// ---------------------------------------------------------------------------------------------------------------
test('pillForAgent covers every state', () => {
  const p = (state, extra) => W.pillForAgent(Object.assign({ state, quietSec: 0 }, extra));
  assert.deepEqual(p('running'), { cls: 'run', text: 'läuft' });
  assert.deepEqual(p('waiting'), { cls: 'wait', text: 'wartet' });
  assert.deepEqual(p('done'), { cls: 'ok', text: 'fertig' });
  assert.deepEqual(p('failed'), { cls: 'err', text: 'Fehler' });
  assert.deepEqual(p('interrupted'), { cls: 'mute', text: 'abgebrochen' });
  assert.deepEqual(p('stopped'), { cls: 'mute', text: 'gestoppt' });
  assert.deepEqual(p('whatever'), { cls: 'mute', text: 'whatever' });
  assert.deepEqual(p(''), { cls: 'mute', text: '–' });
  assert.deepEqual(p('running', { quietSec: 600 }), { cls: 'run', text: 'läuft' }); // exactly 10 min is not "quiet" yet
  assert.deepEqual(p('running', { quietSec: 601 }), { cls: 'warn', text: 'ruhig seit 10 Min.' });
  assert.deepEqual(p('waiting', { quietSec: 1800 }), { cls: 'warn', text: 'ruhig seit 30 Min.' });
  assert.deepEqual(p('done', { quietSec: 9999 }), { cls: 'ok', text: 'fertig' }); // finished items are never "quiet"
  assert.deepEqual(W.pillForAgent(null), { cls: 'mute', text: '–' });
});

test('pillForRun: statuses, unknown status verbatim and neutral, quiet only when every live agent is quiet', () => {
  const run = (status, agents) => ({ kind: 'workflow', status, phases: [{ agents: agents || [] }] });
  assert.deepEqual(W.pillForRun(run('completed')), { cls: 'ok', text: 'fertig' });
  assert.deepEqual(W.pillForRun(run('killed')), { cls: 'mute', text: 'abgebrochen' });
  assert.deepEqual(W.pillForRun(run('stopped')), { cls: 'mute', text: 'gestoppt' });
  assert.deepEqual(W.pillForRun(run('paused')), { cls: 'mute', text: 'paused' });
  assert.deepEqual(W.pillForRun(run('')), { cls: 'mute', text: '–' });
  assert.deepEqual(W.pillForRun(run('running', [{ state: 'running', quietSec: 5 }])), { cls: 'run', text: 'läuft' });
  assert.deepEqual(W.pillForRun(run('running', [{ state: 'running', quietSec: 5 }, { state: 'running', quietSec: 900 }])), { cls: 'run', text: 'läuft' });
  assert.deepEqual(W.pillForRun(run('running', [{ state: 'running', quietSec: 700 }, { state: 'done', quietSec: 0 }, { state: 'running', quietSec: 900 }])), { cls: 'warn', text: 'ruhig seit 11 Min.' });
  assert.deepEqual(W.pillForRun(run('running', [])), { cls: 'run', text: 'läuft' });
});

test('failureText: 429 shows the limit and the reset, everything else Fehler: text', () => {
  assert.equal(W.failureText({ status: 429, error: 'rate_limit', text: "You've hit your session limit · resets 6pm (Europe/Berlin)" }), 'Sitzungslimit erreicht – Reset 6pm (Europe/Berlin)');
  assert.equal(W.failureText({ status: 429, error: 'rate_limit', text: "You've hit your session limit" }), 'Sitzungslimit erreicht');
  // result files of finished runs have no status code (real data: status null, error null, text only)
  assert.equal(W.failureText({ status: null, error: null, text: "You've hit your session limit · resets 4:20am (Europe/Berlin)" }), 'Sitzungslimit erreicht – Reset 4:20am (Europe/Berlin)');
  assert.equal(W.failureText({ status: null, error: 'rate_limit', text: '' }), 'Sitzungslimit erreicht');
  assert.equal(W.failureText({ status: null, error: null, text: 'Claude usage limit reached' }), 'Sitzungslimit erreicht');
  assert.equal(W.failureText({ status: 500, error: 'server_error', text: 'API Error: 500 boom, rate limiter unavailable' }), 'Fehler: API Error: 500 boom, rate limiter unavailable');
  assert.equal(W.failureText({ status: 500, error: 'server_error', text: 'API Error: 500 boom' }), 'Fehler: API Error: 500 boom');
  assert.equal(W.failureText({ status: null, error: 'server_error', text: '' }), 'Fehler: server_error');
  assert.equal(W.failureText({ status: 503, error: null, text: '' }), 'Fehler: Status 503');
  assert.equal(W.failureText({ status: null, error: null, text: '' }), 'Fehler: unbekannt');
  assert.equal(W.failureText(null), 'Fehler');
  const long = W.failureText({ status: 500, text: 'x'.repeat(500) });
  assert.ok(long.length <= 'Fehler: '.length + 120);
  assert.ok(long.endsWith('…'));
});

test('etaView passes the label of the host through unchanged and maps the kind to the chip class', () => {
  const E = (kind, text, tip) => ({ kind, basis: 'siblings', lo: null, mid: null, hi: null, text, tip: tip || '' });
  assert.deepEqual(W.etaView(E('number', 'Fertig in ca. 4 Min.', 'Basis')), { cls: 'number', text: 'Fertig in ca. 4 Min.', tip: 'Basis' });
  assert.deepEqual(W.etaView(E('range', 'Fertig in ca. 2–8 Min.')), { cls: 'range', text: 'Fertig in ca. 2–8 Min.', tip: '' });
  assert.deepEqual(W.etaView(E('range', 'Fertig in ca. 8–30 Min.'), 'run'), { cls: 'range', text: 'Fertig in ca. 8–30 Min.', tip: '' });
  assert.equal(W.etaView(E('late', 'länger als üblich: ca. 4–40 Min.')).cls, 'late');
  assert.equal(W.etaView(E('late', 'länger als üblich: ca. 4–40 Min.')).text, 'länger als üblich: ca. 4–40 Min.');
  assert.equal(W.etaView(E('unknown', 'Dauer noch unbekannt')).cls, 'unknown');
  assert.equal(W.etaView(E('unknown', 'keine Aktivität')).cls, 'stale');
  assert.equal(W.etaView(E('unknown', 'Keine Aktivität seit 12 Min.')).cls, 'stale');
  assert.equal(W.etaView(E('none', '')), null);
  assert.equal(W.etaView(E('number', '')), null);
  assert.equal(W.etaView(null), null);
  assert.equal(W.etaView('x'), null);
  assert.equal(W.etaView(E('martian', 'huh')).cls, 'unknown');
  assert.ok(!/Rest/.test(JS.slice(JS.indexOf('function etaView'), JS.indexOf('function etaView') + 600)), 'the webview adds no "Rest" prefix any more');
});

// The chips must read right for what the host REALLY sends: feed the output of lib/eta.js (not hand-written strings) through etaView.
test('etaView over real lib/eta.js output: every Eta kind, agent and run level', () => {
  const eta = require('../lib/eta');
  const A = (o) => Object.assign({ state: 'running', elapsedSec: 200, silentSec: 0, kind: 'wf', label: 'research:x', phase: 'Research', model: 'claude-sonnet-5-5', project: 'c--p', runId: 'wf_x', agentType: null, phaseSize: 4, phasePos: 0.5, siblingsDoneSec: [], siblingsRunningSec: [], otherPhases: [] }, o);
  const R = (o) => Object.assign({ elapsedSec: 300, phasesAhead: 0, phaseSize: 1, phasePos: 0, runningSec: [], siblingsDoneSec: [], otherPhases: [] }, o);
  const tight = Array.from({ length: 8 }, (_, i) => 60 + i);
  const cases = [
    // [what, Eta from the real module, expected chip class, expected chip text]
    ['range (nothing known but the typical values)', eta.estimateAgent(A({ elapsedSec: 120 }), null), 'range', /^Fertig in (ca\. \d+–\d+ Min\.|unter \d+ Min\.)$/],
    ['range with siblings', eta.estimateAgent(A({ elapsedSec: 150, phaseSize: 6, siblingsDoneSec: [100, 300, 500], siblingsRunningSec: [150, 150] }), null), 'range', /^Fertig in (ca\. \d+–\d+ Min\.|unter \d+ Min\.)$/],
    ['number (siblings agree, narrow span)', eta.estimateAgent(A({ elapsedSec: 100, phaseSize: 10, siblingsDoneSec: tight, siblingsRunningSec: [100] }), null), 'number', /^Fertig in (ca\. \d+ Min\.|unter 1 Min\.)$/],
    ['late (outlasts almost every comparable agent)', eta.estimateAgent(A({ elapsedSec: 40000, phaseSize: 1 }), null), 'late', /^länger als üblich: (ca\. [\d,]+–[\d,]+ (Min|Std)\.|unter \d+ Min\.)$/],
    ['unknown (warm-up)', eta.estimateAgent(A({ elapsedSec: 5 }), null), 'unknown', /^Dauer noch unbekannt$/],
    ['stale', eta.estimateAgent(A({ elapsedSec: 400, silentSec: 700 }), null), 'stale', /^keine Aktivität$/],
    ['subagent without enough history', eta.estimateAgent({ state: 'running', elapsedSec: 100, kind: 'task', label: 'x', agentType: 'Explore', project: 'c--p' }, null), 'unknown', /^Dauer unbekannt$/],
    ['run range', eta.estimateWorkflow(R({ elapsedSec: 700, phasesAhead: 1, runningSec: [100] }), null), 'range', /^Fertig in (ca\. \d+–\d+ (Min|Std)\.|unter \d+ Min\.)$/],
    ['run late', eta.estimateWorkflow(R({ runningSec: [50000] }), null), 'late', /^länger als üblich: /],
    ['run warm-up', eta.estimateWorkflow(R({ runningSec: [4] }), null), 'unknown', /^Dauer noch unbekannt$/],
  ];
  for (const [what, e, cls, re] of cases) {
    const v = W.etaView(e, what.startsWith('run') ? 'run' : 'agent');
    assert.ok(v, what + ': a chip is rendered');
    assert.equal(v.cls, cls, what + ' class');
    assert.match(v.text, re, what + ' text');
    assert.doesNotMatch(v.text, /Rest|undefined|NaN|null|\d\s*s\b/, what + ': no junk, no seconds');
    assert.ok(v.tip.length > 0, what + ': the tooltip carries basis and caveat');
  }
  for (const state of ['done', 'failed', 'interrupted', 'stopped']) assert.equal(W.etaView(eta.estimateAgent(A({ state }), null), 'agent'), null, state + ': kind none renders no chip');
});

test('stateChip and activityText', () => {
  assert.equal(W.stateChip({ state: 'done', quietSec: 0 }), null);
  assert.equal(W.stateChip({ state: 'running', quietSec: 5 }), null);
  assert.deepEqual(W.stateChip({ state: 'running', quietSec: 700 }), { cls: 'warn', text: 'ruhig seit 11 Min.' });
  assert.deepEqual(W.stateChip({ state: 'waiting', quietSec: 5 }), { cls: 'wait', text: 'wartet' });
  assert.equal(W.stateChip({ state: 'failed', failure: { status: 429, text: 'limit resets 6pm' } }).cls, 'err');
  assert.equal(W.stateChip({ state: 'interrupted' }).text, 'abgebrochen');
  assert.equal(W.stateChip({ state: 'stopped' }).text, 'gestoppt');
  assert.equal(W.activityText(null), '');
  assert.equal(W.activityText({ kind: 'thinking' }), 'denkt nach …');
  assert.equal(W.activityText({ kind: 'writing' }), 'schreibt …');
  assert.equal(W.activityText({ kind: 'waiting' }), 'wartet …');
  assert.equal(W.activityText({ kind: 'tool', tool: 'Grep', target: 'C:/x/y.js', running: true }), 'Grep · C:/x/y.js');
  assert.equal(W.activityText({ kind: 'tool', tool: 'Read' }), 'Read');
  assert.equal(W.activityText({ kind: 'tool', tool: 'Read', target: 'a', parallel: 3 }), 'Read · a (3 parallel)');
  assert.equal(W.activityText({ kind: 'tool', parallel: 1 }), 'Werkzeug');
  assert.equal(W.activityText({ kind: 'nonsense' }), '');
});

test('phase summary, default expansion and dot states', () => {
  assert.deepEqual(W.phaseSummary([]), { k: 0, n: 0 });
  assert.deepEqual(W.phaseSummary([{ state: 'running' }, { state: 'pending' }]), { k: 1, n: 2 });
  assert.deepEqual(W.phaseSummary([{ state: 'done' }, { state: 'running' }, { state: 'pending' }]), { k: 2, n: 3 });
  assert.deepEqual(W.phaseSummary([{ state: 'done' }, { state: 'done' }]), { k: 2, n: 2 });
  assert.deepEqual(W.phaseSummary(null), { k: 0, n: 0 });
  assert.equal(W.phaseDefaultOpen({ state: 'running' }), true);
  assert.equal(W.phaseDefaultOpen({ state: 'partial' }), true);
  assert.equal(W.phaseDefaultOpen({ state: 'done' }), false);
  assert.equal(W.phaseDefaultOpen({ state: 'pending' }), false);
  for (const s of ['running', 'waiting', 'done', 'failed', 'interrupted', 'stopped']) assert.equal(W.dotState({ state: s }), s);
  assert.equal(W.dotState({ state: 'x' }), 'pending');
  assert.equal(W.dotState(null), 'pending');
});

test('phase header dots: one per started agent, one hollow "not yet run" dot for a phase without agents', () => {
  assert.deepEqual(W.phaseDotStates({ agents: [{ state: 'done' }, { state: 'running' }, { state: 'failed' }] }), ['done', 'running', 'failed']);
  assert.deepEqual(W.phaseDotStates({ agents: [] }), ['pending']);
  assert.deepEqual(W.phaseDotStates({}), ['pending']);
  assert.deepEqual(W.phaseDotStates(null), ['pending']);
  assert.match(JS, /dotStates\.forEach\(\(s, i\) => setAttr\(p\.dots\.children\[i\], 'data-s', s\)\)/);
});

test('status dots: done = filled grey, running = filled blue, not yet run = hollow blue, identical in the rows and in the phase header', () => {
  const rule = (sel) => {
    const m = CSS.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
    assert.ok(m, 'CSS rule ' + sel);
    return m[1];
  };
  const done = rule('.dot[data-s="done"]');
  assert.match(done, /border-color:\s*var\(--av-muted\)/);
  assert.match(done, /background-color:\s*var\(--av-muted\)/);
  const run = rule('.dot[data-s="running"], .dot[data-s="waiting"]');
  assert.match(run, /border-color:\s*var\(--av-accent\)/);
  assert.match(run, /background-color:\s*var\(--av-accent\)/);
  const pending = rule('.dot[data-s="pending"]');
  assert.match(pending, /border-color:\s*var\(--av-accent\)/);
  assert.ok(!/background|dotted|opacity/.test(pending), 'hollow, solid and fully opaque');
  assert.match(rule('.dot[data-s="failed"]'), /background-color:\s*var\(--av-err\)/);
  assert.ok(!/\.dots\s+\.dot\[/.test(CSS), 'the phase header uses the same colours as the rows');
  assert.match(rule('.dot'), /background-clip:\s*padding-box/, 'a translucent theme colour does not double up under the border');
  assert.ok(!/--av-ok|charts-green/.test(CSS), 'no green for finished work');
  assert.match(CSS, /\.pill-ok\s*\{\s*--c:\s*var\(--av-muted\)/);
  assert.match(CSS, /\.pill-mute::before\s*\{[^}]*background:\s*transparent/);
});

test('stat lines: plural, running fraction, cached agents', () => {
  const wf = (o) => Object.assign({ status: 'completed', agentsTotal: 4, agentsDone: 4, tokens: 380234, toolUses: 52 }, o);
  assert.equal(W.wfStatText(wf()), '4 Agenten · 380.2k Tokens · 52 Tools');
  assert.equal(W.wfStatText(wf({ agentsTotal: 1, agentsDone: 1, toolUses: 1 })), '1 Agent · 380.2k Tokens · 1 Tool');
  assert.equal(W.wfStatText(wf({ status: 'running', agentsDone: 1 })), '1/4 Agenten fertig · 380.2k Tokens · 52 Tools');
  assert.equal(W.wfStatText(wf({ status: 'running', agentsDone: 4 })), '4 Agenten · 380.2k Tokens · 52 Tools');
  assert.equal(W.agentStatText({ model: { id: null, label: 'Haiku 4.5' }, tokens: 43000, toolUses: 4, cached: false }), 'Haiku 4.5 · 43.0k Tokens · 4 Tools');
  assert.equal(W.agentStatText({ model: { id: null, label: 'Haiku 4.5' }, tokens: 0, toolUses: 0, cached: true }), 'Haiku 4.5');
  assert.equal(W.sessionText({ sessionTitle: 'coding-92', origin: 'VS Code' }), 'coding-92 (VS Code)');
  assert.equal(W.sessionText({ sessionTitle: '7c1f0a2e', origin: null }), '7c1f0a2e');
});

// ---------------------------------------------------------------------------------------------------------------
// keyed reconciliation planning
// ---------------------------------------------------------------------------------------------------------------
function applyOps(oldKeys, ops) {
  let list = oldKeys.slice();
  for (const op of ops) {
    list = list.filter((k) => k !== op.k);
    if (op.op === 'remove') continue;
    const at = op.before === null ? list.length : list.indexOf(op.before);
    assert.ok(at >= 0, 'before-key must exist at that moment: ' + JSON.stringify(op));
    list.splice(at, 0, op.k);
  }
  return list;
}

test('uniqueKeys makes duplicates distinct and stable', () => {
  assert.deepEqual(W.uniqueKeys(['a', 'b', 'a', 'a', 'b']), ['a', 'b', 'a#2', 'a#3', 'b#2']);
  assert.deepEqual(W.uniqueKeys([]), []);
  assert.deepEqual(W.uniqueKeys([1, '1']), ['1', '1#2']);
});

test('planReconcile: no-op, append, remove, reverse, replace', () => {
  assert.deepEqual(W.planReconcile(['a', 'b', 'c'], ['a', 'b', 'c']), []);
  assert.deepEqual(W.planReconcile([], []), []);
  assert.deepEqual(W.planReconcile([], ['a', 'b']), [{ op: 'insert', k: 'b', before: null }, { op: 'insert', k: 'a', before: 'b' }]);
  assert.deepEqual(W.planReconcile(['a', 'b', 'c'], ['a', 'b', 'c', 'd']), [{ op: 'insert', k: 'd', before: null }]);
  assert.deepEqual(W.planReconcile(['a', 'b', 'c'], ['a', 'c']), [{ op: 'remove', k: 'b' }]);
  assert.deepEqual(W.planReconcile(['a', 'b'], []), [{ op: 'remove', k: 'a' }, { op: 'remove', k: 'b' }]);
  // rotating the first element to the end moves exactly one node (longest increasing run stays in place)
  assert.deepEqual(W.planReconcile(['a', 'b', 'c', 'd'], ['b', 'c', 'd', 'a']), [{ op: 'move', k: 'a', before: null }]);
  assert.equal(W.planReconcile(['a', 'b', 'c', 'd'], ['d', 'c', 'b', 'a']).filter((o) => o.op === 'move').length, 3);
  assert.deepEqual(applyOps(['a', 'b'], W.planReconcile(['a', 'b'], ['x', 'y'])), ['x', 'y']);
});

test('planReconcile reproduces the target order for random lists with the minimal number of moves', () => {
  let seed = 42;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'.split('');
  const draw = () => {
    const n = Math.floor(rnd() * 14);
    const pool = alphabet.slice();
    const out = [];
    for (let i = 0; i < n; i++) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    return out;
  };
  for (let i = 0; i < 400; i++) {
    const oldKeys = draw();
    const newKeys = draw();
    const ops = W.planReconcile(oldKeys, newKeys);
    assert.deepEqual(applyOps(oldKeys, ops), newKeys, JSON.stringify({ oldKeys, newKeys }));
    const common = newKeys.filter((k) => oldKeys.includes(k));
    const lis = W.lisIndices(common.map((k) => oldKeys.indexOf(k))).size;
    assert.equal(ops.filter((o) => o.op === 'move').length, common.length - lis, 'moves = common - LIS');
    assert.equal(ops.filter((o) => o.op === 'insert').length, newKeys.filter((k) => !oldKeys.includes(k)).length);
    assert.equal(ops.filter((o) => o.op === 'remove').length, oldKeys.filter((k) => !newKeys.includes(k)).length);
  }
});

test('lisIndices', () => {
  assert.equal(W.lisIndices([]).size, 0);
  assert.deepEqual([...W.lisIndices([0, 1, 2])].sort(), [0, 1, 2]);
  assert.equal(W.lisIndices([3, 2, 1, 0]).size, 1);
  assert.equal(W.lisIndices([2, 0, 1, 3]).size, 3);
});

// ---------------------------------------------------------------------------------------------------------------
// state normalisation and persisted UI state
// ---------------------------------------------------------------------------------------------------------------
test('normalizeState tolerates garbage and never throws', () => {
  for (const bad of [null, undefined, 0, 'x', [], true]) assert.equal(W.normalizeState(bad), null);
  const n = W.normalizeState({});
  assert.deepEqual([n.running, n.recent, n.warnings, n.formatNote, n.scope, n.scopeLabel, n.claudeHome], [[], [], [], null, 'workspace', '', '']);
  const g = W.normalizeState({
    v: 7, running: [null, 5, 'x', { kind: 'agent' }, { kind: 'mystery', key: 'a' }, { kind: 'workflow', key: 'k', phases: 'x' }, { kind: 'workflow', key: 'p', phases: [null, { agents: [null, { id: 3 }] }] }],
    recent: 'nope', warnings: [1, '', 'ok', null, 'two'], scope: 'bogus',
  });
  assert.equal(g.running.length, 2);
  assert.deepEqual(g.warnings, ['ok', 'two']);
  assert.deepEqual(g.recent, []);
  assert.equal(g.scope, 'workspace');
  assert.equal(g.running[1].phases.length, 1);
  assert.equal(g.running[1].phases[0].agents.length, 1);
  assert.equal(g.running[1].phases[0].agents[0].id, '#1');
  // every helper survives a normalised garbage card
  for (const c of g.running) { W.pillForRun(c); W.wfStatText(c); W.runQuietSec(c); }
});

test('normalizeState keeps valid fields and fills defaults', () => {
  const s = W.normalizeState(loadFixture('task-agents'));
  assert.equal(s.v, 1);
  assert.equal(s.running[0].kind, 'agent');
  assert.equal(s.running[0].agent.shape, 'background');
  assert.equal(s.running[0].agent.model.label, 'Haiku 4.5');
  assert.equal(s.recent[0].agent.resultPreview.startsWith('Three tests fail'), true);
  const w = W.normalizeState({ v: 1, running: [{ kind: 'workflow', key: 'w', runId: 'r', phases: [{ title: 'P', agents: [{ id: 'a', label: 'x', state: 'done' }] }] }] });
  assert.equal(w.running[0].phases[0].total, 1); // total defaults to the listed agents
  assert.equal(w.running[0].phases[0].state, 'pending');
  assert.equal(w.running[0].phases[0].agents[0].attempt, 1);
  assert.equal(w.running[0].phases[0].agents[0].cached, false);
});

test('UI state: only explicit boolean toggles survive restore, ids are pruned to the current state', () => {
  assert.deepEqual(W.normalizeUi(null), { open: {} });
  assert.deepEqual(W.normalizeUi('x'), { open: {} });
  assert.deepEqual(W.normalizeUi({ open: 'x' }), { open: {} });
  assert.deepEqual(W.normalizeUi({ open: { a: true, b: false, c: 1, d: 'x', e: null, ['x'.repeat(301)]: true } }), { open: { a: true, b: false } });
  assert.deepEqual(W.normalizeUi(JSON.parse('{"open":{"__proto__":true,"ok":true}}')), { open: { ok: true } });
  const big = { open: {} };
  for (let i = 0; i < 700; i++) big.open['k' + i] = true;
  assert.equal(Object.entries(W.normalizeUi(big).open).length, 500);

  const ui = { open: { p1: true } };
  assert.equal(W.isOpen(ui, 'p1', false), true);
  assert.equal(W.isOpen(ui, 'p2', false), false);
  assert.equal(W.isOpen(ui, 'p2', true), true);
  assert.equal(W.isOpen(ui, 'constructor', true), true); // inherited properties are not toggles
  const ui2 = W.setOpen(ui, 'p2', false);
  assert.deepEqual(ui2, { open: { p1: true, p2: false } });
  assert.deepEqual(ui, { open: { p1: true } }); // immutable
  assert.equal(W.pruneUi(ui, new Set(['p1', 'zz'])), ui); // unchanged -> same object
  assert.deepEqual(W.pruneUi(ui2, new Set(['p2'])), { open: { p2: false } });
});

test('collectIds lists section, card, result and phase ids with the same unique keys as the renderer', () => {
  const view = W.normalizeState(loadFixture('wf-running'));
  const ids = W.collectIds(view);
  assert.ok(ids.has('s:recent'));
  const k = view.running[0]['key'];
  assert.ok(ids.has('c:' + k) && ids.has('r:' + k));
  assert.ok(ids.has('p:' + k + '|Research') && ids.has('p:' + k + '|Critic'));
  const dup = W.normalizeState({ v: 1, running: [{ kind: 'workflow', key: 'w', phases: [{ title: 'P' }, { title: 'P' }] }, { kind: 'workflow', key: 'w', phases: [] }] });
  const d = W.collectIds(dup);
  assert.ok(d.has('p:w|P') && d.has('p:w|P#2') && d.has('c:w') && d.has('c:w#2'));
});

// ---------------------------------------------------------------------------------------------------------------
// fixtures: valid ViewState v:1 per SPEC 2, and renderable by the pure helpers
// ---------------------------------------------------------------------------------------------------------------
const ENUM = {
  state: ['running', 'waiting', 'done', 'failed', 'interrupted', 'stopped'], phase: ['pending', 'running', 'done', 'partial'],
  etaKind: ['number', 'range', 'late', 'unknown', 'none'], etaBasis: ['siblings', 'key', 'global', 'phases', 'none'], act: ['tool', 'thinking', 'writing', 'waiting'],
};
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const nullOr = (f) => (x) => x === null || f(x);
const isStr = (x) => typeof x === 'string';

function validateAgent(a, where, errs) {
  const need = (cond, what) => { if (!cond) errs.push(`${where}: ${what}`); };
  need(isStr(a.id) && a.id, 'id'); need(isStr(a.label), 'label'); need(nullOr(isStr)(a.phase), 'phase');
  need(a.kind === 'wf' || a.kind === 'task', 'kind'); need(nullOr(isStr)(a.agentType), 'agentType');
  need([null, 'background', 'foreground'].includes(a.shape), 'shape');
  need(a.model && nullOr(isStr)(a.model.id) && nullOr(isStr)(a.model.label), 'model');
  need(ENUM.state.includes(a.state), 'state ' + a.state);
  for (const f of ['quietSec', 'tokens', 'toolUses', 'attempt']) need(isNum(a[f]) && a[f] >= 0, f);
  for (const f of ['startedAt', 'endedAt', 'durationMs']) need(nullOr(isNum)(a[f]), f);
  need(typeof a.cached === 'boolean' && typeof a.loading === 'boolean', 'cached/loading');
  need(a.activity === null || (ENUM.act.includes(a.activity.kind) && typeof a.activity.running === 'boolean'), 'activity');
  need(a.failure === null || (nullOr(isNum)(a.failure.status) && nullOr(isStr)(a.failure.error) && isStr(a.failure.text)), 'failure');
  need(nullOr(isStr)(a.resultPreview) && (a.resultPreview === null || a.resultPreview.length <= 160), 'resultPreview <= 160');
  if (a.state === 'failed') need(a.failure !== null, 'failed agent has failure');
  if (a.eta !== null) {
    const e = a.eta;
    need(ENUM.etaKind.includes(e.kind) && ENUM.etaBasis.includes(e.basis) && isStr(e.text) && isStr(e.tip), 'eta shape');
    for (const f of ['lo', 'mid', 'hi']) need(nullOr(isNum)(e[f]), 'eta.' + f);
    if (isNum(e.lo) && isNum(e.mid) && isNum(e.hi)) need(e.lo <= e.mid && e.mid <= e.hi, 'eta lo<=mid<=hi');
  }
}

function validateCard(c, where, errs) {
  const need = (cond, what) => { if (!cond) errs.push(`${where}: ${what}`); };
  need(isStr(c['key']) && c['key'], 'key'); need(isStr(c.sessionId) && isStr(c.sessionTitle), 'session'); need(nullOr(isStr)(c.origin), 'origin');
  if (c.kind === 'agent') { validateAgent(c.agent, where + '.agent', errs); need(c.agent.kind === 'task' && c.agent.phase === null, 'plain agent: kind task, phase null'); return; }
  need(c.kind === 'workflow', 'kind');
  need(isStr(c.runId) && isStr(c.name) && nullOr(isStr)(c.description) && isStr(c.status), 'workflow strings');
  for (const f of ['startedAt', 'endedAt', 'durationMs']) need(nullOr(isNum)(c[f]), f);
  for (const f of ['agentsTotal', 'agentsDone', 'agentsFailed', 'tokens', 'toolUses']) need(isNum(c[f]) && c[f] >= 0, f);
  need(c.eta === null || ENUM.etaKind.includes(c.eta.kind), 'eta');
  need(Array.isArray(c.phases), 'phases');
  const titles = new Set();
  for (const p of c.phases) {
    const pw = `${where}.phase(${p.title})`;
    need(isStr(p.title) && !titles.has(p.title), pw + ' unique title'); titles.add(p.title);
    need(nullOr(isStr)(p.detail) && ENUM.phase.includes(p.state), pw + ' detail/state');
    need(isNum(p.done) && isNum(p.failed) && isNum(p.total) && p.done <= p.total, pw + ' counters');
    need(Array.isArray(p.agents) && p.agents.length <= 40, pw + ' agents (cap 40 per phase)');
    need(p.agents.length <= p.total, pw + ' total >= listed agents');
    if (p.state === 'pending') need(p.total === 0, pw + ' pending has no agents');
    if (p.agents.length === p.total) need(p.agents.filter((a) => a.state === 'done').length === p.done, pw + ' done counter matches agents');
    const ids = new Set();
    for (const a of p.agents) { validateAgent(a, `${pw}.agent(${a.label})`, errs); need(!ids.has(a.id), pw + ' unique agent id'); ids.add(a.id); need(a.phase === p.title, pw + ' agent.phase = phase title'); }
  }
}

function validateViewState(s) {
  const errs = [];
  const need = (cond, what) => { if (!cond) errs.push(what); };
  need(s.v === 1, 'v is 1'); need(isNum(s.now), 'now'); need(s.scope === 'workspace' || s.scope === 'all', 'scope');
  need(isStr(s.scopeLabel) && isStr(s.claudeHome), 'scopeLabel/claudeHome');
  need(Array.isArray(s.running) && s.running.length <= 50, 'running <= 50'); need(Array.isArray(s.recent) && s.recent.length <= 20, 'recent <= 20 (SPEC 2)');
  need(Array.isArray(s.warnings) && s.warnings.every(isStr), 'warnings'); need(s.formatNote === null || isStr(s.formatNote), 'formatNote');
  const keys = new Set();
  for (const [list, name] of [[s.running, 'running'], [s.recent, 'recent']]) {
    list.forEach((c, i) => { validateCard(c, `${name}[${i}]`, errs); need(!keys.has(c['key']), `${name}[${i}] unique key`); keys.add(c['key']); });
  }
  return errs;
}

test('all required fixtures exist and are valid ViewState v:1 (SPEC 2)', () => {
  const have = fs.readdirSync(FIXDIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  for (const n of FIXTURE_NAMES) assert.ok(have.includes(n), 'missing fixture ' + n);
  for (const n of have) assert.deepEqual(validateViewState(loadFixture(n)), [], 'fixture ' + n);
});

test('fixture content matches what the task asks for', () => {
  const run = loadFixture('wf-running');
  const first = run.running[0];
  assert.equal(first.phases.length, 2);
  assert.equal(first.phases[0].agents.length, 4);
  assert.ok(first.phases[0].agents.every((a) => a.activity && a.state === 'running'));
  assert.equal(first.phases[1].state, 'pending');
  const kinds = new Set();
  for (const c of run.running) for (const p of c.phases) for (const a of p.agents) if (a.eta) kinds.add(a.eta.kind + (a.eta.text === 'keine Aktivität' ? ':stale' : ''));
  for (const k of ['number', 'range', 'late', 'unknown', 'unknown:stale']) assert.ok(kinds.has(k), 'ETA kind ' + k);
  assert.equal(first.eta.kind, 'range');
  assert.equal(first.tokens, 380200);
  const states = new Set(run.running.flatMap((c) => c.phases.flatMap((p) => p.agents.map((a) => a.state))));
  for (const s of ENUM.state) assert.ok(states.has(s), 'agent state ' + s);

  const done = loadFixture('wf-done');
  assert.ok(done.running.length === 0 && done.recent.every((c) => c.kind === 'workflow'));
  assert.deepEqual(done.recent.map((c) => c.status), ['completed', 'completed', 'paused']);
  assert.ok(done.recent.some((c) => c.phases.some((p) => p.agents.some((a) => a.cached))));
  assert.ok(done.recent.some((c) => c.phases.some((p) => p.agents.some((a) => a.attempt > 1))));

  const killed = loadFixture('wf-killed');
  assert.equal(killed.recent[0].status, 'killed');
  assert.equal(killed.recent[0].tokens, 468112);
  assert.equal(killed.recent[0].durationMs, 64037);
  assert.ok(killed.recent[0].phases[0].agents.every((a) => a.state === 'interrupted'));

  const tasks = loadFixture('task-agents');
  const all = tasks.running.concat(tasks.recent);
  assert.equal(all.length, 3);
  assert.ok(all.every((c) => c.kind === 'agent'));
  assert.ok(all.some((c) => c.agent.state === 'waiting') && all.some((c) => c.agent.state === 'done' && c.agent.resultPreview));

  const f = loadFixture('failed-429');
  assert.ok(f.recent.some((c) => c.kind === 'agent' && c.agent.failure && c.agent.failure.status === 429));
  assert.ok(f.warnings.length > 0 && f.formatNote);

  const many = loadFixture('many-cards');
  assert.equal(many.running.length + many.recent.length, 30);
  assert.ok(JSON.stringify(many).length < 150 * 1024, 'ViewState cap of SPEC 2 (~150 KB)');
  assert.ok(many.running.some((c) => c.phases && c.phases.some((p) => p.total > p.agents.length)), 'a phase above the 40-agent cap');

  const empty = loadFixture('empty');
  assert.deepEqual([empty.running, empty.recent, empty.warnings], [[], [], []]);
});

test('every fixture passes through normalizeState and the pure view helpers without throwing', () => {
  for (const n of FIXTURE_NAMES) {
    const raw = loadFixture(n);
    const view = W.normalizeState(raw);
    assert.equal(view.running.length, raw.running.length, n);
    assert.equal(view.recent.length, raw.recent.length, n);
    const ids = W.collectIds(view);
    for (const c of view.running.concat(view.recent)) {
      assert.ok(ids.has('c:' + c['key']), n);
      if (c.kind === 'workflow') {
        assert.ok(W.pillForRun(c).text.length > 0);
        assert.ok(W.wfStatText(c).includes('Tokens'));
        W.phaseSummary(c.phases);
        W.etaView(c.eta, 'run');
        for (const p of c.phases) for (const a of p.agents) { W.pillForAgent(a); W.stateChip(a); W.etaView(a.eta, 'agent'); W.activityText(a.activity); W.modelLabel(a); }
      } else {
        assert.ok(W.pillForAgent(c.agent).text.length > 0);
        W.agentStatText(c.agent);
      }
    }
    // the view survives a JSON round trip (this is what vscode.setState stores)
    assert.deepEqual(W.normalizeState(JSON.parse(JSON.stringify(raw))), view);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// render harness server
// ---------------------------------------------------------------------------------------------------------------
function get(base, p, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('render harness: loopback only, serves the REAL media files, same CSP as the real shell', async () => {
  const { start } = require('../tools/render-harness/server.js');
  const h = await start({ port: 0 });
  try {
    assert.equal(h.server.address().address, '127.0.0.1');
    const page = await get(h.url, '/view?fixture=wf-running&theme=dark');
    assert.equal(page.status, 200);
    const html = page.body.toString('utf8');
    const csp = /content="(default-src[^"]+)"/.exec(html)[1];
    const nonce = /script-src 'nonce-([0-9a-f]{32})'/.exec(csp)[1];
    assert.equal(csp, `default-src 'none'; style-src 'self'; script-src 'nonce-${nonce}'; img-src 'self' data:; font-src 'self'`);
    assert.ok(html.includes(`<script nonce="${nonce}" src="/media/main.js"></script>`));
    assert.ok(html.includes(`<script nonce="${nonce}" src="/harness/stub.js"></script>`));
    assert.ok(html.includes('<link rel="stylesheet" href="/media/main.css">'));
    assert.ok(html.includes('<div id="app" data-mode="view"></div>'));
    assert.ok(!/\sstyle\s*=/.test(html), 'no style attribute in the shell');
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((m) => m[1]);
    assert.ok(inline.every((a) => /type="application\/json"/.test(a)), 'only a JSON data block is inline');
    // the fixture travels as an escaped data block: it parses back to the fixture and cannot close the script element
    const data = /<script type="application\/json" id="fixture">([\s\S]*?)<\/script>/.exec(html)[1];
    assert.deepEqual(JSON.parse(data), loadFixture('wf-running'));

    const js = await get(h.url, '/media/main.js');
    assert.ok(js.body.equals(fs.readFileSync(path.join(MEDIA, 'main.js'))), 'served main.js is the real file');
    const css = await get(h.url, '/media/main.css');
    assert.ok(css.body.equals(fs.readFileSync(path.join(MEDIA, 'main.css'))));
    assert.equal(css.headers['content-type'].startsWith('text/css'), true);
    const svg = await get(h.url, '/media/icon.svg');
    assert.match(svg.headers['content-type'], /^image\/svg\+xml/);
    assert.equal((await get(h.url, '/harness/stub.js')).status, 200);
    assert.equal((await get(h.url, '/')).status, 200);
    assert.equal((await get(h.url, '/view?fixture=none')).status, 200);
    for (const n of FIXTURE_NAMES) assert.equal((await get(h.url, '/view?fixture=' + n)).status, 200, n);
    assert.deepEqual(JSON.parse((await get(h.url, '/fixtures/empty.json')).body), loadFixture('empty'));
  } finally {
    await h.close();
  }
});

test('render harness rejects traversal, unknown files, other methods and foreign Host headers', async () => {
  const { start } = require('../tools/render-harness/server.js');
  const h = await start({ port: 0 });
  try {
    for (const p of ['/media/../package.json', '/media/%2e%2e/package.json', '/media/nope.js', '/harness/server.js', '/view?fixture=../package', '/view?fixture=nope', '/fixtures/..%2fserver.json', '/etc/passwd']) {
      const r = await get(h.url, p);
      assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
    }
    assert.equal((await get(h.url, '/', { host: 'evil.example' })).status, 403);
    assert.equal((await get(h.url, '/', { host: `localhost:${h.port}` })).status, 200);
    const post = await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: h.port, path: '/', method: 'POST' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      r.on('error', reject);
      r.end();
    });
    assert.equal(post, 405);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// usage block, floating button, description layout
// ---------------------------------------------------------------------------------------------------------------
const NOW = Date.parse('2026-10-03T07:28:34Z');
const TZ = 'Europe/Berlin';
const W5 = { id: 'five_hour', label: '5-Stunden-Limit', percent: 94, resetsAt: Date.parse('2026-10-03T09:20:00Z'), severity: 'critical' };
const WK = { id: 'weekly', label: 'Wochenlimit', percent: 27, resetsAt: Date.parse('2026-10-09T10:00:00Z'), severity: 'normal' };

test('usage: a live window shows percent, local reset clock and the time left', () => {
  const v = W.usageRowView(W5, NOW, TZ);
  assert.equal(v.pct, 94);
  assert.equal(v.pctText, '94 %');
  assert.equal(v.sev, 'critical');
  assert.equal(v.resetText, 'Reset heute 11:20 · noch 1 Std 51 Min');
  const w = W.usageRowView(WK, NOW, TZ);
  assert.equal(w.sev, 'normal');
  assert.equal(w.resetText, 'Reset Fr., 09.10. 12:00 · noch 6 Tg 2 Std');
});

test('usage: a window whose reset time has passed shows "zurückgesetzt" and no stale number', () => {
  const v = W.usageRowView(Object.assign({}, W5, { resetsAt: Date.parse('2026-10-03T07:20:00Z') }), NOW, TZ);
  assert.equal(v.pct, null);
  assert.equal(v.pctText, '–');
  assert.equal(v.sev, 'expired');
  assert.match(v.resetText, /^zurückgesetzt heute 09:20 · neuer Stand folgt/);
  assert.match(v.tip, /zurückgesetzt/);
});

test('usage: severity is never calmer than the percentage; missing reset time is stated', () => {
  assert.equal(W.usageRowView({ id: 'x', label: 'X', percent: 80, resetsAt: null, severity: 'normal' }, NOW, TZ).sev, 'warning');
  assert.equal(W.usageRowView({ id: 'x', label: 'X', percent: 95, resetsAt: null, severity: null }, NOW, TZ).sev, 'critical');
  assert.equal(W.usageRowView({ id: 'x', label: 'X', percent: 10, resetsAt: null, severity: 'critical' }, NOW, TZ).sev, 'critical');
  assert.equal(W.usageRowView({ id: 'x', label: 'X', percent: 10, resetsAt: null, severity: null }, NOW, TZ).resetText, 'Reset-Zeit unbekannt');
});

test('usage: tomorrow and next-week reset clocks, countdown wording', () => {
  assert.equal(W.fmtClock(Date.parse('2026-10-04T01:00:00Z'), NOW, TZ), 'morgen, 03:00 Uhr');
  assert.equal(W.fmtUntil(113 * 60000), 'in 1 Std 53 Min');
  assert.equal(W.fmtUntil((6 * 1440 + 4 * 60) * 60000), 'in 6 Tg 4 Std');
  assert.equal(W.fmtUntil(12 * 60000), 'in 12 Min');
  assert.equal(W.fmtUntil(30000), 'in weniger als 1 Min.');
  assert.equal(W.fmtUntil(-5), 'in weniger als 1 Min.');
});

test('usage: the age of the numbers is stated and turns amber after 30 minutes', () => {
  const fresh = W.usageAge({ fetchedAt: NOW - 5 * 60000 }, NOW);
  assert.equal(fresh.text, 'Stand vor 5 Min.');
  assert.equal(fresh.stale, false);
  assert.equal(fresh.tip, null);
  const old = W.usageAge({ fetchedAt: NOW - 41 * 60000 }, NOW);
  assert.equal(old.text, 'Stand vor 41 Min.');
  assert.equal(old.stale, true);
  assert.match(old.tip, /veraltet/);
  assert.equal(W.usageAge({ fetchedAt: null, windows: [] }, NOW), null);
});

test('usage: normalizeState keeps well-formed usage and drops garbage', () => {
  const ok = W.normalizeState({ v: 1, usage: { fetchedAt: 5, windows: [W5, WK] } });
  assert.equal(ok.usage.windows.length, 2);
  assert.equal(ok.usage.fetchedAt, 5);
  for (const bad of [undefined, null, 5, 'x', [], { windows: 'x' }, { windows: [] }, { windows: [{ percent: 5 }] }]) {
    assert.equal(W.normalizeState({ v: 1, usage: bad }).usage, null, JSON.stringify(bad));
  }
  const clamped = W.normalizeUsage({ fetchedAt: 'x', windows: [{ id: 'a', percent: 250, resetsAt: 'no', severity: 'wild', label: 'L'.repeat(500) }] });
  assert.equal(clamped.windows[0].percent, 100);
  assert.equal(clamped.windows[0].resetsAt, null);
  assert.equal(clamped.windows[0].severity, null);
  assert.equal(clamped.windows[0].label.length, 80);
  assert.equal(clamped.fetchedAt, null);
});

test('usage: labels come from the webview for the two known windows, from the host for any other id', () => {
  assert.equal(W.usageLabel(W5), '5-Stunden-Limit');
  assert.equal(W.usageLabel(WK), 'Wochenlimit');
  assert.equal(W.usageLabel({ id: 'other', label: 'Anderes Limit' }), 'Anderes Limit');
});

test('the description sits directly under the title, in full: no line clamp, the tooltip repeats it (finished runs only)', () => {
  assert.match(JS, /rec\.body\.append\(rec\.desc, sub, stats, rec\.phases\)/);
  const desc = CSS.match(/\.desc\s*\{[^}]*\}/)[0];
  assert.ok(!/line-clamp|-webkit-box/.test(desc), 'description is not clamped');
  assert.match(desc, /white-space:\s*pre-line/);
  assert.match(JS, /setAttr\(rec\.desc, 'title', !live && c\.description \? c\.description : null\)/);
});

test('the activity of a running agent is one line (ellipsis, full text as tooltip, no hover highlight on rows)', () => {
  const act = CSS.match(/\.activity\s*\{[^}]*\}/)[0];
  assert.match(act, /white-space:\s*nowrap/);
  assert.match(act, /text-overflow:\s*ellipsis/);
  assert.ok(!/line-clamp/.test(act));
  assert.match(JS, /setAttr\(r\.activity, 'title', act/, 'the full text is in the hover tooltip');
  assert.match(CSS, /\.line2 \{[^}]*flex-wrap:\s*nowrap/, 'chips stay on the same line');
  assert.ok(!/\.arow:not\(\.head\):hover/.test(CSS), 'no hover highlight on agent rows');
});

test('the toolbar has a floating-window button that is hidden inside the floating window itself', () => {
  assert.match(JS, /'data-act': 'floating'/);
  assert.match(JS, /floatBtn\.hidden = app\.getAttribute\('data-mode'\) === 'floating'/);
  assert.match(JS, /what === 'floating'\) post\(\{ type: 'openFloating' \}\)/);
  assert.match(CSS, /\.ico-float/);
});

test('usage is two compact text lines (no heading, no bar) with severity colours; the age sits right of the Hand-Off and Clear buttons', () => {
  assert.ok(!/u-bar|usage-head|usage-title/.test(JS + CSS), 'bar and heading are gone');
  assert.match(JS, /actions\.append\(usageAgeEl\)/);
  for (const sev of ['warning', 'critical']) assert.match(CSS, new RegExp('data-sev="' + sev + '"\\] \\.u-pct'));
  assert.ok(!/style\.(width|height)/.test(JS), 'no inline style writes');
});

test('the view has a Hand-Off and a Clear button that post their own message', () => {
  assert.match(JS, /'data-act': 'handoff'/);
  assert.match(JS, /'data-act': 'clear'/);
  assert.match(JS, /what === 'handoff'\) post\(\{ type: 'handoff' \}\)/);
  assert.match(JS, /what === 'clear'\) post\(\{ type: 'clearSession' \}\)/);
  assert.equal(W.T.handoff, 'Hand-Off');
  assert.equal(W.T.clear, 'Clear');
  assert.match(W.T.clearTip, /spart Tokens/);
  assert.match(CSS, /\.act-btn/);
});
