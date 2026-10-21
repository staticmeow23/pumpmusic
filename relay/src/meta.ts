import type { CoinInfo } from '../../src/stream/coin-info';

/** The bit of Durable Object storage this needs (and the tests fake). */
export interface MetaStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MISSING_RETRY_MS = 60 * 60_000;

type Stored = { name: string; symbol: string } | { missing: true; at: number };

export interface MetaResult {
  status: 200 | 400 | 404 | 429 | 502;
  body: CoinInfo | { error: string };
}

/**
 * Coin names and tickers for every listener: one Helius getAsset per coin,
 * kept forever (a coin's ticker never changes). Unknown coins are retried
 * after an hour. New lookups are capped per UTC day, so asking for random
 * addresses can't burn the API credits.
 */
export class TokenMeta {
  private day = '';
  private lookups = 0;

  constructor(
    private readonly store: MetaStore,
    private readonly lookup: (mint: string) => Promise<CoinInfo | null>,
    private readonly now: () => number,
    private readonly perDay = 2_000,
  ) {}

  async get(mint: string): Promise<MetaResult> {
    if (!B58.test(mint)) return { status: 400, body: { error: 'not a mint address' } };
    const key = `meta:${mint}`;
    const cached = (await this.store.get(key)) as Stored | undefined;
    if (cached && !('missing' in cached)) return { status: 200, body: { name: cached.name, symbol: cached.symbol } };
    if (cached && this.now() - cached.at < MISSING_RETRY_MS) return { status: 404, body: { error: 'unknown coin' } };

    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.lookups = 0;
    }
    if (this.lookups >= this.perDay) return { status: 429, body: { error: 'too many new coins today' } };
    this.lookups++;

    const info = await this.lookup(mint).catch(() => undefined);
    if (info === undefined) return { status: 502, body: { error: 'lookup failed' } };
    if (info === null) {
      await this.store.put(key, { missing: true, at: this.now() } satisfies Stored);
      return { status: 404, body: { error: 'unknown coin' } };
    }
    await this.store.put(key, { name: info.name, symbol: info.symbol } satisfies Stored);
    return { status: 200, body: info };
  }
}

export interface HoldingResult {
  status: 200 | 400 | 429 | 502;
  body: { amount: number } | { error: string };
}

const HOLDING_CACHE_MS = 20_000;

/**
 * How many tokens of a coin a wallet holds (the app asks for the dev's, to
 * tell a rug from a trim). Answers are kept 20 s; new lookups are capped per
 * UTC day so the route can't be used to burn credits.
 */
export class TokenHoldings {
  private readonly cache = new Map<string, { at: number; amount: number }>();
  private day = '';
  private lookups = 0;

  constructor(
    private readonly lookup: (owner: string, mint: string) => Promise<number | null>,
    private readonly now: () => number,
    private readonly perDay = 5_000,
  ) {}

  async get(owner: string, mint: string): Promise<HoldingResult> {
    if (!B58.test(owner) || !B58.test(mint)) return { status: 400, body: { error: 'not an address' } };
    const key = `${owner}/${mint}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < HOLDING_CACHE_MS) return { status: 200, body: { amount: hit.amount } };

    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.lookups = 0;
    }
    if (this.lookups >= this.perDay) return { status: 429, body: { error: 'too many lookups today' } };
    this.lookups++;

    const amount = await this.lookup(owner, mint).catch(() => null);
    if (amount === null) return { status: 502, body: { error: 'lookup failed' } };
    this.cache.set(key, { at: this.now(), amount });
    if (this.cache.size > 1_000) this.cache.delete(this.cache.keys().next().value!);
    return { status: 200, body: { amount } };
  }
}
