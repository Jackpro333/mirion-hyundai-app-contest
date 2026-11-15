'use strict';

const T = require('./thermal');

const KEYS = ['uaScale', 'massScale', 'solarScale'];

function residuals(params, log, s0, base) {
  const veh = { ...base, uaScale: params[0], massScale: params[1], solarScale: params[2] };
  let s = { ...s0 };
  const r = new Float64Array(log.length);
  for (let i = 0; i < log.length; i++) {
    s = T.step(s, log[i].u, log[i].env, log[i].dt, veh);
    r[i] = s.ta - log[i].ta;
  }
  return r;
}

function sumSq(r) {
  let s = 0;
  for (let i = 0; i < r.length; i++) s += r[i] * r[i];
  return s;
}

function solve3(a, b) {
  const m = [a[0].slice(), a[1].slice(), a[2].slice()];
  const x = b.slice();
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    [x[c], x[p]] = [x[p], x[c]];
    for (let r = c + 1; r < 3; r++) {
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 3; k++) m[r][k] -= f * m[c][k];
      x[r] -= f * x[c];
    }
  }
  for (let r = 2; r >= 0; r--) {
    for (let k = r + 1; k < 3; k++) x[r] -= m[r][k] * x[k];
    x[r] /= m[r][r];
  }
  return x;
}

function fit(log, s0, base = T.VEHICLE, maxIter = 30) {
  let p = [1, 1, 1];
  let r = residuals(p, log, s0, base);
  let f = sumSq(r);
  let lambda = 1e-2;
  let iter = 0;
  for (; iter < maxIter; iter++) {
    const J = [];
    for (let k = 0; k < 3; k++) {
      const q = p.slice();
      const h = 1e-4 * Math.max(1, Math.abs(q[k]));
      q[k] += h;
      const rk = residuals(q, log, s0, base);
      const col = new Float64Array(r.length);
      for (let i = 0; i < r.length; i++) col[i] = (rk[i] - r[i]) / h;
      J.push(col);
    }
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const g = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) for (let i = 0; i < r.length; i++) A[a][b] += J[a][i] * J[b][i];
      for (let i = 0; i < r.length; i++) g[a] -= J[a][i] * r[i];
    }
    let accepted = false;
    for (let tries = 0; tries < 8; tries++) {
      const damped = A.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-12 : v)));
      const d = solve3(damped, g);
      const q = p.map((v, k) => Math.min(3, Math.max(0.3, v + d[k])));
      const rq = residuals(q, log, s0, base);
      const fq = sumSq(rq);
      if (fq < f) {
        const gain = f - fq;
        p = q;
        r = rq;
        f = fq;
        lambda = Math.max(lambda / 3, 1e-7);
        accepted = true;
        if (gain < 1e-10) iter = maxIter;
        break;
      }
      lambda *= 4;
    }
    if (!accepted) break;
  }
  const out = { rmse: Math.sqrt(f / log.length), iterations: iter };
  KEYS.forEach((k, i) => (out[k] = p[i]));
  return out;
}

module.exports = { KEYS, fit, residuals };
