import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coinFromHash, hashForCoin } from '../src/ui/focus';

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
