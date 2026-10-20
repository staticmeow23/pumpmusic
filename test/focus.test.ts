import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_COINS } from '../src/config';
import { coinFromHash, coinsFromHash, hashForCoin, hashForCoins, parseCoinInput, parseCoinList } from '../src/ui/focus';

const MINT = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';

test('a shared link focuses on its coin', () => {
  assert.equal(coinFromHash(hashForCoin(MINT)), MINT);
  assert.equal(coinFromHash(`#coin=${MINT}&x=1`), MINT);
});

test('anything that is not a base58 address is ignored', () => {
  assert.equal(coinFromHash(''), null);
  assert.equal(coinFromHash('#coin='), null);
  assert.equal(coinFromHash('#coin=javascript:alert(1)'), null);
  assert.equal(coinFromHash('#coin=0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl'), null);
});

test('the CA field accepts a bare mint or a pump.fun / Solscan link', () => {
  assert.equal(parseCoinInput(`  ${MINT} `), MINT);
  assert.equal(parseCoinInput(`https://pump.fun/coin/${MINT}`), MINT);
  assert.equal(parseCoinInput(`https://solscan.io/token/${MINT}?cluster=mainnet`), MINT);
  assert.equal(parseCoinInput('hello'), null);
  assert.equal(parseCoinInput(''), null);
});

const MINT2 = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

test('several coins: separated by spaces, commas or lines, duplicates dropped, bad entries reported', () => {
  const r = parseCoinList(`${MINT}, https://pump.fun/coin/${MINT2}\n${MINT}  nonsense`);
  assert.deepEqual(r.mints, [MINT, MINT2]);
  assert.deepEqual(r.invalid, ['nonsense']);
});

test('the coin limit is enforced and reported', () => {
  const many = Array.from({ length: MAX_COINS + 2 }, (_, i) => MINT.slice(0, -2) + 'ABCDEFGHJK'[i]! + 'x').join(' ');
  const r = parseCoinList(many);
  assert.equal(r.mints.length, MAX_COINS);
  assert.equal(r.dropped, 2);
});

test('a shared link carries several coins', () => {
  assert.deepEqual(coinsFromHash(hashForCoins([MINT, MINT2])), [MINT, MINT2]);
  assert.deepEqual(coinsFromHash(`#coin=${MINT}`), [MINT], 'old single-coin links still work');
  assert.deepEqual(coinsFromHash('#coins=bad,also-bad'), []);
});
