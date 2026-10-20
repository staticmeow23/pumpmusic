import { MUSIC, SLOTS_PER_EPOCH } from '../config';

/**
 * Music theory, kept pure so it can be unit-tested and so every listener
 * derives the same harmony from the same slot numbers.
 *
 * All scales are five-note (pentatonic) on purpose: any combination of their
 * notes sounds consonant, which matters when dozens of trades overlap.
 */
export const SCALES = {
  /** Buyers in control: major pentatonic. */
  bright: [0, 2, 4, 7, 9],
  /** Balanced: suspended pentatonic, neither happy nor sad. */
  neutral: [0, 2, 5, 7, 10],
  /** Sellers in control: minor pentatonic. */
  dark: [0, 3, 5, 7, 10],
} as const;
export type Mode = keyof typeof SCALES;

/** Roots move around the circle of fifths, one per epoch (~24 h at 200 ms slots). */
const EPOCH_ROOTS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
/** Chord progression as scale-degree roots; a chord stacks every other scale note. */
const PROGRESSION = [0, 3, 1, 4];
const BASE_MIDI = 48; // C3

export function epochOf(slot: number): number {
  return Math.floor(slot / SLOTS_PER_EPOCH);
}

export function rootOf(slot: number): number {
  return EPOCH_ROOTS[epochOf(slot) % EPOCH_ROOTS.length]!;
}

/** Hysteresis so the key colour doesn't flicker around a threshold. */
export function modeFor(mood: number, current: Mode): Mode {
  if (current === 'bright') return mood < 0.15 ? (mood < -0.35 ? 'dark' : 'neutral') : 'bright';
  if (current === 'dark') return mood > -0.15 ? (mood > 0.35 ? 'bright' : 'neutral') : 'dark';
  if (mood > 0.35) return 'bright';
  if (mood < -0.35) return 'dark';
  return 'neutral';
}

/** MIDI note of scale step `step` (can exceed 5 or go negative) above the epoch root. */
export function scaleNote(slot: number, mode: Mode, step: number, octave = 0): number {
  const scale = SCALES[mode];
  const len = scale.length;
  const oct = Math.floor(step / len);
  const idx = ((step % len) + len) % len;
  return BASE_MIDI + rootOf(slot) + scale[idx]! + 12 * (oct + octave);
}

export function chordIndex(slot: number): number {
  return Math.floor(slot / MUSIC.slotsPerChord) % PROGRESSION.length;
}

/** Three chord tones (MIDI) for the pad, in a low register. */
export function chordNotes(slot: number, mode: Mode): number[] {
  const deg = PROGRESSION[chordIndex(slot)]!;
  return [deg, deg + 2, deg + 4].map((s) => scaleNote(slot, mode, s, -1));
}

export const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

/**
 * Like BitListen: the bigger the trade, the deeper the note. `impact` is the
 * trade's share of the pool's quote reserves. Returns an octave offset from
 * +3 (tiny trade, high and light) down to 0 (large trade, low and heavy).
 */
export function octaveForImpact(impact: number | null): number {
  if (impact === null) return 2;
  if (impact < 0.0015) return 3;
  if (impact < 0.006) return 2;
  if (impact < 0.025) return 1;
  return 0;
}

/** 0..1 loudness from impact on a log scale (0.01 % -> quiet, 10 % -> full). */
export function velocityForImpact(impact: number | null): number {
  if (impact === null) return 0.45;
  const v = (Math.log10(Math.max(impact, 1e-5)) + 4) / 3;
  return Math.min(1, Math.max(0.18, v));
}

/**
 * Note for a trade. A coin's hash picks its scale step, so the same coin keeps
 * "its" note while the key and chord change around it. Sells sit an octave
 * below buys, like the strings under the bells in Listen to Wikipedia.
 */
export function tradeNote(slot: number, mode: Mode, tokenHash: number, impact: number | null, side: 'buy' | 'sell'): number {
  const step = tokenHash % SCALES[mode].length;
  const octave = octaveForImpact(impact) + (side === 'sell' ? -1 : 0);
  return scaleNote(slot, mode, step, octave);
}

/**
 * Exponentially decaying buy-vs-sell balance in [-1, 1]. Each trade adds its
 * weight (we use sqrt(impact) so one whale doesn't flip the mood alone).
 */
export class MoodMeter {
  private buys = 0;
  private sells = 0;
  private last: number | null = null;

  constructor(private readonly halfLifeMs: number = MUSIC.moodHalfLifeMs) {}

  private decay(now: number): void {
    if (this.last !== null && now > this.last) {
      const f = 0.5 ** ((now - this.last) / this.halfLifeMs);
      this.buys *= f;
      this.sells *= f;
    }
    this.last = this.last === null ? now : Math.max(this.last, now);
  }

  add(side: 'buy' | 'sell', weight: number, now: number): void {
    this.decay(now);
    if (side === 'buy') this.buys += weight;
    else this.sells += weight;
  }

  value(now: number): number {
    this.decay(now);
    const total = this.buys + this.sells;
    return total > 1e-9 ? (this.buys - this.sells) / total : 0;
  }
}
