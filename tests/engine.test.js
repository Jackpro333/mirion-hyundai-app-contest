'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/thermal');
const C = require('../src/comfort');
const M = require('../src/mpc');
const S = require('../src/scenario');
const K = require('../src/calibrate');

const still = { tAmb: 10, sun: 0, rh: 0.5, occupants: 0, speed: 0 };
const off = { q: 0, recirc: 0, local: 0, defrost: 0 };

test('외부 조건이 같으면 꺼진 차는 외기 온도로 수렴하고 그대로 머문다', () => {
  let s = T.initialState(30, 0.4);
  for (let i = 0; i < 2000; i++) s = T.step(s, off, still, 60);
  for (const k of ['ta', 'tm', 'tw', 'tg', 'ts']) assert.ok(Math.abs(s[k] - 10) < 1e-3, `${k}=${s[k]}`);
  assert.ok(Math.abs(s.co2 - T.CO2_AMBIENT) < 1e-6);
});

test('정상 상태에서 공급 열량은 외부로 나가는 열량과 같다(에너지 보존)', () => {
  const env = { tAmb: -5, sun: 0, rh: 0.5, occupants: 0, speed: 20 };
  const u = { q: 3000, recirc: 0.5, local: 0, defrost: 0.4 };
  let s = T.initialState(-5, 0.5);
  for (let i = 0; i < 4000; i++) s = T.step(s, u, env, 60);
  const k = T.derive(u, env, T.VEHICLE, {});
  const out = k.kv * (s.ta - env.tAmb) + k.kwo * (s.tw - env.tAmb) + k.kgo * (s.tg - env.tAmb) + k.kso * (s.ts - env.tAmb);
  assert.ok(Math.abs(out - 3000) < 1, `유출 ${out.toFixed(2)} W`);
});

test('적분 간격을 줄이면 해가 1차로 수렴한다(후진 오일러)', () => {
  const env = { tAmb: 0, sun: 300, rh: 0.5, occupants: 2, speed: 15 };
  const u = { q: 2500, recirc: 0.3, local: 1, defrost: 0.2 };
  const run = (dt) => {
    let s = T.initialState(0, 0.5);
    for (let t = 0; t < 600; t += dt) s = T.step(s, u, env, dt);
    return s.ta;
  };
  const ref = run(0.25);
  const ratio = Math.abs(run(20) - ref) / Math.abs(run(10) - ref);
  assert.ok(ratio > 1.7 && ratio < 2.3, `오차비 ${ratio.toFixed(2)}`);
});

test('이슬점과 습도비는 서로 역함수이고 도함수는 수치 미분과 맞는다', () => {
  for (const t of [-10, 0, 12, 25]) assert.ok(Math.abs(T.dewPoint(T.humidityRatio(t, 1)) - t) < 1e-6);
  for (const w of [0.001, 0.004, 0.012]) {
    const fd = (T.dewPoint(w + 1e-8) - T.dewPoint(w - 1e-8)) / 2e-8;
    assert.ok(Math.abs(fd - T.dDewPoint(w)) / fd < 1e-5);
  }
  for (const t of [-5, 10, 30]) {
    const fd = (T.humidityRatio(t + 1e-5, 1) - T.humidityRatio(t - 1e-5, 1)) / 2e-5;
    assert.ok(Math.abs(fd - T.dSatHumidityRatio(t)) / fd < 1e-6);
  }
});

test('환기가 없으면 CO2 는 사람 수에 비례해 오르고, 외기가 들어오면 평형값에 머문다', () => {
  const env = { tAmb: 20, sun: 0, rh: 0.4, occupants: 2, speed: 0 };
  const veh = { ...T.VEHICLE, leakBase: 0 };
  let s = T.initialState(20, 0.4);
  for (let i = 0; i < 60; i++) s = T.step(s, off, env, 1, veh);
  const expected = T.CO2_AMBIENT + (2 * 5e-6 * 1e6 * 60) / veh.cabinVolume;
  assert.ok(Math.abs(s.co2 - expected) < 1, `${s.co2} vs ${expected}`);
  let v = T.initialState(20, 0.4);
  const u = { q: 500, recirc: 0, local: 0, defrost: 0 };
  for (let i = 0; i < 3000; i++) v = T.step(v, u, env, 10);
  const fresh = T.derive(u, env, T.VEHICLE, {}).fresh;
  const eq = T.CO2_AMBIENT + (2 * 5e-6 * 1e6) / (fresh / T.RHO_AIR);
  assert.ok(Math.abs(v.co2 - eq) < 1, `${v.co2} vs ${eq}`);
});

