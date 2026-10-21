import { DISCRIMINATORS, INITIAL_REAL_TOKEN_RESERVES, SYSTEM_PROGRAM, USDC_MINT, WSOL_MINT } from '../config';
import { BorshReader, EndOfData } from '../solana/borsh';

/**
 * Normalised events. Everything the music and the UI need, nothing else.
 * `token` identifies the coin for voice selection: the mint on the bonding
 * curve, the pool address on PumpSwap (BuyEvent/SellEvent carry no mint).
 */
export type Venue = 'curve' | 'swap';
export type Side = 'buy' | 'sell';

export interface TradeEvent {
  kind: 'trade';
  venue: Venue;
  side: Side;
  /** Mint (curve) or pool (swap). Null when only the instruction name was readable. */
  token: string | null;
  /** Trade size as a share of the quote-side reserves (0.01 = 1 %). Null if unknown. */
  impact: number | null;
  /** Lamports, only when the trade is known to be quoted in SOL. */
  lamports: number | null;
  user: string | null;
  /** Raw quote units per raw token unit (curve: virtual reserves, swap: pool reserves). */
  price: number | null;
  /** Quote currency when the event says so; PumpSwap events don't. */
  quote: Quote | null;
  /** Bonding curve progress 0..1 from the real token reserves; null on PumpSwap. */
  progress: number | null;
  /** Trade size in raw quote units (lamports for SOL); on PumpSwap the quote mint is unknown here. */
  quoteAmount: number | null;
  /** The coin's creator (curve: creator, PumpSwap: coin_creator); a sell by them is a dev dump. */
  creator: string | null;
  /** Raw base tokens bought or sold. */
  tokenAmount: number | null;
  /** The trader's raw token balance before the trade; only PumpSwap events carry it. */
  userTokensBefore: number | null;
}

export type Quote = 'sol' | 'usdc' | 'other';

export interface CreateEvent {
  kind: 'create';
  mint: string;
  name: string;
  symbol: string;
  creator: string;
}

/** Bonding curve filled up: the coin is about to graduate. */
export interface CompleteEvent {
  kind: 'complete';
  mint: string;
}

/** Liquidity moved from the curve into a PumpSwap pool. */
export interface MigrateEvent {
  kind: 'migrate';
  mint: string;
  pool: string;
  lamports: number;
}

/** New PumpSwap pool. Lets us map pool -> mint so a coin keeps its voice after graduating. */
export interface PoolEvent {
  kind: 'pool';
  pool: string;
  baseMint: string;
  quoteMint: string;
}

export type PumpEvent = TradeEvent | CreateEvent | CompleteEvent | MigrateEvent | PoolEvent;

/** Removes control characters and caps length: names and symbols are attacker-chosen. */
export function cleanText(value: string, max = 32): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮]/g, '').trim().slice(0, max);
}

function matches(bytes: Uint8Array, disc: readonly number[]): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== disc[i]) return false;
  return true;
}

function ratio(amount: number, reserves: number): number | null {
  if (!(reserves > 0) || !(amount >= 0)) return null;
  return amount / reserves;
}

const isSolQuote = (mint: string | null) => mint === SYSTEM_PROGRAM || mint === WSOL_MINT;

/**
 * pump.fun TradeEvent. The first eight fields have existed since launch; later
 * fields were appended over time and real events can stop at any of them, so
 * everything after the prefix is read best-effort.
 */
export function decodeCurveTrade(body: Uint8Array): TradeEvent {
  const r = new BorshReader(body);
  const mint = r.pubkey();
  const solAmount = r.u64();
  const tokenAmount = r.u64();
  const isBuy = r.bool();
  const user = r.pubkey();
  r.i64(); // timestamp
  const virtualSolReserves = r.u64();
  const virtualTokenReserves = r.u64();

  let quoteMint: string | null = null;
  let quoteAmount: number | null = null;
  let virtualQuoteReserves: number | null = null;
  let realTokenReserves: number | null = null;
  let creator: string | null = null;
  try {
    r.u64(); // real_sol_reserves
    realTokenReserves = r.u64();
    r.skip(32 + 8 + 8); // fee_recipient, fee_basis_points, fee
    creator = r.pubkey();
    r.skip(8 + 8); // creator_fee_basis_points, creator_fee
    r.skip(1 + 8 + 8 + 8 + 8); // track_volume .. last_update_timestamp
    r.string(64); // ix_name
    r.skip(1 + 8 + 8 + 8 + 8); // mayhem_mode, cashback_*, buyback_*
    const shareholders = r.u32();
    if (shareholders > 1_000) throw new EndOfData();
    r.skip(shareholders * 34); // Shareholder = pubkey + u16
    quoteMint = r.pubkey();
    quoteAmount = r.u64();
    virtualQuoteReserves = r.u64();
  } catch (e) {
    if (!(e instanceof EndOfData)) throw e;
  }

  // SOL-paired coins fill sol_amount; coins quoted in another mint (e.g. USDC)
  // leave it at 0 and use quote_amount instead.
  let impact: number | null;
  let lamports: number | null = null;
  if (solAmount > 0) {
    impact = ratio(solAmount, virtualSolReserves);
    lamports = solAmount;
  } else if (quoteAmount !== null && virtualQuoteReserves !== null) {
    impact = ratio(quoteAmount, virtualQuoteReserves);
    if (isSolQuote(quoteMint)) lamports = quoteAmount;
  } else {
    impact = ratio(solAmount, virtualSolReserves);
  }

  const quoteReserves = virtualSolReserves > 0 ? virtualSolReserves : virtualQuoteReserves;
  const price = quoteReserves !== null ? ratio(quoteReserves, virtualTokenReserves) : null;
  const quote: Quote | null =
    solAmount > 0 || virtualSolReserves > 0 || isSolQuote(quoteMint) ? 'sol'
    : quoteMint === USDC_MINT ? 'usdc'
    : quoteMint !== null ? 'other'
    : null;
  const progress = realTokenReserves === null ? null : Math.min(1, Math.max(0, 1 - realTokenReserves / INITIAL_REAL_TOKEN_RESERVES));

  const size = solAmount > 0 ? solAmount : quoteAmount;
  return { kind: 'trade', venue: 'curve', side: isBuy ? 'buy' : 'sell', token: mint, impact, lamports, user, price, quote, progress, quoteAmount: size, creator, tokenAmount, userTokensBefore: null };
}

