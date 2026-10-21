import { RUG } from '../config';
import type { TradeEvent } from '../pump/events';

export interface RugSignal {
  reason: 'dump' | 'dev' | 'crash';
  /** Short, human text, e.g. "dev sold 12 % of the pool". */
  detail: string;
}

/**
 * Watches the trades of the coins being listened to and raises an alarm when
 * one looks like a rug pull (see RUG in config). Pure, so it can be tested
 * and later shared with Rug Guard.
 */
export class RugDetector {
  private readonly prices = new Map<string, { at: number; price: number }[]>();
  private readonly lastAlarm = new Map<string, number>();

  check(coin: string, ev: TradeEvent, now: number): RugSignal | null {
    const history = this.prices.get(coin) ?? [];
    if (ev.price !== null && ev.price > 0) history.push({ at: now, price: ev.price });
    while (history.length && now - history[0]!.at > RUG.windowMs) history.shift();
    this.prices.set(coin, history);

    const signal = this.signalFor(ev, history, now);
    if (!signal) return null;
    const last = this.lastAlarm.get(coin);
    if (last !== undefined && now - last < RUG.cooldownMs) return null;
    this.lastAlarm.set(coin, now);
    return signal;
  }

  private signalFor(ev: TradeEvent, history: { at: number; price: number }[], now: number): RugSignal | null {
    if (ev.side !== 'sell') return null;
    const share = ev.impact ?? 0;
    const pct = (x: number) => Math.round(x * 100);
    if (ev.creator !== null && ev.user === ev.creator && share >= RUG.devImpact) {
      return { reason: 'dev', detail: `dev sold ${pct(share)} % of the pool` };
    }
    if (share >= RUG.dumpImpact) return { reason: 'dump', detail: `one sell took ${pct(share)} % of the pool` };
    const peak = history.reduce((best, h) => (h.price > best.price ? h : best), history[0] ?? { at: now, price: 0 });
    const current = history.at(-1)?.price ?? 0;
    if (peak.price > 0 && current > 0) {
      const drop = 1 - current / peak.price;
      if (drop >= RUG.crashDrop) return { reason: 'crash', detail: `−${pct(drop)} % in ${Math.max(1, Math.round((now - peak.at) / 1_000))} s` };
    }
    return null;
  }
}
