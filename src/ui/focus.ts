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
