import { INITIAL_REAL_TOKEN_RESERVES, NOMINAL_SLOT_MS, WSOL_MINT } from '../config';
import type { PumpEvent, Side } from '../pump/events';
import type { ParsedLogs } from '../pump/logs';
import { prng } from './demo-stream';
import type { Stream, StreamHandlers } from './types';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SYMBOLS = ['FROG', 'MOON', 'WIF', 'GOAT', 'BONK', 'JELLY', 'SOCK', 'NAP'];
/** Virtual reserves of a fresh pump curve (from real CreateEvents). */
const START_VIRTUAL_SOL = 30_000_000_000;
const START_VIRTUAL_TOKENS = 1_073_000_000_000_000;

interface Phase {
  /** Chance that a trade is a buy. */
  buyShare: number;
  /** Mean trades per second. */
  rate: number;
  /** Phase length in seconds. */
  seconds: number;
}
const PHASES: Phase[] = [
  { buyShare: 0.62, rate: 1.2, seconds: 40 }, // steady interest
  { buyShare: 0.8, rate: 3.5, seconds: 25 }, // pump
  { buyShare: 0.45, rate: 2, seconds: 30 }, // chop
  { buyShare: 0.25, rate: 2.5, seconds: 20 }, // dump
  { buyShare: 0.55, rate: 0.6, seconds: 35 }, // quiet
];

/** One simulated coin: a constant-product curve (x * y = k) like the real one. */
interface FakeCurve {
  mint: string;
  symbol: string;
  phase: number;
  phaseLeft: number;
  vSol: number;
  vTokens: number;
  realTokens: number;
  pool: string | null;
  creator: string;
  /** Raw tokens the dev holds. */
  devTokens: number;
}

/**
 * Simulated pump coins for trying coin mode offline. Trades move each coin's
 * curve like the real one, so price and curve progress behave plausibly; when
 * a curve fills up, the coin graduates and keeps trading on a simulated
 * PumpSwap pool. Each coin starts in a different market phase.
 */
export class CoinDemoStream implements Stream {
  readonly label = 'Demo (simulated coins)';
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly rand: () => number;
  private slot = 455_000_000;
  private sig = 0;
  private readonly curves: FakeCurve[];
  private readonly wallets: string[] = [];

  constructor(
    private readonly handlers: StreamHandlers,
    mints: readonly string[],
    seed = 7,
  ) {
    this.rand = prng(seed);
    for (let i = 0; i < 40; i++) this.wallets.push(this.address());
    this.curves = mints.map((mint, i) => {
      // Start well into the curve, so a graduation can happen within a few minutes.
      const vSol = 60_000_000_000 + i * 9_000_000_000;
      const vTokens = Math.round((START_VIRTUAL_SOL * START_VIRTUAL_TOKENS) / vSol);
      const phase = (i * 2) % PHASES.length;
      return {
        mint,
        symbol: SYMBOLS[i % SYMBOLS.length]!,
        phase,
        phaseLeft: PHASES[phase]!.seconds,
        vSol,
        vTokens,
        realTokens: vTokens - (START_VIRTUAL_TOKENS - INITIAL_REAL_TOKEN_RESERVES),
        pool: null,
        creator: this.address(),
        devTokens: 0,
      };
    });
  }

