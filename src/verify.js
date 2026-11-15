'use strict';

const G = require('./gate');

const INVARIANTS = [
  {
    id: 'I1',
    text: '주행 중이거나 P 단이 아니면 문 열림·잠금 해제가 실행되지 않는다',
    bad: (c, v) => (c.type === 'door.open' || c.type === 'door.unlock') && (v.speed > 0 || v.gear !== 'P'),
  },
  {
    id: 'I2',
    text: '사람이 낸 명령이 아니면 문은 어떤 상태에서도 열리지 않는다',
    bad: (c, v, src) => (c.type === 'door.open' || c.type === 'door.unlock') && src !== 'user',
  },
  {
    id: 'I3',
    text: '주행 중에는 운전석 위치가 바뀌지 않는다',
    bad: (c, v) => c.type === 'seat.position' && c.seat === 'driver' && (v.speed > 0 || v.gear !== 'P') && c.delta !== 0,
  },
  {
    id: 'I4',
    text: '시속 100km 이상에서 창문이 20% 넘게 열리지 않는다',
    bad: (c, v) => c.type === 'window.open' && v.speed >= 100 && c.percent > 20,
  },
  {
    id: 'I5',
    text: '김서림 여유가 0.5K 미만이면 내기 순환이 실행되지 않는다',
    bad: (c, v) => c.type === 'hvac.recirc' && v.fogMargin < 0.5 && c.value > 0,
  },
  {
    id: 'I6',
    text: '김서림 여유가 1.5K 미만이면 내기 순환이 30% 를 넘지 않고, 성에 제거가 꺼지지 않으며, 앞유리 풍량이 50% 아래로 내려가지 않는다',
    bad: (c, v) => v.fogMargin < 1.5 && ((c.type === 'hvac.recirc' && c.value > 0.3) || (c.type === 'hvac.defrost' && c.on === false) || (c.type === 'hvac.defrostShare' && c.value < 0.5)),
  },
  {
    id: 'I7',
    text: 'CO2 가 1500ppm 을 넘으면 내기 순환이 20% 를 넘지 않는다',
    bad: (c, v) => c.type === 'hvac.recirc' && v.co2 > 1500 && c.value > 0.2,
  },
  {
    id: 'I8',
    text: '비가 오는 주행 중에는 와이퍼가 꺼지지 않고, 자동 명령으로 창문이 열리지 않는다',
    bad: (c, v, src) =>
      v.rain && ((c.type === 'wiper.set' && c.mode === 'off' && (v.speed > 0 || v.gear !== 'P')) || (c.type === 'window.open' && src !== 'user' && c.percent > 0)),
  },
  {
    id: 'I9',
    text: '설정 온도, 공조 출력, 시트 단수, 창문 개방량이 항상 유한한 값이고 허용 범위 안이다',
    bad: (c) =>
      (c.type === 'hvac.setTemp' && !(c.value >= 17 && c.value <= 30)) ||
      (c.type === 'hvac.power' && !(c.value >= -6000 && c.value <= 5500)) ||
      (c.type === 'hvac.recirc' && !(c.value >= 0 && c.value <= 0.9)) ||
      (c.type === 'hvac.defrostShare' && !(c.value >= 0 && c.value <= 1)) ||
      (c.type === 'seat.heat' && !(Number.isInteger(c.level) && c.level >= -3 && c.level <= 3)) ||
      (c.type === 'window.open' && !(c.percent >= 0 && c.percent <= 100)),
  },
  {
    id: 'I10',
    text: '빈 좌석 열선은 켜지지 않고, 어린이 좌석 열선은 1단을 넘지 않는다',
    bad: (c, v) => c.type === 'seat.heat' && ((c.level !== 0 && !v.occupied[c.seat]) || (c.level > 1 && v.child[c.seat])),
  },
  {
    id: 'I11',
    text: '허용 목록에 없는 명령과 차량 상태를 읽지 못한 경우의 명령은 실행되지 않는다',
    bad: (c, v) => !KNOWN.has(c.type) || !Number.isFinite(v.speed) || !Number.isFinite(v.fogMargin) || !Number.isFinite(v.co2),
  },
];

const KNOWN = new Set(['hvac.setTemp', 'hvac.power', 'hvac.recirc', 'hvac.defrost', 'hvac.defrostShare', 'seat.heat', 'seat.position', 'window.open', 'door.unlock', 'door.open', 'wiper.set']);

