'use strict';
const fs = require('fs');
const path = require('path');
const T = require('../src/thermal');
const M = require('../src/mpc');
const S = require('../src/scenario');
const V = require('../src/verify');
const B = require('../src/blackice');

const round = (x, n = 2) => (x === null || x === undefined ? null : Number(x.toFixed(n)));
const settled = (r) => Math.min(...r.series.slice(10).map((p) => p.fog));
const pick = (r) => ({ hvacKWh: round(r.hvacKWh, 3), meanDiscomfortK: round(r.meanDiscomfort), comfortAtMin: round(r.comfortAtMin, 1), fogSettledMinK: round(settled(r), 1), fogMinutes: round(r.fogMinutes, 1), co2MaxPpm: round(r.co2Max, 0), rangeKm: round(r.rangeKm, 1), gateEvents: r.gateLog.length });
const quantile = (list, q) => {
  const s = list.slice().sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  return s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i - Math.floor(i));
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const out = { generatedBy: 'tools/results.js', batteryKWh: S.BATTERY_KWH, scenarios: {}, uncertainty: {} };

for (const key of Object.keys(S.PROFILES)) {
  const rows = [];
  for (const recirc of key === 'summerSoak' ? [0.6] : [0.2, 0.5, 0.7]) {
    const r = S.compare(key, { baseline: { recirc } });
    const diff = (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, round(v, 2)]));
    rows.push({ baselineRecirc: recirc, base: pick(r.base), baseSeat: pick(r.baseSeat), ours: pick(r.ours), vsBase: diff(r.vsBase), vsBaseSeat: diff(r.vsBaseSeat), distanceKm: round(r.ours.distanceKm, 1) });
  }
  out.scenarios[key] = { name: S.PROFILES[key].name, note: S.PROFILES[key].note, rows };
}

const SAMPLES = 60;
for (const key of Object.keys(S.PROFILES)) {
  const rnd = mulberry32(77);
  const profile = S.PROFILES[key];
  const saved = [];
  const gain = [];
  const fog = [];
  const co2 = [];
  const disc = [];
  for (let i = 0; i < SAMPLES; i++) {
    const vehicle = { ...T.VEHICLE, uaScale: 0.8 + 0.4 * rnd(), massScale: 0.8 + 0.4 * rnd(), solarScale: 0.8 + 0.4 * rnd() };
    const baseline = { recirc: 0.2 + 0.5 * rnd(), defrost: 0.3 * rnd(), seat: rnd() < 0.5 && profile.tAmb < 15 ? 2 : 0 };
    const base = S.simulate(profile, S.baselineController(baseline), { vehicle });
    const ours = S.simulate(profile, S.mirionController({ model: T.VEHICLE }), { vehicle });
    saved.push((100 * (base.hvacKWh - ours.hvacKWh)) / base.hvacKWh);
    gain.push(ours.rangeKm - base.rangeKm);
    fog.push(settled(ours));
    co2.push(ours.co2Max);
    disc.push(ours.meanDiscomfort - base.meanDiscomfort);
  }
  out.uncertainty[key] = {
    samples: SAMPLES,
    savedPct: { p10: round(quantile(saved, 0.1), 1), p50: round(quantile(saved, 0.5), 1), p90: round(quantile(saved, 0.9), 1) },
    rangeGainKm: { p10: round(quantile(gain, 0.1), 1), p50: round(quantile(gain, 0.5), 1), p90: round(quantile(gain, 0.9), 1) },
    shareSaving: round(saved.filter((x) => x > 0).length / SAMPLES, 2),
    fogSettledMinK: { worst: round(Math.min(...fog), 1), p10: round(quantile(fog, 0.1), 1) },
    co2MaxPpm: { worst: round(Math.max(...co2), 0) },
    shareComfortNotWorse: round(disc.filter((x) => x <= 0.05).length / SAMPLES, 2),
  };
}

