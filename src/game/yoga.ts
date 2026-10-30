// Yoga Flow: a calm, slow game. Hold the phone to your chest with both hands and move
// through five poses (stand tall, bend to each side, fold forward, stand tall again).
// A ghost figure shows the pose; your own figure follows your body live. Each pose must be
// held for a few breaths and held STILL: wobbling pauses the progress, so slow breathing
// scores best. Arrow keys (left/right = side bend, down/up = fold) work without a phone.

import { wrap180, type Orientation } from '../shared/pointer';
import { CALM_DEG_PER_S, FLOW, matches, targetOf, torsoRaw, type Torso } from '../shared/yoga';
import type { GameState } from '../shared/protocol';
import type { Sfx } from './audio';
import type { GameHooks, Scene } from './scene';

const HOLD_S = 8; // seconds to hold each pose
const CALIB_S = 4; // "stand tall" countdown at the start
const POSE_TIMEOUT_S = 35; // give up on a pose after this long
const BREATH_IN_S = 4;
const BREATH_OUT_S = 6;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const DEG = Math.PI / 180;

interface Petal {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  size: number;
}
interface FloatText {
  text: string;
  x: number;
  y: number;
  life: number;
}

export class YogaGame implements Scene {
  readonly title = 'Yoga Flow';
  readonly subtitle = 'Slow down. Breathe. Stay still.';
  state: GameState = 'menu';
  score = 0;
  best = 0;
  lives = FLOW.length; // poses left

  private ctx: CanvasRenderingContext2D;
  private w = 800;
  private h = 600;
  private sc = 1;
  private time = 0;
  private lastFrame = 0;

  // sensor input
  private rawFold = 0;
  private rawLean = 0;
  private haveRef = false;
  private refFold = 0;
  private refLean = 0;
  private lastPadSample = 0;
  private flipSign = 1; // F key mirrors the sideways direction on screen

  // keyboard input (no phone)
  private keys = new Set<string>();
  private keyFold = 0;
  private keyLean = 0;

  // live body
  private cur: Torso = { fold: 0, lean: 0 };
  private shown: Torso = { fold: 0, lean: 0 };
  private speed = 0; // smoothed angular speed, deg/s

