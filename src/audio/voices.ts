/**
 * Synthesised instruments (plain Web Audio, no samples, no libraries).
 * Every voice schedules itself at an exact AudioContext time `t` and returns
 * its main source node so the engine can count active voices.
 */

let noiseBuffer: AudioBuffer | null = null;
function noise(ctx: BaseAudioContext): AudioBuffer {
  if (!noiseBuffer || noiseBuffer.sampleRate !== ctx.sampleRate) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

/** Stereo reverb impulse: decaying noise, slightly different per channel. */
export function makeImpulse(ctx: BaseAudioContext, seconds = 3.4, decay = 2.6): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay;
  }
  return buf;
}

function panTo(ctx: BaseAudioContext, dest: AudioNode, pan: number): AudioNode {
  if (pan === 0) return dest;
  const p = ctx.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  p.connect(dest);
  return p;
}

/** Gain node with an attack/exponential-decay envelope. */
function envelope(ctx: BaseAudioContext, dest: AudioNode, t: number, peak: number, attack: number, decay: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(dest);
  return g;
}

function osc(ctx: BaseAudioContext, type: OscillatorType, freq: number, dest: AudioNode, t: number, end: number): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.connect(dest);
  o.start(t);
  o.stop(end);
  return o;
}

/** Buys on the bonding curve: a celesta-like FM bell (BitListen's signature sound). */
export function bell(ctx: BaseAudioContext, dest: AudioNode, t: number, freq: number, vel: number, pan: number): AudioScheduledSourceNode {
  const out = panTo(ctx, dest, pan);
  const dur = 0.9 + vel * 2.2;
  const g = envelope(ctx, out, t, 0.2 * vel + 0.03, 0.004, dur);
  const carrier = osc(ctx, 'sine', freq, g, t, t + dur + 0.05);

  // FM shimmer that dies away quickly, leaving an almost pure tone.
  const modGain = ctx.createGain();
  modGain.gain.setValueAtTime(freq * (0.6 + vel), t);
  modGain.gain.exponentialRampToValueAtTime(0.01, t + 0.35);
  modGain.connect(carrier.frequency);
  osc(ctx, 'sine', freq * 3.5, modGain, t, t + 0.4);

  const g2 = envelope(ctx, out, t, 0.05 * vel, 0.002, dur * 0.4);
  osc(ctx, 'sine', freq * 2, g2, t, t + dur * 0.4 + 0.05);
  return carrier;
}

/** Sells on the bonding curve: a plucked, darker string, like the strings in Listen to Wikipedia. */
/**
 * Sells: a muffled, darker string. The filter opens less and closes fast,
 * the attack is softer than the bell's, and a quiet minor third underneath
 * gives it a sombre colour.
 */
export function pluck(ctx: BaseAudioContext, dest: AudioNode, t: number, freq: number, vel: number, pan: number): AudioScheduledSourceNode {
  const out = panTo(ctx, dest, pan);
  const dur = 0.6 + vel * 1.4;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 1.6;
  lp.frequency.setValueAtTime(Math.min(3_500, freq * (2.2 + vel * 2.5)), t);
  lp.frequency.exponentialRampToValueAtTime(Math.max(90, freq * 0.9), t + 0.25);
  const g = envelope(ctx, out, t, 0.18 * vel + 0.04, 0.008, dur);
  lp.connect(g);
  const main = osc(ctx, 'sawtooth', freq, lp, t, t + dur + 0.05);
  osc(ctx, 'triangle', freq * 0.5, lp, t, t + dur + 0.05);
  const third = ctx.createGain();
  third.gain.value = 0.35;
  third.connect(lp);
  osc(ctx, 'triangle', freq * 2 ** (-9 / 12), third, t, t + dur + 0.05); // minor third below, an octave down
  return main;
}

/**
 * Rug pull alarm: a church-organ cluster that doesn't resolve. Drawbar-style
 * sine partials with a tremolo, a dissonant chord (root, minor second,
 * tritone, minor ninth), louder than everything else, and at the end the
 * pitch sags like an organ losing its air.
 */
