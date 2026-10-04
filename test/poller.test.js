'use strict';
// Poller tests: fake clock + injected fs.watch, so cadence, debounce, re-entrancy, hidden-stops-timers and the
// watch-failure fallback are deterministic. One real-fs test at the end proves the hint works with the platform.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Poller, DEBOUNCE_MS, MIN_TICK_GAP_MS, IDLE_POLL_MS, HEARTBEAT_MS, WATCH_RETRY_MS } = require('../lib/poller');

function makeClock(start) {
  let t = start === undefined ? 1000000 : start;
  let seq = 0;
  const timers = new Map();
  const clock = {
    now: () => t,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { id, at: t + Math.max(0, ms), fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    /** Runs every timer due within `ms`, in time order, moving the clock to each timer's due time. */
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const x of timers.values()) {
          if (x.at <= end && (!next || x.at < next.at || (x.at === next.at && x.id < next.id))) next = x;
        }
        if (!next) break;
        timers.delete(next.id);
        t = Math.max(t, next.at);
        next.fn();
      }
      t = end;
    },
  };
  return clock;
}

function makeFakeFs() {
  const f = { attempts: {}, watchers: [], failDirs: new Set(), calls: [] };
  f.watch = (dir, opts, cb) => {
    f.attempts[dir] = (f.attempts[dir] || 0) + 1;
    f.calls.push({ dir, opts });
    if (f.failDirs.has(dir)) { const e = new Error('ENOENT: no such file or directory, watch'); e.code = 'ENOENT'; throw e; }
    const w = {
      dir, closed: false, handlers: {},
      on(ev, fn) { w.handlers[ev] = fn; return w; },
      close() { w.closed = true; },
      emit(name) { if (!w.closed) cb('change', name); },
      fail(err) { if (w.handlers.error) w.handlers.error(err || new Error('boom')); },
    };
    f.watchers.push(w);
    return w;
  };
  f.liveFor = (dir) => f.watchers.filter((w) => w.dir === dir && !w.closed);
  return f;
}

class FakeModel {
  constructor() {
    this.refreshes = [];
    this.active = true;
    this.roots = ['/r1'];
    this.hash = 'h1';
    this.fail = null;
  }
  refresh(now) {
    this.refreshes.push(now);
    if (this.fail) throw this.fail;
    return { v: 1, now, n: this.refreshes.length };
  }
  hasActivity() { return this.active; }
  watchRoots() { return this.roots.slice(); }
  stateHash() { return this.hash; }
}

function setup(over) {
  const clock = makeClock();
  const model = new FakeModel();
  const fsx = makeFakeFs();
  const pushes = [];
  const logs = [];
  const st = { visible: true };
  const poller = new Poller(Object.assign({
    model, push: (vs, hostNow) => pushes.push({ vs, hostNow }), isVisible: () => st.visible, pollMs: 1500,
    log: (m) => logs.push(m), fs: fsx, timers: clock, now: clock.now,
  }, over || {}));
  return { clock, model, fsx, pushes, logs, st, poller };
}

const rel = (arr, t0) => arr.map((x) => x - t0);

test('start defers the first tick to a timer, pushes with hostNow, watches with recursive/non-persistent options', () => {
  const { clock, model, fsx, pushes, poller } = setup();
  const t0 = clock.now();
  poller.start();
  assert.equal(model.refreshes.length, 0, 'start() itself never refreshes synchronously');
  assert.deepEqual(fsx.calls, [{ dir: '/r1', opts: { recursive: true, persistent: false } }]);
  clock.advance(0);
  assert.deepEqual(rel(model.refreshes, t0), [0]);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].hostNow, clock.now());
  assert.equal(pushes[0].vs.n, 1);
  assert.equal(poller.running, true);
  assert.deepEqual(poller.watching, ['/r1']);
});