const ODD = [NaN, Infinity, -Infinity, null, undefined, '22', {}];

function commandGrid() {
  const out = [];
  const nums = (list) => list.concat(ODD);
  for (const value of nums([-40, 16.9, 17, 22, 30, 30.1, 99])) out.push({ type: 'hvac.setTemp', value });
  for (const value of nums([-9000, -6000, 0, 5500, 5501, 1e9])) out.push({ type: 'hvac.power', value });
  for (const value of nums([-1, 0, 0.1, 0.2, 0.21, 0.3, 0.31, 0.9, 1, 5])) out.push({ type: 'hvac.recirc', value });
  for (const on of [true, false, 0, 'off', null]) out.push({ type: 'hvac.defrost', on });
  for (const value of nums([-1, 0, 0.3, 0.49, 0.5, 1, 4])) out.push({ type: 'hvac.defrostShare', value });
  for (const seat of G.SEATS.concat(['trunk', null]))
    for (const level of nums([-5, -3, -1, 0, 1, 2, 3, 2.6, 7])) out.push({ type: 'seat.heat', seat, level });
  for (const seat of G.SEATS.concat(['trunk'])) for (const delta of nums([-500, -10, 0, 10, 500])) out.push({ type: 'seat.position', seat, delta });
  for (const seat of G.SEATS.concat(['roof'])) for (const percent of nums([-10, 0, 10, 20, 21, 50, 100, 300])) out.push({ type: 'window.open', seat, percent });
  out.push({ type: 'door.unlock' }, { type: 'door.open' });
  for (const mode of ['off', 'auto', 'low', 'high', 'turbo', null]) out.push({ type: 'wiper.set', mode });

  out.push({ type: 'brake.release' }, { type: 'steering.turn', value: 30 }, { type: 'door.openAll' }, { type: '' }, { type: 42 }, {}, null, 'door.open');
  return out;
}

function stateGrid(level) {
  const speeds = level === 'full' ? [0, 0.5, 30, 99.9, 100, 130, 250, NaN] : [0, 30, 100, NaN];
  const fogs = level === 'full' ? [-5, 0.49, 0.5, 1.49, 1.5, 8, NaN] : [0.49, 1.49, 8];
  const co2s = level === 'full' ? [420, 1500, 1501, 5000, NaN] : [420, 1501];
  const seatSets = level === 'full' ? 16 : 4;
  const out = [];
  for (const speed of speeds)
    for (const gear of G.GEARS)
      for (const fogMargin of fogs)
        for (const co2 of co2s)
          for (const rain of [false, true])
            for (let occ = 0; occ < seatSets; occ++)
              for (const kids of [0, 0b0100, 0b1100]) {
                const bits = level === 'full' ? occ : [0b0001, 0b0011, 0b0111, 0b1111][occ];
                const occupied = {};
                const child = {};
                G.SEATS.forEach((seat, i) => {
                  occupied[seat] = Boolean(bits & (1 << i));
                  child[seat] = Boolean(kids & (1 << i)) && occupied[seat];
                });
                out.push({ speed, gear, fogMargin, co2, rain, occupied, child });
              }
  return out;
}

function run(level = 'full', decide = G.decide) {
  const commands = commandGrid();
  const states = stateGrid(level);
  const counts = { allow: 0, clamp: 0, deny: 0 };
  const samples = [];
  let violations = 0;
  let checked = 0;
  for (const v of states)
    for (const cmd of commands)
      for (const source of G.SOURCES) {
        checked++;
        let res;
        try {
          res = decide(cmd, v, source);
        } catch (error) {
          violations++;
          if (samples.length < 5) samples.push({ id: 'crash', cmd, v, source, message: String(error) });
          continue;
        }
        counts[res.verdict]++;
        if (res.verdict === 'deny') continue;
        for (const inv of INVARIANTS)
          if (inv.bad(res.command, v, source)) {
            violations++;
            if (samples.length < 5) samples.push({ id: inv.id, cmd, v, source, effective: res.command });
          }
      }
  return { checked, states: states.length, commands: commands.length, counts, violations, samples, invariants: INVARIANTS.length };
}

module.exports = { INVARIANTS, run, commandGrid, stateGrid };
