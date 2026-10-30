// Marble Maze: the phone is a tray. Hold it flat, screen up, top edge toward the laptop,
// and tilt it to roll the marble through the maze to the flag.
//
// Holes wait just off the route, in the mouths of side branches: overshoot a turn and the
// marble drops (3 marbles per run). Gems sit in dead ends for bonus points. Each cleared
// maze is bigger than the last; the faster you finish, the bigger the time bonus.

import { center, DROP_R, GOAL_R, HOLE_R, makeLevel, MARBLE_R, slope, stepMarble, tiltInput, WALL, wallRects, type Level, type Marble, type Rect, type Vec } from '../shared/marble';
import type { Orientation } from '../shared/pointer';
import type { GameState } from '../shared/protocol';
import type { Sfx } from './audio';
import type { GameHooks, Scene } from './scene';

const MAX_LIVES = 3;
const GEM_POINTS = 25;
const DROP_TIME = 0.6; // seconds the marble takes to sink into a hole
const CLEAR_TIME = 1.6; // seconds the "maze cleared" banner shows
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

interface FloatText {
  text: string;
  x: number;
  y: number;
  life: number;
  color: string;
}

export class MazeGame implements Scene {
  readonly title = 'Marble Maze';
  readonly subtitle = 'Your phone is the tray. Tilt it to roll the marble.';
  state: GameState = 'menu';
  score = 0;
  best = 0;
  lives = MAX_LIVES;

  private ctx: CanvasRenderingContext2D;
  private w = 800;
  private h = 600;
  private sc = 1;

  private levelNo = 1;
  private seed = 1;
  private L: Level = makeLevel(1, 1);
  private rects: Rect[] = wallRects(this.L.maze);
  private gems = new Set<number>();
  private marble: Marble = { p: { x: 0.5, y: 0.5 }, v: { x: 0, y: 0 } };
  private levelTime = 0;
  private dropping: { hole: Vec; t: number; from: Vec } | null = null;
  private cleared = 0; // > 0 while the "cleared" banner shows
  private clearBonus = 0;

  // input
  private ref: Vec | null = null;
  private tilt: Vec = { x: 0, y: 0 };
  private padPush: Vec = { x: 0, y: 0 };
  private push: Vec = { x: 0, y: 0 };
  private lastPadSample = 0;
  private sens = 1;
  private keys = new Set<string>();

