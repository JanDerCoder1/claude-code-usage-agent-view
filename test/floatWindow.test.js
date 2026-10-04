'use strict';
// lib/floatWindow.js with fake server, linker and execFile: browser choice, launch arguments, linking, watching, closing.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const PROFILE = path.join(os.tmpdir(), 'agent-view-floatwindow-test-' + process.pid);

const { FloatWindow, findBrowser } = require('../lib/floatWindow');

function setup(o) {
  const x = { launches: [], kills: 0, servers: [], linkers: [], changes: 0, logs: [], messages: [] };
  const opts = Object.assign({
    mediaDir: 'M', profileDir: PROFILE, editorProc: 'Code', theme: () => 'dark', size: () => ({ width: 380, height: 480 }), watchOwner: () => true,
    onMessage: (m) => x.messages.push(m), onChange: () => { x.changes += 1; }, log: (m) => x.logs.push(m), platform: 'win32', graceMs: 30,
    env: { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\L' },
    exists: (p) => /PF86[\\/]Microsoft[\\/]Edge/.test(p),
    execFile: (exe, args, opts2, cb) => {
      const child = { exe, args, cb, killed: 0, kill() { this.killed += 1; x.kills += 1; } };
      x.launches.push(child);
      return child;
    },
    makeServer: (so) => {
      const s = { so, clients: 0, sent: [], started: 0, stopped: 0,
        async start() { s.started += 1; if (x.serverFails) throw new Error('EADDRINUSE'); return { url: 'http://127.0.0.1:5555/tok/', port: 5555 }; },
        broadcast(m) { s.sent.push(m); }, async stop() { s.stopped += 1; } };
      x.servers.push(s);
      return s;
    },
    makeLinker: (auxProc) => {
      const l = { auxProc, calls: [], watchers: [], activated: [],
        async snapshot() { l.calls.push('snapshot'); return x.snap || { ok: true, main: 100, before: [] }; },
        async link(snap, lo) { l.calls.push(['link', snap, lo]); return x.linkResult || { ok: true, aux: 200 }; },
        watch(main, aux, onGone) { const w = { main, aux, onGone, stopped: 0, stop() { w.stopped += 1; } }; l.watchers.push(w); return w; },
        async activate(aux) { l.activated.push(aux); return { ok: true }; } };
      x.linkers.push(l);
      return l;
    },
  }, o);
  return { x, fw: new FloatWindow(opts) };
}

test.after(() => { try { require('fs').rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* temp */ } });

test('findBrowser: Edge first (Program Files x86, then x64, then per user), Chrome as the fallback, null without both', () => {
  const env = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\L' };
  assert.deepEqual(findBrowser(env, () => true), { exe: path.join('C:\\PF86', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), proc: 'msedge' });
  assert.equal(findBrowser(env, (p) => p.includes(path.join('PF', 'Microsoft'))).proc, 'msedge');
  assert.deepEqual(findBrowser(env, (p) => p.includes('chrome.exe') && p.includes('PF86')), { exe: path.join('C:\\PF86', 'Google', 'Chrome', 'Application', 'chrome.exe'), proc: 'chrome' });
  assert.equal(findBrowser(env, () => false), null);
  assert.equal(findBrowser({}, () => true), null, 'no folders known, nothing to look in');
});

test('open: snapshot first, then the server, then the browser in app mode with its own profile, then the link, then the watcher', async () => {
  const { x, fw } = setup();
  const r = await fw.open();
  assert.deepEqual(r, { ok: true, linked: true });
  const l = x.linkers[0];
  assert.equal(l.auxProc, 'msedge');
  assert.equal(l.calls[0], 'snapshot');
  assert.equal(x.servers[0].started, 1);
  assert.equal(x.servers[0].so.theme, 'dark');
  assert.equal(x.servers[0].so.mediaDir, 'M');
  const b = x.launches[0];
  assert.ok(b.exe.endsWith('msedge.exe'));
  assert.deepEqual(b.args, ['--app=http://127.0.0.1:5555/tok/', '--user-data-dir=' + PROFILE, '--no-first-run', '--no-default-browser-check', '--window-size=380,480']);
  assert.equal(l.calls[1][0], 'link');
  assert.deepEqual(l.calls[1][1], { ok: true, main: 100, before: [] });
  assert.deepEqual(l.calls[1][2], { owner: true, width: 380, height: 480 });
  assert.equal(l.watchers.length, 1);
  assert.equal(l.watchers[0].main, 100);
  assert.equal(l.watchers[0].aux, 200);
  assert.equal(fw.isOpen, true);
});

test('open: a size of 0 falls back to 380x480', async () => {
  const { x, fw } = setup({ size: () => ({ width: 0, height: 0 }) });
  await fw.open();
  assert.ok(x.launches[0].args.includes('--window-size=380,480'));
  assert.deepEqual(x.linkers[0].calls[1][2], { owner: true, width: 380, height: 480 });
});

test('open: not on Windows, without a browser or with a server that cannot start nothing is left running', async () => {
  const a = setup({ platform: 'linux' });
  assert.deepEqual(await a.fw.open(), { ok: false, why: 'platform' });
  assert.equal(a.x.launches.length, 0);
  const b = setup({ exists: () => false });
  assert.deepEqual(await b.fw.open(), { ok: false, why: 'no-browser' });
  assert.equal(b.x.servers.length, 0);
  const c = setup();
  c.x.serverFails = true;
  assert.deepEqual(await c.fw.open(), { ok: false, why: 'server' });
  assert.equal(c.x.launches.length, 0);
  assert.equal(c.fw.isOpen, false);
});

test('open: a browser that cannot be started closes the server again and reports it', async () => {
  const { x, fw } = setup({ execFile: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } });
  assert.deepEqual(await fw.open(), { ok: false, why: 'EACCES' });
  assert.equal(x.servers[0].stopped, 1);
  assert.equal(fw.isOpen, false);
});