test('cadence: pollMs while active, 5 s while idle, and it follows hasActivity', () => {
  const { clock, model, poller } = setup();
  const t0 = clock.now();
  poller.start();
  clock.advance(0);
  clock.advance(1500);
  clock.advance(1500);
  assert.deepEqual(rel(model.refreshes, t0), [0, 1500, 3000]);
  model.active = false; // the tick at 4500 sees "idle" and schedules the next one 5 s later
  clock.advance(1500);
  assert.deepEqual(rel(model.refreshes, t0), [0, 1500, 3000, 4500]);
  clock.advance(IDLE_POLL_MS - 1);
  assert.equal(model.refreshes.length, 4);
  clock.advance(1);
  assert.deepEqual(rel(model.refreshes, t0), [0, 1500, 3000, 4500, 4500 + IDLE_POLL_MS]);
  model.active = true;
  clock.advance(IDLE_POLL_MS); // still on the idle timer; the next tick sees activity again
  clock.advance(1500);
  assert.equal(rel(model.refreshes, t0).pop(), 4500 + 2 * IDLE_POLL_MS + 1500);
});

test('idle cadence never undercuts a larger pollMs', () => {
  const { clock, model, poller } = setup({ pollMs: 8000 });
  model.active = false;
  const t0 = clock.now();
  poller.start();
  clock.advance(0);
  clock.advance(7999);
  assert.equal(model.refreshes.length, 1);
  clock.advance(1);
  assert.deepEqual(rel(model.refreshes, t0), [0, 8000]);
});

test('setPollMs re-times the pending poll, clamps to 250 ms and ignores garbage', () => {
  const { clock, model, poller } = setup();
  const t0 = clock.now();
  poller.start();
  clock.advance(0);
  clock.advance(1000);
  poller.setPollMs(3000);
  clock.advance(2999);
  assert.equal(model.refreshes.length, 1);
  clock.advance(1);
  assert.deepEqual(rel(model.refreshes, t0), [0, 4000]);
  poller.setPollMs(10);
  assert.equal(poller.pollMs, 250);
  poller.setPollMs('x');
  assert.equal(poller.pollMs, 1500);
  poller.setPollMs(NaN);
  assert.equal(poller.pollMs, 1500);
});

test('push is deduped by stateHash, forced pushes and the 10 s heartbeat still go out', () => {
  const { clock, model, pushes, poller } = setup();
  poller.start();
  clock.advance(0);
  assert.equal(pushes.length, 1, 'first tick always pushes');
  clock.advance(1500);
  clock.advance(1500);
  assert.equal(pushes.length, 1, 'unchanged hash: no push');
  model.hash = 'h2';
  clock.advance(1500);
  assert.equal(pushes.length, 2, 'changed hash pushes');
  clock.advance(1500);
  assert.equal(pushes.length, 2);
  poller.requestTick({ immediate: true, force: true });
  clock.advance(MIN_TICK_GAP_MS);
  assert.equal(pushes.length, 3, 'force pushes an unchanged state');
  const n = pushes.length;
  clock.advance(HEARTBEAT_MS + 1500);
  assert.ok(pushes.length >= n + 1, 'heartbeat pushes even if nothing changed');
  assert.ok(pushes.length <= n + 2, 'but not on every tick');
});

test('a stateHash that throws means "changed": the state is still delivered', () => {
  const { clock, model, pushes, poller } = setup();
  model.stateHash = () => { throw new Error('no hash'); };
  poller.start();
  clock.advance(0);
  clock.advance(1500);
  assert.equal(pushes.length, 2);
});

test('debounce: a burst of watch events becomes one tick 150 ms after the first event', () => {
  const { clock, model, fsx, poller } = setup();
  model.active = false; // keep the 1.5 s poll out of the way
  const t0 = clock.now();
  poller.start();
  clock.advance(0);
  clock.advance(1000); // t = 1000, the last tick was at 0, so only the debounce limits the next one
  const w = fsx.liveFor('/r1')[0];
  for (let i = 0; i < 6; i++) { w.emit(`s${i}.jsonl`); clock.advance(20); }
  assert.equal(model.refreshes.length, 1, 'still inside the 150 ms window');
  clock.advance(DEBOUNCE_MS - 120);
  assert.equal(model.refreshes.length, 2, 'one tick for the whole burst');
  assert.equal(model.refreshes[1] - t0, 1000 + DEBOUNCE_MS);
  clock.advance(500);
  assert.equal(model.refreshes.length, 2);
});

