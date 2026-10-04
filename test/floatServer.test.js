'use strict';
// lib/floatServer.js: the loopback page server of the floating window, tested with real HTTP on 127.0.0.1.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');

const { FloatServer, MAX_BODY, CSP } = require('../lib/floatServer');
const { themeCss, bodyClass, themeFromKind, THEMES } = require('../lib/floatTheme');

const MEDIA = path.join(__dirname, '..', 'media');

async function boot(t, o) {
  const got = { msgs: [], clients: [] };
  const s = new FloatServer(Object.assign({ mediaDir: MEDIA, theme: 'dark', onMessage: (m) => got.msgs.push(m), onClients: (n) => got.clients.push(n) }, o));
  const { url, port } = await s.start();
  t.after(() => s.stop());
  return { s, url, port, got, base: new URL(url) };
}

function req(port, pathname, o) {
  const opts = Object.assign({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { Host: '127.0.0.1:' + port } }, o);
  if (o && o.headers) opts.headers = Object.assign({ Host: '127.0.0.1:' + port }, o.headers);
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (o && o.body !== undefined) r.write(o.body);
    r.end();
  });
}

function sse(port, pathname) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, headers: { Host: '127.0.0.1:' + port } }, (res) => {
      const out = { status: res.statusCode, headers: res.headers, text: '', res, close: () => { res.destroy(); r.destroy(); } };
      res.setEncoding('utf8');
      res.on('data', (c) => { out.text += c; });
      resolve(out);
    });
    r.on('error', reject);
    r.end();
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('binds to 127.0.0.1 on a random port and hands out a URL with a 128-bit token', async (t) => {
  const { s, url, port } = await boot(t);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/);
  assert.ok(port > 1023);
  const other = new FloatServer({ mediaDir: MEDIA });
  const o = await other.start();
  t.after(() => other.stop());
  assert.notEqual(o.url, url, 'every server has its own token');
  assert.equal(s.clients, 0);
});

test('the page: the token path serves it with a strict CSP, the theme class and the two scripts; nothing outside the token does', async (t) => {
  const { port, base } = await boot(t, { theme: 'light' });
  const r = await req(port, base.pathname);
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/html/);
  assert.equal(r.headers['content-security-policy'], CSP);
  assert.match(r.body, /<body class="vscode-light">/);
  assert.match(r.body, /<div id="app" data-mode="floating"><\/div>/);
  assert.match(r.body, /<script src="bridge\.js"><\/script>\s*<script src="main\.js"><\/script>/);
  assert.ok(!/<script>|sstyle=|son[a-z]+=/i.test(r.body), 'no inline script, style or handler');
  assert.ok(!/unsafe-|\*/.test(CSP.replace(/'self'/g, '')));
  for (const p of ['/', '/index.html', '/main.js', base.pathname.slice(0, -3) + '/', '/' + '0'.repeat(32) + '/']) assert.equal((await req(port, p)).status, 404, p);
  assert.equal((await req(port, base.pathname, { method: 'PUT' })).status, 405);
});

test('headers on every answer: no store, nosniff, no referrer, same-origin only, never CORS', async (t) => {
  const { port, base } = await boot(t);
  for (const f of ['', 'main.js', 'main.css', 'bridge.js', 'theme.css', 'icon.svg']) {
    const r = await req(port, base.pathname + f);
    assert.equal(r.status, 200, f);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
    assert.ok(!('access-control-allow-origin' in r.headers));
  }
});

test('the real media files are served; only the three whitelisted names, never a path outside', async (t) => {
  const { port, base } = await boot(t);
  const js = await req(port, base.pathname + 'main.js');
  assert.match(js.headers['content-type'], /^text\/javascript/);
  assert.match(js.body, /^'use strict';/);
  assert.match((await req(port, base.pathname + 'main.css')).headers['content-type'], /^text\/css/);
  assert.match((await req(port, base.pathname + 'icon.svg')).headers['content-type'], /^image\/svg\+xml/);
  for (const p of ['../package.json', '..%2fpackage.json', '%2e%2e/package.json', 'main.js/../../extension.js', 'README.md', 'main.js.map', 'bridge.js/x', '..\\package.json', 'icon.svg%00.js']) {
    const r = await req(port, base.pathname + p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.body.includes('"name": "claude-code-usage-agent-view"'), p);
  }
});

