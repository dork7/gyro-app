// Gyro Racer: a pseudo-3D road race (the classic "segment projection" technique).
// The phone is the steering wheel: roll it like a wheel to steer. Gas and brake are
// buttons on the phone (or the arrow keys on the laptop).
//
// Dodge traffic, pass close for near-miss bonuses, stay on the road. 3 crashes ends the run.

import { steerValue, wheelAngle, type Orientation } from '../shared/pointer';
import type { GameState } from '../shared/protocol';
import type { Sfx } from './audio';
import type { GameHooks, Scene } from './scene';

// ---- world constants ------------------------------------------------------------
const SEG_LEN = 200; // length of one road segment (world units)
const ROAD_W = 2000; // half-width of the road
const LANES = 3;
const CAM_H = 1000; // camera height
const CAM_DEPTH = 1 / Math.tan((100 / 2) * (Math.PI / 180)); // 100° field of view
const PLAYER_Z = CAM_H * CAM_DEPTH; // player sits this far in front of the camera
const DRAW = 200; // draw distance in segments
const RUMBLE = 3; // segments per colour stripe

const MAX_SPEED = SEG_LEN * 60; // one segment per frame at 60 fps
const ACCEL = MAX_SPEED / 4.5;
const BRAKING = -MAX_SPEED * 0.9;
const COAST = -MAX_SPEED / 6;
const OFFROAD_DECEL = -MAX_SPEED / 1.6;
const OFFROAD_LIMIT = MAX_SPEED / 4;
const CENTRIFUGAL = 0.3;

const CAR_W = 0.28 * ROAD_W; // car width in world units
const HIT = 0.26; // lateral distance (in road half-widths) below which cars collide
const NEAR = 0.52; // ... and below which a pass counts as a near miss
const TRAFFIC = 34;
const MAX_LIVES = 3;
const LANE_X = [-0.66, 0, 0.66];

const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
const TREES = ['🌲', '🌳', '🌴', '🌲', '🌳', '🌵'];
const CAR_COLORS = ['#f4a261', '#2a9d8f', '#e9c46a', '#8338ec', '#4cc9f0', '#f1f1f1', '#adb5bd', '#ff7aa2'];