test('never ticks more often than every 250 ms, also for immediate requests', () => {
  const { clock, model, fsx, poller } = setup();
  model.active = false;
  const t0 = clock.now();
  poller.start();
  clock.advance(0);
  clock.advance(10);
  fsx.liveFor('/r1')[0].emit('a.jsonl'); // would be due at 160, but the last tick was at 0
  clock.advance(MIN_TICK_GAP_MS - 10 - 1);
  assert.equal(model.refreshes.length, 1);
  clock.advance(1);
  assert.deepEqual(rel(model.refreshes, t0), [0, MIN_TICK_GAP_MS]);
  poller.requestTick({ immediate: true });
  clock.advance(MIN_TICK_GAP_MS - 1);
  assert.equal(model.refreshes.length, 2);
  clock.advance(1);
  assert.equal(model.refreshes.length, 3);
});

test('continuous writes cannot starve the poller and cannot exceed one tick per 250 ms', () => {
  const { clock, model, fsx, poller } = setup();
  const t0 = clock.now();
  poller.start();
  clock.advance(0);
  const w = fsx.liveFor('/r1')[0];
  for (let i = 0; i < 40; i++) { w.emit('live.jsonl'); clock.advance(50); } // 2 s of writes
  const ticks = rel(model.refreshes, t0);
  assert.ok(ticks.length >= 5, `ticks happen under load (${ticks.length})`);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i] - ticks[i - 1] >= MIN_TICK_GAP_MS, `gap ${ticks[i] - ticks[i - 1]}`);
  assert.ok(ticks.length <= 2000 / MIN_TICK_GAP_MS + 2);
});

test('watch events are filtered: null names, non-json files and directories do not tick', () => {
  const { clock, model, fsx, poller } = setup();
  model.active = false;
  poller.start();
  clock.advance(0);
  const w = fsx.liveFor('/r1')[0];
  for (const name of [null, undefined, 'notes.txt', 'wf_abc', 'a.jsonl.tmp', 'x.key']) { w.emit(name); clock.advance(500); } // 3 s: below the idle poll
  assert.equal(model.refreshes.length, 1);
  for (const name of ['agent-1.jsonl', 'journal.jsonl', 'wf_x.json', 'A.JSONL']) {
    const before = model.refreshes.length;
    w.emit(name);
    clock.advance(400);
    assert.equal(model.refreshes.length, before + 1, name);
  }
});

test('watch events call model.invalidate() before the tick; ignored events do not; a model without invalidate() still works', () => {
  const { clock, model, fsx, poller } = setup();
  model.active = false;
  const order = [];
  model.invalidations = 0;
  model.invalidate = () => { model.invalidations++; order.push('invalidate'); };
  const refresh = model.refresh.bind(model);
  model.refresh = (now) => { order.push('refresh'); return refresh(now); };
  poller.start();
  clock.advance(0);
  assert.equal(model.invalidations, 0, 'start and the first tick do not invalidate');
  const w = fsx.liveFor('/r1')[0];
  for (const name of [null, undefined, 'notes.txt', 'wf_abc', 'x.key']) { w.emit(name); clock.advance(300); }
  assert.equal(model.invalidations, 0, 'filtered events never invalidate');
  order.length = 0;
  w.emit('agent-1.jsonl');
  w.emit('agent-2.jsonl');
  w.emit('wf_x.json');
  assert.equal(model.invalidations, 3, 'every accepted event invalidates');
  clock.advance(400);
  assert.deepEqual(order, ['invalidate', 'invalidate', 'invalidate', 'refresh'], 'all invalidations precede the one coalesced tick');
  // a throwing invalidate() does not break the hint
  model.invalidate = () => { throw new Error('boom'); };
  const before = model.refreshes.length;
  w.emit('again.jsonl');
  clock.advance(400);
  assert.equal(model.refreshes.length, before + 1);
  // and a model that has no invalidate() at all keeps ticking
  delete model.invalidate;
  w.emit('again2.jsonl');
  clock.advance(400);
  assert.equal(model.refreshes.length, before + 2);
});

