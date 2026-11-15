'use strict';

const CP_AIR = 1006;
const RHO_AIR = 1.2;
const P_ATM = 101325;

const VEHICLE = Object.freeze({
  cabinVolume: 3.4,
  Ca: 9e3,
  Cm: 90e3,
  Cw: 14e3,
  Cg: 24e3,
  Cs: 110e3,
  windArea: 1.3,
  glassArea: 2.7,
  shellArea: 10.0,
  hInGlass: 7.5,
  shellU: 1.6,
  massBase: 60,
  massBlower: 90,
  solarMass: 0.75,
  solarWind: 0.1,
  solarGlass: 0.2,
  solarShell: 1.5,
  leakBase: 0.002,
  leakPerMs: 0.00025,
  flowMin: 0.03,
  flowSpan: 0.07,
  flowRamp: 300,
  qHeatMax: 5500,
  qCoolMax: 6000,
  seatHeatW: 22,
  seatVentW: 8,
  defrostEta: 0.35,
  defrostConv: 1.5,
  uaScale: 1,
  massScale: 1,
  solarScale: 1,
});

const OCC_SENSIBLE = 75;
const OCC_VAPOR = 55 / 3.6e6;
const OCC_CO2 = 5.0e-6;
const CO2_AMBIENT = 420;
const EVAP_TEMP = 5;
const DEHUMID_START = 200;
const DEHUMID_SPAN = 400;

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function satPressure(t) {
  return 610.94 * Math.exp((17.625 * t) / (t + 243.04));
}

function humidityRatio(t, rh) {
  const pv = rh * satPressure(t);
  return (0.622 * pv) / (P_ATM - pv);
}

function dSatHumidityRatio(t) {
  const pv = satPressure(t);
  const dpv = (pv * 17.625 * 243.04) / ((t + 243.04) * (t + 243.04));
  return (0.622 * P_ATM * dpv) / ((P_ATM - pv) * (P_ATM - pv));
}

function dewPoint(w) {
  const pv = (w * P_ATM) / (0.622 + w);
  const a = Math.log(Math.max(pv, 1) / 610.94);
  return (243.04 * a) / (17.625 - a);
}

function dDewPoint(w) {
  const pv = (w * P_ATM) / (0.622 + w);
  if (pv <= 1) return 0;
  const a = Math.log(pv / 610.94);
  const dpv = (P_ATM * 0.622) / ((0.622 + w) * (0.622 + w));
  return ((243.04 * 17.625) / ((17.625 - a) * (17.625 - a))) * (dpv / pv);
}

function hExt(v) {
  return 9 + 3.5 * Math.pow(Math.max(v, 0), 0.8);
}

function copHeat(tAmb) {
  return clamp(1.0 + 0.085 * (tAmb + 20), 1.0, 3.6);
}

function copCool(tAmb) {
  return clamp(3.4 - 0.07 * (tAmb - 25), 1.5, 3.6);
}

function blowerOf(q, veh) {
  return Math.min(1, Math.abs(q) / (0.8 * veh.qHeatMax));
}

function derive(u, env, veh, k) {
  const q = clamp(u.q, -veh.qCoolMax, veh.qHeatMax);
  const aq = Math.abs(q);
  const sign = q >= 0 ? 1 : -1;
  const bFull = 0.8 * veh.qHeatMax;
  k.q = q;
  k.r = clamp(u.recirc, 0, 0.9);
  k.d = clamp(u.defrost || 0, 0, 1);
  k.l = u.local;
  k.pos = q > 0 ? 1 : 0;
  k.b = aq < bFull ? aq / bFull : 1;
  k.db = aq < bFull ? sign / bFull : 0;
  k.g = aq < veh.flowRamp ? aq / veh.flowRamp : 1;
  k.dg = aq < veh.flowRamp ? sign / veh.flowRamp : 0;
  k.flow = k.g * (veh.flowMin + veh.flowSpan * k.b);
  k.dflow = k.dg * (veh.flowMin + veh.flowSpan * k.b) + k.g * veh.flowSpan * k.db;
  k.fresh = k.flow * (1 - k.r) + veh.leakBase + veh.leakPerMs * env.speed;
  const he = hExt(env.speed);
  const hin = veh.uaScale * veh.hInGlass;
  k.kam = veh.massBase + veh.massBlower * k.b;
  k.kaw = hin * veh.windArea * (1 + 0.6 * k.b + veh.defrostConv * k.d * k.b);
  k.kag = hin * veh.glassArea * (1 + 0.6 * k.b);
  k.kas = veh.uaScale * veh.shellU * veh.shellArea;
  k.kwo = he * veh.windArea;
  k.kgo = he * veh.glassArea;
  k.kso = he * veh.shellArea;
  k.kv = k.fresh * CP_AIR;
  const h = (-q - DEHUMID_START) / DEHUMID_SPAN;
  k.hd = h <= 0 ? 0 : h >= 1 ? 1 : h;
  k.dhd = h > 0 && h < 1 ? -1 / DEHUMID_SPAN : 0;
  return k;
}

