// Jump Run: an endless runner you play by really jumping.
//
// The phone's accelerometer detects your jump (on the phone, see shared/jump.ts) and the
// runner on the laptop jumps with you. Clear the obstacles, grab coins, don't lose all
// three lives. Space / Up arrow / the JUMP button on the phone also jump (for testing).

import type { GameState } from '../shared/protocol';
import type { Sfx } from './audio';
import type { GameHooks, Scene } from './scene';

const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
const OBSTACLES = ['🌵', '🪨', '📦', '🧱', '🔥'];
const MAX_LIVES = 3;
const BUFFER_S = 0.18; // a jump pressed just before landing still counts
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

interface Obstacle {
  x: number; // left edge
  w: number;
  h: number;
  e: string;
}
interface Coin {
  x: number;
  y: number; // height above ground
  taken: boolean;
}
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
  color: string;
}
interface FloatText {
  text: string;
  x: number;
  y: number;
  life: number;
  color: string;
}

export class JumpGame implements Scene {
  readonly title = 'Jump Run';
  readonly subtitle = 'Jump for real. Your phone feels it.';
  state: GameState = 'menu';
  score = 0;
  best = 0;
  lives = MAX_LIVES;

  private ctx: CanvasRenderingContext2D;
  private w = 800;
  private h = 600;
  private sc = 1;
  private ground = 480;
  private time = 0;
  private lastFrame = 0;

  // player
  private py = 0; // height above ground
  private pvy = 0; // upwards
  private runT = 0;
  private buffer = 0;
  private invul = 0;
  private shake = 0;
  private flash = 0;
  private detectFlash = 0;

  // world
  private playTime = 0;
  private scroll = 0; // total distance scrolled
  private spawnIn = 0;
  private obstacles: Obstacle[] = [];
  private coins: Coin[] = [];
  private particles: Particle[] = [];
  private texts: FloatText[] = [];
  private meters = 0;
  private coinCount = 0;
  private keys = new Set<string>();

  constructor(
    private canvas: HTMLCanvasElement,
    private sfx: Sfx,
    private hooks: GameHooks,
  ) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('Canvas 2D is not available');
    this.ctx = c;
    try {
      this.best = Number(localStorage.getItem('bestJump') ?? 0) || 0;
    } catch {
      /* ignore */
    }
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // ---------------------------------------------------------------- derived sizes
  private get G(): number {
    return this.h * 3.4;
  }
  private get jumpH(): number {
    return this.h * 0.3;
  }
  private get speed(): number {
    const base = this.w * 0.34;
    return this.state === 'playing' ? base + Math.min(this.w * 0.5, this.playTime * this.w * 0.006) : base * 0.8;
  }
  private get px(): number {
    return this.w * 0.2;
  }
  private get ph(): number {
    return this.h * 0.12;
  }
  private get airborne(): boolean {
    return this.py > 0.5 || this.pvy > 0;
  }

  // ---------------------------------------------------------------- scene API
  enter(): void {
    this.resize();
    this.state = 'menu';
    this.obstacles = [];
    this.coins = [];
    this.particles = [];
    this.texts = [];
    this.py = 0;
    this.pvy = 0;
    this.buffer = 0;
    this.lastFrame = 0;
    this.setState('menu');
  }

  exit(): void {
    this.keys.clear();
  }

  /** Space/Start: starts or resumes; while running it is also a jump. */
  requestStart(): void {
    if (this.state === 'menu' || this.state === 'over') this.startRun();
    else if (this.state === 'paused') this.setState('playing');
    else this.jump(0);
  }

  togglePause(): void {
    if (this.state === 'playing') this.setState('paused');
    else if (this.state === 'paused') this.setState('playing');
  }

  tick(t: number): void {
    const dt = Math.min(0.05, this.lastFrame ? (t - this.lastFrame) / 1000 : 0.016);
    this.lastFrame = t;
    this.update(dt);
    this.render();
  }

