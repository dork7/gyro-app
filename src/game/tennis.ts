// Tennis: the computer player hits the ball to you, you swing the phone as the racket.
//
// The racket follows the phone's aim (same mapping as the blade, see main.ts); the mouse
// works too. When the ball arrives, the racket has to be on it: a ring shows where the
// ball will come. Holding the racket still blocks the ball back softly, a faster swing
// hits harder and deeper, and the swing direction steers the shot. Over-hit and it goes out.
//
// Like the real game: every point starts with a serve into the service box, the court
// slows the ball at each bounce, a ball swung down at goes into the net (or clips the
// tape and drops over), a ball caught off the middle of the strings comes off weak, and
// the computer player's reply is weaker when it had to stretch for the ball.
//
// Score: 1 for every return that lands in, 3 more for a winner (the computer cannot reach
// it). Letting a ball go past costs a life; three lives. The ball gets faster as you go.
//
// Physics and shot maths are in shared/tennis.ts.

import { RANGE_Y, wrap180 } from '../shared/pointer';
import type { GameState } from '../shared/protocol';
import { arrival, CAM_Z, CPU_Z, DOUBLES_W, HALF_W, incomingShot, LENGTH, NET_H, NET_Z, project, returnShot, SERVICE, stepBall, type Ball, type Vec3 } from '../shared/tennis';
import type { Sfx } from './audio';
import type { GameHooks, Scene } from './scene';

const LIVES = 3;
const HIT_FAR = 2.2; // the ball can be hit between these depths (m from the baseline)
const HIT_NEAR = -1.5;
const GONE = -3.2; // past this it is a miss
const REACH = 0.75; // how close (m) the racket must be to the ball
const HEAD = 0.42; // racket head radius as drawn (m at the baseline)
const BALL_R = 0.1;
const CPU_REACH = 1.3;
const CPU_SPEED = 4.2; // m/s
const SERVE_X = 2.6; // balls arrive within this far of the middle
const TOSS = 0.7; // seconds the ball toss takes before a serve
const SERVE_Y = 2.5; // height the serve is struck at (m)
const CORD = 0.12; // a ball this close above the net (m) clips the tape
const MARK_LIFE = 4; // seconds a bounce mark stays on the court
const SWING_WINDOW = 110; // ms of movement the swing speed is measured over
const SWINGING = 1.5; // racket speed (screen heights/s) that counts as a swing rather than holding still
const BLOCK_Z = 0.4; // a still racket only blocks the ball once it is this close (m): until then there is time to swing
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

interface P {
  x: number;
  y: number;
}
interface Particle extends P {
  vx: number;
  vy: number;
  life: number;
  color: string;
}

export class TennisGame implements Scene {
  readonly title = 'Tennis';
  readonly subtitle = 'Swing the phone like a racket and hit the ball back.';
  state: GameState = 'menu';
  score = 0;
  best = 0;
  lives = LIVES;

  private ctx: CanvasRenderingContext2D;
  private w = 800;
  private h = 600;
  private lastFrame = 0;
  private now = 0;
  private time = 0;

  // rally
  private ball: Ball | null = null;
  private phase: 'wait' | 'incoming' | 'outgoing' = 'wait';
  private waitT = 0;
  private hits = 0; // returns this game: the ball speeds up with it
  private rally = 0;
  private landed = false;
  private side = 1; // which side of the centre mark the next serve comes from
  private marks: { x: number; z: number; t: number }[] = []; // where balls have bounced
  private mark: Vec3 | null = null; // where the incoming ball will arrive
  private cpu = { x: 0, swing: 0 };

  // racket
  private pen: P | null = null;
  private prevPen: P | null = null;
  private trail: (P & { t: number })[] = [];
  private aims: { yaw: number; pitch: number; t: number }[] = []; // the phone's own movement, in degrees
  private flash = 0;
  private shotKmh = 0; // speed of the player's last shot, shown on screen
  private shotT = 0;

