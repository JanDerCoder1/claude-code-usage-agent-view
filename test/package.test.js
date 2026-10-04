'use strict';
// Manifest, packaging and README checks (SPEC 7.1, 10, 11.6). Nothing here needs VS Code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildVsix, collectFiles } = require('../tools/build-vsix');
const { listZip, readZip } = require('../tools/zip-list');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const extSrc = read('extension.js');
const COMMANDS = ['agentView.open', 'agentView.openFloating', 'agentView.handoff', 'agentView.clearSession', 'agentView.refresh', 'agentView.toggleScope', 'agentView.resetEtaHistory'];

function tmpDir(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function put(root, rel, text) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text === undefined ? rel : text);
}

// ---- manifest -------------------------------------------------------------------------------------------------

test('manifest: identity, engine and activation fields of SPEC 7.1', () => {
  assert.equal(pkg.name, 'claude-code-usage-agent-view');
  assert.equal(pkg.displayName, 'Claude Code Utilities');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.publisher, 'local');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.private, true);
  assert.deepEqual(pkg.categories, ['Other']);
  assert.deepEqual(pkg.extensionKind, ['workspace']);
  assert.equal(pkg.main, './extension.js');
  assert.deepEqual(pkg.activationEvents, ['onStartupFinished', 'onWebviewPanel:agentView.floating']);
  assert.deepEqual(pkg.capabilities, { untrustedWorkspaces: { supported: true }, virtualWorkspaces: false });
  assert.match(pkg.description, /nur lesend/);
});

test('manifest: engines.vscode is a caret range at 1.94 or higher, and below the secondary side bar threshold', () => {
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.engines.vscode);
  assert.ok(m, 'caret range');
  const minor = Number(m[2]);
  assert.equal(m[1], '1');
  assert.ok(minor >= 94, 'at least 1.94');
  assert.ok(minor < 106, 'the default manifest must not need the secondary side bar API');
  assert.equal(pkg.engines.vscode, '^1.94.0');
});

test('manifest: view container only in the activity bar, never a secondarySidebar container', () => {
  const vc = pkg.contributes.viewsContainers;
  assert.deepEqual(Object.keys(vc), ['activitybar']);
  assert.equal(vc.activitybar.length, 1);
  assert.deepEqual(vc.activitybar[0], { id: 'agentView', title: 'Claude Code Utilities', icon: 'media/icon.svg' });
  assert.ok(!JSON.stringify(pkg).includes('secondarySidebar'));
  assert.deepEqual(Object.keys(pkg.contributes.views), ['agentView'], 'views are keyed by the container id');
  assert.deepEqual(pkg.contributes.views.agentView, [{ type: 'webview', id: 'agentView.cards', name: 'Agenten', icon: 'media/icon.svg' }]);
});

test('manifest: the seven commands are declared, with German titles that use proper umlauts', () => {
  const cmds = pkg.contributes.commands;
  assert.deepEqual(cmds.map((c) => c.command).sort(), COMMANDS.slice().sort());
  const title = (id) => cmds.find((c) => c.command === id).title;
  assert.equal(title('agentView.open'), 'Claude Code Utilities: Öffnen');
  assert.equal(title('agentView.openFloating'), 'Claude Code Utilities: In schwebendem Fenster öffnen');
  assert.equal(cmds.find((c) => c.command === 'agentView.openFloating').icon, '$(multiple-windows)');
  assert.equal(title('agentView.handoff'), 'Claude Code Utilities: Hand-Off (Kontext in Markdown-Datei schreiben)');
  assert.equal(title('agentView.clearSession'), 'Claude Code Utilities: Clear (neue Unterhaltung starten)');
  assert.equal(cmds.find((c) => c.command === 'agentView.handoff').icon, '$(export)');
  assert.equal(cmds.find((c) => c.command === 'agentView.clearSession').icon, '$(clear-all)');
  assert.equal(title('agentView.refresh'), 'Claude Code Utilities: Aktualisieren');
  assert.equal(title('agentView.toggleScope'), 'Claude Code Utilities: Arbeitsbereich / Alle Sitzungen');
  assert.equal(title('agentView.resetEtaHistory'), 'Claude Code Utilities: Zeitschätzungs-Verlauf löschen');
  assert.equal(cmds.find((c) => c.command === 'agentView.refresh').icon, '$(refresh)');
  assert.equal(cmds.find((c) => c.command === 'agentView.toggleScope').icon, '$(filter)');
  const texts = JSON.stringify(pkg.contributes) + pkg.description;
  assert.ok(!/Oeffn|Loesch|Schaetz|Eintraege|Ueberschreib|Laeuft|Aenderung/.test(texts), 'no ASCII transliterations of umlauts');
});