  /** The player jumped (strength = sensor ratio, 0 for a key/tap). */
  jump(_strength: number): void {
    if (this.state === 'menu' || this.state === 'over') {
      if (this.state === 'over' && this.time - this.overAt < 0.8) return; // don't restart by accident
      this.startRun();
      this.detectFlash = 1;
      return;
    }
    if (this.state !== 'playing') return;
    this.detectFlash = 1;
    if (this.airborne) this.buffer = BUFFER_S;
    else this.launch();
  }

  keyDown(code: string): void {
    if ((code === 'ArrowUp' || code === 'KeyW') && !this.keys.has(code)) this.jump(0);
    this.keys.add(code);
  }
  keyUp(code: string): void {
    this.keys.delete(code);
  }

  private overAt = -10;

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
    this.sc = clamp(this.h / 800, 0.6, 1.6);
    this.ground = this.h * 0.78;
  }

  private setState(s: GameState): void {
    this.state = s;
    document.body.dataset.state = s;
    this.hooks.onChange();
  }

  private startRun(): void {
    this.score = 0;
    this.meters = 0;
    this.baseMeters = Math.floor(this.scroll / (this.h * 0.05));
    this.coinCount = 0;
    this.lives = MAX_LIVES;
    this.playTime = 0;
    this.invul = 0;
    this.obstacles = [];
    this.coins = [];
    this.texts = [];
    this.py = 0;
    this.pvy = 0;
    this.buffer = 0;
    this.spawnIn = this.w * 0.9; // first obstacle comes after a short run-up
    this.sfx.start();
    this.setState('playing');
  }

  private gameOver(): void {
    if (this.score > this.best) {
      this.best = this.score;
      try {
        localStorage.setItem('bestJump', String(this.best));
      } catch {
        /* ignore */
      }
    }
    this.overAt = this.time;
    this.setState('over');
  }

  private launch(): void {
    this.pvy = Math.sqrt(2 * this.G * this.jumpH);
    this.py = 1;
    this.sfx.jump();
    this.dust(8);
    this.hooks.onSlice();
  }

  // ---------------------------------------------------------------- update
  private update(dt: number): void {
    if (this.state === 'paused') return;
    this.time += dt;
    this.detectFlash = Math.max(0, this.detectFlash - dt * 4);
    this.flash = Math.max(0, this.flash - dt * 3);
    this.shake = Math.max(0, this.shake - dt * 3);
    this.invul = Math.max(0, this.invul - dt);
    for (const t of this.texts) {
      t.life -= dt;
      t.y -= 40 * this.sc * dt;
    }
    this.texts = this.texts.filter((t) => t.life > 0);
    for (const p of this.particles) {
      p.vy += this.G * 0.35 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);

    const running = this.state === 'playing';
    const dx = this.speed * dt;
    this.scroll += dx;
    if (running) this.playTime += dt;
    this.runT += dt * (running ? 1 : 0.5);

    // player physics
    if (this.airborne) {
      this.pvy -= this.G * dt;
      this.py += this.pvy * dt;
      if (this.py <= 0) {
        this.py = 0;
        this.pvy = 0;
        this.sfx.land();
        this.dust(6);
        if (this.buffer > 0 && running) this.launch();
      }
    }
    this.buffer = Math.max(0, this.buffer - dt);

    // world scrolls left
    for (const o of this.obstacles) o.x -= dx;
    for (const c of this.coins) c.x -= dx;
    this.obstacles = this.obstacles.filter((o) => o.x + o.w > -50);
    this.coins = this.coins.filter((c) => c.x > -50 && !c.taken);

    if (!running) return;

    // spawn
    this.spawnIn -= dx;
    if (this.spawnIn <= 0) this.spawnPattern();

    // distance score
    const m = Math.floor(this.scroll / (this.h * 0.05));
    const meters = m - this.baseMeters;
    if (meters !== this.meters) {
      this.meters = meters;
      this.updateScore();
    }

    // collisions
    const pw = this.ph * 0.55;
    const left = this.px - pw * 0.32;
    const right = this.px + pw * 0.32;
    const feet = this.ground - this.py;
    const head = feet - this.ph * 0.9;
    for (const o of this.obstacles) {
      const ol = o.x + o.w * 0.14;
      const or = o.x + o.w * 0.86;
      const ot = this.ground - o.h * 0.85;
      if (right > ol && left < or && feet > ot && head < this.ground) {
        this.obstacles = this.obstacles.filter((q) => q !== o);
        this.hit(o);
        break;
      }
    }
    // coins
    const cy = (c: Coin) => this.ground - c.y;
    for (const c of this.coins) {
      if (Math.hypot(c.x - this.px, cy(c) - (feet - this.ph * 0.5)) < this.ph * 0.55) {
        c.taken = true;
        this.coinCount++;
        this.sfx.coin();
        this.texts.push({ text: '+5', x: c.x, y: cy(c), life: 0.7, color: '#ffd23f' });
        this.updateScore();
      }
    }
  }

  private baseMeters = 0;

  private updateScore(): void {
    const next = this.meters + this.coinCount * 5;
    if (next !== this.score) {
      this.score = next;
      this.hooks.onChange();
    }
  }

  private hit(o: Obstacle): void {
    if (this.invul > 0) return;
    this.lives = Math.max(0, this.lives - 1);
    this.invul = 1.4;
    this.shake = 1;
    this.flash = 0.8;
    this.sfx.crash();
    this.hooks.onHaptic(140);
    for (let i = 0; i < 18; i++) {
      this.particles.push({
        x: o.x + o.w / 2,
        y: this.ground - o.h / 2,
        vx: rand(-260, 260) * this.sc,
        vy: rand(-520, -80) * this.sc,
        life: rand(0.4, 0.9),
        size: rand(3, 7) * this.sc,
        color: i % 2 ? '#ffb703' : '#e5e5e5',
      });
    }
    this.hooks.onChange();
    if (this.lives === 0) this.gameOver();
  }

  private dust(n: number): void {
    for (let i = 0; i < n; i++) {
      this.particles.push({
        x: this.px + rand(-12, 12) * this.sc,
        y: this.ground - this.py,
        vx: rand(-140, 20) * this.sc,
        vy: rand(-120, -20) * this.sc,
        life: rand(0.25, 0.5),
        size: rand(2, 5) * this.sc,
        color: 'rgba(230,210,180,0.8)',
      });
    }
  }

  private spawnPattern(): void {
    const t = this.playTime;
    const oh = this.h * rand(0.09, 0.13);
    const ow = oh * 0.85;
    const x0 = this.w + 60;
    let width = ow;
    const count = t > 18 && Math.random() < 0.3 ? 2 : 1;
    const withObstacle = Math.random() < 0.92 || t < 3;

    if (withObstacle) {
      for (let i = 0; i < count; i++) {
        this.obstacles.push({ x: x0 + i * (ow + ow * 0.25), w: ow, h: oh, e: OBSTACLES[Math.floor(Math.random() * OBSTACLES.length)] });
      }
      width = count * ow + (count - 1) * ow * 0.25;
    }

    // coins: an arc over the obstacle(s), or a low line when there is no obstacle
    if (Math.random() < 0.75) {
      const n = withObstacle ? 5 : 4;
      const span = withObstacle ? width + ow * 1.6 : this.w * 0.12;
      const peak = withObstacle ? this.jumpH * 0.8 : this.h * 0.04;
      const start = x0 - (span - width) / 2;
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const y = withObstacle ? oh + (peak - oh) * (1 - Math.pow(2 * u - 1, 2)) + oh * 0.2 : peak;
        this.coins.push({ x: start + u * span, y: Math.max(y, this.ph * 0.4), taken: false });
      }
    }

    // time to land and get ready again before the next pattern
    const gapTime = rand(1.25, 1.95) - Math.min(0.3, t * 0.004);
    this.spawnIn = width + this.speed * gapTime;
  }

  // ---------------------------------------------------------------- drawing
  private render(): void {
    const { ctx, w, h } = this;
    ctx.save();
    if (this.shake > 0) ctx.translate(rand(-1, 1) * 10 * this.sc * this.shake, rand(-1, 1) * 8 * this.sc * this.shake);

    this.drawBackground();

    // obstacles
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (const o of this.obstacles) {
      ctx.font = `${o.h * 1.15}px ${EMOJI_FONT}`;
      ctx.fillText(o.e, o.x + o.w / 2, this.ground + o.h * 0.08);
    }

    // coins
    for (const c of this.coins) this.drawCoin(c.x, this.ground - c.y);

    this.drawRunner();

    for (const p of this.particles) {
      ctx.globalAlpha = clamp(p.life * 2.5, 0, 1);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    for (const t of this.texts) {
      ctx.globalAlpha = clamp(t.life * 2, 0, 1);
      ctx.font = `800 ${30 * this.sc}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = t.color;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 4;
      ctx.strokeText(t.text, t.x, t.y);
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    this.drawHud();

    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255,70,70,${this.flash * 0.35})`;
      ctx.fillRect(0, 0, w, h);
    }
    if (this.state === 'menu' || this.state === 'over') this.drawPrompt();
    if (this.state === 'paused') {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.font = `800 ${64 * this.sc}px system-ui, sans-serif`;
      ctx.fillText('PAUSED', w / 2, h / 2);
    }
  }

  private drawBackground(): void {
    const { ctx, w, h, ground } = this;
    const sky = ctx.createLinearGradient(0, 0, 0, ground);
    sky.addColorStop(0, '#1d2b53');
    sky.addColorStop(0.55, '#7e4a8a');
    sky.addColorStop(1, '#f7a072');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, ground);

    // sun
    ctx.fillStyle = 'rgba(255, 224, 160, 0.95)';
    ctx.beginPath();
    ctx.arc(w * 0.78, ground - h * 0.17, h * 0.09, 0, Math.PI * 2);
    ctx.fill();

    // two mountain layers with parallax
    const layer = (speed: number, base: number, amp: number, color: string, seed: number) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, ground);
      const off = this.scroll * speed;
      for (let x = 0; x <= w + 10; x += 10) {
        const t = (x + off) / (h * 0.55);
        const y = base - amp * (0.55 + 0.3 * Math.sin(t + seed) + 0.15 * Math.sin(2.3 * t + seed * 2));
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, ground);
      ctx.closePath();
      ctx.fill();
    };
    layer(0.08, ground - h * 0.06, h * 0.3, '#4a3567', 1);
    layer(0.22, ground, h * 0.2, '#2c2148', 4);

    // ground
    ctx.fillStyle = '#3a2a3f';
    ctx.fillRect(0, ground, w, h - ground);
    ctx.fillStyle = '#6b8e4e';
    ctx.fillRect(0, ground, w, 6 * this.sc);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    const period = h * 0.16;
    const dash = h * 0.07;
    const off = this.scroll % period;
    for (let x = -off; x < w; x += period) ctx.fillRect(x, ground + (h - ground) * 0.45, dash, 4 * this.sc);
  }

  private drawCoin(x: number, y: number): void {
    const { ctx } = this;
    const r = this.ph * 0.17;
    const squash = Math.abs(Math.cos(this.time * 4 + x * 0.02));
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = '#ffd23f';
    ctx.strokeStyle = '#b8860b';
    ctx.lineWidth = 2 * this.sc;
    ctx.shadowColor = 'rgba(255,210,63,0.7)';
    ctx.shadowBlur = 10 * this.sc;
    ctx.beginPath();
    ctx.ellipse(0, 0, Math.max(r * 0.25, r * squash), r, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private drawRunner(): void {
    const { ctx, ph } = this;
    if (this.invul > 0 && Math.floor(this.time * 14) % 2 === 0) return; // blink while invulnerable
    const x = this.px;
    const feetY = this.ground - this.py;
    const air = this.airborne;
    const lw = ph * 0.11;
    const phase = this.runT * 11;

    ctx.save();
    // shadow stays on the ground and shrinks with height
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(x, this.ground + 4 * this.sc, ph * 0.3 * (1 - Math.min(0.6, this.py / (this.jumpH * 1.4))), ph * 0.06, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.translate(x, feetY);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const hip = { x: 0, y: -ph * 0.45 };
    const shoulder = { x: ph * 0.04, y: -ph * 0.78 };
    const leg = ph * 0.22;

    const limb = (from: { x: number; y: number }, kx: number, ky: number, fx: number, fy: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(kx, ky);
      ctx.lineTo(fx, fy);
      ctx.stroke();
    };

    // legs (back leg darker)
    for (const side of [1, -1]) {
      const a = air ? (side === 1 ? 0.9 : -0.2) : Math.sin(phase + (side === 1 ? 0 : Math.PI)) * 0.9;
      const bend = air ? 0.8 : Math.max(0, Math.cos(phase + (side === 1 ? 0 : Math.PI))) * 0.9 + 0.15;
      const kx = hip.x + Math.sin(a) * leg;
      const ky = hip.y + Math.cos(a) * leg;
      const fx = kx + Math.sin(a - bend) * leg;
      const fy = ky + Math.cos(a - bend) * leg;
      limb(hip, kx, ky, fx, fy, side === 1 ? '#2b2d42' : '#1a1b2b');
    }
    // body
    ctx.strokeStyle = '#ef476f';
    ctx.lineWidth = lw * 1.5;
    ctx.beginPath();
    ctx.moveTo(hip.x, hip.y);
    ctx.lineTo(shoulder.x, shoulder.y);
    ctx.stroke();
    // arms
    for (const side of [1, -1]) {
      const a = air ? -2.6 + (side === 1 ? 0.25 : -0.25) : Math.sin(phase + (side === 1 ? Math.PI : 0)) * 0.9 + 0.3;
      const ex = shoulder.x + Math.sin(a) * leg * 0.9;
      const ey = shoulder.y + Math.cos(a) * leg * 0.9;
      const hx = ex + Math.sin(a + (air ? 0.2 : 0.9)) * leg * 0.8;
      const hy = ey + Math.cos(a + (air ? 0.2 : 0.9)) * leg * 0.8;
      limb(shoulder, ex, ey, hx, hy, side === 1 ? '#ef476f' : '#b83259');
    }
    // head
    ctx.fillStyle = '#ffd6a5';
    ctx.beginPath();
    ctx.arc(shoulder.x + ph * 0.03, shoulder.y - ph * 0.15, ph * 0.14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffd23f'; // headband
    ctx.fillRect(shoulder.x - ph * 0.11, shoulder.y - ph * 0.22, ph * 0.28, ph * 0.045);
    ctx.restore();
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
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(`BEST ${this.best}   ·   ${this.coinCount} coins`, pad, pad + 66 * this.sc);

    ctx.textAlign = 'right';
    ctx.font = `800 ${38 * this.sc}px system-ui, sans-serif`;
    for (let i = 0; i < MAX_LIVES; i++) {
      ctx.fillStyle = i < this.lives ? '#ff4d6d' : 'rgba(255,255,255,0.25)';
      ctx.fillText('♥', w - pad - i * 42 * this.sc, pad + 36 * this.sc);
    }

    // "JUMP!" flash when the sensor (or a key) registers a jump
    if (this.detectFlash > 0) {
      ctx.globalAlpha = this.detectFlash;
      ctx.textAlign = 'center';
      ctx.font = `900 ${34 * this.sc}px system-ui, sans-serif`;
      ctx.fillStyle = '#7be495';
      ctx.fillText('JUMP!', this.px, this.ground - this.py - this.ph * 1.35 - (1 - this.detectFlash) * 24 * this.sc);
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'center';
  }

  private drawPrompt(): void {
    const { ctx, w, h } = this;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    const bw = Math.min(w * 0.7, 720 * this.sc);
    const bh = 130 * this.sc;
    const bx = w / 2 - bw / 2;
    const by = h * 0.3;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 20 * this.sc);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${(this.state === 'over' ? 40 : 36) * this.sc}px system-ui, sans-serif`;
    ctx.fillText(this.state === 'over' ? `Game over · ${this.score}` : 'Jump to start!', w / 2, by + 52 * this.sc);
    ctx.font = `500 ${20 * this.sc}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(
      this.state === 'over' ? 'Jump (or press Start) to run again' : 'Hold your phone and really jump. Space works too.',
      w / 2,
      by + 90 * this.sc,
    );
  }
}
