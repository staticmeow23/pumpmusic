import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base64ToBytes, bytesToBase58, hash32, isBase58Address } from '../src/solana/encoding';

test('base58 known vectors', () => {
  assert.equal(bytesToBase58(new Uint8Array(32)), '11111111111111111111111111111111');
  assert.equal(bytesToBase58(new Uint8Array([0, 0, 1])), '112');
  assert.equal(bytesToBase58(new TextEncoder().encode('hello world')), 'StV1DL6CwTryKyV');
});

test('address check rejects junk and accepts real program IDs', () => {
  assert.ok(isBase58Address('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'));
  assert.ok(!isBase58Address('javascript:alert(1)'));
  assert.ok(!isBase58Address('0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl'));
});

test('base64 returns null instead of throwing', () => {
  assert.deepEqual(base64ToBytes('AQID'), new Uint8Array([1, 2, 3]));
  assert.equal(base64ToBytes('%%%'), null);
});

test('hash32 is stable', () => {
  assert.equal(hash32('abc'), hash32('abc'));
  assert.notEqual(hash32('abc'), hash32('abd'));
});