function electricPower(u, env, veh) {
  const q = clamp(u.q, -veh.qCoolMax, veh.qHeatMax);
  const aq = Math.abs(q);
  const b = blowerOf(q, veh);
  const g = aq < veh.flowRamp ? aq / veh.flowRamp : 1;
  const thermal = q >= 0 ? q / copHeat(env.tAmb) : -q / copCool(env.tAmb);
  const seats = env.occupants * (u.local >= 0 ? veh.seatHeatW * u.local : -veh.seatVentW * u.local);
  return thermal + g * (20 + 180 * b * b * b) + seats;
}

function electricPowerGrad(u, env, veh, out) {
  const q = clamp(u.q, -veh.qCoolMax, veh.qHeatMax);
  const aq = Math.abs(q);
  const sign = q >= 0 ? 1 : -1;
  const bFull = 0.8 * veh.qHeatMax;
  const b = aq < bFull ? aq / bFull : 1;
  const db = aq < bFull ? sign / bFull : 0;
  const g = aq < veh.flowRamp ? aq / veh.flowRamp : 1;
  const dg = aq < veh.flowRamp ? sign / veh.flowRamp : 0;
  out.q = (q >= 0 ? 1 / copHeat(env.tAmb) : -1 / copCool(env.tAmb)) + dg * (20 + 180 * b * b * b) + g * 540 * b * b * db;
  out.local = env.occupants * (u.local >= 0 ? veh.seatHeatW : -veh.seatVentW);
  return out;
}

function initialState(t, rh) {
  return { ta: t, tm: t, tw: t, tg: t, ts: t, w: humidityRatio(t, rh), co2: CO2_AMBIENT };
}

const _k = {};
const _x = new Float64Array(5);

function solveArrow(daa, dm, dw, dg, ds, k, ra, rm, rw, rg, rs, x) {
  const schur = daa - (k.kam * k.kam) / dm - (k.kaw * k.kaw) / dw - (k.kag * k.kag) / dg - (k.kas * k.kas) / ds;
  const a = (ra + (k.kam * rm) / dm + (k.kaw * rw) / dw + (k.kag * rg) / dg + (k.kas * rs) / ds) / schur;
  x[0] = a;
  x[1] = (rm + k.kam * a) / dm;
  x[2] = (rw + k.kaw * a) / dw;
  x[3] = (rg + k.kag * a) / dg;
  x[4] = (rs + k.kas * a) / ds;
  return x;
}

function step(s, u, env, dt, veh = VEHICLE, out = {}) {
  const k = derive(u, env, veh, _k);
  const ca = veh.Ca / dt;
  const cm = (veh.Cm * veh.massScale) / dt;
  const cw = veh.Cw / dt;
  const cg = veh.Cg / dt;
  const cs = veh.Cs / dt;
  const sun = env.sun * veh.solarScale;
  const qw = veh.defrostEta * k.d * k.pos * k.q;
  const seatHeat = k.l > 0 ? env.occupants * veh.seatHeatW * k.l : 0;
  solveArrow(
    ca + k.kam + k.kaw + k.kag + k.kas + k.kv,
    cm + k.kam,
    cw + k.kaw + k.kwo,
    cg + k.kag + k.kgo,
    cs + k.kas + k.kso,
    k,
    ca * s.ta + k.kv * env.tAmb + k.q - qw + env.occupants * OCC_SENSIBLE,
    cm * s.tm + veh.solarMass * sun + seatHeat,
    cw * s.tw + k.kwo * env.tAmb + veh.solarWind * sun + qw,
    cg * s.tg + k.kgo * env.tAmb + veh.solarGlass * sun,
    cs * s.ts + k.kso * env.tAmb + veh.solarShell * sun,
    _x
  );

  const mAir = (RHO_AIR * veh.cabinVolume) / dt;
  const wAmb = humidityRatio(env.tAmb, env.rh);
  const wEvap = humidityRatio(EVAP_TEMP, 1);
  const evap = k.hd > 0 && s.w > wEvap ? k.hd * k.flow : 0;
  const w = (mAir * s.w + k.fresh * wAmb + env.occupants * OCC_VAPOR + evap * wEvap) / (mAir + k.fresh + evap);

  const vol = veh.cabinVolume / dt;
  const qf = k.fresh / RHO_AIR;
  const co2 = (vol * s.co2 + qf * CO2_AMBIENT + env.occupants * OCC_CO2 * 1e6) / (vol + qf);

  out.ta = _x[0];
  out.tm = _x[1];
  out.tw = _x[2];
  out.tg = _x[3];
  out.ts = _x[4];
  out.w = Math.min(w, humidityRatio(_x[0], 1));
  out.co2 = co2;
  return out;
}

