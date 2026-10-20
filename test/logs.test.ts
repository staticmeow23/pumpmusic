import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseLogs } from '../src/pump/logs';
import type { CreateEvent, PoolEvent, TradeEvent } from '../src/pump/events';
import { bytesToBase58 } from '../src/solana/encoding';

interface Fixture {
  logs: string[];
  err: unknown;
}
const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Fixture;

/**
 * expected.json was produced by an independent Python decoder driven by the
 * official IDLs (see README, "Tests"). The TS decoders must agree with it.
 */
type Expected = Record<string, { program: string; event: string; fields: Record<string, unknown> }[]>;
const expected = JSON.parse(readFileSync(new URL('./fixtures/expected.json', import.meta.url), 'utf8')) as Expected;
const expectedEvent = (file: string, name: string) => {
  const e = expected[file]?.find((x) => x.event === name);
  assert.ok(e, `no expected ${name} in ${file}`);
  return e.fields;
};

test('bonding-curve BuyV2 through a wrapper: one buy, wrapper payload ignored', () => {
  const { logs, err } = fixture('pump-buy-v2.json');
  const out = parseLogs(logs, err);
  const want = expectedEvent('pump-buy-v2.json', 'TradeEvent');

  assert.equal(out.events.length, 1);
  const t = out.events[0] as TradeEvent;
  assert.equal(t.kind, 'trade');
  assert.equal(t.venue, 'curve');
  assert.equal(t.side, 'buy');
  assert.equal(t.token, want.mint);
  // USDC-quoted coin: sol_amount is 0, size comes from quote_amount / virtual_quote_reserves.
  assert.equal(want.sol_amount, 0);
  assert.ok(t.impact !== null);
  assert.ok(Math.abs(t.impact - (want.quote_amount as number) / (want.virtual_quote_reserves as number)) < 1e-12);
  assert.equal(t.lamports, null, 'USDC trade must not be shown as SOL');
  assert.equal(out.foreignData, 1, 'the wrapper program also wrote a Program data line');
  assert.equal(out.fallbackTrades, 0);
});

test('create + first buy in one transaction', () => {
  const { logs, err } = fixture('pump-create-and-buy.json');
  const out = parseLogs(logs, err);
  const wantCreate = expectedEvent('pump-create-and-buy.json', 'CreateEvent');
  const wantTrade = expectedEvent('pump-create-and-buy.json', 'TradeEvent');

  const kinds = out.events.map((e) => e.kind);
  assert.deepEqual(kinds, ['create', 'trade']);
  const c = out.events[0] as CreateEvent;
  assert.equal(c.mint, wantCreate.mint);
  assert.equal(c.name, wantCreate.name);
  assert.equal(c.symbol, wantCreate.symbol);
  const t = out.events[1] as TradeEvent;
  assert.equal(t.lamports, wantTrade.sol_amount);
  assert.ok(Math.abs(t.impact! - (wantTrade.sol_amount as number) / (wantTrade.virtual_sol_reserves as number)) < 1e-12);
});

test('create_v2 with the newer, longer event layout', () => {
  const { logs, err } = fixture('pump-create-v2-and-buy.json');
  const out = parseLogs(logs, err);
  const wantTrade = expectedEvent('pump-create-v2-and-buy.json', 'TradeEvent');
  const t = out.events.find((e): e is TradeEvent => e.kind === 'trade');
  assert.ok(t);
  assert.equal(t.token, wantTrade.mint);
  assert.equal(t.lamports, wantTrade.sol_amount);
});

test('PumpSwap sell', () => {
  const { logs, err } = fixture('pumpswap-sell.json');
  const out = parseLogs(logs, err);
  const want = expectedEvent('pumpswap-sell.json', 'SellEvent');
  assert.equal(out.events.length, 1);
  const t = out.events[0] as TradeEvent;
  assert.equal(t.venue, 'swap');
  assert.equal(t.side, 'sell');
  assert.equal(t.token, want.pool);
  assert.ok(Math.abs(t.impact! - (want.quote_amount_out as number) / (want.pool_quote_token_reserves as number)) < 1e-12);
});

test('a TradeEvent emitted by another launchpad is not a pump trade', () => {
  const { logs, err } = fixture('foreign-trade-event.json');
  const out = parseLogs(logs, err);
  assert.equal(out.events.length, 0);
  assert.ok(out.foreignData >= 1);
});

test('forged pump discriminator from a wrapper frame is ignored', () => {
  const real = fixture('pump-buy-v2.json').logs;
  const payload = real.find((l) => l.startsWith('Program data: vdt/'))!;
  const forged = [
    'Program Evi1111111111111111111111111111111111111111 invoke [1]',
    payload,
    'Program Evi1111111111111111111111111111111111111111 success',
  ];
  const out = parseLogs(forged, null);
  assert.equal(out.events.length, 0);
  assert.equal(out.foreignData, 1);
});

test('failed transaction: no events, venue reported', () => {
  const logs = [
    'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]',
    'Program log: Instruction: Buy',
    'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P failed: custom program error: 0x1772',
  ];
  const out = parseLogs(logs, { InstructionError: [0, { Custom: 6002 }] });
  assert.equal(out.failed, true);
  assert.equal(out.failedVenue, 'curve');
  assert.equal(out.events.length, 0);
});

test('truncated logs fall back to the instruction name', () => {
  const logs = [
    'Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [1]',
    'Program log: Instruction: Sell',
    'Log truncated',
  ];
  const out = parseLogs(logs, null);
  assert.equal(out.fallbackTrades, 1);
  assert.deepEqual(out.events[0], {
    kind: 'trade', venue: 'swap', side: 'sell', token: null, impact: null, lamports: null, user: null,
  });
});

test('malformed base64 and short payloads are counted, never thrown', () => {
  const logs = [
    'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]',
    'Program data: !!!not-base64!!!',
    'Program data: vdt/007mYe4=', // TradeEvent discriminator with no body
    'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success',
  ];
  const out = parseLogs(logs, null);
  assert.equal(out.malformed, 2);
  assert.equal(out.events.length, 0);
});

test('pool event decoder reads base mint and pool', async () => {
  // Build a synthetic CreatePoolEvent body field by field (layout from the IDL).
  const { decodeProgramData } = await import('../src/pump/events');
  const key = (n: number) => new Uint8Array(32).fill(n);
  const parts: Uint8Array[] = [
    new Uint8Array([177, 49, 12, 210, 160, 118, 167, 116]),
    new Uint8Array(8), // timestamp
    new Uint8Array(2), // index
    key(1), // creator
    key(2), // base_mint
    key(3), // quote_mint
    new Uint8Array(2), // decimals
    new Uint8Array(7 * 8),
    new Uint8Array(1), // bump
    key(4), // pool
  ];
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    bytes.set(p, o);
    o += p.length;
  }
  const res = decodeProgramData('pumpSwap', bytes);
  assert.equal(res.status, 'event');
  const ev = (res as { event: PoolEvent }).event;
  assert.equal(ev.baseMint, bytesToBase58(key(2)));
  assert.equal(ev.pool, bytesToBase58(key(4)));
});
