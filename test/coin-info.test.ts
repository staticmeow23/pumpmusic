import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heliusHttpUrl, parseAsset } from '../src/stream/coin-info';

test('only Helius WebSocket endpoints map to their HTTPS twin', () => {
  assert.equal(heliusHttpUrl('wss://mainnet.helius-rpc.com/?api-key=abc'), 'https://mainnet.helius-rpc.com/?api-key=abc');
  assert.equal(heliusHttpUrl('wss://api.mainnet.solana.com'), null);
  assert.equal(heliusHttpUrl('wss://helius-rpc.com.evil.example/?api-key=abc'), null);
  assert.equal(heliusHttpUrl('not a url'), null);
});

test('asset metadata is cleaned before it reaches the screen', () => {
  const info = parseAsset({ result: { content: { metadata: { name: 'Pop\u0000cat‮', symbol: ' POPCAT ' } } } });
  assert.deepEqual(info, { name: 'Popcat', symbol: 'POPCAT' });
  assert.equal(parseAsset({ error: { message: 'nope' } }), null);
  assert.equal(parseAsset({ result: { content: { metadata: { name: 7 } } } }), null);
});
