'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prettyModel, fmtTokens, fmtDur } = require('../lib/format');

test('prettyModel: SPEC fact 10 / contract examples', () => {
  assert.equal(prettyModel('claude-sonnet-5-5'), 'Sonnet 5.5');
  assert.equal(prettyModel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(prettyModel('claude-opus-5[1m]'), 'Opus 5 (1M)');
});

test('prettyModel: every model id seen in the real session files', () => {
  assert.equal(prettyModel('claude-opus-5'), 'Opus 5');
  assert.equal(prettyModel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(prettyModel('claude-opus-5-5[1m]'), 'Opus 5.5 (1M)');
  assert.equal(prettyModel('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(prettyModel('claude-fable-5-1'), 'Fable 5.1');
});

test('prettyModel: date suffix with and without minor version, [1m] case-insensitive', () => {
  assert.equal(prettyModel('claude-sonnet-4-20250514'), 'Sonnet 4');
  assert.equal(prettyModel('claude-opus-4-1-20250805'), 'Opus 4.1');
  assert.equal(prettyModel('claude-haiku-4-5-20251001[1m]'), 'Haiku 4.5 (1M)');
  assert.equal(prettyModel('claude-opus-5[1M]'), 'Opus 5 (1M)');
});

test('prettyModel: legacy naming (version before family)', () => {
  assert.equal(prettyModel('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
  assert.equal(prettyModel('claude-3-opus-20240229'), 'Opus 3');
});

test('prettyModel: unknown ids stay unchanged, synthetic and empty give null', () => {
  assert.equal(prettyModel('gpt-4o'), 'gpt-4o');
  assert.equal(prettyModel('claude-sonnet-latest-x'), 'claude-sonnet-latest-x');
  assert.equal(prettyModel('<synthetic>'), null);
  assert.equal(prettyModel(null), null);
  assert.equal(prettyModel(undefined), null);
  assert.equal(prettyModel(''), null);
  assert.equal(prettyModel(42), null);
});

test('fmtTokens: plain, thousands, millions', () => {
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(999), '999');
  assert.equal(fmtTokens(1000), '1.0k');
  assert.equal(fmtTokens(1500), '1.5k');
  assert.equal(fmtTokens(39070), '39.1k');
  assert.equal(fmtTokens(43000), '43.0k');                  // SPEC 8.1 example: always one decimal
  assert.equal(fmtTokens(380234), '380.2k');
  assert.equal(fmtTokens(468112), '468.1k');
  assert.equal(fmtTokens(1100000), '1.1M');
  assert.equal(fmtTokens(1000000), '1.0M');
  assert.equal(fmtTokens(12345678), '12.3M');
});

test('fmtTokens: rounding never produces "1000.0k" and bad input gives 0', () => {
  assert.equal(fmtTokens(999949), '999.9k');
  assert.equal(fmtTokens(999950), '1.0M');
  assert.equal(fmtTokens(999999), '1.0M');
  assert.equal(fmtTokens(999.6), '1.0k');
  assert.equal(fmtTokens(-5), '0');
  assert.equal(fmtTokens(NaN), '0');
  assert.equal(fmtTokens(Infinity), '0');
  assert.equal(fmtTokens('12'), '0');
  assert.equal(fmtTokens(null), '0');
});

test('fmtDur: mm:ss below one hour, h:mm:ss from one hour', () => {
  assert.equal(fmtDur(0), '00:00');
  assert.equal(fmtDur(999), '00:00');
  assert.equal(fmtDur(1000), '00:01');
  assert.equal(fmtDur(18622), '00:18');
  assert.equal(fmtDur(60000), '01:00');
  assert.equal(fmtDur(21 * 60000 + 13000), '21:13');
  assert.equal(fmtDur(3599999), '59:59');
  assert.equal(fmtDur(3600000), '1:00:00');
  assert.equal(fmtDur(3661000), '1:01:01');
  assert.equal(fmtDur(10 * 3600000), '10:00:00');
  assert.equal(fmtDur(4494873), '1:14:54');
});

test('fmtDur: negative, NaN, infinite and non-number input give 00:00', () => {
  assert.equal(fmtDur(-1), '00:00');
  assert.equal(fmtDur(NaN), '00:00');
  assert.equal(fmtDur(Infinity), '00:00');
  assert.equal(fmtDur(undefined), '00:00');
  assert.equal(fmtDur(null), '00:00');
  assert.equal(fmtDur('5000'), '00:00');
});

// The webview carries its own copy of these rules (media/main.js cannot require lib/): keep both in lock-step.
let W = null;
try { W = require('../media/main.js'); } catch (_) { W = null; }
const skipParity = W && W.fmtTokens && W.fmtDur && W.prettyModel ? false : 'media/main.js helpers not available';

test('parity with the webview copy: fmtTokens, fmtDur, prettyModel', { skip: skipParity }, () => {
  const nums = [0, 1, 7, 999, 999.4, 999.5, 1000, 1049, 1050, 1150, 2250, 12345, 43000, 99999, 380234, 999949, 999950, 999999, 1e6, 1.05e6, 1100000, 12345678, 1e9];
  for (const n of nums) assert.equal(W.fmtTokens(n), fmtTokens(n), 'fmtTokens(' + n + ')');
  const durs = [0, 999, 1000, 18622, 59999, 60000, 21 * 60000 + 13000, 3599999, 3600000, 3661000, 36000000, 100 * 3600000];
  for (const d of durs) assert.equal(W.fmtDur(d), fmtDur(d), 'fmtDur(' + d + ')');
  const ids = ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-opus-5[1m]', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-4-20250514',
    'claude-3-5-sonnet-20241022', 'gpt-4o', '<synthetic>', '', null];
  for (const id of ids) assert.equal(W.prettyModel(id), prettyModel(id), 'prettyModel(' + id + ')');
});
