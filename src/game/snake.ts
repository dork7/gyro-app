// Gyro Snake: the classic, steered by tilting the phone. Hold it flat like a tray, screen
// up, top edge toward the laptop, and tip it toward where the snake should go.
//
// Apples make the snake longer and faster. Every fifth apple a golden star appears for a
// few seconds: worth more, and the snake grows more. Walls and your own tail end the run.

import { slope, tiltInput, type Vec } from '../shared/marble';
import type { Orientation } from '../shared/pointer';
import type { GameState } from '../shared/protocol';
import { freeCell, newSnake, OPPOSITE, START_LEN, step, STEP, stepTime, tiltDir, turn, type Cell, type Dir, type Snake } from '../shared/snake';
import type { Sfx } from './audio';
import type { GameHooks, Scene } from './scene';

const ROWS = 16;
const APPLE_POINTS = 10;
const STAR_POINTS = 50;
const STAR_GROW = 3;
const STAR_EVERY = 5; // apples
const STAR_LIFE = 6; // seconds
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
const KEY_DIR: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class SnakeGame implements Scene {
  readonly title = 'Gyro Snake';
  readonly subtitle = 'Tilt the phone to steer the snake.';
  state: GameState = 'menu';
  score = 0;
  best = 0;
  /** Shown on the phone as the snake's length. */
  lives = START_LEN;

  private ctx: CanvasRenderingContext2D;
  private w = 800;
  private h = 600;
  private sc = 1;

  private snake: Snake = newSnake(28, ROWS, Math.random);
  private prev: Cell[] = this.snake.body.map((c) => ({ ...c })); // body before the last step, for smooth drawing
  private acc = 0; // time since the last step
  private apples = 0;
  private star: Cell | null = null;
  private starLife = 0;
  private dead = 0; // > 0 while the crash plays

  // input
  private ref: Vec | null = null;
  private tilt: Vec = { x: 0, y: 0 };
  private padPush: Vec = { x: 0, y: 0 };
  private lastPadSample = 0;
  private sens = 1;
  private wanted: Dir | null = null;
  private keyQueue: Dir[] = [];

  private lastFrame = 0;
  private pop: { x: number; y: number; text: string; life: number } | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private sfx: Sfx,
    private hooks: GameHooks,
  ) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('Canvas 2D is not available');
    this.ctx = c;
    try {
      this.best = Number(localStorage.getItem('bestSnake') ?? 0) || 0;
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
    this.reset();
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
    const d = tiltDir(this.padPush, this.wanted);
    if (d) this.wanted = d;
  }
  calibrate(): void {
    this.ref = { ...this.tilt };
  }
  setSensitivity(v: number): void {
    this.sens = v;
  }
  padLost(): void {
    this.padPush = { x: 0, y: 0 };
    this.lastPadSample = 0;
  }
  keyDown(code: string): void {
    const d = KEY_DIR[code];
    if (d && this.keyQueue.length < 2 && this.keyQueue[this.keyQueue.length - 1] !== d) this.keyQueue.push(d);
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

  /** A fresh snake on a board shaped like the screen. */
  private reset(): void {
    const { aw, ah } = this.area();
    const cols = clamp(Math.round((ROWS * aw) / ah), 16, 32);
    this.snake = newSnake(cols, ROWS, Math.random);
    this.prev = this.snake.body.map((c) => ({ ...c }));
    this.acc = 0;
    this.apples = 0;
    this.star = null;
    this.dead = 0;
    this.wanted = null;
    this.keyQueue = [];
    this.pop = null;
    this.lives = this.snake.body.length;
  }

  private startRun(): void {
    this.reset();
    this.score = 0;
    this.sfx.start();
    this.setState('playing');
  }

  private gameOver(): void {
    if (this.score > this.best) {
      this.best = this.score;
      try {
        localStorage.setItem('bestSnake', String(this.best));
      } catch {
        /* ignore */
      }
    }
    this.setState('over');
  }

  // ---------------------------------------------------------------- update
  private update(dt: number): void {
    if (this.state === 'paused') return;
    if (this.pop) {
      this.pop.life -= dt;
      if (this.pop.life <= 0) this.pop = null;
    }
    if (this.dead > 0) {
      this.dead -= dt;
      if (this.dead <= 0) this.gameOver();
      return;
    }
    if (this.state !== 'playing') return;

    if (this.star) {
      this.starLife -= dt;
      if (this.starLife <= 0) this.star = null;
    }

    this.acc += dt;
    const every = stepTime(this.snake.body.length);
    if (this.acc < every) return;
    this.acc -= every;
    if (this.acc > every) this.acc = 0; // after a stall, do not run several steps at once

    const key = this.keyQueue.shift();
    if (key) this.wanted = null; // a key turn wins over an older tilt
    const next = key ?? this.wanted;
    if (next) turn(this.snake, next);
    if (this.wanted === OPPOSITE[this.snake.dir]) this.wanted = null; // an ignored reverse tilt must not fire later
    this.prev = this.snake.body.map((c) => ({ ...c }));
    const res = step(this.snake, Math.random);
    const head = this.snake.body[0];

    if (res === 'dead') {
      this.dead = 0.9;
      this.sfx.crash();
      this.hooks.onHaptic(80);
      return;
    }
    if (res === 'ate') {
      this.score += APPLE_POINTS;
      this.apples++;
      this.pop = { x: head.x, y: head.y, text: `+${APPLE_POINTS}`, life: 0.7 };
      this.sfx.coin();
      this.hooks.onSlice();
      if (this.apples % STAR_EVERY === 0) {
        this.star = freeCell(this.snake, Math.random, [this.snake.food]);
        this.starLife = STAR_LIFE;
      }
    }
    if (this.star && head.x === this.star.x && head.y === this.star.y) {
      this.score += STAR_POINTS;
      this.snake.grow += STAR_GROW;
      this.pop = { x: head.x, y: head.y, text: `+${STAR_POINTS}`, life: 0.9 };
      this.star = null;
      this.sfx.combo();
      this.hooks.onHaptic(30);
    }
    if (this.lives !== this.snake.body.length || res === 'ate') {
      this.lives = this.snake.body.length;
      this.hooks.onChange();
    }
  }

  // ---------------------------------------------------------------- render
  private area(): { aw: number; ah: number; top: number; side: number } {
    const top = 100 * this.sc;
    const side = 40 * this.sc;
    return { aw: this.w - 2 * side, ah: this.h - top - side, top, side };
  }

  private render(): void {
    const { ctx, w, h } = this;
    const { cols, rows } = this.snake;
    const { aw, ah, top } = this.area();
    const cell = Math.min(aw / cols, ah / rows);
    const ox = (w - cell * cols) / 2;
    const oy = top + (ah - cell * rows) / 2;
    const X = (x: number) => ox + (x + 0.5) * cell;
    const Y = (y: number) => oy + (y + 0.5) * cell;

    ctx.fillStyle = '#120b1c';
    ctx.fillRect(0, 0, w, h);

    // board
    ctx.fillStyle = '#0d2a17';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 30 * this.sc;
    ctx.fillRect(ox - 6, oy - 6, cols * cell + 12, rows * cell + 12);
    ctx.shadowBlur = 0;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#1f5a2e' : '#256b36';
        ctx.fillRect(ox + x * cell, oy + y * cell, cell + 0.5, cell + 0.5);
      }
    }

    // food
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const pulse = 1 + Math.sin(performance.now() / 180) * 0.06;
    ctx.font = `${cell * 0.8 * pulse}px ${EMOJI_FONT}`;
    ctx.fillText('🍎', X(this.snake.food.x), Y(this.snake.food.y) + cell * 0.04);
    if (this.star) {
      ctx.globalAlpha = this.starLife < 2 ? 0.4 + 0.6 * Math.abs(Math.sin(performance.now() / 90)) : 1; // blink before it goes
      ctx.font = `${cell * 0.85}px ${EMOJI_FONT}`;
      ctx.fillText('⭐', X(this.star.x), Y(this.star.y) + cell * 0.04);
      ctx.globalAlpha = 1;
    }

    this.drawSnake(X, Y, cell);

    if (this.pop) {
      ctx.globalAlpha = Math.min(1, this.pop.life * 2);
      ctx.font = `800 ${22 * this.sc}px system-ui, sans-serif`;
      ctx.lineWidth = 4 * this.sc;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.fillStyle = '#ffe066';
      const py = Y(this.pop.y) - cell * (1.4 - this.pop.life);
      ctx.strokeText(this.pop.text, X(this.pop.x), py);
      ctx.fillText(this.pop.text, X(this.pop.x), py);
      ctx.globalAlpha = 1;
    }

    this.drawHud();
    this.drawBanner();
  }

  private drawSnake(X: (x: number) => number, Y: (y: number) => number, cell: number): void {
    const { ctx } = this;
    const body = this.snake.body;
    // glide between the last two steps (frozen while the crash plays)
    const k = this.state === 'playing' && this.dead <= 0 ? clamp(this.acc / stepTime(body.length), 0, 1) : 1;
    const pts = body.map((c, i) => {
      const p = this.prev[i] ?? this.prev[this.prev.length - 1] ?? c;
      return { x: X(p.x + (c.x - p.x) * k), y: Y(p.y + (c.y - p.y) * k) };
    });
    const hurt = this.dead > 0 || this.state === 'over';

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = pts.length - 1; i > 0; i--) {
      const f = i / pts.length;
      ctx.strokeStyle = hurt ? `hsl(0, 60%, ${55 - f * 20}%)` : `hsl(${95 - f * 30}, 75%, ${58 - f * 22}%)`;
      ctx.lineWidth = cell * (0.78 - f * 0.22);
      ctx.beginPath();
      ctx.moveTo(pts[i].x, pts[i].y);
      ctx.lineTo(pts[i - 1].x, pts[i - 1].y);
      ctx.stroke();
    }

    // head with eyes looking where it goes
    const head = pts[0];
    const d = STEP[this.snake.dir];
    ctx.fillStyle = hurt ? '#e05555' : '#9be564';
    ctx.beginPath();
    ctx.arc(head.x, head.y, cell * 0.45, 0, Math.PI * 2);
    ctx.fill();
    for (const side of [-1, 1]) {
      const ex = head.x + d.x * cell * 0.15 - d.y * side * cell * 0.2;
      const ey = head.y + d.y * cell * 0.15 + d.x * side * cell * 0.2;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(ex, ey, cell * 0.12, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#111';
      ctx.beginPath();
      ctx.arc(ex + d.x * cell * 0.04, ey + d.y * cell * 0.04, cell * 0.06, 0, Math.PI * 2);
      ctx.fill();
    }
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
    const sub = `LENGTH ${this.snake.body.length}   ·   BEST ${this.best}`;
    ctx.strokeText(sub, pad, pad + 66 * sc);
    ctx.fillText(sub, pad, pad + 66 * sc);

    // tilt indicator: the bubble shows the tilt, the arrow the direction it asks for
    const R = 38 * sc;
    const cx = w - pad - R;
    const cy = h - pad - R;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.arc(cx, cy, R + 6 * sc, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2 * sc;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.4, 0, Math.PI * 2); // inside this ring the phone counts as level
    ctx.stroke();
    if (this.wanted) {
      const d = STEP[this.wanted];
      ctx.fillStyle = 'rgba(155,229,100,0.85)';
      ctx.beginPath();
      ctx.moveTo(cx + d.x * R * 0.95, cy + d.y * R * 0.95);
      ctx.lineTo(cx + d.x * R * 0.55 - d.y * R * 0.25, cy + d.y * R * 0.55 + d.x * R * 0.25);
      ctx.lineTo(cx + d.x * R * 0.55 + d.y * R * 0.25, cy + d.y * R * 0.55 - d.x * R * 0.25);
      ctx.closePath();
      ctx.fill();
    }
    const padActive = performance.now() - this.lastPadSample < 600;
    if (padActive) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(cx + clamp(this.padPush.x, -1, 1) * R * 0.75, cy + clamp(this.padPush.y, -1, 1) * R * 0.75, 7 * sc, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawBanner(): void {
    const { ctx, w, h } = this;
    const sc = this.sc;
    const lines: [string, number, string][] = [];
    if (this.state === 'menu') {
      lines.push(['Hold the phone flat, screen up, top edge toward this screen', 24, '#fff']);
      lines.push(['Tip it toward where the snake should go', 22, 'rgba(255,255,255,0.85)']);
      lines.push(['Press START on your phone, or Space', 30, '#ffe066']);
    } else if (this.state === 'over') {
      lines.push(['GAME OVER', 64, '#ff6b6b']);
      lines.push([`Score ${this.score}   ·   Length ${this.snake.body.length}   ·   Best ${this.best}`, 30, '#fff']);
      lines.push(['Press START to play again', 26, '#ffe066']);
    } else if (this.state === 'paused') {
      lines.push(['PAUSED', 64, '#fff']);
      lines.push(['Press P, or Resume on your phone', 24, 'rgba(255,255,255,0.8)']);
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
      ctx.font = `800 ${size * sc}px system-ui, sans-serif`;
      ctx.fillStyle = color;
      ctx.strokeText(text, w / 2, y);
      ctx.fillText(text, w / 2, y);
      y += (size + 22) * sc;
    }
  }
}
