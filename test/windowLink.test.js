'use strict';
// lib/windowLink.js with an injected execFile: what it asks PowerShell, how it parses the answer, retries, failures.
const test = require('node:test');
const assert = require('node:assert/strict');
const { WindowLinker, PS_SNAPSHOT, PS_LINK, PS_WATCH, PS_ACTIVATE, RETRIES } = require('../lib/windowLink');

function fakeExec(answers) {
  const f = { calls: [] };
  f.fn = (bin, args, opts, cb) => {
    f.calls.push({ bin, args, opts });
    const a = answers.length > 1 ? answers.shift() : answers[0];
    const child = { stdin: { end() {} } };
    setImmediate(() => (a instanceof Error ? cb(a) : cb(null, typeof a === 'string' ? a : JSON.stringify(a) + '\r\n', '')));
    return child;
  };
  return f;
}
const mk = (answers, o) => { const x = fakeExec(answers); return { x, l: new WindowLinker(Object.assign({ procName: 'Code', platform: 'win32', execFile: x.fn, retryMs: 1 }, o)) }; };

test('snapshot: runs the fixed script for the editor process and returns the foreground window and the known windows', async () => {
  const { x, l } = mk([{ ok: true, main: 4242, before: [4242, 77] }]);
  const r = await l.snapshot();
  assert.deepEqual(r, { ok: true, main: 4242, before: [4242, 77] });
  const c = x.calls[0];
  assert.equal(c.bin, 'powershell.exe');
  assert.deepEqual(c.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
  assert.equal(c.args[5], PS_SNAPSHOT);
  assert.equal(c.opts.env.AV_PROC, 'Code');
  assert.equal(c.opts.windowsHide, true);
  assert.ok(!('shell' in c.opts));
});

test('snapshot: a single window comes as a number, not an array; foreground that is not an editor window is "no-main"', async () => {
  assert.deepEqual(await mk([{ ok: true, main: 5, before: 5 }]).l.snapshot(), { ok: true, main: 5, before: [5] });
  assert.deepEqual(await mk([{ ok: false, main: 0, before: [1] }]).l.snapshot(), { ok: false, why: 'no-main' });
  assert.deepEqual(await mk([{ ok: true, main: 0, before: [1] }]).l.snapshot(), { ok: false, why: 'no-main' });
});

test('not on Windows or with an odd process name nothing is started', async () => {
  const a = mk([{ ok: true }], { platform: 'linux' });
  assert.deepEqual(await a.l.snapshot(), { ok: false, why: 'platform' });
  assert.equal(a.x.calls.length, 0);
  for (const bad of ['', 'a;b', 'x\ny', '$(calc)', 'a'.repeat(50), undefined]) {
    const b = mk([{ ok: true }], { procName: bad });
    assert.deepEqual(await b.l.snapshot(), { ok: false, why: 'process' }, String(bad));
    assert.equal(b.x.calls.length, 0);
  }
});

test('link: hands over only numbers through the environment, never through the script text', async () => {
  const { x, l } = mk([{ ok: true, aux: 9 }]);
  const r = await l.link({ ok: true, main: 4242, before: [4242, 77] }, { owner: true, width: 380, height: 480 });
  assert.deepEqual(r, { ok: true, place: '', aux: 9 });
  assert.equal(x.calls[0].opts.env.AV_OWNER, '1');
  assert.equal(x.calls[0].opts.env.AV_W, '380');
  assert.equal(x.calls[0].opts.env.AV_H, '480');
  const c = x.calls[0];
  assert.equal(c.args[5], PS_LINK);
  assert.equal(c.opts.env.AV_MAIN, '4242');
  assert.equal(c.opts.env.AV_BEFORE, '4242,77');
  assert.equal(c.opts.env.AV_PROC, 'Code');
  assert.ok(!c.args[5].includes('4242'));
});

test('link: waits for the new window (why "none") up to the retry limit, then gives up; other failures stop at once', async () => {
  const a = mk([{ ok: false, why: 'none' }]);
  assert.deepEqual(await a.l.link({ ok: true, main: 1, before: [1] }), { ok: false, why: 'none' });
  assert.equal(a.x.calls.length, RETRIES);
  const b = mk([{ ok: false, why: 'none' }, { ok: false, why: 'none' }, { ok: true }]);
  assert.deepEqual(await b.l.link({ ok: true, main: 1, before: [1] }), { ok: true, place: '' });
  assert.equal(b.x.calls.length, 3);
  const c = mk([{ ok: false, why: 'ambiguous' }]);
  assert.deepEqual(await c.l.link({ ok: true, main: 1, before: [1] }), { ok: false, why: 'ambiguous' });
  assert.equal(c.x.calls.length, 1);
  const d = mk([{ ok: false, why: 'refused' }]);
  assert.deepEqual(await d.l.link({ ok: true, main: 1, before: [1] }), { ok: false, why: 'refused' });
});

test('link without a usable snapshot does nothing', async () => {
  const { x, l } = mk([{ ok: true }]);
  assert.deepEqual(await l.link(null), { ok: false, why: 'no-snapshot' });
  assert.deepEqual(await l.link({ ok: false, why: 'platform' }), { ok: false, why: 'platform' });
  assert.equal(x.calls.length, 0);
});

test('PowerShell failures and garbage output become results; nothing throws or rejects', async () => {
  assert.deepEqual(await mk([Object.assign(new Error('x'), { code: 'ENOENT' })]).l.snapshot(), { ok: false, why: 'ENOENT' });
  assert.deepEqual(await mk(['kein json\r\n']).l.snapshot(), { ok: false, why: 'output' });
  assert.deepEqual(await mk(['null']).l.snapshot(), { ok: false, why: 'output' });
  assert.deepEqual(await mk(['[1,2]']).l.snapshot(), { ok: false, why: 'no-main' });
  assert.deepEqual(await mk(['']).l.snapshot(), { ok: false, why: 'output' });
  const boom = new WindowLinker({ procName: 'Code', platform: 'win32', execFile: () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); } });
  assert.deepEqual(await boom.snapshot(), { ok: false, why: 'EACCES' });
  assert.deepEqual(await mk([{ ok: true, main: 'x', before: ['a', -1, 1.5] }]).l.snapshot(), { ok: false, why: 'no-main' });
  const filtered = await mk([{ ok: true, main: 7, before: [7, 'x', -1, 1.5, 9] }]).l.snapshot();
  assert.deepEqual(filtered.before, [7, 9], 'only positive integers survive');
});

