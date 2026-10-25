// Orbit Defender: meteors fall on your planet from every side. Hold the phone flat like a
// dial and twist it (or turn on the spot) to swing the cannon round; it fires on its own.
// A shield arc in front of the cannon stops anything that slips through. Big rocks take
// three hits and split in two; shoot a ⚡ for a few seconds of triple rapid fire.
// Three hits on the planet end the run.

import { angleOf, bigChance, cannonAngle, dirOf, heading, inArc, meteorSpeed, PLANET_R, SHIELD_R, SHIELD_W, SPAWN_R, spawnAngle, spawnGap, turnToward } from '../shared/orbit';
import type { Orientation } from '../shared/pointer';
import type { GameState } from '../shared/protocol';
import type { Sfx } from './audio';
import type { GameHooks, Scene } from './scene';

const MAX_LIVES = 3;
const FIRE_GAP = 0.2; // seconds between shots
const RAPID_GAP = 0.08;
const RAPID_TIME = 6;
const BULLET_SPEED = 1.7; // arena radii per second
const SMALL = 0.045;
const BIG = 0.085;
const KEY_TURN = 220; // degrees per second with the arrow keys
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Meteor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  hp: number;
  rot: number;
  spin: number;
  shape: number[]; // radius factor per vertex
  power: boolean; // a ⚡ pickup instead of a rock
}
interface Bullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}
interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

function rockShape(): number[] {
  return Array.from({ length: 9 }, () => 0.75 + Math.random() * 0.35);
}

export class OrbitGame implements Scene {
  readonly title = 'Orbit Defender';
  readonly subtitle = 'Twist the phone like a dial to turn the cannon.';
  state: GameState = 'menu';
  score = 0;
  best = 0;
  lives = MAX_LIVES;

  private ctx: CanvasRenderingContext2D;
  private w = 800;
  private h = 600;
  private sc = 1;

  private angle = 0; // cannon, degrees
  private target = 0;
  private meteors: Meteor[] = [];
  private bullets: Bullet[] = [];
  private sparks: Spark[] = [];
  private stars: { x: number; y: number; s: number }[] = [];
  private time = 0;
  private nextSpawn = 0;
  private lastSpawnAngle: number | null = null;
  private fireTimer = 0;
  private rapid = 0;
  private shieldFlash = 0;
  private hurt = 0;
  private pops: { x: number; y: number; text: string; life: number }[] = [];

