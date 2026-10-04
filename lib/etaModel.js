'use strict';
// Statistical core of the remaining-time estimate (SPEC 6, v0.9.5). Pure functions: no I/O, no clock, seconds everywhere.
//
// Model: the duration D of a workflow agent is log-normal, ln D = mu(x) + u_run + v_phase + eps with
//   mu(x) = beta0 + beta1 * ln(agents started in the phase) + beta2 * position of the phase in the run (0 = first, 1 = last)
//   u_run ~ N(0, tauR^2)    effect shared by every agent of one run (a heavy task makes all of its agents slow)
//   v_phase ~ N(0, tauP^2)  effect shared by the agents of one phase
//   eps ~ N(0, s^2)         what is left per agent
// Evidence for u and v of the CURRENT run comes from the agents that already finished in this run (exact values) and from the
// ones that are still running (right-censored: they last at least as long as they have run so far). The posterior of
// theta = u + v is computed on a grid; the remaining time of an agent is then a mixture of truncated log-normals.
// beta is fitted from the history (ridge regression toward the priors below, so a fresh install still works).
//
// Why this and not "median of the finished siblings": on the 82 workflow runs of the author the agents of one run and phase differ
// by a factor of 1.5 only (sd 0.39 of ln D) while the agents of different runs differ by a factor of 2.5 (sd 0.9). Finished siblings
// are biased short (the slow ones are still running), which the censoring handles.

// ---- standard normal distribution ---------------------------------------------------------------------------------------------

// CDF, Hart (1968) as published by West (2005): double precision, accurate far into both tails (rel. error < 1e-9 up to |x| = 6).
const PHI_A = [3.52624965998911e-02, 0.700383064443688, 6.37396220353165, 33.912866078383, 112.079291497871, 221.213596169931, 220.206867912376];
const PHI_B = [8.83883476483184e-02, 1.75566716318264, 16.064177579207, 86.7807322029461, 296.564248779674, 637.333633378831, 793.826512519948, 440.413735824752];
function phi(x) {
  const ax = Math.abs(x);
  let c;
  if (ax > 37) c = 0;
  else {
    const e = Math.exp(-ax * ax / 2);
    if (ax < 7.07106781186547) {
      let b = PHI_A[0];
      for (let i = 1; i < 7; i++) b = b * ax + PHI_A[i];
      let d = PHI_B[0];
      for (let i = 1; i < 8; i++) d = d * ax + PHI_B[i];
      c = e * b / d;
    } else {
      let b = ax + 0.65;
      b = ax + 4 / b; b = ax + 3 / b; b = ax + 2 / b; b = ax + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}
const surv = (x) => phi(-x);   // 1 - Phi(x), exact in the upper tail

// Inverse CDF, Acklam's rational approximation plus one Halley step (relative error < 1e-15).
const AC_A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
const AC_B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
const AC_C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
const AC_D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
function phiInv(p) {
  if (!(p > 0)) return -Infinity;
  if (!(p < 1)) return Infinity;
  let x;
  if (p < 0.02425 || p > 1 - 0.02425) {
    const upper = p > 0.5;
    const q = Math.sqrt(-2 * Math.log(upper ? 1 - p : p));
    const t = (((((AC_C[0] * q + AC_C[1]) * q + AC_C[2]) * q + AC_C[3]) * q + AC_C[4]) * q + AC_C[5]) / ((((AC_D[0] * q + AC_D[1]) * q + AC_D[2]) * q + AC_D[3]) * q + 1);
    x = upper ? -t : t;
  } else {
    const q = p - 0.5, r = q * q;
    x = (((((AC_A[0] * r + AC_A[1]) * r + AC_A[2]) * r + AC_A[3]) * r + AC_A[4]) * r + AC_A[5]) * q / (((((AC_B[0] * r + AC_B[1]) * r + AC_B[2]) * r + AC_B[3]) * r + AC_B[4]) * r + 1);
  }
  const e = phi(x) - p, u = e * 2.5066282746310002 * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}

// Deterministic generator (mulberry32): the same input always gives the same estimate, so the chip does not flicker.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- parameters ------------------------------------------------------------------------------------------------------------------

// The priors were fitted on 82 runs / 679 finished agents of one user; the history regression moves them toward the user's own data.
const PARAMS = Object.freeze({
  beta: Object.freeze([7.0, -0.55, -0.6]),   // prior regression coefficients (intercept, ln phase size, phase position)
  ridge: 10,                                  // strength of the prior in pseudo-observations
  minRows: 10,                                // fewer history agents: the prior alone
  tauR: 0.75,                                 // sd of the run effect
  tauP: 0.45,                                 // sd of the phase effect
  s: 0.45,                                    // sd per agent inside one run and phase
  grid: 101, gridMax: 4,                      // posterior grid for theta = u + v
  phaseMean: 6.55, phaseSd: 0.9, phaseKappa: 1.0, // phases that have not started: ln duration (median 11.6 min), carry-over of the run effect
  samples: 1200,                              // Monte Carlo samples for the workflow level
});

const clampLn = (sec) => Math.log(Math.max(1, sec));

// ---- regression of ln D on (1, ln phase size, phase position) from history rows {ln, np, pos} -----------------------------------

function solve(A, b) {
  const k = b.length;
  A = A.map((r) => r.slice()); b = b.slice();
  for (let i = 0; i < k; i++) {
    let p = i;
    for (let j = i + 1; j < k; j++) if (Math.abs(A[j][i]) > Math.abs(A[p][i])) p = j;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let j = i + 1; j < k; j++) {
      const f = A[j][i] / A[i][i];
      for (let l = i; l < k; l++) A[j][l] -= f * A[i][l];
      b[j] -= f * b[i];
    }
  }
  const w = new Array(k).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    let s = b[i];
    for (let l = i + 1; l < k; l++) s -= A[i][l] * w[l];
    w[i] = s / A[i][i];
  }
  return w;
}

