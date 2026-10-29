// Fishing: two minutes on the lake with the phone as the rod. Whip it forward to cast
// (harder = farther, and farther water holds bigger fish), wait for a bite, jerk it up to
// strike, then wind the reel by moving the phone in circles. Watch the line tension: wind
// while the fish runs and the line snaps; stop for too long and it gets away.
//
// Without a phone: click to cast (higher on the screen = farther) and to strike, and move
// the mouse in circles to reel.

import { castDistance, fishPoints, newFight, pickFish, ReelTracker, stepFight, SwingDetector, type Fight, type FishKind } from '../shared/fishing';
import type { GameState } from '../shared/protocol';
import type { Sfx } from './audio';
import type { GameHooks, Scene } from './scene';

const SESSION = 120; // seconds
const FLY_TIME = 0.9;
const BITE_WINDOW = 1.1;
const RESULT_TIME = 2.4;
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

type Phase = 'ready' | 'flying' | 'waiting' | 'bite' | 'fight' | 'result';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Catch {
  fish: FishKind;
  kg: number;
  points: number;
}

export class FishingGame implements Scene {
  readonly title = 'Fishing';
  readonly subtitle = 'Your phone is the rod. Cast, strike, and reel in circles.';
  state: GameState = 'menu';
  score = 0;
  best = 0;
  lives = SESSION; // seconds left, shown on the phone

  private ctx: CanvasRenderingContext2D;
  private w = 800;
  private h = 600;
  private sc = 1;

  private phase: Phase = 'ready';
  private phaseT = 0;
  private timeLeft = SESSION;
  private catches = 0;
  // the bobber: across (-1..1 of the view) and out (metres)
  private bx = 0;
  private bd = 10;
  private castPower = 0;
  private waitFor = 3;
  private hooked: { fish: FishKind; kg: number } | null = null;
  private fight: Fight | null = null;
  private result: { text: string; sub: string; emoji: string; good: boolean } | null = null;
  private log: Catch[] = [];

  // input
  private rx = 400; // rod tip pointer, pixels
  private ry = 300;
  private swing = new SwingDetector();
  // reel turns: from the phone's own angles (not the on-screen pointer, which stops at the
  // screen edge while the rod points down), or from the mouse in pixels
  private reelPhone = new ReelTracker(1.5);
  private reelMouse = new ReelTracker(28);
  private reelRate = 0; // turns per second, smoothed
  private reelTurns = 0;
  private lastClick = 0;
  private lastPull = 0;
  private lastFrame = 0;
  private ripples: { x: number; y: number; r: number; life: number }[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private sfx: Sfx,
    private hooks: GameHooks,
  ) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('Canvas 2D is not available');
    this.ctx = c;
    try {
      this.best = Number(localStorage.getItem('bestFish') ?? 0) || 0;
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
    this.setPhase('ready');
    this.setState('menu');
  }

