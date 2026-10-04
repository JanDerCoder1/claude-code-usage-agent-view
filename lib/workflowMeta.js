'use strict';
// Literal-only parser for `export const meta = {...}` of a workflow script (SPEC 5.2 step 7). Nothing is evaluated:
// objects, arrays, strings ('"` without ${}), numbers, true/false/null, comments and "a" + "b" concatenation are understood,
// anything else (calls, identifiers, template expressions) throws internally and falls back to a regex over the first 4 KB.

const ESC = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
const MAX_SOURCE = 2 * 1024 * 1024;   // a script larger than this is not a plausible workflow script

function parseLiteral(src, start) {
  let i = start;
  const n = src.length;
  const ws = () => {
    for (;;) {
      while (i < n && /\s/.test(src[i])) i++;
      if (src[i] === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; }
      else if (src[i] === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) throw new Error('eof'); i = e + 2; }
      else return;
    }
  };
  const hex = len => {
    const h = src.slice(i, i + len);
    if (h.length !== len || !/^[0-9a-fA-F]+$/.test(h)) throw new Error('escape');
    i += len;
    return parseInt(h, 16);
  };
  const str = () => {
    const q = src[i++];
    let out = '';
    for (;;) {
      if (i >= n) throw new Error('eof');
      const c = src[i++];
      if (c === q) return out;
      if (q === '`' && c === '$' && src[i] === '{') throw new Error('template expr');
      if (c !== '\\') { out += c; continue; }
      const d = src[i++];
      if (d === 'u') {
        if (src[i] === '{') { const e = src.indexOf('}', i); if (e < 0) throw new Error('escape'); out += String.fromCodePoint(parseInt(src.slice(i + 1, e), 16)); i = e + 1; }
        else out += String.fromCharCode(hex(4));
      } else if (d === 'x') out += String.fromCharCode(hex(2));
      else if (d === '\r') { if (src[i] === '\n') i++; }             // line continuation
      else if (d === '\n') { /* line continuation */ }
      else out += ESC[d] !== undefined ? ESC[d] : d;
    }
  };
  const value = () => {
    ws();
    const c = src[i];
    if (c === '{') {
      i++;
      const o = Object.create(null);                                  // a "__proto__" key stays an ordinary key
      for (;;) {
        ws();
        if (src[i] === '}') { i++; return o; }
        let k;
        if (/["'`]/.test(src[i])) k = str();
        else { const mm = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 80)); if (!mm) throw new Error('key@' + i); k = mm[0]; i += k.length; }
        ws();
        if (src[i++] !== ':') throw new Error('colon@' + i);
        o[k] = value();
        ws();
        if (src[i] === ',') i++; else if (src[i] !== '}') throw new Error('sep@' + i);
      }
    }
    if (c === '[') {
      i++;
      const a = [];
      for (;;) {
        ws();
        if (src[i] === ']') { i++; return a; }
        a.push(value());
        ws();
        if (src[i] === ',') i++; else if (src[i] !== ']') throw new Error('sep@' + i);
      }
    }
    if (c === '"' || c === "'" || c === '`') {
      let s = str();
      for (;;) {
        ws();
        if (src[i] === '+') { i++; ws(); if (!/["'`]/.test(src[i])) throw new Error('concat'); s += str(); } else return s;
      }
    }
    const lit = /^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(src.slice(i, i + 40));
    if (lit) {
      i += lit[0].length;
      return lit[0] === 'true' ? true : lit[0] === 'false' ? false : lit[0] === 'null' ? null : Number(lit[0]);
    }
    throw new Error('unsupported@' + i + ':' + c);
  };
  return value();
}

const asString = v => (typeof v === 'string' ? v : null);

function normalizePhases(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const p of list) {
    if (typeof p === 'string') out.push({ title: p, detail: null });
    else if (p && typeof p === 'object' && typeof p.title === 'string') out.push({ title: p.title, detail: asString(p.detail) });
  }
  return out;
}

/**
 * @param {string} source text of a workflow script
 * @returns {{name:string|null, description:string|null, phases:{title:string, detail:string|null}[], degraded:boolean}|null}
 *   null when the script has no `export const meta =`; degraded:true when only the regex fallback could read it
 */
function extractMetaSafe(source) {
  if (typeof source !== 'string' || source.length > MAX_SOURCE) return null;
  const m = /export\s+const\s+meta\s*=\s*/.exec(source);
  if (!m) return null;
  try {
    const v = parseLiteral(source, m.index + m[0].length);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return { name: asString(v.name), description: asString(v.description), phases: normalizePhases(v.phases), degraded: false };
    }
  } catch (_) { /* fall through to the degraded reader */ }
  const lit = source.slice(m.index, m.index + 4000);
  const plain = x => (x && !x[2].includes('${') ? x[2] : null);   // a template with an expression is not a literal
  const name = /name\s*:\s*(['"`])([^'"`\n]+)\1/.exec(lit);
  const description = /description\s*:\s*(['"`])([^'"`\n]+)\1/.exec(lit);
  const phases = [...lit.matchAll(/title\s*:\s*(['"`])([^'"`\n]+)\1(?:\s*,\s*detail\s*:\s*(['"`])([^'"`\n]*)\3)?/g)]
    .filter(x => plain(x) !== null)
    .map(x => ({ title: x[2], detail: x[4] === undefined || x[4].includes('${') ? null : x[4] }));
  return { name: plain(name), description: plain(description), phases, degraded: true };
}

module.exports = { extractMetaSafe };