function fitBeta(rows, params) {
  const P = params || PARAMS;
  const prior = P.beta.slice();
  if (!Array.isArray(rows) || rows.length < P.minRows) return prior;
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (const r of rows) {
    const x = [1, Math.log(Math.max(1, r.np)), r.pos];
    for (let p = 0; p < 3; p++) {
      b[p] += x[p] * r.ln;
      for (let q = 0; q < 3; q++) A[p][q] += x[p] * x[q];
    }
  }
  for (let p = 0; p < 3; p++) { A[p][p] += P.ridge; b[p] += P.ridge * prior[p]; }
  const w = solve(A, b);
  return w.every(Number.isFinite) ? w : prior;
}

const meanLn = (np, pos, beta) => beta[0] + beta[1] * Math.log(Math.max(1, np)) + beta[2] * pos;

// Posterior of the run effect u from the finished agents of the OTHER phases of the same run.
// others = [{ size, pos, doneSec: [] }]. Returns the Gaussian N(m, v).
function runEffect(others, beta, P) {
  let prec = 1 / (P.tauR * P.tauR), num = 0;
  for (const ph of others || []) {
    const d = ph && Array.isArray(ph.doneSec) ? ph.doneSec : [];
    if (!d.length) continue;
    const m = meanLn(ph.size, ph.pos, beta);
    const mean = d.reduce((s, v) => s + clampLn(v) - m, 0) / d.length;
    const v = P.tauP * P.tauP + P.s * P.s / d.length;
    prec += 1 / v; num += mean / v;
  }
  return { m: num / prec, v: 1 / prec };
}

// Grid posterior of theta for the current phase. cens = elapsed seconds of agents that are still running (right-censored).
function posterior(ctx, beta, P, cens) {
  const muT = meanLn(ctx.size, ctx.pos, beta);
  const u = runEffect(ctx.others, beta, P);
  const sdTheta = Math.sqrt(u.v + P.tauP * P.tauP);
  const G = P.grid, lo = -P.gridMax, step = (2 * P.gridMax) / (G - 1);
  const th = new Float64Array(G), lw = new Float64Array(G);
  const lnDone = (ctx.doneSec || []).map(clampLn);
  const lnCens = cens.map(clampLn);
  for (let g = 0; g < G; g++) {
    const t = lo + g * step;
    th[g] = t;
    const z = (t - u.m) / sdTheta;
    let l = -0.5 * z * z;
    for (const x of lnDone) { const r = (x - muT - t) / P.s; l += -0.5 * r * r; }
    for (const x of lnCens) l += Math.log(Math.max(1e-300, surv((x - muT - t) / P.s)));
    lw[g] = l;
  }
  return { muT, th, lw, uMean: u.m };
}

/**
 * Remaining time of ONE running agent.
 * ctx = { size, pos, elapsedSec, doneSec: [finished siblings], runningSec: [elapsed of the other running siblings], others: [...] }
 * Returns { quantile(p) -> seconds of remaining time, survive -> probability that an agent like this lasts longer than it has run }.
 */
