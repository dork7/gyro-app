import type { GameState } from '../shared/protocol';
import type { Sfx } from './audio';
import { Blade, type Segment } from './blade';
import { segmentHitsCircle } from './geometry';
import type { GameHooks, Scene } from './scene';

interface Kind {
  e: string;
  c: string;
}

const FRUITS: Kind[] = [
  { e: '🍉', c: '#ff4d6d' },
  { e: '🍊', c: '#ff9f1c' },
  { e: '🍎', c: '#e63946' },
  { e: '🍋', c: '#f4e04d' },
  { e: '🥝', c: '#8ac926' },
  { e: '🍍', c: '#ffd23f' },
  { e: '🍓', c: '#ff3860' },
  { e: '🍇', c: '#9d4edd' },
];
const BOMB: Kind = { e: '💣', c: '#ffb703' };
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

interface Fruit extends Kind {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  r: number;
  bomb: boolean;
}
interface Half extends Kind {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number; // current emoji rotation
  vr: number;
  phi: number; // cut line angle relative to the emoji
  side: 1 | -1;
  r: number;
  life: number;
}
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
}
interface FloatText {
  text: string;
  x: number;
  y: number;
  life: number;
  color: string;
  size: number;
}
interface Target extends Kind {
  x: number;
  y: number;
  r: number;
  label: string;
}