  // input
  private ref: number | null = null;
  private yaw = 0;
  private lastPadSample = 0;
  private lastMouse = 0;
  private sens = 1;
  private keys = new Set<string>();

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
      this.best = Number(localStorage.getItem('bestOrbit') ?? 0) || 0;
    } catch {
      /* ignore */
    }
    for (let i = 0; i < 160; i++) this.stars.push({ x: Math.random(), y: Math.random(), s: Math.random() });
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // ---------------------------------------------------------------- scene API
  enter(): void {
    this.resize();
    this.ref = null; // first sample after entering points the cannon up
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
    this.yaw = heading(o);
    if (this.ref === null) this.ref = this.yaw;
    this.target = cannonAngle(this.yaw, this.ref, this.sens);
    this.lastPadSample = now;
  }
  calibrate(): void {
    this.ref = this.yaw;
  }
  setSensitivity(v: number): void {
    this.sens = v;
  }
  padLost(): void {
    this.lastPadSample = 0;
  }
  /** Mouse fallback: the cannon points at the cursor. */
  aimAt(x: number, y: number): void {
    const { cx, cy } = this.arena();
    if (Math.hypot(x - cx, y - cy) < 5) return;
    this.target = angleOf(x - cx, y - cy);
    this.lastMouse = performance.now();
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

  /** Arena centre and radius in pixels. */
  private arena(): { cx: number; cy: number; R: number } {
    const top = 60 * this.sc;
    return { cx: this.w / 2, cy: top + (this.h - top) / 2, R: Math.min(this.w / 2, (this.h - top) / 2) * 0.9 };
  }

  private setState(s: GameState): void {
    this.state = s;
    document.body.dataset.state = s;
    this.hooks.onChange();
  }

  private reset(): void {
    this.meteors = [];
    this.bullets = [];
    this.sparks = [];
    this.pops = [];
    this.time = 0;
    this.nextSpawn = 1;
    this.lastSpawnAngle = null;
    this.rapid = 0;
    this.hurt = 0;
  }

  private startRun(): void {
    this.reset();
    this.score = 0;
    this.lives = MAX_LIVES;
    this.sfx.start();
    this.setState('playing');
  }

  private gameOver(): void {
    if (this.score > this.best) {
      this.best = this.score;
      try {
        localStorage.setItem('bestOrbit', String(this.best));
      } catch {
        /* ignore */
      }
    }
    this.setState('over');
  }

  // ---------------------------------------------------------------- update
  private spawn(): void {
    const t = this.time;
    const a = spawnAngle(this.lastSpawnAngle, Math.random);
    this.lastSpawnAngle = a;
    const d = dirOf(a);
    const power = Math.random() < 0.06 && this.rapid <= 0;
    const big = !power && Math.random() < bigChance(t);
    // later on, some rocks come in at a slant instead of straight at the planet
    const slant = t > 40 ? (Math.random() * 2 - 1) * Math.min(0.35, (t - 40) * 0.006) : 0;
    const speed = meteorSpeed(t) * (big ? 0.75 : power ? 0.7 : 1);
    const vx = -d.x * speed + -d.y * slant * speed;
    const vy = -d.y * speed + d.x * slant * speed;
    this.meteors.push({ x: d.x * SPAWN_R, y: d.y * SPAWN_R, vx, vy, size: big ? BIG : SMALL, hp: big ? 3 : 1, rot: Math.random() * 6, spin: (Math.random() * 2 - 1) * 2, shape: rockShape(), power });
  }

  private burst(x: number, y: number, color: string, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 0.1 + Math.random() * 0.4;
      this.sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.4 + Math.random() * 0.4, color });
    }
  }

  private update(dt: number): void {
    if (this.state === 'paused') return;

    // aim: phone, then mouse, then arrow keys
    const now = performance.now();
    const padActive = now - this.lastPadSample < 600;
    const turnKeys = (this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('ArrowLeft') ? 1 : 0);
    if (!padActive && turnKeys) this.target = this.angle + turnKeys * KEY_TURN * dt;
    const rate = padActive || now - this.lastMouse < 300 ? 900 : KEY_TURN;
    this.angle = turnToward(this.angle, this.target, rate * dt);

    for (const s of this.sparks) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.life -= dt;
    }
    this.sparks = this.sparks.filter((s) => s.life > 0);
    for (const p of this.pops) p.life -= dt;
    this.pops = this.pops.filter((p) => p.life > 0);
    this.shieldFlash = Math.max(0, this.shieldFlash - dt * 3);
    this.hurt = Math.max(0, this.hurt - dt * 1.5);

    if (this.state !== 'playing') return;
    this.time += dt;
    this.rapid = Math.max(0, this.rapid - dt);

    // fire
    this.fireTimer -= dt;
    if (this.fireTimer <= 0) {
      this.fireTimer = this.rapid > 0 ? RAPID_GAP : FIRE_GAP;
      const spread = this.rapid > 0 ? [-8, 0, 8] : [0];
      for (const off of spread) {
        const d = dirOf(this.angle + off);
        this.bullets.push({ x: d.x * SHIELD_R, y: d.y * SHIELD_R, vx: d.x * BULLET_SPEED, vy: d.y * BULLET_SPEED, life: 0.8 });
      }
    }

    // spawn
    this.nextSpawn -= dt;
    if (this.nextSpawn <= 0) {
      this.spawn();
      this.nextSpawn = spawnGap(this.time);
    }

    for (const b of this.bullets) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
    }

    const split: Meteor[] = [];
    for (const m of this.meteors) {
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      m.rot += m.spin * dt;

      for (const b of this.bullets) {
        if (b.life <= 0 || Math.hypot(b.x - m.x, b.y - m.y) > m.size + 0.012) continue;
        b.life = 0;
        m.hp--;
        if (m.hp > 0) {
          this.burst(b.x, b.y, '#c9b8a6', 4);
          this.sfx.land();
          continue;
        }
        if (m.power) {
          this.rapid = RAPID_TIME;
          this.pops.push({ x: m.x, y: m.y, text: 'RAPID FIRE!', life: 1.2 });
          this.burst(m.x, m.y, '#ffe066', 18);
          this.sfx.combo();
          this.hooks.onHaptic(30);
        } else {
          const pts = m.size === BIG ? 30 : 10;
          this.score += pts;
          this.pops.push({ x: m.x, y: m.y, text: `+${pts}`, life: 0.7 });
          this.burst(m.x, m.y, '#ffb36b', m.size === BIG ? 22 : 12);
          this.sfx.slice();
          this.hooks.onSlice();
          if (m.size === BIG) {
            // two small rocks fly off to the sides
            for (const s of [-1, 1]) split.push({ ...m, size: SMALL, hp: 1, vx: m.vx * 1.2 - m.vy * s * 0.8, vy: m.vy * 1.2 + m.vx * s * 0.8, shape: rockShape() });
          }
        }
        this.hooks.onChange();
        break;
      }
      if (m.hp <= 0) continue;

      const r = Math.hypot(m.x, m.y);
      if (r < SHIELD_R + m.size * 0.5 && inArc(angleOf(m.x, m.y), this.angle, SHIELD_W)) {
        m.hp = 0;
        if (!m.power) {
          this.score += 2;
          this.hooks.onChange();
        }
        this.shieldFlash = 1;
        this.burst(m.x, m.y, '#7fe7ff', 10);
        this.sfx.racket();
        this.hooks.onHaptic(15);
      } else if (r < PLANET_R + m.size * 0.6) {
        m.hp = 0;
        if (m.power) continue; // a missed pickup just fizzles
        this.lives--;
        this.hurt = 1;
        this.burst(m.x, m.y, '#ff6b6b', 26);
        this.sfx.bomb();
        this.hooks.onHaptic(70);
        this.hooks.onChange();
        if (this.lives <= 0) {
          this.gameOver();
          return;
        }
      } else if (r > SPAWN_R + 0.3) {
        m.hp = 0; // slanted rocks that miss everything drift off
      }
    }
    this.meteors = this.meteors.filter((m) => m.hp > 0).concat(split);
    this.bullets = this.bullets.filter((b) => b.life > 0);
  }

  // ---------------------------------------------------------------- render
  private render(): void {
    const { ctx, w, h } = this;
    const { cx, cy, R } = this.arena();
    const P = (x: number, y: number) => ({ x: cx + x * R, y: cy + y * R });

    ctx.fillStyle = '#07051a';
    ctx.fillRect(0, 0, w, h);
    const t = performance.now() / 1000;
    for (const s of this.stars) {
      ctx.globalAlpha = 0.3 + 0.5 * Math.abs(Math.sin(t * (0.5 + s.s) + s.x * 40));
      ctx.fillStyle = '#fff';
      ctx.fillRect(s.x * w, s.y * h, 1 + s.s * 1.5, 1 + s.s * 1.5);
    }
    ctx.globalAlpha = 1;

    // arena edge
    ctx.strokeStyle = 'rgba(120,140,255,0.15)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 10]);
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // aim line
    const d = dirOf(this.angle);
    const aim = ctx.createLinearGradient(cx + d.x * SHIELD_R * R, cy + d.y * SHIELD_R * R, cx + d.x * R, cy + d.y * R);
    aim.addColorStop(0, 'rgba(127,231,255,0.35)');
    aim.addColorStop(1, 'rgba(127,231,255,0)');
    ctx.strokeStyle = aim;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx + d.x * SHIELD_R * R, cy + d.y * SHIELD_R * R);
    ctx.lineTo(cx + d.x * R, cy + d.y * R);
    ctx.stroke();

    // planet
    const pr = PLANET_R * R;
    ctx.save();
    ctx.translate(cx, cy);
    if (this.hurt > 0) ctx.translate((Math.random() - 0.5) * 8 * this.hurt, (Math.random() - 0.5) * 8 * this.hurt);
    const glow = ctx.createRadialGradient(0, 0, pr, 0, 0, pr * 2.2);
    glow.addColorStop(0, 'rgba(90,160,255,0.35)');
    glow.addColorStop(1, 'rgba(90,160,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, pr * 2.2, 0, Math.PI * 2);
    ctx.fill();
    const body = ctx.createRadialGradient(-pr * 0.4, -pr * 0.4, pr * 0.1, 0, 0, pr);
    body.addColorStop(0, '#9fe0ff');
    body.addColorStop(0.5, '#3b82d6');
    body.addColorStop(1, '#173a7a');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(0, 0, pr, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(110,200,120,0.75)'; // continents
    ctx.beginPath();
    ctx.ellipse(-pr * 0.25, -pr * 0.1, pr * 0.35, pr * 0.22, 0.6, 0, Math.PI * 2);
    ctx.ellipse(pr * 0.35, pr * 0.35, pr * 0.22, pr * 0.15, -0.4, 0, Math.PI * 2);
    ctx.fill();
    if (this.hurt > 0) {
      ctx.fillStyle = `rgba(255,80,80,${this.hurt * 0.5})`;
      ctx.beginPath();
      ctx.arc(0, 0, pr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // shield arc and cannon
    const a0 = ((this.angle - 90 - SHIELD_W / 2) * Math.PI) / 180;
    const a1 = ((this.angle - 90 + SHIELD_W / 2) * Math.PI) / 180;
    ctx.lineCap = 'round';
    ctx.strokeStyle = `rgba(127,231,255,${0.55 + this.shieldFlash * 0.45})`;
    ctx.lineWidth = (6 + this.shieldFlash * 5) * this.sc;
    ctx.shadowColor = '#7fe7ff';
    ctx.shadowBlur = (10 + this.shieldFlash * 20) * this.sc;
    ctx.beginPath();
    ctx.arc(cx, cy, SHIELD_R * R, a0, a1);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((this.angle * Math.PI) / 180);
    ctx.fillStyle = this.rapid > 0 ? '#ffe066' : '#dfe7f2';
    ctx.fillRect(-4 * this.sc, -SHIELD_R * R - 4 * this.sc, 8 * this.sc, SHIELD_R * R - pr + 6 * this.sc);
    ctx.restore();
    ctx.lineCap = 'butt';

    // bullets
    ctx.fillStyle = this.rapid > 0 ? '#ffe066' : '#bff3ff';
    for (const b of this.bullets) {
      const p = P(b.x, b.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.2 * this.sc, 0, Math.PI * 2);
      ctx.fill();
    }

    // meteors
    for (const m of this.meteors) {
      const p = P(m.x, m.y);
      const r = m.size * R;
      if (m.power) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `${r * 2}px ${EMOJI_FONT}`;
        ctx.fillText('⚡', p.x, p.y);
        continue;
      }
      // trail toward where it came from
      const sp = Math.hypot(m.vx, m.vy) || 1;
      const tail = ctx.createLinearGradient(p.x, p.y, p.x - (m.vx / sp) * r * 4, p.y - (m.vy / sp) * r * 4);
      tail.addColorStop(0, 'rgba(255,150,80,0.45)');
      tail.addColorStop(1, 'rgba(255,150,80,0)');
      ctx.strokeStyle = tail;
      ctx.lineWidth = r * 1.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - (m.vx / sp) * r * 4, p.y - (m.vy / sp) * r * 4);
      ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(m.rot);
      const rock = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
      rock.addColorStop(0, m.size === BIG ? '#a68c78' : '#b59a83');
      rock.addColorStop(1, '#4d3b30');
      ctx.fillStyle = rock;
      ctx.beginPath();
      m.shape.forEach((k, i) => {
        const a = (i / m.shape.length) * Math.PI * 2;
        const x = Math.cos(a) * r * k;
        const y = Math.sin(a) * r * k;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fill();
      if (m.size === BIG && m.hp < 3) {
        ctx.strokeStyle = 'rgba(255,170,90,0.8)'; // cracks
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-r * 0.4, -r * 0.2);
        ctx.lineTo(0, 0);
        ctx.lineTo(r * 0.3, -r * 0.4);
        if (m.hp < 2) {
          ctx.moveTo(0, 0);
          ctx.lineTo(r * 0.1, r * 0.5);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // sparks
    for (const s of this.sparks) {
      const p = P(s.x, s.y);
      ctx.globalAlpha = clamp(s.life * 2, 0, 1);
      ctx.fillStyle = s.color;
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;

    // floating points
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `800 ${20 * this.sc}px system-ui, sans-serif`;
    ctx.lineWidth = 4 * this.sc;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    for (const pop of this.pops) {
      const p = P(pop.x, pop.y);
      ctx.globalAlpha = clamp(pop.life * 2, 0, 1);
      ctx.fillStyle = pop.text.startsWith('+') ? '#ffe066' : '#fff';
      ctx.strokeText(pop.text, p.x, p.y - (1 - pop.life) * 30 * this.sc);
      ctx.fillText(pop.text, p.x, p.y - (1 - pop.life) * 30 * this.sc);
    }
    ctx.globalAlpha = 1;

    this.drawHud();
    this.drawBanner();
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
    const sub = this.state === 'menu' ? `BEST ${this.best}` : `${Math.floor(this.time)}s   ·   BEST ${this.best}`;
    ctx.strokeText(sub, pad, pad + 66 * sc);
    ctx.fillText(sub, pad, pad + 66 * sc);
    if (this.rapid > 0) {
      ctx.fillStyle = '#ffe066';
      ctx.fillText(`⚡ RAPID FIRE ${this.rapid.toFixed(1)}s`, pad, pad + 92 * sc);
    }

    // planet health (top right, clear of the Menu button)
    ctx.textAlign = 'right';
    ctx.font = `${28 * sc}px ${EMOJI_FONT}`;
    for (let i = 0; i < MAX_LIVES; i++) {
      ctx.globalAlpha = i < this.lives ? 1 : 0.22;
      ctx.fillText('🛡️', w - pad - 150 * sc - i * 40 * sc, pad + 30 * sc);
    }
    ctx.globalAlpha = 1;

    // compass: which way the cannon points
    const R = 38 * sc;
    const cx = w - pad - R;
    const cy = h - pad - R;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.arc(cx, cy, R + 6 * sc, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 2 * sc;
    for (let i = 0; i < 8; i++) {
      const d = dirOf(i * 45);
      ctx.beginPath();
      ctx.moveTo(cx + d.x * R * 0.8, cy + d.y * R * 0.8);
      ctx.lineTo(cx + d.x * R, cy + d.y * R);
      ctx.stroke();
    }
    const d = dirOf(this.angle);
    ctx.strokeStyle = '#7fe7ff';
    ctx.lineWidth = 4 * sc;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + d.x * R * 0.85, cy + d.y * R * 0.85);
    ctx.stroke();
  }

  private drawBanner(): void {
    const { ctx, w, h } = this;
    const sc = this.sc;
    const lines: [string, number, string][] = [];
    if (this.state === 'menu') {
      lines.push(['Hold the phone flat like a dial, top edge toward this screen', 24, '#fff']);
      lines.push(['Twist it (or turn around) to swing the cannon. It fires on its own', 22, 'rgba(255,255,255,0.85)']);
      lines.push(['Press START on your phone, or Space', 30, '#ffe066']);
    } else if (this.state === 'over') {
      lines.push(['PLANET LOST', 64, '#ff6b6b']);
      lines.push([`Score ${this.score}   ·   ${Math.floor(this.time)}s   ·   Best ${this.best}`, 30, '#fff']);
      lines.push(['Press START to defend again', 26, '#ffe066']);
    } else if (this.state === 'paused') {
      lines.push(['PAUSED', 64, '#fff']);
      lines.push(['Press P, or Resume on your phone', 24, 'rgba(255,255,255,0.8)']);
    } else {
      return;
    }
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
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
