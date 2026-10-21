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