  private note = { text: '', t: 0, color: '#fff' };
  private particles: Particle[] = [];
  private overAt = -10;

  constructor(
    private canvas: HTMLCanvasElement,
    private sfx: Sfx,
    private hooks: GameHooks,
  ) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('Canvas 2D is not available');
    this.ctx = c;
    try {
      this.best = Number(localStorage.getItem('bestTennis') ?? 0) || 0;
    } catch {
      /* ignore */
    }
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // ---------------------------------------------------------------- scene API
  enter(): void {
    this.resize();
    this.reset();
    this.lastFrame = 0;
    this.setState('menu');
  }

  exit(): void {
    this.pen = null;
    this.prevPen = null;
    this.trail = [];
    this.aims = [];
  }

  requestStart(): void {
    if (this.state === 'menu' || this.state === 'over') {
      if (this.state === 'over' && this.time - this.overAt < 0.8) return;
      this.reset();
      this.sfx.start();
      this.setState('playing');
    } else if (this.state === 'paused') this.togglePause();
  }

  togglePause(): void {
    if (this.state === 'playing') this.setState('paused');
    else if (this.state === 'paused') this.setState('playing');
  }

  /** Racket position in screen pixels (from the phone's aim, or the mouse). */
  racketMove(x: number, y: number, now: number): void {
    this.pen = { x: clamp(x, 0, this.w), y: clamp(y, 0, this.h) };
    this.trail.push({ ...this.pen, t: now });
    while (this.trail.length > 2 && now - this.trail[0]!.t > SWING_WINDOW) this.trail.shift();
  }

  /**
   * Where the phone is pointing, in degrees. The swing speed is measured from this
   * rather than from the racket on screen, so a fast swing still counts in full when
   * the racket has run into the edge of the screen, whatever the sensitivity setting.
   */
  swingAim(yaw: number, pitch: number, now: number): void {
    this.aims.push({ yaw, pitch, t: now });
    while (this.aims.length > 2 && now - this.aims[0]!.t > SWING_WINDOW) this.aims.shift();
  }

  tick(t: number): void {
    const dt = Math.min(0.05, this.lastFrame ? (t - this.lastFrame) / 1000 : 0.016);
    this.lastFrame = t;
    this.now = t;
    this.update(dt);
    this.render();
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
  }

  private reset(): void {
    this.score = 0;
    this.lives = LIVES;
    this.hits = 0;
    this.rally = 0;
    this.ball = null;
    this.mark = null;
    this.phase = 'wait';
    this.waitT = 1.2;
    this.cpu = { x: 0, swing: 0 };
    this.side = 1;
    this.marks = [];
    this.particles = [];
    this.note.t = 0;
  }

  private setState(s: GameState): void {
    this.state = s;
    document.body.dataset.state = s;
    this.hooks.onChange();
  }

  private say(text: string, color: string): void {
    this.note = { text, t: 1.3, color };
  }

  private at(p: Vec3): { x: number; y: number; s: number } {
    return project(p, this.w, this.h);
  }

  /**
   * Racket speed in screen heights per second (up is positive), from the last ~0.1 s of
   * movement: the phone's own turning speed when it is streaming, otherwise the mouse.
   */
  private swing(): { vx: number; vy: number } {
    const p = this.aims[0];
    const q = this.aims[this.aims.length - 1];
    if (p && q && this.now - q.t <= 150) {
      const dt = (q.t - p.t) / 1000;
      if (dt < 0.012) return { vx: 0, vy: 0 };
      return { vx: wrap180(q.yaw - p.yaw) / RANGE_Y / dt, vy: (q.pitch - p.pitch) / RANGE_Y / dt };
    }
    const a = this.trail[0];
    const b = this.trail[this.trail.length - 1];
    if (!a || !b || this.now - b.t > 150) return { vx: 0, vy: 0 };
    const dt = (b.t - a.t) / 1000;
    if (dt < 0.012) return { vx: 0, vy: 0 };
    return { vx: (b.x - a.x) / this.h / dt, vy: -(b.y - a.y) / this.h / dt };
  }

