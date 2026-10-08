// Number Writing: a dotted outline of a digit is shown on the laptop and you trace it with
// the phone as a pen. The part you have traced fills with green. Finish the outline
// (93%) to move on to the next digit; ten digits, 0 to 9, make a round.
//
// Pen position comes from the same gyro aim mapping as the blade (see main.ts).
// Score per digit (max 100): up to 60 for staying on the line, up to 40 for speed.
// Press Start while playing to skip a digit.

import { cover, DIGITS, dist, GLYPH_W, nearPath, resample, type P } from '../shared/digits';
import type { GameState } from '../shared/protocol';
import type { Sfx } from './audio';
import type { GameHooks, Scene } from './scene';

const DIGIT_COUNT = 10;
const DONE_AT = 0.93; // share of the outline that must be traced
const HIT = 0.07; // pen radius as a share of the digit height
const STEP = 0.03; // spacing of the points that make up an outline (share of the digit height)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}
interface FloatText {
  text: string;
  x: number;
  y: number;
  life: number;
  color: string;
}

export class WriteGame implements Scene {
  readonly title = 'Number Writing';
  readonly subtitle = 'Trace the number with your gyro pen.';
  state: GameState = 'menu';
  score = 0;
  best = 0;
  /** Digits still to write (shown as "Digits left" on the phone). */
  lives = DIGIT_COUNT;

  private ctx: CanvasRenderingContext2D;
  private w = 800;
  private h = 600;
  private lastFrame = 0;
  private time = 0;

  // the digit on screen
  private idx = 0;
  private npts: P[] = []; // outline points, unit box
  private strokeOf: number[] = [];
  private path: P[] = []; // the same in pixels
  private done = new Uint8Array(0);
  private covered = 0;
  private phase: 'tracing' | 'done' = 'tracing';
  private doneT = 0;
  private digitTime = 0;
  private inkLen = 0;
  private onLen = 0;
  private H = 300; // digit height in px
  private ox = 0;
  private oy = 0;
  private R = 20; // pen/line radius in px

  // pen
  private target: P | null = null;
  private pen: P | null = null;
  private prev: P | null = null;
  private trail: { x: number; y: number; t: number }[] = [];
  private onLine = false;

  // round
  private stars: number[] = []; // per digit: 0 = not done, -1 = skipped, 1-3
  private particles: Particle[] = [];
  private texts: FloatText[] = [];
  private overAt = -10;

  constructor(
    private canvas: HTMLCanvasElement,
    private sfx: Sfx,
    private hooks: GameHooks,
  ) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('Canvas 2D is not available');
    this.ctx = c;
    try {
      this.best = Number(localStorage.getItem('bestWrite') ?? 0) || 0;
    } catch {
      /* ignore */
    }
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // ---------------------------------------------------------------- scene API
  enter(): void {
    this.resize();
    this.idx = 0;
    this.stars = [];
    this.score = 0;
    this.lives = DIGIT_COUNT;
    this.particles = [];
    this.texts = [];
    this.trail = [];
    this.lastFrame = 0;
    this.loadDigit(0);
    this.setState('menu');
  }

  exit(): void {
    this.target = null;
  }

  /** Start / play again / resume; while playing it skips the current digit. */
  requestStart(): void {
    if (this.state === 'menu' || this.state === 'over') {
      if (this.state === 'over' && this.time - this.overAt < 0.8) return;
      this.startRound();
    } else if (this.state === 'paused') this.setState('playing');
    else if (this.state === 'playing' && this.phase === 'tracing' && this.digitTime > 0.8) this.skip();
  }

  togglePause(): void {
    if (this.state === 'playing') this.setState('paused');
    else if (this.state === 'paused') this.setState('playing');
  }

  /** Pen position in screen pixels (from the phone's aim, or the mouse). */
  penMove(x: number, y: number, _now: number): void {
    this.target = { x: clamp(x, 0, this.w), y: clamp(y, 0, this.h) };
  }

  tick(t: number): void {
    const dt = Math.min(0.05, this.lastFrame ? (t - this.lastFrame) / 1000 : 0.016);
    this.lastFrame = t;
    this.update(dt);
    this.render();
  }

  // ---------------------------------------------------------------- setup
  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.floor(this.w * dpr);
    this.canvas.height = Math.floor(this.h * dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.layout();
  }

  /** Horizontal centre of the digit: right of the pairing card on wide screens. */
  private get cx(): number {
    return this.w >= 1000 ? this.w * 0.62 : this.w / 2;
  }

  /** How far right of the screen centre the digit sits (the phone's centre maps to the digit). */
  get shiftX(): number {
    return this.cx - this.w / 2;
  }

