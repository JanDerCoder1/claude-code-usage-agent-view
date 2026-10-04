'use strict';
// Number and model formatting shared by the host-side modules (the webview carries its own copy of the same rules, SPEC 8.4).

/**
 * 'claude-sonnet-5-5' -> 'Sonnet 5.5', 'claude-haiku-4-5-20251001' -> 'Haiku 4.5', 'claude-opus-5[1m]' -> 'Opus 5 (1M)'.
 * Unknown ids come back unchanged; null, '' and '<synthetic>' (never a real model) give null.
 */
function prettyModel(id) {
  if (typeof id !== 'string') return null;
  const s = id.trim();
  if (!s || s === '<synthetic>') return null;
  const big = /\[1m\]$/i.test(s);
  const base = big ? s.replace(/\[1m\]$/i, '') : s;
  // current naming: claude-<family>-<major>[-<minor>][-<yyyymmdd>]
  let m = /^claude-([a-z]+)((?:-\d{1,2})*)(?:-\d{8})?$/i.exec(base);
  let fam, ver;
  if (m) { fam = m[1]; ver = m[2].split('-').filter(Boolean).join('.'); }
  else {
    // legacy naming: claude-<major>[-<minor>]-<family>[-<yyyymmdd>]
    m = /^claude-(\d{1,2}(?:-\d{1,2})?)-([a-z]+)(?:-\d{8})?$/i.exec(base);
    if (!m) return s;
    fam = m[2]; ver = m[1].split('-').join('.');
  }
  fam = fam[0].toUpperCase() + fam.slice(1).toLowerCase();
  return fam + (ver ? ' ' + ver : '') + (big ? ' (1M)' : '');
}

/** 999 -> '999', 43000 -> '43.0k', 380234 -> '380.2k', 1100000 -> '1.1M' (always one decimal, as in SPEC 8.1; same rule as media/main.js). */
function fmtTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '0';
  if (n < 999.5) return String(Math.round(n));
  if (n < 999950) return (n / 1e3).toFixed(1) + 'k';
  return (n / 1e6).toFixed(1) + 'M';
}

/** 'mm:ss' below one hour, 'h:mm:ss' from one hour; negative or non-finite input gives '00:00'. */
function fmtDur(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const two = x => (x < 10 ? '0' : '') + x;
  return h > 0 ? h + ':' + two(m) + ':' + two(s) : two(m) + ':' + two(s);
}

module.exports = { prettyModel, fmtTokens, fmtDur };
