import assert from 'node:assert/strict';
import { test } from 'node:test';
import { learnCoinPool } from '../src/audio/engine';
import type { PumpEvent } from '../src/pump/events';

const swap = (pool: string): PumpEvent => ({
  kind: 'trade', venue: 'swap', side: 'buy', token: pool, impact: 0.01, lamports: null, user: null, price: 1, quote: null, progress: null, quoteAmount: 1e8, creator: null,
});

test('one unknown PumpSwap pool in a transaction of the coin belongs to the coin', () => {
  assert.equal(learnCoinPool([swap('P1'), swap('P1')], new Map()), 'P1');
});

test('several pools in one transaction (a route through other coins) teach nothing', () => {
  assert.equal(learnCoinPool([swap('P1'), swap('P2')], new Map()), null);
});

test('known pools and curve trades are ignored', () => {
  assert.equal(learnCoinPool([swap('P1')], new Map([['P1', 'M']])), null);
  const curve: PumpEvent = { ...(swap('M') as Extract<PumpEvent, { kind: 'trade' }>), venue: 'curve' };
  assert.equal(learnCoinPool([curve], new Map()), null);
});

test('a coin still on its bonding curve learns no pool (a route through another coin pool)', () => {
  const curve: PumpEvent = { ...(swap('M') as Extract<PumpEvent, { kind: 'trade' }>), venue: 'curve' };
  assert.equal(learnCoinPool([curve, swap('OTHER')], new Map()), null, 'curve trade in the same tx');
  assert.equal(learnCoinPool([swap('OTHER')], new Map(), true), null, 'coin known to be on the curve');
});