test('invalidate() reaches a real SessionModel: a session created after the last discovery shows up on the tick the watch event causes', () => {
  const SessionModel = require('../lib/sessionModel');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'av-poller-model-'));
  try {
    fs.mkdirSync(path.join(home, 'projects', 'c--p'), { recursive: true });
    const model = new SessionModel({ claudeHome: home, scope: 'all', workspaceFolders: [], recentHours: 24, staleMinutes: 10, showToolTargets: true, etaEnabled: false, history: null });
    const clock = makeClock(Date.now());
    const fsx = makeFakeFs();
    const pushes = [];
    const poller = new Poller({ model, push: (vs) => pushes.push(vs), isVisible: () => true, pollMs: 1500, log() {}, fs: fsx, timers: clock, now: clock.now });
    poller.start();
    clock.advance(0);                                           // first tick: discovery of an empty tree
    assert.equal(pushes.length, 1);
    const sid = '00000000-0000-4000-8000-0000000000aa';
    const agentDir = path.join(home, 'projects', 'c--p', sid, 'subagents');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(home, 'projects', 'c--p', sid + '.jsonl'), '{}\n');
    fs.writeFileSync(path.join(agentDir, 'agent-a1.jsonl'), '');
    fs.writeFileSync(path.join(agentDir, 'agent-a1.meta.json'), JSON.stringify({ description: 'fresh agent', agentType: 'general' }));
    clock.advance(1000);                                        // 1 s later: well inside the 5 s discovery cadence, no event yet
    const noEvent = model.refresh(clock.now());
    assert.equal(noEvent.running.length + noEvent.recent.length, 0, 'without a watch event the new session waits for the next discovery');
    const w = fsx.watchers.find((x) => !x.closed);
    assert.ok(w, 'the poller watches the projects root');
    w.emit(path.join('c--p', sid, 'subagents', 'agent-a1.jsonl'));
    clock.advance(400);
    const vs = pushes[pushes.length - 1];
    const labels = vs.running.concat(vs.recent).map((c) => (c.kind === 'agent' ? c.agent.label : c.name));
    assert.ok(labels.includes('fresh agent'), 'the watch event invalidated discovery: ' + JSON.stringify(labels));
    poller.dispose();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('re-entrancy: requests and start() made from inside a tick never nest, one follow-up tick runs', () => {
  const { clock, model, poller } = setup();
  const t0 = clock.now();
  let depth = 0;
  let maxDepth = 0;
  const original = model.refresh.bind(model);
  model.refresh = (now) => {
    depth++;
    maxDepth = Math.max(maxDepth, depth);
    try {
      if (model.refreshes.length === 0) { poller.requestTick({ immediate: true }); poller.requestTick(); poller.start(); }
      return original(now);
    } finally { depth--; }
  };
  poller.start();
  clock.advance(0);
  assert.equal(model.refreshes.length, 1);
  clock.advance(MIN_TICK_GAP_MS);
  assert.deepEqual(rel(model.refreshes, t0), [0, MIN_TICK_GAP_MS], 'exactly one follow-up tick for the queued requests');
  assert.equal(maxDepth, 1);
});

