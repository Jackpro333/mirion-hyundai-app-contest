'use strict';

const GEARS = ['P', 'R', 'N', 'D'];
const SEATS = ['driver', 'passenger', 'rearLeft', 'rearRight'];
const SOURCES = ['user', 'ai', 'mpc'];

const LIMITS = Object.freeze({
  tempMin: 17,
  tempMax: 30,
  qMin: -6000,
  qMax: 5500,
  fogHard: 0.5,
  fogSoft: 1.5,
  co2Soft: 1500,
  windowSpeed: 100,
  windowMaxFast: 20,
  childSeatHeat: 1,
  defrostFloor: 0.5,
});

function finite(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function allow(command) {
  return { verdict: 'allow', command, reason: null };
}

function clampTo(command, reason) {
  return { verdict: 'clamp', command, reason };
}

function deny(reason) {
  return { verdict: 'deny', command: null, reason };
}

function recircCeiling(v) {
  if (v.fogMargin < LIMITS.fogHard) return 0;
  let cap = 0.9;
  if (v.fogMargin < LIMITS.fogSoft) cap = Math.min(cap, 0.3);
  if (v.co2 > LIMITS.co2Soft) cap = Math.min(cap, 0.2);
  return cap;
}

function decide(cmd, v, source) {
  if (!cmd || typeof cmd.type !== 'string') return deny('명령 형식이 올바르지 않습니다.');
  if (!SOURCES.includes(source)) return deny('출처를 알 수 없는 명령입니다.');
  if (!finite(v.speed) || !GEARS.includes(v.gear) || !finite(v.fogMargin) || !finite(v.co2))
    return deny('차량 상태를 읽지 못해 명령을 보류합니다.');
  const moving = v.speed > 0 || v.gear !== 'P';
  const auto = source !== 'user';

  switch (cmd.type) {
    case 'hvac.setTemp': {
      if (!finite(cmd.value)) return deny('온도 값이 숫자가 아닙니다.');
      const value = Math.min(LIMITS.tempMax, Math.max(LIMITS.tempMin, cmd.value));
      const out = { type: cmd.type, value };
      return value === cmd.value ? allow(out) : clampTo(out, `설정 온도는 ${LIMITS.tempMin}~${LIMITS.tempMax}°C 범위로 맞춥니다.`);
    }
    case 'hvac.power': {
      if (!finite(cmd.value)) return deny('열량 값이 숫자가 아닙니다.');
      const value = Math.min(LIMITS.qMax, Math.max(LIMITS.qMin, cmd.value));
      const out = { type: cmd.type, value };
      return value === cmd.value ? allow(out) : clampTo(out, '공조 출력 한계로 맞춥니다.');
    }
    case 'hvac.recirc': {
      if (!finite(cmd.value)) return deny('내기 순환 값이 숫자가 아닙니다.');
      const cap = recircCeiling(v);
      const value = Math.min(cap, Math.max(0, cmd.value));
      const out = { type: cmd.type, value };
      if (value === cmd.value) return allow(out);
      if (cmd.value < 0) return clampTo(out, '내기 순환 비율은 0 이상입니다.');
      return clampTo(out, v.fogMargin < LIMITS.fogSoft ? '앞유리 김서림 여유가 부족해 외기를 더 들입니다.' : v.co2 > LIMITS.co2Soft ? '실내 CO2 가 높아 외기를 더 들입니다.' : '내기 순환은 90%까지입니다.');
    }
    case 'hvac.defrost': {
      if (typeof cmd.on !== 'boolean') return deny('성에 제거 값이 올바르지 않습니다.');
      if (!cmd.on && v.fogMargin < LIMITS.fogSoft) return deny('김서림 여유가 부족해 성에 제거를 끌 수 없습니다.');
      return allow({ type: cmd.type, on: cmd.on });
    }
    case 'hvac.defrostShare': {
      if (!finite(cmd.value)) return deny('성에 제거 풍량 값이 숫자가 아닙니다.');
      const floor = v.fogMargin < LIMITS.fogSoft ? LIMITS.defrostFloor : 0;
      const value = Math.min(1, Math.max(floor, cmd.value));
      const out = { type: cmd.type, value };
      if (value === cmd.value) return allow(out);
      return clampTo(out, cmd.value < floor && floor > 0 ? '김서림 여유가 부족해 앞유리 쪽 풍량을 절반 이상으로 유지합니다.' : '성에 제거 풍량은 0~100% 입니다.');
    }
    case 'seat.heat': {
      if (!SEATS.includes(cmd.seat) || !finite(cmd.level)) return deny('좌석 또는 단수가 올바르지 않습니다.');
      let level = Math.round(Math.min(3, Math.max(-3, cmd.level)));
      let reason = level === cmd.level ? null : '시트 단수는 -3~3 사이 정수로 맞춥니다.';
      if (level !== 0 && !v.occupied[cmd.seat]) {
        level = 0;
        reason = '빈 좌석에는 켜지 않습니다.';
      } else if (level > LIMITS.childSeatHeat && v.child[cmd.seat]) {
        level = LIMITS.childSeatHeat;
        reason = '어린이 좌석 열선은 1단까지입니다.';
      }
      const out = { type: cmd.type, seat: cmd.seat, level };
      return reason ? clampTo(out, reason) : allow(out);
    }
    case 'seat.position': {
      if (!SEATS.includes(cmd.seat) || !finite(cmd.delta)) return deny('좌석 또는 이동량이 올바르지 않습니다.');
      if (cmd.seat === 'driver' && moving) return deny('주행 중에는 운전석 위치를 바꾸지 않습니다.');
      if (auto && v.occupied[cmd.seat]) return deny('사람이 앉은 좌석은 자동으로 움직이지 않습니다.');
      return allow({ type: cmd.type, seat: cmd.seat, delta: Math.min(50, Math.max(-50, cmd.delta)) });
    }
    case 'window.open': {
      if (!SEATS.includes(cmd.seat) || !finite(cmd.percent)) return deny('창문 또는 개방량이 올바르지 않습니다.');
      let percent = Math.min(100, Math.max(0, cmd.percent));
      let reason = percent === cmd.percent ? null : '창문 개방은 0~100% 입니다.';
      if (v.speed >= LIMITS.windowSpeed && percent > LIMITS.windowMaxFast) {
        percent = LIMITS.windowMaxFast;
        reason = `시속 ${LIMITS.windowSpeed}km 이상에서는 창문을 ${LIMITS.windowMaxFast}%까지만 엽니다.`;
      }
      if (auto && v.rain && percent > 0) return deny('비가 올 때는 자동으로 창문을 열지 않습니다.');
      const out = { type: cmd.type, seat: cmd.seat, percent };
      return reason ? clampTo(out, reason) : allow(out);
    }
    case 'door.unlock':
    case 'door.open': {
      if (moving) return deny('주행 중이거나 P 단이 아니면 문을 열거나 잠금을 풀지 않습니다.');
      if (auto) return deny('문은 사람이 직접 조작합니다.');
      return allow({ type: cmd.type });
    }
    case 'wiper.set': {
      if (!['off', 'auto', 'low', 'high'].includes(cmd.mode)) return deny('와이퍼 모드가 올바르지 않습니다.');
      if (cmd.mode === 'off' && v.rain && moving) return deny('비가 오는 주행 중에는 와이퍼를 끄지 않습니다.');
      return allow({ type: cmd.type, mode: cmd.mode });
    }
    default:
      return deny('허용 목록에 없는 명령입니다.');
  }
}

function createLimiter(maxPerWindow = 6, windowMs = 10000) {
  const stamps = [];
  return function admit(nowMs) {
    while (stamps.length && nowMs - stamps[0] >= windowMs) stamps.shift();
    if (stamps.length >= maxPerWindow) return false;
    stamps.push(nowMs);
    return true;
  };
}

module.exports = { GEARS, SEATS, SOURCES, LIMITS, decide, recircCeiling, createLimiter };
