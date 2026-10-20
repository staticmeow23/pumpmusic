import type { Quote, Side } from '../pump/events';

const DECIMALS: Record<Quote, number | null> = { sol: 9, usdc: 6, other: null };
const UNIT: Record<Quote, string> = { sol: 'SOL', usdc: 'USDC', other: '' };

/** "0.52 SOL", "12.3 SOL", "0.004 SOL"; null when the quote's decimals are unknown. */
export function formatAmount(raw: number, quote: Quote): string | null {
  const d = DECIMALS[quote];
  if (d === null) return null;
  const v = raw / 10 ** d;
  const digits = v >= 10 ? 1 : v >= 0.1 ? 2 : 3;
  return `${Number(v.toFixed(digits))} ${UNIT[quote]}`;
}

/** Bubble text in coin mode: "$POPCAT +0.52 SOL" (buy) or "$POPCAT −0.52 SOL" (sell). */
export function tradeLabel(symbol: string | null, side: Side, raw: number | null, quote: Quote | null): string | null {
  const amount = raw !== null && raw > 0 && quote ? formatAmount(raw, quote) : null;
  const name = symbol ? `$${symbol}` : null;
  if (!amount) return name;
  const signed = `${side === 'buy' ? '+' : '−'}${amount}`;
  return name ? `${name} ${signed}` : signed;
}
