'use strict';

const SIGMA = 5.670374e-8;
const KELVIN = 273.15;

const SURFACES = Object.freeze({
  road: { name: '일반 도로', capacity: 1.6e5, ground: 7.0, convection: 1.0 },
  bridge: { name: '교량·고가', capacity: 0.6e5, ground: 0.0, convection: 1.8 },
});

const DEFAULTS = Object.freeze({
  particles: 600,
  seed: 20261115,
  latitude: 37.3,
  hoursBack: 8,
  stepSeconds: 300,
  depositionWindowHours: 3,
  slipLikelihoodRatio: 8,
});

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

function gaussian(rnd) {
  const u = Math.max(rnd(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

function sinElevation(dayOfYear, hour, latitude) {
  const decl = (-23.44 * Math.PI) / 180 * Math.cos((2 * Math.PI * (dayOfYear + 10)) / 365);
  const lat = (latitude * Math.PI) / 180;
  const hourAngle = ((hour - 12) * 15 * Math.PI) / 180;
  return Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
}

function clearSkyIrradiance(sinEl) {
  return sinEl > 0.01 ? 1098 * sinEl * Math.exp(-0.057 / sinEl) : 0;
}

function skyEmissivity(tDew, cloud) {
  const x = tDew / 100;
  const clear = 0.711 + 0.56 * x + 0.73 * x * x;
  return clear + (1 - clear) * 0.84 * cloud;
}

function diurnal(hour) {
  return Math.cos((2 * Math.PI * (hour - 15)) / 24);
}

function stepSurface(ts, tAir, tSkyK, solar, tDeep, wind, surface, dt) {
  const hc = (5.8 + 4.1 * wind) * surface.convection;
  const mean = ts + KELVIN;
  const hr = 4 * 0.95 * SIGMA * mean * mean * mean;
  const c = surface.capacity / dt;
  return (c * ts + hc * tAir + hr * (tSkyK - KELVIN) + surface.ground * tDeep + solar) / (c + hc + hr + surface.ground);
}

function sample(obs, rnd) {
  const sky = obs.sky || 'unknown';
  const cloud = sky === 'clear' ? 0.25 * rnd() : sky === 'overcast' ? 0.75 + 0.25 * rnd() : rnd();
  const bias = Math.max(-0.5, 0.5 + 0.7 * gaussian(rnd));
  const tAir = obs.outsideTemp - bias;
  let depression;
  if (obs.humidity !== undefined && obs.humidity !== null) {
    const rh = Math.min(1, Math.max(0.05, obs.humidity + 0.05 * gaussian(rnd)));
    depression = Math.max(0, ((100 - 100 * rh) / 5) * (1 + 0.15 * gaussian(rnd)));
  } else {
    depression = 0.3 + 7.7 * rnd() * rnd();
  }
  return {
    cloud,
    tAir,
    tDew: tAir - depression,
    wind: obs.wind !== undefined && obs.wind !== null ? Math.max(0.2, obs.wind * (1 + 0.25 * gaussian(rnd))) : 0.5 + 5.5 * rnd(),
    amplitude: 4 + 8 * rnd(),
    deepOffset: -1 + 8 * rnd(),
    shade: 0.6 + 0.4 * rnd(),
    residualWet: rnd() < (obs.recentRain ? 0.6 : 0.15),
    modelError: 1.2 * gaussian(rnd),
  };
}

function runParticle(p, obs, surface, cfg) {
  const steps = Math.round((cfg.hoursBack * 3600) / cfg.stepSeconds);
  const windowSteps = Math.round((cfg.depositionWindowHours * 3600) / cfg.stepSeconds);
  const day = obs.dayOfYear !== undefined ? obs.dayOfYear : 319;
  const shapeNow = diurnal(obs.hour);
  const mean = p.tAir - (p.amplitude / 2) * shapeNow;
  const tDeep = mean + p.deepOffset;
  const eps = skyEmissivity(p.tDew, p.cloud);
  let ts = p.tAir;
  let deposited = false;
  let wasAbove = false;
  for (let warm = 0; warm < 2; warm++) {
    for (let i = steps; i >= 0; i--) {
      const hour = (((obs.hour - (i * cfg.stepSeconds) / 3600) % 24) + 24) % 24;
      const tAir = p.tAir + (p.amplitude / 2) * (diurnal(hour) - shapeNow);
      const tSkyK = Math.pow(eps, 0.25) * (tAir + KELVIN);
      const solar = 0.88 * p.shade * (1 - 0.75 * Math.pow(p.cloud, 3)) * clearSkyIrradiance(sinElevation(day, hour, cfg.latitude));
      ts = stepSurface(ts, tAir, tSkyK, solar, tDeep, p.wind, surface, cfg.stepSeconds);
      if (warm === 1 && i <= windowSteps) {
        if (ts < Math.min(p.tDew, tAir)) deposited = true;
        if (ts > 0.5) wasAbove = true;
      }
    }
  }
  ts += p.modelError;
  const wet = Boolean(obs.raining) || p.residualWet;
  const frozen = ts <= 0;
  return { ts, frozen, ice: frozen && (wet || deposited), cause: !frozen ? null : obs.raining ? 'rain' : deposited ? 'frost' : wet ? (wasAbove ? 'refreeze' : 'wet') : null };
}

function quantile(sorted, q) {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function applySlip(p, slipEvents, ratio) {
  if (!slipEvents) return p;
  const odds = (Math.min(Math.max(p, 1e-4), 1 - 1e-4) / (1 - Math.min(Math.max(p, 1e-4), 1 - 1e-4))) * Math.pow(ratio, slipEvents);
  return odds / (1 + odds);
}

function estimate(obs, surfaceKey, cfg) {
  const surface = SURFACES[surfaceKey];
  const rnd = mulberry32(cfg.seed);
  const temps = [];
  const byCloud = { clear: [0, 0], partly: [0, 0], overcast: [0, 0] };
  const causes = { rain: 0, frost: 0, refreeze: 0, wet: 0 };
  let ice = 0;
  let frozen = 0;
  for (let i = 0; i < cfg.particles; i++) {
    const p = sample(obs, rnd);
    const r = runParticle(p, obs, surface, cfg);
    temps.push(r.ts);
    if (r.frozen) frozen++;
    if (r.ice) {
      ice++;
      causes[r.cause]++;
    }
    const bin = p.cloud < 1 / 3 ? 'clear' : p.cloud < 2 / 3 ? 'partly' : 'overcast';
    byCloud[bin][0] += r.ice ? 1 : 0;
    byCloud[bin][1]++;
  }
  temps.sort((a, b) => a - b);
  const prior = ice / cfg.particles;
  const probability = applySlip(prior, obs.slipEvents, cfg.slipLikelihoodRatio);
  const cond = {};
  for (const [k, [a, b]] of Object.entries(byCloud)) cond[k] = b >= 20 ? applySlip(a / b, obs.slipEvents, cfg.slipLikelihoodRatio) : null;
  let mainCause = null;
  for (const [k, v] of Object.entries(causes)) if (v > 0 && (mainCause === null || v > causes[mainCause])) mainCause = k;
  return {
    surface: surfaceKey,
    probability,
    standardError: Math.sqrt((prior * (1 - prior)) / cfg.particles),
    frozenProbability: frozen / cfg.particles,
    surfaceTemp: { p10: quantile(temps, 0.1), median: quantile(temps, 0.5), p90: quantile(temps, 0.9) },
    byCloud: cond,
    mainCause,
  };
}

function levelOf(p) {
  return p >= 0.6 ? 'danger' : p >= 0.3 ? 'warning' : p >= 0.1 ? 'caution' : 'low';
}

const LEVEL_TEXT = { danger: '위험', warning: '경고', caution: '주의', low: '낮음' };
const CAUSE_TEXT = {
  rain: '비나 눈이 영하의 노면에 닿아 바로 얼 수 있습니다.',
  frost: '노면이 이슬점보다 차가워 서리가 내려앉을 조건입니다.',
  refreeze: '젖은 노면이 영상에서 영하로 내려가며 다시 얼 조건입니다.',
  wet: '남아 있는 물기가 영하의 노면에서 얼어 있을 수 있습니다.',
};

function pct(p) {
  return Math.round(p * 100);
}

function assess(obs, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  if (!Number.isFinite(obs.outsideTemp) || !Number.isFinite(obs.hour)) throw new Error('outsideTemp 와 hour 가 필요합니다.');
  const road = estimate(obs, 'road', cfg);
  const bridge = estimate(obs, 'bridge', cfg);
  const top = bridge.probability >= road.probability ? bridge : road;
  const level = levelOf(top.probability);
  const reasons = [];
  if (top.mainCause && level !== 'low') reasons.push(CAUSE_TEXT[top.mainCause]);
  if (obs.outsideTemp > 0 && top.probability >= 0.1)
    reasons.push(`외기는 영상 ${obs.outsideTemp.toFixed(1)}°C 지만 노면은 더 차갑습니다. 추정 노면 온도 ${top.surfaceTemp.p10.toFixed(1)}~${top.surfaceTemp.p90.toFixed(1)}°C.`);
  if (bridge.probability - road.probability >= 0.1) reasons.push(`교량·고가는 땅의 열을 받지 못해 먼저 업니다. 교량 ${pct(bridge.probability)}%, 일반 도로 ${pct(road.probability)}%.`);
  const c = top.byCloud;
  if ((obs.sky || 'unknown') === 'unknown' && c.clear !== null && c.overcast !== null && Math.abs(c.clear - c.overcast) >= 0.2)
    reasons.push(`하늘 상태를 몰라 범위가 넓습니다. 맑으면 ${pct(c.clear)}%, 흐리면 ${pct(c.overcast)}%.`);
  if (obs.slipEvents) reasons.push(`미끄러짐 감지 ${obs.slipEvents}회를 반영해 확률을 올렸습니다.`);
  const headline =
    level === 'low'
      ? `결빙 신호가 약합니다(${pct(top.probability)}%). 안전하다는 뜻은 아닙니다.`
      : `${SURFACES[top.surface].name} 결빙 가능성 ${pct(top.probability)}% · ${LEVEL_TEXT[level]}`;
  const action = level === 'danger' ? '지금 속도를 줄이고 급제동·급조향을 피하세요.' : level === 'warning' ? '교량, 고가, 그늘, 터널 출구에서 미리 감속하세요.' : level === 'caution' ? '교량과 그늘진 구간을 조심하세요.' : '';
  return { level, levelText: LEVEL_TEXT[level], headline, action, reasons, road, bridge };
}

function sweepTemperature(obs, temps, options = {}) {
  return temps.map((t) => {
    const r = assess({ ...obs, outsideTemp: t }, options);
    return { outsideTemp: t, road: r.road.probability, bridge: r.bridge.probability };
  });
}

module.exports = { SURFACES, DEFAULTS, assess, sweepTemperature, estimate, stepSurface, skyEmissivity, sinElevation, clearSkyIrradiance, levelOf, mulberry32 };