test('a push callback that requests a tick does not recurse either', () => {
  const clock = makeClock();
  const model = new FakeModel();
  let depth = 0;
  let maxDepth = 0;
  let poller;
  const original = model.refresh.bind(model);
  model.refresh = (now) => { depth++; maxDepth = Math.max(maxDepth, depth); try { return original(now); } finally { depth--; } };
  poller = new Poller({
    model, isVisible: () => true, pollMs: 1500, log() {}, fs: makeFakeFs(), timers: clock, now: clock.now,
    push: () => { poller.requestTick({ immediate: true, force: true }); },
  });
  poller.start();
  clock.advance(0);
  clock.advance(MIN_TICK_GAP_MS * 3);
  assert.equal(maxDepth, 1);
  assert.ok(model.refreshes.length >= 2);
});

test('stop() called from inside a tick leaves no timers behind', () => {
  const { clock, model, fsx, poller } = setup();
  const original = model.refresh.bind(model);
  model.refresh = (now) => { poller.stop(); return original(now); };
  poller.start();
  clock.advance(0);
  assert.equal(poller.running, false);
  assert.equal(clock.pending(), 0);
  assert.ok(fsx.watchers.every((w) => w.closed));
});

test('a throwing model is logged once per message, polling continues and recovers', () => {
  const { clock, model, pushes, logs, poller } = setup();
  model.fail = new Error('torn file');
  poller.start();
  clock.advance(0);
  assert.equal(pushes.length, 0);
  assert.ok(clock.pending() > 0, 'next poll is scheduled');
  clock.advance(IDLE_POLL_MS);
  clock.advance(IDLE_POLL_MS);
  assert.equal(model.refreshes.length, 3);
  assert.equal(logs.filter((l) => l.includes('torn file')).length, 1, 'same error is not logged again');
  model.fail = null;
  clock.advance(IDLE_POLL_MS);
  assert.equal(pushes.length, 1, 'recovered tick pushes');
});

test('a throwing push callback does not stop the loop', () => {
  const clock = makeClock();
  const model = new FakeModel();
  const logs = [];
  const poller = new Poller({
    model, isVisible: () => true, pollMs: 1500, log: (m) => logs.push(m), fs: makeFakeFs(), timers: clock, now: clock.now,
    push: () => { throw new Error('webview gone'); },
  });
  poller.start();
  clock.advance(0);
  clock.advance(1500);
  assert.equal(model.refreshes.length, 2);
  assert.ok(logs.some((l) => l.includes('webview gone')));
});

test('hidden view: the next tick stops everything (timers and watchers); start() resumes with a forced push', () => {
  const { clock, model, fsx, pushes, st, poller } = setup();
  poller.start();
  clock.advance(0);
  assert.equal(pushes.length, 1);
  st.visible = false;
  clock.advance(1500);
  assert.equal(model.refreshes.length, 1, 'no refresh while hidden');
  assert.equal(poller.running, false);
  assert.equal(clock.pending(), 0, 'all timers cleared');
  assert.ok(fsx.watchers.every((w) => w.closed), 'watchers closed');
  assert.deepEqual(poller.watching, []);
  clock.advance(60000);
  assert.equal(model.refreshes.length, 1);
  st.visible = true;
  poller.start();
  assert.equal(poller.running, true);
  clock.advance(0);
  assert.equal(model.refreshes.length, 2, 'ticks immediately after becoming visible');
  assert.equal(pushes.length, 2, 'and pushes although the hash did not change');
  assert.equal(fsx.liveFor('/r1').length, 1, 'watcher reopened');
});

test('stop() clears timers and closes watchers, requestTick afterwards is a no-op, stop is idempotent', () => {
  const { clock, model, fsx, poller } = setup();
  poller.start();
  clock.advance(0);
  poller.requestTick();
  assert.ok(clock.pending() > 0);
  poller.stop();
  poller.stop();
  assert.equal(clock.pending(), 0);
  assert.ok(fsx.watchers.every((w) => w.closed));
  poller.requestTick({ immediate: true });
  assert.equal(clock.pending(), 0);
  clock.advance(60000);
  assert.equal(model.refreshes.length, 1);
});

