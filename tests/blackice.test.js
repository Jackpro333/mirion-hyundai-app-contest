'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/blackice');

const dawn = { hour: 5.5 };

test('노면 모델: 해가 없고 하늘이 대기와 같은 온도면 노면은 대기 온도로 수렴한다', () => {
  let ts = 10;
  for (let i = 0; i < 2000; i++) ts = B.stepSurface(ts, 2, 2 + 273.15, 0, 2, 2, B.SURFACES.bridge, 300);
  assert.ok(Math.abs(ts - 2) < 1e-3);
});

test('맑은 밤에는 복사 냉각으로 노면이 대기보다 차갑고, 흐리면 그 차이가 줄어든다', () => {
  const clear = B.assess({ outsideTemp: 1.5, hour: 5.5, sky: 'clear', humidity: 0.9, wind: 1 });
  const overcast = B.assess({ outsideTemp: 1.5, hour: 5.5, sky: 'overcast', humidity: 0.9, wind: 1 });
  assert.ok(clear.bridge.surfaceTemp.median < 1.5 - 2);
  assert.ok(clear.bridge.surfaceTemp.median < overcast.bridge.surfaceTemp.median - 1.5);
  assert.ok(clear.bridge.probability > overcast.bridge.probability + 0.3);
});

test('외기가 영상이어도 맑고 습한 새벽의 교량은 결빙 확률이 높다', () => {
  const r = B.assess({ outsideTemp: 1.5, hour: 5.5, sky: 'clear', humidity: 0.9, wind: 1 });
  assert.ok(r.bridge.probability > 0.8);
  assert.equal(r.level, 'danger');
  assert.ok(r.reasons.some((t) => t.includes('영상')));
});

test('교량은 일반 도로보다 먼저 언다', () => {
  for (const obs of [{ outsideTemp: 1.5, ...dawn }, { outsideTemp: 0, ...dawn, sky: 'overcast' }, { outsideTemp: 2.5, ...dawn, sky: 'clear' }]) {
    const r = B.assess(obs);
    assert.ok(r.bridge.probability >= r.road.probability, JSON.stringify(obs));
  }
});

test('맑은 오후에는 결빙 확률이 거의 0 이고, 그래도 안전하다고 말하지 않는다', () => {
  const r = B.assess({ outsideTemp: 3, hour: 14, sky: 'clear' });
  assert.ok(r.bridge.probability < 0.02);
  assert.equal(r.level, 'low');
  assert.ok(r.headline.includes('안전하다는 뜻은 아닙니다'));
});

test('영하에서 비가 오면 확률이 가장 높다', () => {
  const r = B.assess({ outsideTemp: -2, hour: 23, raining: true });
  assert.ok(r.bridge.probability > 0.95 && r.road.probability > 0.8);
});

test('공기가 건조하면 서리가 덜 생겨 확률이 낮아진다', () => {
  const humid = B.assess({ outsideTemp: 1.5, hour: 5.5, sky: 'clear', humidity: 0.9, wind: 1 });
  const dry = B.assess({ outsideTemp: 1.5, hour: 5.5, sky: 'clear', humidity: 0.3, wind: 1 });
  assert.ok(dry.bridge.probability < humid.bridge.probability - 0.5);
});

test('외기 온도가 오를수록 확률은 줄어든다', () => {
  const sweep = B.sweepTemperature(dawn, [-4, -1, 1, 3, 5, 8]);
  for (let i = 1; i < sweep.length; i++) {
    assert.ok(sweep[i].bridge <= sweep[i - 1].bridge + 0.03);
    assert.ok(sweep[i].road <= sweep[i - 1].road + 0.03);
  }
  assert.ok(sweep[sweep.length - 1].bridge < 0.01);
});

test('하늘 상태를 모르면 맑을 때와 흐릴 때의 확률을 따로 알려 준다', () => {
  const r = B.assess({ outsideTemp: 1.5, ...dawn });
  assert.ok(r.bridge.byCloud.clear > r.bridge.byCloud.overcast + 0.2);
  assert.ok(r.reasons.some((t) => t.includes('하늘 상태를 몰라')));
});

test('미끄러짐 감지와 최근 강수 정보는 확률을 올린다', () => {
  const base = B.assess({ outsideTemp: 1.5, ...dawn });
  assert.ok(B.assess({ outsideTemp: 1.5, ...dawn, slipEvents: 1 }).bridge.probability > base.bridge.probability + 0.2);
  assert.ok(B.assess({ outsideTemp: 1.5, ...dawn, recentRain: true }).bridge.probability > base.bridge.probability + 0.05);
});

test('같은 입력에는 같은 결과가 나오고, 표본을 10배로 늘려도 5%p 안에서 같다', () => {
  const obs = { outsideTemp: 1.5, ...dawn };
  const a = B.assess(obs);
  const b = B.assess(obs);
  assert.equal(a.bridge.probability, b.bridge.probability);
  const big = B.assess(obs, { particles: 6000, seed: 7 });
  assert.ok(Math.abs(a.bridge.probability - big.bridge.probability) < 0.05);
  assert.ok(Math.abs(a.road.probability - big.road.probability) < 0.05);
  assert.ok(a.bridge.standardError < 0.03);
});

test('필수 입력이 없으면 추정하지 않는다', () => {
  assert.throws(() => B.assess({ hour: 5 }));
  assert.throws(() => B.assess({ outsideTemp: NaN, hour: 5 }));
});
