import { NOMINAL_SLOT_MS } from '../config';
import type { PumpEvent, Side, Venue } from '../pump/events';
import type { ParsedLogs } from '../pump/logs';
import type { Stream, StreamHandlers } from './types';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const WORDS = ['frog', 'cat', 'moon', 'pepe', 'dog', 'wif', 'cap', 'goat', 'beer', 'nap', 'bonk', 'ai', 'jelly', 'sock'];

/** Small seeded PRNG (mulberry32) so a demo run is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface FakeCoin {
  mint: string;
  pool: string | null;
  popularity: number;
}

/**
 * Simulated pump traffic for trying the sound without a network connection
 * (and for automated tests). Rates follow the public figures: roughly a
 * million pump transactions a day, i.e. about 12 per second on average.
 */
export class DemoStream implements Stream {
  readonly label = 'Demo (simulated data)';
  private timer: ReturnType<typeof setInterval> | null = null;
  private slot = 455_000_000;
  private readonly rand: () => number;
  private coins: FakeCoin[] = [];
  private sig = 0;
  /** Slowly drifting market mood so the demo changes key colour over time. */
  private mood = 0;

  constructor(
    private readonly handlers: StreamHandlers,
    seed = 42,
    private readonly tradesPerSecond = 12,
  ) {
    this.rand = prng(seed);
    for (let i = 0; i < 40; i++) this.coins.push(this.newCoin(this.rand() < 0.3));
  }

  start(): void {
    if (this.timer) return;
    this.handlers.onState({ kind: 'live', since: Date.now() });
    this.timer = setInterval(() => this.tick(), NOMINAL_SLOT_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.handlers.onState({ kind: 'idle' });
  }

  private address(suffix = ''): string {
    let s = '';
    for (let i = 0; i < 44 - suffix.length; i++) s += B58[Math.floor(this.rand() * 58)];
    return s + suffix;
  }

  private newCoin(graduated: boolean): FakeCoin {
    return { mint: this.address('pump'), pool: graduated ? this.address() : null, popularity: 0.2 + this.rand() ** 3 * 5 };
  }

  /** Poisson sample (Knuth); fine for the small means used here. */
  private poisson(mean: number): number {
    const l = Math.exp(-mean);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.rand();
    } while (p > l);
    return k - 1;
  }

  private pickCoin(): FakeCoin {
    const total = this.coins.reduce((n, c) => n + c.popularity, 0);
    let x = this.rand() * total;
    for (const c of this.coins) {
      x -= c.popularity;
      if (x <= 0) return c;
    }
    return this.coins[0]!;
  }

  private emit(events: PumpEvent[], failedVenue: Venue | null = null): void {
    const parsed: ParsedLogs = {
      events,
      failed: failedVenue !== null,
      failedVenue,
      fallbackTrades: 0,
      foreignData: 0,
      malformed: 0,
    };
    // Roughly the size of a real logsNotification, so the cost panel stays meaningful.
    this.handlers.onBytes(3_500 + Math.floor(this.rand() * 3_000), 'logs');
    this.handlers.onTx({ slot: this.slot, signature: `demo-${++this.sig}`, receivedAt: performance.now(), parsed });
  }

  private tick(): void {
    // ~3 % skipped slots, like a real leader missing its turn.
    this.slot += this.rand() < 0.03 ? 2 : 1;
    this.handlers.onBytes(90, 'slot');
    this.handlers.onSlot(this.slot, performance.now());

    this.mood = Math.max(-1, Math.min(1, this.mood + (this.rand() - 0.5) * 0.08));
    // Activity breathes on a ~40 s cycle with random bursts.
    const wave = 1 + 0.6 * Math.sin(this.slot / 200);
    const burst = this.rand() < 0.01 ? 4 : 1;
    const n = this.poisson((this.tradesPerSecond * NOMINAL_SLOT_MS) / 1_000 * wave * burst);

    for (let i = 0; i < n; i++) {
      const coin = this.pickCoin();
      const venue: Venue = coin.pool ? 'swap' : 'curve';
      const side: Side = this.rand() < 0.5 + this.mood * 0.25 ? 'buy' : 'sell';
      // Log-normal-ish: median ~0.1 % of reserves, 1 in ~60 trades above 3 % (a whale).
      const impact = Math.min(0.2, Math.exp(-7 + (this.rand() + this.rand() + this.rand() - 1.5) * 2.6 + (this.rand() < 0.015 ? 3 : 0)));
      this.emit([
        {
          kind: 'trade',
          venue,
          side,
          token: venue === 'swap' ? coin.pool : coin.mint,
          impact,
          lamports: venue === 'curve' ? Math.round(impact * 32e9) : null,
          user: null,
        },
      ]);
    }

    if (this.rand() < 0.5) this.emit([], this.rand() < 0.7 ? 'curve' : 'swap'); // failed bot tx

    if (this.rand() < 0.06) {
      const coin = this.newCoin(false);
      this.coins.push(coin);
      if (this.coins.length > 60) this.coins.splice(0, 1);
      const word = WORDS[Math.floor(this.rand() * WORDS.length)]!;
      this.emit([{ kind: 'create', mint: coin.mint, name: `${word} coin`, symbol: word.toUpperCase(), creator: this.address() }]);
    }

    if (this.rand() < 0.002) {
      const coin = this.coins.find((c) => !c.pool);
      if (coin) {
        coin.pool = this.address();
        this.emit([{ kind: 'complete', mint: coin.mint }]);
        this.emit([
          { kind: 'migrate', mint: coin.mint, pool: coin.pool, lamports: 85e9 },
          { kind: 'pool', pool: coin.pool, baseMint: coin.mint, quoteMint: 'So11111111111111111111111111111111111111112' },
        ]);
      }
    }
  }
}
