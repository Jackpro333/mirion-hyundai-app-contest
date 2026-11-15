'use strict';

const T = require('./thermal');
const C = require('./comfort');
const M = require('./mpc');
const G = require('./gate');

const BATTERY_KWH = 77;
const PLANT_DT = 10;
const COMFORT_TOL = 0.1;

const PROFILES = {
  winterCommute: {
    name: '겨울 출근',
    note: '영하 5도, 밤새 실외 주차, 혼자 35분',
    minutes: 35,
    tAmb: -5,
    sun: 80,
    rh: 0.7,
    occupants: 1,
    soakMinutes: 0,
    speed: [
      [0, 30],
      [10, 80],
      [30, 25],
    ],
  },
  summerSoak: {
    name: '여름 땡볕 주차 후',
    note: '33도, 땡볕 90분 주차 뒤 2명이 30분',
    minutes: 30,
    tAmb: 33,
    sun: 850,
    rh: 0.6,
    occupants: 2,
    soakMinutes: 90,
    speed: [
      [0, 30],
      [8, 70],
      [26, 25],
    ],
  },
  winterFamily: {
    name: '겨울 가족 장거리',
    note: '영하 8도 야간, 4명이 고속도로 90분',
    minutes: 90,
    tAmb: -8,
    sun: 0,
    rh: 0.8,
    occupants: 4,
    soakMinutes: 0,
    speed: [
      [0, 40],
      [8, 100],
      [84, 40],
    ],
  },
};

function speedAt(profile, tSec) {
  const m = tSec / 60;
  let kmh = profile.speed[0][1];
  for (const [from, v] of profile.speed) if (m >= from) kmh = v;
  return kmh;
}

function envAt(profile, tSec) {
  return { tAmb: profile.tAmb, sun: profile.sun, rh: profile.rh, occupants: profile.occupants, speed: speedAt(profile, tSec) / 3.6 };
}

function drivePower(kmh) {
  const v = kmh / 3.6;
  const road = 0.5 * 1.25 * 0.62 * v * v * v + 2000 * 9.81 * 0.009 * v;
  const stopGo = kmh < 50 ? 1.3 : 1.05;
  return (road * stopGo) / 0.88 + 350;
}

function soak(profile, veh) {
  let s = T.initialState(profile.tAmb, profile.rh);
  const env = { tAmb: profile.tAmb, sun: profile.sun, rh: profile.rh, occupants: 0, speed: 0 };
  const off = { q: 0, recirc: 0, local: 0, defrost: 0 };
  for (let t = 0; t < profile.soakMinutes * 60; t += 30) s = T.step(s, off, env, 30, veh);
  return s;
}

function vehicleView(s, kmh, profile) {
  const seats = ['driver', 'passenger', 'rearLeft', 'rearRight'];
  const occupied = {};
  const child = {};
  seats.forEach((seat, i) => {
    occupied[seat] = i < profile.occupants;
    child[seat] = false;
  });
  return { speed: kmh, gear: 'D', fogMargin: T.fogMargin(s), co2: s.co2, rain: false, occupied, child };
}

function baselineController(opts = {}) {
  let integral = 0;
  const seat = opts.seat || 0;
  const heatRecirc = opts.recirc !== undefined ? opts.recirc : 0.2;
  const heatDefrost = opts.defrost !== undefined ? opts.defrost : 0.15;
  return {
    name: seat ? `자동 공조 + 열선 ${seat}단` : '자동 공조',
    interval: 10,
    update(tSec, s, env, remaining, target, veh) {
      const heating = env.tAmb < target - 2;
      const local = heating ? seat : 0;
      const err = target - C.equivalentTemp(s, env, local, veh);
      let q = 1500 * err + integral;
      const lo = heating ? 0 : -veh.qCoolMax;
      const hi = heating ? veh.qHeatMax : 0;
      if (q > lo && q < hi) integral += 5 * err * 10;
      q = T.clamp(q, lo, hi);
      return { q, recirc: heating ? heatRecirc : 0.6, local, defrost: heating ? heatDefrost : 0 };
    },
  };
}

function mirionController(opts = {}) {
  let warm = null;
  return {
    name: '미리온',
    interval: 60,
    update(tSec, s, env, remaining, target, veh, profile) {
      const cfg = { ...M.DEFAULTS, ...opts.config };
      const res = M.plan(s, (i) => envAt(profile, tSec + i * cfg.dt), Math.ceil(remaining / cfg.dt), { target, vehicle: opts.model || veh, warm, config: opts.config, prevLocal: this.last ? this.last.control.local : undefined });
      warm = res.z;
      this.last = res;
      return res.control;
    },
  };
}

