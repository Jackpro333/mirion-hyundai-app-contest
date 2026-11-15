'use strict';

const T = require('./thermal');
const C = require('./comfort');

const NV = 4;
const SOFT = 0.05;

const DEFAULTS = Object.freeze({
  dt: 60,
  block: 2,
  horizon: 20,
  wEnergy: 1,
  wComfort: 0.02,
  wComfortLin: 0.02,
  wFog: 0.5,
  wCo2: 0.05,
  wSmooth: 0.002,
  wLocalSmooth: 0.004,
  wTerminal: 0.15,
  wAir: 0.02,
  airMin: 17,
  airMax: 28,
  localMax: 2,
  fogLimit: 2.0,
  co2Target: 1100,
  iterations: 1000,
  tolerance: 1e-5,
  memory: 8,
  solver: 'pqn',
});

function decode(z, k, veh, heating, localMax, out = {}) {
  out.q = heating ? z[NV * k] * veh.qHeatMax : -z[NV * k] * veh.qCoolMax;
  out.recirc = z[NV * k + 1] * 0.9;
  out.local = heating ? z[NV * k + 2] * localMax : -z[NV * k + 2] * localMax;
  out.defrost = z[NV * k + 3];
  out.heating = heating;
  return out;
}

function createProblem(s0, envAt, steps, target, veh, cfg, heating, continues, prevLocal) {
  const blocks = Math.ceil(cfg.horizon / cfg.block);
  const n = blocks * NV;
  const used = Math.min(blocks, Math.ceil(steps / cfg.block));
  const traj = Array.from({ length: steps + 1 }, () => ({}));
  const us = Array.from({ length: blocks }, () => ({ q: 0, recirc: 0, local: 0, defrost: 0 }));
  const gus = Array.from({ length: blocks }, () => ({ q: 0, recirc: 0, local: 0, defrost: 0 }));
  const envs = Array.from({ length: steps }, (_, i) => envAt(i));
  const minutes = cfg.dt / 60;
  const fw = C.glassShare(veh);
  const lam = { ta: 0, tm: 0, tw: 0, tg: 0, ts: 0, w: 0, co2: 0 };
  const pg = { q: 0, local: 0 };
  const blockOf = (i) => Math.min((i / cfg.block) | 0, blocks - 1);
  const localGain = heating ? C.LOCAL_HEAT_K : C.LOCAL_VENT_K;

  function comfortTerm(s, env, u, scaleQuad, scaleLin, back, gu) {
    const teq = C.equivalentTemp(s, env, u.local, veh);
    const d = C.discomfort(teq, target);
    if (d <= 0) return 0;
    const soft = Math.sqrt(d * d + SOFT * SOFT);
    if (back) {
      const g = (2 * scaleQuad * d + (scaleLin * d) / soft) * (teq > target ? 1 : -1);
      lam.ta += g * C.W_AIR;
      lam.tm += g * C.W_MASS;
      lam.tw += g * C.W_GLASS * fw;
      lam.tg += g * C.W_GLASS * (1 - fw);
      gu.local += g * localGain;
    }
    return scaleQuad * d * d + scaleLin * (soft - SOFT);
  }

  function stage(i, s, u, env, back, gu) {
    let j = (cfg.wEnergy * T.electricPower(u, env, veh) * cfg.dt) / 3.6e6;
    if (back) {
      T.electricPowerGrad(u, env, veh, pg);
      const e = (cfg.wEnergy * cfg.dt) / 3.6e6;
      gu.q += e * pg.q;
      gu.local += e * env.occupants * (heating ? veh.seatHeatW : -veh.seatVentW);
    }
    j += comfortTerm(s, env, u, cfg.wComfort * minutes, cfg.wComfortLin * minutes, back, gu);
    if (i >= 3) {
      const a = s.ta < cfg.airMin ? s.ta - cfg.airMin : s.ta > cfg.airMax ? s.ta - cfg.airMax : 0;
      if (a !== 0) {
        j += cfg.wAir * a * a * minutes;
        if (back) lam.ta += 2 * cfg.wAir * a * minutes;
      }
    }
    const fog = cfg.fogLimit - T.fogMargin(s);
    if (fog > 0) {
      j += cfg.wFog * fog * fog * minutes;
      if (back) {
        const g = 2 * cfg.wFog * fog * minutes;
        lam.tw -= g;
        lam.w += g * T.dDewPoint(s.w);
      }
    }
    const over = (s.co2 - cfg.co2Target) / 100;
    if (over > 0) {
      j += cfg.wCo2 * over * over * minutes;
      if (back) lam.co2 += (2 * cfg.wCo2 * over * minutes) / 100;
    }
    return j;
  }

  function evaluate(z, grad) {
    for (let k = 0; k < blocks; k++) decode(z, k, veh, heating, cfg.localMax, us[k]);
    Object.assign(traj[0], s0);
    let j = 0;
    for (let i = 0; i < steps; i++) {
      const u = us[blockOf(i)];
      T.step(traj[i], u, envs[i], cfg.dt, veh, traj[i + 1]);
      j += stage(i, traj[i + 1], u, envs[i], false, null);
    }
    for (let k = 0; k < used; k++) {
      if (k > 0) {
        const dq = (us[k].q - us[k - 1].q) / 1000;
        j += cfg.wSmooth * dq * dq;
      }
      const prev = k > 0 ? us[k - 1].local : prevLocal;
      if (prev !== undefined) j += cfg.wLocalSmooth * (us[k].local - prev) * (us[k].local - prev);
    }
    const last = us[blockOf(steps - 1)];
    if (continues) j += comfortTerm(traj[steps], envs[steps - 1], last, cfg.wTerminal, 0, false, null);
    if (!grad) return j;

    for (const g of gus) g.q = g.recirc = g.local = g.defrost = 0;
    lam.ta = lam.tm = lam.tw = lam.tg = lam.ts = lam.w = lam.co2 = 0;
    if (continues) comfortTerm(traj[steps], envs[steps - 1], last, cfg.wTerminal, 0, true, gus[blockOf(steps - 1)]);
    for (let i = steps - 1; i >= 0; i--) {
      const k = blockOf(i);
      stage(i, traj[i + 1], us[k], envs[i], true, gus[k]);
      T.stepAdjoint(traj[i], traj[i + 1], us[k], envs[i], cfg.dt, veh, lam, gus[k]);
    }
    for (let k = 0; k < used; k++) {
      if (k > 0) {
        const g = (2 * cfg.wSmooth * (us[k].q - us[k - 1].q)) / 1e6;
        gus[k].q += g;
        gus[k - 1].q -= g;
      }
      const prev = k > 0 ? us[k - 1].local : prevLocal;
      if (prev !== undefined) {
        const g = 2 * cfg.wLocalSmooth * (us[k].local - prev);
        gus[k].local += g;
        if (k > 0) gus[k - 1].local -= g;
      }
    }
    for (let k = 0; k < blocks; k++) {
      grad[NV * k] = gus[k].q * (heating ? veh.qHeatMax : -veh.qCoolMax);
      grad[NV * k + 1] = gus[k].recirc * 0.9;
      grad[NV * k + 2] = gus[k].local * (heating ? cfg.localMax : -cfg.localMax);
      grad[NV * k + 3] = gus[k].defrost;
    }
    return j;
  }

  return { n, blocks, evaluate, us };
}

