#!/usr/bin/env node
'use strict';
// Lists the central directory of a zip/vsix with raw entry names (shows backslash problems) and verifies CRC32 by
// inflating every entry. Exit code 1 when a CRC fails or a name contains a backslash.
// usage: node zip-list.js file.vsix        (also usable as a module: listZip(buffer), readZip(buffer))
const fs = require('fs');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
  return t;
})();

function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Reads every entry: [{ name, method, usize, data: Buffer|null (null for directories), crcOk: boolean|null }]. */
function readZip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('no EOCD: not a zip');
  const n = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const entries = [];
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28);
    const el = buf.readUInt16LE(p + 30);
    const cl = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    let data = null;
    let crcOk = null;
    if (!name.endsWith('/')) {
      const lnl = buf.readUInt16LE(lho + 26);
      const lel = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + lnl + lel;
      const raw = buf.subarray(start, start + csize);
      data = method === 8 ? zlib.inflateRawSync(raw) : raw;
      crcOk = crc32(data) === crc && data.length === usize;
    }
    entries.push({ name, method, usize, data, crcOk });
    p += 46 + nl + el + cl;
  }
  return entries;
}

/** @returns {{ entries: {name:string, usize:number, method:number, crcOk:boolean|null}[], badCrc:number, backslash:number }} */
function listZip(buf) {
  const all = readZip(buf);
  return {
    entries: all.map((x) => ({ name: x.name, usize: x.usize, method: x.method, crcOk: x.crcOk })),
    badCrc: all.filter((x) => x.crcOk === false).length,
    backslash: all.filter((x) => x.name.includes('\\')).length,
  };
}

function main(file) {
  if (!file) { console.error('usage: node zip-list.js file.vsix'); return 2; }
  const r = listZip(fs.readFileSync(file));
  for (const x of r.entries) {
    const ok = x.crcOk === null ? '-' : x.crcOk ? 'crc-ok' : 'CRC-BAD';
    console.log(`${String(x.usize).padStart(7)}  m${x.method}  ${ok}  ${JSON.stringify(x.name)}`);
  }
  console.log(`${r.entries.length} entries, ${r.badCrc} crc errors, ${r.backslash} names containing backslash`);
  return r.badCrc > 0 || r.backslash > 0 ? 1 : 0;
}

module.exports = { listZip, readZip, crc32 };

if (require.main === module) {
  try { process.exitCode = main(process.argv[2]); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
