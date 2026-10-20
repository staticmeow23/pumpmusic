import type { SlotMark, VisualNote } from '../audio/engine';
import type { Mode } from '../audio/theory';

interface Bubble {
  x: number;
  y: number;
  r: number;
  born: number;
  life: number;
  note: VisualNote;
}

interface Wave {
  x: number;
  y: number;
  born: number;
  life: number;
  maxR: number;
  color: string;
  width: number;
}

export interface Ambience {
  mode: Mode;
  activity: number;
}

const COLORS = {
  buy: '94, 234, 212', // teal
  sell: '251, 113, 133', // rose
  create: '216, 180, 254', // lilac
  gold: '252, 211, 77',
  failed: '148, 163, 184',
};
const MAX_BUBBLES = 600;

/**
 * BitListen-style canvas: every trade appears as a bubble when its note
 * sounds, sized by trade size, placed where you hear it (left/right = stereo
 * pan, up/down = pitch), then drifts up and fades.
 */
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private pending: VisualNote[] = [];
  private bubbles: Bubble[] = [];
  private waves: Wave[] = [];
  private marks: SlotMark[] = [];
  private headline: { text: string; born: number } | null = null;
  private frame = 0;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private beatFlash = 0;
  private hover: Bubble | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ambience: () => Ambience,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
  }

  push(note: VisualNote): void {
    this.pending.push(note);
    if (this.pending.length > 2_000) this.pending.splice(0, this.pending.length - 2_000);
  }

  slot(mark: SlotMark): void {
    this.marks.push(mark);
    if (this.marks.length > 200) this.marks.splice(0, this.marks.length - 200);
  }

  start(): void {
    if (this.frame) return;
    const loop = () => {
      this.draw(performance.now());
      this.frame = requestAnimationFrame(loop);
    };
    this.frame = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.pending = [];
    this.bubbles = [];
    this.waves = [];
    this.marks = [];
    this.headline = null;
    this.draw(performance.now());
  }

  /** The clickable bubble under the pointer, if any (also sets the hover ring). */
  hitTest(x: number, y: number): VisualNote | null {
    const b = this.bubbleAt(x, y);
    this.hover = b;
    return b?.note ?? null;
  }

  private bubbleAt(x: number, y: number): Bubble | null {
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i]!;
      const r = Math.max(b.r, 10);
      if ((x - b.x) ** 2 + (y - b.y) ** 2 <= r * r && (b.note.link || b.note.coin)) return b;
    }
    return null;
  }

  private spawn(n: VisualNote, now: number): void {
    const w = this.width;
    const h = this.height;
    const scale = Math.min(w, h) / 900;
    const margin = 60;
    const x = Math.max(margin, Math.min(w - margin, w / 2 + n.pan * (w / 2 - margin) * 0.9 + (Math.random() - 0.5) * w * 0.12));
    const yBand = h - 140;
    // Mostly random like BitListen, nudged by pitch so low notes tend to sit lower.
    const y = Math.max(margin, Math.min(h - 120, 60 + ((1 - n.pitch) * 0.45 + Math.random() * 0.55) * yBand));

    if (n.kind === 'migrate') {
      if (n.faint) return;
      this.waves.push({ x: w / 2, y: h / 2, born: now, life: 5_000, maxR: Math.hypot(w, h) * 0.6, color: COLORS.gold, width: 3 });
      this.headline = { text: n.label ?? 'graduated', born: now };
      return;
    }
    if (n.kind === 'complete' && !n.faint) {
      this.waves.push({ x, y, born: now, life: 2_500, maxR: 220 * scale + 80, color: COLORS.gold, width: 2 });
    }
    if (n.whale && !n.faint) {
      this.waves.push({ x, y, born: now, life: 2_200, maxR: 260 * scale + 60, color: n.kind === 'sell' ? COLORS.sell : COLORS.buy, width: 1.5 });
    }

    // Most trades are small: keep them small and short-lived so the big ones stand out.
    const r = n.kind === 'failed' ? 2 : n.kind === 'create' ? 7 : 4 + n.size ** 1.7 * 78 * scale;
    const life = n.kind === 'failed' ? 600 : n.kind === 'create' ? 5_000 : 3_000 + n.size ** 1.5 * 7_000;
    this.bubbles.push({ x, y, r, born: now, life, note: n });
    if (this.bubbles.length > MAX_BUBBLES) this.bubbles.splice(0, this.bubbles.length - MAX_BUBBLES);
  }

  private draw(now: number): void {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Release notes whose time has come; skip ones that went stale while the tab was hidden.
    if (this.pending.length) {
      const keep: VisualNote[] = [];
      for (const n of this.pending) {
        if (n.at > now) keep.push(n);
        else if (now - n.at < 1_500) this.spawn(n, now);
      }
      this.pending = keep;
    }
    for (const m of this.marks) {
      if (m.at <= now && now - m.at < 60 && m.downbeat) this.beatFlash = 1;
    }

    this.drawBackground(now);

    // Waves
    this.waves = this.waves.filter((wv) => now - wv.born < wv.life);
    for (const wv of this.waves) {
      const p = (now - wv.born) / wv.life;
      const ease = 1 - (1 - p) ** 3;
      ctx.beginPath();
      ctx.arc(wv.x, wv.y, 10 + ease * wv.maxR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${wv.color}, ${0.55 * (1 - p)})`;
      ctx.lineWidth = wv.width;
      ctx.stroke();
    }

    // Bubbles
    this.bubbles = this.bubbles.filter((b) => now - b.born < b.life);
    for (const b of this.bubbles) this.drawBubble(b, now);

    if (this.headline) this.drawHeadline(now);
    this.drawSlotStrip(now);
    this.beatFlash *= 0.9;
  }

  private drawBackground(now: number): void {
    const { ctx, width: w, height: h } = this;
    const amb = this.ambience();
    const tint = amb.mode === 'bright' ? '40, 70, 90' : amb.mode === 'dark' ? '50, 30, 70' : '30, 40, 80';
    ctx.fillStyle = '#070a14';
    ctx.fillRect(0, 0, w, h);
    const g = ctx.createRadialGradient(w / 2, h * 0.55, 0, w / 2, h * 0.55, Math.max(w, h) * 0.75);
    const glow = 0.25 + Math.min(1, amb.activity) * 0.35 + this.beatFlash * 0.06;
    g.addColorStop(0, `rgba(${tint}, ${glow})`);
    g.addColorStop(1, 'rgba(7, 10, 20, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    void now;
  }

  private drawBubble(b: Bubble, now: number): void {
    const { ctx } = this;
    const n = b.note;
    const age = now - b.born;
    const p = age / b.life;
    // Pop in with a little overshoot, then drift upward and fade.
    const pop = age < 260 ? 0.3 + 0.75 * Math.sin((age / 260) * (Math.PI * 0.6)) / Math.sin(Math.PI * 0.6) : 1;
    const r = b.r * Math.min(pop, 1.05);
    const y = b.y - age * 0.006;
    // Coins outside the focus stay visible as faint context, like silent edits in Listen to Wikipedia.
    const alpha = Math.min(1, (1 - p) * 1.4) * (b === this.hover ? 1 : 0.9) * (n.faint ? 0.22 : 1);

    const color =
      n.kind === 'buy' ? COLORS.buy : n.kind === 'sell' ? COLORS.sell : n.kind === 'create' ? COLORS.create : n.kind === 'failed' ? COLORS.failed : COLORS.gold;

    if (n.kind === 'create') {
      // Four-pointed star for a newborn coin.
      const s = r * 1.6;
      ctx.save();
      ctx.translate(b.x, y);
      ctx.rotate(age / 1_500);
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const rad = i % 2 === 0 ? s : s * 0.3;
        const a = (i / 8) * Math.PI * 2;
        ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
      }
      ctx.closePath();
      ctx.fillStyle = `rgba(${color}, ${alpha * 0.9})`;
      ctx.fill();
      ctx.restore();
      if (n.label && !n.faint) this.drawLabel(n.label, b.x, y + s + 12, 11, alpha * 0.85, color);
      return;
    }

    ctx.beginPath();
    ctx.arc(b.x, y, Math.max(r, 1), 0, Math.PI * 2);
    if (n.venue === 'swap') {
      // Graduated coins: rings instead of filled bubbles.
      ctx.fillStyle = `rgba(${color}, ${alpha * 0.08})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${color}, ${alpha * 0.85})`;
      ctx.lineWidth = Math.max(1.2, r * 0.08);
      ctx.stroke();
    } else {
      const g = ctx.createRadialGradient(b.x - r * 0.3, y - r * 0.35, r * 0.1, b.x, y, r);
      g.addColorStop(0, `rgba(${color}, ${alpha * 0.55})`);
      g.addColorStop(1, `rgba(${color}, ${alpha * 0.18})`);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = `rgba(${color}, ${alpha * 0.6})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (b === this.hover) {
      ctx.beginPath();
      ctx.arc(b.x, y, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.6})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (n.label && r > 22 && !n.faint) this.drawLabel(n.label, b.x, y, Math.max(10, Math.min(20, r * 0.34)), alpha, '255, 255, 255');
  }

  private drawLabel(text: string, x: number, y: number, size: number, alpha: number, color: string): void {
    const { ctx } = this;
    ctx.font = `600 ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = `rgba(${color}, ${alpha})`;
    ctx.fillText(text, x, y);
  }

  private drawHeadline(now: number): void {
    const hl = this.headline!;
    const age = now - hl.born;
    if (age > 5_000) {
      this.headline = null;
      return;
    }
    const a = age < 400 ? age / 400 : age > 3_800 ? (5_000 - age) / 1_200 : 1;
    this.drawLabel(`🎓 ${hl.text}`, this.width / 2, this.height * 0.42, 30, a, COLORS.gold);
  }

  /** The heartbeat: one tick per slot, beats grouped by leader window, skipped slots in red. */
  private drawSlotStrip(now: number): void {
    const { ctx } = this;
    const shown = this.marks.filter((m) => m.at <= now).slice(-48);
    if (!shown.length) return;
    const cell = 9;
    const gap = 3;
    const total = shown.length * (cell + gap);
    const x0 = this.width / 2 - total / 2;
    const y0 = this.height - 34;
    shown.forEach((m, i) => {
      const age = now - m.at;
      const fresh = Math.max(0, 1 - age / 400);
      const hgt = m.downbeat ? 14 : 8;
      ctx.fillStyle = m.skipped
        ? `rgba(${COLORS.sell}, ${0.6 + fresh * 0.4})`
        : `rgba(226, 232, 240, ${0.18 + (m.downbeat ? 0.17 : 0) + fresh * 0.6})`;
      ctx.fillRect(x0 + i * (cell + gap) + (m.downbeat ? 0 : 2), y0 - hgt / 2, m.downbeat ? cell : cell - 4, hgt);
    });
    const last = shown[shown.length - 1]!;
    ctx.font = '500 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(226, 232, 240, 0.5)';
    ctx.fillText(`slot ${last.slot.toLocaleString('en-US')}`, this.width / 2, y0 + 12);
  }
}
