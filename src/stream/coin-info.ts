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

/** Any WebSocket RPC endpoint has an HTTP twin on the same host and path. */
export function httpUrlFor(wsUrl: string): string | null {
  try {
    const u = new URL(wsUrl);
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null;
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    return u.toString();
  } catch {
    return null;
  }
}

/** Sum of the raw amounts in a jsonParsed getTokenAccountsByOwner answer; null if it isn't one. */
export function parseTokenBalance(json: unknown): number | null {
  const value = (json as { result?: { value?: unknown } } | null)?.result?.value;
  if (!Array.isArray(value)) return null;
  let total = 0;
  for (const item of value) {
    const amount = (item as { account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: unknown } } } } } })?.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (typeof amount !== 'string' || !/^\d+$/.test(amount)) return null;
    total += Number(amount);
  }
  return total;
}

/** A wallet's raw balance of one token (standard RPC, all token programs). Null on any failure. */
export async function fetchTokenBalance(httpUrl: string, owner: string, mint: string): Promise<number | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6_000);
  try {
    const res = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'slotwave', method: 'getTokenAccountsByOwner', params: [owner, { mint }, { encoding: 'jsonParsed', commitment: 'processed' }] }),
      signal: ctrl.signal,
    });
    return res.ok ? parseTokenBalance(await res.json()) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** wss://host/ws -> https://host/holding/<owner>/<mint> */
export function relayHoldingUrl(wsUrl: string, owner: string, mint: string): string | null {
  const meta = relayMetaUrl(wsUrl, mint);
  return meta ? meta.replace(/\/token\/[^/]+$/, `/holding/${owner}/${mint}`) : null;
}

/** The dev's balance from the relay. */
export async function fetchRelayHolding(url: string): Promise<number | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const amount = ((await res.json()) as { amount?: unknown }).amount;
    return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? amount : null;
  } catch {
    return null;
  }
}
