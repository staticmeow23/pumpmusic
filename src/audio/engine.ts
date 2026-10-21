import { MUSIC, SLOTS_PER_LEADER_WINDOW } from '../config';
import type { PumpEvent, Quote, TradeEvent, Venue } from '../pump/events';
import { hash32, isBase58Address } from '../solana/encoding';
import type { TxMessage } from '../stream/types';
import { tradeLabel } from '../ui/labels';
import { SlotClock } from './clock';
import { RugDetector, type RugSignal } from './rug';
import {
  MoodMeter,
  PriceMelody,
  chordIndex,
  chordNotes,
  coinNote,
  coinPan,
  coinRegister,
  midiToHz,
  modeFor,
  rootOf,
  scaleNote,
  tradeNote,
  velocityForImpact,
  type Mode,
} from './theory';
import * as V from './voices';

export type Channel = 'buys' | 'sells' | 'swap' | 'events' | 'pulse' | 'ghosts' | 'pad';
export const CHANNELS: Channel[] = ['buys', 'sells', 'swap', 'events', 'pulse', 'ghosts', 'pad'];

export const DEFAULT_GAINS: Record<Channel, number> = {
  buys: 0.9,
  sells: 0.8,
  swap: 0.8,
  events: 0.9,
  pulse: 0.4,
  ghosts: 0.25,
  pad: 0.7,
};
const REVERB_SEND: Record<Channel, number> = {
  buys: 0.35,
  sells: 0.25,
  swap: 0.3,
  events: 0.6,
  pulse: 0.05,
  ghosts: 0.1,
  pad: 0.5,
};

/** Something the screen should show at local time `at` (performance.now ms). */
export interface VisualNote {
  at: number;
  /** 'rug': a coin being listened to looks rugged (label: "$TICKER\n<what happened>"). */
  kind: 'buy' | 'sell' | 'create' | 'complete' | 'migrate' | 'failed' | 'rug';
  venue: Venue | null;
  /** 0..1 */
  size: number;
  /** 0 (low) .. 1 (high), so bubbles sit where they sound. */
  pitch: number;
  label: string | null;
  link: string | null;
  whale: boolean;
  /** -1..1, matches the stereo position. */
  pan: number;
  /** Mint, or the pool address while a graduated coin's mint is unknown. */
  coin: string | null;
  symbol: string | null;
  /** Trade size in SOL; null when not SOL-quoted or unknown (PumpSwap). */
  sol: number | null;
  /** Outside the focused coin: drawn quietly, not played. */
  faint: boolean;
  /** Trader's wallet, when the event names it. */
  user: string | null;
  /** Coin mode: which of the entered coins (0, 1, ...), for its colour. */
  coinIndex: number | null;
}

/** One entered coin in coin mode. */
interface CoinVoice {
  index: number;
  melody: PriceMelody;
  /** Learned from curve trades; PumpSwap events don't say. */
  quote: Quote | null;
  /** Seen trading on its bonding curve (and not graduated since). */
  onCurve: boolean;
}

export interface SlotMark {
  slot: number;
  at: number;
  skipped: boolean;
  downbeat: boolean;
}

export interface EngineStats {
  notes: number;
  merged: number;
  late: number;
  dropped: number;
  activeVoices: number;
  mode: Mode;
  mood: number;
  root: string;
  slotMs: number;
  playingSlot: number | null;
  slotFeed: boolean;
}

/**
 * PumpSwap events name the pool, not the mint. While listening to a coin,
 * every transaction we get mentions its mint, so if such a transaction trades
 * exactly one PumpSwap pool we don't know yet, that pool is the coin's.
 * Several pools (a route through other coins) teach us nothing, and neither
 * does a coin still on its bonding curve: a PumpSwap trade next to it belongs
 * to some other coin on the route.
 */
