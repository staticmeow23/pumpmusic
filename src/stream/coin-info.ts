import { cleanText } from '../pump/events';

export interface CoinInfo {
  name: string;
  symbol: string;
}

/**
 * Helius serves the same key over HTTPS, which gives us the DAS `getAsset`
 * call for a coin's name and ticker. Other providers: no lookup.
 */
export function heliusHttpUrl(wsUrl: string): string | null {
  try {
    const u = new URL(wsUrl);
    if (u.protocol !== 'wss:' || !(u.hostname === 'helius-rpc.com' || u.hostname.endsWith('.helius-rpc.com'))) return null;
    u.protocol = 'https:';
    return u.toString();
  } catch {
    return null;
  }
}

/** Extracts name and symbol from a getAsset response; both are attacker-chosen text. */
export function parseAsset(json: unknown): CoinInfo | null {
  const meta = (json as { result?: { content?: { metadata?: { name?: unknown; symbol?: unknown } } } } | null)?.result?.content?.metadata;
  if (!meta || typeof meta.name !== 'string' || typeof meta.symbol !== 'string') return null;
  const symbol = cleanText(meta.symbol, 12);
  return symbol ? { name: cleanText(meta.name), symbol } : null;
}

/** One getAsset call (a few credits), with a timeout. Null on any failure. */
export async function fetchCoinInfo(httpUrl: string, mint: string): Promise<CoinInfo | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6_000);
  try {
    const res = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'slotwave', method: 'getAsset', params: { id: mint } }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return parseAsset(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
