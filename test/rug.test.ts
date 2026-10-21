import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RugDetector } from '../src/audio/rug';
import type { TradeEvent } from '../src/pump/events';

const DEV = 'DevWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const t = (over: Partial<TradeEvent>): TradeEvent => ({
  kind: 'trade', venue: 'curve', side: 'buy', token: 'M', impact: 0.01, lamports: 1e8, user: 'Someone', price: 1, quote: 'sol', progress: 0.5,
  quoteAmount: 1e8, creator: DEV, tokenAmount: 1_000, userTokensBefore: null, ...over,
});

test('only the dev selling at least half of their own tokens is a rug', () => {
  const d = new RugDetector();
  d.setDevBalance('M', DEV, 10_000);
  assert.equal(d.check('M', t({ user: DEV, side: 'sell', tokenAmount: 4_000 }), 0), null, '40 % of the bag: not yet');
  const r = d.check('M', t({ user: DEV, side: 'sell', tokenAmount: 5_000 }), 1_000); // 5,000 of the 6,000 left
  assert.equal(r?.reason, 'dev');
  assert.match(r!.detail, /dev sold 83 % of their tokens/);
});

test('huge sells by anyone else never ring the alarm', () => {
  const d = new RugDetector();
  d.setDevBalance('M', DEV, 10_000);
  assert.equal(d.check('M', t({ side: 'sell', impact: 0.9, tokenAmount: 9e9 }), 0), null);
});

test('the dev balance is followed through their buys and sells', () => {
  const d = new RugDetector();
  d.noteCreate('M', DEV); // created while we listen: the dev starts with nothing
  d.check('M', t({ user: DEV, side: 'buy', tokenAmount: 8_000 }), 0);
  d.check('M', t({ user: DEV, side: 'sell', tokenAmount: 1_000 }), 1_000); // 12.5 %
  assert.equal(d.check('M', t({ user: DEV, side: 'sell', tokenAmount: 3_000 }), 2_000), null, '3,000 of 7,000 = 43 %');
  assert.equal(d.check('M', t({ user: DEV, side: 'sell', tokenAmount: 4_000 }), 3_000)?.reason, 'dev', 'the whole rest');
});

test('without a known balance there is no alarm, and the detector asks for one once', () => {
  const d = new RugDetector();
  assert.equal(d.check('M', t({ user: DEV, side: 'sell', tokenAmount: 1e12 }), 0), null);
  assert.deepEqual(d.needsBalance('M'), { creator: DEV });
  assert.equal(d.needsBalance('M'), null, 'asked once');
});

test('PumpSwap sells carry the balance before the sell: no lookup needed', () => {
  const d = new RugDetector();
  const r = d.check('M', t({ venue: 'swap', user: DEV, side: 'sell', tokenAmount: 1_167, userTokensBefore: 1_167 }), 0);
  assert.equal(r?.reason, 'dev');
  assert.match(r!.detail, /100 %/);
});

test('one alarm per coin per two minutes', () => {
  const d = new RugDetector();
  d.setDevBalance('M', DEV, 100_000);
  assert.ok(d.check('M', t({ user: DEV, side: 'sell', tokenAmount: 60_000 }), 0));
  d.setDevBalance('M', DEV, 100_000);
  assert.equal(d.check('M', t({ user: DEV, side: 'sell', tokenAmount: 60_000 }), 60_000), null);
});
