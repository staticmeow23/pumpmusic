import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RugDetector } from '../src/audio/rug';
import type { TradeEvent } from '../src/pump/events';

const DEV = 'DevWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const t = (over: Partial<TradeEvent>): TradeEvent => ({
  kind: 'trade', venue: 'curve', side: 'buy', token: 'M', impact: 0.01, lamports: 1e8, user: 'Someone', price: 1, quote: 'sol', progress: 0.5, quoteAmount: 1e8, creator: DEV, ...over,
});

test('one huge sell is a rug: a fifth of the pool or more', () => {
  const d = new RugDetector();
  assert.equal(d.check('M', t({ side: 'sell', impact: 0.12 }), 0), null, 'big, but not a rug');
  const r = d.check('M', t({ side: 'sell', impact: 0.35 }), 1_000);
  assert.equal(r?.reason, 'dump');
  assert.match(r!.detail, /35 % of the pool/);
});

test('the dev selling a real chunk is a rug, buying is not', () => {
  const d = new RugDetector();
  assert.equal(d.check('M', t({ user: DEV, side: 'buy', impact: 0.2 }), 0), null);
  assert.equal(d.check('M', t({ user: DEV, side: 'sell', impact: 0.01 }), 1_000), null, 'dev trimming a little');
  assert.equal(d.check('M', t({ user: DEV, side: 'sell', impact: 0.08 }), 2_000)?.reason, 'dev');
});

test('a crash of 40 % within a minute is a rug, even in many small sells', () => {
  const d = new RugDetector();
  let price = 1;
  let hit = null;
  for (let i = 0; i < 30 && !hit; i++) {
    price *= 0.97;
    hit = d.check('M', t({ side: 'sell', impact: 0.02, price }), i * 1_500);
  }
  assert.equal(hit?.reason, 'crash');
  assert.match(hit!.detail, /−4\d % in \d+ s/);
});

test('a slow decline over many minutes is not a crash', () => {
  const d = new RugDetector();
  let price = 1;
  for (let i = 0; i < 100; i++) {
    price *= 0.99;
    assert.equal(d.check('M', t({ side: 'sell', impact: 0.01, price }), i * 10_000), null);
  }
});

test('one alarm per coin per two minutes, coins independent', () => {
  const d = new RugDetector();
  assert.ok(d.check('M', t({ side: 'sell', impact: 0.4 }), 0));
  assert.equal(d.check('M', t({ side: 'sell', impact: 0.4 }), 60_000), null);
  assert.ok(d.check('N', t({ side: 'sell', impact: 0.4, token: 'N' }), 60_000));
  assert.ok(d.check('M', t({ side: 'sell', impact: 0.4 }), 121_000));
});
