// Bowling: ten frames of ten-pin with the phone as the ball. Point the phone to line up
// along the foul line, hold GRIP on the phone, swing your arm underarm and let go of GRIP
// to release. Swing speed sets the ball speed, a sideways swing the angle, and a twist of
// the wrist as you let go adds hook. Scored like the real thing: strikes, spares, and the
// tenth-frame bonus balls.
//
// Without a phone: move the mouse to line up, then press and flick the mouse upward.

import { BALL_R, frames, HEAD_Z, LANE_W, laneSettled, launch, marks, PIN_R, rack, stepLane, ThrowTracker, totals, type Ball, type Pin, type Throw } from '../shared/bowling';
import type { GameState } from '../shared/protocol';
import type { Sfx } from './audio';
import type { GameHooks, Scene } from './scene';

const RESULT_TIME = 1.9;
const ROLL_TIMEOUT = 9; // seconds before a roll is scored regardless
const PIN_H = 0.38;
const CAM_H = 1.35;
const GUTTER_W = 0.24;
const START_X = LANE_W / 2 - BALL_R - 0.05; // furthest left/right the ball can start

type Phase = 'aim' | 'grip' | 'rolling' | 'result';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class BowlingGame implements Scene {
  readonly title = 'Bowling';
  readonly subtitle = 'Hold GRIP on the phone, swing, and let go.';
  state: GameState = 'menu';
  score = 0;
  best = 0;
  lives = 1; // frame number, shown on the phone

  private ctx: CanvasRenderingContext2D;
  private w = 800;
  private h = 600;
  private sc = 1;

  private rolls: number[] = [];
  private pins: Pin[] = rack();
  private ball: Ball | null = null;
  private phase: Phase = 'aim';
  private phaseT = 0;
  private startX = 0;
  private resultText = '';
  private note = '';
  private noteT = 0;
  private camZ = -4;
  private spin = 0;
  private hitSound = false;

  // input
  private tracker = new ThrowTracker();
  private mouse: { x: number; y: number; t: number }[] = [];
  private mouseHeld = false;
  private lastPad = 0;
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
      this.best = Number(localStorage.getItem('bestBowl') ?? 0) || 0;
    } catch {
      /* ignore */
    }
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // ---------------------------------------------------------------- scene API
  enter(): void {
    this.resize();
    this.lastFrame = 0;
    this.rolls = [];
    this.pins = rack();
    this.ball = null;
    this.setPhase('aim');
    this.setState('menu');
  }

  requestStart(): void {
    if (this.state === 'menu' || this.state === 'over') this.startGame();
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
  /** Line up: x is the pointer across the screen, in pixels. Locked while gripping. */
  aim(x: number): void {
    if (this.phase === 'aim') this.startX = clamp(((x / this.w) * 2 - 1) * START_X * 1.2, -START_X, START_X);
  }
  /** Phone orientation stream (degrees) for reading the swing. */
  orient(pitch: number, yaw: number, roll: number, now: number): void {
    this.lastPad = now;
    this.tracker.push(pitch, yaw, roll, now);
  }
  setSensitivity(v: number): void {
    this.tracker.sens = v;
  }
  grip(): void {
    if (this.state === 'menu' || this.state === 'over') this.startGame();
    if (this.state !== 'playing' || this.phase !== 'aim') return;
    this.setPhase('grip');
    this.hooks.onHaptic(15);
  }
  release(now: number): void {
    if (this.state !== 'playing' || this.phase !== 'grip') return;
    const t = this.tracker.release(now);
    if (!t) {
      this.say('Swing your arm, then let go of GRIP');
      this.setPhase('aim');
      return;
    }
    this.bowl(t);
  }

  // mouse: press, flick upward, let go
  mouseMove(x: number, y: number, now: number): void {
    if (now - this.lastPad < 1500) return; // the phone is in charge
    this.aim(x);
    this.mouse.push({ x, y, t: now });
    while (this.mouse.length && this.mouse[0].t < now - 200) this.mouse.shift();
  }
  mouseDown(): void {
    if (performance.now() - this.lastPad < 1500) return;
    this.mouseHeld = true;
    this.grip();
  }
  mouseUp(now: number): void {
    if (!this.mouseHeld) return;
    this.mouseHeld = false;
    if (this.state !== 'playing' || this.phase !== 'grip') return;
    const m = this.mouse.filter((p) => p.t >= now - 120);
    const first = m[0];
    const last = m[m.length - 1];
    const dt = first && last ? (last.t - first.t) / 1000 : 0;
    const up = dt > 0 ? (first.y - last.y) / dt : 0; // px/s upward
    if (up < this.h * 0.5) {
      this.say('Flick the mouse upward as you let go');
      this.setPhase('aim');
      return;
    }
    const side = (last.x - first.x) / dt;
    this.bowl({ speed: clamp(3 + (up / this.h) * 1.6, 3, 10), angle: clamp((side / up) * 0.08, -0.08, 0.08), hook: 0 });
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

  private setPhase(p: Phase): void {
    this.phase = p;
    this.phaseT = 0;
  }

  private say(text: string): void {
    this.note = text;
    this.noteT = 2.2;
  }

  private startGame(): void {
    this.rolls = [];
    this.pins = rack();
    this.ball = null;
    this.score = 0;
    this.lives = 1;
    this.camZ = -4;
    this.setPhase('aim');
    this.sfx.start();
    this.setState('playing');
  }

  private bowl(t: Throw): void {
    this.ball = launch(this.startX, t);
    this.hitSound = false;
    this.sfx.land();
    this.hooks.onHaptic(25);
    this.setPhase('rolling');
  }

  // ---------------------------------------------------------------- update
  private update(dt: number): void {
    this.noteT = Math.max(0, this.noteT - dt);
    if (this.state !== 'playing') return;
    this.phaseT += dt;
    const ball = this.ball;
    if (this.phase === 'rolling' && ball) {
      const upBefore = this.pins.filter((p) => p.up && !p.gone).length;
      stepLane(ball, this.pins, dt);
      this.spin += Math.hypot(ball.vx, ball.vz) * dt * 6;
      const upNow = this.pins.filter((p) => p.up && !p.gone).length;
      if (upNow < upBefore && !this.hitSound) {
        this.hitSound = true;
        this.sfx.crash();
        this.hooks.onHaptic(40);
      }
      this.camZ = clamp(ball.z - 7, -4, HEAD_Z - 8.5);
      if (laneSettled(ball, this.pins) || this.phaseT > ROLL_TIMEOUT) this.scoreRoll();
    } else if (this.phase === 'result' && this.phaseT >= RESULT_TIME) {
      this.nextRoll();
    } else if (this.phase !== 'rolling') {
      this.camZ += (-4 - this.camZ) * Math.min(1, dt * 3);
    }
  }

  private scoreRoll(): void {
    const before = frames(this.rolls);
    const down = this.pins.filter((p) => !p.up && !p.gone).length;
    this.rolls.push(down);
    const standingBefore = before.standing;
    const t = totals(this.rolls).filter((x): x is number => x !== null);
    this.score = t[t.length - 1] ?? 0;
    if (this.ball?.gutter && down === 0) this.resultText = 'GUTTER BALL';
    else if (down === standingBefore && before.fresh) this.resultText = 'STRIKE!';
    else if (down === standingBefore) this.resultText = 'SPARE!';
    else if (down === 0) this.resultText = 'MISS';
    else this.resultText = `${down} PIN${down === 1 ? '' : 'S'}`;
    if (this.resultText === 'STRIKE!' || this.resultText === 'SPARE!') this.sfx.combo();
    this.hooks.onChange();
    this.setPhase('result');
  }

  private nextRoll(): void {
    const f = frames(this.rolls);
    this.ball = null;
    if (f.done) {
      if (this.score > this.best) {
        this.best = this.score;
        try {
          localStorage.setItem('bestBowl', String(this.best));
        } catch {
          /* ignore */
        }
      }
      this.setState('over');
      return;
    }
    if (f.fresh) this.pins = rack();
    else {
      // the pinsetter sweeps away what fell and sets the rest back on their spots
      for (const p of this.pins) {
        if (!p.up) p.gone = true;
        else Object.assign(p, { x: p.homeX, z: p.homeZ, vx: 0, vz: 0 });
      }
    }
    this.lives = f.frame + 1;
    this.hooks.onChange();
    this.setPhase('aim');
  }

  // ---------------------------------------------------------------- render
  /** Screen point for lane coordinates (x across, y up, z down the lane). */
  private P(x: number, y: number, z: number): { x: number; y: number; s: number } | null {
    const dz = z - this.camZ;
    if (dz < 0.4) return null;
    const f = this.h * 1.25;
    const s = f / dz;
    return { x: this.w / 2 + x * s, y: this.h * 0.24 + (CAM_H - y) * s, s };
  }

  private quad(color: string, x0: number, x1: number, z0: number, z1: number): void {
    const a = this.P(x0, 0, z0);
    const b = this.P(x1, 0, z0);
    const c = this.P(x1, 0, z1);
    const d = this.P(x0, 0, z1);
    if (!a || !b || !c || !d) return;
    const { ctx } = this;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.closePath();
    ctx.fill();
  }

  private render(): void {
    const { ctx, w, h } = this;
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#120e22');
    bg.addColorStop(1, '#2a1d3d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const near = Math.max(0, this.camZ + 0.45);
    const far = HEAD_Z + 1.4;
    const half = LANE_W / 2;
    // the pit, side boards, gutters and the lane itself
    this.quad('#0a0a10', -half - GUTTER_W - 0.3, half + GUTTER_W + 0.3, HEAD_Z + 1.1, far + 1);
    this.quad('#3a2c4a', -half - GUTTER_W - 0.3, -half - GUTTER_W, near, far);
    this.quad('#3a2c4a', half + GUTTER_W, half + GUTTER_W + 0.3, near, far);
    this.quad('#5b5f6b', -half - GUTTER_W, -half, near, HEAD_Z + 1.1);
    this.quad('#5b5f6b', half, half + GUTTER_W, near, HEAD_Z + 1.1);
    this.quad('#dcb27a', -half, half, near, HEAD_Z - 0.4);
    this.quad('#c99a63', -half, half, HEAD_Z - 0.4, HEAD_Z + 1.1);
    // boards
    ctx.strokeStyle = 'rgba(120,80,40,0.18)';
    ctx.lineWidth = 1;
    for (let b = -half; b <= half + 1e-6; b += LANE_W / 13) {
      const a = this.P(b, 0, near);
      const c = this.P(b, 0, HEAD_Z + 1.1);
      if (!a || !c) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(c.x, c.y);
      ctx.stroke();
    }
    // foul line and the aiming arrows
    this.quad('#b3263a', -half, half, 0, 0.03);
    ctx.fillStyle = '#5a3a20';
    for (let i = -3; i <= 3; i++) {
      const z = 4.6 + Math.abs(i) * 0.3;
      const x = i * (LANE_W / 8);
      const tip = this.P(x, 0, z + 0.25);
      const l = this.P(x - 0.03, 0, z);
      const r = this.P(x + 0.03, 0, z);
      if (!tip || !l || !r) continue;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(l.x, l.y);
      ctx.lineTo(r.x, r.y);
      ctx.fill();
    }

    // pins and ball, far to near
    type Item = { z: number; draw: () => void };
    const items: Item[] = this.pins.filter((p) => !p.gone).map((p) => ({ z: p.z, draw: () => this.drawPin(p) }));
    const ball = this.ball ?? (this.state !== 'menu' && this.phase !== 'result' ? { x: this.startX, z: 0.3, vx: 0, vz: 0, hook: 0, gutter: false } : null);
    if (ball) items.push({ z: ball.z, draw: () => this.drawBall(ball) });
    items.sort((a, b) => b.z - a.z);
    for (const it of items) it.draw();

    this.drawHud();
    this.drawBanner();
  }

  private drawPin(p: Pin): void {
    const base = this.P(p.x, 0, p.z);
    if (!base) return;
    const { ctx } = this;
    const s = base.s;
    const hgt = PIN_H * s;
    const r = PIN_R * s;
    ctx.save();
    ctx.translate(base.x, base.y);
    if (!p.up) {
      // lying on the deck
      ctx.rotate(Math.PI / 2 * Math.sign(Math.sin(p.tilt) || 1));
      ctx.scale(0.55, 0.55);
      ctx.globalAlpha = 0.9;
    }
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.1, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    // body: wide belly, narrow neck, round head
    ctx.fillStyle = '#f7f4ee';
    ctx.beginPath();
    ctx.moveTo(-r * 0.55, 0);
    ctx.bezierCurveTo(-r * 1.15, -hgt * 0.25, -r * 1.05, -hgt * 0.45, -r * 0.4, -hgt * 0.62);
    ctx.bezierCurveTo(-r * 0.25, -hgt * 0.7, -r * 0.6, -hgt * 0.85, -r * 0.45, -hgt * 0.93);
    ctx.arc(0, -hgt * 0.92, r * 0.45, Math.PI, 0);
    ctx.bezierCurveTo(r * 0.6, -hgt * 0.85, r * 0.25, -hgt * 0.7, r * 0.4, -hgt * 0.62);
    ctx.bezierCurveTo(r * 1.05, -hgt * 0.45, r * 1.15, -hgt * 0.25, r * 0.55, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#d62839';
    ctx.fillRect(-r * 0.42, -hgt * 0.72, r * 0.84, hgt * 0.035);
    ctx.fillRect(-r * 0.4, -hgt * 0.77, r * 0.8, hgt * 0.035);
    ctx.restore();
  }

  private drawBall(b: Ball): void {
    const c = this.P(b.x, BALL_R, b.z);
    if (!c) return;
    const { ctx } = this;
    const r = BALL_R * c.s;
    const shadow = this.P(b.x, 0, b.z);
    if (shadow) {
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.ellipse(shadow.x, shadow.y, r, r * 0.25, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const g = ctx.createRadialGradient(c.x - r * 0.35, c.y - r * 0.4, r * 0.1, c.x, c.y, r);
    g.addColorStop(0, '#7aa6ff');
    g.addColorStop(0.5, '#2c47b8');
    g.addColorStop(1, '#101a4a');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fill();
    // finger holes, turning as it rolls
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    for (const [dx, dy] of [[-0.22, -0.2], [0.22, -0.2], [0, 0.2]]) {
      const y = c.y + (dy * Math.cos(this.spin) - 0.1) * r;
      if (Math.cos(this.spin + dy) < -0.2) continue;
      ctx.beginPath();
      ctx.arc(c.x + dx * r, y, r * 0.09, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.phase === 'grip' && !this.ball) {
      ctx.strokeStyle = `rgba(255,224,102,${0.5 + 0.4 * Math.sin(performance.now() / 120)})`;
      ctx.lineWidth = 4 * this.sc;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r * 1.35, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawHud(): void {
    const { ctx, w, h } = this;
    const sc = this.sc;
    // score sheet across the top
    const bw = Math.min(64 * sc, (w - 260 * sc) / 10);
    const bh = 54 * sc;
    const x0 = w / 2 - bw * 5;
    const y0 = 30 * sc; // frame numbers sit just above the boxes
    const mk = marks(this.rolls);
    const tot = totals(this.rolls);
    const cur = frames(this.rolls);
    for (let f = 0; f < 10; f++) {
      const x = x0 + f * bw;
      const now = this.state === 'playing' && f === cur.frame && !cur.done;
      ctx.fillStyle = now ? 'rgba(255,224,102,0.9)' : 'rgba(255,255,255,0.9)';
      ctx.fillRect(x, y0, bw - 2, bh);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = `700 ${11 * sc}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(String(f + 1), x + (bw - 2) / 2, y0 - 2 * sc);
      ctx.textBaseline = 'top';
      ctx.font = `800 ${15 * sc}px system-ui, sans-serif`;
      // two mark slots per frame (three in the tenth); a strike's X sits in the right one
      const slots = f === 9 ? 3 : 2;
      const slotW = (bw - 2) / slots;
      (mk[f] ?? []).forEach((m, k) => {
        const slot = f < 9 && m === 'X' ? 1 : k;
        ctx.fillStyle = m === 'X' || m === '/' ? '#c1121f' : '#222';
        ctx.fillText(m, x + slotW * (slot + 0.5), y0 + 4 * sc);
      });
      const t = tot[f];
      if (t !== undefined && t !== null) {
        ctx.font = `800 ${18 * sc}px system-ui, sans-serif`;
        ctx.fillStyle = '#111';
        ctx.fillText(String(t), x + (bw - 2) / 2, y0 + 26 * sc);
      }
    }
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${34 * sc}px system-ui, sans-serif`;
    ctx.fillText(String(this.score), 24 * sc, 52 * sc);
    ctx.font = `600 ${15 * sc}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(`BEST ${this.best}`, 24 * sc, 74 * sc);

    // pin diagram: what is standing
    const dx = w - 90 * sc;
    const dy = h - 40 * sc;
    for (const p of this.pins) {
      const row = Math.round((p.homeZ - HEAD_Z) / 0.2639);
      const px = dx + (p.homeX / 0.3048) * 22 * sc;
      const py = dy - row * 20 * sc;
      ctx.fillStyle = p.gone || !p.up ? 'rgba(255,255,255,0.15)' : '#fff';
      ctx.beginPath();
      ctx.arc(px, py, 7 * sc, 0, Math.PI * 2);
      ctx.fill();
    }

    if (this.state !== 'playing') return;
    ctx.textAlign = 'center';
    ctx.lineWidth = 5 * sc;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    let prompt = '';
    if (this.phase === 'aim') prompt = 'Point to line up · hold GRIP on the phone, swing, and let go';
    else if (this.phase === 'grip') prompt = 'Swing your arm… and let go of GRIP!';
    if (this.noteT > 0) prompt = this.note;
    if (prompt) {
      ctx.font = `800 ${22 * sc}px system-ui, sans-serif`;
      ctx.fillStyle = this.noteT > 0 ? '#ffd166' : '#fff';
      ctx.strokeText(prompt, w / 2, h - 40 * sc);
      ctx.fillText(prompt, w / 2, h - 40 * sc);
    }
    if (this.phase === 'result') {
      const k = Math.min(1, this.phaseT * 4);
      ctx.font = `900 ${(40 + 34 * k) * sc}px system-ui, sans-serif`;
      ctx.fillStyle = this.resultText === 'STRIKE!' ? '#ffe066' : this.resultText === 'SPARE!' ? '#7be495' : '#fff';
      ctx.strokeText(this.resultText, w / 2, h * 0.42);
      ctx.fillText(this.resultText, w / 2, h * 0.42);
    }
  }

  private drawBanner(): void {
    const { ctx, w, h } = this;
    const sc = this.sc;
    const lines: [string, number, string][] = [];
    if (this.state === 'menu') {
      lines.push(['Hold the phone in your bowling hand, top edge toward the screen', 22, '#fff']);
      lines.push(['Hold GRIP, swing underarm, let go of GRIP to bowl', 22, 'rgba(255,255,255,0.9)']);
      lines.push(['Press START (or GRIP) on your phone, or Space', 28, '#ffe066']);
    } else if (this.state === 'over') {
      lines.push(['GAME OVER', 60, '#ffe066']);
      lines.push([`Score ${this.score}   ·   Best ${this.best}${this.score === 300 ? '   ·   PERFECT GAME!' : ''}`, 28, '#fff']);
      lines.push(['Press START to bowl again', 24, '#ffe066']);
    } else if (this.state === 'paused') {
      lines.push(['PAUSED', 64, '#fff']);
      lines.push(['Press P, or Resume on your phone', 24, 'rgba(255,255,255,0.8)']);
    } else {
      return;
    }
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, h * 0.4 - 40 * sc, w, 60 * sc + lines.length * 52 * sc);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 5 * sc;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    let y = h * 0.4 + 14 * sc;
    for (const [text, size, color] of lines) {
      ctx.font = `800 ${size * sc}px system-ui, sans-serif`;
      ctx.fillStyle = color;
      ctx.strokeText(text, w / 2, y);
      ctx.fillText(text, w / 2, y);
      y += (size + 22) * sc;
    }
  }
}