// ---- track ------------------------------------------------------------------------
interface RoadSprite {
  e: string;
  offset: number; // in road half-widths, negative = left
  size: number; // world units
}
interface Seg {
  curve: number;
  dark: boolean;
  sprites: RoadSprite[];
}
interface Traffic {
  z: number;
  offset: number;
  speed: number;
  color: string;
  prevRel: number;
}
interface FloatText {
  text: string;
  life: number;
  color: string;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const easeIn = (a: number, b: number, t: number) => a + (b - a) * t * t;
const easeInOut = (a: number, b: number, t: number) => a + (b - a) * (-Math.cos(t * Math.PI) / 2 + 0.5);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function buildTrack(): Seg[] {
  const rng = mulberry32(2026);
  const segs: Seg[] = [];
  const add = (curve: number) => segs.push({ curve, dark: Math.floor(segs.length / RUMBLE) % 2 === 1, sprites: [] });
  const straight = (n: number) => {
    for (let i = 0; i < n; i++) add(0);
  };
  const bend = (enter: number, hold: number, leave: number, curve: number) => {
    for (let n = 0; n < enter; n++) add(easeIn(0, curve, n / enter));
    for (let n = 0; n < hold; n++) add(curve);
    for (let n = 0; n < leave; n++) add(easeInOut(curve, 0, n / leave));
  };
  const between = (a: number, b: number) => Math.floor(a + rng() * (b - a));

  straight(40);
  for (let i = 0; i < 18; i++) {
    straight(between(12, 45));
    const dir = rng() < 0.5 ? -1 : 1;
    bend(between(20, 40), between(30, 90), between(20, 40), dir * (1.5 + rng() * 4.5));
  }
  straight(40);

  for (let i = 12; i < segs.length; i += between(3, 9)) {
    const side = rng() < 0.5 ? -1 : 1;
    segs[i].sprites.push({ e: TREES[between(0, TREES.length)], offset: side * (1.35 + rng() * 2.2), size: 650 + rng() * 500 });
    if (rng() < 0.35) {
      segs[i].sprites.push({ e: TREES[between(0, TREES.length)], offset: -side * (1.35 + rng() * 2.2), size: 650 + rng() * 500 });
    }
  }
  return segs;
}

// ---- drawing helpers --------------------------------------------------------------
function poly(ctx: CanvasRenderingContext2D, color: string, pts: number[]): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
  ctx.fill();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** A car seen from behind. (x, y) = centre of the bottom edge, w = width. */
function drawCar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, color: string, braking = false): void {
  if (w < 3) return;
  const h = w * 0.62;
  ctx.save();
  ctx.translate(x, y);
  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(0, 0, w * 0.54, h * 0.1, 0, 0, Math.PI * 2);
  ctx.fill();
  // wheels
  ctx.fillStyle = '#16161c';
  roundRect(ctx, -w * 0.5, -h * 0.34, w * 0.15, h * 0.34, w * 0.03);
  ctx.fill();
  roundRect(ctx, w * 0.35, -h * 0.34, w * 0.15, h * 0.34, w * 0.03);
  ctx.fill();
  // body
  ctx.fillStyle = color;
  roundRect(ctx, -w * 0.46, -h * 0.62, w * 0.92, h * 0.46, w * 0.07);
  ctx.fill();
  // cabin
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-w * 0.34, -h * 0.6);
  ctx.lineTo(-w * 0.25, -h);
  ctx.lineTo(w * 0.25, -h);
  ctx.lineTo(w * 0.34, -h * 0.6);
  ctx.closePath();
  ctx.fill();
  // rear window
  ctx.fillStyle = 'rgba(20,28,40,0.88)';
  ctx.beginPath();
  ctx.moveTo(-w * 0.28, -h * 0.64);
  ctx.lineTo(-w * 0.21, -h * 0.93);
  ctx.lineTo(w * 0.21, -h * 0.93);
  ctx.lineTo(w * 0.28, -h * 0.64);
  ctx.closePath();
  ctx.fill();
  // shade under the body
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(-w * 0.46, -h * 0.2, w * 0.92, h * 0.05);
  // tail lights
  ctx.fillStyle = braking ? '#ff2d2d' : '#b3171f';
  ctx.shadowColor = braking ? '#ff2d2d' : 'transparent';
  ctx.shadowBlur = braking ? w * 0.12 : 0;
  roundRect(ctx, -w * 0.43, -h * 0.5, w * 0.2, h * 0.1, w * 0.02);
  ctx.fill();
  roundRect(ctx, w * 0.23, -h * 0.5, w * 0.2, h * 0.1, w * 0.02);
  ctx.fill();
  ctx.shadowBlur = 0;
  // plate
  ctx.fillStyle = '#f5f5f5';
  ctx.fillRect(-w * 0.1, -h * 0.46, w * 0.2, h * 0.08);
  ctx.restore();
}

// ---- the game ---------------------------------------------------------------------
interface Proj {
  ok: boolean;
  x1: number;
  y1: number;
  w1: number;
  s1: number;
  x2: number;
  y2: number;
  w2: number;
  s2: number;
}

export class CarGame implements Scene {
  readonly title = 'Gyro Racer';
  readonly subtitle = 'Your phone is the steering wheel.';
  state: GameState = 'menu';
  score = 0;
  best = 0;
  lives = MAX_LIVES;

  private ctx: CanvasRenderingContext2D;
  private w = 800;
  private h = 600;
  private sc = 1;
  private segs = buildTrack();
  private trackLen = this.segs.length * SEG_LEN;
  private traffic: Traffic[] = [];
  private proj: Proj[] = Array.from({ length: DRAW }, () => ({ ok: false, x1: 0, y1: 0, w1: 0, s1: 0, x2: 0, y2: 0, w2: 0, s2: 0 }));