export function learnCoinPool(events: readonly PumpEvent[], poolToMint: ReadonlyMap<string, string>, onCurve = false): string | null {
  if (onCurve) return null;
  const unknown = new Set<string>();
  for (const ev of events) {
    if (ev.kind === 'trade' && ev.venue === 'curve') return null;
    if (ev.kind === 'trade' && ev.venue === 'swap' && ev.token && !poolToMint.has(ev.token)) unknown.add(ev.token);
  }
  return unknown.size === 1 ? unknown.values().next().value! : null;
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

interface SlotBook {
  counts: Partial<Record<Channel, number>>;
}

/**
 * Turns pump events into sound and visuals.
 *
 * Timing model: slot S plays at clock.timeOf(S) + delay. The delay is a small
 * buffer that lets late messages still land on their own slot, so the music
 * keeps the order and rhythm of the chain. Each slot holds up to
 * `notesPerSlotPerVoice` notes per instrument on a sub-grid; extra trades are
 * still drawn, and they brighten the pad instead of adding more notes.
 */
export class MusicEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buses = new Map<Channel, GainNode>();
  private pad: V.Pad | null = null;
  private loop: ReturnType<typeof setInterval> | null = null;

  readonly clock = new SlotClock();
  private readonly mood = new MoodMeter();
  private mode: Mode = 'neutral';
  private delayMs: number = MUSIC.defaultDelayMs;
  private gains: Record<Channel, number> = { ...DEFAULT_GAINS };

  private books = new Map<number, SlotBook>();
  private seenSlots = new Set<number>();
  private highestSlot = 0;
  /** First slot seen since the clock (re)started; nothing before it can be called skipped. */
  private firstSlot: number | null = null;
  private lastSlotFeedAt = -Infinity;
  private nextPulseSlot: number | null = null;
  private padChord = -1;
  private padMode: Mode | null = null;
  private recentTrades: number[] = [];

  private symbols = new Map<string, string>();
  private poolToMint = new Map<string, string>();
  private celebrated = new Set<string>();

  /** Coin (mint or pool) to listen to exclusively; null = the whole market. */
  private focus: string | null = null;
  /** Coin mode: the entered mints; each has its own melody, register and stereo place. */
  private coins = new Map<string, CoinVoice>();
  private rugs = new RugDetector();

  private activeVoices = 0;
  private counters = { notes: 0, merged: 0, late: 0, dropped: 0 };

  onVisual: (n: VisualNote) => void = () => {};
  onSlotMark: (m: SlotMark) => void = () => {};
  /** Coin mode: every trade of the coin, for its price and stats. */
  onCoinTrade: (ev: TradeEvent, mint: string) => void = () => {};

  /** Must be called from a user gesture (browser autoplay rules). */
  async start(): Promise<void> {
    if (this.ctx) {
      await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    limiter.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(limiter);

    const reverb = ctx.createConvolver();
    reverb.buffer = V.makeImpulse(ctx);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.55;
    reverb.connect(reverbReturn);
    reverbReturn.connect(this.master);

    for (const ch of CHANNELS) {
      const bus = ctx.createGain();
      bus.gain.value = this.gains[ch];
      bus.connect(this.master);
      const send = ctx.createGain();
      send.gain.value = REVERB_SEND[ch];
      bus.connect(send);
      send.connect(reverb);
      this.buses.set(ch, bus);
    }

    await ctx.resume();
    this.loop = setInterval(() => this.schedulerTick(), 50);
  }

  async stop(): Promise<void> {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
    this.pad?.stop();
    this.pad = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.buses.clear();
    this.nextPulseSlot = null;
    this.padChord = -1;
    this.padMode = null;
    this.activeVoices = 0;
    if (ctx) await ctx.close();
  }

  get running(): boolean {
    return this.ctx !== null;
  }

  setDelay(ms: number): void {
    this.delayMs = Math.max(MUSIC.minDelayMs, Math.min(MUSIC.maxDelayMs, ms));
  }

  get delay(): number {
    return this.delayMs;
  }

  setGain(ch: Channel, value: number): void {
    this.gains[ch] = value;
    const bus = this.buses.get(ch);
    if (bus && this.ctx) bus.gain.setTargetAtTime(value, this.ctx.currentTime, 0.05);
  }

  setMasterVolume(value: number): void {
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(value, this.ctx.currentTime, 0.05);
  }

  stats(): EngineStats {
    const now = performance.now();
    return {
      ...this.counters,
      activeVoices: this.activeVoices,
      mode: this.mode,
      mood: this.mood.value(now),
      root: NOTE_NAMES[rootOf(this.highestSlot)]!,
      slotMs: this.clock.slotMs,
      playingSlot: this.clock.ready ? Math.floor(this.clock.slotAt(now - this.delayMs)) : null,
      slotFeed: now - this.lastSlotFeedAt < 5_000,
    };
  }

  /** Listen to one coin only (mint or pool address), or to everything with null. */
  setFocus(coin: string | null): void {
    this.focus = coin;
  }

  /** Coin mode: only these mints play, each price drives its own melody. Empty = market mode. */
  setCoins(mints: readonly string[]): void {
    this.coins = new Map(mints.map((m, index) => [m, { index, melody: new PriceMelody(), quote: null, onCurve: false }]));
    this.rugs = new RugDetector();
    this.focus = null;
  }

  get coinMode(): boolean {
    return this.coins.size > 0;
  }

  get coinList(): string[] {
    return [...this.coins.keys()];
  }

  private coinIndexOf(mint: string | null): number | null {
    return mint ? this.coins.get(mint)?.index ?? null : null;
  }

  get focused(): string | null {
    return this.focus;
  }

  /** Ticker learned elsewhere (e.g. a metadata lookup), for labels and the coin bar. */
  setSymbol(mint: string, symbol: string): void {
    this.symbols.set(mint, symbol);
  }

  /** Ticker of a coin seen in this session (mint or a known pool), if any. */
  symbolOf(coin: string): string | null {
    return this.symbols.get(this.poolToMint.get(coin) ?? coin) ?? null;
  }

  // ---------------------------------------------------------------- input

  handleSlot(slot: number, at: number): void {
    this.lastSlotFeedAt = at;
    this.noteSlot(slot, at);
  }

  handleTx(tx: TxMessage): void {
    this.noteSlot(tx.slot, tx.receivedAt);
    if (!this.ctx) return;

    const base = this.clock.timeOf(tx.slot) + this.delayMs;
    const { parsed } = tx;

    if (parsed.failed && parsed.failedVenue) {
      const faint = this.focus !== null;
      const at = faint ? null : this.place(tx.slot, 'ghosts', base, 1);
      const pan = ((hash32(tx.signature) % 200) / 100 - 1) * 0.8;
      if (at !== null) this.play('ghosts', at, (ctx, dest, t) => V.ghost(ctx, dest, t, pan));
      this.onVisual({ at: Math.max(base, performance.now()), kind: 'failed', venue: parsed.failedVenue, size: 0, pitch: 0.5, label: null, link: null, whale: false, pan, coin: null, symbol: null, sol: null, faint, user: null, coinIndex: this.coinIndexOf(tx.mentions) });
      return;
    }

    if (this.coins.size) {
      // The subscription that delivered the tx tells us which coin it is about.
      const owner = tx.mentions && this.coins.has(tx.mentions) ? tx.mentions : this.coins.size === 1 ? this.coinList[0]! : null;
      const pool = owner ? learnCoinPool(parsed.events, this.poolToMint, this.coins.get(owner)!.onCurve) : null;
      if (pool && owner) this.poolToMint.set(pool, owner);
    }
    for (const ev of parsed.events) this.handleEvent(ev, tx, base);
  }

  private noteSlot(slot: number, at: number): void {
    const resets = this.clock.resets;
    this.clock.observe(slot, at);
    if (this.clock.resets !== resets) {
      // The clock started over (endpoint switch, lagging node): so does our slot bookkeeping.
      this.highestSlot = slot;
      this.firstSlot = null;
      this.seenSlots.clear();
      this.books.clear();
      this.nextPulseSlot = null;
    }
    this.seenSlots.add(slot);
    if (this.firstSlot === null || slot < this.firstSlot) this.firstSlot = slot;
    if (slot > this.highestSlot) this.highestSlot = slot;
    if (this.seenSlots.size > 600) {
      for (const s of this.seenSlots) if (s < this.highestSlot - 400) this.seenSlots.delete(s);
    }
  }

  private handleEvent(ev: PumpEvent, tx: TxMessage, base: number): void {
    switch (ev.kind) {
      case 'trade':
        this.handleTrade(ev, tx, base);
        return;
      case 'pool':
        this.poolToMint.set(ev.pool, ev.baseMint);
        return;
      case 'create': {
        this.symbols.set(ev.mint, ev.symbol);
        if (this.symbols.size > 5_000) this.symbols.delete(this.symbols.keys().next().value!);
        const faint = !this.isFocused(ev.mint, ev.mint);
        const at = faint ? null : this.place(tx.slot, 'events', base, 2);
        const h = hash32(ev.mint);
        const pan = ((h % 200) / 100 - 1) * 0.7;
        if (at !== null) {
          const freqs = [0, 2, 4].map((s) => midiToHz(scaleNote(tx.slot, this.mode, (h % 5) + s, 3)));
          this.play('events', at, (ctx, dest, t) => V.sparkle(ctx, dest, t, freqs, pan));
        }
        this.onVisual({ at: at ?? base, kind: 'create', venue: 'curve', size: 0.25, pitch: 0.92, label: ev.symbol ? `$${ev.symbol}` : 'new coin', link: this.coinLink(ev.mint, tx), whale: false, pan, coin: ev.mint, symbol: ev.symbol || null, sol: null, faint, user: null, coinIndex: this.coinIndexOf(ev.mint) });
        return;
      }
      case 'complete': {
        if (!this.celebrate(`complete:${ev.mint}`)) return;
        const faint = !this.isFocused(ev.mint, ev.mint);
        const at = Math.max(base, performance.now() + 30);
        const f = midiToHz(scaleNote(tx.slot, this.mode, 0, 2));
        if (!faint) this.play('events', at, (ctx, dest, t) => V.chime(ctx, dest, t, f));
        this.onVisual({ at, kind: 'complete', venue: 'curve', size: 0.6, pitch: 0.7, label: this.labelFor(ev.mint, 'curve filled'), link: this.coinLink(ev.mint, tx), whale: false, pan: 0, coin: ev.mint, symbol: this.symbols.get(ev.mint) ?? null, sol: null, faint, user: null, coinIndex: this.coinIndexOf(ev.mint) });
        return;
      }
      case 'migrate': {
        this.poolToMint.set(ev.pool, ev.mint);
        const migrated = this.coins.get(ev.mint);
        if (migrated) migrated.onCurve = false;
        if (!this.celebrate(`migrate:${ev.mint}`)) return;
        const faint = !this.isFocused(ev.mint, ev.pool);
        const at = Math.max(base, performance.now() + 30);
        const chord = chordNotes(tx.slot, this.mode).map((m) => midiToHz(m + 12));
        const root = midiToHz(scaleNote(tx.slot, this.mode, 0, -1));
        if (!faint) this.play('events', at, (ctx, dest, t) => V.swell(ctx, dest, t, chord, root));
        this.onVisual({ at, kind: 'migrate', venue: 'swap', size: 1, pitch: 0.5, label: `${this.labelFor(ev.mint, 'coin')} graduated`, link: this.coinLink(ev.mint, tx), whale: true, pan: 0, coin: ev.mint, symbol: this.symbols.get(ev.mint) ?? null, sol: null, faint, user: null, coinIndex: this.coinIndexOf(ev.mint) });
        return;
      }
    }
  }

  private handleTrade(ev: TradeEvent, tx: TxMessage, base: number): void {
    const now = performance.now();
    const channel: Channel = ev.venue === 'swap' ? 'swap' : ev.side === 'buy' ? 'buys' : 'sells';
    let mint = ev.token ? (ev.venue === 'swap' ? this.poolToMint.get(ev.token) ?? null : ev.token) : null;
    // Fallback trades (no event, no token) inside a coin's transaction are that coin's.
    if (!mint && ev.token === null && tx.mentions && this.coins.has(tx.mentions)) mint = tx.mentions;
    const voice = mint ? this.coins.get(mint) : undefined;
    if (voice && ev.quote) voice.quote = ev.quote;
    if (voice && ev.venue === 'curve') voice.onCurve = true;
    const faint = this.coins.size ? !voice : !this.isFocused(mint, ev.token);
    if (!faint) {
      this.recentTrades.push(now);
      this.mood.add(ev.side, Math.sqrt(ev.impact ?? 0.002), now);
    }

    // The coin keeps one voice before and after graduation once we know its pool.
    const key = mint ?? ev.token ?? `${ev.venue}-${ev.side}`;
    const h = hash32(key);
    // Market: big = deep, each coin its own note. Coin mode: each price is a melody
    // in its coin's register, each coin has its place in the stereo field.
    const midi = voice
      ? coinNote(tx.slot, this.mode, voice.melody.step(ev.price, now) + coinRegister(voice.index), ev.side)
      : tradeNote(tx.slot, this.mode, h, ev.impact, ev.side);
    const vel = velocityForImpact(ev.impact);
    const pan = voice
      ? coinPan(voice.index, this.coins.size, ev.user ? hash32(ev.user) : h)
      : ((h % 200) / 100 - 1) * 0.7;
    const whale = ev.impact !== null && ev.impact >= MUSIC.whaleImpact;
    const cap = this.coins.size ? MUSIC.coin.notesPerSlot : MUSIC.notesPerSlotPerVoice;

    const at = faint ? null : this.place(tx.slot, channel, base, cap);
    if (faint) {
      // Out of focus: drawn quietly, neither played nor counted as merged.
    } else if (at === null) {
      this.counters.merged++;
    } else {
      const freq = midiToHz(midi);
      if (channel === 'buys') this.play(channel, at, (ctx, d, t) => V.bell(ctx, d, t, freq, vel, pan));
      else if (channel === 'sells') this.play(channel, at, (ctx, d, t) => V.pluck(ctx, d, t, freq, vel, pan));
      else this.play(channel, at, (ctx, d, t) => V.epiano(ctx, d, t, freq, vel, pan, ev.side === 'sell'));
      if (whale) {
        const subHz = midiToHz(scaleNote(tx.slot, this.mode, 0, -1));
        this.play('events', at, (ctx, d, t) => V.sub(ctx, d, t, subHz, vel));
      }
    }

    let label: string | null = null;
    // Graduated pump coins trade against SOL unless the curve told us otherwise.
    const quote = voice && ev.venue === 'swap' ? voice.quote ?? 'sol' : ev.quote;
    if (voice && mint) {
      // Coin mode: every bubble says which coin and how much.
      label = tradeLabel(this.symbols.get(mint) ?? `${mint.slice(0, 4)}…`, ev.side, ev.quoteAmount, quote);
    } else if (mint && this.symbols.has(mint)) label = `$${this.symbols.get(mint)}`;
    else if (ev.lamports !== null && ev.lamports >= 1e9) label = `${(ev.lamports / 1e9).toFixed(ev.lamports >= 1e10 ? 0 : 1)} SOL`;

    this.onVisual({
      at: at ?? Math.max(base, now),
      kind: ev.side,
      venue: ev.venue,
      size: ev.impact === null ? 0.2 : Math.min(1, Math.max(0, (Math.log10(Math.max(ev.impact, 1e-5)) + 4) / 3)),
      pitch: Math.max(0, Math.min(1, (midi - 36) / 60)),
      label,
      // One coin: every bubble is its own transaction. Market: the bubble is its coin.
      link: this.coins.size || !mint ? this.txLink(tx) : this.coinLink(mint, tx),
      whale,
      pan,
      coin: mint ?? ev.token,
      symbol: mint ? this.symbols.get(mint) ?? null : null,
      sol: ev.lamports !== null && ev.lamports > 0 ? ev.lamports / 1e9 : voice && quote === 'sol' && ev.quoteAmount ? ev.quoteAmount / 1e9 : null,
      faint,
      user: ev.user,
      coinIndex: voice?.index ?? null,
    });
    if (voice && mint) {
      this.onCoinTrade(ev, mint);
      const rug = this.rugs.check(mint, ev, now);
      if (rug) this.rugAlarm(mint, voice, rug, tx, base, pan);
    }
  }

  /** The organ: louder than everything, outside the per-slot note limits. */
  private rugAlarm(mint: string, voice: CoinVoice, rug: RugSignal, tx: TxMessage, base: number, pan: number): void {
    const at = Math.max(base, performance.now() + 30);
    const root = midiToHz(scaleNote(tx.slot, this.mode, 0, 0));
    this.play('events', at, (ctx, d, t) => V.organ(ctx, d, t, root));
    const name = this.symbols.has(mint) ? `$${this.symbols.get(mint)}` : `${mint.slice(0, 4)}…`;
    this.onVisual({
      at, kind: 'rug', venue: null, size: 1, pitch: 0.2, label: `${name}\n${rug.detail}`, link: this.txLink(tx),
      whale: true, pan, coin: mint, symbol: this.symbols.get(mint) ?? null, sol: null, faint: false, user: null, coinIndex: voice.index,
    });
  }

  // --------------------------------------------------------------- helpers

  /**
   * Reserves a position for one note in slot `slot` on `channel`.
   * Returns the local time to play it, or null when the slot is full.
   */
  private place(slot: number, channel: Channel, base: number, cap: number): number | null {
    let book = this.books.get(slot);
    if (!book) {
      book = { counts: {} };
      this.books.set(slot, book);
      if (this.books.size > 400) {
        for (const s of this.books.keys()) if (s < this.highestSlot - 300) this.books.delete(s);
      }
    }
    const index = book.counts[channel] ?? 0;
    if (index >= cap) return null;
    book.counts[channel] = index + 1;

    let at = base + (index * this.clock.slotMs) / cap;
    const earliest = performance.now() + 25;
    if (at < earliest) {
      // Arrived after its slot already played: play it right away, still in order.
      this.counters.late++;
      at = earliest + index * 15;
    }
    return at;
  }

  private play(channel: Channel, atMs: number, voice: (ctx: AudioContext, dest: AudioNode, t: number) => AudioScheduledSourceNode): void {
    const ctx = this.ctx;
    const bus = this.buses.get(channel);
    if (!ctx || !bus) return;
    if (this.activeVoices >= MUSIC.maxActiveVoices) {
      this.counters.dropped++;
      return;
    }
    const t = ctx.currentTime + Math.max(0, (atMs - performance.now()) / 1_000);
    try {
      const src = voice(ctx, bus, t);
      this.activeVoices++;
      this.counters.notes++;
      src.onended = () => {
        this.activeVoices = Math.max(0, this.activeVoices - 1);
      };
    } catch {
      this.counters.dropped++;
    }
  }

  /**
   * Whether an event of this coin passes the focus filter. A focus set on a
   * pool still matches once we learn its mint, and the other way round.
   */
  private isFocused(mint: string | null, token: string | null): boolean {
    if (this.coins.size) {
      const tMint = token ? this.poolToMint.get(token) ?? token : null;
      return (mint !== null && this.coins.has(mint)) || (tMint !== null && this.coins.has(tMint));
    }
    const f = this.focus;
    if (f === null) return true;
    const fMint = this.poolToMint.get(f) ?? f;
    const tMint = token ? this.poolToMint.get(token) ?? token : null;
    return fMint === mint || fMint === tMint || f === token;
  }

  private celebrate(key: string): boolean {
    if (this.celebrated.has(key)) return false;
    this.celebrated.add(key);
    if (this.celebrated.size > 2_000) this.celebrated.delete(this.celebrated.values().next().value!);
    return true;
  }

  private labelFor(mint: string, fallback: string): string {
    const sym = this.symbols.get(mint);
    return sym ? `$${sym}` : fallback;
  }

  private coinLink(mint: string, tx: TxMessage): string | null {
    if (tx.signature.startsWith('demo-')) return null;
    return isBase58Address(mint) ? `https://pump.fun/coin/${mint}` : this.txLink(tx);
  }

  private txLink(tx: TxMessage): string | null {
    return SIGNATURE.test(tx.signature) ? `https://solscan.io/tx/${tx.signature}` : null;
  }

  /** Runs every 50 ms: the slot pulse, skipped-slot glitches, pad chord and brightness. */
  private schedulerTick(): void {
    const ctx = this.ctx;
    if (!ctx || !this.clock.ready) return;
    const now = performance.now();
    this.mode = modeFor(this.mood.value(now), this.mode);

    const playing = this.clock.slotAt(now - this.delayMs);
    const horizon = Math.floor(this.clock.slotAt(now - this.delayMs + 250));
    if (this.nextPulseSlot === null || playing - this.nextPulseSlot > 50 || this.nextPulseSlot - playing > 50) {
      this.nextPulseSlot = Math.ceil(playing);
    }
    const slotFeed = now - this.lastSlotFeedAt < 5_000;

    for (let s = this.nextPulseSlot; s <= horizon; s++) {
      const at = this.clock.timeOf(s) + this.delayMs;
      if (at < now) continue;
      const downbeat = s % SLOTS_PER_LEADER_WINDOW === 0;
      // Only the slot feed tells us reliably that a slot was skipped.
      const skipped = slotFeed && this.firstSlot !== null && s > this.firstSlot && s < this.highestSlot && !this.seenSlots.has(s);
      if (skipped) this.play('pulse', at, (c, d, t) => V.glitch(c, d, t));
      else if (downbeat) this.play('pulse', at, (c, d, t) => V.kick(c, d, t, 0.9));
      else this.play('pulse', at, (c, d, t) => V.tick(c, d, t, 0.7));
      this.onSlotMark({ slot: s, at, skipped, downbeat });

      // Harmony follows the slot that is about to be heard.
      const ci = chordIndex(s);
      if (ci !== this.padChord || this.mode !== this.padMode) {
        this.padChord = ci;
        this.padMode = this.mode;
        const freqs = chordNotes(s, this.mode).map(midiToHz);
        const t = ctx.currentTime + Math.max(0, (at - now) / 1_000);
        const padBus = this.buses.get('pad');
        if (!this.pad && padBus) this.pad = new V.Pad(ctx, padBus, freqs);
        else this.pad?.setChord(freqs, t);
      }
    }
    this.nextPulseSlot = Math.max(this.nextPulseSlot, horizon + 1);

    // Pad brightness: trades heard in the last 5 s against a "busy" reference.
    while (this.recentTrades.length && now - this.recentTrades[0]! > 5_000) this.recentTrades.shift();
    const ref = this.coins.size ? MUSIC.coin.activityRef * this.coins.size : MUSIC.marketActivityRef;
    this.pad?.setActivity(this.recentTrades.length / (ref * 5), ctx.currentTime);
  }
}