export function organ(ctx: BaseAudioContext, dest: AudioNode, t: number, rootHz: number): AudioScheduledSourceNode {
  const attack = 0.06;
  const hold = 2.4;
  const release = 1.6;
  const end = t + attack + hold + release;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.22, t + attack);
  g.gain.setValueAtTime(0.22, t + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  // Leslie-like tremolo.
  const trem = ctx.createGain();
  trem.gain.value = 1;
  const depth = ctx.createGain();
  depth.gain.value = 0.22;
  osc(ctx, 'sine', 6.2, depth, t, end + 0.05);
  depth.connect(trem.gain);
  trem.connect(g);
  g.connect(dest);

  const chord = [0, 1, 6, 13].map((semi) => rootHz * 2 ** (semi / 12));
  const drawbars: [number, number][] = [[0.5, 0.7], [1, 1], [2, 0.6], [3, 0.35], [4, 0.25]];
  let main: AudioScheduledSourceNode | null = null;
  for (const f of chord) {
    for (const [mult, level] of drawbars) {
      const lv = ctx.createGain();
      lv.gain.value = level / chord.length;
      lv.connect(trem);
      const o = osc(ctx, 'sine', f * mult, lv, t, end + 0.05);
      o.detune.setValueAtTime(0, t + attack + hold);
      o.detune.linearRampToValueAtTime(-120, end);
      main ??= o;
    }
  }
  return main!;
}

/** Graduated coins on PumpSwap: a warm electric piano; sells are filtered darker. */
export function epiano(ctx: BaseAudioContext, dest: AudioNode, t: number, freq: number, vel: number, pan: number, dark: boolean): AudioScheduledSourceNode {
  const out = panTo(ctx, dest, pan);
  const dur = 1.2 + vel * 2;
  let target: AudioNode = out;
  if (dark) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(4_000, freq * 3);
    lp.connect(out);
    target = lp;
  }
  const g = envelope(ctx, target, t, 0.17 * vel + 0.03, 0.006, dur);
  const carrier = osc(ctx, 'sine', freq, g, t, t + dur + 0.05);
  const modGain = ctx.createGain();
  modGain.gain.setValueAtTime(freq * 0.9 * (0.5 + vel), t);
  modGain.gain.exponentialRampToValueAtTime(freq * 0.05, t + dur * 0.5);
  modGain.connect(carrier.frequency);
  osc(ctx, 'sine', freq, modGain, t, t + dur + 0.05);
  const g2 = envelope(ctx, target, t, 0.04 * vel, 0.01, dur * 0.6);
  osc(ctx, 'sine', freq * 2.01, g2, t, t + dur * 0.6 + 0.05);
  return carrier;
}

/** A coin is born: a quick, quiet upward arpeggio high in the sky. */
export function sparkle(ctx: BaseAudioContext, dest: AudioNode, t: number, freqs: number[], pan: number): AudioScheduledSourceNode {
  const out = panTo(ctx, dest, pan);
  let first: AudioScheduledSourceNode | null = null;
  freqs.forEach((f, i) => {
    const s = t + i * 0.07;
    const g = envelope(ctx, out, s, 0.06, 0.003, 0.9);
    const o = osc(ctx, 'sine', f, g, s, s + 1);
    first ??= o;
  });
  return first!;
}

/** Bonding curve complete: a bright rising fifth. */
export function chime(ctx: BaseAudioContext, dest: AudioNode, t: number, freq: number): AudioScheduledSourceNode {
  const a = bell(ctx, dest, t, freq, 0.8, -0.2);
  bell(ctx, dest, t + 0.18, freq * 1.5, 0.8, 0.2);
  return a;
}

/** Graduation: the big string swell, BitListen's "new block" moment. */
export function swell(ctx: BaseAudioContext, dest: AudioNode, t: number, chordHz: number[], rootHz: number): AudioScheduledSourceNode {
  const attack = 1.4;
  const hold = 1.2;
  const release = 3.8;
  const end = t + attack + hold + release;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.8;
  lp.frequency.setValueAtTime(300, t);
  lp.frequency.exponentialRampToValueAtTime(2_600, t + attack);
  lp.frequency.exponentialRampToValueAtTime(500, end);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.06, t + attack);
  g.gain.setValueAtTime(0.06, t + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  lp.connect(g);
  g.connect(dest);

  let main: AudioScheduledSourceNode | null = null;
  for (const f of [...chordHz, ...chordHz.map((x) => x * 2)]) {
    for (const detune of [-7, 7]) {
      const o = osc(ctx, 'sawtooth', f, lp, t, end + 0.05);
      o.detune.value = detune;
      main ??= o;
    }
  }

  // Low gong underneath: inharmonic FM, slow decay.
  const gg = envelope(ctx, dest, t, 0.16, 0.02, 4.5);
  const carrier = osc(ctx, 'sine', rootHz / 2, gg, t, t + 4.6);
  const mg = ctx.createGain();
  mg.gain.setValueAtTime(rootHz * 0.8, t);
  mg.gain.exponentialRampToValueAtTime(1, t + 3);
  mg.connect(carrier.frequency);
  osc(ctx, 'sine', (rootHz / 2) * 1.41, mg, t, t + 4.6);
  return main!;
}