  private texts: FloatText[] = [];
  private lastFrame = 0;
  private lastHit = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private sfx: Sfx,
    private hooks: GameHooks,
  ) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('Canvas 2D is not available');
    this.ctx = c;
    try {
      this.best = Number(localStorage.getItem('bestMaze') ?? 0) || 0;
    } catch {
      /* ignore */
    }
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // ---------------------------------------------------------------- scene API
  enter(): void {
    this.resize();
    this.ref = null; // first sample after entering sets the level pose
    this.lastFrame = 0;
    this.texts = [];
    this.loadLevel(1, 1);
    this.setState('menu');
  }

  requestStart(): void {
    if (this.state === 'menu' || this.state === 'over') this.startRun();
    else if (this.state === 'paused') this.setState('playing');
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

  // ---------------------------------------------------------------- input
  setOrientation(o: Orientation, now: number): void {
    this.tilt = slope(o);
    if (this.ref === null) this.ref = { ...this.tilt };
    this.padPush = tiltInput(this.tilt, this.ref, this.sens);
    this.lastPadSample = now;
  }
  calibrate(): void {
    this.ref = { ...this.tilt };
  }
  /** On-screen joystick (-1..1, y up): pushing it tilts the tray that way. */
  joy(x: number, y: number, now: number): void {
    this.padPush = { x, y: -y };
    this.lastPadSample = now;
  }
  setSensitivity(v: number): void {
    this.sens = v;
  }
  padLost(): void {
    this.padPush = { x: 0, y: 0 };
    this.lastPadSample = 0;
  }
  keyDown(code: string): void {
    this.keys.add(code);
  }
  keyUp(code: string): void {
    this.keys.delete(code);
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
    this.sc = clamp(this.h / 800, 0.6, 1.6);
  }

  private setState(s: GameState): void {
    this.state = s;
    document.body.dataset.state = s;
    this.hooks.onChange();
  }

  private loadLevel(n: number, seed: number): void {
    this.levelNo = n;
    this.L = makeLevel(n, seed);
    this.rects = wallRects(this.L.maze);
    this.gems = new Set(this.L.gems);
    this.levelTime = 0;
    this.dropping = null;
    this.cleared = 0;
    this.respawn();
  }

  private respawn(): void {
    this.marble = { p: center(this.L.maze, this.L.start), v: { x: 0, y: 0 } };
  }

  private startRun(): void {
    this.score = 0;
    this.lives = MAX_LIVES;
    this.texts = [];
    this.seed = Math.floor(Math.random() * 1e9);
    this.loadLevel(1, this.seed);
    this.sfx.start();
    this.setState('playing');
  }

  private gameOver(): void {
    if (this.score > this.best) {
      this.best = this.score;
      try {
        localStorage.setItem('bestMaze', String(this.best));
      } catch {
        /* ignore */
      }
    }
    this.setState('over');
  }

  // ---------------------------------------------------------------- update
  private update(dt: number): void {
    if (this.state === 'paused') return;
    for (const t of this.texts) {
      t.life -= dt;
      t.y -= dt * 0.6;
    }
    this.texts = this.texts.filter((t) => t.life > 0);

    const padActive = performance.now() - this.lastPadSample < 600;
    const k = (a: string, b: string) => (this.keys.has(a) ? 1 : 0) - (this.keys.has(b) ? 1 : 0);
    const target = padActive ? this.padPush : { x: k('ArrowRight', 'ArrowLeft'), y: k('ArrowDown', 'ArrowUp') };
    const a = Math.min(1, dt * (padActive ? 18 : 8));
    this.push.x += (target.x - this.push.x) * a;
    this.push.y += (target.y - this.push.y) * a;

    if (this.state === 'over') return;
    const playing = this.state === 'playing';

    if (this.cleared > 0) {
      this.cleared -= dt;
      if (this.cleared <= 0) this.loadLevel(this.levelNo + 1, this.seed + this.levelNo);
      return;
    }

    if (this.dropping) {
      this.dropping.t += dt;
      if (this.dropping.t >= DROP_TIME) {
        this.dropping = null;
        this.lives--;
        this.hooks.onChange();
        if (this.lives <= 0) this.gameOver();
        else this.respawn();
      }
      return;
    }

    const m = this.marble;
    const push = { ...this.push };
    // holes have a lip: close to one, the marble is drawn towards it
    if (playing) {
      for (const i of this.L.holes) {
        const hc = center(this.L.maze, i);
        const d = dist(m.p, hc);
        if (d < HOLE_R + MARBLE_R && d > 1e-6) {
          const pull = 0.9 * (1 - d / (HOLE_R + MARBLE_R));
          push.x += ((hc.x - m.p.x) / d) * pull;
          push.y += ((hc.y - m.p.y) / d) * pull;
        }
      }
    }
    const hit = stepMarble(m, push, dt, this.rects);
    const now = performance.now();
    if (hit > 1.2 && now - this.lastHit > 90) {
      this.lastHit = now;
      this.sfx.land();
      this.hooks.onHaptic(Math.round(clamp(hit * 4, 8, 30)));
    }

    if (!playing) return; // menu: free practice, holes and goal do nothing
    this.levelTime += dt;

    for (const i of this.L.holes) {
      const hc = center(this.L.maze, i);
      if (dist(m.p, hc) < DROP_R) {
        this.dropping = { hole: hc, t: 0, from: { ...m.p } };
        this.sfx.miss();
        this.hooks.onHaptic(60);
        return;
      }
    }
    for (const i of this.gems) {
      const gc = center(this.L.maze, i);
      if (dist(m.p, gc) < 0.4) {
        this.gems.delete(i);
        this.score += GEM_POINTS;
        this.texts.push({ text: `+${GEM_POINTS}`, x: gc.x, y: gc.y, life: 1, color: '#7fe7ff' });
        this.sfx.coin();
        this.hooks.onSlice();
        this.hooks.onChange();
      }
    }
    if (dist(m.p, center(this.L.maze, this.L.goal)) < GOAL_R) {
      const timeBonus = Math.max(0, Math.round((this.L.par - this.levelTime) * 5));
      this.clearBonus = 100 * this.levelNo + timeBonus;
      this.score += this.clearBonus;
      this.cleared = CLEAR_TIME;
      this.marble.v = { x: 0, y: 0 };
      this.sfx.combo();
      this.hooks.onHaptic(40);
      this.hooks.onChange();
    }
  }

  // ---------------------------------------------------------------- render
  /** Board placement: pixels per cell and the top-left corner. */
  private layout(): { cell: number; ox: number; oy: number } {
    const { cols, rows } = this.L.maze;
    const top = 100 * this.sc;
    const side = 40 * this.sc;
    const cell = Math.min((this.w - 2 * side) / cols, (this.h - top - side) / rows);
    return { cell, ox: (this.w - cell * cols) / 2, oy: top + (this.h - top - side - cell * rows) / 2 };
  }

  private render(): void {
    const { ctx, w, h } = this;
    const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
    bg.addColorStop(0, '#2d2140');
    bg.addColorStop(1, '#120b1c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const { cell, ox, oy } = this.layout();
    const { cols, rows } = this.L.maze;
    const X = (x: number) => ox + x * cell;
    const Y = (y: number) => oy + y * cell;

    // tray: a wooden frame and floor
    const frame = cell * 0.35;
    ctx.fillStyle = '#5a3a22';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 30 * this.sc;
    ctx.fillRect(ox - frame, oy - frame, cols * cell + 2 * frame, rows * cell + 2 * frame);
    ctx.shadowBlur = 0;
    const floor = ctx.createLinearGradient(ox, oy, ox + cols * cell, oy + rows * cell);
    floor.addColorStop(0, '#d9b98a');
    floor.addColorStop(1, '#c49a64');
    ctx.fillStyle = floor;
    ctx.fillRect(ox, oy, cols * cell, rows * cell);
    // wood grain
    ctx.strokeStyle = 'rgba(120,80,40,0.12)';
    ctx.lineWidth = 1;
    for (let y = oy + 6; y < oy + rows * cell; y += 9 * this.sc) {
      ctx.beginPath();
      ctx.moveTo(ox, y);
      ctx.bezierCurveTo(ox + cols * cell * 0.3, y + 4, ox + cols * cell * 0.7, y - 4, ox + cols * cell, y);
      ctx.stroke();
    }

    // start pad and goal
    const s = center(this.L.maze, this.L.start);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.arc(X(s.x), Y(s.y), cell * 0.36, 0, Math.PI * 2);
    ctx.fill();
    const g = center(this.L.maze, this.L.goal);
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
    ctx.fillStyle = `rgba(123,228,149,${0.35 + pulse * 0.25})`;
    ctx.beginPath();
    ctx.arc(X(g.x), Y(g.y), cell * (GOAL_R + 0.06 + pulse * 0.04), 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${cell * 0.5}px ${EMOJI_FONT}`;
    ctx.fillText('🏁', X(g.x), Y(g.y));

    // holes
    for (const i of this.L.holes) {
      const c = center(this.L.maze, i);
      const r = HOLE_R * cell;
      const hole = ctx.createRadialGradient(X(c.x) - r * 0.2, Y(c.y) - r * 0.25, r * 0.1, X(c.x), Y(c.y), r);
      hole.addColorStop(0, '#000');
      hole.addColorStop(0.75, '#140c08');
      hole.addColorStop(1, '#5a3d24');
      ctx.fillStyle = hole;
      ctx.beginPath();
      ctx.arc(X(c.x), Y(c.y), r, 0, Math.PI * 2);
      ctx.fill();
    }

    // gems
    ctx.font = `${cell * 0.38}px ${EMOJI_FONT}`;
    const bob = Math.sin(performance.now() / 400) * cell * 0.03;
    for (const i of this.gems) {
      const c = center(this.L.maze, i);
      ctx.fillText('💎', X(c.x), Y(c.y) + bob);
    }

    // walls: shadow first, then the raised top
    const t = WALL * cell;
    ctx.fillStyle = 'rgba(60,35,15,0.35)';
    for (const r of this.rects) ctx.fillRect(X(r.x) + t * 0.35, Y(r.y) + t * 0.5, r.w * cell, r.h * cell);
    ctx.fillStyle = '#7a5032';
    for (const r of this.rects) ctx.fillRect(X(r.x), Y(r.y), r.w * cell, r.h * cell);
    ctx.fillStyle = 'rgba(255,220,170,0.18)';
    for (const r of this.rects) ctx.fillRect(X(r.x), Y(r.y), r.w * cell, Math.min(r.h * cell, t * 0.35));

    this.drawMarble(X, Y, cell);

    // floating texts
    ctx.font = `800 ${24 * this.sc}px system-ui, sans-serif`;
    ctx.lineWidth = 4 * this.sc;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    for (const f of this.texts) {
      ctx.globalAlpha = Math.min(1, f.life * 2);
      ctx.fillStyle = f.color;
      ctx.strokeText(f.text, X(f.x), Y(f.y));
      ctx.fillText(f.text, X(f.x), Y(f.y));
    }
    ctx.globalAlpha = 1;

    this.drawHud();
    this.drawBanner();
  }

  private drawMarble(X: (x: number) => number, Y: (y: number) => number, cell: number): void {
    const { ctx } = this;
    let p = this.marble.p;
    let scale = 1;
    if (this.dropping) {
      const k = Math.min(1, this.dropping.t / DROP_TIME);
      const e = k * k;
      p = { x: this.dropping.from.x + (this.dropping.hole.x - this.dropping.from.x) * Math.min(1, k * 3), y: this.dropping.from.y + (this.dropping.hole.y - this.dropping.from.y) * Math.min(1, k * 3) };
      scale = 1 - e * 0.85;
      ctx.globalAlpha = 1 - e;
    }
    const r = MARBLE_R * cell * scale;
    const x = X(p.x);
    const y = Y(p.y);
    // shadow falls away from the light (top-left), longer when the tray tilts
    ctx.fillStyle = 'rgba(40,20,5,0.35)';
    ctx.beginPath();
    ctx.ellipse(x + r * 0.35 + this.push.x * r * 0.25, y + r * 0.45 + this.push.y * r * 0.25, r * 1.02, r * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
    const steel = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.08, x, y, r);
    steel.addColorStop(0, '#ffffff');
    steel.addColorStop(0.25, '#d7e3f0');
    steel.addColorStop(0.7, '#7c8ca3');
    steel.addColorStop(1, '#3b4658');
    ctx.fillStyle = steel;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private drawHud(): void {
    const { ctx, w, h } = this;
    const sc = this.sc;
    const pad = 24 * sc;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.lineWidth = 5 * sc;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${46 * sc}px system-ui, sans-serif`;
    ctx.strokeText(String(this.score), pad, pad + 38 * sc);
    ctx.fillText(String(this.score), pad, pad + 38 * sc);
    ctx.font = `600 ${18 * sc}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    const sub = this.state === 'menu' ? `BEST ${this.best}` : `MAZE ${this.levelNo}   ·   ${Math.floor(this.levelTime)}s   ·   BEST ${this.best}`;
    ctx.strokeText(sub, pad, pad + 66 * sc);
    ctx.fillText(sub, pad, pad + 66 * sc);

    // marbles left (top right, clear of the Menu button)
    const r = 13 * sc;
    for (let i = 0; i < MAX_LIVES; i++) {
      const x = w - pad - r - i * 34 * sc - 150 * sc;
      const y = pad + 22 * sc;
      ctx.globalAlpha = i < this.lives ? 1 : 0.22;
      const steel = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
      steel.addColorStop(0, '#fff');
      steel.addColorStop(0.7, '#7c8ca3');
      steel.addColorStop(1, '#3b4658');
      ctx.fillStyle = steel;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // bubble level: where the tray is tilting
    const R = 38 * sc;
    const cx = w - pad - R;
    const cy = h - pad - R;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.arc(cx, cy, R + 6 * sc, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2 * sc;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.moveTo(cx - R, cy);
    ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R);
    ctx.lineTo(cx, cy + R);
    ctx.stroke();
    const px = clamp(this.push.x, -1, 1);
    const py = clamp(this.push.y, -1, 1);
    const m = Math.hypot(px, py);
    const k = m > 1 ? 1 / m : 1;
    ctx.fillStyle = '#7be495';
    ctx.beginPath();
    ctx.arc(cx + px * k * (R - 9 * sc), cy + py * k * (R - 9 * sc), 9 * sc, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawBanner(): void {
    const { ctx, w, h } = this;
    const sc = this.sc;
    const lines: [string, number, string][] = [];
    if (this.state === 'menu') {
      lines.push(['Hold the phone flat like a tray, top edge toward this screen', 24, '#fff']);
      lines.push(['Tilt to roll the marble to the 🏁. Mind the holes', 22, 'rgba(255,255,255,0.85)']);
      lines.push(['Press START on your phone, or Space', 30, '#ffe066']);
    } else if (this.state === 'over') {
      lines.push(['OUT OF MARBLES', 64, '#ff6b6b']);
      lines.push([`Score ${this.score}   ·   Maze ${this.levelNo}   ·   Best ${this.best}`, 30, '#fff']);
      lines.push(['Press START to play again', 26, '#ffe066']);
    } else if (this.state === 'paused') {
      lines.push(['PAUSED', 64, '#fff']);
      lines.push(['Press P, or Resume on your phone', 24, 'rgba(255,255,255,0.8)']);
    } else if (this.cleared > 0) {
      lines.push([`MAZE ${this.levelNo} CLEARED`, 56, '#7be495']);
      lines.push([`+${this.clearBonus}`, 34, '#ffe066']);
    } else {
      return;
    }
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, h * 0.36 - 40 * sc, w, 60 * sc + lines.length * 52 * sc);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 5 * sc;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    let y = h * 0.36 + 14 * sc;
    for (const [text, size, color] of lines) {
      ctx.font = `800 ${size * sc}px system-ui, ${EMOJI_FONT}`;
      ctx.fillStyle = color;
      ctx.strokeText(text, w / 2, y);
      ctx.fillText(text, w / 2, y);
      y += (size + 22) * sc;
    }
  }
}
