import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SlotClock } from '../src/audio/clock';
import { MUSIC } from '../src/config';
import {
  MoodMeter,
  PriceMelody,
  coinNote,
  SCALES,
  chordNotes,
  modeFor,
  octaveForImpact,
  scaleNote,
  tradeNote,
  velocityForImpact,
} from '../src/audio/theory';

test('clock learns the real slot time despite jitter and skipped slots', () => {
  const clock = new SlotClock();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const start = 455_000_000;
  for (let i = 0; i < 300; i++) {
    if (i % 17 === 0) continue; // skipped slot
    const jitter = rnd() * 60; // up to 60 ms late
    clock.observe(start + i, 10_000 + i * 210 + jitter);
  }
  assert.ok(Math.abs(clock.slotMs - 210) < 2, `slotMs ${clock.slotMs}`);
  // Predicts the next slot within the jitter band.
  const predicted = clock.timeOf(start + 300);
  assert.ok(Math.abs(predicted - (10_000 + 300 * 210 + 30)) < 25, `predicted ${predicted}`);
  assert.ok(Math.abs(clock.slotAt(predicted) - (start + 300)) < 1e-6);
});

test('clock clamps nonsense and ignores later duplicates', () => {
  const clock = new SlotClock();
  for (let i = 0; i < 20; i++) clock.observe(100 + i, 1_000 + i * 5); // 5 ms/slot is impossible
  assert.equal(clock.slotMs, 120);
  clock.observe(100, 50_000); // later duplicate: ignored
  clock.observe(Number.NaN, 1);
  assert.equal(clock.slotMs, 120);
});

test('scale notes wrap octaves and stay in the scale', () => {
  const slot = 0; // epoch 0 -> root C
  assert.equal(scaleNote(slot, 'bright', 0), 48);
  assert.equal(scaleNote(slot, 'bright', 5), 60);
  assert.equal(scaleNote(slot, 'bright', -1), 45); // A2, the top of the scale below
  for (let step = -10; step < 20; step++) {
    const pc = (scaleNote(slot, 'dark', step) - 48 + 120) % 12;
    assert.ok((SCALES.dark as readonly number[]).includes(pc));
  }
});

test('bigger trades sound lower, sells sit below buys', () => {
  assert.ok(octaveForImpact(0.0005) > octaveForImpact(0.05));
  const small = tradeNote(0, 'neutral', 3, 0.0005, 'buy');
  const whale = tradeNote(0, 'neutral', 3, 0.05, 'buy');
  const sell = tradeNote(0, 'neutral', 3, 0.0005, 'sell');
  assert.ok(whale < small);
  assert.equal(small - sell, 12);
  assert.ok(velocityForImpact(0.1) > velocityForImpact(0.0001));
  assert.ok(velocityForImpact(0.1) <= 1 && velocityForImpact(1e-9) >= 0.18);
});

test('mode switching has hysteresis', () => {
  assert.equal(modeFor(0.4, 'neutral'), 'bright');
  assert.equal(modeFor(0.2, 'bright'), 'bright');
  assert.equal(modeFor(0.1, 'bright'), 'neutral');
  assert.equal(modeFor(-0.5, 'bright'), 'dark');
});

test('mood decays toward the recent side', () => {
  const m = new MoodMeter(1_000);
  m.add('sell', 1, 0);
  assert.equal(m.value(0), -1);
  m.add('buy', 1, 5_000); // old sell has decayed to ~3 %
  assert.ok(m.value(5_000) > 0.9);
});

test('chord tones are three distinct scale notes', () => {
  const notes = chordNotes(0, 'bright');
  assert.equal(new Set(notes).size, 3);
});

test('clock starts over after a big slot jump instead of bending the tempo', () => {
  const clock = new SlotClock();
  for (let i = 0; i < 50; i++) clock.observe(1_000 + i, i * 200);
  assert.equal(clock.resets, 0);
  // Reconnect to a node that is 10,000 slots ahead.
  for (let i = 0; i < 50; i++) clock.observe(11_000 + i, 20_000 + i * 200);
  assert.equal(clock.resets, 1);
  assert.ok(Math.abs(clock.slotMs - 200) < 1);
  assert.ok(Math.abs(clock.timeOf(11_050) - 30_000) < 5);
});

test('price melody: rising price climbs the scale, falling price descends', () => {
  const m = new PriceMelody();
  assert.equal(m.step(1e-7, 0), 0, 'the first trade sets the reference');
  const up = m.step(1e-7 * 1.03 ** 4, 1_000);
  assert.ok(up >= 3 && up <= 4, `+4 steps of 3 % -> about 4, got ${up}`);
  const down = m.step(1e-7 * 0.97 ** 3, 2_000);
  assert.ok(down < 0, `below the reference -> negative, got ${down}`);
});

test('price melody: the reference follows the price, so a plateau returns to the middle', () => {
  const m = new PriceMelody();
  m.step(1, 0);
  const jump = m.step(2, 1_000); // doubled
  assert.equal(jump, MUSIC.coin.maxStep, 'a doubling is clamped to the top of the range');
  let s: number = jump;
  for (let t = 2_000; t <= 20 * 60_000; t += 10_000) s = m.step(2, t);
  assert.equal(s, 0, 'after a long plateau the melody is back home');
});

test('price melody: missing prices keep the last step', () => {
  const m = new PriceMelody();
  m.step(1, 0);
  const s = m.step(1.1, 1_000);
  assert.equal(m.step(null, 2_000), s);
  assert.equal(m.step(0, 3_000), s);
});

test('in coin mode a sell sits an octave below a buy at the same price', () => {
  assert.equal(coinNote(0, 'neutral', 3, 'buy') - coinNote(0, 'neutral', 3, 'sell'), 12);
});