  start(): void {
    if (this.timer) return;
    this.handlers.onState({ kind: 'live', since: Date.now() });
    this.curves.forEach((c, i) => {
      this.emit(c, [{ kind: 'create', mint: c.mint, name: `${c.symbol} demo`, symbol: c.symbol, creator: c.creator }]);
      this.trade(i, 'buy', 1_500_000_000, c.creator); // the dev's first buy
    });
    this.timer = setInterval(() => this.tick(), NOMINAL_SLOT_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.handlers.onState({ kind: 'idle' });
  }

  private address(): string {
    let s = '';
    for (let i = 0; i < 44; i++) s += B58[Math.floor(this.rand() * 58)];
    return s;
  }

  private emit(c: FakeCurve, events: PumpEvent[]): void {
    const parsed: ParsedLogs = { events, failed: false, failedVenue: null, fallbackTrades: 0, foreignData: 0, malformed: 0 };
    this.handlers.onBytes(3_500 + Math.floor(this.rand() * 3_000), 'logs');
    this.handlers.onTx({ slot: this.slot, signature: `demo-${++this.sig}`, receivedAt: performance.now(), parsed, mentions: c.mint });
  }

  private tick(): void {
    this.slot += this.rand() < 0.03 ? 2 : 1;
    this.handlers.onBytes(90, 'slot');
    this.handlers.onSlot(this.slot, performance.now());

    for (let i = 0; i < this.curves.length; i++) {
      const c = this.curves[i]!;
      c.phaseLeft -= NOMINAL_SLOT_MS / 1_000;
      if (c.phaseLeft <= 0) {
        c.phase = (c.phase + 1) % PHASES.length;
        c.phaseLeft = PHASES[c.phase]!.seconds;
      }
      const ph = PHASES[c.phase]!;
      // Now and then, in a sell-off, the dev pulls the rug: sells their whole bag at once.
      if (ph.buyShare < 0.3 && c.devTokens > 0 && this.rand() < 0.004) {
        const k = c.vSol * c.vTokens;
        this.trade(i, 'sell', Math.round(c.vSol - k / (c.vTokens + c.devTokens)), c.creator);
        continue;
      }
      if (this.rand() > (ph.rate * NOMINAL_SLOT_MS) / 1_000) continue;
      const side: Side = this.rand() < ph.buyShare ? 'buy' : 'sell';
      // Mostly small trades (median ~0.15 SOL), now and then a whale of several SOL.
      const sol = Math.min(8e9, Math.exp(Math.log(0.15e9) + (this.rand() + this.rand() + this.rand() - 1.5) * 2.2 + (this.rand() < 0.03 ? 2.5 : 0)));
      this.trade(i, side, Math.round(sol));
    }
  }

  private trade(index: number, side: Side, lamports: number, seller?: string): void {
    const c = this.curves[index]!;
    const k = c.vSol * c.vTokens;
    const before = c.vSol;
    if (side === 'buy') {
      c.vSol += lamports;
    } else {
      lamports = Math.min(lamports, c.vSol - START_VIRTUAL_SOL * 0.5);
      if (lamports <= 0) return;
      c.vSol -= lamports;
    }
    const tokens = c.vTokens - k / c.vSol;
    c.vTokens = k / c.vSol;
    if (!c.pool) c.realTokens -= tokens;
    const user = seller ?? this.wallets[Math.floor(this.rand() ** 2 * this.wallets.length)]!;
    const tokenAmount = Math.round(Math.abs(tokens));
    const devBefore = c.devTokens;
    if (user === c.creator) c.devTokens = Math.max(0, c.devTokens + (side === 'buy' ? tokenAmount : -tokenAmount));
    // Like the real PumpSwap events: the trader's balance before the trade (known here only for the dev).
    const userTokensBefore = c.pool && user === c.creator ? devBefore : null;
    const price = c.vSol / c.vTokens;
    const impact = lamports / before;

    if (!c.pool) {
      const progress = Math.min(1, Math.max(0, 1 - c.realTokens / INITIAL_REAL_TOKEN_RESERVES));
      this.emit(c, [{ kind: 'trade', venue: 'curve', side, token: c.mint, impact, lamports, user, price, quote: 'sol', progress, quoteAmount: lamports, creator: c.creator, tokenAmount, userTokensBefore: null }]);
      if (c.realTokens <= 0) this.graduate(c);
    } else {
      this.emit(c, [{ kind: 'trade', venue: 'swap', side, token: c.pool, impact, lamports: null, user, price, quote: null, progress: null, quoteAmount: lamports, creator: c.creator, tokenAmount, userTokensBefore }]);
    }
  }

  private graduate(c: FakeCurve): void {
    c.pool = this.address();
    this.emit(c, [{ kind: 'complete', mint: c.mint }]);
    this.emit(c, [
      { kind: 'migrate', mint: c.mint, pool: c.pool, lamports: c.vSol - START_VIRTUAL_SOL },
      { kind: 'pool', pool: c.pool, baseMint: c.mint, quoteMint: WSOL_MINT },
    ]);
  }
}