function stepAdjoint(s, n, u, env, dt, veh, lam, gu) {
  const k = derive(u, env, veh, _k);
  const ca = veh.Ca / dt;
  const cm = (veh.Cm * veh.massScale) / dt;
  const cw = veh.Cw / dt;
  const cg = veh.Cg / dt;
  const cs = veh.Cs / dt;

  const mAir = (RHO_AIR * veh.cabinVolume) / dt;
  const wAmb = humidityRatio(env.tAmb, env.rh);
  const wEvap = humidityRatio(EVAP_TEMP, 1);
  const evapOn = k.hd > 0 && s.w > wEvap;
  const evap = evapOn ? k.hd * k.flow : 0;
  const den = mAir + k.fresh + evap;
  const wStar = (mAir * s.w + k.fresh * wAmb + env.occupants * OCC_VAPOR + evap * wEvap) / den;
  let lamTa = lam.ta;
  let nu = lam.w;
  if (wStar > humidityRatio(n.ta, 1)) {
    lamTa += lam.w * dSatHumidityRatio(n.ta);
    nu = 0;
  }
  let dFresh = (nu * (wAmb - wStar)) / den;
  const dEvap = evapOn ? (nu * (wEvap - wStar)) / den : 0;
  const lamW = (nu * mAir) / den;

  const vol = veh.cabinVolume / dt;
  const qf = k.fresh / RHO_AIR;
  dFresh += (lam.co2 * (CO2_AMBIENT - n.co2)) / (vol + qf) / RHO_AIR;
  const lamC = (lam.co2 * vol) / (vol + qf);

  const mu = solveArrow(
    ca + k.kam + k.kaw + k.kag + k.kas + k.kv,
    cm + k.kam,
    cw + k.kaw + k.kwo,
    cg + k.kag + k.kgo,
    cs + k.kas + k.kso,
    k,
    lamTa,
    lam.tm,
    lam.tw,
    lam.tg,
    lam.ts,
    _x
  );
  const mua = mu[0];
  const mum = mu[1];
  const muw = mu[2];
  const mug = mu[3];
  const mus = mu[4];

  const dkam = -(mua - mum) * (n.ta - n.tm);
  const dkaw = -(mua - muw) * (n.ta - n.tw);
  const dkag = -(mua - mug) * (n.ta - n.tg);
  dFresh += mua * (env.tAmb - n.ta) * CP_AIR;

  const hin = veh.uaScale * veh.hInGlass;
  const eta = veh.defrostEta;
  const dB = dkam * veh.massBlower + dkaw * hin * veh.windArea * (0.6 + veh.defrostConv * k.d) + dkag * hin * veh.glassArea * 0.6;
  const dFlow = dFresh * (1 - k.r) + dEvap * k.hd;

  gu.q += mua * (1 - eta * k.d * k.pos) + muw * eta * k.d * k.pos + dB * k.db + dFlow * k.dflow + dEvap * k.dhd * k.flow;
  gu.recirc += -dFresh * k.flow;
  gu.defrost += (muw - mua) * eta * k.pos * k.q + dkaw * hin * veh.windArea * veh.defrostConv * k.b;
  if (k.l > 0 || (k.l === 0 && u.heating)) gu.local += mum * env.occupants * veh.seatHeatW;

  lam.ta = ca * mua;
  lam.tm = cm * mum;
  lam.tw = cw * muw;
  lam.tg = cg * mug;
  lam.ts = cs * mus;
  lam.w = lamW;
  lam.co2 = lamC;
}

function fogMargin(s) {
  return s.tw - dewPoint(s.w);
}

module.exports = {
  VEHICLE,
  CP_AIR,
  RHO_AIR,
  CO2_AMBIENT,
  clamp,
  satPressure,
  humidityRatio,
  dSatHumidityRatio,
  dewPoint,
  dDewPoint,
  hExt,
  copHeat,
  copCool,
  blowerOf,
  derive,
  electricPower,
  electricPowerGrad,
  initialState,
  step,
  stepAdjoint,
  fogMargin,
};
