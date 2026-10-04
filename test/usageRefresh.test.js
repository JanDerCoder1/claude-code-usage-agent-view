'use strict';
// lib/usageRefresh.js with an injected execFile: arguments, environment, in-flight sharing, gap, errors, timeouts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { UsageRefresher, ARGS, TIMEOUT_MS, MIN_GAP_MS } = require('../lib/usageRefresh');

function fakeExec() {
  const f = { calls: [], pending: [] };
  f.fn = (bin, args, opts, cb) => {
    f.calls.push({ bin, args, opts });
    const child = { stdin: { ended: 0, end() { this.ended += 1; } } };
    f.child = child;
    f.pending.push(cb);
    return child;
  };
  f.finish = (err) => f.pending.shift()(err || null, 'ignored output', '');
  return f;
}

test('runs exactly "claude -p /usage" with no session, no user settings, no shell, hidden window and a timeout', async () => {
  const x = fakeExec();
  const r = new UsageRefresher({ binary: 'C:\\x\\claude.exe', cwd: 'C:\\store', execFile: x.fn, now: () => 1e6 });
  const p = r.refresh();
  assert.equal(x.calls.length, 1);
  const c = x.calls[0];
  assert.equal(c.bin, 'C:\\x\\claude.exe');
  assert.deepEqual(c.args, ['-p', '/usage', '--no-session-persistence', '--setting-sources', 'project']);
  assert.deepEqual(ARGS, c.args);
  assert.equal(c.opts.windowsHide, true);
  assert.equal(c.opts.timeout, TIMEOUT_MS);
  assert.equal(c.opts.cwd, 'C:\\store');
  assert.ok(!('shell' in c.opts));
  assert.ok(c.opts.maxBuffer <= 1024 * 1024);
  assert.equal(x.child.stdin.ended, 1, 'no input is awaited');
  x.finish();
  assert.deepEqual(await p, { ok: true, ms: 0 });
});

test('the environment: CLAUDE_CONFIG_DIR only when given, ELECTRON_RUN_AS_NODE never passed on', async () => {
  const keep = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try {
    const x = fakeExec();
    const a = new UsageRefresher({ binary: 'c', execFile: x.fn, configDir: 'D:\\cfg' });
    const pa = a.refresh();
    x.finish();
    await pa;
    assert.equal(x.calls[0].opts.env.CLAUDE_CONFIG_DIR, 'D:\\cfg');
    assert.ok(!('ELECTRON_RUN_AS_NODE' in x.calls[0].opts.env));
    const y = fakeExec();
    delete process.env.CLAUDE_CONFIG_DIR;
    const b = new UsageRefresher({ binary: 'c', execFile: y.fn });
    const pb = b.refresh();
    y.finish();
    await pb;
    assert.ok(!('CLAUDE_CONFIG_DIR' in y.calls[0].opts.env) || y.calls[0].opts.env.CLAUDE_CONFIG_DIR === process.env.CLAUDE_CONFIG_DIR);
  } finally {
    if (keep === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = keep;
  }
});

test('a run in progress is shared, a second one inside the minimum gap is skipped, one after it starts', async () => {
  const x = fakeExec();
  let now = 1000;
  const r = new UsageRefresher({ binary: 'c', execFile: x.fn, now: () => now });
  const p1 = r.refresh();
  const p2 = r.refresh();
  assert.equal(p1, p2, 'the same promise while running');
  assert.equal(x.calls.length, 1);
  now += 500;
  x.finish();
  assert.equal((await p1).ok, true);
  now += 1000;
  assert.deepEqual(await r.refresh(), { ok: false, skipped: 'gap' });
  assert.equal(x.calls.length, 1);
  now += MIN_GAP_MS;
  const p3 = r.refresh();
  assert.equal(x.calls.length, 2);
  x.finish();
  assert.equal((await p3).ok, true);
});

test('errors become results: exit code, timeout signal, missing binary, a throwing execFile; nothing rejects', async () => {
  const x = fakeExec();
  let now = 0;
  const r = new UsageRefresher({ binary: 'c', execFile: x.fn, now: () => now });
  const p1 = r.refresh();
  x.finish(Object.assign(new Error('Command failed'), { code: 1 }));
  assert.deepEqual(await p1, { ok: false, ms: 0, error: '1' });
  now += MIN_GAP_MS + 1;
  const p2 = r.refresh();
  x.finish(Object.assign(new Error('killed'), { signal: 'SIGTERM' }));
  assert.equal((await p2).error, 'SIGTERM');
  now += MIN_GAP_MS + 1;
  const p3 = r.refresh();
  x.finish(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
  assert.equal((await p3).error, 'ENOENT');
  now += MIN_GAP_MS + 1;
  const boom = new UsageRefresher({ binary: 'c', execFile: () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); } });
  assert.deepEqual(await boom.refresh(), { ok: false, ms: 0, error: 'EACCES' });
  assert.deepEqual(await new UsageRefresher({ binary: '', execFile: x.fn }).refresh(), { ok: false, skipped: 'no-binary' });
  assert.deepEqual(await new UsageRefresher({ execFile: x.fn }).refresh(), { ok: false, skipped: 'no-binary' });
});

test('after a failure the next run is possible again (no stuck in-flight state)', async () => {
  const x = fakeExec();
  let now = 0;
  const r = new UsageRefresher({ binary: 'c', execFile: x.fn, now: () => now });
  const p1 = r.refresh();
  x.finish(new Error('x'));
  await p1;
  now += MIN_GAP_MS + 1;
  const p2 = r.refresh();
  assert.notEqual(p1, p2);
  x.finish();
  assert.equal((await p2).ok, true);
});