function simulate(profile, controller, opts = {}) {
  const veh = opts.vehicle || T.VEHICLE;
  const target = opts.target !== undefined ? opts.target : C.targetFor(profile.tAmb);
  let s = soak(profile, veh);
  const total = profile.minutes * 60;
  const series = [];
  const gateLog = [];
  let u = { q: 0, recirc: 0, local: 0, defrost: 0 };
  let eHvac = 0;
  let eDrive = 0;
  let dist = 0;
  let discSum = 0;
  let comfortAt = null;
  let fogMin = Infinity;
  let fogSeconds = 0;
  let co2Max = 0;
  for (let t = 0; t < total; t += PLANT_DT) {
    const env = envAt(profile, t);
    const kmh = env.speed * 3.6;
    if (t % (controller.interval || 60) === 0) {
      const want = controller.update(t, s, env, total - t, target, veh, profile);
      const view = vehicleView(s, kmh, profile);
      const r = G.decide({ type: 'hvac.recirc', value: want.recirc }, view, 'mpc');
      const p = G.decide({ type: 'hvac.power', value: want.q }, view, 'mpc');
      const d = G.decide({ type: 'hvac.defrostShare', value: want.defrost || 0 }, view, 'mpc');
      u = { q: p.command ? p.command.value : 0, recirc: r.command ? r.command.value : 0, local: want.local, defrost: d.command ? d.command.value : 1 };
      if (r.verdict !== 'allow' && t % 60 === 0) gateLog.push({ minute: t / 60, verdict: r.verdict, reason: r.reason, asked: want.recirc, applied: u.recirc });
    }
    s = T.step(s, u, env, PLANT_DT, veh);
    const pHvac = T.electricPower(u, env, veh);
    eHvac += (pHvac * PLANT_DT) / 3.6e6;
    eDrive += (drivePower(kmh) * PLANT_DT) / 3.6e6;
    dist += (kmh * PLANT_DT) / 3600;
    const teq = C.equivalentTemp(s, env, u.local, veh);
    const d = C.discomfort(teq, target);
    discSum += d * PLANT_DT;
    if (d <= COMFORT_TOL && comfortAt === null) comfortAt = (t + PLANT_DT) / 60;
    const fog = T.fogMargin(s);
    if (fog < fogMin) fogMin = fog;
    if (fog < 0) fogSeconds += PLANT_DT;
    if (s.co2 > co2Max) co2Max = s.co2;
    if (t % 60 === 0) series.push({ minute: t / 60, ta: s.ta, tm: s.tm, tw: s.tw, tg: s.tg, teq, power: pHvac, q: u.q, recirc: u.recirc, local: u.local, defrost: u.defrost, fog, co2: s.co2, kmh });
  }
  const perKm = (eDrive + eHvac) / dist;
  return {
    controller: controller.name,
    target,
    series,
    gateLog,
    hvacKWh: eHvac,
    driveKWh: eDrive,
    distanceKm: dist,
    whPerKm: perKm * 1000,
    rangeKm: BATTERY_KWH / perKm,
    meanDiscomfort: discSum / total,
    comfortAtMin: comfortAt,
    fogMin,
    fogMinutes: fogSeconds / 60,
    co2Max,
  };
}

function compare(profileKey, opts = {}) {
  const profile = typeof profileKey === 'string' ? PROFILES[profileKey] : profileKey;
  const base = simulate(profile, baselineController(opts.baseline), opts);
  const baseSeat = simulate(profile, baselineController({ ...opts.baseline, seat: profile.tAmb < 15 ? 2 : 0 }), opts);
  const ours = simulate(profile, mirionController(opts), opts);
  const saving = (a) => ({
    hvacSavedKWh: a.hvacKWh - ours.hvacKWh,
    hvacSavedPct: (100 * (a.hvacKWh - ours.hvacKWh)) / a.hvacKWh,
    rangeGainKm: ours.rangeKm - a.rangeKm,
    rangeGainPct: (100 * (ours.rangeKm - a.rangeKm)) / a.rangeKm,
  });
  return { profile, base, baseSeat, ours, vsBase: saving(base), vsBaseSeat: saving(baseSeat) };
}

module.exports = { PROFILES, BATTERY_KWH, envAt, speedAt, drivePower, soak, baselineController, mirionController, simulate, compare, vehicleView };