test('manifest: title menu entries use declared commands and the view id', () => {
  const items = pkg.contributes.menus['view/title'];
  assert.deepEqual(items.map((i) => i.command).sort(), ['agentView.clearSession', 'agentView.handoff', 'agentView.openFloating', 'agentView.refresh', 'agentView.toggleScope']);
  assert.equal(items.find((i) => i.command === 'agentView.openFloating').group, 'navigation@0', 'the new button comes first');
  for (const i of items) {
    assert.ok(COMMANDS.includes(i.command));
    assert.equal(i.when, 'view == agentView.cards');
    assert.match(i.group, /^navigation@\d$/);
  }
});

test('manifest: configuration keys, defaults and limits', () => {
  const props = pkg.contributes.configuration.properties;
  const pick = (k) => { const { type, default: d, minimum, enum: e } = props[k]; return { type, default: d, minimum, enum: e }; };
  assert.deepEqual(Object.keys(props).sort(), [
    'agentView.claudeHome', 'agentView.eta.enabled', 'agentView.floating.closeWithVscode', 'agentView.floating.height', 'agentView.floating.width', 'agentView.pollMs', 'agentView.recentHours',
    'agentView.scope', 'agentView.showToolTargets', 'agentView.staleMinutes', 'agentView.usage.autoRefreshMinutes', 'agentView.usage.enabled',
  ]);
  assert.deepEqual(pick('agentView.scope'), { type: 'string', default: 'workspace', minimum: undefined, enum: ['workspace', 'all'] });
  assert.deepEqual(pick('agentView.recentHours'), { type: 'number', default: 24, minimum: 1, enum: undefined });
  assert.deepEqual(pick('agentView.claudeHome'), { type: 'string', default: '', minimum: undefined, enum: undefined });
  assert.deepEqual(pick('agentView.showToolTargets'), { type: 'boolean', default: true, minimum: undefined, enum: undefined });
  assert.deepEqual(pick('agentView.pollMs'), { type: 'number', default: 1500, minimum: 500, enum: undefined });
  assert.deepEqual(pick('agentView.staleMinutes'), { type: 'number', default: 10, minimum: 2, enum: undefined });
  assert.deepEqual(pick('agentView.eta.enabled'), { type: 'boolean', default: true, minimum: undefined, enum: undefined });
  assert.deepEqual(pick('agentView.usage.autoRefreshMinutes'), { type: 'number', default: 5, minimum: 0, enum: undefined });
  assert.deepEqual(pick('agentView.usage.enabled'), { type: 'boolean', default: true, minimum: undefined, enum: undefined });
  assert.deepEqual(pick('agentView.floating.closeWithVscode'), { type: 'boolean', default: true, minimum: undefined, enum: undefined });
  assert.deepEqual(pick('agentView.floating.width'), { type: 'number', default: 380, minimum: 0, enum: undefined });
  assert.deepEqual(pick('agentView.floating.height'), { type: 'number', default: 480, minimum: 0, enum: undefined });
  for (const [k, v] of Object.entries(props)) assert.ok(v.description && v.description.length > 5, `${k} has a description`);
});

// ---- manifest <-> extension.js ----------------------------------------------------------------------------------