  // ---------------------------------------------------------------- rally
  /**
   * The computer player hits the ball to the player from `from`. A serve is faster and
   * lands in the service box; a ball it had to stretch for (`stretch` near 1) comes back slower.
   */
  private feed(from: Vec3, serve: boolean, stretch = 0): void {
    const pace = 9 + Math.min(6, this.hits * 0.2);
    const speed = serve ? pace + 2.5 : pace * (stretch > 0.7 ? 0.8 : 1);
    this.ball = incomingShot(from, rand(-SERVE_X, SERVE_X), speed, rand(0.9, 1.7), serve ? NET_Z - SERVICE : 3);
    const a = arrival(this.ball);
    this.mark = { x: a.x, y: a.y, z: 0 };
    this.phase = 'incoming';
    this.cpu.swing = 0.3;
    this.sfx.racket();
  }

  /** How far through the ball toss the computer player is before a serve, 0 (not yet) to 1. */
  private get toss(): number {
    return this.state !== 'menu' && this.phase === 'wait' && this.waitT < TOSS ? 1 - Math.max(0, this.waitT) / TOSS : 0;
  }

  private bounceMark(b: Ball): void {
    this.marks.push({ x: b.p.x, z: b.p.z, t: this.time });
    if (this.marks.length > 12) this.marks.shift();
    this.sfx.land();
  }