  // flow progress
  private phase: 'calibrate' | 'pose' = 'calibrate';
  private calibLeft = CALIB_S;
  private calibSum = { fold: 0, lean: 0, n: 0 };
  private poseIdx = 0;
  private held = 0;
  private matchTime = 0;
  private calmTime = 0;
  private poseTime = 0;
  private sideSign = 0;
  private lastLeanSign = 0;
  private poseScores: number[] = [];
  private breathT = 0;
  private flash = 0;
  private petals: Petal[] = [];
  private texts: FloatText[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private sfx: Sfx,
    private hooks: GameHooks,
  ) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('Canvas 2D is not available');
    this.ctx = c;
    try {
      this.best = Number(localStorage.getItem('bestYoga') ?? 0) || 0;
    } catch {
      /* ignore */
    }
    this.resize();
    window.addEventListener('resize', () => this.resize());
    for (let i = 0; i < 18; i++) this.petals.push(this.newPetal(true));
  }

  // ---------------------------------------------------------------- scene API
  enter(): void {
    this.resize();
    this.lastFrame = 0;
    this.texts = [];
    this.setState('menu');
  }

  exit(): void {
    this.keys.clear();
  }

  requestStart(): void {
    if (this.state === 'menu' || this.state === 'over') this.startFlow();
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
    const t = torsoRaw(o);
    this.rawFold = t.fold;
    this.rawLean = t.lean;
    this.lastPadSample = now;
    if (!this.haveRef) this.setRef();
  }

  /** On-screen joystick (-1..1): sideways bends, pulling down folds forward. */
  joy(x: number, y: number): void {
    this.keyLean = clamp(x * 45, -45, 45);
    this.keyFold = clamp(-y * 120, 0, 120);
  }

  /** "Stand tall": use the current position as the zero pose. */
  calibrate(): void {
    this.setRef();
  }

  private setRef(): void {
    this.refFold = this.rawFold;
    this.refLean = this.rawLean;
    this.haveRef = true;
  }

  padLost(): void {
    this.lastPadSample = 0;
    this.haveRef = false;
  }

  keyDown(code: string): void {
    this.keys.add(code);
    if (code === 'KeyF') this.flipSign *= -1;
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

  private newPetal(anywhere: boolean): Petal {
    return {
      x: Math.random() * this.w,
      y: anywhere ? Math.random() * this.h : -20,
      vx: 8 + Math.random() * 18,
      vy: 14 + Math.random() * 20,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 1.2,
      size: (6 + Math.random() * 8) * this.sc,
    };
  }

  private startFlow(): void {
    this.score = 0;
    this.poseIdx = 0;
    this.lives = FLOW.length;
    this.poseScores = [];
    this.sideSign = 0;
    this.phase = 'calibrate';
    this.calibLeft = CALIB_S;
    this.calibSum = { fold: 0, lean: 0, n: 0 };
    this.resetPoseCounters();
    this.texts = [];
    this.sfx.start();
    this.setState('playing');
  }

  private resetPoseCounters(): void {
    this.held = 0;
    this.matchTime = 0;
    this.calmTime = 0;
    this.poseTime = 0;
  }

  private finish(): void {
    if (this.score > this.best) {
      this.best = this.score;
      try {
        localStorage.setItem('bestYoga', String(this.best));
      } catch {
        /* ignore */
      }
    }
    this.sfx.bowl();
    this.setState('over');
  }

  // ---------------------------------------------------------------- update
  private get padActive(): boolean {
    return performance.now() - this.lastPadSample < 1000;
  }

  private update(dt: number): void {
    // petals always drift, even in menus
    for (const p of this.petals) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }
    this.petals = this.petals.map((p) => (p.y > this.h + 20 || p.x > this.w + 20 ? this.newPetal(false) : p));

    if (this.state === 'paused') return;
    this.time += dt;
    this.breathT = (this.breathT + dt) % (BREATH_IN_S + BREATH_OUT_S);
    this.flash = Math.max(0, this.flash - dt * 1.5);
    for (const t of this.texts) {
      t.life -= dt;
      t.y -= 26 * this.sc * dt;
    }
    this.texts = this.texts.filter((t) => t.life > 0);

    // current body angles (phone, or keyboard when there is no phone)
    let target: Torso;
    if (this.padActive && this.haveRef) {
      const fold = Math.max(0, this.rawFold - this.refFold);
      const lean = fold < 50 ? wrap180(this.rawLean - this.refLean) : 0;
      target = { fold, lean: lean * this.flipSign };
    } else {
      const kl = (this.keys.has('ArrowRight') || this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('ArrowLeft') || this.keys.has('KeyA') ? 1 : 0);
      const kf = (this.keys.has('ArrowDown') || this.keys.has('KeyS') ? 1 : 0) - (this.keys.has('ArrowUp') || this.keys.has('KeyW') ? 1 : 0);
      this.keyLean = clamp(this.keyLean + kl * 70 * dt, -45, 45);
      this.keyFold = clamp(this.keyFold + kf * 70 * dt, 0, 120);
      target = { fold: this.keyFold, lean: this.keyFold < 50 ? this.keyLean : 0 };
    }
    this.cur = target;
    // The drawn figure eases towards the measured pose. Steadiness is judged on that smoothed
    // signal, so fast hand tremor is ignored and only real swaying or moving counts.
    const px = this.shown.fold;
    const py = this.shown.lean;
    this.shown.fold += (this.cur.fold - this.shown.fold) * Math.min(1, dt * 10);
    this.shown.lean += (this.cur.lean - this.shown.lean) * Math.min(1, dt * 10);
    const ang = Math.hypot(this.shown.fold - px, this.shown.lean - py) / Math.max(dt, 1e-3);
    this.speed += (Math.min(ang, 300) - this.speed) * Math.min(1, dt * 3);

    if (this.state !== 'playing') return;

    if (this.phase === 'calibrate') {
      this.calibLeft -= dt;
      if (this.padActive) {
        // average the raw angles over the last second of the countdown
        if (this.calibLeft < 1) {
          this.calibSum.fold += this.rawFold;
          this.calibSum.lean += this.rawLean;
          this.calibSum.n++;
        }
      }
      if (this.calibLeft <= 0) {
        if (this.calibSum.n > 0) {
          this.refFold = this.calibSum.fold / this.calibSum.n;
          this.refLean = this.calibSum.lean / this.calibSum.n;
          this.haveRef = true;
        }
        this.phase = 'pose';
        this.resetPoseCounters();
        this.sfx.bowl();
      }
      return;
    }

    // ---- holding a pose
    const pose = FLOW[this.poseIdx];
    this.poseTime += dt;
    const ok = matches(pose.kind, this.cur, this.sideSign);
    const calm = this.speed < CALM_DEG_PER_S;
    if (ok) {
      this.matchTime += dt;
      if (Math.abs(this.cur.lean) > 5) this.lastLeanSign = Math.sign(this.cur.lean);
      if (calm) {
        this.held += dt;
        this.calmTime += dt;
      } else {
        this.held += dt * 0.25;
      }
    } else {
      this.held = Math.max(0, this.held - dt * 1.5);
    }

    if (this.held >= HOLD_S) {
      const calmFrac = this.matchTime > 0 ? this.calmTime / this.matchTime : 0;
      this.completePose(Math.round(60 + 40 * calmFrac));
    } else if (this.poseTime > POSE_TIMEOUT_S) {
      this.texts.push({ text: 'Skipped', x: this.w / 2, y: this.h * 0.3, life: 1.6 });
      this.completePose(0, true);
    }
  }

  private completePose(points: number, skipped = false): void {
    if (!skipped) {
      this.sfx.bowl();
      this.hooks.onHaptic(35);
      this.flash = 1;
      this.texts.push({ text: `+${points}`, x: this.w / 2, y: this.h * 0.36, life: 1.8 });
    }
    if (FLOW[this.poseIdx].kind === 'side' && this.lastLeanSign !== 0) this.sideSign = this.lastLeanSign;
    this.poseScores.push(points);
    this.score += points;
    this.poseIdx++;
    this.lives = FLOW.length - this.poseIdx;
    this.resetPoseCounters();
    this.hooks.onChange();
    if (this.poseIdx >= FLOW.length) this.finish();
  }

  // ---------------------------------------------------------------- drawing
  private breath(): number {
    // 0 = fully breathed out, 1 = fully breathed in
    const t = this.breathT;
    if (t < BREATH_IN_S) return 0.5 - 0.5 * Math.cos((t / BREATH_IN_S) * Math.PI);
    return 0.5 + 0.5 * Math.cos(((t - BREATH_IN_S) / BREATH_OUT_S) * Math.PI);
  }

  private render(): void {
    const { ctx, w, h } = this;
    this.drawBackground();

    const cx = w * 0.5;
    const hipY = h * 0.74;
    const S = h * 0.2;

    // breathing ring behind the figure
    const br = this.breath();
    const ringR = S * (1.15 + 0.22 * br);
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${0.1 + 0.12 * br})`;
    ctx.lineWidth = 3 * this.sc;
    ctx.beginPath();
    ctx.arc(cx, hipY - S * 0.45, ringR, 0, Math.PI * 2);
    ctx.stroke();
    const glow = ctx.createRadialGradient(cx, hipY - S * 0.45, S * 0.2, cx, hipY - S * 0.45, ringR);
    glow.addColorStop(0, `rgba(255,214,165,${0.15 + 0.15 * br})`);
    glow.addColorStop(1, 'rgba(255,214,165,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, hipY - S * 0.45, ringR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const playingPose = this.state === 'playing' && this.phase === 'pose';
    const pose = FLOW[Math.min(this.poseIdx, FLOW.length - 1)];

    if (playingPose) {
      const tgt = targetOf(pose.kind, this.sideSign);
      this.drawFigure(cx, hipY, S, tgt, 'rgba(255,255,255,0.28)', true);
    }
    const ok = playingPose && matches(pose.kind, this.cur, this.sideSign);
    const calm = this.speed < CALM_DEG_PER_S;
    this.drawFigure(cx, hipY, S, this.shown, ok ? (calm ? '#9be8b0' : '#ffe08a') : '#ffffff', false);

    // hold progress ring
    if (playingPose) {
      const p = clamp(this.held / HOLD_S, 0, 1);
      ctx.save();
      ctx.lineWidth = 10 * this.sc;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.beginPath();
      ctx.arc(cx, hipY - S * 0.45, ringR + 24 * this.sc, -Math.PI / 2, Math.PI * 1.5);
      ctx.stroke();
      ctx.strokeStyle = ok ? '#9be8b0' : '#ffd6a5';
      ctx.beginPath();
      ctx.arc(cx, hipY - S * 0.45, ringR + 24 * this.sc, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // texts
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    if (this.state === 'playing') {
      if (this.phase === 'calibrate') {
        this.bigText('Stand tall', h * 0.16, 54);
        this.smallText('Phone against your chest, both hands, stay still', h * 0.16 + 38 * this.sc);
        this.bigText(String(Math.max(1, Math.ceil(this.calibLeft))), h * 0.27, 80, 'rgba(255,214,165,0.95)');
      } else {
        this.bigText(pose.name, h * 0.13, 52);
        this.smallText(pose.cue, h * 0.13 + 36 * this.sc);
        const hint = !ok
          ? 'Move into the pose (match the faint figure)'
          : calm
            ? br > 0.5 || this.breathT < BREATH_IN_S
              ? 'Breathe in…'
              : 'Breathe out…'
            : 'Soften… stay very still';
        this.smallText(hint, h * 0.13 + 70 * this.sc, ok && !calm ? '#ffe08a' : 'rgba(255,255,255,0.85)');
      }
    }
    for (const t of this.texts) {
      ctx.globalAlpha = clamp(t.life, 0, 1);
      ctx.font = `800 ${46 * this.sc}px system-ui, sans-serif`;
      ctx.fillStyle = '#ffe9c7';
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;

    this.drawHud();

    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255,240,210,${this.flash * 0.25})`;
      ctx.fillRect(0, 0, w, h);
    }
    if (this.state === 'menu') this.drawPanel('Yoga Flow', ['Hold the phone against your chest with both hands.', 'Stand tall, press Start, then follow the faint figure.', 'Breathe slowly and stay still: wobbling pauses your progress.']);
    if (this.state === 'over') {
      const stars = this.score >= 400 ? 3 : this.score >= 250 ? 2 : 1;
      this.drawPanel(`${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}  ${this.score} points`, [`Best ${this.best}`, 'Namaste. Press Start for another flow.']);
    }
    if (this.state === 'paused') {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, w, h);
      this.bigText('PAUSED', h / 2, 64);
    }
  }

  private bigText(text: string, y: number, size: number, color = '#fff'): void {
    const { ctx } = this;
    ctx.font = `800 ${size * this.sc}px system-ui, sans-serif`;
    ctx.fillStyle = color;
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 12 * this.sc;
    ctx.fillText(text, this.w / 2, y);
    ctx.shadowBlur = 0;
  }

  private smallText(text: string, y: number, color = 'rgba(255,255,255,0.85)'): void {
    const { ctx } = this;
    ctx.font = `500 ${21 * this.sc}px system-ui, sans-serif`;
    ctx.fillStyle = color;
    ctx.fillText(text, this.w / 2, y);
  }

  private drawPanel(title: string, lines: string[]): void {
    const { ctx, w, h } = this;
    const bw = Math.min(w * 0.8, 820 * this.sc);
    const bh = (110 + lines.length * 34) * this.sc;
    const bx = w / 2 - bw / 2;
    const by = h * 0.1;
    ctx.fillStyle = 'rgba(30,18,45,0.55)';
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 22 * this.sc);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${42 * this.sc}px system-ui, sans-serif`;
    ctx.fillText(title, w / 2, by + 56 * this.sc);
    ctx.font = `500 ${20 * this.sc}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    lines.forEach((l, i) => ctx.fillText(l, w / 2, by + (96 + i * 34) * this.sc));
  }

  private drawBackground(): void {
    const { ctx, w, h } = this;
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#2b2250');
    sky.addColorStop(0.45, '#8e5a8c');
    sky.addColorStop(0.8, '#f2a98f');
    sky.addColorStop(1, '#ffd9a8');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // low sun
    const sunY = h * 0.62;
    const sun = ctx.createRadialGradient(w / 2, sunY, 0, w / 2, sunY, h * 0.4);
    sun.addColorStop(0, 'rgba(255,236,190,0.9)');
    sun.addColorStop(0.25, 'rgba(255,200,150,0.35)');
    sun.addColorStop(1, 'rgba(255,200,150,0)');
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, w, h);

    // hills
    const hill = (base: number, amp: number, color: string, seed: number) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w + 10; x += 10) {
        const t = x / (w * 0.35);
        ctx.lineTo(x, base - amp * (0.5 + 0.35 * Math.sin(t + seed) + 0.15 * Math.sin(2.1 * t + seed * 3)));
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();
    };
    hill(h * 0.82, h * 0.12, 'rgba(80,50,100,0.55)', 1);
    hill(h * 0.9, h * 0.1, 'rgba(48,30,70,0.8)', 4);

    // mat
    ctx.fillStyle = 'rgba(40,24,60,0.55)';
    ctx.beginPath();
    ctx.ellipse(w / 2, h * 0.935, h * 0.3, h * 0.035, 0, 0, Math.PI * 2);
    ctx.fill();

    // petals
    for (const p of this.petals) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = 'rgba(255,200,215,0.75)';
      ctx.beginPath();
      ctx.ellipse(0, 0, p.size, p.size * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /**
   * A simple front-view figure. The torso swings sideways with `lean`, and shrinks, then
   * hangs below the hips as `fold` grows (bending towards the viewer).
   */
  private drawFigure(cx: number, hipY: number, S: number, t: Torso, color: string, ghost: boolean): void {
    const { ctx } = this;
    const lean = t.lean * DEG;
    const fold = t.fold * DEG;
    const reach = Math.cos(fold);
    const dx = Math.sin(lean);
    const dy = -Math.cos(lean);
    const torso = S * 0.8 * reach;
    const neck = { x: cx + dx * torso, y: hipY + dy * torso };
    const near = 1 + 0.25 * Math.sin(Math.min(fold, Math.PI / 2)); // bigger when bending towards us
    const headR = S * 0.13 * near;
    const dirx = torso >= 0 ? dx : -dx;
    const diry = torso >= 0 ? dy : -dy;
    const head = { x: neck.x + dirx * headR * 1.25, y: neck.y + diry * headR * 1.25 };
    const hands = { x: cx + dx * torso * 0.6, y: hipY + dy * torso * 0.6 };
    const lw = S * 0.075;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lw;
    if (ghost) ctx.setLineDash([lw * 0.1, lw * 1.6]);
    else {
      ctx.shadowColor = 'rgba(255,214,165,0.6)';
      ctx.shadowBlur = 18 * this.sc;
    }
    // legs
    ctx.beginPath();
    ctx.moveTo(cx - S * 0.06, hipY + S * 0.95);
    ctx.lineTo(cx - S * 0.03, hipY);
    ctx.lineTo(cx + S * 0.03, hipY);
    ctx.lineTo(cx + S * 0.06, hipY + S * 0.95);
    ctx.stroke();
    // torso
    ctx.beginPath();
    ctx.moveTo(cx, hipY);
    ctx.lineTo(neck.x, neck.y);
    ctx.stroke();
    // arms to the heart centre (prayer hands)
    const sh = { x: neck.x, y: neck.y };
    ctx.beginPath();
    ctx.moveTo(sh.x - S * 0.16, sh.y + S * 0.03);
    ctx.lineTo(hands.x, hands.y);
    ctx.lineTo(sh.x + S * 0.16, sh.y + S * 0.03);
    ctx.stroke();
    // head
    if (ghost) ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(head.x, head.y, headR, 0, Math.PI * 2);
    if (ghost) ctx.stroke();
    else ctx.fill();
    ctx.restore();
  }

  private drawHud(): void {
    const { ctx, w } = this;
    const pad = 24 * this.sc;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${44 * this.sc}px system-ui, sans-serif`;
    ctx.fillText(String(this.score), pad, pad + 38 * this.sc);
    ctx.font = `600 ${18 * this.sc}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(`BEST ${this.best}`, pad, pad + 66 * this.sc);

    // pose dots
    const r = 9 * this.sc;
    for (let i = 0; i < FLOW.length; i++) {
      const x = w - pad - (FLOW.length - 1 - i) * 30 * this.sc - r;
      const y = pad + 24 * this.sc;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      const done = i < this.poseIdx && (this.poseScores[i] ?? 0) > 0;
      const skipped = i < this.poseIdx && !done;
      ctx.fillStyle = done ? '#9be8b0' : skipped ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.12)';
      ctx.fill();
      if (i === this.poseIdx && this.state === 'playing') {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2 * this.sc;
        ctx.stroke();
      }
    }
    ctx.textAlign = 'center';
  }
}
