'use strict';

const T = require('./thermal');
const C = require('./comfort');
const M = require('./mpc');
const G = require('./gate');
const B = require('./blackice');

const RECIRC_ON = 0.5;
const DEFAULT_TRIP_MINUTES = 30;

function finite(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function createRuntime(options = {}) {
  const veh = options.vehicle || T.VEHICLE;
  let state = null;
  let lastControl = { q: 0, recirc: 0, local: 0, defrost: 0 };
  let lastSeconds = null;
  let warm = null;
  let prevLocal;

  function seed(snap) {
    const cabin = snap.cabinTemp;
    const out = snap.outsideTemp;
    state = T.initialState(cabin, 0.5);
    state.tw = out + 0.25 * (cabin - out);
    state.tg = out + 0.3 * (cabin - out);
    state.ts = out + 0.05 * (cabin - out);
    state.w = T.humidityRatio(out, 0.7);
  }

  function update(snap) {
    const missing = ['cabinTemp', 'outsideTemp'].filter((k) => !finite(snap[k]));
    if (missing.length) return { ok: false, missing, card: null, ice: null, commands: [] };
    const occupants = finite(snap.occupants) && snap.occupants >= 1 ? Math.round(snap.occupants) : 1;
    const speed = finite(snap.speedKmh) ? Math.max(0, snap.speedKmh) : 0;
    const env = { tAmb: snap.outsideTemp, sun: finite(snap.sun) ? snap.sun : 0, rh: finite(snap.humidity) ? snap.humidity : 0.7, occupants, speed: speed / 3.6 };
    const seconds = finite(snap.timeSeconds) ? snap.timeSeconds : lastSeconds === null ? 0 : lastSeconds + 60;
    if (!state) seed(snap);
    else {
      let dt = Math.min(600, Math.max(0, seconds - lastSeconds));
      const observed = { ...lastControl, recirc: typeof snap.recirculation === 'boolean' ? (snap.recirculation ? 0.9 : 0) : lastControl.recirc };
      while (dt > 0) {
        const h = Math.min(10, dt);
        state = T.step(state, observed, env, h, veh);
        dt -= h;
      }
      const error = snap.cabinTemp - state.ta;
      state.ta += error;
      state.tm += 0.3 * error;
    }
    lastSeconds = seconds;

    const target = C.targetFor(env.tAmb) + (finite(snap.targetOffset) ? snap.targetOffset : 0);
    const heating = env.tAmb < target - 2;
    const remainingMinutes = finite(snap.remainingMinutes) && snap.remainingMinutes > 0 ? snap.remainingMinutes : DEFAULT_TRIP_MINUTES;
    const res = M.plan(state, () => env, Math.ceil(remainingMinutes), { target, vehicle: veh, warm, prevLocal, heating });
    warm = res.z;
    prevLocal = res.control.local;

    const view = {
      speed,
      gear: typeof snap.gear === 'string' ? snap.gear : speed > 0 ? 'D' : 'P',
      fogMargin: T.fogMargin(state),
      co2: state.co2,
      rain: Boolean(snap.raining),
      occupied: { driver: true, passenger: occupants > 1, rearLeft: occupants > 2, rearRight: occupants > 3 },
      child: { driver: false, passenger: false, rearLeft: false, rearRight: false },
    };
    const want = res.control;
    const recirc = G.decide({ type: 'hvac.recirc', value: want.recirc }, view, 'mpc');
    const power = G.decide({ type: 'hvac.power', value: want.q }, view, 'mpc');
    const defrost = G.decide({ type: 'hvac.defrostShare', value: want.defrost }, view, 'mpc');
    lastControl = { q: power.command ? power.command.value : 0, recirc: recirc.command ? recirc.command.value : 0, local: want.local, defrost: defrost.command ? defrost.command.value : 1 };

    const commands = [];
    const recircOn = lastControl.recirc >= RECIRC_ON;
    if (typeof snap.recirculation !== 'boolean' || snap.recirculation !== recircOn) commands.push({ type: 'recirculation', on: recircOn });
    if (finite(snap.seatLevel)) {
      const seat = G.decide({ type: 'seat.heat', seat: 'driver', level: Math.max(0, want.local) }, view, 'mpc');
      if (seat.command && seat.command.level !== Math.round(snap.seatLevel)) commands.push({ type: 'seatHeat', level: seat.command.level });
    }

    const parts = [];
    if (Math.abs(lastControl.q) < 1) parts.push('공조 대기');
    else parts.push((heating ? '난방 ' : '냉방 ') + Math.abs(lastControl.q / 1000).toFixed(1) + ' kW');
    parts.push('내기 순환 ' + (recircOn ? '켜기' : '끄기'));
    if (heating && lastControl.defrost >= 0.05) parts.push('앞유리 풍량 ' + Math.round(lastControl.defrost * 100) + '%');
    if (lastControl.local > 0) parts.push('시트 열선 ' + lastControl.local + '단');
    if (lastControl.local < 0) parts.push('시트 통풍 ' + -lastControl.local + '단');
    const teq = C.equivalentTemp(state, env, lastControl.local, veh);
    const reasons = ['체감온도 ' + teq.toFixed(1) + '°C, 목표 ' + target + '°C', '김서림 여유 ' + view.fogMargin.toFixed(1) + 'K, 추정 CO2 ' + Math.round(state.co2) + 'ppm'];
    if (recirc.verdict !== 'allow' && recirc.reason) reasons.push(recirc.reason);
    if (finite(snap.batterySoc)) reasons.push('배터리 ' + Math.round(snap.batterySoc) + '%');

    let ice = null;
    if (finite(snap.hour)) ice = B.assess({ outsideTemp: snap.outsideTemp, hour: snap.hour, raining: Boolean(snap.raining), slipEvents: snap.slipEvents || 0 });

    return {
      ok: true,
      missing: [],
      card: { text: parts.join(' · '), reasons },
      ice: ice && { level: ice.level, headline: ice.headline, action: ice.action, reasons: ice.reasons, road: ice.road.probability, bridge: ice.bridge.probability },
      commands,
      estimate: { teq, fogMargin: view.fogMargin, co2: state.co2, cabin: state.ta },
      plan: { residual: res.relaxedResidual, iterations: res.iterations },
    };
  }

  return { update };
}

module.exports = { createRuntime, RECIRC_ON };
