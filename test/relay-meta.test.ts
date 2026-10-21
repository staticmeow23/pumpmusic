import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TokenHoldings, TokenMeta, type MetaStore } from '../relay/src/meta';
import { parseTokenBalance, relayHoldingUrl, relayMetaUrl } from '../src/stream/coin-info';

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

test('a token balance is the sum over all the owner token accounts for that mint', () => {
  const acct = (amount: string) => ({ account: { data: { parsed: { info: { tokenAmount: { amount } } } } } });
  assert.equal(parseTokenBalance({ result: { value: [acct('1500'), acct('500')] } }), 2_000);
  assert.equal(parseTokenBalance({ result: { value: [] } }), 0, 'no account: holds nothing');
  assert.equal(parseTokenBalance({ error: { message: 'x' } }), null);
  assert.equal(parseTokenBalance({ result: { value: [{ account: {} }] } }), null, 'unexpected shape: unknown, not zero');
});

test('the app finds the holdings route next to the relay socket', () => {
  assert.equal(relayHoldingUrl('wss://r.x.workers.dev/ws', B, A), `https://r.x.workers.dev/holding/${B}/${A}`);
});

test('holdings: cached briefly, nonsense refused, new lookups capped per day', async () => {
  let now = Date.UTC(2026, 9, 21, 12);
  const asked: string[] = [];
  const h = new TokenHoldings(async (owner, mint) => (asked.push(`${owner}/${mint}`), 42), () => now, 2);
  assert.deepEqual(await h.get(B, A), { status: 200, body: { amount: 42 } });
  assert.deepEqual(await h.get(B, A), { status: 200, body: { amount: 42 } });
  assert.equal(asked.length, 1, 'second answer from the cache');
  now += 30_000;
  await h.get(B, A);
  assert.equal(asked.length, 2, 'stale after 20 s');
  assert.equal((await h.get('bad', A)).status, 400);
  assert.equal((await h.get(A, B)).status, 429, 'third lookup today');
});
