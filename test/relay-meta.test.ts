import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TokenMeta, type MetaStore } from '../relay/src/meta';
import { relayMetaUrl } from '../src/stream/coin-info';

const A = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const B = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function rig(perDay = 100) {
  const data = new Map<string, unknown>();
  const store: MetaStore = { get: async (k) => data.get(k), put: async (k, v) => void data.set(k, v) };
  let now = Date.UTC(2026, 9, 21, 12);
  const asked: string[] = [];
  const answers = new Map<string, { name: string; symbol: string } | null>([[A, { name: 'Popcat', symbol: 'POPCAT' }], [B, null]]);
  const meta = new TokenMeta(store, async (m) => (asked.push(m), answers.get(m) ?? null), () => now, perDay);
  return { meta, asked, advance: (ms: number) => (now += ms) };
}

test('a ticker is asked from Helius once, then served from storage', async () => {
  const r = rig();
  assert.deepEqual(await r.meta.get(A), { status: 200, body: { name: 'Popcat', symbol: 'POPCAT' } });
  assert.deepEqual(await r.meta.get(A), { status: 200, body: { name: 'Popcat', symbol: 'POPCAT' } });
  assert.deepEqual(r.asked, [A]);
});

test('unknown coins are remembered for an hour, then asked again', async () => {
  const r = rig();
  assert.equal((await r.meta.get(B)).status, 404);
  assert.equal((await r.meta.get(B)).status, 404);
  assert.equal(r.asked.length, 1);
  r.advance(61 * 60_000);
  await r.meta.get(B);
  assert.equal(r.asked.length, 2);
});

test('nonsense is refused and new lookups are capped per day', async () => {
  const r = rig(1);
  assert.equal((await r.meta.get('not-a-mint')).status, 400);
  assert.equal((await r.meta.get(A)).status, 200);
  assert.equal((await r.meta.get(B)).status, 429, 'second new coin today: over the cap');
  assert.equal((await r.meta.get(A)).status, 200, 'cached answers are always served');
  r.advance(24 * 3_600_000);
  assert.equal((await r.meta.get(B)).status, 404, 'a new day');
});

test('the app finds the ticker route next to the relay socket', () => {
  assert.equal(relayMetaUrl('wss://slotwave-relay.x.workers.dev/ws', A), `https://slotwave-relay.x.workers.dev/token/${A}`);
  assert.equal(relayMetaUrl('ws://127.0.0.1:8787/ws', A), `http://127.0.0.1:8787/token/${A}`);
  assert.equal(relayMetaUrl('nonsense', A), null);
});
