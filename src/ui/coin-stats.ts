import { TOKEN_SUPPLY_RAW } from '../config';
import type { Quote, TradeEvent } from '../pump/events';
import { formatCompact } from './metrics';

const QUOTE_DECIMALS: Record<Quote, number | null> = { sol: 9, usdc: 6, other: null };

export interface CoinSnapshot {
  /** Market cap in whole quote units (SOL or USDC); null until a priced trade arrives. */
  marketCap: number | null;
  quote: Quote | null;
  /** Price change since the first trade we heard, e.g. 0.5 = +50 %. */
  change: number | null;
  /** Bonding curve progress 0..1, null once graduated or unknown. */
  progress: number | null;
  graduated: boolean;
  buysPerMin: number;
  sellsPerMin: number;
}

/** Running figures for the one coin being listened to. */
export class CoinTracker {
  private firstPrice: number | null = null;
  private lastPrice: number | null = null;
  private quote: Quote | null = null;
  private progress: number | null = null;
  private graduated = false;
  private trades: { at: number; side: 'buy' | 'sell' }[] = [];

  add(ev: TradeEvent, now: number): void {
    this.trades.push({ at: now, side: ev.side });
    if (ev.quote) this.quote = ev.quote;
    if (ev.venue === 'swap') {
      this.graduated = true;
      this.progress = null;
    } else if (ev.progress !== null) {
      this.progress = ev.progress;
    }
    if (ev.price !== null && ev.price > 0) {
      this.firstPrice ??= ev.price;
      this.lastPrice = ev.price;
    }
  }

  markGraduated(): void {
    this.graduated = true;
    this.progress = null;
  }

  snapshot(now: number): CoinSnapshot {
    while (this.trades.length && now - this.trades[0]!.at > 60_000) this.trades.shift();
    const buys = this.trades.filter((t) => t.side === 'buy').length;
    // PumpSwap events don't name the quote; pump coins graduate into SOL pools unless we saw otherwise.
    const quote = this.quote ?? (this.graduated ? 'sol' : null);
    const decimals = quote ? QUOTE_DECIMALS[quote] : null;
    const marketCap =
      this.lastPrice !== null && decimals !== null ? (this.lastPrice * TOKEN_SUPPLY_RAW) / 10 ** decimals : null;
    return {
      marketCap,
      quote,
      change: this.firstPrice !== null && this.lastPrice !== null ? this.lastPrice / this.firstPrice - 1 : null,
      progress: this.graduated ? null : this.progress,
      graduated: this.graduated,
      buysPerMin: buys,
      sellsPerMin: this.trades.length - buys,
    };
  }
}

export function formatMarketCap(value: number | null, quote: Quote | null): string {
  if (value === null) return '–';
  const unit = quote === 'usdc' ? 'USDC' : quote === 'sol' ? 'SOL' : '';
  const n = value < 1_000 ? value.toFixed(1) : formatCompact(value);
  return unit ? `${n} ${unit}` : n;
}

export function formatChange(change: number | null): string {
  if (change === null) return '–';
  const pct = change * 100;
  return `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)} %`;
}