  /** Where the digit sits: centred, clear of the title above and the pairing card below. */
  private layout(): void {
    this.H = clamp(this.h * 0.44, 180, 520);
    this.ox = this.cx - (GLYPH_W * this.H) / 2;
    this.oy = this.h * 0.25;
    this.R = this.H * HIT;
    this.path = this.npts.map((p) => ({ x: this.ox + p.x * this.H, y: this.oy + p.y * this.H }));
  }

  private loadDigit(i: number): void {
    const r = resample(DIGITS[i]!, STEP);
    this.npts = r.pts;
    this.strokeOf = r.stroke;
    this.done = new Uint8Array(r.pts.length);
    this.covered = 0;
    this.phase = 'tracing';
    this.digitTime = 0;
    this.inkLen = 0;
    this.onLen = 0;
    this.prev = this.pen ? { ...this.pen } : null;
    this.layout();
  }

  private setState(s: GameState): void {
    this.state = s;
    document.body.dataset.state = s;
    this.hooks.onChange();
  }

  private startRound(): void {
    this.score = 0;
    this.idx = 0;
    this.stars = [];
    this.lives = DIGIT_COUNT;
    this.particles = [];
    this.texts = [];
    this.loadDigit(0);
    this.sfx.start();
    this.setState('playing');
  }

  private skip(): void {
    this.stars[this.idx] = -1;
    this.sfx.miss();
    this.next();
  }

  private next(): void {
    this.idx++;
    this.lives = DIGIT_COUNT - this.idx;
    if (this.idx >= DIGIT_COUNT) {
      if (this.score > this.best) {
        this.best = this.score;
        try {
          localStorage.setItem('bestWrite', String(this.best));
        } catch {
          /* ignore */
        }
      }
      this.overAt = this.time;
      this.sfx.bowl();
      this.idx = DIGIT_COUNT - 1; // keep the last digit on screen behind the summary
      this.setState('over');
      return;
    }
    this.loadDigit(this.idx);
    this.hooks.onChange();
  }