export function decodeCreate(body: Uint8Array): CreateEvent {
  const r = new BorshReader(body);
  const name = cleanText(r.string(200));
  const symbol = cleanText(r.string(50), 12);
  r.string(400); // uri
  const mint = r.pubkey();
  r.pubkey(); // bonding_curve
  r.pubkey(); // user
  const creator = r.pubkey();
  return { kind: 'create', mint, name, symbol, creator };
}

export function decodeComplete(body: Uint8Array): CompleteEvent {
  const r = new BorshReader(body);
  r.pubkey(); // user
  return { kind: 'complete', mint: r.pubkey() };
}

export function decodeMigration(body: Uint8Array): MigrateEvent {
  const r = new BorshReader(body);
  r.pubkey(); // user
  const mint = r.pubkey();
  r.u64(); // mint_amount
  const lamports = r.u64();
  r.u64(); // pool_migration_fee
  r.pubkey(); // bonding_curve
  r.i64(); // timestamp
  const pool = r.pubkey();
  return { kind: 'migrate', mint, pool, lamports };
}

/**
 * PumpSwap BuyEvent / SellEvent share a fixed 112-byte prefix of one i64 and
 * thirteen u64 fields, followed by pool and user. Newer events go on with four
 * token accounts and the coin creator (read best-effort).
 */
export function decodeSwapTrade(body: Uint8Array, side: Side): TradeEvent {
  const r = new BorshReader(body);
  r.i64(); // timestamp
  const baseAmount = r.u64(); // base_amount_out | base_amount_in
  r.u64(); // max_quote_amount_in | min_quote_amount_out
  const userBaseBefore = r.u64(); // user_base_token_reserves
  r.u64(); // user_quote_token_reserves
  const poolBaseReserves = r.u64();
  const poolQuoteReserves = r.u64();
  const quoteAmount = r.u64(); // quote_amount_in | quote_amount_out
  r.skip(6 * 8); // fees and the two user-side quote amounts
  const pool = r.pubkey();
  const user = r.pubkey();
  let creator: string | null = null;
  try {
    r.skip(4 * 32); // user base/quote token accounts, protocol fee recipient and its token account
    creator = r.pubkey(); // coin_creator
  } catch (e) {
    if (!(e instanceof EndOfData)) throw e;
  }
  return {
    kind: 'trade',
    venue: 'swap',
    side,
    token: pool,
    impact: ratio(quoteAmount, poolQuoteReserves),
    lamports: null, // the event does not say which mint the pool is quoted in
    user,
    price: ratio(poolQuoteReserves, poolBaseReserves),
    quote: null,
    progress: null,
    quoteAmount,
    creator,
    tokenAmount: baseAmount,
    userTokensBefore: userBaseBefore,
  };
}

export function decodePoolCreated(body: Uint8Array): PoolEvent {
  const r = new BorshReader(body);
  r.i64(); // timestamp
  r.u16(); // index
  r.pubkey(); // creator
  const baseMint = r.pubkey();
  const quoteMint = r.pubkey();
  r.u8(); // base_mint_decimals
  r.u8(); // quote_mint_decimals
  r.skip(7 * 8); // amounts
  r.u8(); // pool_bump
  const pool = r.pubkey();
  return { kind: 'pool', pool, baseMint, quoteMint };
}

/** Result of looking at one `Program data:` payload from a known program. */
export type DecodeResult =
  | { status: 'event'; event: PumpEvent }
  | { status: 'ignored' } // a known event we don't sonify (fees, admin, ...)
  | { status: 'malformed' };

export function decodeProgramData(program: 'pumpCurve' | 'pumpSwap', bytes: Uint8Array): DecodeResult {
  const body = bytes.subarray(8);
  try {
    if (program === 'pumpCurve') {
      const d = DISCRIMINATORS.pumpCurve;
      if (matches(bytes, d.TradeEvent)) return { status: 'event', event: decodeCurveTrade(body) };
      if (matches(bytes, d.CreateEvent)) return { status: 'event', event: decodeCreate(body) };
      if (matches(bytes, d.CompleteEvent)) return { status: 'event', event: decodeComplete(body) };
      if (matches(bytes, d.CompletePumpAmmMigrationEvent)) return { status: 'event', event: decodeMigration(body) };
    } else {
      const d = DISCRIMINATORS.pumpSwap;
      if (matches(bytes, d.BuyEvent)) return { status: 'event', event: decodeSwapTrade(body, 'buy') };
      if (matches(bytes, d.SellEvent)) return { status: 'event', event: decodeSwapTrade(body, 'sell') };
      if (matches(bytes, d.CreatePoolEvent)) return { status: 'event', event: decodePoolCreated(body) };
    }
    return { status: 'ignored' };
  } catch (e) {
    if (e instanceof EndOfData) return { status: 'malformed' };
    throw e;
  }
}
