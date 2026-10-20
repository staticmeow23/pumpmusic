import { MAX_COINS } from '../config';
import { isBase58Address } from '../solana/encoding';

/** Reads the coin from a shared link like `#coin=<mint>`; anything else yields null. */
export function coinFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const coin = params.get('coin');
  return coin && isBase58Address(coin) ? coin : null;
}

export function hashForCoin(coin: string): string {
  return `#coin=${coin}`;
}

/** What people paste: a bare CA, or a pump.fun / Solscan / Dexscreener link that ends in one. */
export function parseCoinInput(text: string): string | null {
  const t = text.trim();
  if (isBase58Address(t)) return t;
  try {
    const u = new URL(t);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    return isBase58Address(last) ? last : null;
  } catch {
    return null;
  }
}

export interface CoinList {
  mints: string[];
  /** Entries that are neither a CA nor a link ending in one. */
  invalid: string[];
  /** Valid coins beyond MAX_COINS. */
  dropped: number;
}

/** Several coins at once: separated by spaces, commas, semicolons or new lines. */
export function parseCoinList(text: string): CoinList {
  const mints: string[] = [];
  const invalid: string[] = [];
  let dropped = 0;
  for (const part of text.split(/[\s,;]+/).filter(Boolean)) {
    const mint = parseCoinInput(part);
    if (!mint) invalid.push(part.length > 24 ? `${part.slice(0, 24)}…` : part);
    else if (mints.includes(mint)) continue;
    else if (mints.length >= MAX_COINS) dropped++;
    else mints.push(mint);
  }
  return { mints, invalid, dropped };
}

/** `#coins=A,B` (and the older `#coin=A`); invalid entries are skipped. */
export function coinsFromHash(hash: string): string[] {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const raw = params.get('coins') ?? params.get('coin') ?? '';
  return parseCoinList(raw).mints;
}

export function hashForCoins(mints: readonly string[]): string {
  return `#coins=${mints.join(',')}`;
}