{
  const p = S.PROFILES.winterFamily;
  const cases = [T.initialState(p.tAmb, p.rh), { ...T.initialState(21, 0.6), tm: 20, tw: 0, tg: 2, ts: -6, w: 0.004, co2: 1000 }, T.initialState(-5, 0.7), S.soak(S.PROFILES.summerSoak, T.VEHICLE)];
  const keys = ['winterFamily', 'winterFamily', 'winterCommute', 'summerSoak'];
  let ms = 0;
  let iters = 0;
  let worstResidual = 0;
  let worstGap = 0;
  cases.forEach((s0, i) => {
    const prof = S.PROFILES[keys[i]];
    const envAt = (j) => S.envAt(prof, 600 + j * 60);
    const t0 = process.hrtime.bigint();
    let r;
    for (let k = 0; k < 20; k++) r = M.plan(s0, envAt, 90);
    ms += Number(process.hrtime.bigint() - t0) / 1e6 / 20;
    iters += r.iterations;
    worstResidual = Math.max(worstResidual, r.relaxedResidual);
    const ref = M.plan(s0, envAt, 90, { config: { solver: 'spg', iterations: 20000 } });
    worstGap = Math.max(worstGap, Math.abs(r.relaxedCost - ref.relaxedCost) / ref.relaxedCost);
  });
  out.optimizer = { cases: cases.length, meanPlanMs: round(ms / cases.length, 1), meanIterations: round(iters / cases.length, 0), worstResidual: Number(worstResidual.toExponential(1)), worstRelativeGapToSecondSolver: Number(worstGap.toExponential(1)) };
}

const t0 = Date.now();
const v = V.run('full');
out.gate = { checked: v.checked, states: v.states, commands: v.commands, invariants: v.invariants, counts: v.counts, violations: v.violations, seconds: round((Date.now() - t0) / 1000, 1) };

const iceCases = {
  clearDawnHumid: { outsideTemp: 1.5, hour: 5.5, sky: 'clear', humidity: 0.9, wind: 1 },
  unknownDawn: { outsideTemp: 1.5, hour: 5.5 },
  overcastDawnHumid: { outsideTemp: 1.5, hour: 5.5, sky: 'overcast', humidity: 0.9, wind: 1 },
  clearAfternoon: { outsideTemp: 3, hour: 14, sky: 'clear' },
  rainBelowZero: { outsideTemp: -2, hour: 23, raining: true },
};
out.blackice = {};
for (const [k, obs] of Object.entries(iceCases)) {
  const r = B.assess(obs);
  out.blackice[k] = { obs, road: round(r.road.probability), bridge: round(r.bridge.probability), level: r.level, headline: r.headline, bridgeByCloud: Object.fromEntries(Object.entries(r.bridge.byCloud).map(([c, x]) => [c, round(x)])) };
}

fs.writeFileSync(path.join(__dirname, '..', 'docs', 'results.json'), JSON.stringify(out, null, 2));

for (const [key, sc] of Object.entries(out.scenarios)) {
  console.log(`\n${sc.name} (${sc.note})`);
  for (const r of sc.rows)
    console.log(`  기준 내기순환 ${r.baselineRecirc * 100}%: 기준 ${r.base.hvacKWh} / 기준+열선 ${r.baseSeat.hvacKWh} / 미리온 ${r.ours.hvacKWh} kWh | 절감 ${r.vsBase.hvacSavedPct}% (${r.vsBaseSeat.hvacSavedPct}%) | 주행거리 ${r.vsBase.rangeGainKm} km (${r.vsBaseSeat.rangeGainKm}) | 쾌적 도달 ${r.base.comfortAtMin}/${r.baseSeat.comfortAtMin}/${r.ours.comfortAtMin} 분 | 불쾌 ${r.base.meanDiscomfortK}/${r.baseSeat.meanDiscomfortK}/${r.ours.meanDiscomfortK} K | 김서림 ${r.base.fogSettledMinK}/${r.ours.fogSettledMinK} K | CO2 ${r.base.co2MaxPpm}/${r.ours.co2MaxPpm} | 게이트 ${r.base.gateEvents}/${r.ours.gateEvents}`);
  console.log('  불확실성', JSON.stringify(out.uncertainty[key]));
}
console.log('\n최적화', JSON.stringify(out.optimizer));
console.log('게이트', JSON.stringify(out.gate));
console.log('결빙', JSON.stringify(Object.fromEntries(Object.entries(out.blackice).map(([k, x]) => [k, [x.road, x.bridge, x.level]]))));