  /** `off`: how far from the middle of the strings the ball was caught, 0 to 1. */
  private hit(off: number): void {
    const b = this.ball!;
    const shot = returnShot(b.p, this.swing(), off);
    this.ball = shot.ball;
    this.shotKmh = Math.round(shot.pace * 3.6);
    this.shotT = 2.5;
    this.landed = false;
    this.mark = null;
    this.phase = 'outgoing';
    this.hits++;
    this.rally++;
    this.flash = 0.18;
    // off the frame it thuds instead of pinging
    if (off > 0.6) this.sfx.land();
    else this.sfx.racket();
    this.hooks.onHaptic(Math.round(25 + 45 * shot.power));
    const p = this.at(b.p);
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = rand(80, 320) * (0.5 + shot.power);
      this.particles.push({ x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.4, color: '#e6ff5a' });
    }
  }

  /** The point is over: the next ball comes after a short pause. */
  private rest(seconds: number): void {
    this.phase = 'wait';
    this.waitT = seconds;
    this.rally = 0;
    this.mark = null;
    this.side = -this.side;
  }

  private miss(): void {
    this.lives--;
    this.sfx.miss();
    this.hooks.onHaptic(140);
    this.say('Missed', '#ff6b6b');
    this.ball = null;
    if (this.lives <= 0) {
      this.overAt = this.time;
      if (this.score > this.best) {
        this.best = this.score;
        try {
          localStorage.setItem('bestTennis', String(this.best));
        } catch {
          /* ignore */
        }
      }
      this.sfx.crash();
      this.setState('over');
      return;
    }
    this.rest(1.3);
    this.hooks.onChange();
  }

  private update(dt: number): void {
    this.time += dt;
    this.flash = Math.max(0, this.flash - dt);
    this.note.t = Math.max(0, this.note.t - dt);
    this.shotT = Math.max(0, this.shotT - dt);
    this.cpu.swing = Math.max(0, this.cpu.swing - dt);
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);

    if (this.state === 'playing') this.play(dt);
    this.prevPen = this.pen ? { ...this.pen } : null;
  }

  private play(dt: number): void {
    const b = this.ball;
    if (this.phase === 'wait') {
      // a dead ball (out, or a winner) keeps flying until the next one is hit
      if (b) {
        const z = b.p.z;
        stepBall(b, dt);
        if (z < NET_Z && b.p.z >= NET_Z && b.p.y < NET_H) this.intoNet(b);
      }
      // the computer player walks to its serving spot, tosses the ball up and serves
      const spot = this.side * 1.2;
      this.cpu.x += clamp(spot - this.cpu.x, -CPU_SPEED * dt, CPU_SPEED * dt);
      this.waitT -= dt;
      if (this.waitT <= 0) this.feed({ x: this.cpu.x, y: SERVE_Y, z: CPU_Z }, true);
      return;
    }
    if (!b) return;
    const z0 = b.p.z;
    const bounced = stepBall(b, dt);

    if (this.phase === 'incoming') {
      if (bounced) this.bounceMark(b);
      // the computer player recovers towards the middle after its shot
      this.cpu.x += clamp(-this.cpu.x, -CPU_SPEED * 0.5 * dt, CPU_SPEED * 0.5 * dt);
      const off = b.p.z <= HIT_FAR && b.p.z >= HIT_NEAR ? this.touching(b) : null;
      // A racket held on the ball's path waits for the swing; only when the ball is
      // right on it does a still racket block it back.
      const sw = this.swing();
      if (off !== null && (b.p.z <= BLOCK_Z || Math.hypot(sw.vx, sw.vy) >= SWINGING)) this.hit(off);
      else if (b.p.z < GONE) this.miss();
      return;
    }

    // outgoing: the net is in the way
    if (!this.landed && z0 < NET_Z && b.p.z >= NET_Z) {
      if (b.p.y < NET_H) {
        this.intoNet(b);
        this.say('Net', '#ffb347');
        this.sfx.land();
        this.sfx.miss();
        this.rest(1.4);
        return;
      }
      if (b.p.y < NET_H + CORD) {
        // clips the tape: it loses its pace and pops up
        b.v.z *= 0.5;
        b.v.y = Math.abs(b.v.y) * 0.3 + 1.2;
        this.say('Net cord', '#c9d1d9');
        this.sfx.land();
      }
    }

    // outgoing: the computer player runs to where the ball is heading
    const tx = clamp(b.p.x + (b.v.x * (CPU_Z - b.p.z)) / b.v.z, -HALF_W - 1.5, HALF_W + 1.5);
    this.cpu.x += clamp(tx - this.cpu.x, -CPU_SPEED * dt, CPU_SPEED * dt);
    if (bounced && !this.landed) {
      this.landed = true;
      this.bounceMark(b);
      // judged where it really lands, like a line call
      const short = b.p.z < NET_Z;
      if (short || Math.abs(b.p.x) > HALF_W || b.p.z > LENGTH) {
        this.say(short ? 'Net' : 'Out', '#ffb347');
        this.sfx.miss();
        this.rest(1.4);
        return;
      }
      this.score++;
      this.hooks.onChange();
    } else if (bounced) {
      // a second bounce before the computer player gets to it
      this.bounceMark(b);
      this.winner();
      return;
    }
    if (b.p.z >= CPU_Z) {
      const stretch = Math.abs(this.cpu.x - b.p.x) / CPU_REACH;
      if (stretch <= 1) {
        this.feed({ x: b.p.x, y: clamp(b.p.y, 0.6, 2), z: CPU_Z }, false, stretch);
      } else this.winner();
    }
  }

  /** The computer player could not get the ball back. */
  private winner(): void {
    this.score += 3;
    this.say('Winner! +3', '#7be495');
    this.sfx.combo();
    this.hooks.onHaptic(60);
    this.hooks.onChange();
    this.rest(1.4);
  }

  /** The ball hits the net and drops at its foot. */
  private intoNet(b: Ball): void {
    b.p.z = NET_Z - 0.1;
    b.v.z *= -0.15;
    b.v.x *= 0.3;
    b.v.y = Math.min(b.v.y, 0);
  }

  /**
   * Is the racket on the ball? Checks the path the racket took since the last frame, so a
   * fast swing cannot skip over it. Returns how far off the middle of the strings the ball
   * was (0 centre, 1 the edge of the reach), or null for no contact.
   */
  private touching(b: Ball): number | null {
    if (!this.pen) return null;
    const p = this.at(b.p);
    const a = this.prevPen ?? this.pen;
    const dx = this.pen.x - a.x;
    const dy = this.pen.y - a.y;
    const len2 = dx * dx + dy * dy;
    const k = len2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1) : 0;
    const off = Math.hypot(a.x + dx * k - p.x, a.y + dy * k - p.y) / (REACH * p.s);
    return off <= 1 ? off : null;
  }

  // ---------------------------------------------------------------- drawing
  private render(): void {
    const c = this.ctx;
    const { w, h } = this;
    this.court();
    this.bounceMarks();

    const b = this.ball && this.ball.p.z > CAM_Z + 1 ? this.ball : null;
    this.player();
    if (this.toss > 0 && this.state !== 'over') {
      const up = Math.sin((this.toss * Math.PI) / 2);
      this.drawBall({ p: { x: this.cpu.x + 0.25, y: 1.2 + (SERVE_Y - 1.2) * up, z: CPU_Z }, v: { x: 0, y: 0, z: 0 } });
    }
    if (b && b.p.z > NET_Z) this.drawBall(b);
    this.net();
    if (this.mark && this.phase === 'incoming' && this.state !== 'over') {
      const m = this.at(this.mark);
      c.strokeStyle = `rgba(255,255,255,${0.35 + 0.2 * Math.sin(this.time * 8)})`;
      c.lineWidth = 3;
      c.setLineDash([10, 8]);
      c.beginPath();
      c.arc(m.x, m.y, REACH * m.s * 0.8, 0, Math.PI * 2);
      c.stroke();
      c.setLineDash([]);
    }
    if (b && b.p.z <= NET_Z) this.drawBall(b);

    for (const p of this.particles) {
      c.globalAlpha = clamp(p.life * 3, 0, 1);
      c.fillStyle = p.color;
      c.fillRect(p.x - 3, p.y - 3, 6, 6);
    }
    c.globalAlpha = 1;

    this.racket();
    this.hud();

    if (this.note.t > 0 && this.state === 'playing') {
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.globalAlpha = clamp(this.note.t * 2, 0, 1);
      c.fillStyle = this.note.color;
      c.font = `800 ${Math.round(clamp(w * 0.04, 30, 56))}px system-ui, sans-serif`;
      c.fillText(this.note.text, w / 2, h * 0.2 - (1.3 - this.note.t) * 20);
      c.globalAlpha = 1;
    }
  }

  private quad(pts: Vec3[], fill: string): void {
    const c = this.ctx;
    c.fillStyle = fill;
    c.beginPath();
    pts.forEach((p, i) => {
      const q = this.at(p);
      if (i) c.lineTo(q.x, q.y);
      else c.moveTo(q.x, q.y);
    });
    c.closePath();
    c.fill();
  }

  private line(a: Vec3, b: Vec3): void {
    const c = this.ctx;
    const p = this.at(a);
    const q = this.at(b);
    c.beginPath();
    c.moveTo(p.x, p.y);
    c.lineTo(q.x, q.y);
    c.stroke();
  }

  private court(): void {
    const c = this.ctx;
    const { w, h } = this;
    const hy = h * 0.3; // horizon
    const sky = c.createLinearGradient(0, 0, 0, hy);
    sky.addColorStop(0, '#0b1320');
    sky.addColorStop(1, '#1d3557');
    c.fillStyle = sky;
    c.fillRect(0, 0, w, hy);
    // stands behind the far end
    const back = this.at({ x: 0, y: 0, z: LENGTH + 8 });
    c.fillStyle = '#14233a';
    c.fillRect(0, hy - h * 0.05, w, back.y - hy + h * 0.05);
    c.fillStyle = '#1f7a4d';
    c.fillRect(0, back.y, w, h - back.y);

    const z0 = CAM_Z + 0.6; // the court runs under the camera
    this.quad(
      [
        { x: -DOUBLES_W, y: 0, z: z0 },
        { x: DOUBLES_W, y: 0, z: z0 },
        { x: DOUBLES_W, y: 0, z: LENGTH },
        { x: -DOUBLES_W, y: 0, z: LENGTH },
      ],
      '#2a66b0',
    );
    c.strokeStyle = 'rgba(255,255,255,0.9)';
    c.lineWidth = 3;
    // singles sidelines (the ones that count) and the doubles alleys outside them
    for (const x of [-HALF_W, HALF_W]) this.line({ x, y: 0, z: z0 }, { x, y: 0, z: LENGTH });
    for (const x of [-DOUBLES_W, DOUBLES_W]) this.line({ x, y: 0, z: z0 }, { x, y: 0, z: LENGTH });
    for (const z of [0, LENGTH]) this.line({ x: -DOUBLES_W, y: 0, z }, { x: DOUBLES_W, y: 0, z });
    for (const z of [NET_Z - SERVICE, NET_Z + SERVICE]) this.line({ x: -HALF_W, y: 0, z }, { x: HALF_W, y: 0, z });
    this.line({ x: 0, y: 0, z: NET_Z - SERVICE }, { x: 0, y: 0, z: NET_Z + SERVICE });
    // centre marks on the baselines
    this.line({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0.3 });
    this.line({ x: 0, y: 0, z: LENGTH - 0.3 }, { x: 0, y: 0, z: LENGTH });
  }

  /** Scuffs where balls have bounced, fading out. */
  private bounceMarks(): void {
    const c = this.ctx;
    this.marks = this.marks.filter((m) => this.time - m.t < MARK_LIFE);
    for (const m of this.marks) {
      const p = this.at({ x: m.x, y: 0, z: m.z });
      c.fillStyle = `rgba(8,20,40,${0.45 * (1 - (this.time - m.t) / MARK_LIFE)})`;
      c.beginPath();
      c.ellipse(p.x, p.y, Math.max(3, 0.16 * p.s), Math.max(1.5, 0.06 * p.s), 0, 0, Math.PI * 2);
      c.fill();
    }
  }

  private net(): void {
    const c = this.ctx;
    const x = DOUBLES_W + 0.9;
    const a = this.at({ x: -x, y: NET_H, z: NET_Z });
    const b = this.at({ x, y: 0, z: NET_Z });
    c.fillStyle = 'rgba(10,20,35,0.45)';
    c.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    c.strokeStyle = 'rgba(255,255,255,0.18)';
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 1; i < 40; i++) {
      const px = a.x + ((b.x - a.x) * i) / 40;
      c.moveTo(px, a.y);
      c.lineTo(px, b.y);
    }
    for (let i = 1; i < 4; i++) {
      const py = a.y + ((b.y - a.y) * i) / 4;
      c.moveTo(a.x, py);
      c.lineTo(b.x, py);
    }
    c.stroke();
    c.fillStyle = '#fff';
    c.fillRect(a.x, a.y - 2, b.x - a.x, 4);
    c.fillRect((a.x + b.x) / 2 - 2, a.y, 4, b.y - a.y); // centre strap
    c.fillStyle = '#c9d1d9';
    c.fillRect(a.x - 3, a.y - 4, 5, b.y - a.y + 4);
    c.fillRect(b.x - 2, a.y - 4, 5, b.y - a.y + 4);
  }

  /** The computer player at the far end. */
  private player(): void {
    const c = this.ctx;
    const foot = this.at({ x: this.cpu.x, y: 0, z: CPU_Z });
    const s = foot.s;
    c.fillStyle = 'rgba(0,0,0,0.3)';
    c.beginPath();
    c.ellipse(foot.x, foot.y, 0.45 * s, 0.12 * s, 0, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = '#ff8fab';
    c.lineCap = 'round';
    c.lineWidth = Math.max(3, 0.34 * s);
    c.beginPath();
    c.moveTo(foot.x, foot.y - 0.5 * s);
    c.lineTo(foot.x, foot.y - 1.35 * s);
    c.stroke();
    c.lineWidth = Math.max(2, 0.14 * s);
    c.beginPath();
    c.moveTo(foot.x - 0.16 * s, foot.y);
    c.lineTo(foot.x - 0.1 * s, foot.y - 0.6 * s);
    c.moveTo(foot.x + 0.16 * s, foot.y);
    c.lineTo(foot.x + 0.1 * s, foot.y - 0.6 * s);
    c.stroke();
    c.fillStyle = '#ffd9b3';
    c.beginPath();
    c.arc(foot.x, foot.y - 1.62 * s, 0.17 * s, 0, Math.PI * 2);
    c.fill();
    // racket arm: swings forward for a moment after each hit
    // and reaches up behind the ball during the toss
    const ang = this.toss > 0 ? -1.2 - this.toss * 0.6 : -0.5 - (this.cpu.swing / 0.3) * 1.6;
    const hx = foot.x + 0.25 * s + Math.cos(ang) * 0.7 * s;
    const hyy = foot.y - 1.2 * s + Math.sin(ang) * 0.7 * s;
    c.strokeStyle = '#ffd9b3';
    c.lineWidth = Math.max(2, 0.1 * s);
    c.beginPath();
    c.moveTo(foot.x + 0.15 * s, foot.y - 1.2 * s);
    c.lineTo(hx, hyy);
    c.stroke();
    c.strokeStyle = '#ff9f1c';
    c.lineWidth = Math.max(1.5, 0.05 * s);
    c.beginPath();
    c.arc(hx + Math.cos(ang) * 0.25 * s, hyy + Math.sin(ang) * 0.25 * s, 0.25 * s, 0, Math.PI * 2);
    c.stroke();
    c.lineCap = 'butt';
  }

  private drawBall(b: Ball): void {
    const c = this.ctx;
    const shadow = this.at({ x: b.p.x, y: 0, z: b.p.z });
    const p = this.at(b.p);
    const r = Math.max(3, BALL_R * p.s);
    // the shadow spreads and fades as the ball rises
    const lift = clamp(b.p.y / 3, 0, 1);
    c.fillStyle = `rgba(0,0,0,${0.42 - 0.24 * lift})`;
    c.beginPath();
    c.ellipse(shadow.x, shadow.y, r * (1.1 + 0.5 * lift), r * (0.4 + 0.18 * lift), 0, 0, Math.PI * 2);
    c.fill();
    // a fast ball leaves a short streak
    const tail = this.at({ x: b.p.x - b.v.x * 0.035, y: Math.max(0, b.p.y - b.v.y * 0.035), z: b.p.z - b.v.z * 0.035 });
    if (Math.hypot(tail.x - p.x, tail.y - p.y) > r) {
      c.strokeStyle = 'rgba(230,255,90,0.3)';
      c.lineWidth = r * 1.5;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(tail.x, tail.y);
      c.lineTo(p.x, p.y);
      c.stroke();
      c.lineCap = 'butt';
    }
    const hittable = this.phase === 'incoming' && b.p.z <= HIT_FAR;
    if (hittable) {
      c.fillStyle = 'rgba(230,255,90,0.25)';
      c.beginPath();
      c.arc(p.x, p.y, r * 1.8, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = '#e6ff5a';
    c.beginPath();
    c.arc(p.x, p.y, r, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.8)';
    c.lineWidth = Math.max(1, r * 0.14);
    c.beginPath();
    c.arc(p.x - r * 0.9, p.y, r, -0.9, 0.9);
    c.stroke();
  }

  private racket(): void {
    if (!this.pen) return;
    const c = this.ctx;
    const r = HEAD * this.at({ x: 0, y: 0, z: 0 }).s;
    // swoosh behind a moving racket
    if (this.trail.length > 1 && this.now - this.trail[this.trail.length - 1]!.t < 150) {
      c.strokeStyle = 'rgba(255,255,255,0.18)';
      c.lineWidth = r * 1.2;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.beginPath();
      this.trail.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.stroke();
      c.lineCap = 'butt';
    }
    c.save();
    c.translate(this.pen.x, this.pen.y);
    c.rotate(clamp(this.swing().vx / 8, -0.7, 0.7));
    c.fillStyle = '#3a2a1a';
    c.fillRect(-r * 0.09, r * 0.95, r * 0.18, r * 1.1);
    c.fillStyle = '#e63946';
    c.fillRect(-r * 0.11, r * 1.45, r * 0.22, r * 0.62);
    c.beginPath();
    c.ellipse(0, 0, r * 0.8, r, 0, 0, Math.PI * 2);
    c.fillStyle = this.flash > 0 ? 'rgba(230,255,90,0.35)' : 'rgba(255,255,255,0.08)';
    c.fill();
    c.save();
    c.clip();
    c.strokeStyle = 'rgba(255,255,255,0.45)';
    c.lineWidth = 1;
    c.beginPath();
    for (let k = -4; k <= 4; k++) {
      c.moveTo((k * r) / 5, -r);
      c.lineTo((k * r) / 5, r);
      c.moveTo(-r, (k * r) / 5);
      c.lineTo(r, (k * r) / 5);
    }
    c.stroke();
    c.restore();
    c.strokeStyle = '#ff9f1c';
    c.lineWidth = Math.max(4, r * 0.1);
    c.beginPath();
    c.ellipse(0, 0, r * 0.8, r, 0, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  }

  private hud(): void {
    const c = this.ctx;
    const { w, h } = this;
    c.textBaseline = 'middle';

    if (this.state === 'menu') {
      const mx = w / 2;
      const my = h * 0.255; // on the dark stands, clear of the court lines
      c.textAlign = 'center';
      c.fillStyle = 'rgba(255,255,255,0.9)';
      c.font = '600 22px system-ui, sans-serif';
      c.fillText('Press Start, then swing at the ball', mx, my);
      c.fillStyle = 'rgba(255,255,255,0.6)';
      c.font = '500 16px system-ui, sans-serif';
      c.fillText('Put the racket on the ring where the ball will arrive.', mx, my + 28);
      c.fillText('The faster you swing, the faster the ball goes. Swing sideways to aim.' + (this.best ? `  Best: ${this.best}` : ''), mx, my + 48);
    }

    if (this.state === 'playing' || this.state === 'paused') {
      c.fillStyle = 'rgba(255,255,255,0.85)';
      c.font = '700 22px system-ui, sans-serif';
      c.textAlign = 'left';
      c.fillText(`${'♥'.repeat(this.lives)}${'♡'.repeat(LIVES - this.lives)}${this.rally > 1 ? `   Rally ${this.rally}` : ''}`, 28, 36);
      c.textAlign = 'right';
      c.fillText(`Score ${this.score}`, w - 170, 36);
      if (this.shotT > 0) {
        // how fast the last shot left the racket: swing faster and this goes up
        c.textAlign = 'center';
        c.globalAlpha = clamp(this.shotT, 0, 1);
        c.fillStyle = '#e6ff5a';
        c.fillText(`${this.shotKmh} km/h`, w / 2, 36);
        c.globalAlpha = 1;
      }
    }

    if (this.state === 'paused') this.banner('Paused', 'Press Start or P to continue');
    if (this.state === 'over') {
      this.banner(`Game over: ${this.score} points`, `${this.score >= this.best && this.score > 0 ? 'New best!' : `Best ${this.best}`} · Press Start to play again`);
    }
  }

  private banner(title: string, sub: string): void {
    const c = this.ctx;
    c.fillStyle = 'rgba(11,19,32,0.78)';
    c.fillRect(0, 0, this.w, this.h);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#fff';
    c.font = `800 ${Math.round(clamp(this.w * 0.04, 32, 56))}px system-ui, sans-serif`;
    c.fillText(title, this.w / 2, this.h * 0.42);
    c.fillStyle = 'rgba(255,255,255,0.7)';
    c.font = '500 20px system-ui, sans-serif';
    c.fillText(sub, this.w / 2, this.h * 0.42 + 46);
  }
}