/** Whale trade: a sub-bass drop under the regular note. */
export function sub(ctx: BaseAudioContext, dest: AudioNode, t: number, freq: number, vel: number): AudioScheduledSourceNode {
  const g = envelope(ctx, dest, t, 0.35 * vel, 0.01, 1.8);
  const o = osc(ctx, 'sine', freq, g, t, t + 1.9);
  o.frequency.exponentialRampToValueAtTime(freq * 0.85, t + 1.8);
  return o;
}

/** Leader-window downbeat: a soft heartbeat. */
export function kick(ctx: BaseAudioContext, dest: AudioNode, t: number, vel: number): AudioScheduledSourceNode {
  const g = envelope(ctx, dest, t, 0.5 * vel, 0.002, 0.28);
  const o = osc(ctx, 'sine', 110, g, t, t + 0.32);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
  return o;
}

function noiseBurst(ctx: BaseAudioContext, dest: AudioNode, t: number, filter: BiquadFilterType, freq: number, peak: number, len: number, q = 0.7): AudioScheduledSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  const f = ctx.createBiquadFilter();
  f.type = filter;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = envelope(ctx, dest, t, peak, 0.001, len);
  src.connect(f);
  f.connect(g);
  // Random start so consecutive bursts don't sound identical.
  src.start(t, Math.random() * 0.8, len + 0.02);
  return src;
}

/** Every other slot: a tiny hi-hat tick. */
export function tick(ctx: BaseAudioContext, dest: AudioNode, t: number, vel: number): AudioScheduledSourceNode {
  return noiseBurst(ctx, dest, t, 'highpass', 7_000, 0.05 * vel, 0.03);
}

/** A skipped slot (leader missed its turn): a short digital stutter. */
export function glitch(ctx: BaseAudioContext, dest: AudioNode, t: number): AudioScheduledSourceNode {
  const first = noiseBurst(ctx, dest, t, 'bandpass', 1_200 + Math.random() * 1_600, 0.4, 0.025, 8);
  noiseBurst(ctx, dest, t + 0.05, 'bandpass', 900 + Math.random() * 1_600, 0.28, 0.02, 8);
  return first;
}

/** Failed transaction (mostly bots losing a race): a barely audible click. */
export function ghost(ctx: BaseAudioContext, dest: AudioNode, t: number, pan: number): AudioScheduledSourceNode {
  return noiseBurst(ctx, panTo(ctx, dest, pan), t, 'highpass', 9_000, 0.035, 0.012);
}

/**
 * Ambient pad holding the current chord. Its brightness and level follow the
 * overall trading activity, so a busy market literally sounds brighter.
 */
export class Pad {
  private readonly voices: OscillatorNode[][] = [];
  private readonly filter: BiquadFilterNode;
  private readonly gain: GainNode;

  constructor(private readonly ctx: BaseAudioContext, dest: AudioNode, freqs: number[]) {
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 400;
    this.filter.Q.value = 0.5;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0.0001;
    this.filter.connect(this.gain);
    this.gain.connect(dest);
    const now = ctx.currentTime;
    for (const f of freqs) {
      const pair = [-6, 6].map((detune) => {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = f;
        o.detune.value = detune;
        o.connect(this.filter);
        o.start(now);
        return o;
      });
      this.voices.push(pair);
    }
    this.gain.gain.setTargetAtTime(0.03, now, 2);
  }

  /** Glide to a new chord over ~1 s. */
  setChord(freqs: number[], t: number): void {
    freqs.forEach((f, i) => {
      for (const o of this.voices[i] ?? []) o.frequency.setTargetAtTime(f, t, 0.35);
    });
  }

  /** activity 0..1 */
  setActivity(activity: number, t: number): void {
    const a = Math.max(0, Math.min(1, activity));
    this.filter.frequency.setTargetAtTime(350 + a * 2_200, t, 1.2);
    this.gain.gain.setTargetAtTime(0.02 + a * 0.035, t, 1.2);
  }

  stop(): void {
    const t = this.ctx.currentTime;
    this.gain.gain.setTargetAtTime(0.0001, t, 0.3);
    for (const pair of this.voices) for (const o of pair) o.stop(t + 1.5);
  }
}