  requestStart(): void {
    if (this.state === 'menu' || this.state === 'over') this.startSession();
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
  /** Where the rod points on screen, in pixels: aims the cast and draws the rod. */
  rodMove(x: number, y: number): void {
    this.rx = clamp(x, 0, this.w);
    this.ry = clamp(y, 0, this.h);
  }
  /** Mouse fallback: point with it, and circle it to reel. */
  mouseMove(x: number, y: number, now: number): void {
    this.rodMove(x, y);
    this.reelTurns += this.reelMouse.push(x, y, now);
  }
  /** The phone's rod angles (degrees): circles reel, a forward whip casts, a jerk up strikes. */
  rodAngles(yaw: number, pitch: number, now: number): void {
    this.reelTurns += this.reelPhone.push(yaw, pitch, now);
    const s = this.swing.push(pitch, now);
    if (!s || this.state !== 'playing') return;
    if (s.type === 'cast') this.cast(s.power);
    else this.strike();
  }
  setSensitivity(v: number): void {
    this.swing.sens = v;
  }
  /** Mouse fallback: click to cast (higher = farther) or to strike. */
  click(): void {
    const now = performance.now();
    if (now - this.lastClick < 250) return;
    this.lastClick = now;
    if (this.state === 'menu' || this.state === 'over') return this.startSession();
    if (this.phase === 'ready') this.cast(clamp(1.15 - this.ry / this.h, 0.15, 1));
    else this.strike();
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

  private startSession(): void {
    this.score = 0;
    this.catches = 0;
    this.log = [];
    this.timeLeft = SESSION;
    this.lives = SESSION;
    this.setPhase('ready');
    this.sfx.start();
    this.setState('playing');
  }

  private gameOver(): void {
    if (this.score > this.best) {
      this.best = this.score;
      try {
        localStorage.setItem('bestFish', String(this.best));
      } catch {
        /* ignore */
      }
    }
    this.setState('over');
  }

  // ---------------------------------------------------------------- moves
  private cast(power: number): void {
    if (this.state !== 'playing' || this.phase !== 'ready') return;
    this.castPower = power;
    this.bx = clamp((this.rx / this.w - 0.5) * 2, -0.9, 0.9);
    this.bd = castDistance(power);
    this.sfx.slice();
    this.setPhase('flying');
  }

  private strike(): void {
    if (this.state !== 'playing') return;
    if (this.phase === 'bite') {
      this.fight = newFight(this.hooked!.fish.strength, this.bd);
      this.reelTurns = 0;
      this.reelRate = 0;
      this.sfx.racket();
      this.hooks.onHaptic(40);
      this.setPhase('fight');
    } else if (this.phase === 'waiting') {
      // struck too early: the fish is scared off, cast again
      this.showResult('Too early!', 'Wait for the bobber to go under', '💨', false);
    }
  }

  private showResult(text: string, sub: string, emoji: string, good: boolean): void {
    this.result = { text, sub, emoji, good };
    this.fight = null;
    this.setPhase('result');
  }

  private ripple(x: number, y: number): void {
    this.ripples.push({ x, y, r: 4, life: 1 });
  }

  // ---------------------------------------------------------------- update
  private update(dt: number): void {
    for (const r of this.ripples) {
      r.r += dt * 60 * this.sc;
      r.life -= dt;
    }
    this.ripples = this.ripples.filter((r) => r.life > 0);
    // winding speed, from the turns counted since the last frame
    this.reelRate += (this.reelTurns / Math.max(dt, 1e-3) - this.reelRate) * Math.min(1, dt * 4);
    this.reelTurns = 0;

    if (this.state !== 'playing') return;
    this.phaseT += dt;
    const before = Math.ceil(this.timeLeft);
    this.timeLeft = Math.max(0, this.timeLeft - dt);
    this.lives = Math.ceil(this.timeLeft);
    if (this.lives !== before) this.hooks.onChange();
    // time up: finish once nothing is on the line
    if (this.timeLeft <= 0 && (this.phase === 'ready' || this.phase === 'waiting' || this.phase === 'flying')) {
      this.gameOver();
      return;
    }

    switch (this.phase) {
      case 'flying':
        if (this.phaseT >= FLY_TIME) {
          const at = this.bobberScreen();
          this.ripple(at.x, at.y);
          this.sfx.land();
          this.waitFor = 1.5 + Math.random() * 4.5;
          this.hooked = pickFish(this.castPower, Math.random);
          this.setPhase('waiting');
        }
        break;
      case 'waiting':
        if (this.phaseT >= this.waitFor) {
          const at = this.bobberScreen();
          this.ripple(at.x, at.y);
          this.ripple(at.x, at.y);
          this.sfx.pass();
          this.hooks.onHaptic(60);
          this.setPhase('bite');
        }
        break;
      case 'bite':
        if (this.phaseT >= BITE_WINDOW) this.showResult('It took the bait!', 'Jerk the phone up as soon as the bobber dips', '🪱', false);
        break;
      case 'fight': {
        const f = this.fight!;
        const res = stepFight(f, dt, this.reelRate, Math.random);
        if (f.pull > 0 && performance.now() - this.lastPull > 350) {
          this.lastPull = performance.now();
          this.hooks.onHaptic(Math.round(10 + f.pull * 30));
          const at = this.bobberScreen();
          this.ripple(at.x, at.y);
        }
        if (res === 'caught') {
          const { fish, kg } = this.hooked!;
          const points = fishPoints(fish, kg);
          this.score += points;
          this.catches++;
          this.log.push({ fish, kg, points });
          this.sfx.combo();
          this.hooks.onHaptic(50);
          this.hooks.onChange();
          this.showResult(fish.name, `${kg} kg  ·  +${points}`, fish.emoji, true);
        } else if (res === 'snapped') {
          this.sfx.crash();
          this.hooks.onHaptic(60);
          this.showResult('The line snapped!', 'Stop winding while the fish pulls hard', '💥', false);
        } else if (res === 'escaped') {
          this.sfx.miss();
          this.showResult('It got away', 'Keep winding: a slack line lets the hook slip', '🌊', false);
        }
        break;
      }
      case 'result':
        if (this.phaseT >= RESULT_TIME) {
          if (this.timeLeft <= 0) this.gameOver();
          else this.setPhase('ready');
        }
        break;
    }
  }

  // ---------------------------------------------------------------- render
  private horizon(): number {
    return this.h * 0.36;
  }

  /** Screen position of a point on the water `d` metres out, `across` (-1..1) to the side. */
  private water(across: number, d: number): { x: number; y: number; s: number } {
    const hz = this.horizon();
    const k = (this.h * 0.95 - hz) * 5;
    const s = 1 / Math.max(d, 1);
    return { x: this.w / 2 + across * this.w * 0.45 * (4 * s + 0.35), y: hz + k * s, s: k * s };
  }

  private bobberScreen(): { x: number; y: number; s: number } {
    const dist = this.fight ? Math.max(1, this.fight.dist) : this.bd;
    return this.water(this.bx * (this.fight ? clamp(this.fight.dist / this.bd, 0.2, 1) : 1), dist);
  }

  private rodTip(): { x: number; y: number } {
    return { x: this.w / 2 + (this.rx - this.w / 2) * 0.45, y: this.h * 0.42 + (this.ry - this.h / 2) * 0.25 };
  }

  private render(): void {
    const { ctx, w, h } = this;
    const hz = this.horizon();
    const sky = ctx.createLinearGradient(0, 0, 0, hz);
    sky.addColorStop(0, '#ffb98a');
    sky.addColorStop(1, '#ffe3b3');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, hz);
    ctx.fillStyle = 'rgba(255,240,200,0.9)';
    ctx.beginPath();
    ctx.arc(w * 0.7, hz - 30 * this.sc, 46 * this.sc, 0, Math.PI * 2);
    ctx.fill();
    // far shore with pines
    ctx.fillStyle = '#4b6b4a';
    ctx.beginPath();
    ctx.moveTo(0, hz);
    for (let x = 0; x <= w; x += 18 * this.sc) {
      const t = 14 + 22 * Math.abs(Math.sin(x * 0.031) + Math.sin(x * 0.013));
      ctx.lineTo(x, hz - t * this.sc);
      ctx.lineTo(x + 9 * this.sc, hz - 4 * this.sc);
    }
    ctx.lineTo(w, hz);
    ctx.fill();
    // water
    const water = ctx.createLinearGradient(0, hz, 0, h);
    water.addColorStop(0, '#6aa8c8');
    water.addColorStop(1, '#1d5577');
    ctx.fillStyle = water;
    ctx.fillRect(0, hz, w, h - hz);
    const t = performance.now() / 1000;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 2;
    for (let d = 4; d < 60; d *= 1.25) {
      const p = this.water(0, d);
      for (let i = -3; i <= 3; i++) {
        const x = p.x + i * p.s * 2.2 + Math.sin(t + d + i) * 10;
        ctx.beginPath();
        ctx.moveTo(x - p.s * 0.4, p.y);
        ctx.quadraticCurveTo(x, p.y - p.s * 0.04, x + p.s * 0.4, p.y);
        ctx.stroke();
      }
    }
    for (const r of this.ripples) {
      ctx.strokeStyle = `rgba(255,255,255,${r.life * 0.6})`;
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, r.r * 2, r.r * 0.6, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    this.drawFishShadow();
    this.drawRodAndLine();
    this.drawHud();
    this.drawBanner();
  }

  private drawFishShadow(): void {
    const { ctx } = this;
    if (this.state !== 'playing' || !['waiting', 'bite', 'fight'].includes(this.phase)) return;
    const b = this.bobberScreen();
    const t = performance.now() / 1000;
    const near = this.phase === 'waiting' ? clamp(this.phaseT / this.waitFor, 0, 1) : 1;
    const thrash = this.fight ? this.fight.pull : 0;
    const off = (1 - near) * 120 * this.sc;
    const x = b.x + Math.cos(t * 1.3) * off + Math.sin(t * 20) * thrash * 14 * this.sc;
    const y = b.y + 10 * this.sc + Math.sin(t * 1.1) * off * 0.25;
    const size = b.s * (0.25 + (this.hooked ? Math.min(0.6, this.hooked.fish.strength * 0.6) : 0.2));
    ctx.fillStyle = 'rgba(10,30,45,0.45)';
    ctx.beginPath();
    ctx.ellipse(x, y, size, size * 0.35, Math.sin(t) * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawRodAndLine(): void {
    const { ctx, w, h } = this;
    const tip = this.rodTip();
    const base = { x: w / 2 + 40 * this.sc, y: h + 20 * this.sc };
    let bob: { x: number; y: number; s: number } | null = null;
    if (this.state === 'playing' && this.phase !== 'ready' && this.phase !== 'result') {
      bob = this.bobberScreen();
      if (this.phase === 'flying') {
        // arc from the rod tip out to the landing spot
        const k = clamp(this.phaseT / FLY_TIME, 0, 1);
        const end = bob;
        bob = { x: tip.x + (end.x - tip.x) * k, y: tip.y + (end.y - tip.y) * k - Math.sin(k * Math.PI) * h * 0.25, s: end.s };
      }
    }
    // line: sags when slack, straight when tight
    if (bob) {
      const tension = this.fight ? this.fight.tension : 0.2;
      ctx.strokeStyle = tension > 0.8 ? 'rgba(255,120,120,0.95)' : 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      const mx = (tip.x + bob.x) / 2;
      const my = (tip.y + bob.y) / 2 + (1 - clamp(tension, 0, 1)) * 60 * this.sc;
      ctx.quadraticCurveTo(mx, my, bob.x, bob.y);
      ctx.stroke();
      // bobber: red over white, ducking under on a bite and while fighting
      const r = Math.max(3, bob.s * 0.07);
      const dip = this.phase === 'bite' ? r * 1.1 : this.phase === 'fight' ? r * (0.5 + (this.fight?.pull ?? 0)) : Math.sin(performance.now() / 300) * r * 0.2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(bob.x - r * 2, bob.y - r * 3, r * 4, r * 3 + (this.phase === 'flying' ? r * 3 : 0)); // the water hides the lower half
      ctx.clip();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(bob.x, bob.y + dip, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e63946';
      ctx.beginPath();
      ctx.arc(bob.x, bob.y + dip, r, Math.PI, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      if (this.phase === 'bite') {
        ctx.font = `900 ${48 * this.sc}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffe066';
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 5 * this.sc;
        ctx.strokeText('!', bob.x, bob.y - r * 3);
        ctx.fillText('!', bob.x, bob.y - r * 3);
      }
    }
    // rod
    const bend = this.fight ? this.fight.tension * 40 * this.sc : 0;
    ctx.strokeStyle = '#3b2a1a';
    ctx.lineWidth = 9 * this.sc;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.quadraticCurveTo((base.x + tip.x) / 2 + bend, (base.y + tip.y) / 2 - bend * 0.5, tip.x, tip.y);
    ctx.stroke();
    ctx.strokeStyle = '#8a6a40';
    ctx.lineWidth = 3 * this.sc;
    ctx.stroke();
    // reel
    ctx.fillStyle = '#c0c6cf';
    ctx.beginPath();
    ctx.arc(base.x - 6 * this.sc, h - 80 * this.sc, 22 * this.sc, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 4 * this.sc;
    const a = performance.now() / 1000 * this.reelRate * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(base.x - 6 * this.sc, h - 80 * this.sc);
    ctx.lineTo(base.x - 6 * this.sc + Math.cos(a) * 18 * this.sc, h - 80 * this.sc + Math.sin(a) * 18 * this.sc);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  private drawHud(): void {
    const { ctx, w, h } = this;
    const sc = this.sc;
    const pad = 24 * sc;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.lineWidth = 5 * sc;
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${46 * sc}px system-ui, sans-serif`;
    ctx.strokeText(String(this.score), pad, pad + 38 * sc);
    ctx.fillText(String(this.score), pad, pad + 38 * sc);
    ctx.font = `600 ${18 * sc}px system-ui, sans-serif`;
    const sub = this.state === 'menu' ? `BEST ${this.best}` : `${Math.ceil(this.timeLeft)}s left   ·   ${this.catches} caught   ·   BEST ${this.best}`;
    ctx.strokeText(sub, pad, pad + 66 * sc);
    ctx.fillText(sub, pad, pad + 66 * sc);

    // the catch so far, along the bottom left
    ctx.font = `${26 * sc}px ${EMOJI_FONT}`;
    this.log.slice(-12).forEach((c, i) => ctx.fillText(c.fish.emoji, pad + i * 32 * sc, h - pad));

    if (this.state !== 'playing') return;
    // prompts
    const prompt =
      this.phase === 'ready'
        ? 'Whip the phone forward to cast (harder = farther, bigger fish)'
        : this.phase === 'waiting'
          ? 'Wait for a bite…'
          : this.phase === 'bite'
            ? 'STRIKE! Jerk the phone up!'
            : this.phase === 'fight'
              ? this.fight!.tension > 0.75
                ? 'Ease off! The line is tight'
                : 'Move the phone in circles to reel it in'
              : '';
    if (prompt) {
      ctx.textAlign = 'center';
      ctx.font = `800 ${this.phase === 'bite' ? 34 * sc : 22 * sc}px system-ui, sans-serif`;
      ctx.fillStyle = this.phase === 'bite' ? '#ffe066' : '#fff';
      ctx.strokeText(prompt, w / 2, h * 0.3);
      ctx.fillText(prompt, w / 2, h * 0.3);
    }

    // tension meter and line out
    if (this.phase === 'fight' && this.fight) {
      const f = this.fight;
      const bh = h * 0.42;
      const bx = w - pad - 34 * sc;
      const by = h * 0.3;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath();
      ctx.roundRect(bx, by, 26 * sc, bh, 13 * sc);
      ctx.fill();
      const k = clamp(f.tension, 0, 1);
      ctx.fillStyle = k > 0.75 ? '#ff4d4d' : k > 0.45 ? '#ffd166' : '#7be495';
      ctx.beginPath();
      ctx.roundRect(bx + 4 * sc, by + bh - 4 * sc - (bh - 8 * sc) * k, 18 * sc, (bh - 8 * sc) * k, 9 * sc);
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.font = `700 ${14 * sc}px system-ui, sans-serif`;
      ctx.fillStyle = '#fff';
      ctx.fillText('TENSION', bx + 13 * sc, by - 10 * sc);
      ctx.font = `800 ${22 * sc}px system-ui, sans-serif`;
      ctx.fillText(`${f.dist.toFixed(1)} m`, bx + 13 * sc, by + bh + 28 * sc);
    }

    if (this.phase === 'result' && this.result) {
      const r = this.result;
      const cw = 340 * sc;
      const ch = 220 * sc;
      const x = w / 2 - cw / 2;
      const y = h * 0.42;
      ctx.fillStyle = r.good ? '#1d4a33' : '#3a1f2b';
      ctx.beginPath();
      ctx.roundRect(x, y, cw, ch, 20 * sc);
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.font = `${80 * sc}px ${EMOJI_FONT}`;
      ctx.fillText(r.emoji, w / 2, y + 95 * sc);
      ctx.font = `800 ${28 * sc}px system-ui, sans-serif`;
      ctx.fillStyle = r.good ? '#ffe066' : '#fff';
      ctx.fillText(r.text, w / 2, y + 150 * sc);
      ctx.font = `600 ${17 * sc}px system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(r.sub, w / 2, y + 185 * sc);
    }
  }

  private drawBanner(): void {
    const { ctx, w, h } = this;
    const sc = this.sc;
    const lines: [string, number, string][] = [];
    if (this.state === 'menu') {
      lines.push(['Hold the phone like a rod, top edge toward the screen, press Centre', 22, '#fff']);
      lines.push(['Whip forward to cast · jerk up to strike · circle to reel', 22, 'rgba(255,255,255,0.9)']);
      lines.push(['Press START on your phone, or Space', 30, '#ffe066']);
    } else if (this.state === 'over') {
      const top = [...this.log].sort((a, b) => b.points - a.points)[0];
      lines.push(["TIME'S UP", 60, '#ffe066']);
      lines.push([`${this.score} points · ${this.catches} caught${top ? ` · best: ${top.fish.name} ${top.kg} kg` : ''}`, 26, '#fff']);
      lines.push(['Press START to fish again', 24, '#ffe066']);
    } else if (this.state === 'paused') {
      lines.push(['PAUSED', 64, '#fff']);
      lines.push(['Press P, or Resume on your phone', 24, 'rgba(255,255,255,0.8)']);
    } else {
      return;
    }
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
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