test('every declared command is registered in extension.js and nothing undeclared is registered', () => {
  const registered = [...extSrc.matchAll(/registerCommand\(\s*'([\w.]+)'/g)].map((m) => m[1]);
  assert.deepEqual(registered.sort(), COMMANDS.slice().sort());
  for (const c of pkg.contributes.commands) assert.ok(registered.includes(c.command), c.command);
});

test('extension.js registers the view id declared in the manifest', () => {
  const m = /const VIEW_ID = '([\w.]+)'/.exec(extSrc);
  assert.ok(m);
  assert.equal(m[1], pkg.contributes.views.agentView[0].id);
  assert.match(extSrc, /registerWebviewViewProvider\(VIEW_ID,\s*this\.provider\)/, 'no options: retainContextWhenHidden stays off');
  assert.ok(!/webviewOptions|retainContextWhenHidden\s*:/.test(extSrc));
});

test('extension.js reads exactly the declared settings', () => {
  const declared = Object.keys(pkg.contributes.configuration.properties).map((k) => k.replace(/^agentView\./, '')).sort();
  const read2 = [...new Set([...extSrc.matchAll(/(?:cfg\.get|num)\('([\w.]+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(read2, declared);
  assert.match(extSrc, /const SECTION = 'agentView'/);
});

test('extension.js only requires the editor API, node core modules and ./lib modules', () => {
  const mods = [...extSrc.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  const allowed = new Set(['vscode', 'crypto', 'fs', 'os', 'path']);
  for (const m of mods) assert.ok(allowed.has(m) || /^\.\/lib\/\w+$/.test(m), `unexpected require: ${m}`);
  for (const lib of ['claudeHome', 'sessionModel', 'history', 'poller']) assert.ok(mods.includes('./lib/' + lib), lib);
});

test('main file and icons referenced by the manifest exist (icons: skipped while media/ is still empty)', (t) => {
  assert.ok(fs.existsSync(path.join(ROOT, pkg.main)));
  const icon = pkg.contributes.viewsContainers.activitybar[0].icon;
  if (!fs.existsSync(path.join(ROOT, icon))) { t.skip(`${icon} is written by the webview builder`); return; }
  assert.ok(fs.statSync(path.join(ROOT, icon)).size > 0);
});

// ---- forbidden APIs (own files; the integration run greps the whole tree) -----------------------------------------

test('own files satisfy the global rules: no forbidden API, no secrets-related names', () => {
  const strict = /eval|new Function|\bvm\b|child_process|https?|innerHTML|outerHTML|document\.write|\.key|\.lock|credentials/;
  for (const rel of ['extension.js', 'lib/poller.js']) {
    const lines = read(rel).split('\n');
    lines.forEach((l, i) => assert.ok(!strict.test(l), `${rel}:${i + 1} matches the forbidden pattern: ${l.trim()}`));
    assert.ok(!read(rel).includes('\r'), `${rel} uses LF`);
    assert.ok(!read(rel).startsWith('\uFEFF'), `${rel} has no BOM`);
  }
  assert.ok(!/require\('vscode'\)/.test(read('lib/poller.js')), 'only extension.js may import the editor API');
  assert.ok(read('lib/poller.js').split('\n').length < 700 && extSrc.split('\n').length < 900);
});

// ---- whole shipped tree (integration gate: CONTRACT global rules, SPEC 11.6) --------------------------------------

const SHIPPED = (() => {
  const out = ['extension.js'];
  for (const dir of ['lib', 'media']) for (const n of fs.readdirSync(path.join(ROOT, dir)).sort()) if (/\.(js|css|svg)$/.test(n)) out.push(dir + '/' + n);
  return out;
})();

test('shipped files (lib/, extension.js, media/): no forbidden API, no secret-file names, UTF-8 with LF and no BOM', () => {
  const api = /\beval\b|new\s+Function|\bvm\b|child_process|https?|innerHTML|outerHTML|document\.write/;
  const processFiles = ['lib/usageRefresh.js', 'lib/windowLink.js', 'lib/floatWindow.js'];
  const serverFile = 'lib/floatServer.js';             // loopback page server (see its own test)
  const apiRefresh = /\beval\b|new\s+Function|\bvm\b|https?|innerHTML|outerHTML|document\.write/; // lib/usageRefresh.js may start a process (see its own test)
  // `.key` and `.lock` are only a problem as FILE names (token, IDE lock); property accesses like `card.key` are fine
  const secretFile = /['"`][^'"`\n]*\.(?:key|lock)['"`]|credentials/i;
  for (const rel of SHIPPED) {
    const text = read(rel);
    assert.ok(!text.includes('\r'), rel + ' uses LF');
    assert.ok(!text.startsWith('﻿'), rel + ' has no BOM');
    text.split('\n').forEach((l, i) => {
      assert.ok(!(processFiles.includes(rel) ? apiRefresh : rel === serverFile ? /\beval\b|new\s+Function|\bvm\b|child_process|innerHTML|outerHTML|document\.write/ : api).test(l), `${rel}:${i + 1} forbidden API: ${l.trim()}`);
      assert.ok(!secretFile.test(l), `${rel}:${i + 1} names a secret-bearing file: ${l.trim()}`);
    });
  }
  assert.ok(SHIPPED.length >= 15, 'the gate really covers the tree (' + SHIPPED.length + ' files)');
});

test('shipped code requires only node core modules and ./lib modules; only extension.js imports the editor API', () => {
  const core = new Set(['fs', 'path', 'os', 'crypto']);
  for (const rel of SHIPPED.filter((f) => f.endsWith('.js'))) {
    const allowed = rel === 'lib/usageRefresh.js' ? new Set([...core, 'child_process']) : rel === 'lib/windowLink.js' ? new Set(['child_process']) : rel === 'lib/floatWindow.js' ? new Set([...core, 'child_process']) : rel === 'lib/floatServer.js' ? new Set([...core, 'http']) : core;
    const text = read(rel);
    for (const m of text.matchAll(/require\(\s*(['"`])([^'"`]+)\1\s*\)/g)) {
      const mod = m[2];
      if (mod === 'vscode') { assert.equal(rel, 'extension.js', rel + ' must not import the editor API'); continue; }
      assert.ok(allowed.has(mod) || /^\.\.?\//.test(mod), `${rel} requires "${mod}"`);
    }
    assert.ok(!/\bimport\s+[\w{*]/.test(text) || rel === 'media/main.js', rel + ' is CommonJS');
  }
});

test('shipped code stays reviewable: no file in lib/, extension.js or media/ exceeds 1000 lines', () => {
  const rows = SHIPPED.map((rel) => [rel, read(rel).split('\n').length]).sort((a, b) => b[1] - a[1]);
  for (const [rel, n] of rows) assert.ok(n <= 1000, `${rel} has ${n} lines`);
  console.log('# longest shipped file: ' + rows[0][0] + ' (' + rows[0][1] + ' lines)');
});

// ---- README ----------------------------------------------------------------------------------------------------

test('docs/ANLEITUNG.md is German, lists the settings, the commands and the privacy statement', () => {
  const md = read('docs/ANLEITUNG.md');
  for (const h of ['## Installation', '## Datenschutz', '## Bekannte Grenzen', '## Einstellungen']) assert.ok(md.includes(h), h);
  assert.match(md, /[äöü]/);
  assert.ok(!/fuer |Oeffn|loesch|Schaetz|Aenderung|Ueber/.test(md), 'no ASCII transliterations');
  for (const k of Object.keys(pkg.contributes.configuration.properties)) assert.ok(md.includes('`' + k + '`'), `${k} documented`);
  for (const c of pkg.contributes.commands) assert.ok(md.includes(c.title), `${c.title} documented`);
  assert.ok(md.includes('View: Move View'));
  assert.ok(md.includes('New Secondary Side Bar Entry'));
  assert.match(md, /Nur lesend/);
  assert.match(md, /kein Netzwerk/);
  assert.match(md, /Kontextgröße, nicht die kumulierte Summe/);
  assert.match(md, /Die Restzeit ist eine Spanne, keine Zusage/);
  assert.ok(!/jans[m]|Unternehmung/.test(md), 'no personal paths in a document that goes public');
});

test('README (the short GitHub front page): sections, screenshot, links that resolve, install commands in their own blocks, no personal paths', () => {
  const md = read('README.md');
  for (const h of ['## Was es kann', '## Installation', '## Benutzung', '## Hinweise', '## Lizenz']) assert.ok(md.includes(h), h);
  assert.ok(md.startsWith('# Claude Code Utilities'));
  assert.match(md, /[äöü]/);
  assert.ok(!/fuer |Oeffn|loesch|Schaetz|Aenderung|Ueber/.test(md), 'no ASCII transliterations');
  assert.ok(!/jans[m]|Unternehmung|C:\\/.test(md), 'no personal or machine-specific paths');
  assert.ok(md.split('\n').length <= 70, 'the front page stays short (details live in docs/ANLEITUNG.md)');
  // every relative link and image points at a file of the repository, anchors at a heading of the target
  for (const m of md.matchAll(/\]\((?!https?:|#)([^)#]+)(?:#([^)]*))?\)/g)) {
    const file = path.join(ROOT, m[1]);
    assert.ok(fs.existsSync(file), 'broken link: ' + m[1]);
    if (m[2]) {
      const slugs = fs.readFileSync(file, 'utf8').split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => l.replace(/^#+ /, '').toLowerCase().replace(/[^a-z0-9äöüß -]/g, '').trim().replace(/ /g, '-'));
      assert.ok(slugs.includes(m[2]), 'broken anchor: ' + m[1] + '#' + m[2]);
    }
  }
  assert.match(md, /!\[[^\]]+\]\(docs\/images\/ansicht\.png\)/);
  assert.ok(fs.statSync(path.join(ROOT, 'docs/images/ansicht.png')).size > 5000);
  assert.ok(md.includes('/handoff') && md.includes('/clear') && md.includes('docs/handoff-command.md'));
  assert.match(md, /127\.0\.0\.1/);
  assert.match(md, /Nur lesend, nur lokal/);
  assert.match(md, /## Lizenz\n\nMIT, siehe \[LICENSE\]\(LICENSE\)/);
  const lic = read('LICENSE');
  assert.ok(lic.startsWith('MIT License\n\nCopyright (c) 2026 '), 'MIT text with year and holder');
  assert.ok(lic.includes('Permission is hereby granted, free of charge') && lic.includes('THE SOFTWARE IS PROVIDED "AS IS"'));
  const v = pkg.version;
  assert.ok(md.includes('code --install-extension claude-code-usage-agent-view-' + v + '.vsix'), 'release install command names the current version');
  const b2 = md.split('**Selbst bauen**')[1].split('\n## ')[0];
  const blocks = [...b2.matchAll(/```powershell\n([\s\S]*?)\n```/g)];
  assert.deepEqual(blocks.slice(0, 4).map((x) => x[1]), [
    'git clone https://github.com/JanDerCoder1/claude-code-usage-agent-view.git',
    'cd claude-code-usage-agent-view',
    'node tools/build-vsix.js . dist/claude-code-usage-agent-view-' + v + '.vsix',
    'code --install-extension dist/claude-code-usage-agent-view-' + v + '.vsix',
  ]);
  for (const x of blocks.slice(0, 4)) assert.ok(!x[1].includes('\n') && !x[1].includes('#'), 'one command, no comment');
  for (let i = 0; i < 3; i++) assert.equal(b2.slice(blocks[i].index + blocks[i][0].length, blocks[i + 1].index).trim(), '', `nothing between block ${i + 1} and ${i + 2}`);
});

// ---- packaging -------------------------------------------------------------------------------------------------

const ALLOWED_ENTRY = /^(\[Content_Types\]\.xml|extension\.vsixmanifest|extension\/(package\.json|extension\.js|README\.md|LICENSE|lib\/[^/]+\.js|media\/.+))$/;
const FORBIDDEN_ENTRY = /(^|\/)(test|tools|dist|docs|\.tmp|fixtures?|node_modules|\.git)\/|\.vsix$|\.test\.js$/;

test('build of the real project: only package.json, extension.js, lib/*.js, media/*, README.md; 0 CRC errors; no backslashes', (t) => {
  const out = path.join(tmpDir(t, 'agent-view-build-'), 'agent-view.vsix');
  const r = buildVsix({ src: ROOT, out });
  assert.deepEqual(r.notIncluded, [], 'no stray files next to the package content');
  const z = listZip(fs.readFileSync(out));
  assert.equal(z.badCrc, 0);
  assert.equal(z.backslash, 0);
  const names = z.entries.map((e) => e.name);
  assert.deepEqual(names, r.entries);
  for (const n of names) {
    assert.match(n, ALLOWED_ENTRY, `unexpected entry ${n}`);
    assert.ok(!FORBIDDEN_ENTRY.test(n), `forbidden entry ${n}`);
    if (/\.md$/.test(n)) assert.equal(n, 'extension/README.md');
  }
  for (const must of ['[Content_Types].xml', 'extension.vsixmanifest', 'extension/package.json', 'extension/extension.js', 'extension/lib/poller.js', 'extension/README.md']) {
    assert.ok(names.includes(must), must);
  }
  const entries = readZip(fs.readFileSync(out));
  const get = (n) => entries.find((e) => e.name === n).data;
  assert.deepEqual(get('extension/package.json'), fs.readFileSync(path.join(ROOT, 'package.json')), 'package.json is shipped byte for byte');
  const manifest = get('extension.vsixmanifest').toString('utf8');
  assert.match(manifest, new RegExp(`Id="claude-code-usage-agent-view" Version="${pkg.version.replace(/\./g, '\\.')}" Publisher="local"`));
  assert.match(manifest, /Microsoft\.VisualStudio\.Code\.Engine" Value="\^1\.94\.0"/);
  assert.match(manifest, /ExtensionKind" Value="workspace"/);
  assert.match(manifest, /Path="extension\/README\.md"/);
  assert.match(get('[Content_Types].xml').toString('utf8'), /Extension="\.js" ContentType="application\/javascript"/);
});

test('build with a synthetic tree: exclusions and the allow-list', (t) => {
  const src = tmpDir(t, 'agent-view-src-');
  const pj = { name: 'demo', version: '1.2.3', publisher: 'local', engines: { vscode: '^1.94.0' }, main: './extension.js',
    contributes: { viewsContainers: { activitybar: [{ id: 'c', title: 'T', icon: 'media/icon.svg' }] }, views: { c: [{ id: 'v', name: 'V', icon: 'media/icon.svg' }] } } };
  put(src, 'package.json', JSON.stringify(pj));
  for (const f of ['extension.js', 'README.md', 'lib/a.js', 'lib/b.js', 'media/main.js', 'media/main.css', 'media/icon.svg', 'media/sub/x.png']) put(src, f);
  const noise = [
    'CHANGELOG.md', 'notes.md', 'docs/CONTRACT.md', 'lib/b.test.js', 'lib/sub/deep.js', 'lib/fixtures/z.js', 'media/README.md',
    'test/a.test.js', 'test/fixtures/agents/x.jsonl', 'tools/build.js', 'dist/old.vsix', '.tmp/x', 'node_modules/m/index.js',
    '.git/config', 'fixtures/f.json', 'old.vsix', '.vscode/settings.json', 'package-lock.json', '.vscodeignore', 'stray.txt', 'lib/data.json',
  ];
  for (const f of noise) put(src, f);
  const out = path.join(src, 'dist', 'demo.vsix');
  const r = buildVsix({ src, out });
  assert.deepEqual(r.entries.slice(0, 2), ['[Content_Types].xml', 'extension.vsixmanifest']);
  const names = r.entries.filter((n) => n.startsWith('extension/')).map((n) => n.slice('extension/'.length)).sort();
  assert.deepEqual(names, ['README.md', 'extension.js', 'lib/a.js', 'lib/b.js', 'media/icon.svg', 'media/main.css', 'media/main.js', 'media/sub/x.png', 'package.json']);
  assert.deepEqual(r.notIncluded, ['lib/data.json', 'lib/sub/deep.js', 'stray.txt'], 'what the allow-list rejects is reported, not silently dropped');
  assert.deepEqual(r.warnings, []);
  assert.equal(listZip(fs.readFileSync(out)).badCrc, 0);
  assert.equal(r.pkg.version, '1.2.3');
  assert.equal(path.basename(buildVsix({ src, out: path.join(src, 'dist', 'x.vsix') }).out), 'x.vsix');
  assert.equal(path.basename(buildVsix({ src }).out), 'demo-1.2.3.vsix', 'default file name');
  assert.equal(path.basename(buildVsix({ src, secondary: true }).out), 'demo-1.2.3-secondary.vsix', 'default name of the secondary variant');
  assert.ok(!collectFiles(src).files.some((f) => f.endsWith('.vsix')), 'built packages never end up inside the next package');
});

test('build ignores symbolic links and special files', (t) => {
  const src = tmpDir(t, 'agent-view-link-');
  put(src, 'package.json', JSON.stringify({ name: 'demo', version: '1.0.0', publisher: 'local', engines: { vscode: '^1.94.0' }, main: './extension.js' }));
  put(src, 'extension.js');
  const outside = tmpDir(t, 'agent-view-outside-');
  put(outside, 'secret.js', 'secret');
  let linked = false;
  try { fs.symlinkSync(outside, path.join(src, 'lib'), 'junction'); linked = true; } catch (e) { /* no permission */ }
  const names = collectFiles(src).files;
  assert.ok(!names.some((n) => n.startsWith('lib/')), linked ? 'linked directory is not followed' : 'nothing to follow');
});

test('build fails clearly when package.json, main or required fields are missing', (t) => {
  const empty = tmpDir(t, 'agent-view-empty-');
  assert.throws(() => buildVsix({ src: empty }), /package\.json missing/);
  const noMain = tmpDir(t, 'agent-view-nomain-');
  put(noMain, 'package.json', JSON.stringify({ name: 'd', version: '1.0.0', publisher: 'p', engines: { vscode: '^1.94.0' }, main: './extension.js' }));
  assert.throws(() => buildVsix({ src: noMain }), /main file "extension\.js" is not part of the package/);
  const noEngine = tmpDir(t, 'agent-view-noengine-');
  put(noEngine, 'package.json', JSON.stringify({ name: 'd', version: '1.0.0', publisher: 'p' }));
  assert.throws(() => buildVsix({ src: noEngine }), /needs name, publisher, version, engines\.vscode/);
});

test('build warns about a manifest icon that is not part of the package', (t) => {
  const src = tmpDir(t, 'agent-view-icon-');
  put(src, 'package.json', JSON.stringify({ name: 'd', version: '1.0.0', publisher: 'p', engines: { vscode: '^1.94.0' }, main: './extension.js',
    contributes: { viewsContainers: { activitybar: [{ id: 'c', title: 'T', icon: 'media/icon.svg' }] } } }));
  put(src, 'extension.js');
  const r = buildVsix({ src, out: path.join(src, 'out.vsix') });
  assert.deepEqual(r.warnings, ['icon "media/icon.svg" is not part of the package']);
});

test('build --secondary swaps the container and raises the engine; the default build never contains it', (t) => {
  const dir = tmpDir(t, 'agent-view-sec-');
  const normal = buildVsix({ src: ROOT, out: path.join(dir, 'n.vsix') });
  const sec = buildVsix({ src: ROOT, out: path.join(dir, 's.vsix'), secondary: true });
  const pkgOf = (file) => JSON.parse(readZip(fs.readFileSync(file)).find((e) => e.name === 'extension/package.json').data.toString('utf8'));
  const n = pkgOf(normal.out);
  const s = pkgOf(sec.out);
  assert.ok(n.contributes.viewsContainers.activitybar);
  assert.ok(!n.contributes.viewsContainers.secondarySidebar);
  assert.equal(n.engines.vscode, '^1.94.0');
  assert.deepEqual(Object.keys(s.contributes.viewsContainers), ['secondarySidebar'], 'never both containers');
  assert.deepEqual(s.contributes.viewsContainers.secondarySidebar, pkg.contributes.viewsContainers.activitybar);
  assert.equal(s.engines.vscode, '^1.106.0');
  assert.deepEqual(s.contributes.views, pkg.contributes.views);
  const manifest = readZip(fs.readFileSync(sec.out)).find((e) => e.name === 'extension.vsixmanifest').data.toString('utf8');
  assert.match(manifest, /Microsoft\.VisualStudio\.Code\.Engine" Value="\^1\.106\.0"/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).engines.vscode, '^1.94.0', 'the source manifest is untouched');
});

test('the command line tools work end to end: build-vsix, then zip-list (exit codes and last line)', (t) => {
  const dir = tmpDir(t, 'agent-view-cli-');
  const out = path.join(dir, 'cli', 'agent-view.vsix');
  const b = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-vsix.js'), ROOT, out], { encoding: 'utf8' });
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stdout, /^wrote .*agent-view\.vsix \(\d+ bytes, \d+ entries\)/);
  assert.ok(b.stdout.includes('  extension/extension.js'));
  const l = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'zip-list.js'), out], { encoding: 'utf8' });
  assert.equal(l.status, 0, l.stderr);
  const last = l.stdout.trim().split('\n').pop();
  assert.match(last, /^\d+ entries, 0 crc errors, 0 names containing backslash$/);
  assert.ok(l.stdout.includes('"extension/package.json"'));
  assert.ok(!/CRC-BAD/.test(l.stdout));
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-vsix.js'), dir], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /package\.json missing/);
  const notZip = path.join(dir, 'x.vsix');
  fs.writeFileSync(notZip, 'definitely not a zip file, just text');
  const nz = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'zip-list.js'), notZip], { encoding: 'utf8' });
  assert.equal(nz.status, 1);
  assert.match(nz.stderr, /not a zip/);
});

test('zip-list detects a corrupted entry and backslash names', (t) => {
  const dir = tmpDir(t, 'agent-view-zip-');
  const out = path.join(dir, 'ok.vsix');
  buildVsix({ src: ROOT, out });
  const buf = fs.readFileSync(out);
  const good = listZip(buf);
  assert.equal(good.badCrc, 0);
  // flip one payload byte of the first stored/deflated entry that is not tiny
  const damaged = Buffer.from(buf);
  const lhNameLen = damaged.readUInt16LE(26);
  const lhExtraLen = damaged.readUInt16LE(28);
  const csize = damaged.readUInt32LE(18);
  damaged[30 + lhNameLen + lhExtraLen + Math.floor(csize / 2)] ^= 0xff;
  let bad;
  try { bad = listZip(damaged).badCrc; } catch (e) { bad = 1; } // inflate may reject the damaged stream outright
  assert.ok(bad >= 1, 'corruption is noticed');
});

test('the one place that starts a process: execFile only, no shell, fixed arguments, no eval-like use', () => {
  const src = read('lib/usageRefresh.js');
  assert.deepEqual([...src.matchAll(/require\('([^']+)'\)/g)].map((x) => x[1]).sort(), ['child_process', 'os']);
  assert.match(src, /const \{ execFile \} = require\('child_process'\)/);
  assert.ok(!/\bspawn\b|\bexec\(|execSync|spawnSync|fork\(|shell\s*:/.test(src), 'no shell and no other process API');
  assert.match(src, /ARGS = Object\.freeze\(\['-p', '\/usage', '--no-session-persistence', '--setting-sources', 'project'\]\)/);
  for (const rel of SHIPPED) if (!['lib/usageRefresh.js', 'lib/windowLink.js', 'lib/floatWindow.js'].includes(rel)) assert.ok(!/child_process/.test(read(rel)), rel + ' must not start processes');
});

test('lib/windowLink.js: execFile of powershell.exe only, no shell, constant scripts, only numbers and the process name handed over', () => {
  const src = read('lib/windowLink.js');
  assert.deepEqual([...src.matchAll(/require\('([^']+)'\)/g)].map((x) => x[1]), ['child_process']);
  assert.ok(!/\bspawn\b|\bexec\(|execSync|spawnSync|fork\(|shell\s*:/.test(src));
  assert.match(src, /this\._exec\('powershell\.exe', \['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script\]/);
  assert.ok(/AV_MAIN: String\(snap\.main\)/.test(src) && /AV_BEFORE: snap\.before\.join\(','\)/.test(src));
  assert.ok(/Number\.isSafeInteger/.test(src), 'window handles are validated as integers');
});

test('lib/floatWindow.js: only execFile of the browser, no shell; lib/floatServer.js: loopback only', () => {
  const fw = read('lib/floatWindow.js');
  assert.match(fw, /const \{ execFile \} = require\('child_process'\)/);
  assert.ok(!/\bspawn\b|\bexec\(|execSync|spawnSync|fork\(|shell\s*:/.test(fw));
  const sv = read('lib/floatServer.js');
  assert.match(sv, /server\.listen\(0, '127\.0\.0\.1'/);
  assert.ok(!/0\.0\.0\.0|'::'|listen\(\s*\d{2,5}\b/.test(sv), 'never bound to a public interface or a fixed port');
  assert.ok(!/require\('https'\)|createServer\(\{/.test(sv));
  assert.ok(!/Access-Control-Allow-Origin/i.test(sv), 'no CORS: other pages cannot read it');
});
