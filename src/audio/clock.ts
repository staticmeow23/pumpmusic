import { NOMINAL_SLOT_MS } from '../config';

/**
 * Maps Solana slot numbers onto local time (performance.now() milliseconds).
 *
 * Every message tells us "slot S was seen at local time t". Network jitter
 * makes single samples noisy, so we fit a line t = a + b * S over the last
 * minute of slots (least squares). b is the measured slot duration, which
 * makes the tempo follow the real network instead of a hard-coded 200 ms.
 * The music then plays slot S at timeOf(S) + buffer, so notes keep their
 * on-chain order and spacing even though they arrive irregularly.
 */
export class SlotClock {
  /** First arrival per slot (a later duplicate says nothing new). */
  private readonly samples = new Map<number, number>();
  private fitA = 0;
  private fitB = NOMINAL_SLOT_MS;
  private refSlot = 0;
  private fitted = false;
  private dirty = false;

  constructor(
    private readonly windowSlots = 300,
    private readonly minMs = 120,
    private readonly maxMs = 600,
  ) {}

  observe(slot: number, atMs: number): void {
    if (!Number.isFinite(slot) || !Number.isFinite(atMs)) return;
    const prev = this.samples.get(slot);
    if (prev !== undefined && prev <= atMs) return;
    // A jump of more than ~30 s against the prediction means a different
    // endpoint, a lagging node or a long pause: start over instead of bending
    // the fit (which would stretch the tempo for a minute).
    if (prev === undefined && this.samples.size >= 10 && Math.abs(slot - this.slotAt(atMs)) > 150) this.reset();
    this.samples.set(slot, atMs);
    this.dirty = true;
    // Bound memory: drop samples older than the window.
    if (this.samples.size > this.windowSlots * 1.5) {
      const newest = this.newestSlot();
      for (const s of this.samples.keys()) if (s < newest - this.windowSlots) this.samples.delete(s);
    }
  }

  reset(): void {
    this.samples.clear();
    this.fitted = false;
    this.dirty = false;
    this.fitB = NOMINAL_SLOT_MS;
    this.resets++;
  }

  /** How often the clock had to start over (shown in the stats). */
  resets = 0;

  private newestSlot(): number {
    let n = -Infinity;
    for (const s of this.samples.keys()) if (s > n) n = s;
    return n;
  }

  private refit(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const newest = this.newestSlot();
    const pts: [number, number][] = [];
    for (const [s, t] of this.samples) if (s >= newest - this.windowSlots) pts.push([s, t]);
    if (pts.length === 0) return;

    this.refSlot = newest;
    // Work relative to the newest slot: absolute slot numbers (~4.5e8) times
    // milliseconds would lose precision in the sums.
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [s, t] of pts) {
      const x = s - this.refSlot;
      n++;
      sx += x;
      sy += t;
      sxx += x * x;
      sxy += x * t;
    }
    const spread = n * sxx - sx * sx;
    let b = this.fitB;
    if (n >= 10 && spread > 0) b = (n * sxy - sx * sy) / spread;
    if (!Number.isFinite(b)) b = NOMINAL_SLOT_MS;
    b = Math.min(this.maxMs, Math.max(this.minMs, b));
    // With the slope fixed (and clamped), the intercept is the mean residual.
    this.fitB = b;
    this.fitA = (sy - b * sx) / n;
    this.fitted = true;
  }

  get ready(): boolean {
    return this.samples.size > 0;
  }

  /** Measured slot duration in ms. */
  get slotMs(): number {
    this.refit();
    return this.fitB;
  }

  /** Local time (ms) at which `slot` is expected to be observed. */
  timeOf(slot: number): number {
    this.refit();
    if (!this.fitted) return performance.now();
    return this.fitA + (slot - this.refSlot) * this.fitB;
  }

  /** Slot expected to be observed at local time `atMs` (fractional). */
  slotAt(atMs: number): number {
    this.refit();
    return this.refSlot + (atMs - this.fitA) / this.fitB;
  }
}
