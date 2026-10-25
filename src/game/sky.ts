// Sky Rings: the phone is an aircraft yoke. Hold it upright like a steering wheel, turn it
// to bank, pull the top edge back to climb and push it away to dive. Fly through the rings
// as they come at you: the centre of a ring scores double, gold rings triple, and a streak
// of rings raises the multiplier. Each missed ring costs one of three planes.

import { forwardSpeed, judge, nextRing, PLANE_VX, PLANE_VY, X_RANGE, Y_RANGE, yoke, yokeInput, type Ring, type Yoke } from '../shared/flight';
import type { Orientation } from '../shared/pointer';
import type { GameState } from '../shared/protocol';
import type { Sfx } from './audio';
import type { GameHooks, Scene } from './scene';

const MAX_LIVES = 3;
const AHEAD = 7; // rings kept in front of the plane
const CAM_BACK = 4; // camera distance behind the plane
const GROUND_Y = -5.5;
const STRIPE = 8; // ground band length
const MAX_MULT = 5;
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Cloud {
  x: number;
  y: number;
  z: number;
  s: number;
}
interface FloatText {
  text: string;
  life: number;
  color: string;
}

export class SkyGame implements Scene {
  readonly title = 'Sky Rings';
  readonly subtitle = 'Your phone is the yoke. Fly through the rings.';
  state: GameState = 'menu';
  score = 0;
  best = 0;
  lives = MAX_LIVES;

  private ctx: CanvasRenderingContext2D;
  private w = 800;
  private h = 600;
  private sc = 1;

  // flight
  private px = 0;
  private py = 0;
  private bank = 0; // smoothed -1..1, for drawing
  private distance = 0;
  private rings: Ring[] = [];
  private ringNo = 0;
  private streak = 0;
  private mult = 1;
  private clouds: Cloud[] = [];
  private flash = 0;
  private flashColor = '#fff';

  // input
  private ref: Yoke | null = null;
  private cur: Yoke = { roll: 0, pitch: 0 };
  private padCtl = { x: 0, y: 0 };
  private ctl = { x: 0, y: 0 };
  private lastPadSample = 0;
  private sens = 1;
  private invert = false;
  private keys = new Set<string>();