  // player
  private pos = 0; // camera z along the track
  private playerX = 0; // -1 .. 1 across the road
  private speed = 0;
  private distance = 0;
  private bonus = 0;
  private invul = 0;
  private shake = 0;
  private flash = 0;
  private steer = 0; // smoothed steering, -1..1
  private bgOff = 0;

  // input
  private gasPedal = false;
  private brakePedal = false;
  private keys = new Set<string>();
  private theta0: number | null = null;
  private theta = 0;
  private padSteer = 0;
  private lastPadSample = 0;
  private sens = 1;

  private texts: FloatText[] = [];
  private lastFrame = 0;
  private time = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private sfx: Sfx,
    private hooks: GameHooks,
  ) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('Canvas 2D is not available');
    this.ctx = c;
    try {
      this.best = Number(localStorage.getItem('bestCar') ?? 0) || 0;
    } catch {
      /* ignore */
    }
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.resetTraffic();
  }

  // ---------------------------------------------------------------- scene API
  enter(): void {
    this.resize();
    this.speed = 0;
    this.steer = 0;
    this.theta0 = null; // first sample after entering sets the neutral wheel angle
    this.gasPedal = false;
    this.brakePedal = false;
    this.texts = [];
    this.flash = 0;
    this.shake = 0;
    this.lastFrame = 0;
    this.resetTraffic();
    this.setState('menu');
  }

  exit(): void {
    this.sfx.engine(0, false);
  }

  requestStart(): void {
    if (this.state === 'menu' || this.state === 'over') this.startRace();
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
    this.sfx.engine(this.speed / MAX_SPEED, this.state === 'playing');
  }

  // ---------------------------------------------------------------- input
  setOrientation(o: Orientation, now: number): void {
    this.theta = wheelAngle(o);
    if (this.theta0 === null) this.theta0 = this.theta;
    this.padSteer = steerValue(this.theta - this.theta0, this.sens);
    this.lastPadSample = now;
  }
  calibrate(): void {
    this.theta0 = this.theta;
  }
  setSensitivity(v: number): void {
    this.sens = v;
  }
  setPedals(gas: boolean, brake: boolean): void {
    this.gasPedal = gas;
    this.brakePedal = brake;
  }
  padLost(): void {
    this.gasPedal = false;
    this.brakePedal = false;
    this.padSteer = 0;
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

  private resetTraffic(): void {
    const rng = Math.random;
    this.traffic = [];
    const spacing = (this.trackLen - 12000) / TRAFFIC;
    for (let i = 0; i < TRAFFIC; i++) {
      const z = (this.pos + PLAYER_Z + 6000 + i * spacing + rng() * spacing * 0.6) % this.trackLen;
      this.traffic.push({
        z,
        offset: LANE_X[Math.floor(rng() * LANES)],
        speed: MAX_SPEED * (0.2 + rng() * 0.2),
        color: CAR_COLORS[Math.floor(rng() * CAR_COLORS.length)],
        prevRel: 1e9,
      });
    }
  }

  private startRace(): void {
    this.speed = 0;
    this.playerX = 0;
    this.distance = 0;
    this.bonus = 0;
    this.score = 0;
    this.lives = MAX_LIVES;
    this.invul = 0;
    this.texts = [];
    this.resetTraffic();
    this.sfx.start();
    this.setState('playing');
  }

  private gameOver(): void {
    if (this.score > this.best) {
      this.best = this.score;
      try {
        localStorage.setItem('bestCar', String(this.best));
      } catch {
        /* ignore */
      }
    }
    this.setState('over');
  }

  // ---------------------------------------------------------------- update
  private segAt(z: number): Seg {
    return this.segs[Math.floor((((z % this.trackLen) + this.trackLen) % this.trackLen) / SEG_LEN)];
  }

  private rel(z: number): number {
    // signed distance from the player to z along the loop, in (-L/2, L/2]
    let d = (z - (this.pos + PLAYER_Z)) % this.trackLen;
    if (d > this.trackLen / 2) d -= this.trackLen;
    else if (d <= -this.trackLen / 2) d += this.trackLen;
    return d;
  }

  private update(dt: number): void {
    if (this.state === 'paused') return;
    this.time += dt;
    this.flash = Math.max(0, this.flash - dt * 2);
    this.shake = Math.max(0, this.shake - dt * 2.5);
    for (const t of this.texts) t.life -= dt;
    this.texts = this.texts.filter((t) => t.life > 0);

    const now = performance.now();
    const padActive = now - this.lastPadSample < 600;
    const keyLeft = this.keys.has('ArrowLeft') || this.keys.has('KeyA');
    const keyRight = this.keys.has('ArrowRight') || this.keys.has('KeyD');
    const target = padActive ? this.padSteer : (keyRight ? 1 : 0) - (keyLeft ? 1 : 0);
    this.steer += (target - this.steer) * Math.min(1, dt * (padActive ? 20 : 9));

    if (this.state === 'menu') {
      this.pos = (this.pos + 1800 * dt) % this.trackLen; // gentle idle drive for the background
      this.bgOff += this.segAt(this.pos + PLAYER_Z).curve * 0.15 * dt * 60;
      return;
    }

    const gas = this.gasPedal || this.keys.has('ArrowUp') || this.keys.has('KeyW');
    const brake = this.brakePedal || this.keys.has('ArrowDown') || this.keys.has('KeyS');
    const playing = this.state === 'playing';

    // speed
    const speedPct = this.speed / MAX_SPEED;
    const seg = this.segAt(this.pos + PLAYER_Z);
    if (playing) {
      if (brake) this.speed += BRAKING * dt;
      else if (gas) this.speed += ACCEL * dt;
      else this.speed += COAST * dt;
      const offroad = Math.abs(this.playerX) > 1.02;
      if (offroad && this.speed > OFFROAD_LIMIT) {
        this.speed += OFFROAD_DECEL * dt;
        this.shake = Math.max(this.shake, 0.25);
      }
      // steering and centrifugal force
      const dx = dt * 2 * speedPct;
      this.playerX += dx * this.steer * 1.25;
      this.playerX -= dx * speedPct * seg.curve * CENTRIFUGAL;
      this.playerX = clamp(this.playerX, -2.6, 2.6);
    } else {
      this.speed += COAST * 2 * dt; // game over: roll to a stop
    }
    this.speed = clamp(this.speed, 0, MAX_SPEED);

    const step = this.speed * dt;
    this.pos = (this.pos + step) % this.trackLen;
    this.bgOff += seg.curve * speedPct * dt * 140;
    if (playing) {
      this.distance += step;
      this.invul = Math.max(0, this.invul - dt);
    }

    // traffic
    for (const c of this.traffic) {
      c.z = (c.z + c.speed * dt) % this.trackLen;
      const rel = this.rel(c.z);
      const near = Math.abs(rel) < 3000 && Math.abs(c.prevRel) < 3000;
      if (playing && near && Math.sign(rel) !== Math.sign(c.prevRel)) {
        const lateral = Math.abs(this.playerX - c.offset);
        const wePassed = c.prevRel > 0;
        if (lateral < HIT && this.invul <= 0) {
          this.crash(c);
        } else if (wePassed) {
          if (lateral < NEAR) {
            this.bonus += 5;
            this.say('NEAR MISS  +5', '#ffe066');
            this.sfx.pass();
          } else {
            this.bonus += 1;
          }
        }
      }
      c.prevRel = rel;
    }

    if (playing) {
      this.score = Math.floor(this.distance / 8000) + this.bonus;
      if (this.score !== this.lastScore) {
        this.lastScore = this.score;
        this.hooks.onChange();
      }
    }
  }

  private lastScore = 0;

  private crash(c: Traffic): void {
    this.lives--;
    this.speed = Math.min(this.speed, c.speed * 0.6);
    this.invul = 1.8;
    this.shake = 1;
    this.flash = 1;
    this.sfx.crash();
    this.hooks.onHaptic(60);
    this.say('CRASH', '#ff6b6b');
    // push the car out of the way so we don't re-hit it
    c.z = (c.z + 3000) % this.trackLen;
    this.hooks.onChange();
    if (this.lives <= 0) this.gameOver();
  }

  private say(text: string, color: string): void {
    this.texts = [{ text, life: 1.1, color }];
  }

  // ---------------------------------------------------------------- render
  private render(): void {
    const { ctx, w, h } = this;
    const sc = this.sc;
    ctx.save();
    if (this.shake > 0) ctx.translate((Math.random() - 0.5) * 14 * this.shake * sc, (Math.random() - 0.5) * 10 * this.shake * sc);

    this.drawSky();
    this.projectRoad();
    this.drawRoad();
    this.drawPlayer();
    ctx.restore();

    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255,70,70,${this.flash * 0.45})`;
      ctx.fillRect(0, 0, w, h);
    }
    this.drawHud();
    this.drawBanner();
  }

  private drawSky(): void {
    const { ctx, w, h } = this;
    const horizon = h / 2;
    const g = ctx.createLinearGradient(0, 0, 0, horizon);
    g.addColorStop(0, '#3d86d6');
    g.addColorStop(1, '#bfe6f2');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, horizon + 2);
    ctx.fillStyle = '#2d9a43'; // ground below the horizon
    ctx.fillRect(0, horizon, w, h - horizon);

    // two parallax hill layers
    const layers = [
      { amp: h * 0.1, f: 0.0046, k: 0.35, color: '#6aa0b8', base: 0.96 },
      { amp: h * 0.07, f: 0.0083, k: 0.7, color: '#4d8b6a', base: 0.99 },
    ];
    for (const L of layers) {
      ctx.fillStyle = L.color;
      ctx.beginPath();
      ctx.moveTo(0, horizon + 1);
      for (let x = 0; x <= w; x += 8) {
        const t = (x + this.bgOff * L.k) * L.f;
        const y = horizon * L.base - L.amp * (0.55 + 0.3 * Math.sin(t) + 0.15 * Math.sin(t * 2.3 + 1));
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, horizon + 1);
      ctx.closePath();
      ctx.fill();
    }
  }

  private projectRoad(): void {
    const { w, h } = this;
    const N = this.segs.length;
    const baseIdx = Math.floor(this.pos / SEG_LEN) % N;
    const basePercent = (this.pos % SEG_LEN) / SEG_LEN;
    const camX = this.playerX * ROAD_W;
    let x = 0;
    let dx = -(this.segs[baseIdx].curve * basePercent);
    for (let n = 0; n < DRAW; n++) {
      const idx = (baseIdx + n) % N;
      const looped = idx < baseIdx;
      const z1 = idx * SEG_LEN + (looped ? this.trackLen : 0) - this.pos;
      const z2 = z1 + SEG_LEN;
      const p = this.proj[n];
      p.ok = z1 > CAM_DEPTH;
      if (p.ok) {
        p.s1 = CAM_DEPTH / z1;
        p.s2 = CAM_DEPTH / z2;
        p.x1 = w / 2 + p.s1 * (x - camX) * (w / 2);
        p.x2 = w / 2 + p.s2 * (x + dx - camX) * (w / 2);
        p.y1 = h / 2 + p.s1 * CAM_H * (h / 2);
        p.y2 = h / 2 + p.s2 * CAM_H * (h / 2);
        p.w1 = p.s1 * ROAD_W * (w / 2);
        p.w2 = p.s2 * ROAD_W * (w / 2);
      }
      x += dx;
      dx += this.segs[idx].curve;
    }
  }

  private drawRoad(): void {
    const { ctx, w, h } = this;
    const N = this.segs.length;
    const baseIdx = Math.floor(this.pos / SEG_LEN) % N;

    // bucket traffic by draw-distance index
    const buckets: Traffic[][] = [];
    for (const c of this.traffic) {
      const ci = Math.floor(c.z / SEG_LEN) % N;
      const n = (ci - baseIdx + N) % N;
      if (n < DRAW) (buckets[n] ??= []).push(c);
    }

    for (let n = DRAW - 1; n >= 0; n--) {
      const p = this.proj[n];
      if (!p.ok || p.y2 >= h) continue;
      const seg = this.segs[(baseIdx + n) % N];
      const dark = seg.dark;
      const { x1, y1, w1, x2, y2, w2 } = p;

      ctx.fillStyle = dark ? '#278f3b' : '#2f9f45';
      ctx.fillRect(0, y2, w, y1 - y2 + 1);

      const r1 = w1 / 6;
      const r2 = w2 / 6;
      const rumble = dark ? '#e8e8e8' : '#c0392b';
      poly(ctx, rumble, [x1 - w1 - r1, y1, x1 - w1, y1, x2 - w2, y2, x2 - w2 - r2, y2]);
      poly(ctx, rumble, [x1 + w1 + r1, y1, x1 + w1, y1, x2 + w2, y2, x2 + w2 + r2, y2]);
      poly(ctx, dark ? '#4e5058' : '#555760', [x1 - w1, y1, x1 + w1, y1, x2 + w2, y2, x2 - w2, y2]);

      if (!dark) {
        const l1 = w1 / 30;
        const l2 = w2 / 30;
        const lw1 = (w1 * 2) / LANES;
        const lw2 = (w2 * 2) / LANES;
        let lx1 = x1 - w1 + lw1;
        let lx2 = x2 - w2 + lw2;
        for (let lane = 1; lane < LANES; lane++) {
          poly(ctx, '#e6e6e6', [lx1 - l1 / 2, y1, lx1 + l1 / 2, y1, lx2 + l2 / 2, y2, lx2 - l2 / 2, y2]);
          lx1 += lw1;
          lx2 += lw2;
        }
      }

      // haze with distance
      const fog = 1 - 1 / Math.exp((n / DRAW) * (n / DRAW) * 5);
      if (fog > 0.01) {
        ctx.globalAlpha = fog;
        ctx.fillStyle = '#bfe6f2';
        ctx.fillRect(0, y2, w, y1 - y2 + 1);
        ctx.globalAlpha = 1;
      }

      // roadside scenery
      for (const s of seg.sprites) {
        const px = p.s1 * s.size * (w / 2);
        if (px < 5 || px > 900) continue;
        const sx = x1 + p.s1 * s.offset * ROAD_W * (w / 2);
        if (sx < -px || sx > w + px) continue;
        ctx.globalAlpha = 1 - fog * 0.9;
        ctx.font = `${px}px ${EMOJI_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(s.e, sx, y1 - px * 0.42);
        ctx.globalAlpha = 1;
      }

      // traffic in this segment
      const here = buckets[n];
      if (here) {
        for (const c of here) {
          const percent = (c.z % SEG_LEN) / SEG_LEN;
          const scale = p.s1 + (p.s2 - p.s1) * percent;
          const cx = x1 + (x2 - x1) * percent + scale * c.offset * ROAD_W * (w / 2);
          const cy = y1 + (y2 - y1) * percent;
          ctx.globalAlpha = 1 - fog * 0.85;
          drawCar(ctx, cx, cy, scale * CAR_W * (w / 2), c.color);
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  private drawPlayer(): void {
    const { ctx, w, h } = this;
    const blink = this.invul > 0 && Math.floor(this.time * 12) % 2 === 0;
    if (blink) return;
    const width = (CAM_DEPTH / PLAYER_Z) * CAR_W * (w / 2);
    const bounce = this.speed > 0 ? Math.sin(this.time * 38) * 1.2 * (this.speed / MAX_SPEED) * this.sc : 0;
    ctx.save();
    ctx.translate(w / 2, h - 26 * this.sc + bounce);
    ctx.rotate(this.steer * 0.07); // lean into the turn
    drawCar(ctx, 0, 0, width, '#ff3b30', this.brakePedal || this.keys.has('ArrowDown') || this.keys.has('KeyS'));
    ctx.restore();
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
    ctx.strokeText(`BEST ${this.best}`, pad, pad + 66 * sc);
    ctx.fillText(`BEST ${this.best}`, pad, pad + 66 * sc);

    // lives
    ctx.textAlign = 'right';
    ctx.font = `${34 * sc}px ${EMOJI_FONT}`;
    for (let i = 0; i < MAX_LIVES; i++) {
      ctx.globalAlpha = i < this.lives ? 1 : 0.25;
      ctx.fillText('🚗', w - pad - i * 46 * sc, pad + 34 * sc);
    }
    ctx.globalAlpha = 1;

    // speedometer
    ctx.textAlign = 'left';
    ctx.font = `800 ${54 * sc}px system-ui, sans-serif`;
    ctx.fillStyle = '#fff';
    const kmh = Math.round((this.speed / MAX_SPEED) * 220);
    ctx.strokeText(String(kmh), pad, h - pad - 18 * sc);
    ctx.fillText(String(kmh), pad, h - pad - 18 * sc);
    ctx.font = `600 ${16 * sc}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText('KM/H', pad, h - pad);

    // steering wheel indicator
    const cx = w - pad - 44 * sc;
    const cy = h - pad - 44 * sc;
    const r = 38 * sc;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.arc(0, 0, r + 6 * sc, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(this.steer * (Math.PI / 2));
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 6 * sc;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-r, 0);
    ctx.lineTo(r, 0);
    ctx.moveTo(0, 0);
    ctx.lineTo(0, r);
    ctx.stroke();
    ctx.fillStyle = '#ff3b30';
    ctx.fillRect(-4 * sc, -r - 4 * sc, 8 * sc, 12 * sc); // top marker
    ctx.restore();

    // floating message
    const t = this.texts[0];
    if (t) {
      ctx.textAlign = 'center';
      ctx.globalAlpha = Math.min(1, t.life * 2);
      ctx.font = `800 ${38 * sc}px system-ui, sans-serif`;
      ctx.strokeText(t.text, w / 2, h * 0.3);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, w / 2, h * 0.3);
      ctx.globalAlpha = 1;
    }
  }

  private drawBanner(): void {
    const { ctx, w, h } = this;
    const sc = this.sc;
    const lines: [string, number, string][] = [];
    if (this.state === 'menu') {
      lines.push(['Hold GAS on your phone to go, tilt it like a wheel to steer', 24, '#fff']);
      lines.push(['Press START on your phone, or Space', 30, '#ffe066']);
    } else if (this.state === 'over') {
      lines.push(['OUT OF CARS', 64, '#ff6b6b']);
      lines.push([`Score ${this.score}   ·   Best ${this.best}`, 30, '#fff']);
      lines.push(['Press START to race again', 26, '#ffe066']);
    } else if (this.state === 'paused') {
      lines.push(['PAUSED', 64, '#fff']);
      lines.push(['Press P, or Resume on your phone', 24, 'rgba(255,255,255,0.8)']);
    } else {
      return;
    }
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.fillRect(0, h * 0.3 - 40 * sc, w, 60 * sc + lines.length * 52 * sc);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 5 * sc;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    let y = h * 0.3 + 14 * sc;
    for (const [text, size, color] of lines) {
      ctx.font = `800 ${size * sc}px system-ui, sans-serif`;
      ctx.fillStyle = color;
      ctx.strokeText(text, w / 2, y);
      ctx.fillText(text, w / 2, y);
      y += (size + 22) * sc;
    }
  }
}