const MAX_LIVES = 3;
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class Game implements Scene {
  readonly title = 'Gyro Fruit Slicer';
  readonly subtitle = 'Your phone is the sword.';
  state: GameState = 'menu';
  score = 0;
  best = 0;
  lives = MAX_LIVES;
  w = 800;
  h = 600;
  readonly blade = new Blade();

  private ctx: CanvasRenderingContext2D;
  private sc = 1; // UI scale
  private R = 40; // base fruit radius
  private G = 1000; // gravity px/s²
  private time = 0;
  private playTime = 0;
  private waveTimer = 0;
  private spawnQueue: { t: number; bomb: boolean }[] = [];
  private fruits: Fruit[] = [];
  private halves: Half[] = [];
  private particles: Particle[] = [];
  private texts: FloatText[] = [];
  private segments: Segment[] = [];
  private target: Target | null = null;
  private comboCount = 0;
  private comboTimer = 0;
  private comboX = 0;
  private comboY = 0;
  private flash = 0;
  private overAt = 0;
  private lastFrame = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private sfx: Sfx,
    private hooks: GameHooks,
  ) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('Canvas 2D is not available');
    this.ctx = c;
    try {
      this.best = Number(localStorage.getItem('best') ?? 0) || 0;
    } catch {
      /* ignore */
    }
    this.resize();
    window.addEventListener('resize', () => this.resize());
    document.body.dataset.state = 'menu'; // no hook call yet: the caller isn't fully set up
  }

  // ---------------------------------------------------------------- setup
  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.floor(this.w * dpr);
    this.canvas.height = Math.floor(this.h * dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.sc = Math.max(0.6, Math.min(1.6, this.h / 800));
    this.R = Math.max(28, Math.min(64, this.h * 0.062));
    this.G = this.h * 1.6;
    if (this.target) this.placeTarget(this.target.label);
  }

  private placeTarget(label: string): void {
    // Slightly right of centre (keeps clear of the pairing card) and at mid height,
    // so a horizontal swipe from the calibrated centre pose crosses it.
    this.target = { ...FRUITS[0], x: this.w * 0.64, y: this.h * 0.5, r: this.R * 1.9, label };
  }

  private setState(s: GameState): void {
    this.state = s;
    document.body.dataset.state = s;
    this.hooks.onChange();
  }

  // ---------------------------------------------------------------- input
  /** Raw pointer position from the phone (or mouse). */
  pointerMove(x: number, y: number, now: number): void {
    const seg = this.blade.push(x, y, now);
    if (seg) {
      this.segments.push(seg);
      if (this.segments.length > 30) this.segments.shift();
    }
  }

  /** Start from menu/over, or resume from pause. */
  requestStart(): void {
    if (this.state === 'menu' || this.state === 'over') this.startGame();
    else if (this.state === 'paused') this.setState('playing');
  }

  togglePause(): void {
    if (this.state === 'playing') this.setState('paused');
    else if (this.state === 'paused') this.setState('playing');
  }

  startGame(): void {
    this.score = 0;
    this.lives = MAX_LIVES;
    this.playTime = 0;
    this.waveTimer = 0.7;
    this.spawnQueue = [];
    this.fruits = [];
    this.comboCount = 0;
    this.comboTimer = 0;
    this.target = null;
    this.segments = [];
    this.blade.clear();
    this.sfx.start();
    this.setState('playing');
  }

  private gameOver(): void {
    if (this.score > this.best) {
      this.best = this.score;
      try {
        localStorage.setItem('best', String(this.best));
      } catch {
        /* ignore */
      }
    }
    this.overAt = this.time;
    this.setState('over');
    this.placeTarget('Slice to play again');
  }

  // ---------------------------------------------------------------- loop
  /** Become the active scene: fresh menu, no leftovers from earlier play. */
  enter(): void {
    this.resize();
    this.fruits = [];
    this.halves = [];
    this.particles = [];
    this.texts = [];
    this.segments = [];
    this.spawnQueue = [];
    this.target = null;
    this.flash = 0;
    this.lastFrame = 0;
    this.blade.clear();
    this.setState('menu');
  }

  tick(t: number): void {
    const dt = Math.min(0.033, this.lastFrame ? (t - this.lastFrame) / 1000 : 0.016);
    this.lastFrame = t;
    this.update(dt);
    this.render(t);
  }

  private update(dt: number): void {
    if (this.state === 'menu' && !this.target) this.placeTarget('Slice to start');
    if (this.state === 'paused') {
      this.segments = [];
      return;
    }
    this.time += dt;

    if (this.state === 'playing') {
      this.playTime += dt;
      this.updateSpawner(dt);
    }

    // blade vs things
    const minSpeed = this.h * 0.5; // px/s needed to cut
    for (const seg of this.segments) {
      const speed = Math.hypot(seg.x1 - seg.x0, seg.y1 - seg.y0) / seg.dt;
      if (speed < minSpeed) continue;
      this.bladeHit(seg);
    }
    this.segments = [];

    // physics
    for (const f of this.fruits) {
      f.vy += this.G * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.rot += f.vr * dt;
    }
    for (const h of this.halves) {
      h.vy += this.G * dt;
      h.x += h.vx * dt;
      h.y += h.vy * dt;
      h.rot += h.vr * dt;
      h.life -= dt;
    }
    for (const p of this.particles) {
      p.vy += this.G * 0.6 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    for (const t of this.texts) {
      t.y -= 40 * this.sc * dt;
      t.life -= dt;
    }
    this.flash = Math.max(0, this.flash - dt * 1.6);

    // missed fruit
    const missed = this.fruits.filter((f) => f.y - f.r > this.h && f.vy > 0);
    for (const f of missed) {
      if (!f.bomb && this.state === 'playing') this.loseLife(f.x);
    }
    this.fruits = this.fruits.filter((f) => !(f.y - f.r > this.h && f.vy > 0));
    this.halves = this.halves.filter((h) => h.life > 0 && h.y - h.r < this.h + 100);
    this.particles = this.particles.filter((p) => p.life > 0);
    this.texts = this.texts.filter((t) => t.life > 0);

    // combo window
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        if (this.comboCount >= 3 && this.state === 'playing') {
          this.score += this.comboCount;
          this.floatText(`COMBO x${this.comboCount}  +${this.comboCount}`, this.comboX, this.comboY, '#ffe066', 34);
          this.sfx.combo();
          this.hooks.onChange();
        }
        this.comboCount = 0;
      }
    }
  }

  private updateSpawner(dt: number): void {
    this.waveTimer -= dt;
    if (this.waveTimer <= 0) {
      const t = this.playTime;
      this.waveTimer = Math.max(0.65, 1.5 - t * 0.01);
      const n = 1 + Math.floor(Math.random() * (1 + Math.min(4, t / 20)));
      const pBomb = t < 6 ? 0 : Math.min(0.22, 0.06 + t * 0.002);
      for (let i = 0; i < n; i++) this.spawnQueue.push({ t: i * rand(0.08, 0.18), bomb: Math.random() < pBomb });
    }
    for (const q of this.spawnQueue) q.t -= dt;
    const ready = this.spawnQueue.filter((q) => q.t <= 0);
    this.spawnQueue = this.spawnQueue.filter((q) => q.t > 0);
    for (const q of ready) this.spawn(q.bomb);
  }

  private spawn(bomb: boolean): void {
    const kind = bomb ? BOMB : FRUITS[Math.floor(Math.random() * FRUITS.length)];
    const r = this.R * rand(0.9, 1.12);
    const x = rand(0.12, 0.88) * this.w;
    const apex = rand(0.55, 0.88) * this.h;
    const vy = -Math.sqrt(2 * this.G * apex);
    const flight = (2 * Math.abs(vy)) / this.G;
    const x2 = rand(0.15, 0.85) * this.w;
    this.fruits.push({
      ...kind,
      x,
      y: this.h + r,
      vx: (x2 - x) / flight,
      vy,
      rot: rand(0, Math.PI * 2),
      vr: rand(-4, 4),
      r,
      bomb,
    });
  }

  private loseLife(x: number): void {
    this.lives = Math.max(0, this.lives - 1);
    this.sfx.miss();
    this.floatText('✕', Math.max(30, Math.min(this.w - 30, x)), this.h - 60 * this.sc, '#ff5d5d', 44);
    this.hooks.onChange();
    if (this.lives === 0) this.gameOver();
  }

  // ---------------------------------------------------------------- slicing
  private bladeHit(seg: Segment): void {
    const angle = Math.atan2(seg.y1 - seg.y0, seg.x1 - seg.x0);

    if (this.target && (this.state === 'menu' || this.state === 'over')) {
      // After dying, the swipe that hit the bomb is still in motion: don't let it restart the game.
      if (this.state === 'over' && this.time - this.overAt < 1) return;
      const t = this.target;
      if (segmentHitsCircle(seg.x0, seg.y0, seg.x1, seg.y1, t.x, t.y, t.r)) {
        this.burst(t, angle, 0, 0, 30);
        this.sfx.slice();
        this.hooks.onSlice();
        this.startGame();
      }
      return;
    }
    if (this.state !== 'playing') return;

    for (const f of this.fruits) {
      if (!segmentHitsCircle(seg.x0, seg.y0, seg.x1, seg.y1, f.x, f.y, f.r)) continue;
      this.fruits = this.fruits.filter((o) => o !== f);
      if (f.bomb) {
        this.burst(f, angle, f.vx, f.vy, 40);
        this.flash = 1;
        this.sfx.bomb();
        this.hooks.onSlice();
        this.gameOver();
        return;
      }
      this.burst(f, angle, f.vx, f.vy, 16, f.rot);
      this.score++;
      this.sfx.slice();
      this.hooks.onSlice();
      this.comboCount++;
      this.comboTimer = 0.3;
      this.comboX = f.x;
      this.comboY = f.y;
      this.hooks.onChange();
      // only one fruit per segment step keeps combos readable; the next segment gets the rest
      // (we still continue the loop for other fruit on the same segment)
    }
  }

  /** Spawn two halves + juice for a cut object. */
  private burst(k: Kind & { x: number; y: number; r: number }, angle: number, vx: number, vy: number, n: number, rot = 0): void {
    const nx = -Math.sin(angle);
    const ny = Math.cos(angle);
    for (const side of [1, -1] as const) {
      this.halves.push({
        e: k.e,
        c: k.c,
        x: k.x,
        y: k.y,
        vx: vx + nx * side * 150 * this.sc,
        vy: vy + ny * side * 150 * this.sc - 80 * this.sc,
        rot,
        vr: side * rand(1.5, 3.5),
        phi: angle - rot,
        side,
        r: k.r,
        life: 1.8,
      });
    }
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const s = rand(80, 420) * this.sc;
      this.particles.push({
        x: k.x,
        y: k.y,
        vx: Math.cos(a) * s + vx * 0.3,
        vy: Math.sin(a) * s + vy * 0.3 - 100,
        life: rand(0.35, 0.8),
        max: 0.8,
        size: rand(2.5, 6.5) * this.sc,
        color: k.c,
      });
    }
  }

  private floatText(text: string, x: number, y: number, color: string, size: number): void {
    this.texts.push({ text, x, y, life: 0.9, color, size: size * this.sc });
  }

  // ---------------------------------------------------------------- drawing
  private render(nowMs: number): void {
    const { ctx, w, h } = this;
    // background
    const bg = ctx.createRadialGradient(w / 2, h * 0.4, h * 0.1, w / 2, h / 2, Math.max(w, h) * 0.8);
    bg.addColorStop(0, '#3b2a4a');
    bg.addColorStop(1, '#120b1c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    if (this.target) this.drawTarget(this.target);

    for (const f of this.fruits) this.drawEmoji(f.e, f.x, f.y, f.r, f.rot);
    for (const hf of this.halves) this.drawHalf(hf);

    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    this.blade.draw(ctx, nowMs, this.sc);
    this.blade.drawCursor(ctx, this.sc);

    for (const t of this.texts) {
      ctx.globalAlpha = Math.min(1, t.life * 2);
      ctx.font = `800 ${t.size}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = t.color;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 4;
      ctx.strokeText(t.text, t.x, t.y);
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;

    this.drawHud();

    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${this.flash * 0.85})`;
      ctx.fillRect(0, 0, w, h);
    }
    if (this.state === 'paused') {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.font = `800 ${64 * this.sc}px system-ui, sans-serif`;
      ctx.fillText('PAUSED', w / 2, h / 2);
      ctx.font = `500 ${22 * this.sc}px system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillText('Press P, or Pause on your phone, to continue', w / 2, h / 2 + 46 * this.sc);
    }
  }

  private drawEmoji(e: string, x: number, y: number, r: number, rot: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.font = `${r * 2}px ${EMOJI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(e, 0, r * 0.08);
    ctx.restore();
  }

  private drawHalf(hf: Half): void {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = Math.min(1, hf.life * 1.5);
    ctx.translate(hf.x, hf.y);
    ctx.rotate(hf.rot);
    ctx.save();
    ctx.rotate(hf.phi); // align with the cut line
    ctx.beginPath();
    const big = hf.r * 3;
    if (hf.side === 1) ctx.rect(-big, 0, big * 2, big);
    else ctx.rect(-big, -big, big * 2, big);
    ctx.clip();
    ctx.rotate(-hf.phi);
    ctx.font = `${hf.r * 2}px ${EMOJI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(hf.e, 0, hf.r * 0.08);
    ctx.restore();
    ctx.restore();
  }

  private drawTarget(t: Target): void {
    const { ctx } = this;
    const bob = Math.sin(this.time * 2.2) * 8 * this.sc;
    ctx.save();
    ctx.shadowColor = 'rgba(255,255,255,0.25)';
    ctx.shadowBlur = 40 * this.sc;
    this.drawEmoji(t.e, t.x, t.y + bob, t.r, Math.sin(this.time * 1.3) * 0.12);
    ctx.restore();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${26 * this.sc}px system-ui, sans-serif`;
    ctx.fillText(t.label, t.x, t.y + t.r + 44 * this.sc);
  }

  private drawHud(): void {
    const { ctx, w } = this;
    const pad = 24 * this.sc;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${44 * this.sc}px system-ui, sans-serif`;
    ctx.fillText(String(this.score), pad, pad + 38 * this.sc);
    ctx.font = `600 ${18 * this.sc}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillText(`BEST ${this.best}`, pad, pad + 66 * this.sc);

    ctx.textAlign = 'right';
    ctx.font = `800 ${40 * this.sc}px system-ui, sans-serif`;
    for (let i = 0; i < MAX_LIVES; i++) {
      const lost = i >= this.lives;
      ctx.fillStyle = lost ? '#ff5d5d' : 'rgba(255,255,255,0.3)';
      ctx.fillText(lost ? '✕' : '○', w - pad - i * 44 * this.sc, pad + 36 * this.sc);
    }
    ctx.textAlign = 'center';
  }
}