  private finishDigit(): void {
    const acc = this.inkLen > 0 ? clamp(this.onLen / this.inkLen, 0, 1) : 1;
    const accPts = Math.round(60 * acc);
    const speedPts = Math.round(40 * clamp(1 - (this.digitTime - 6) / 24, 0, 1));
    const pts = accPts + speedPts;
    this.score += pts;
    this.stars[this.idx] = acc >= 0.85 ? 3 : acc >= 0.7 ? 2 : 1;
    this.done.fill(1);
    this.covered = this.done.length;
    this.phase = 'done';
    this.doneT = 1.2;
    this.sfx.coin();
    this.hooks.onHaptic(30);
    const cx = this.ox + (GLYPH_W * this.H) / 2;
    const cy = this.oy + this.H / 2;
    this.texts.push({ text: `+${pts}`, x: cx, y: cy, life: 1.2, color: '#ffe066' });
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = (80 + Math.random() * 260) * (this.H / 400);
      this.particles.push({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, life: 0.7 + Math.random() * 0.5, color: ['#7be495', '#78dcff', '#ffe066', '#ff9f1c'][i % 4]! });
    }
    this.hooks.onChange();
  }

  // ---------------------------------------------------------------- update
  private update(dt: number): void {
    if (this.state === 'paused') return;
    this.time += dt;

    // pen: smoothed more when still, almost raw when moving fast
    if (this.target) {
      if (!this.pen) this.pen = { ...this.target };
      const d = dist(this.pen, this.target);
      const speed = d / Math.max(dt, 0.001);
      const a = clamp(0.18 + speed / 2500, 0.18, 0.85);
      this.pen = { x: this.pen.x + (this.target.x - this.pen.x) * a, y: this.pen.y + (this.target.y - this.pen.y) * a };
      this.trail.push({ x: this.pen.x, y: this.pen.y, t: this.time });
    }
    while (this.trail.length && this.time - this.trail[0]!.t > 0.9) this.trail.shift();

    this.onLine = this.pen ? nearPath(this.path, this.pen, this.R * 1.15) : false;

    if (this.state === 'playing' && this.phase === 'tracing') {
      this.digitTime += dt;
      if (this.pen && this.prev) {
        const len = dist(this.prev, this.pen);
        if (len > 0.5) {
          this.inkLen += len;
          if (this.onLine) this.onLen += len;
          this.covered += cover(this.path, this.done, this.prev, this.pen, this.R);
          if (this.covered / this.done.length >= DONE_AT) this.finishDigit();
        }
      }
    }
    this.prev = this.pen ? { ...this.pen } : null;

    if (this.state === 'playing' && this.phase === 'done') {
      this.doneT -= dt;
      if (this.doneT <= 0) this.next();
    }

    for (const p of this.particles) {
      p.vy += 500 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const t of this.texts) {
      t.life -= dt;
      t.y -= 50 * dt;
    }
    this.texts = this.texts.filter((t) => t.life > 0);
  }

  // ---------------------------------------------------------------- drawing
  private strokePolys(): P[][] {
    return DIGITS[this.idx]!.map((s) => s.map((p) => ({ x: this.ox + p.x * this.H, y: this.oy + p.y * this.H })));
  }

  private render(): void {
    const c = this.ctx;
    const { w, h, R } = this;
    c.clearRect(0, 0, w, h);
    const bg = c.createRadialGradient(w / 2, h * 0.4, 0, w / 2, h * 0.4, Math.max(w, h) * 0.75);
    bg.addColorStop(0, '#2b2040');
    bg.addColorStop(1, '#120b1c');
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);

    // writing card
    const padX = this.H * 0.35;
    const padY = this.H * 0.1;
    c.fillStyle = 'rgba(255,255,255,0.045)';
    c.strokeStyle = 'rgba(255,255,255,0.1)';
    c.lineWidth = 1;
    this.roundRect(this.ox - padX, this.oy - padY, GLYPH_W * this.H + padX * 2, this.H + padY * 2, 28);
    c.fill();
    c.stroke();

    const polys = this.strokePolys();
    c.lineCap = 'round';
    c.lineJoin = 'round';

    // guide band + dashed centre line
    c.strokeStyle = 'rgba(255,255,255,0.1)';
    c.lineWidth = R * 2;
    for (const s of polys) this.line(s);
    c.strokeStyle = 'rgba(255,255,255,0.4)';
    c.lineWidth = 2;
    c.setLineDash([6, 10]);
    for (const s of polys) this.line(s);
    c.setLineDash([]);

    // traced part
    c.strokeStyle = 'rgba(123,228,149,0.9)';
    c.fillStyle = 'rgba(123,228,149,0.9)';
    c.lineWidth = R * 1.5;
    for (let i = 0; i < this.path.length; i++) {
      if (!this.done[i]) continue;
      const p = this.path[i]!;
      c.beginPath();
      if (i > 0 && this.done[i - 1] && this.strokeOf[i - 1] === this.strokeOf[i]) {
        const q = this.path[i - 1]!;
        c.moveTo(q.x, q.y);
        c.lineTo(p.x, p.y);
        c.stroke();
      } else {
        c.arc(p.x, p.y, R * 0.75, 0, Math.PI * 2);
        c.fill();
      }
    }

    // stroke starts (numbered) and the demo dot
    if (this.phase === 'tracing') {
      const seen = new Set<number>();
      for (let i = 0; i < this.path.length; i++) {
        const si = this.strokeOf[i]!;
        if (seen.has(si)) continue;
        seen.add(si);
        if (this.done[i]) continue;
        const p = this.path[i]!;
        c.fillStyle = '#78dcff';
        c.beginPath();
        c.arc(p.x, p.y, R * 0.62, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = '#08202b';
        c.font = `800 ${Math.round(R * 0.8)}px system-ui, sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(String(si + 1), p.x, p.y + 1);
      }
      if ((this.state === 'menu' || this.covered === 0) && this.path.length) {
        const k = Math.floor(((this.time * 0.5) % 1) * this.path.length);
        const p = this.path[k]!;
        c.fillStyle = `rgba(255,224,102,${0.65 + 0.35 * Math.sin(this.time * 8)})`;
        c.beginPath();
        c.arc(p.x, p.y, R * 0.45, 0, Math.PI * 2);
        c.fill();
      }
    }

    // ink trail and pen
    if (this.trail.length > 1) {
      for (let i = 1; i < this.trail.length; i++) {
        const a = this.trail[i - 1]!;
        const b = this.trail[i]!;
        const age = clamp(1 - (this.time - b.t) / 0.9, 0, 1);
        c.strokeStyle = `rgba(120,220,255,${0.55 * age})`;
        c.lineWidth = R * 0.45 * (0.4 + 0.6 * age);
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
      }
    }
    if (this.pen) {
      c.strokeStyle = this.onLine ? 'rgba(123,228,149,0.9)' : 'rgba(255,255,255,0.55)';
      c.lineWidth = 2;
      c.beginPath();
      c.arc(this.pen.x, this.pen.y, R, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = '#fff';
      c.beginPath();
      c.arc(this.pen.x, this.pen.y, Math.max(4, R * 0.22), 0, Math.PI * 2);
      c.fill();
    }

    // effects
    for (const p of this.particles) {
      c.globalAlpha = clamp(p.life * 2, 0, 1);
      c.fillStyle = p.color;
      c.fillRect(p.x - 3, p.y - 3, 6, 6);
    }
    c.globalAlpha = 1;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (const t of this.texts) {
      c.globalAlpha = clamp(t.life * 2, 0, 1);
      c.fillStyle = t.color;
      c.font = '800 44px system-ui, sans-serif';
      c.fillText(t.text, t.x, t.y);
    }
    c.globalAlpha = 1;

    this.hud();
  }

  private hud(): void {
    const c = this.ctx;
    const { w, h } = this;
    c.textBaseline = 'middle';

    // progress strip (bottom right, clear of the pairing card)
    const cell = clamp(w * 0.028, 30, 44);
    const gap = 6;
    const total = DIGIT_COUNT * cell + (DIGIT_COUNT - 1) * gap;
    const x0 = w - 24 - total;
    const y0 = h - 24 - cell - 16;
    for (let i = 0; i < DIGIT_COUNT; i++) {
      const x = x0 + i * (cell + gap);
      const st = this.stars[i] ?? 0;
      const cur = i === this.idx && this.state !== 'over';
      c.fillStyle = st > 0 ? 'rgba(123,228,149,0.25)' : st < 0 ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.08)';
      c.strokeStyle = cur ? '#78dcff' : st > 0 ? 'rgba(123,228,149,0.7)' : 'rgba(255,255,255,0.14)';
      c.lineWidth = cur ? 2.5 : 1;
      this.roundRect(x, y0, cell, cell, 8);
      c.fill();
      c.stroke();
      c.fillStyle = st > 0 ? '#7be495' : 'rgba(255,255,255,0.7)';
      c.font = `700 ${Math.round(cell * 0.5)}px system-ui, sans-serif`;
      c.textAlign = 'center';
      c.fillText(String(i), x + cell / 2, y0 + cell / 2 + 1);
      if (st > 0) {
        c.fillStyle = '#ffe066';
        c.font = `${Math.round(cell * 0.3)}px system-ui, sans-serif`;
        c.fillText('★'.repeat(st), x + cell / 2, y0 + cell + 10);
      }
    }

    if (this.state === 'playing' || this.state === 'paused') {
      c.fillStyle = 'rgba(255,255,255,0.85)';
      c.font = '700 22px system-ui, sans-serif';
      c.textAlign = 'left';
      c.fillText(`Digit ${this.idx + 1} of ${DIGIT_COUNT}`, 28, 36);
      c.textAlign = 'right';
      c.fillText(`Score ${this.score}`, w - 170, 36);
      const pct = Math.round((this.covered / Math.max(1, this.done.length)) * 100);
      const mx = this.cx;
      const my = this.oy + this.H + this.H * 0.2;
      c.textAlign = 'center';
      c.fillStyle = 'rgba(255,255,255,0.6)';
      c.font = '600 18px system-ui, sans-serif';
      c.fillText(`${Math.min(100, pct)}% traced`, mx, my);
      c.fillStyle = 'rgba(255,255,255,0.4)';
      c.font = '500 14px system-ui, sans-serif';
      c.fillText('Start on the blue dot and follow the line.', mx, my + 24);
      c.fillText('Start button = skip this digit.', mx, my + 44);
    } else if (this.state === 'menu') {
      const mx = this.cx;
      const my = this.oy + this.H + this.H * 0.2;
      c.textAlign = 'center';
      c.fillStyle = '#fff';
      c.font = '700 22px system-ui, sans-serif';
      c.fillText('Press Start, then trace the number', mx, my);
      c.fillStyle = 'rgba(255,255,255,0.6)';
      c.font = '500 15px system-ui, sans-serif';
      c.fillText('Hold the phone like a pen, point it at the screen,', mx, my + 28);
      c.fillText('press Centre.' + (this.best ? `  Best: ${this.best}` : ''), mx, my + 48);
    }

    if (this.state === 'paused') this.banner('Paused', 'Press Start or P to continue');
    if (this.state === 'over') {
      const got = this.stars.filter((s) => s > 0).length;
      this.banner(`Round done: ${this.score} points`, `${got} of ${DIGIT_COUNT} digits written${this.score >= this.best && this.score > 0 ? ' · new best!' : ` · best ${this.best}`} · Press Start to play again`);
    }
  }

  private banner(title: string, sub: string): void {
    const c = this.ctx;
    c.fillStyle = 'rgba(18,11,28,0.78)';
    c.fillRect(0, 0, this.w, this.h);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#fff';
    c.font = `800 ${Math.round(clamp(this.w * 0.04, 32, 56))}px system-ui, sans-serif`;
    c.fillText(title, this.cx, this.h * 0.42);
    c.fillStyle = 'rgba(255,255,255,0.7)';
    c.font = '500 20px system-ui, sans-serif';
    c.fillText(sub, this.cx, this.h * 0.42 + 46);
  }

  private line(s: P[]): void {
    const c = this.ctx;
    c.beginPath();
    s.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
    c.stroke();
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
}
