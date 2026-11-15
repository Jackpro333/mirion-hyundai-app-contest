'use strict';

const LOCAL_HEAT_K = 0.8;
const LOCAL_VENT_K = 0.7;
const SUN_K = 0.0015;
const BAND = 0.5;
const W_AIR = 0.66;
const W_MASS = 0.24;
const W_GLASS = 0.1;

function glassShare(veh) {
  return veh.windArea / (veh.windArea + veh.glassArea);
}

function equivalentTemp(s, env, local, veh) {
  const fw = veh ? glassShare(veh) : 0.325;
  const base = W_AIR * s.ta + W_MASS * s.tm + W_GLASS * (fw * s.tw + (1 - fw) * s.tg) + SUN_K * env.sun;
  return base + (local >= 0 ? LOCAL_HEAT_K * local : LOCAL_VENT_K * local);
}

function discomfort(teq, target) {
  const d = Math.abs(teq - target) - BAND;
  return d > 0 ? d : 0;
}

function targetFor(tAmb) {
  return tAmb < 15 ? 22 : 24;
}

module.exports = { LOCAL_HEAT_K, LOCAL_VENT_K, SUN_K, BAND, W_AIR, W_MASS, W_GLASS, glassShare, equivalentTemp, discomfort, targetFor };
