import { HELIUS_CREDITS_PER_100KB, HELIUS_FREE_MONTHLY_CREDITS } from '../config';

/** Sums values in one-second buckets over a sliding window. */
export class RateWindow {
  private readonly buckets: number[];
  private headSecond = -1;
  private firstSecond = -1;

  constructor(private readonly seconds = 60) {
    this.buckets = new Array<number>(seconds).fill(0);
  }

  private advance(nowMs: number): number {
    const sec = Math.floor(nowMs / 1_000);
    if (this.headSecond < 0) {
      this.headSecond = sec;
      this.firstSecond = sec;
    }
    const steps = Math.min(this.seconds, sec - this.headSecond);
    for (let i = 1; i <= steps; i++) this.buckets[(this.headSecond + i) % this.seconds] = 0;
    if (sec > this.headSecond) this.headSecond = sec;
    return sec;
  }

  add(value: number, nowMs: number): void {
    const sec = this.advance(nowMs);
    this.buckets[sec % this.seconds]! += value;
  }

  /** Average per second over the last `window` full seconds (current second excluded). */
  perSecond(nowMs: number, window = this.seconds - 1): number {
    const sec = this.advance(nowMs);
    // Right after start, divide by the seconds that exist, not the whole window.
    const w = Math.max(1, Math.min(window, this.seconds - 1, sec - this.firstSecond));
    let sum = 0;
    for (let i = 1; i <= w; i++) sum += this.buckets[(sec - i + this.seconds * 2) % this.seconds]!;
    return sum / w;
  }
}

export interface CostEstimate {
  bytesPerSecond: number;
  gbPerDay: number;
  /** Credits per month if the same stream ran through one Helius connection. */
  heliusCreditsPerMonth: number;
  /** Share of the Helius free plan that stream would use (1 = 100 %). */
  freePlanShare: number;
}

/**
 * What would this exact data volume cost on Helius? Assumes one server
 * connection relaying to all listeners (bytes don't grow with listeners).
 * 0.1 MB is taken as 100,000 bytes; treat the result as an estimate.
 */
export function estimateCost(bytesPerSecond: number): CostEstimate {
  const perDay = bytesPerSecond * 86_400;
  const perMonth = perDay * 30;
  const credits = (perMonth / 100_000) * HELIUS_CREDITS_PER_100KB;
  return {
    bytesPerSecond,
    gbPerDay: perDay / 1e9,
    heliusCreditsPerMonth: credits,
    freePlanShare: credits / HELIUS_FREE_MONTHLY_CREDITS,
  };
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${Math.round(n)} B`;
}

export function formatCompact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(n < 10 && n % 1 !== 0 ? 1 : 0);
}
