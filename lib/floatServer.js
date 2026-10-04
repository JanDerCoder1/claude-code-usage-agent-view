'use strict';
// Local page server for the stand-alone floating window (a browser window in app mode shows the same cards as the side view).
// Loopback only (127.0.0.1, random port), every URL starts with a random 128-bit token, Host and Origin are checked, request bodies
// are capped, only three media files are served. It serves the page, a small bridge that gives main.js its acquireVsCodeApi(),
// the theme variables, a server-sent-events stream (host -> page) and one POST endpoint (page -> host).
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { themeCss, bodyClass } = require('./floatTheme');

const MEDIA_FILES = { 'main.js': 'text/javascript; charset=utf-8', 'main.css': 'text/css; charset=utf-8', 'icon.svg': 'image/svg+xml' };
const MAX_BODY = 64 * 1024;
const KEEPALIVE_MS = 15000;
const CSP = "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";

const BRIDGE = `(function () {
  var base = location.pathname.replace(/[^/]*$/, '');
  var KEY = 'agentView.state';
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (m) { try { fetch(base + 'msg', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m), keepalive: true }); } catch (e) { /* host gone */ } },
      getState: function () { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } },
      setState: function (s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* convenience only */ } return s; }
    };
  };
  var es = new EventSource(base + 'events');
  es.onmessage = function (ev) { try { window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(ev.data) })); } catch (e) { /* ignore */ } };
})();
`;

class FloatServer {
  /** @param {{ mediaDir: string, theme?: string, onMessage?: (m: object) => void, onClients?: (n: number) => void, log?: (s: string) => void }} opts */
  constructor(opts) {
    const o = opts || {};
    this.mediaDir = o.mediaDir;
    this.theme = o.theme || 'dark';
    this.onMessage = typeof o.onMessage === 'function' ? o.onMessage : () => {};
    this.onClients = typeof o.onClients === 'function' ? o.onClients : () => {};
    this.log = typeof o.log === 'function' ? o.log : () => {};
    this.token = crypto.randomBytes(16).toString('hex');
    this.port = 0;
    this._server = null;
    this._clients = new Set();
    this._last = new Map();           // last message per type, replayed to a page that connects later
    this._timer = null;
  }

  get clients() { return this._clients.size; }

  /** Starts listening; resolves { url, port }. */
  start() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => { try { this._handle(req, res); } catch (e) { this._end(res, 500, 'text/plain', 'error'); } });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this._server = server;
        this.port = server.address().port;
        this._timer = setInterval(() => this._write(': keepalive\n\n'), KEEPALIVE_MS);
        if (this._timer.unref) this._timer.unref();
        server.removeListener('error', reject);
        server.on('error', (e) => this.log('Server-Fehler: ' + (e && e.code)));
        resolve({ url: 'http://127.0.0.1:' + this.port + '/' + this.token + '/', port: this.port });
      });
    });
  }

  /** Sends a message to every connected page; the newest of each type is kept for pages that connect later. */
  broadcast(msg) {
    if (!msg || typeof msg !== 'object') return;
    const type = typeof msg.type === 'string' ? msg.type : '';
    const line = 'data: ' + JSON.stringify(msg) + '\n\n';   // SSE splits lines on CR and LF only, JSON.stringify never emits those
    if (type) this._last.set(type, line);
    this._write(line);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    for (const res of this._clients) { try { res.end(); } catch (e) { /* closed */ } }
    this._clients.clear();
    const s = this._server;
    this._server = null;
    return new Promise((resolve) => { if (!s) return resolve(); try { s.close(() => resolve()); if (s.closeAllConnections) s.closeAllConnections(); } catch (e) { resolve(); } });
  }

  _write(chunk) { for (const res of this._clients) { try { res.write(chunk); } catch (e) { /* the close event removes it */ } } }

  _end(res, code, type, body, extra) {
    if (res.headersSent) { try { res.end(); } catch (e) { /* ignore */ } return; }
    res.writeHead(code, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin' }, extra));
    res.end(body);
  }

  _hostOk(req) {
    const h = String(req.headers.host || '');
    return h === '127.0.0.1:' + this.port || h === 'localhost:' + this.port;
  }

  _originOk(req) {
    const o = req.headers.origin;
    return o === undefined || o === 'http://127.0.0.1:' + this.port || o === 'http://localhost:' + this.port;
  }

  _html() {
    return '<!DOCTYPE html>\n<html lang="de">\n<head>\n<meta charset="UTF-8">\n' +
      '<meta http-equiv="Content-Security-Policy" content="' + CSP + '">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
      '<link rel="stylesheet" href="theme.css">\n<link rel="stylesheet" href="main.css">\n<link rel="icon" href="icon.svg">\n' +
      '<title>Claude Code Utilities</title>\n</head>\n<body class="' + bodyClass(this.theme) + '">\n<div id="app" data-mode="floating"></div>\n' +
      '<script src="bridge.js"></script>\n<script src="main.js"></script>\n</body>\n</html>\n';
  }

  _handle(req, res) {
    if (!this._hostOk(req)) return this._end(res, 403, 'text/plain', 'forbidden');
    let pathname = '';
    try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch (e) { return this._end(res, 400, 'text/plain', 'bad request'); }
    const prefix = '/' + this.token + '/';
    if (!pathname.startsWith(prefix)) return this._end(res, 404, 'text/plain', 'not found');
    const rest = pathname.slice(prefix.length);

    if (req.method === 'POST' && rest === 'msg') return this._post(req, res);
    if (req.method !== 'GET') return this._end(res, 405, 'text/plain', 'method not allowed');

    if (rest === '' || rest === 'index.html') return this._end(res, 200, 'text/html; charset=utf-8', this._html(), { 'Content-Security-Policy': CSP });
    if (rest === 'bridge.js') return this._end(res, 200, 'text/javascript; charset=utf-8', BRIDGE);
    if (rest === 'theme.css') return this._end(res, 200, 'text/css; charset=utf-8', themeCss(this.theme));
    if (rest === 'events') return this._events(req, res);
    if (Object.prototype.hasOwnProperty.call(MEDIA_FILES, rest)) {
      let data;
      try { data = fs.readFileSync(path.join(this.mediaDir, rest)); } catch (e) { return this._end(res, 404, 'text/plain', 'not found'); }
      return this._end(res, 200, MEDIA_FILES[rest], data);
    }
    return this._end(res, 404, 'text/plain', 'not found');
  }

  _events(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'keep-alive', 'Cross-Origin-Resource-Policy': 'same-origin' });
    res.write('retry: 2000\n\n');
    for (const line of this._last.values()) res.write(line);
    this._clients.add(res);
    this.onClients(this._clients.size);
    const gone = () => { if (this._clients.delete(res)) this.onClients(this._clients.size); };
    req.on('close', gone);
    res.on('close', gone);
  }

  _post(req, res) {
    if (!this._originOk(req)) return this._end(res, 403, 'text/plain', 'forbidden');
    const chunks = [];
    let size = 0, over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY) { over = true; this._end(res, 413, 'text/plain', 'too large'); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      let msg = null;
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return this._end(res, 400, 'text/plain', 'bad json'); }
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return this._end(res, 400, 'text/plain', 'bad message');
      try { this.onMessage(msg); } catch (e) { this.log('Nachricht nicht verarbeitet: ' + (e && e.message)); }
      this._end(res, 204, 'text/plain', '');
    });
    req.on('error', () => { try { res.destroy(); } catch (e) { /* ignore */ } });
  }
}

module.exports = { FloatServer, BRIDGE, CSP, MAX_BODY };