test('start() while the view is not visible does nothing', () => {
  const { clock, fsx, st, poller } = setup();
  st.visible = false;
  poller.start();
  assert.equal(poller.running, false);
  assert.equal(clock.pending(), 0);
  assert.equal(fsx.watchers.length, 0);
});

test('start() twice does not double the timers or watchers', () => {
  const { clock, model, fsx, poller } = setup();
  poller.start();
  poller.start();
  clock.advance(0);
  assert.equal(model.refreshes.length, 1);
  assert.equal(fsx.watchers.length, 1);
});

test('dispose() stops for good', () => {
  const { clock, model, fsx, poller } = setup();
  poller.start();
  clock.advance(0);
  poller.dispose();
  poller.dispose();
  poller.start();
  poller.requestTick({ immediate: true });
  clock.advance(60000);
  assert.equal(model.refreshes.length, 1);
  assert.equal(poller.running, false);
  assert.equal(clock.pending(), 0);
  assert.ok(fsx.watchers.every((w) => w.closed));
});

test('watch failure falls back to polling and is retried every 30 s, not every tick', () => {
  const { clock, model, fsx, logs, poller } = setup();
  fsx.failDirs.add('/r1');
  const t0 = clock.now();
  poller.start();
  clock.advance(0);
  assert.deepEqual(poller.watching, []);
  assert.equal(fsx.attempts['/r1'], 1);
  assert.equal(logs.filter((l) => l.includes('ENOENT')).length, 1, 'failure logged once');
  clock.advance(29000);
  assert.ok(model.refreshes.length >= 19, 'polling carries on without a watcher');
  assert.equal(fsx.attempts['/r1'], 1, 'no retry before 30 s');
  fsx.failDirs.clear(); // the directory exists now
  clock.advance(WATCH_RETRY_MS - 29000 + 6000);
  assert.equal(fsx.attempts['/r1'], 2);
  assert.deepEqual(poller.watching, ['/r1']);
  assert.equal(logs.filter((l) => l.includes('ENOENT')).length, 1, 'retry success does not log a failure');
  // and the hint works afterwards
  model.active = false;
  clock.advance(1600);
  const before = model.refreshes.length;
  fsx.liveFor('/r1')[0].emit('late.jsonl');
  clock.advance(DEBOUNCE_MS + 1);
  assert.equal(model.refreshes.length, before + 1);
  assert.ok(clock.now() - t0 > 30000);
});

