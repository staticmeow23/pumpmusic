import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coinPan, coinRegister } from '../src/audio/theory';
import { formatAmount, tradeLabel } from '../src/ui/labels';

test('bubble label: ticker above, signed amount below, in the coin quote', () => {
  assert.equal(tradeLabel('POPCAT', 'buy', 520_000_000, 'sol'), '$POPCAT\n+0.52 SOL');
  assert.equal(tradeLabel('POPCAT', 'sell', 12_300_000_000, 'sol'), '$POPCAT\n−12.3 SOL');
  assert.equal(tradeLabel('USDX', 'buy', 3_517_192, 'usdc'), '$USDX\n+3.52 USDC');
  assert.equal(tradeLabel(null, 'buy', null, 'sol'), null, 'nothing to say');
  assert.equal(tradeLabel('POPCAT', 'buy', null, null), '$POPCAT');
  assert.equal(formatAmount(4_000_000, 'sol'), '0.004 SOL');
  assert.equal(formatAmount(1e9, 'other'), null, 'unknown decimals: no amount');
});

test('coins get their own place in the stereo field, wallets wobble around it', () => {
  assert.equal(coinPan(0, 1, 0), coinPan(0, 1, 0));
  const a = coinPan(0, 3, 12345);
  const c = coinPan(2, 3, 12345);
  assert.ok(a < 0 && c > 0, `first coin left, last right: ${a} ${c}`);
  for (let h = 0; h < 50; h++) assert.ok(Math.abs(coinPan(1, 3, h * 7919)) <= 0.2, 'the middle coin stays near the middle');
});

test('each coin sings in its own register, the first one at home', () => {
  assert.equal(coinRegister(0), 0);
  assert.notEqual(coinRegister(1), coinRegister(2));
});
