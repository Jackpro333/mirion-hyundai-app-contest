'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/runtime');

const winter = { cabinTemp: 2, outsideTemp: -5, speedKmh: 60, recirculation: false, batterySoc: 64, hour: 6, remainingMinutes: 30, occupants: 1 };

test('차량 스냅숏을 받아 제안 카드와 결빙 안내를 만든다', () => {
  const rt = R.createRuntime();
  const out = rt.update({ ...winter, timeSeconds: 0 });
  assert.equal(out.ok, true);
  assert.match(out.card.text, /난방 \d\.\d kW/);
  assert.match(out.card.text, /내기 순환 켜기/);
  assert.ok(out.card.reasons.some((t) => t.includes('배터리 64%')));
  assert.ok(out.ice.bridge > 0.3);
  assert.deepEqual(out.commands, [{ type: 'recirculation', on: true }]);
});

test('필수 신호가 없으면 제안하지 않고 무엇이 없는지 알려 준다', () => {
  const rt = R.createRuntime();
  const out = rt.update({ outsideTemp: -5, hour: 6 });
  assert.equal(out.ok, false);
  assert.deepEqual(out.missing, ['cabinTemp']);
  assert.deepEqual(out.commands, []);
});

test('측정한 실내 온도로 추정 상태를 계속 바로잡는다', () => {
  const rt = R.createRuntime();
  rt.update({ ...winter, timeSeconds: 0 });
  const out = rt.update({ ...winter, cabinTemp: 14, recirculation: true, timeSeconds: 300 });
  assert.ok(Math.abs(out.estimate.cabin - 14) < 1e-9);
  assert.equal(out.commands.length, 0);
});

test('네 명이 탄 차가 내기 순환을 계속 켜 두면 김서림을 추정해 끄라고 안내한다', () => {
  const rt = R.createRuntime();
  let out;
  for (let i = 0; i <= 20; i++) out = rt.update({ cabinTemp: Math.min(22, 2 + i), outsideTemp: -8, speedKmh: 100, recirculation: true, hour: 22, remainingMinutes: 60, occupants: 4, timeSeconds: i * 60 });
  assert.ok(out.estimate.fogMargin < 1.5);
  assert.match(out.card.text, /내기 순환 끄기/);
  assert.deepEqual(out.commands, [{ type: 'recirculation', on: false }]);
  assert.ok(out.card.reasons.some((t) => t.includes('외기를 더 들입니다')));
});

test('시각이 없으면 결빙 추정은 건너뛰고 공조 제안만 한다', () => {
  const out = R.createRuntime().update({ cabinTemp: 30, outsideTemp: 33, speedKmh: 40 });
  assert.equal(out.ice, null);
  assert.match(out.card.text, /냉방/);
});

test('시트 열선 단수를 읽을 수 있는 차에서는 열선 명령도 함께 낸다', () => {
  const rt = R.createRuntime();
  const out = rt.update({ ...winter, seatLevel: 0, timeSeconds: 0 });
  const seat = out.commands.find((c) => c.type === 'seatHeat');
  assert.ok(seat && seat.level >= 1 && seat.level <= 3);
  const same = R.createRuntime().update({ ...winter, seatLevel: seat.level, timeSeconds: 0 });
  assert.equal(same.commands.some((c) => c.type === 'seatHeat'), false);
});
