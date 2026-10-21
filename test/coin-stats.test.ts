import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TradeEvent } from '../src/pump/events';
import { CoinTracker, formatMarketCap } from '../src/ui/coin-stats';
import { CoinDemoStream } from '../src/stream/coin-demo';
import type { TxMessage } from '../src/stream/types';

const trade = (over: Partial<TradeEvent>): TradeEvent => ({
  kind: 'trade', venue: 'curve', side: 'buy', token: 'M', impact: 0.01, lamports: 1e8, user: 'U',
  price: 30_000_000_000 / 1_073_000_000_000_000, quote: 'sol', progress: 0, quoteAmount: 1e8, creator: null, tokenAmount: null, userTokensBefore: null, ...over,
});

test('market cap of a fresh SOL curve is about 28 SOL', () => {
  const t = new CoinTracker();
  t.add(trade({}), 0);
  const s = t.snapshot(0);
  assert.ok(Math.abs(s.marketCap! - 27.96) < 0.01, `mcap ${s.marketCap}`);
  assert.equal(s.quote, 'sol');
  assert.equal(formatMarketCap(s.marketCap, s.quote), '28.0 SOL');
  assert.equal(formatMarketCap(12_345, 'usdc'), '12.3K USDC');
});

test('change since joining, curve progress and trades per minute', () => {
  const t = new CoinTracker();
  t.add(trade({ price: 1e-6 }), 0);
  t.add(trade({ price: 1.5e-6, side: 'sell', progress: 0.42 }), 30_000);
  const s = t.snapshot(30_000);
  assert.ok(Math.abs(s.change! - 0.5) < 1e-9);
  assert.equal(s.progress, 0.42);
  assert.equal(s.buysPerMin + s.sellsPerMin, 2);
});

test('PumpSwap trades keep the quote learned on the curve and mark the coin graduated', () => {
  const t = new CoinTracker();
  t.add(trade({ quote: 'usdc' }), 0);
  t.add(trade({ venue: 'swap', quote: null, progress: null }), 1_000);
  const s = t.snapshot(1_000);
  assert.equal(s.quote, 'usdc');
  assert.equal(s.graduated, true);
});

test('the coin demo moves its price with trades and graduates when the curve is full', () => {
  const txs: TxMessage[] = [];
  const demo = new CoinDemoStream({ onTx: (t) => txs.push(t), onSlot() {}, onBytes() {}, onState() {} }, ['DemoMint']);
  const trade = (demo as unknown as { trade(index: number, side: 'buy', lamports: number): void }).trade.bind(demo);
  for (let i = 0; i < 60; i++) trade(0, 'buy', 1e9);
  const trades = txs.flatMap((t) => t.parsed.events).filter((e): e is TradeEvent => e.kind === 'trade');
  assert.ok(trades.at(-1)!.price! > trades[0]!.price!, 'buys raise the price');
  const kinds = txs.flatMap((t) => t.parsed.events.map((e) => e.kind));
  assert.ok(kinds.includes('complete') && kinds.includes('migrate'), 'the curve filled up');
});
