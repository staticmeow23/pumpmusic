import { MUSIC, SLOTS_PER_LEADER_WINDOW } from '../config';
import type { PumpEvent, TradeEvent, Venue } from '../pump/events';
import { hash32, isBase58Address } from '../solana/encoding';
import type { TxMessage } from '../stream/types';
import { SlotClock } from './clock';
import {
  MoodMeter,
  chordIndex,
  chordNotes,
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
  kind: 'buy' | 'sell' | 'create' | 'complete' | 'migrate' | 'failed';
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

  private activeVoices = 0;
  private counters = { notes: 0, merged: 0, late: 0, dropped: 0 };

  onVisual: (n: VisualNote) => void = () => {};
  onSlotMark: (m: SlotMark) => void = () => {};

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
      const at = this.place(tx.slot, 'ghosts', base, 1);
      const pan = ((hash32(tx.signature) % 200) / 100 - 1) * 0.8;
      if (at !== null) this.play('ghosts', at, (ctx, dest, t) => V.ghost(ctx, dest, t, pan));
      this.onVisual({ at: Math.max(base, performance.now()), kind: 'failed', venue: parsed.failedVenue, size: 0, pitch: 0.5, label: null, link: null, whale: false, pan });
      return;
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
        const at = this.place(tx.slot, 'events', base, 2);
        const h = hash32(ev.mint);
        const pan = ((h % 200) / 100 - 1) * 0.7;
        if (at !== null) {
          const freqs = [0, 2, 4].map((s) => midiToHz(scaleNote(tx.slot, this.mode, (h % 5) + s, 3)));
          this.play('events', at, (ctx, dest, t) => V.sparkle(ctx, dest, t, freqs, pan));
        }
        this.onVisual({ at: at ?? base, kind: 'create', venue: 'curve', size: 0.25, pitch: 0.92, label: ev.symbol ? `$${ev.symbol}` : 'new coin', link: this.coinLink(ev.mint, tx), whale: false, pan });
        return;
      }
      case 'complete': {
        if (!this.celebrate(`complete:${ev.mint}`)) return;
        const at = Math.max(base, performance.now() + 30);
        const f = midiToHz(scaleNote(tx.slot, this.mode, 0, 2));
        this.play('events', at, (ctx, dest, t) => V.chime(ctx, dest, t, f));
        this.onVisual({ at, kind: 'complete', venue: 'curve', size: 0.6, pitch: 0.7, label: this.labelFor(ev.mint, 'curve filled'), link: this.coinLink(ev.mint, tx), whale: false, pan: 0 });
        return;
      }
      case 'migrate': {
        this.poolToMint.set(ev.pool, ev.mint);
        if (!this.celebrate(`migrate:${ev.mint}`)) return;
        const at = Math.max(base, performance.now() + 30);
        const chord = chordNotes(tx.slot, this.mode).map((m) => midiToHz(m + 12));
        const root = midiToHz(scaleNote(tx.slot, this.mode, 0, -1));
        this.play('events', at, (ctx, dest, t) => V.swell(ctx, dest, t, chord, root));
        this.onVisual({ at, kind: 'migrate', venue: 'swap', size: 1, pitch: 0.5, label: `${this.labelFor(ev.mint, 'coin')} graduated`, link: this.coinLink(ev.mint, tx), whale: true, pan: 0 });
        return;
      }
    }
  }

  private handleTrade(ev: TradeEvent, tx: TxMessage, base: number): void {
    const now = performance.now();
    this.recentTrades.push(now);
    this.mood.add(ev.side, Math.sqrt(ev.impact ?? 0.002), now);

    const channel: Channel = ev.venue === 'swap' ? 'swap' : ev.side === 'buy' ? 'buys' : 'sells';
    const mint = ev.token ? (ev.venue === 'swap' ? this.poolToMint.get(ev.token) ?? null : ev.token) : null;
    // The coin keeps one voice before and after graduation once we know its pool.
    const key = mint ?? ev.token ?? `${ev.venue}-${ev.side}`;
    const h = hash32(key);
    const midi = tradeNote(tx.slot, this.mode, h, ev.impact, ev.side);
    const vel = velocityForImpact(ev.impact);
    const pan = ((h % 200) / 100 - 1) * 0.7;
    const whale = ev.impact !== null && ev.impact >= MUSIC.whaleImpact;

    const at = this.place(tx.slot, channel, base, MUSIC.notesPerSlotPerVoice);
    if (at === null) {
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
    if (mint && this.symbols.has(mint)) label = `$${this.symbols.get(mint)}`;
    else if (ev.lamports !== null && ev.lamports >= 1e9) label = `${(ev.lamports / 1e9).toFixed(ev.lamports >= 1e10 ? 0 : 1)} SOL`;

    this.onVisual({
      at: at ?? Math.max(base, now),
      kind: ev.side,
      venue: ev.venue,
      size: ev.impact === null ? 0.2 : Math.min(1, Math.max(0, (Math.log10(Math.max(ev.impact, 1e-5)) + 4) / 3)),
      pitch: Math.max(0, Math.min(1, (midi - 36) / 60)),
      label,
      link: mint ? this.coinLink(mint, tx) : this.txLink(tx),
      whale,
      pan,
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

    // Pad brightness: trades in the last 5 s against a busy reference of 25/s.
    while (this.recentTrades.length && now - this.recentTrades[0]! > 5_000) this.recentTrades.shift();
    this.pad?.setActivity(this.recentTrades.length / (25 * 5), ctx.currentTime);
  }
}
