'use strict';
// Incremental JSONL reader (SPEC 4.1): byte offset + carry, only complete lines are parsed, bounded read per poll.
// Never throws: a missing or unreadable file is reported through the result, not an exception.
const fs = require('fs');

// A line longer than this is not a transcript line (the longest real ones are a few hundred KB): it is skipped, so a file
// without any newline cannot make the carry grow without bound (and each poll re-copy all of it).
const CARRY_MAX = 8 * 1024 * 1024;

class Tail {
  /** @param {string} file absolute path of the .jsonl file */
  constructor(file) {
    this.file = file;
    this.offset = 0;            // bytes of the file consumed so far (complete lines + carry)
    this.carry = Buffer.alloc(0); // bytes after the last newline, waiting for the rest of the line
    this._skip = false;         // inside an over-long line: everything up to the next newline is dropped
    this.badLines = 0;          // complete lines that were not a JSON object, since the last reset (an over-long line counts as one)
    this._stat = null;          // {size, mtimeMs} seen by the previous poll
    this._gone = false;         // file vanished since the previous poll
  }

  /**
   * @param {number} maxBytes read cap for this call (per-file/per-tick budget); 0 reads nothing
   * @returns {{lines:object[], loading:boolean, reset:boolean, badLines:number, missing:boolean,
   *            size:number, mtimeMs:number, changed:boolean, bytesRead:number}}
   *   lines     parsed objects of the newly completed lines, in file order
   *   loading   unread bytes remain (cap reached): call again, the data is still incomplete
   *   reset     the file shrank or was replaced: the caller must discard its folded state and refold from `lines`
   *   badLines  cumulative count of unparsable complete lines (torn writes in the middle of a file)
   *   changed   false when (size, mtime) are unchanged and nothing is left to read (then `lines` is empty)
   */
  poll(maxBytes) {
    const cap = typeof maxBytes === 'number' && maxBytes > 0 ? Math.floor(maxBytes) : 0;   // NaN, negative, non-number: read nothing; Infinity: no cap
    let st;
    try { st = fs.statSync(this.file); } catch (_) {
      this._gone = true;
      this._stat = null;
      return { lines: [], loading: false, reset: false, badLines: this.badLines, missing: true, size: 0, mtimeMs: 0, changed: true, bytesRead: 0 };
    }
    if (!st.isFile()) {
      return { lines: [], loading: false, reset: false, badLines: this.badLines, missing: true, size: 0, mtimeMs: 0, changed: false, bytesRead: 0 };
    }
    const size = st.size, mtimeMs = st.mtimeMs;
    let reset = false;
    if (size < this.offset || (this._gone && this.offset > 0)) {
      this.offset = 0; this.carry = Buffer.alloc(0); this._skip = false; this.badLines = 0; this._stat = null; reset = true;
    }
    this._gone = false;
    const same = !!this._stat && this._stat.size === size && this._stat.mtimeMs === mtimeMs;
    if (same && !reset && this.offset >= size) {
      return { lines: [], loading: false, reset: false, badLines: this.badLines, missing: false, size, mtimeMs, changed: false, bytesRead: 0 };
    }
    let lines = [], bytesRead = 0;
    const want = Math.min(size - this.offset, cap);
    if (want > 0) {
      let fd = null;
      try {
        fd = fs.openSync(this.file, 'r');
        const buf = Buffer.allocUnsafe(want);
        let got = 0;
        while (got < want) {
          const n = fs.readSync(fd, buf, got, want - got, this.offset + got);
          if (n <= 0) break;
          got += n;
        }
        bytesRead = got;
        if (got > 0) {
          this.offset += got;
          lines = this._split(Buffer.concat([this.carry, buf.subarray(0, got)]));
        }
      } catch (_) {
        // locked or vanished between stat and read: report "unchanged" and retry on the next poll
        return { lines: [], loading: this.offset < size, reset, badLines: this.badLines, missing: false, size, mtimeMs, changed: reset, bytesRead: 0 };
      } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
      }
    }
    this._stat = { size, mtimeMs };
    return { lines, loading: this.offset < size, reset, badLines: this.badLines, missing: false, size, mtimeMs, changed: !same || reset || bytesRead > 0, bytesRead };
  }

  // Newlines (0x0A) never occur inside a multi-byte UTF-8 sequence, so cutting at the last one cannot split a character.
  _split(chunk) {
    if (this._skip) {                                    // the rest of an over-long line: drop it up to its newline
      const nl = chunk.indexOf(0x0a);
      if (nl === -1) { this.carry = Buffer.alloc(0); return []; }
      chunk = chunk.subarray(nl + 1);
      this._skip = false;
    }
    const cut = chunk.lastIndexOf(0x0a);
    if (cut === -1) {
      if (chunk.length > CARRY_MAX) { this._skip = true; this.badLines++; this.carry = Buffer.alloc(0); return []; }
      this.carry = chunk;
      return [];
    }
    this.carry = Buffer.from(chunk.subarray(cut + 1));   // copy: do not pin the whole chunk in memory
    if (this.carry.length > CARRY_MAX) { this.carry = Buffer.alloc(0); this._skip = true; this.badLines++; }
    const out = [];
    for (const raw of chunk.toString('utf8', 0, cut).split('\n')) {
      if (!raw || !raw.trim()) continue;
      let o;
      try { o = JSON.parse(raw); } catch (_) { this.badLines++; continue; }
      if (o && typeof o === 'object' && !Array.isArray(o)) out.push(o); else this.badLines++;
    }
    return out;
  }
}

module.exports = { Tail, CARRY_MAX };