function projectedGradientNorm(z, g, lo, hi) {
  let m = 0;
  for (let i = 0; i < z.length; i++) {
    const p = Math.min(hi[i], Math.max(lo[i], z[i] - g[i])) - z[i];
    if (Math.abs(p) > m) m = Math.abs(p);
  }
  return m;
}

function spg(evaluate, z, lo, hi, maxIter, tol, memory) {
  const n = z.length;
  const g = new Float64Array(n);
  const gNew = new Float64Array(n);
  const d = new Float64Array(n);
  const trial = new Float64Array(n);
  const hist = [];
  let f = evaluate(z, g);
  let evals = 1;
  let pgn = projectedGradientNorm(z, g, lo, hi);
  let alpha = pgn > 0 ? Math.min(1e3, 1 / pgn) : 1;
  let iter = 0;
  for (; iter < maxIter && pgn > tol; iter++) {
    hist.push(f);
    if (hist.length > memory) hist.shift();
    let fRef = hist[0];
    for (const h of hist) if (h > fRef) fRef = h;
    let gtd = 0;
    for (let i = 0; i < n; i++) {
      d[i] = Math.min(hi[i], Math.max(lo[i], z[i] - alpha * g[i])) - z[i];
      gtd += g[i] * d[i];
    }
    let t = 1;
    let fNew = f;
    let ok = false;
    for (let tries = 0; tries < 20; tries++) {
      for (let i = 0; i < n; i++) trial[i] = z[i] + t * d[i];
      fNew = evaluate(trial, gNew);
      evals++;
      if (fNew <= fRef + 1e-4 * t * gtd) {
        ok = true;
        break;
      }
      t *= 0.5;
    }
    if (!ok) break;
    let ss = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      const s = trial[i] - z[i];
      ss += s * s;
      sy += s * (gNew[i] - g[i]);
      z[i] = trial[i];
      g[i] = gNew[i];
    }
    f = fNew;
    alpha = sy > 1e-16 ? Math.min(1e6, Math.max(1e-6, ss / sy)) : 1e6;
    pgn = projectedGradientNorm(z, g, lo, hi);
  }
  return { cost: f, iterations: iter, evaluations: evals, residual: pgn };
}