  private texts: FloatText[] = [];
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
      this.best = Number(localStorage.getItem('bestSky') ?? 0) || 0;
      this.invert = localStorage.getItem('skyInvert') === '1';
    } catch {
      /* ignore */
    }
    for (let i = 0; i < 26; i++) this.clouds.push(this.newCloud(Math.random() * 140));
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // ---------------------------------------------------------------- scene API
  enter(): void {
    this.resize();
    this.ref = null; // first sample after entering sets level flight
    this.lastFrame = 0;
    this.texts = [];
    this.rings = [];
    this.px = 0;
    this.py = 0;
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
    this.cur = yoke(o);
    if (this.ref === null) this.ref = { ...this.cur };
    this.padCtl = yokeInput(this.cur, this.ref, this.sens, this.invert);
    this.lastPadSample = now;
  }
  calibrate(): void {
    this.ref = { ...this.cur };
  }
  setSensitivity(v: number): void {
    this.sens = v;
  }
  padLost(): void {
    this.padCtl = { x: 0, y: 0 };
    this.lastPadSample = 0;
  }
  keyDown(code: string): void {
    if (code === 'KeyI' && !this.keys.has('KeyI')) {
      this.invert = !this.invert;
      this.texts.unshift({ text: this.invert ? 'Pitch inverted: push to climb' : 'Pitch normal: pull back to climb', life: 2, color: '#fff' });
      try {
        localStorage.setItem('skyInvert', this.invert ? '1' : '0');
      } catch {
        /* ignore */
      }
    }
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

  /** Clouds float beside and above the flight box, never in the way of the rings. */
  private newCloud(z: number): Cloud {
    const side = Math.random() < 0.7;
    const x = side ? (Math.random() < 0.5 ? -1 : 1) * (X_RANGE + 6 + Math.random() * 30) : (Math.random() * 2 - 1) * 30;
    const y = side ? -2 + Math.random() * 12 : Y_RANGE + 5 + Math.random() * 6;
    return { x, y, z, s: 2 + Math.random() * 3 };
  }

  private startRun(): void {
    this.score = 0;
    this.lives = MAX_LIVES;
    this.distance = 0;
    this.streak = 0;
    this.mult = 1;
    this.texts = [];
    this.ringNo = 0;
    this.rings = [];
    let prev = { x: this.px, y: this.py, z: 30 };
    for (let i = 0; i < AHEAD; i++) prev = this.addRing(prev);
    this.sfx.start();
    this.setState('playing');
  }

  private addRing(prev: { x: number; y: number; z: number }): Ring {
    const r = nextRing(prev, this.ringNo++, forwardSpeed(this.distance), Math.random);
    this.rings.push(r);
    return r;
  }

  private gameOver(): void {
    if (this.score > this.best) {
      this.best = this.score;
      try {
        localStorage.setItem('bestSky', String(this.best));
      } catch {
        /* ignore */
      }
    }
    this.setState('over');
  }

  // ---------------------------------------------------------------- update
  private update(dt: number): void {
    if (this.state === 'paused') return;
    for (const t of this.texts) t.life -= dt;
    this.texts = this.texts.filter((t) => t.life > 0);
    this.flash = Math.max(0, this.flash - dt * 2.5);

    const padActive = performance.now() - this.lastPadSample < 600;
    const k = (a: string, b: string) => (this.keys.has(a) ? 1 : 0) - (this.keys.has(b) ? 1 : 0);
    const target = padActive ? this.padCtl : { x: k('ArrowRight', 'ArrowLeft'), y: k('ArrowUp', 'ArrowDown') };
    const a = Math.min(1, dt * (padActive ? 16 : 7));
    this.ctl.x += (target.x - this.ctl.x) * a;
    this.ctl.y += (target.y - this.ctl.y) * a;
    this.bank += (this.ctl.x - this.bank) * Math.min(1, dt * 6);

    this.px = clamp(this.px + this.ctl.x * PLANE_VX * dt, -X_RANGE, X_RANGE);
    this.py = clamp(this.py + this.ctl.y * PLANE_VY * dt, -Y_RANGE, Y_RANGE);

    const playing = this.state === 'playing';
    const speed = playing ? forwardSpeed(this.distance) : 14;
    const step = speed * dt;
    if (playing) this.distance += step;
    for (const c of this.clouds) {
      c.z -= step;
      if (c.z < -CAM_BACK + 0.5) Object.assign(c, this.newCloud(120 + Math.random() * 20));
    }
    if (!playing) return;

    for (const r of this.rings) r.z -= step;
    while (this.rings.length && this.rings[0].z <= 0) {
      const r = this.rings.shift()!;
      this.passRing(r);
      if (this.state !== 'playing') return;
      this.addRing(this.rings[this.rings.length - 1] ?? { x: this.px, y: this.py, z: 0 });
    }
  }

  private passRing(r: Ring): void {
    const v = judge(r, this.px, this.py);
    if (v === 'miss') {
      this.streak = 0;
      this.mult = 1;
      this.lives--;
      this.flash = 1;
      this.flashColor = '#ff6b6b';
      this.texts.unshift({ text: 'MISSED', life: 0.9, color: '#ff6b6b' });
      this.sfx.miss();
      this.hooks.onHaptic(50);
      this.hooks.onChange();
      if (this.lives <= 0) this.gameOver();
      return;
    }
    this.streak++;
    this.mult = Math.min(MAX_MULT, 1 + Math.floor(this.streak / 5));
    const pts = (v === 'bull' ? 20 : 10) * (r.gold ? 3 : 1) * this.mult;
    this.score += pts;
    this.flash = 0.6;
    this.flashColor = r.gold ? '#ffd166' : '#7fe7ff';
    this.texts.unshift({ text: `${v === 'bull' ? 'BULLSEYE ' : ''}+${pts}${this.mult > 1 ? `  ×${this.mult}` : ''}`, life: 0.9, color: r.gold ? '#ffd166' : '#fff' });
    if (v === 'bull' || r.gold) this.sfx.combo();
    else this.sfx.pass();
    this.hooks.onSlice();
    this.hooks.onChange();
  }

  // ---------------------------------------------------------------- render
  private render(): void {
    const { ctx, w, h } = this;
    const f = h * 0.9;
    // the camera sits right behind the plane: a ring you are lined up with is dead centre
    const camX = this.px;
    const camY = this.py;
    const proj = (x: number, y: number, z: number) => {
      const s = f / (z + CAM_BACK);
      return { x: w / 2 + (x - camX) * s, y: h * 0.48 - (y - camY) * s, s };
    };
    const tiltRad = -this.bank * 0.35;
    const horizon = h * 0.48; // where z = infinity projects

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(tiltRad);
    ctx.translate(-w / 2, -h / 2);
    const big = Math.hypot(w, h);

    // sky and sun
    const sky = ctx.createLinearGradient(0, horizon - h, 0, horizon);
    sky.addColorStop(0, '#2a6fdb');
    sky.addColorStop(1, '#a9dcff');
    ctx.fillStyle = sky;
    ctx.fillRect(w / 2 - big, horizon - big * 2, big * 2, big * 2);
    ctx.fillStyle = 'rgba(255,244,200,0.9)';
    ctx.beginPath();
    ctx.arc(w * 0.78 - camX * 4, horizon - h * 0.3, 40 * this.sc, 0, Math.PI * 2);
    ctx.fill();

    // ground: bands rushing towards you
    ctx.fillStyle = '#5fae4a';
    ctx.fillRect(w / 2 - big, horizon, big * 2, big * 2);
    const off = this.distance % (STRIPE * 2);
    ctx.fillStyle = '#4f9a3d';
    for (let z = -off; z < 180; z += STRIPE * 2) {
      const a = proj(0, GROUND_Y, Math.max(-CAM_BACK + 0.3, z));
      const b = proj(0, GROUND_Y, z + STRIPE);
      if (b.y >= a.y) continue;
      ctx.fillRect(w / 2 - big, b.y, big * 2, a.y - b.y);
    }
    // haze on the horizon
    const haze = ctx.createLinearGradient(0, horizon - 30 * this.sc, 0, horizon + 50 * this.sc);
    haze.addColorStop(0, 'rgba(220,240,255,0)');
    haze.addColorStop(0.4, 'rgba(220,240,255,0.7)');
    haze.addColorStop(1, 'rgba(220,240,255,0)');
    ctx.fillStyle = haze;
    ctx.fillRect(w / 2 - big, horizon - 30 * this.sc, big * 2, 80 * this.sc);

    // far to near: clouds and rings together
    type Item = { z: number; draw: () => void };
    const items: Item[] = [];
    for (const c of this.clouds) items.push({ z: c.z, draw: () => this.drawCloud(proj(c.x, c.y, c.z), c) });
    this.rings.forEach((r, i) => items.push({ z: r.z, draw: () => this.drawRing(proj(r.x, r.y, r.z), r, i === 0) }));
    items.sort((p, q) => q.z - p.z);
    for (const it of items) if (it.z > -CAM_BACK + 0.6) it.draw();
    ctx.restore();

    this.drawPlane(proj(this.px, this.py, 0));

    if (this.flash > 0) {
      ctx.globalAlpha = this.flash * 0.25;
      ctx.fillStyle = this.flashColor;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }
    this.drawHud();
    this.drawBanner();
  }

  private drawCloud(p: { x: number; y: number; s: number }, c: Cloud): void {
    const { ctx } = this;
    const r = c.s * p.s * 0.5;
    if (r < 1) return;
    ctx.fillStyle = `rgba(255,255,255,${0.85 * clamp(c.z / 12, 0, 1)})`;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, r * 1.6, r * 0.7, 0, 0, Math.PI * 2);
    ctx.ellipse(p.x - r * 0.7, p.y + r * 0.1, r * 0.8, r * 0.55, 0, 0, Math.PI * 2);
    ctx.ellipse(p.x + r * 0.6, p.y - r * 0.25, r, r * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawRing(p: { x: number; y: number; s: number }, r: Ring, next: boolean): void {
    const { ctx } = this;
    const R = r.r * p.s;
    const t = Math.max(2, R * 0.16);
    const near = clamp((r.z + CAM_BACK - 1) / 3, 0, 1); // fade the ring as it sweeps past the camera
    ctx.globalAlpha = near;
    ctx.lineWidth = t * 1.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.arc(p.x, p.y + t * 0.3, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = t;
    ctx.strokeStyle = r.gold ? '#ffcc33' : next ? '#ff4fa3' : '#ff8cc6';
    ctx.beginPath();
    ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = Math.max(1, t * 0.3);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, R - t * 0.2, Math.PI * 1.1, Math.PI * 1.7);
    ctx.stroke();
    if (next) {
      // bullseye marker
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** A small plane seen from behind, banking with the yoke. */
  private drawPlane(p: { x: number; y: number; s: number }): void {
    const { ctx } = this;
    const u = p.s * 0.55; // half wingspan in pixels
    ctx.save();
    ctx.translate(p.x, p.y + u * 0.35);
    ctx.rotate(this.bank * 0.6);
    ctx.scale(1, 1 - Math.abs(this.ctl.y) * 0.15);
    // shadow glow
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.ellipse(0, u * 0.25, u * 1.05, u * 0.18, 0, 0, Math.PI * 2);
    ctx.fill();
    // wings
    ctx.fillStyle = '#e63946';
    ctx.beginPath();
    ctx.moveTo(-u, u * 0.05);
    ctx.lineTo(u, u * 0.05);
    ctx.lineTo(u * 0.9, u * 0.17);
    ctx.lineTo(-u * 0.9, u * 0.17);
    ctx.closePath();
    ctx.fill();
    // tailplane and fin
    ctx.fillStyle = '#c1121f';
    ctx.fillRect(-u * 0.38, -u * 0.12, u * 0.76, u * 0.08);
    ctx.beginPath();
    ctx.moveTo(-u * 0.04, -u * 0.12);
    ctx.lineTo(0, -u * 0.48);
    ctx.lineTo(u * 0.04, -u * 0.12);
    ctx.closePath();
    ctx.fill();
    // fuselage
    const body = ctx.createRadialGradient(-u * 0.05, -u * 0.02, u * 0.02, 0, u * 0.05, u * 0.2);
    body.addColorStop(0, '#ffffff');
    body.addColorStop(1, '#b8c0cc');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(0, u * 0.05, u * 0.17, 0, Math.PI * 2);
    ctx.fill();
    // exhaust glow
    ctx.fillStyle = 'rgba(255,190,90,0.8)';
    ctx.beginPath();
    ctx.arc(0, u * 0.05, u * 0.06, 0, Math.PI * 2);
    ctx.fill();
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
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    const sub = this.state === 'menu' ? `BEST ${this.best}` : `${Math.floor(this.distance)} m   ·   ×${this.mult}   ·   BEST ${this.best}`;
    ctx.strokeText(sub, pad, pad + 66 * sc);
    ctx.fillText(sub, pad, pad + 66 * sc);

    // planes left (top right, clear of the Menu button)
    ctx.textAlign = 'right';
    ctx.font = `${30 * sc}px ${EMOJI_FONT}`;
    for (let i = 0; i < MAX_LIVES; i++) {
      ctx.globalAlpha = i < this.lives ? 1 : 0.25;
      ctx.fillText('✈️', w - pad - 150 * sc - i * 42 * sc, pad + 32 * sc);
    }
    ctx.globalAlpha = 1;

    // artificial horizon: bank and climb
    const R = 38 * sc;
    const cx = w - pad - R;
    const cy = h - pad - R;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate(-this.bank * 0.6);
    const ho = this.ctl.y * R * 0.5;
    ctx.fillStyle = '#4f9fe6';
    ctx.fillRect(-R * 2, -R * 2, R * 4, R * 2 + ho);
    ctx.fillStyle = '#8a5a2b';
    ctx.fillRect(-R * 2, ho, R * 4, R * 2);
    ctx.restore();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3 * sc;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.moveTo(cx - R * 0.5, cy);
    ctx.lineTo(cx - R * 0.15, cy);
    ctx.lineTo(cx, cy + R * 0.12);
    ctx.lineTo(cx + R * 0.15, cy);
    ctx.lineTo(cx + R * 0.5, cy);
    ctx.stroke();

    // floating message
    const t = this.texts[0];
    if (t) {
      ctx.textAlign = 'center';
      ctx.globalAlpha = Math.min(1, t.life * 2);
      ctx.font = `800 ${34 * sc}px system-ui, sans-serif`;
      ctx.strokeText(t.text, w / 2, h * 0.2);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, w / 2, h * 0.2);
      ctx.globalAlpha = 1;
    }
  }

  private drawBanner(): void {
    const { ctx, w, h } = this;
    const sc = this.sc;
    const lines: [string, number, string][] = [];
    if (this.state === 'menu') {
      lines.push(['Hold the phone upright like a yoke, screen facing you', 24, '#fff']);
      lines.push(['Turn it to bank, pull the top back to climb, push it away to dive', 22, 'rgba(255,255,255,0.9)']);
      lines.push(['Press START on your phone, or Space', 30, '#ffe066']);
    } else if (this.state === 'over') {
      lines.push(['OUT OF PLANES', 64, '#ff6b6b']);
      lines.push([`Score ${this.score}   ·   ${Math.floor(this.distance)} m   ·   Best ${this.best}`, 30, '#fff']);
      lines.push(['Press START to fly again', 26, '#ffe066']);
    } else if (this.state === 'paused') {
      lines.push(['PAUSED', 64, '#fff']);
      lines.push(['Press P, or Resume on your phone', 24, 'rgba(255,255,255,0.8)']);
    } else {
      return;
    }
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
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
