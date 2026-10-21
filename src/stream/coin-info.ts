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

/** The relay serves tickers next to its socket: wss://host/ws -> https://host/token/<mint>. */
export function relayMetaUrl(wsUrl: string, mint: string): string | null {
  try {
    const u = new URL(wsUrl);
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null;
    return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}/token/${mint}`;
  } catch {
    return null;
  }
}

/** Name and ticker from the relay; cleaned again, the relay is just another source of text. */
export async function fetchRelayInfo(url: string): Promise<CoinInfo | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = (await res.json()) as { name?: unknown; symbol?: unknown };
    return parseAsset({ result: { content: { metadata: { name: j.name, symbol: j.symbol } } } });
  } catch {
    return null;
  }
}