test('겨울에 내기 순환을 높이면 김서림 여유가 줄고, 앞유리로 바람을 보내면 다시 늘어난다', () => {
  const env = { tAmb: -8, sun: 0, rh: 0.8, occupants: 4, speed: 27 };
  const margin = (recirc, defrost) => {
    let s = T.initialState(-8, 0.8);
    for (let i = 0; i < 240; i++) s = T.step(s, { q: 4000, recirc, local: 0, defrost }, env, 10);
    return T.fogMargin(s);
  };
  assert.ok(margin(0, 0) > margin(0.5, 0) && margin(0.5, 0) > margin(0.9, 0));
  assert.ok(margin(0.9, 0) < 0, '4명이 90% 내기 순환이면 김이 서린다');
  assert.ok(margin(0.5, 0.6) > margin(0.5, 0) + 2);
});

test('땡볕에 세워 둔 차는 외기보다 훨씬 뜨거워진다', () => {
  const s = S.soak(S.PROFILES.summerSoak, T.VEHICLE);
  assert.ok(s.ta > 45 && s.ta < 70, `실내 공기 ${s.ta.toFixed(1)}°C`);
  assert.ok(s.tm > s.ta);
});

function problemFor(key, s0, steps, prevLocal) {
  const p = S.PROFILES[key];
  const target = C.targetFor(p.tAmb);
  return M.createProblem(s0, (i) => S.envAt(p, 600 + i * 60), steps, target, T.VEHICLE, { ...M.DEFAULTS }, p.tAmb < target - 2, steps >= 20, prevLocal);
}

test('수반법으로 구한 기울기가 중심차분과 1e-5 이내로 일치한다', () => {
  const cases = [
    ['winterCommute', T.initialState(-5, 0.7), 20, 1],
    ['winterFamily', { ...T.initialState(18, 0.6), tw: 1, tg: 3, ts: -2, w: 0.006, co2: 1150 }, 20, undefined],
    ['winterFamily', T.initialState(-8, 0.8), 7, 2],
    ['summerSoak', S.soak(S.PROFILES.summerSoak, T.VEHICLE), 20, -1],
  ];
  let seed = 3;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (const [key, s0, steps, prev] of cases) {
    const prob = problemFor(key, s0, steps, prev);
    const z = Float64Array.from({ length: prob.n }, () => 0.08 + 0.84 * rnd());
    const g = new Float64Array(prob.n);
    prob.evaluate(z, g);
    for (let i = 0; i < prob.n; i++) {
      const keep = z[i];
      z[i] = keep + 1e-6;
      const up = prob.evaluate(z, null);
      z[i] = keep - 1e-6;
      const down = prob.evaluate(z, null);
      z[i] = keep;
      const fd = (up - down) / 2e-6;
      assert.ok(Math.abs(fd - g[i]) <= 1e-5 * Math.max(1e-4, Math.abs(fd), Math.abs(g[i])), `${key} 변수 ${i}: ${fd} vs ${g[i]}`);
    }
  }
});

test('계획은 수렴 판정을 통과하고, 서로 다른 두 풀이법이 같은 최적값에 도달한다', () => {
  const p = S.PROFILES.winterCommute;
  const s0 = T.initialState(p.tAmb, p.rh);
  const envAt = (i) => S.envAt(p, i * 60);
  const a = M.plan(s0, envAt, 35);
  const b = M.plan(s0, envAt, 35, { config: { solver: 'spg', iterations: 20000 } });
  assert.ok(a.relaxedResidual <= 1e-5, `잔차 ${a.relaxedResidual}`);
  assert.ok(Math.abs(a.relaxedCost - b.relaxedCost) / b.relaxedCost < 1e-6);
  for (const v of a.z) assert.ok(v >= 0 && v <= 1);
  assert.ok(a.control.q > 0 && a.control.q <= T.VEHICLE.qHeatMax);
  assert.ok(Number.isInteger(a.control.local));
});

test('무작위 출발점 여러 곳에서 풀어도 더 낮은 비용이 나오지 않는다', () => {
  const p = S.PROFILES.winterFamily;
  const s0 = { ...T.initialState(20, 0.6), tm: 18, tw: 0, tg: 2, ts: -6, w: 0.004, co2: 900 };
  const target = C.targetFor(p.tAmb);
  const prob = M.createProblem(s0, (i) => S.envAt(p, 1200 + i * 60), 20, target, T.VEHICLE, { ...M.DEFAULTS }, true, true, 1);
  const lo = new Float64Array(prob.n);
  const hi = new Float64Array(prob.n).fill(1);
  const solve = (z) => M.pqn(prob.evaluate, z, lo, hi, 3000, 1e-6, 8).cost;
  const ref = solve(Float64Array.from({ length: prob.n }, () => 0.3));
  let seed = 9;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let k = 0; k < 8; k++) {
    const c = solve(Float64Array.from({ length: prob.n }, rnd));
    assert.ok(c > ref - 1e-4 * ref, `출발점 ${k}: ${c} < ${ref}`);
  }
});