test('open: a window that could not be linked still opens, reports why, and starts no watcher', async () => {
  const { x, fw } = setup();
  x.linkResult = { ok: false, why: 'ambiguous' };
  const r = await fw.open();
  assert.deepEqual(r, { ok: true, linked: false, linkWhy: 'ambiguous' });
  assert.equal(x.linkers[0].watchers.length, 0);
  assert.equal(fw.isOpen, true);
});

test('open: a failed snapshot is handed on to the link (which then fails by itself) and no watcher starts without a main window', async () => {
  const { x, fw } = setup();
  x.snap = { ok: false, why: 'no-main' };
  x.linkResult = { ok: false, why: 'no-main' };
  const r = await fw.open();
  assert.equal(r.linked, false);
  assert.equal(x.linkers[0].watchers.length, 0);
});

test('open: closeWithVscode off starts no watcher', async () => {
  const { x, fw } = setup({ watchOwner: () => false });
  await fw.open();
  assert.equal(x.linkers[0].watchers.length, 0);
});

test('open while open brings the window forward instead of opening a second one; parallel calls share one run', async () => {
  const { x, fw } = setup();
  const [a, b] = await Promise.all([fw.open(), fw.open()]);
  assert.deepEqual(a, b);
  assert.equal(x.launches.length, 1);
  const again = await fw.open();
  assert.deepEqual(again, { ok: true, already: true, linked: true });
  assert.deepEqual(x.linkers[0].activated, [200]);
  assert.equal(x.launches.length, 1);
});

test('the window going away (watcher ends) closes server, browser process and watcher', async () => {
  const { x, fw } = setup();
  await fw.open();
  const w = x.linkers[0].watchers[0];
  w.onGone();
  await new Promise((r) => setImmediate(r));
  assert.equal(fw.isOpen, false);
  assert.equal(x.servers[0].stopped, 1);
  assert.equal(x.launches[0].killed, 1);
  assert.equal(w.stopped, 1);
  assert.ok(x.logs.includes('Fenster geschlossen'));
  const r = await fw.open();
  assert.equal(r.ok, true);
  assert.equal(x.launches.length, 2, 'opens a fresh window afterwards');
});

test('close(): ends everything, tells the owner via onChange, and is safe twice', async () => {
  const { x, fw } = setup();
  await fw.open();
  const before = x.changes;
  await fw.close();
  await fw.close();
  assert.equal(x.servers[0].stopped, 1);
  assert.equal(x.launches[0].killed, 1);
  assert.ok(x.changes > before);
  assert.equal(fw.visible, false);
});

test('visible follows the connected pages; broadcast goes to the server only while open', async () => {
  const { x, fw } = setup();
  fw.broadcast({ type: 'state' });                      // nothing open: nothing happens
  await fw.open();
  assert.equal(fw.visible, false, 'the page has not connected yet');
  x.servers[0].clients = 1;
  assert.equal(fw.visible, true);
  fw.broadcast({ type: 'state', seq: 1 });
  assert.deepEqual(x.servers[0].sent, [{ type: 'state', seq: 1 }]);
  x.servers[0].so.onMessage({ type: 'ready' });
  assert.deepEqual(x.messages, [{ type: 'ready' }]);
  const c = x.changes;
  x.servers[0].so.onClients(0);
  assert.ok(x.changes > c, 'a change of the connected pages is announced');
});

test('without a link the window counts as closed when no page is connected for the grace time (safety net)', async () => {
  const { x, fw } = setup();
  x.linkResult = { ok: false, why: 'none' };
  await fw.open();
  assert.equal(fw.isOpen, true);
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(fw.isOpen, false);
  assert.equal(x.launches[0].killed, 1);
});

test('with a link a missing page connection never closes the window by itself (the watcher decides)', async () => {
  const { fw } = setup();
  await fw.open();
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(fw.isOpen, true);
  await fw.close();
});

test('a connecting page cancels the grace timer', async () => {
  const { x, fw } = setup();
  x.linkResult = { ok: false, why: 'none' };
  await fw.open();
  x.servers[0].clients = 1;
  x.servers[0].so.onClients(1);
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(fw.isOpen, true);
  await fw.close();
});

test('the browser process exiting early (handing over to a running instance) does not close a linked window', async () => {
  const { x, fw } = setup();
  await fw.open();
  x.launches[0].cb(null);
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(fw.isOpen, true);
  await fw.close();
});
