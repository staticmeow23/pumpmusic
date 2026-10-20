import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateWindow, estimateCost, formatBytes } from '../src/ui/metrics';
import { RecentSet } from '../src/stream/dedupe';
import { maskEndpoint, isValidWsUrl } from '../src/stream/rpc-stream';

test('rate window averages full seconds and forgets old ones', () => {
  const r = new RateWindow(10);
  for (let s = 0; s < 5; s++) r.add(4, s * 1_000 + 500);
  assert.equal(r.perSecond(5_100, 4), 4);
  // 20 s of silence later everything has expired.
  assert.equal(r.perSecond(25_000), 0);
});

test('cost estimate matches the Helius formula', () => {
  // 10 KB/s -> 864 MB/day -> 25.92 GB/month -> 259,200 x 0.1 MB -> 518,400 credits.
  const c = estimateCost(10_000);
  assert.ok(Math.abs(c.gbPerDay - 0.864) < 1e-9);
  assert.ok(Math.abs(c.heliusCreditsPerMonth - 518_400) < 1e-6);
  assert.ok(Math.abs(c.freePlanShare - 0.5184) < 1e-9);
  assert.equal(formatBytes(1_500), '1.5 KB');
});

test('dedupe evicts the oldest entry', () => {
  const s = new RecentSet(2);
  assert.ok(s.add('a'));
  assert.ok(!s.add('a'));
  s.add('b');
  s.add('c');
  assert.ok(s.add('a'), 'a was evicted, so it counts as new again');
});

test('API keys never show up in the displayed endpoint', () => {
  assert.equal(maskEndpoint('wss://api.mainnet-beta.solana.com'), 'wss://api.mainnet-beta.solana.com');
  const helius = maskEndpoint('wss://mainnet.helius-rpc.com/?api-key=SECRET123');
  assert.ok(!helius.includes('SECRET123'));
  const qn = maskEndpoint('wss://x.solana-mainnet.quiknode.pro/SECRETTOKEN/');
  assert.ok(!qn.includes('SECRETTOKEN'));
  assert.ok(isValidWsUrl('wss://a.b'));
  assert.ok(!isValidWsUrl('https://a.b'));
  assert.ok(!isValidWsUrl('javascript:alert(1)'));
});