test('bridge.js gives main.js its acquireVsCodeApi and connects the event stream; theme.css carries the --vscode-* variables', async (t) => {
  const { port, base } = await boot(t);
  const b = await req(port, base.pathname + 'bridge.js');
  assert.match(b.body, /window\.acquireVsCodeApi = function/);
  assert.match(b.body, /new EventSource\(base \+ 'events'\)/);
  assert.match(b.body, /base \+ 'msg'/);
  assert.ok(!/eval\(|innerHTML|document\.write/.test(b.body));
  const c = await req(port, base.pathname + 'theme.css');
  assert.match(c.body, /--vscode-foreground: #CCCCCC;/);
  assert.match(c.body, /--vscode-font-family:/);
  assert.match(c.body, /html \{ background: #181818; \}/);
  for (const n of Object.keys(THEMES)) { assert.ok(themeCss(n).includes('--vscode-foreground')); assert.ok(bodyClass(n).startsWith('vscode-')); }
  assert.equal(themeCss('nonsense'), themeCss('dark'));
  assert.deepEqual([1, 2, 3, 4, 99].map(themeFromKind), ['light', 'dark', 'hc', 'hclight', 'dark']);
});

test('Host header: only 127.0.0.1:<port> and localhost:<port> (DNS rebinding)', async (t) => {
  const { port, base } = await boot(t);
  for (const host of ['evil.example', '127.0.0.1', 'localhost', '127.0.0.1:1', 'evil.example:' + port, '127.0.0.1:' + port + '.evil.example']) {
    const r = await req(port, base.pathname, { headers: { Host: host } });
    assert.equal(r.status, 403, JSON.stringify(host));
  }
  assert.equal((await req(port, base.pathname, { headers: { Host: 'localhost:' + port } })).status, 200);
});

test('POST /msg: a valid message reaches the host; wrong origin, bad JSON, arrays, a missing type and oversized bodies do not', async (t) => {
  const { port, base, got } = await boot(t);
  const post = (body, headers) => req(port, base.pathname + 'msg', { method: 'POST', body, headers: Object.assign({ 'Content-Type': 'application/json' }, headers) });
  assert.equal((await post(JSON.stringify({ type: 'refresh' }))).status, 204);
  assert.equal((await post(JSON.stringify({ type: 'setScope', scope: 'all' }), { Origin: 'http://127.0.0.1:' + port })).status, 204);
  assert.deepEqual(got.msgs, [{ type: 'refresh' }, { type: 'setScope', scope: 'all' }]);
  assert.equal((await post(JSON.stringify({ type: 'refresh' }), { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await post(JSON.stringify({ type: 'refresh' }), { Origin: 'null' })).status, 403);
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post('[1,2]')).status, 400);
  assert.equal((await post('{"nope":1}')).status, 400);
  assert.equal((await post('{"type":5}')).status, 400);
  assert.equal((await post('null')).status, 400);
  const big = await post(JSON.stringify({ type: 'x', pad: 'a'.repeat(MAX_BODY + 10) })).catch((e) => ({ status: e.code }));
  assert.ok(big.status === 413 || big.status === 'ECONNRESET' || big.status === 'EPIPE', String(big.status));
  assert.equal(got.msgs.length, 2, 'only the two valid messages arrived');
  assert.equal((await req(port, base.pathname + 'msg')).status, 404, 'GET on msg is not an endpoint');
});

test('a throwing message handler does not take the server down', async (t) => {
  const { port, base } = await boot(t, { onMessage: () => { throw new Error('boom'); } });
  const r = await req(port, base.pathname + 'msg', { method: 'POST', body: '{"type":"refresh"}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 204);
  assert.equal((await req(port, base.pathname)).status, 200);
});

test('events: a connecting page gets the newest message of each type, later broadcasts reach it, client count follows', async (t) => {
  const { s, port, base, got } = await boot(t);
  s.broadcast({ type: 'state', seq: 1, state: { a: 1 } });
  s.broadcast({ type: 'state', seq: 2, state: { a: 2 } });
  s.broadcast({ type: 'usageBusy', busy: true });
  const c = await sse(port, base.pathname + 'events');
  assert.equal(c.status, 200);
  assert.match(c.headers['content-type'], /^text\/event-stream/);
  await wait(60);
  assert.ok(c.text.startsWith('retry: 2000\n\n'));
  assert.ok(c.text.includes('data: {"type":"state","seq":2,"state":{"a":2}}\n\n'), 'the newest state');
  assert.ok(!c.text.includes('"seq":1,'), 'not the old one');
  assert.ok(c.text.includes('data: {"type":"usageBusy","busy":true}\n\n'));
  assert.equal(s.clients, 1);
  assert.deepEqual(got.clients, [1]);
  s.broadcast({ type: 'state', seq: 3, state: { a: 3 } });
  await wait(60);
  assert.ok(c.text.includes('"seq":3'));
  const d = await sse(port, base.pathname + 'events');
  await wait(60);
  assert.equal(s.clients, 2);
  c.close();
  await wait(100);
  assert.equal(s.clients, 1);
  d.close();
  await wait(100);
  assert.equal(s.clients, 0);
  assert.deepEqual(got.clients, [1, 2, 1, 0]);
});

test('events need the token and the Host check like everything else; broadcast ignores garbage', async (t) => {
  const { s, port, base } = await boot(t);
  assert.equal((await req(port, '/events')).status, 404);
  assert.equal((await req(port, base.pathname + 'events', { headers: { Host: 'evil.example' } })).status, 403);
  assert.doesNotThrow(() => { s.broadcast(null); s.broadcast('x'); s.broadcast(5); s.broadcast({ no: 'type' }); });
});

test('stop() ends the stream, frees the port and is safe to call twice', async (t) => {
  const s = new FloatServer({ mediaDir: MEDIA });
  const { port, url } = await s.start();
  const c = await sse(port, new URL(url).pathname + 'events');
  await wait(50);
  assert.equal(s.clients, 1);
  await s.stop();
  await s.stop();
  assert.equal(s.clients, 0);
  await assert.rejects(req(port, new URL(url).pathname), /ECONNREFUSED|ECONNRESET/);
  c.close();
});