test('the scripts call exactly the documented Win32 functions and nothing that starts or injects code', () => {
  for (const ps of [PS_SNAPSHOT, PS_LINK]) {
    assert.ok(!/Invoke-Expression|iex |Start-Process|DownloadString|WebClient|Invoke-WebRequest|\.exe['"]/i.test(ps));
    assert.ok(/GWLP|-8/.test(PS_LINK));
  }
  assert.match(PS_LINK, /SetOwner\(\$new\[0\], \$main\)/);
  assert.match(PS_LINK, /Owner\(\$new\[0\]\) -ne \$main/, 'the result is verified, not assumed');
});

test('link: owner and size are optional; sizes outside 200..4000 or not integers are dropped to 0 (no resize)', async () => {
  const a = mk([{ ok: true }]);
  await a.l.link({ ok: true, main: 1, before: [1] });
  assert.equal(a.x.calls[0].opts.env.AV_OWNER, '0');
  assert.equal(a.x.calls[0].opts.env.AV_W, '0');
  assert.equal(a.x.calls[0].opts.env.AV_H, '0');
  for (const bad of [199, 4001, -5, 380.5, '380', null, NaN, 1e12]) {
    const b = mk([{ ok: true }]);
    await b.l.link({ ok: true, main: 1, before: [1] }, { owner: true, width: bad, height: bad });
    assert.equal(b.x.calls[0].opts.env.AV_W, '0', String(bad));
  }
  const c = mk([{ ok: true }]);
  await c.l.link({ ok: true, main: 1, before: [1] }, { owner: 'yes', width: 400, height: 500 });
  assert.equal(c.x.calls[0].opts.env.AV_OWNER, '0', 'only the boolean true links');
});

test('link: a placement problem is reported back but the window counts as linked', async () => {
  assert.deepEqual(await mk([{ ok: true, place: 'pos' }]).l.link({ ok: true, main: 1, before: [1] }, { owner: true, width: 380, height: 480 }), { ok: true, place: 'pos' });
});

test('the link script places only when asked, scaled by the window DPI, at the top right of the main window', () => {
  assert.match(PS_LINK, /if \(\$w -gt 0 -and \$h -gt 0\) \{ \$placed = \[AvW\]::Place\(\$new\[0\], \$main, \$w, \$h\) \}/);
  assert.match(PS_LINK, /if \(\$owner\) \{/);
});

test('link returns the handle of the new window (only when it is a positive integer)', async () => {
  assert.equal((await mk([{ ok: true, aux: 1234 }]).l.link({ ok: true, main: 1, before: [1] })).aux, 1234);
  for (const bad of [0, -3, 1.5, 'x', null, undefined]) assert.ok(!('aux' in (await mk([{ ok: true, aux: bad }]).l.link({ ok: true, main: 1, before: [1] }))), String(bad));
});

test('watch: starts the fixed watcher script with only the two handles, and stop() ends it', () => {
  const calls = [];
  let killed = 0;
  const l = new WindowLinker({ procName: 'Code', platform: 'win32', execFile: (bin, args, opts, cb) => { calls.push({ bin, args, opts, cb }); return { stdin: { end() {} }, kill() { killed += 1; } }; } });
  const w = l.watch(4242, 99);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'powershell.exe');
  assert.equal(calls[0].args[5], PS_WATCH);
  assert.equal(calls[0].opts.env.AV_MAIN, '4242');
  assert.equal(calls[0].opts.env.AV_AUX, '99');
  assert.equal(calls[0].opts.windowsHide, true);
  assert.ok(calls[0].opts.timeout > 12 * 3600e3, 'a watcher outlives a long working day but not forever');
  assert.ok(!PS_WATCH.includes('4242'));
  w.stop();
  assert.equal(killed, 1);
});

test('watch: not on Windows, with bad handles or a throwing execFile nothing is started and nothing throws', () => {
  let n = 0;
  const exec = () => { n += 1; throw new Error('boom'); };
  assert.doesNotThrow(() => new WindowLinker({ procName: 'Code', platform: 'linux', execFile: exec }).watch(1, 2).stop());
  for (const bad of [[0, 2], [1, 0], [1.5, 2], ['1', 2], [1, null], [-1, 2]]) new WindowLinker({ procName: 'Code', platform: 'win32', execFile: exec }).watch(bad[0], bad[1]).stop();
  assert.equal(n, 0);
  assert.doesNotThrow(() => new WindowLinker({ procName: 'Code', platform: 'win32', execFile: exec }).watch(1, 2).stop());
});

test('the watcher script only checks two windows and posts WM_CLOSE to the floating one', () => {
  assert.match(PS_WATCH, /IsWindow\(\[IntPtr\]\$a\)\) \{ exit 0 \}/);
  assert.match(PS_WATCH, /IsWindow\(\[IntPtr\]\$m\)\) \{ \[void\]\[AvX\]::PostMessage\(\[IntPtr\]\$a, 0x0010/);
  assert.ok(!/Stop-Process|taskkill|Remove-Item|Invoke-Expression|Start-Process/i.test(PS_WATCH));
});

test('auxProc: the process of the NEW window (a browser) is handed over next to the editor process; odd names are dropped', async () => {
  const a = mk([{ ok: true, main: 4, before: [4] }], { auxProc: 'msedge' });
  await a.l.snapshot();
  assert.equal(a.x.calls[0].opts.env.AV_PROC, 'Code');
  assert.equal(a.x.calls[0].opts.env.AV_AUXPROC, 'msedge');
  await a.l.link({ ok: true, main: 4, before: [4] });
  assert.equal(a.x.calls[1].opts.env.AV_AUXPROC, 'msedge');
  const b = mk([{ ok: true, main: 4, before: [4] }], { auxProc: 'x;y' });
  await b.l.snapshot();
  assert.equal(b.x.calls[0].opts.env.AV_AUXPROC, '');
});

test('retries: a larger number waits longer for a slow window; absurd values fall back to the default', async () => {
  const a = mk([{ ok: false, why: 'none' }], { retries: 14 });
  await a.l.link({ ok: true, main: 1, before: [1] });
  assert.equal(a.x.calls.length, 14);
  for (const bad of [0, -1, 41, 2.5, 'x']) {
    const b = mk([{ ok: false, why: 'none' }], { retries: bad });
    await b.l.link({ ok: true, main: 1, before: [1] });
    assert.equal(b.x.calls.length, RETRIES, String(bad));
  }
});

test('watch: the callback runs when the watcher ends by itself, not when it is stopped from outside', () => {
  const calls = [];
  const l = new WindowLinker({ procName: 'Code', platform: 'win32', execFile: (bin, args, opts, cb) => { calls.push(cb); return { stdin: { end() {} }, kill() {} }; } });
  let gone = 0;
  l.watch(1, 2, () => { gone += 1; });
  calls[0](null);
  assert.equal(gone, 1);
  const w = l.watch(1, 2, () => { gone += 1; });
  w.stop();
  calls[1](new Error('killed'));
  assert.equal(gone, 1, 'stop() is silent');
  l.watch(1, 2, () => { throw new Error('boom'); });
  assert.doesNotThrow(() => calls[2](null));
});

test('activate: brings the window forward through a fixed script with only its handle', async () => {
  const { x, l } = mk([{ ok: true }]);
  assert.deepEqual(await l.activate(4711), { ok: true });
  assert.equal(x.calls[0].args[5], PS_ACTIVATE);
  assert.equal(x.calls[0].opts.env.AV_AUX, '4711');
  assert.ok(!PS_ACTIVATE.includes('4711'));
  assert.deepEqual(await mk([{ ok: false, why: 'gone' }]).l.activate(1), { ok: false, why: 'gone' });
  for (const bad of [0, -1, 1.5, '1', null]) assert.deepEqual(await mk([{ ok: true }]).l.activate(bad), { ok: false, why: 'platform' });
  assert.deepEqual(await mk([{ ok: true }], { platform: 'linux' }).l.activate(5), { ok: false, why: 'platform' });
});
