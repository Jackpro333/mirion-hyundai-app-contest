'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/gate');
const V = require('../src/verify');

const driving = { speed: 100, gear: 'D', fogMargin: 5, co2: 700, rain: false, occupied: { driver: true, passenger: false, rearLeft: true, rearRight: false }, child: { driver: false, passenger: false, rearLeft: true, rearRight: false } };
const parked = { ...driving, speed: 0, gear: 'P' };

test('전수 검사: 모든 상태·명령·출처 조합에서 불변식 위반이 0건이다', () => {
  const r = V.run('full');
  assert.ok(r.checked > 9e7, `검사 ${r.checked}건`);
  assert.equal(r.violations, 0, JSON.stringify(r.samples));
  assert.ok(r.counts.allow > 0 && r.counts.clamp > 0 && r.counts.deny > 0);
});

test('검사기 자체 시험: 규칙을 하나씩 망가뜨린 게이트는 반드시 걸린다', () => {
  const mutants = {
    '문 규칙 삭제': (c, v, s) => (c && (c.type === 'door.open' || c.type === 'door.unlock') ? { verdict: 'allow', command: { type: c.type } } : G.decide(c, v, s)),
    '김서림 한계 무시': (c, v, s) => (c && c.type === 'hvac.recirc' && Number.isFinite(c.value) ? { verdict: 'allow', command: { type: c.type, value: Math.min(0.9, Math.max(0, c.value)) } } : G.decide(c, v, s)),
    '창문 속도 제한 무시': (c, v, s) => G.decide(c, { ...v, speed: Number.isFinite(v.speed) ? Math.min(v.speed, 50) : v.speed }, s),
    '어린이 좌석 무시': (c, v, s) => G.decide(c, { ...v, child: {} }, s),
    '앞유리 풍량 하한 무시': (c, v, s) => G.decide(c, c && c.type === 'hvac.defrostShare' ? { ...v, fogMargin: Number.isFinite(v.fogMargin) ? 9 : v.fogMargin } : v, s),
    '범위 보정 생략': (c, v, s) => (c && c.type === 'hvac.setTemp' && Number.isFinite(c.value) ? { verdict: 'allow', command: c } : G.decide(c, v, s)),
    '허용 목록 무시': (c, v, s) => {
      const r = G.decide(c, v, s);
      return r.verdict === 'deny' && c && typeof c.type === 'string' && c.type ? { verdict: 'allow', command: c } : r;
    },
  };
  for (const [name, decide] of Object.entries(mutants)) assert.ok(V.run('quick', decide).violations > 0, `${name} 를 잡지 못했다`);
});

test('주행 중 문 열기는 누가 시켜도 거부된다', () => {
  for (const src of G.SOURCES) assert.equal(G.decide({ type: 'door.open' }, driving, src).verdict, 'deny');
  assert.equal(G.decide({ type: 'door.open' }, parked, 'user').verdict, 'allow');
  assert.equal(G.decide({ type: 'door.open' }, parked, 'ai').verdict, 'deny');
});

test('위험한 명령을 보내도 실행되는 명령은 안전 범위를 벗어나지 않는다', () => {
  const all = ['driver', 'passenger', 'rearLeft', 'rearRight'];
  const attacks = [
    { type: 'door.open' },
    { type: 'door.unlock' },
    ...all.map((seat) => ({ type: 'window.open', seat, percent: 100 })),
    { type: 'hvac.setTemp', value: 99 },
    { type: 'seat.heat', seat: 'rearLeft', level: 3 },
    { type: 'seat.position', seat: 'driver', delta: 200 },
    { type: 'hvac.recirc', value: 0.9 },
  ];
  const foggy = { ...driving, fogMargin: 0.2 };
  for (const cmd of attacks) {
    const res = G.decide(cmd, foggy, 'ai');
    if (res.verdict === 'deny') continue;
    for (const inv of V.INVARIANTS) assert.ok(!inv.bad(res.command, foggy, 'ai'), `${cmd.type} → ${inv.id}`);
  }
  assert.equal(G.decide(attacks[0], foggy, 'ai').verdict, 'deny');
  assert.equal(G.decide({ type: 'hvac.setTemp', value: 99 }, foggy, 'ai').command.value, 30);
  assert.equal(G.decide({ type: 'seat.heat', seat: 'rearLeft', level: 3 }, foggy, 'ai').command.level, 1);
});

test('자동 명령은 10초에 6건까지만 통과한다', () => {
  const admit = G.createLimiter(6, 10000);
  let passed = 0;
  for (let i = 0; i < 50; i++) if (admit(i * 100)) passed++;
  assert.equal(passed, 6);
  assert.ok(admit(10000));
});