function pqn(evaluate, z, lo, hi, maxIter, tol, memory) {
  const n = z.length;
  const g = new Float64Array(n);
  const gNew = new Float64Array(n);
  const d = new Float64Array(n);
  const trial = new Float64Array(n);
  const free = new Uint8Array(n);
  const S = [];
  const Y = [];
  const rho = [];
  const a = new Float64Array(memory);
  let f = evaluate(z, g);
  let evals = 1;
  let pgn = projectedGradientNorm(z, g, lo, hi);
  let iter = 0;
  for (; iter < maxIter && pgn > tol; iter++) {
    for (let i = 0; i < n; i++) {
      free[i] = (z[i] <= lo[i] + 1e-12 && g[i] > 0) || (z[i] >= hi[i] - 1e-12 && g[i] < 0) ? 0 : 1;
      d[i] = free[i] ? -g[i] : 0;
    }
    for (let k = S.length - 1; k >= 0; k--) {
      let dot = 0;
      for (let i = 0; i < n; i++) dot += S[k][i] * d[i];
      a[k] = rho[k] * dot;
      for (let i = 0; i < n; i++) d[i] -= a[k] * Y[k][i];
    }
    if (S.length) {
      const k = S.length - 1;
      let yy = 0;
      for (let i = 0; i < n; i++) yy += Y[k][i] * Y[k][i];
      const scale = 1 / (rho[k] * yy);
      for (let i = 0; i < n; i++) d[i] *= scale;
    }
    for (let k = 0; k < S.length; k++) {
      let dot = 0;
      for (let i = 0; i < n; i++) dot += Y[k][i] * d[i];
      const b = rho[k] * dot;
      for (let i = 0; i < n; i++) d[i] += (a[k] - b) * S[k][i];
    }
    let gd = 0;
    for (let i = 0; i < n; i++) {
      if (!free[i]) d[i] = 0;
      gd += g[i] * d[i];
    }
    if (!(gd < 0)) {
      S.length = Y.length = rho.length = 0;
      for (let i = 0; i < n; i++) d[i] = free[i] ? -g[i] : 0;
    }
    let t = S.length ? 1 : Math.min(1, 1 / (pgn + 1e-12));
    let fNew = f;
    let ok = false;
    for (let tries = 0; tries < 30; tries++) {
      let dec = 0;
      for (let i = 0; i < n; i++) {
        trial[i] = Math.min(hi[i], Math.max(lo[i], z[i] + t * d[i]));
        dec += g[i] * (trial[i] - z[i]);
      }
      fNew = evaluate(trial, gNew);
      evals++;
      if (fNew <= f + 1e-4 * dec) {
        ok = true;
        break;
      }
      t *= 0.5;
    }
    if (!ok) {
      if (!S.length) break;
      S.length = Y.length = rho.length = 0;
      continue;
    }
    const s = new Float64Array(n);
    const y = new Float64Array(n);
    let sy = 0;
    for (let i = 0; i < n; i++) {
      s[i] = trial[i] - z[i];
      y[i] = gNew[i] - g[i];
      sy += s[i] * y[i];
      z[i] = trial[i];
      g[i] = gNew[i];
    }
    if (sy > 1e-12) {
      S.push(s);
      Y.push(y);
      rho.push(1 / sy);
      if (S.length > memory) {
        S.shift();
        Y.shift();
        rho.shift();
      }
    }
    f = fNew;
    pgn = projectedGradientNorm(z, g, lo, hi);
  }
  return { cost: f, iterations: iter, evaluations: evals, residual: pgn };
}