function predictAgent(ctx, beta, params) {
  const P = Object.assign({}, PARAMS, params || {});
  const e = Math.max(1, ctx.elapsedSec);
  const cens = (ctx.runningSec || []).slice();
  const post = posterior(ctx, beta, P, cens);   // evidence WITHOUT the target's own survival
  const { muT, th, lw } = post;
  const G = th.length, le = Math.log(e);
  const lsT = new Float64Array(G), pe = new Float64Array(G);   // pe: P(D <= elapsed | theta), the part of the cdf that does not depend on x
  let mx = -Infinity;
  for (let g = 0; g < G; g++) {
    const z = (le - muT - th[g]) / P.s;
    pe[g] = phi(z);
    lsT[g] = Math.log(Math.max(1e-300, surv(z)));
    mx = Math.max(mx, lw[g] + lsT[g]);
  }
  const wp = new Float64Array(G);   // evidence of the others, scaled
  let den = 0, all = 0;
  for (let g = 0; g < G; g++) { wp[g] = Math.exp(lw[g] - mx); all += wp[g]; den += Math.exp(lw[g] + lsT[g] - mx); }
  const cdf = (x) => {
    const lx = Math.log(e + Math.max(0, x));
    let num = 0;
    for (let g = 0; g < G; g++) num += wp[g] * (phi((lx - muT - th[g]) / P.s) - pe[g]);
    return Math.min(1, Math.max(0, num / den));
  };
  const quantile = (p) => {
    let a = 0, b = 1;
    while (cdf(b) < p && b < 1e7) b *= 2;
    for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (cdf(m) < p) a = m; else b = m; }   // 40 halvings: far below a second of error
    return (a + b) / 2;
  };
  return { quantile, survive: all > 0 ? den / all : 0 };
}

/**
 * Remaining time of the WHOLE workflow: the slowest running agent of the current phase (all agents share theta, so this is a
 * maximum over conditionally independent truncated log-normals) plus every phase that has not started yet.
 * ctx = { size, pos, runningSec: [elapsed of all running agents of the phase], doneSec: [...], others: [...], ahead: n, phaseMean?, phaseSd? }
 * Returns { quantile(p) -> seconds }.
 */
function predictWorkflow(ctx, beta, params) {
  const P = Object.assign({}, PARAMS, params || {});
  const running = ctx.runningSec || [];
  const post = posterior(ctx, beta, P, running);
  const { muT, th, lw, uMean } = post;
  const G = th.length;
  let mx = -Infinity;
  for (let g = 0; g < G; g++) mx = Math.max(mx, lw[g]);
  const cum = new Float64Array(G);
  let tot = 0;
  for (let g = 0; g < G; g++) { tot += Math.exp(lw[g] - mx); cum[g] = tot; }
  const rnd = rng(12345);
  const N = P.samples, out = new Float64Array(N);
  const pm = Number.isFinite(ctx.phaseMean) ? ctx.phaseMean : P.phaseMean;
  const ps = Number.isFinite(ctx.phaseSd) ? ctx.phaseSd : P.phaseSd;
  const ahead = Math.max(0, Math.floor(ctx.ahead || 0));
  for (let i = 0; i < N; i++) {
    let g = 0;
    const u = rnd() * tot;
    while (g < G - 1 && cum[g] < u) g++;
    const t = th[g];
    let slowest = 0;
    for (const e of running) {
      const se = Math.max(1e-300, surv((clampLn(e) - muT - t) / P.s));
      const z = -phiInv(Math.max(1e-300, se * (1 - rnd())));
      slowest = Math.max(slowest, Math.exp(muT + t + P.s * z) - e);
    }
    let later = 0;
    for (let p = 0; p < ahead; p++) {
      const z = phiInv(Math.min(1 - 1e-12, Math.max(1e-12, rnd())));
      later += Math.exp(pm + P.phaseKappa * uMean + ps * z);
    }
    out[i] = slowest + later;
  }
  const sorted = Array.from(out).sort((a, b) => a - b);
  return { quantile: (p) => sorted[Math.min(N - 1, Math.max(0, Math.floor(p * N)))] };
}

// Remaining time of an agent without phase information (Agent-tool subagent): plain log-normal of its own history.
function lognormalRemaining(mean, sd, elapsedSec, p) {
  const e = Math.max(1, elapsedSec);
  const se = Math.max(1e-300, surv((Math.log(e) - mean) / sd));
  return Math.exp(mean + sd * -phiInv(Math.max(1e-300, se * (1 - p)))) - e;
}

module.exports = { PARAMS, phi, phiInv, surv, rng, fitBeta, meanLn, predictAgent, predictWorkflow, lognormalRemaining };