test('도착이 가까우면 계획 구간이 도착 시점에서 끝난다', () => {
  const p = S.PROFILES.winterCommute;
  assert.equal(M.plan(T.initialState(15, 0.5), (i) => S.envAt(p, i * 60), 3).steps, 3);
});

test('겨울 나홀로 출근: 미리온이 기준보다 전력을 덜 쓰고 불쾌 지표도 낮다', () => {
  for (const recirc of [0.2, 0.7]) {
    const r = S.compare('winterCommute', { baseline: { recirc } });
    assert.ok(r.ours.hvacKWh < r.base.hvacKWh * 0.9);
    assert.ok(r.ours.hvacKWh < r.baseSeat.hvacKWh * 0.9);
    assert.ok(r.ours.meanDiscomfort <= r.baseSeat.meanDiscomfort);
    assert.equal(r.ours.fogMinutes, 0);
    assert.ok(r.ours.co2Max < 1500);
  }
});

test('여름 땡볕 출발: 실내가 외기보다 뜨거운 첫 구간에는 외기를 들이고 이후 내기로 바꾼다', () => {
  const r = S.compare('summerSoak');
  assert.ok(r.ours.series[0].recirc < 0.2, `첫 구간 내기 순환 ${r.ours.series[0].recirc}`);
  assert.ok(r.ours.series[5].recirc > 0.5);
  assert.ok(r.ours.meanDiscomfort <= r.base.meanDiscomfort);
});

test('겨울 4인 장거리: 앞유리 풍량을 써서 김서림 없이 CO2 한계 안에서 달린다', () => {
  const r = S.compare('winterFamily');
  assert.equal(r.ours.fogMinutes, 0);
  assert.ok(r.ours.co2Max < 1500);
  const late = r.ours.series.slice(15);
  assert.ok(Math.min(...late.map((p) => p.fog)) > 1.5);
  assert.ok(Math.max(...late.map((p) => p.defrost)) > 0.2);
  assert.ok(Math.max(...late.map((p) => Math.abs(p.teq - r.ours.target))) < 1.2);
});

test('모델이 실제 차와 20% 어긋나도 김서림과 CO2 한계를 지킨다', () => {
  for (const scale of [0.8, 1.2]) {
    const real = { ...T.VEHICLE, uaScale: scale, massScale: scale };
    const r = S.simulate(S.PROFILES.winterFamily, S.mirionController({ model: T.VEHICLE }), { vehicle: real });
    assert.equal(r.fogMinutes, 0);
    assert.ok(r.co2Max < 1500);
  }
});

test('보정: 잡음 섞인 실내 온도 기록에서 차의 열 특성 계수를 되찾는다', () => {
  const truth = { ...T.VEHICLE, uaScale: 1.3, massScale: 0.75, solarScale: 1.2 };
  const log = [];
  let s = T.initialState(5, 0.5);
  const s0 = { ...s };
  let seed = 7;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648 - 0.5) * 0.2;
  };
  for (let i = 0; i < 180; i++) {
    const env = { tAmb: 5, sun: i < 60 ? 0 : 600, rh: 0.5, occupants: 1, speed: i % 40 < 20 ? 8 : 25 };
    const u = { q: i < 30 ? 4500 : i < 90 ? 1500 : i < 130 ? 0 : 2500, recirc: 0.3, local: 0, defrost: 0.1 };
    s = T.step(s, u, env, 30, truth);
    log.push({ u, env, dt: 30, ta: s.ta + noise() });
  }
  const fit = K.fit(log, s0);
  assert.ok(Math.abs(fit.uaScale - 1.3) < 0.07, `uaScale ${fit.uaScale}`);
  assert.ok(Math.abs(fit.massScale - 0.75) < 0.04, `massScale ${fit.massScale}`);
  assert.ok(Math.abs(fit.solarScale - 1.2) < 0.06, `solarScale ${fit.solarScale}`);
  assert.ok(fit.rmse < 0.1);
});

test('쾌적 지표: 열선은 등가온도를 올리고 통풍은 내린다', () => {
  const s = T.initialState(20, 0.5);
  const env = { sun: 0 };
  assert.ok(C.equivalentTemp(s, env, 2, T.VEHICLE) > C.equivalentTemp(s, env, 0, T.VEHICLE));
  assert.ok(C.equivalentTemp(s, env, -2, T.VEHICLE) < C.equivalentTemp(s, env, 0, T.VEHICLE));
  assert.equal(C.discomfort(22.3, 22), 0);
});