function plan(s0, envAt, remainingSteps, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts.config };
  const veh = opts.vehicle || T.VEHICLE;
  const env0 = envAt(0);
  const target = opts.target !== undefined ? opts.target : C.targetFor(env0.tAmb);
  const heating = opts.heating !== undefined ? opts.heating : env0.tAmb < target - 2;
  const steps = Math.max(1, Math.min(cfg.horizon, remainingSteps));
  const continues = remainingSteps > cfg.horizon;
  const prob = createProblem(s0, envAt, steps, target, veh, cfg, heating, continues, opts.prevLocal);
  const n = prob.n;
  const z = new Float64Array(n);
  if (opts.warm && opts.warm.length === n) {
    for (let k = 0; k < prob.blocks; k++) {
      const src = Math.min(k + 1, prob.blocks - 1);
      for (let c = 0; c < NV; c++) z[NV * k + c] = opts.warm[NV * src + c];
    }
  } else {
    for (let k = 0; k < prob.blocks; k++) {
      z[NV * k] = 0.4;
      z[NV * k + 1] = 0.3;
      z[NV * k + 2] = 0.3;
      z[NV * k + 3] = 0.2;
    }
  }
  const lo = new Float64Array(n);
  const hi = new Float64Array(n).fill(1);
  const solver = cfg.solver === 'spg' ? spg : pqn;
  const main = solver(prob.evaluate, z, lo, hi, cfg.iterations, cfg.tolerance, cfg.memory);
  let best = { ...main };
  let evaluations = main.evaluations;
  let iterations = main.iterations;

  const level = z[2] * cfg.localMax;
  if (Math.abs(level - Math.round(level)) > 1e-6) {
    const relaxed = Float64Array.from(z);
    let pick = null;
    for (const cand of [Math.floor(level), Math.ceil(level)]) {
      const zc = Float64Array.from(relaxed);
      zc[2] = cand / cfg.localMax;
      lo[2] = hi[2] = zc[2];
      const r = solver(prob.evaluate, zc, lo, hi, cfg.iterations, cfg.tolerance, cfg.memory);
      evaluations += r.evaluations;
      iterations += r.iterations;
      if (!pick || r.cost < pick.cost) pick = { ...r, z: zc };
    }
    z.set(pick.z);
    best = pick;
  }
  const first = decode(z, 0, veh, heating, cfg.localMax);
  first.local = Math.round(first.local);
  if (Math.abs(first.q) < 150) first.q = 0;
  return { control: first, z, cost: best.cost, residual: best.residual, relaxedCost: main.cost, relaxedResidual: main.residual, iterations, evaluations, target, heating, steps };
}

module.exports = { DEFAULTS, NV, plan, createProblem, spg, pqn, decode, projectedGradientNorm };