test('a watcher error closes it, polling continues, and it is re-created after 30 s', () => {
  const { clock, model, fsx, poller } = setup();
  poller.start();
  clock.advance(0);
  const first = fsx.liveFor('/r1')[0];
  first.fail(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
  assert.equal(first.closed, true);
  assert.deepEqual(poller.watching, []);
  clock.advance(10000);
  assert.equal(fsx.liveFor('/r1').length, 0, 'not before the retry delay');
  assert.ok(model.refreshes.length > 5);
  clock.advance(WATCH_RETRY_MS);
  assert.equal(fsx.liveFor('/r1').length, 1, 'new watcher after the retry delay');
});

test('a throwing watch with no watch API at all (null result) also falls back to polling', () => {
  const { clock, model, poller } = setup({ fs: { watch: () => null } });
  poller.start();
  clock.advance(0);
  clock.advance(1500);
  assert.equal(model.refreshes.length, 2);
  assert.deepEqual(poller.watching, []);
});

test('watch roots follow the model: removed roots are closed, new ones opened, duplicates collapse', () => {
  const { clock, model, fsx, poller } = setup();
  model.roots = ['/a', '/a', '', '/b'];
  poller.start();
  clock.advance(0);
  assert.deepEqual(poller.watching.sort(), ['/a', '/b']);
  assert.equal(fsx.attempts['/a'], 1);
  model.roots = ['/b', '/c'];
  clock.advance(7000);
  assert.deepEqual(poller.watching.sort(), ['/b', '/c']);
  assert.equal(fsx.watchers.filter((w) => w.dir === '/a')[0].closed, true);
  assert.equal(fsx.attempts['/b'], 1, 'unchanged roots are not re-watched');
});

test('a model without roots or whose watchRoots throws still polls', () => {
  const { clock, model, poller } = setup();
  model.watchRoots = () => { throw new Error('nope'); };
  poller.start();
  clock.advance(0);
  clock.advance(1500);
  assert.equal(model.refreshes.length, 2);
  assert.deepEqual(poller.watching, []);
});

test('real fs.watch: a write into a watched directory wakes an idle poller well before the 5 s poll', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-view-poller-'));
  const model = new FakeModel();
  model.roots = [dir];
  model.active = false;
  const poller = new Poller({ model, push() {}, isVisible: () => true, pollMs: 1500, log() {} });
  const waitFor = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 20)); } return cond(); };
  try {
    poller.start();
    assert.ok(await waitFor(() => model.refreshes.length >= 1, 2000), 'first tick');
    if (poller.watching.length === 0) { t.skip('recursive fs.watch not available on this platform'); return; }
    await new Promise((r) => setTimeout(r, 400)); // let the initial tick settle
    const before = model.refreshes.length;
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'agent-x.jsonl'), '{}\n');
    assert.ok(await waitFor(() => model.refreshes.length > before, 3000), 'tick triggered by the watch hint');
  } finally {
    poller.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- regression: vscode-runtime F5 (a watcher whose directory was deleted or replaced) ------------------------------------

test('rt F5: a watcher that reports its own absolute path (deleted or renamed directory) is released at once and re-opened on the next sync', () => {
  const { clock, model, fsx, poller } = setup();
  model.active = false;
  poller.start();
  clock.advance(0);
  const names = ['\\\\?\\C:\\work\\proj', 'C:\\work\\proj', '/work/proj'];
  names.forEach((name, i) => {
    const w = fsx.liveFor('/r1')[0];
    assert.ok(w, 'live watcher before ' + name);
    w.emit(name);
    assert.equal(w.closed, true, 'closed on the first event that names the directory itself: ' + name);
    assert.deepEqual(poller.watching, []);
    clock.advance(MIN_TICK_GAP_MS + DEBOUNCE_MS + 10);      // the tick that follows re-syncs the watchers
    assert.equal(fsx.liveFor('/r1').length, 1, 'a fresh watcher on the (re-created) directory');
    assert.equal(fsx.attempts['/r1'], i + 2);
  });
  const before = model.refreshes.length;
  fsx.liveFor('/r1')[0].emit('proj/agent-1.jsonl');            // ordinary relative events still work
  clock.advance(DEBOUNCE_MS + 1);
  assert.ok(model.refreshes.length > before);
});

test('rt F5: a directory replaced under the same name (the old handle follows the old one) gets a new watcher at the next sync, an unchanged one is left alone', () => {
  const { WATCH_SYNC_MS } = require('../lib/poller');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'av-rg-pw-'));
  const d = path.join(root, 'proj');
  fs.mkdirSync(d);
  try {
    const { clock, model, fsx, poller } = setup();
    fsx.statSync = fs.statSync;
    model.roots = [d];
    poller.start();
    clock.advance(0);
    assert.equal(fsx.liveFor(d).length, 1);
    clock.advance(3 * WATCH_SYNC_MS);
    assert.equal(fsx.attempts[d], 1, 'an unchanged directory is not re-watched');
    fs.renameSync(d, d + '-old');                              // the watched directory moves away, a new one takes its name
    fs.mkdirSync(d);
    clock.advance(WATCH_SYNC_MS + 2000);
    const mine = fsx.watchers.filter((w) => w.dir === d);
    assert.equal(mine.length, 2, 'a second watcher was opened');
    assert.equal(mine[0].closed, true, 'the one on the old directory was closed');
    assert.equal(fsx.liveFor(d).length, 1);
    clock.advance(3 * WATCH_SYNC_MS);
    assert.equal(fsx.attempts[d], 2, 'and it stays');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
