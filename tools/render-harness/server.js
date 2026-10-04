'use strict';
// Render harness (SPEC 11.4): serves the REAL media/main.js + main.css with a stub acquireVsCodeApi and injected
// --vscode-* theme variables, bound to 127.0.0.1 only. Open  /  for the fixture list or
//   /view?fixture=wf-running&theme=dark|light|hc|hclight[&open=all|none][&reduce=1][&fresh=1]
// Run: node tools/render-harness/server.js [--port 8766]
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MEDIA = path.resolve(__dirname, '..', '..', 'media');
const FIXTURES = path.join(__dirname, 'fixtures');
const MEDIA_FILES = { 'main.js': 'text/javascript', 'main.css': 'text/css', 'icon.svg': 'image/svg+xml' };
const HARNESS_FILES = { 'stub.js': 'text/javascript', 'vscode-default.css': 'text/css' };
const THEMES = ['dark', 'light', 'hc', 'hclight'];
const NAME = /^[a-z0-9-]{1,40}$/;

const listFixtures = () => fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();

// Same CSP as the real shell (extension.js, SPEC 8.3) with 'self' standing in for webview.cspSource.
function shell(fixtureName, nonce, mode) {
  let data = 'null';
  if (fixtureName && fixtureName !== 'none') data = fs.readFileSync(path.join(FIXTURES, fixtureName + '.json'), 'utf8').replace(/</g, '\\u003c');
  const csp = `default-src 'none'; style-src 'self'; script-src 'nonce-${nonce}'; img-src 'self' data:; font-src 'self'`;
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta ${['http', 'equiv'].join('-')}="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="/harness/vscode-default.css">
<link rel="stylesheet" href="/media/main.css">
<title>Claude Code Utilities harness</title>
</head>
<body>
<div id="app" data-mode="${mode === 'floating' ? 'floating' : 'view'}"></div>
<script type="application/json" id="fixture">${data}</script>
<script nonce="${nonce}" src="/harness/stub.js"></script>
<script nonce="${nonce}" src="/media/main.js"></script>
</body>
</html>
`;
}

function indexPage() {
  const rows = listFixtures().map((f) => `<tr><td>${f}</td>${THEMES.map((t) => `<td><a href="/view?fixture=${f}&amp;theme=${t}">${t}</a> <a href="/view?fixture=${f}&amp;theme=${t}&amp;open=all">open</a></td>`).join('')}</tr>`).join('\n');
  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><title>Claude Code Utilities harness</title>
<style>body{font:14px system-ui,sans-serif;margin:24px}td,th{padding:4px 14px 4px 0;text-align:left}img{width:24px;height:24px;vertical-align:middle;background:#ccc}</style></head>
<body><h1><img src="/media/icon.svg" alt="icon"> Claude Code Utilities render harness</h1><table><tr><th>fixture</th>${THEMES.map((t) => `<th>${t}</th>`).join('')}</tr>${rows}</table></body></html>
`;
}

function createServer() {
  return http.createServer((req, res) => {
    const send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type + (/^(text|application)\//.test(type) ? '; charset=utf-8' : ''), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(body);
    };
    // DNS-rebinding guard: only literal loopback host names are served
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(String(req.headers.host || ''))) return send(403, 'text/plain', 'forbidden');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'method not allowed');
    let u;
    try { u = new URL(req.url, 'http://127.0.0.1'); } catch (e) { return send(400, 'text/plain', 'bad request'); }
    const p = u.pathname;
    try {
      if (p === '/') return send(200, 'text/html', indexPage());
      if (p === '/view') {
        const fx = u.searchParams.get('fixture') || 'wf-running';
        if (fx !== 'none' && (!NAME.test(fx) || !listFixtures().includes(fx))) return send(404, 'text/plain', 'unknown fixture');
        return send(200, 'text/html', shell(fx, crypto.randomBytes(16).toString('hex'), u.searchParams.get('mode')));
      }
      let m = /^\/media\/([a-z.]+)$/.exec(p);
      if (m && MEDIA_FILES[m[1]]) return send(200, MEDIA_FILES[m[1]], fs.readFileSync(path.join(MEDIA, m[1])));
      m = /^\/harness\/([a-z.-]+)$/.exec(p);
      if (m && HARNESS_FILES[m[1]]) return send(200, HARNESS_FILES[m[1]], fs.readFileSync(path.join(__dirname, m[1])));
      m = /^\/fixtures\/([a-z0-9-]+)\.json$/.exec(p);
      if (m && listFixtures().includes(m[1])) return send(200, 'application/json', fs.readFileSync(path.join(FIXTURES, m[1] + '.json')));
    } catch (e) {
      return send(500, 'text/plain', 'error: ' + e.message);
    }
    return send(404, 'text/plain', 'not found');
  });
}

/** Starts the harness on 127.0.0.1; port 0 picks a free one. Resolves { server, port, url, close() }. */
function start(opts) {
  const port = opts && typeof opts.port === 'number' ? opts.port : 8766;
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({ server, port: actual, url: `http://127.0.0.1:${actual}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

module.exports = { start, createServer, shell, listFixtures };

if (require.main === module) {
  const i = process.argv.indexOf('--port');
  start({ port: i > 0 ? Number(process.argv[i + 1]) : 8766 }).then((h) => console.log('harness on ' + h.url), (e) => { console.error(e.message); process.exit(1); });
}
