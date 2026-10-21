import { RUG } from '../config';
import type { TradeEvent } from '../pump/events';

export interface RugSignal {
  reason: 'dev';
  /** Short, human text, e.g. "dev sold 83 % of their tokens". */
  detail: string;
}

interface Dev {
  creator: string;
  /** Raw tokens the dev holds, as far as we know; null = unknown. */
  balance: number | null;
  asked: boolean;
}

/**
 * Raises the rug alarm when a coin's creator sells at least RUG.devSellShare
 * of their own tokens in one trade. To know the share it follows the dev's
 * balance: zero for a coin created while we listen, the balance PumpSwap
 * events report, or a one-off lookup (needsBalance -> setDevBalance), then
 * every buy and sell by the dev. Tokens moved to other wallets first are
 * invisible to it. Pure, so it can be tested and shared with Rug Guard.
 */
export class RugDetector {
  private readonly devs = new Map<string, Dev>();
  private readonly lastAlarm = new Map<string, number>();

  /** The coin was created while we listen: its dev starts with nothing. */
  noteCreate(coin: string, creator: string): void {
    this.devs.set(coin, { creator, balance: 0, asked: true });
  }

  setDevBalance(coin: string, creator: string, balance: number): void {
    this.devs.set(coin, { creator, balance, asked: true });
  }

  /** Once per coin, when its dev is known but their balance isn't: who to look up. */
  needsBalance(coin: string): { creator: string } | null {
    const dev = this.devs.get(coin);
    if (!dev || dev.balance !== null || dev.asked) return null;
    dev.asked = true;
    return { creator: dev.creator };
  }

  check(coin: string, ev: TradeEvent, now: number): RugSignal | null {
    let dev = this.devs.get(coin);
    if (!dev && ev.creator) {
      dev = { creator: ev.creator, balance: null, asked: false };
      this.devs.set(coin, dev);
    }
    if (!dev || ev.user !== dev.creator || ev.tokenAmount === null) return null;

    // PumpSwap tells us the balance before the trade; otherwise use what we followed.
    const before = ev.userTokensBefore ?? dev.balance;
    if (before !== null) dev.balance = Math.max(0, before + (ev.side === 'buy' ? ev.tokenAmount : -ev.tokenAmount));
    if (ev.side !== 'sell' || before === null || before <= 0) return null;

    const share = Math.min(1, ev.tokenAmount / before);
    if (share < RUG.devSellShare) return null;
    const last = this.lastAlarm.get(coin);
    if (last !== undefined && now - last < RUG.cooldownMs) return null;
    this.lastAlarm.set(coin, now);
    return { reason: 'dev', detail: `dev sold ${Math.round(share * 100)} % of their tokens` };
  }
}
