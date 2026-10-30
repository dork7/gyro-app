// Tennis: the computer player hits the ball to you, you swing the phone as the racket.
//
// The racket follows the phone's aim (same mapping as the blade, see main.ts); the mouse
// works too. When the ball arrives, the racket has to be on it: a ring shows where the
// ball will come. Holding the racket still blocks the ball back softly, a faster swing
// hits harder and deeper (but never long), and timing aims it: hit early and it goes
// cross-court, late and it goes down the line. A marker on the far court shows where the
// shot would land if hit now; badly mistimed shots go wide. The racket reaches generously,
// and a ball caught near the edge of the reach still goes back, just weakly.
//
// Like the real game: every point starts with a serve into the service box, the court
// slows the ball at each bounce, a ball swung down at goes into the net (or clips the
// tape and drops over), a ball caught off the middle of the strings comes off weak, and
// the computer player's reply is weaker when it had to stretch for the ball.
//
// Score: 1 for every return that lands in, 3 more for a winner (the computer cannot reach
// it). A long rally multiplies the points, a ball off the sweet spot of the strings earns 1
// more, and landing in the glowing target on the far court 2 more. Letting a ball go past
// costs a life; three lives, and a 10-shot rally wins one back. The ball gets faster as you go.
//
// A closing ring shows when the ball arrives, and turns green while the racket is on it.
//
// Physics and shot maths are in shared/tennis.ts.

import { RANGE_Y, wrap180 } from '../shared/pointer';
import type { GameState } from '../shared/protocol';
import { arrival, CAM_Z, CPU_Z, DOUBLES_W, HALF_W, HIT_FAR, HIT_NEAR, incomingShot, LENGTH, NET_H, NET_Z, project, returnShot, SERVICE, stepBall, type Ball, type Vec3 } from '../shared/tennis';
import type { Sfx } from './audio';
import type { GameHooks, Scene } from './scene';

const LIVES = 3;
const GONE = -3.2; // past this it is a miss
const REACH = 1.1; // how close (m) the racket must be to the ball: generous, for casual play
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
const SWEET = 0.2; // a hit this close to the middle of the strings (share of REACH) is a sweet-spot hit
const HIT_STOP = 0.07; // seconds the action freezes on a sweet-spot hit, for weight
const CLOSE_T = 1.1; // seconds before arrival that the timing ring starts closing in
const TARGET = 1.4; // half-size (m) of the target square on the far court
const MULTI_EVERY = 4; // rally shots per step of the points multiplier
const MULTI_MAX = 4;
const LIFE_RALLY = 10; // a rally this long wins back a life
const TRAIL = 10; // positions kept for the ball's comet trail
const BOARD_Z = LENGTH + 6; // advertising boards behind the far baseline
const BOARD_H = 0.9;
const RING_LIFE = 0.35; // seconds a shock ring takes to fade
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
  private markAt = 0; // game time it gets there
  private cpu = { x: 0, swing: 0 };
  private target: { x: number; z: number } | null = null; // bonus square on the far court
  private sweetHit = false; // the ball in flight came off the sweet spot
  private ballTrail: P[] = [];
  private freeze = 0; // hit-stop left, seconds
  private shake = 0; // screen shake strength, px
  private rings: { x: number; y: number; r: number; life: number; color: string }[] = []; // shock rings on hits
  private cheer = 0; // seconds the crowd keeps jumping
  private cpuRun = 0; // how fast the computer player is moving, m/s (smoothed)
  private cpuDir = 0; // which way it is running, -1 to 1
  private cpuStep = 0; // stride phase
  // static scenery, painted once per screen size
  private layers: Record<'sky' | 'crowd' | 'court' | 'net' | 'light', HTMLCanvasElement> | null = null;

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
  private lefty = false; // from the middle of the court, early hits go right instead of left

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

  setLefty(lefty: boolean): void {
    this.lefty = lefty;
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
    this.layers = null;
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
    this.ballTrail = [];
    this.rings = [];
    this.freeze = 0;
    this.shake = 0;
    this.note.t = 0;
    this.newTarget();
  }

  private newTarget(): void {
    this.target = { x: rand(-HALF_W + TARGET, HALF_W - TARGET), z: rand(NET_Z + SERVICE - 1, LENGTH - TARGET - 0.3) };
  }

  /** Points multiplier for the current rally. */
  private get multi(): number {
    return Math.min(MULTI_MAX, 1 + Math.floor(this.rally / MULTI_EVERY));
  }

  private burst(x: number, y: number, n: number, speed: number, color: string): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = rand(0.3, 1) * speed;
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.35, 0.7), color });
    }
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
    this.markAt = this.time + a.t;
    this.ballTrail = [];
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
    // a puff of dust off the court
    const p = this.at({ x: b.p.x, y: 0, z: b.p.z });
    for (let i = 0; i < 6; i++) {
      this.particles.push({ x: p.x, y: p.y, vx: rand(-1, 1) * 6 * p.s, vy: -rand(0.5, 2) * 3 * p.s, life: rand(0.2, 0.4), color: 'rgba(200,220,255,0.6)' });
    }
  }

  /** `off`: how far from the middle of the strings the ball was caught, 0 to 1. */
  private hit(off: number): void {
    const b = this.ball!;
    const shot = returnShot(b.p, this.swing(), off, this.lefty);
    this.ball = shot.ball;
    this.shotKmh = Math.round(shot.pace * 3.6);
    this.shotT = 2.5;
    this.landed = false;
    this.mark = null;
    this.phase = 'outgoing';
    this.hits++;
    this.rally++;
    this.flash = 0.18;
    this.ballTrail = [];
    this.sweetHit = off <= SWEET;
    const p = this.at(b.p);
    // off the frame it thuds instead of pinging
    if (off > 0.6) this.sfx.land();
    else if (this.sweetHit) this.sfx.sweet();
    else this.sfx.racket();
    if (this.sweetHit) {
      this.freeze = HIT_STOP;
      this.say('Sweet spot!', '#e6ff5a');
      this.burst(p.x, p.y, 14, 420, '#ffffff');
    } else if (off > 0.6) this.say('Off the frame', '#c9d1d9');
    if (shot.power > 0.7) this.shake = 4 + 8 * shot.power;
    if (this.rally > 0 && this.rally % MULTI_EVERY === 0 && this.multi > 1) this.say(`Rally x${this.multi}`, '#7be495');
    if (this.rally === LIFE_RALLY && this.lives < LIVES) {
      this.lives++;
      this.say('Rally 10! +♥', '#ff8fab');
      this.sfx.coin();
    }
    this.hooks.onHaptic(Math.round(25 + 45 * shot.power + (this.sweetHit ? 20 : 0)));
    this.burst(p.x, p.y, 10, 320 * (0.5 + shot.power), '#e6ff5a');
    this.rings.push({ x: p.x, y: p.y, r: REACH * p.s * (0.6 + shot.power), life: RING_LIFE, color: this.sweetHit ? '#ffffff' : '#e6ff5a' });
  }

  /** The point is over: the next ball comes after a short pause. */
  private rest(seconds: number): void {
    this.phase = 'wait';
    this.waitT = seconds;
    this.rally = 0;
    this.mark = null;
    this.side = -this.side;
    this.newTarget();
  }

  private miss(): void {
    this.lives--;
    this.sfx.miss();
    this.hooks.onHaptic(140);
    this.shake = 14;
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
    this.shake = Math.max(0, this.shake - dt * 40);
    this.cheer = Math.max(0, this.cheer - dt);
    for (const r of this.rings) r.life -= dt;
    this.rings = this.rings.filter((r) => r.life > 0);

    const cx = this.cpu.x;
    if (this.freeze > 0) this.freeze -= dt;
    else if (this.state === 'playing') this.play(dt);
    if (dt > 0) {
      const v = (this.cpu.x - cx) / dt;
      this.cpuRun += (Math.abs(v) - this.cpuRun) * Math.min(1, dt * 12);
      this.cpuDir += (Math.sign(v) - this.cpuDir) * Math.min(1, dt * 8);
      this.cpuStep += this.cpuRun * dt * 5;
    }
    if (this.ball && this.state === 'playing') {
      this.ballTrail.push(this.at(this.ball.p));
      if (this.ballTrail.length > TRAIL) this.ballTrail.shift();
    }
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
      let pts = 1 + (this.sweetHit ? 1 : 0);
      const tg = this.target;
      if (tg && Math.abs(b.p.x - tg.x) <= TARGET && Math.abs(b.p.z - tg.z) <= TARGET) {
        pts += 2;
        this.say('Bullseye! +2', '#ffd166');
        this.sfx.coin();
        const p = this.at(b.p);
        this.burst(p.x, p.y, 18, 260, '#ffd166');
        this.rings.push({ x: p.x, y: p.y, r: TARGET * p.s, life: RING_LIFE * 1.5, color: '#ffd166' });
        this.cheer = 1;
        this.newTarget();
      }
      this.score += pts * this.multi;
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
    this.score += 3 * this.multi;
    this.say(`Winner! +${3 * this.multi}`, '#7be495');
    this.sfx.combo();
    this.sfx.applause(16 + Math.min(30, this.rally * 3));
    this.cheer = 1.6;
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
    const L = (this.layers ??= {
      sky: this.layer(() => this.paintStadium()),
      crowd: this.layer(() => this.paintCrowd()),
      court: this.layer(() => this.paintCourt()),
      net: this.layer(() => this.paintNet()),
      light: this.layer(() => this.paintLights()),
    });
    c.fillStyle = '#050a14';
    c.fillRect(0, 0, w, h);
    c.save();
    if (this.shake > 0) c.translate(rand(-1, 1) * this.shake, rand(-1, 1) * this.shake);
    c.drawImage(L.sky, 0, 0, w, h);
    // the crowd jumps up and down for a while after a great shot
    const jump = this.cheer > 0 ? -Math.abs(Math.sin(this.time * 16)) * 3 * Math.min(1, this.cheer) : 0;
    c.drawImage(L.crowd, 0, jump, w, h);
    c.drawImage(L.court, 0, 0, w, h);
    this.targetZone();
    this.bounceMarks();

    const b = this.ball && this.ball.p.z > CAM_Z + 1 ? this.ball : null;
    this.player();
    if (this.toss > 0 && this.state !== 'over') {
      const up = Math.sin((this.toss * Math.PI) / 2);
      this.drawBall({ p: { x: this.cpu.x + 0.25, y: 1.2 + (SERVE_Y - 1.2) * up, z: CPU_Z }, v: { x: 0, y: 0, z: 0 } });
    }
    if (b && b.p.z > NET_Z) this.drawBall(b);
    c.drawImage(L.net, 0, 0, w, h);
    this.aimMarker(); // over the net, so the mesh never hides it
    if (this.mark && this.phase === 'incoming' && this.state !== 'over') this.timingRing();
    if (b && b.p.z <= NET_Z) this.drawBall(b);

    for (const r of this.rings) {
      c.strokeStyle = r.color;
      c.globalAlpha = clamp(r.life / RING_LIFE, 0, 1);
      c.lineWidth = 2 + 4 * (r.life / RING_LIFE);
      c.beginPath();
      c.arc(r.x, r.y, r.r * (1.6 - r.life / RING_LIFE), 0, Math.PI * 2);
      c.stroke();
    }
    for (const p of this.particles) {
      c.globalAlpha = clamp(p.life * 3, 0, 1);
      c.fillStyle = p.color;
      c.beginPath();
      c.arc(p.x, p.y, 1.5 + 3 * clamp(p.life * 2, 0, 1), 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;

    c.drawImage(L.light, 0, 0, w, h);
    this.racket();
    c.restore();
    this.hud();

    if (this.note.t > 0 && this.state === 'playing') {
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.globalAlpha = clamp(this.note.t * 2, 0, 1);
      c.font = `800 ${Math.round(clamp(w * 0.04, 30, 56))}px system-ui, sans-serif`;
      const y = h * 0.2 - (1.3 - this.note.t) * 20;
      c.lineJoin = 'round';
      c.lineWidth = 6;
      c.strokeStyle = 'rgba(5,10,20,0.8)';
      c.strokeText(this.note.text, w / 2, y);
      c.fillStyle = this.note.color;
      c.fillText(this.note.text, w / 2, y);
      c.globalAlpha = 1;
    }
  }

  /** Paints into an offscreen canvas the size of the screen, using the usual drawing helpers. */
  private layer(paint: () => void): HTMLCanvasElement {
    const dpr = window.devicePixelRatio || 1;
    const cv = document.createElement('canvas');
    cv.width = Math.floor(this.w * dpr);
    cv.height = Math.floor(this.h * dpr);
    const c = cv.getContext('2d');
    if (!c) return cv;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const main = this.ctx;
    this.ctx = c;
    try {
      paint();
    } finally {
      this.ctx = main;
    }
    return cv;
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

  /** Top of the stands, in screen pixels. */
  private get standsTop(): number {
    return this.h * 0.25;
  }

  /** Night sky, the stadium roof with its floodlights, and the empty stands. */
  private paintStadium(): void {
    const c = this.ctx;
    const { w } = this;
    const top = this.standsTop;
    const sky = c.createLinearGradient(0, 0, 0, top);
    sky.addColorStop(0, '#03070f');
    sky.addColorStop(0.7, '#0c1a30');
    sky.addColorStop(1, '#1b3152');
    c.fillStyle = sky;
    c.fillRect(0, 0, w, top);
    for (let i = 0; i < 80; i++) {
      c.fillStyle = `rgba(255,255,255,${rand(0.15, 0.7)})`;
      const s = rand(0.6, 1.8);
      c.fillRect(rand(0, w), rand(0, top * 0.75), s, s);
    }
    const foot = this.at({ x: 0, y: 0, z: BOARD_Z }).y;
    const stand = c.createLinearGradient(0, top, 0, foot);
    stand.addColorStop(0, '#0b1424');
    stand.addColorStop(1, '#1c2c46');
    c.fillStyle = stand;
    c.fillRect(0, top, w, foot - top);
    // roof edge, with a row of floodlights along it
    c.fillStyle = '#070d18';
    c.fillRect(0, top - 12, w, 14);
    for (let i = 0; i < 9; i++) {
      const x = ((i + 0.5) * w) / 9;
      const y = top - 6;
      const glow = c.createRadialGradient(x, y, 0, x, y, 48);
      glow.addColorStop(0, 'rgba(255,248,215,0.55)');
      glow.addColorStop(1, 'rgba(255,248,215,0)');
      c.fillStyle = glow;
      c.fillRect(x - 48, y - 48, 96, 96);
      c.fillStyle = '#fffbea';
      c.fillRect(x - 8, y - 3, 16, 6);
    }
  }

  /** Rows of spectators, smaller towards the back. Rebuilt with each resize, so it is random. */
  private paintCrowd(): void {
    const c = this.ctx;
    const shirts = ['#e63946', '#f1faee', '#a8dadc', '#457b9d', '#ffb703', '#fb8500', '#8ecae6', '#2a9d8f', '#e9c46a', '#6a4c93', '#ef476f'];
    const skins = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'];
    const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;
    const top = this.standsTop;
    const foot = this.at({ x: 0, y: 0, z: BOARD_Z }).y;
    let y = top + 6;
    while (y < foot) {
      const k = (y - top) / Math.max(1, foot - top); // 0 back row, 1 front
      const r = 1.8 + 2.4 * k; // head radius, px
      c.globalAlpha = 0.5 + 0.45 * k;
      for (let x = rand(0, 2 * r); x < this.w; x += r * 2.7 + rand(0, r * 0.6)) {
        if (Math.random() < 0.07) continue; // an empty seat
        c.fillStyle = pick(shirts);
        c.fillRect(x - r * 1.15, y + r * 0.7, r * 2.3, r * 2.4);
        c.fillStyle = pick(skins);
        c.beginPath();
        c.arc(x, y, r, 0, Math.PI * 2);
        c.fill();
      }
      y += r * 2.9;
    }
    c.globalAlpha = 1;
  }

  /** Advertising boards, the grass around the court, the court and its lines. */
  private paintCourt(): void {
    const c = this.ctx;
    const { w, h } = this;
    const z0 = CAM_Z + 0.6; // the court runs under the camera
    // grass from the boards to the camera, mown in stripes
    for (let z = z0, i = 0; z < BOARD_Z; z += 2.4, i++) {
      const z1 = Math.min(BOARD_Z, z + 2.4);
      this.quad(
        [
          { x: -60, y: 0, z },
          { x: 60, y: 0, z },
          { x: 60, y: 0, z: z1 },
          { x: -60, y: 0, z: z1 },
        ],
        i % 2 ? '#1c6e45' : '#218050',
      );
    }
    // boards along the back
    const bt = this.at({ x: 0, y: BOARD_H, z: BOARD_Z }).y;
    const bb = this.at({ x: 0, y: 0, z: BOARD_Z }).y;
    const bh = bb - bt;
    c.fillStyle = '#0b1a2e';
    c.fillRect(0, bt, w, bh);
    const panels = ['#1d4e89', '#0f7b6c', '#7a2a5c'];
    const pw = w / 5;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = `800 ${Math.max(8, Math.round(bh * 0.55))}px system-ui, sans-serif`;
    for (let i = 0; i < 5; i++) {
      c.fillStyle = panels[i % panels.length]!;
      c.fillRect(i * pw + 2, bt + 2, pw - 4, bh - 4);
      c.fillStyle = 'rgba(255,255,255,0.85)';
      c.fillText(i % 2 ? 'SWING · HIT · WIN' : 'GYRO OPEN', i * pw + pw / 2, bt + bh / 2 + 1);
    }

    const court = [
      { x: -DOUBLES_W - 0.6, y: 0, z: z0 },
      { x: DOUBLES_W + 0.6, y: 0, z: z0 },
      { x: DOUBLES_W + 0.6, y: 0, z: LENGTH + 2 },
      { x: -DOUBLES_W - 0.6, y: 0, z: LENGTH + 2 },
    ];
    this.quad(court, '#235aa0');
    c.save();
    c.clip();
    // the floodlights make the middle of the court brightest
    const mid = this.at({ x: 0, y: 0, z: NET_Z * 0.8 });
    const lit = c.createRadialGradient(mid.x, mid.y, 0, mid.x, mid.y, Math.max(w, h) * 0.7);
    lit.addColorStop(0, 'rgba(140,190,255,0.28)');
    lit.addColorStop(1, 'rgba(0,10,30,0.25)');
    c.fillStyle = lit;
    c.fillRect(0, 0, w, h);
    // a fine grain in the hard court
    for (let i = 0; i < 2500; i++) {
      c.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,30,0.08)';
      c.fillRect(rand(0, w), rand(mid.y - h * 0.2, h), 1.5, 1.5);
    }
    c.restore();

    // Lines are painted strips of real width, so they thin out with distance, with a soft glow.
    c.shadowColor = 'rgba(255,255,255,0.55)';
    c.shadowBlur = 5;
    const white = 'rgba(255,255,255,0.95)';
    const along = (x: number, za: number, zb: number, wd = 0.05) =>
      this.quad(
        [
          { x: x - wd, y: 0, z: za },
          { x: x + wd, y: 0, z: za },
          { x: x + wd, y: 0, z: zb },
          { x: x - wd, y: 0, z: zb },
        ],
        white,
      );
    const across = (z: number, xa: number, xb: number, wd = 0.05) =>
      this.quad(
        [
          { x: xa, y: 0, z: z - wd },
          { x: xb, y: 0, z: z - wd },
          { x: xb, y: 0, z: z + wd },
          { x: xa, y: 0, z: z + wd },
        ],
        white,
      );
    for (const x of [-HALF_W, HALF_W, -DOUBLES_W, DOUBLES_W]) along(x, z0, LENGTH);
    across(0, -DOUBLES_W, DOUBLES_W, 0.1);
    across(LENGTH, -DOUBLES_W, DOUBLES_W, 0.1);
    for (const z of [NET_Z - SERVICE, NET_Z + SERVICE]) across(z, -HALF_W, HALF_W);
    along(0, NET_Z - SERVICE, NET_Z + SERVICE);
    along(0, 0, 0.3);
    along(0, LENGTH - 0.3, LENGTH);
    c.shadowBlur = 0;
    // the net's shadow, cast towards the player by the lights behind it
    this.quad(
      [
        { x: -DOUBLES_W - 0.9, y: 0, z: NET_Z },
        { x: DOUBLES_W + 0.9, y: 0, z: NET_Z },
        { x: DOUBLES_W + 0.9, y: 0, z: NET_Z - 0.7 },
        { x: -DOUBLES_W - 0.9, y: 0, z: NET_Z - 0.7 },
      ],
      'rgba(5,15,35,0.3)',
    );
  }

  /** Light from the floodlights falling over the scene, and a vignette at the edges. */
  private paintLights(): void {
    const c = this.ctx;
    const { w, h } = this;
    const top = this.standsTop - 6;
    for (const k of [0.12, 0.88]) {
      const x = w * k;
      const cone = c.createLinearGradient(0, top, 0, h);
      cone.addColorStop(0, 'rgba(255,248,215,0.09)');
      cone.addColorStop(1, 'rgba(255,248,215,0)');
      c.fillStyle = cone;
      c.beginPath();
      c.moveTo(x - 10, top);
      c.lineTo(x + 10, top);
      c.lineTo(w / 2 + (x - w / 2) * 0.2 + w * 0.12, h);
      c.lineTo(w / 2 + (x - w / 2) * 0.2 - w * 0.12, h);
      c.closePath();
      c.fill();
    }
    const v = c.createRadialGradient(w / 2, h * 0.55, Math.min(w, h) * 0.35, w / 2, h * 0.55, Math.max(w, h) * 0.8);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,8,0.5)');
    c.fillStyle = v;
    c.fillRect(0, 0, w, h);
  }

  /**
   * Where the incoming ball will arrive: a dashed ring the racket should be on, and an
   * outer ring that closes onto it as the ball gets there. Both turn green while the
   * racket is in reach.
   */
  private timingRing(): void {
    const c = this.ctx;
    const m = this.at(this.mark!);
    const r = REACH * m.s * 0.8;
    const on = this.pen !== null && Math.hypot(this.pen.x - m.x, this.pen.y - m.y) <= REACH * m.s;
    const rgb = on ? '123,228,149' : '255,255,255';
    c.strokeStyle = `rgba(${rgb},${0.45 + 0.2 * Math.sin(this.time * 8)})`;
    c.lineWidth = 3;
    c.setLineDash([10, 8]);
    c.beginPath();
    c.arc(m.x, m.y, r, 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);
    const left = clamp((this.markAt - this.time) / CLOSE_T, 0, 1);
    if (left > 0) {
      c.strokeStyle = `rgba(${rgb},${0.25 + 0.6 * (1 - left)})`;
      c.lineWidth = 2 + 3 * (1 - left);
      c.beginPath();
      c.arc(m.x, m.y, r * (1 + 2.2 * left), 0, Math.PI * 2);
      c.stroke();
    }
  }

  /**
   * Where the player's shot would land if the ball were hit right now: it sweeps from
   * cross-court to down the line as the ball comes in, and turns red where it would go wide.
   */
  private aimMarker(): void {
    const b = this.ball;
    if (!b || this.phase !== 'incoming' || this.state !== 'playing' || b.p.z > NET_Z) return;
    const contact = { x: b.p.x, y: b.p.y, z: clamp(b.p.z, HIT_NEAR, HIT_FAR) };
    // caught where the racket is now: off the middle of the strings it comes off shorter
    const p = this.at(contact);
    const off = this.pen ? clamp(Math.hypot(this.pen.x - p.x, this.pen.y - p.y) / (REACH * p.s), 0, 1) : 0;
    const shot = returnShot(contact, this.swing(), off, this.lefty);
    const bad = shot.out || shot.net;
    const rgb = bad ? '255,107,107' : '120,220,255';
    const fade = clamp((NET_Z - b.p.z) / 3, 0, 1); // fades in once the ball is over the net
    const c = this.ctx;
    const m = this.at({ x: shot.land.x, y: 0, z: shot.land.z });
    const rx = Math.max(6, 0.55 * m.s);
    const ry = Math.max(2.5, 0.2 * m.s);
    c.globalAlpha = fade;
    c.fillStyle = `rgba(${rgb},0.25)`;
    c.strokeStyle = `rgb(${rgb})`;
    c.lineWidth = 2;
    c.beginPath();
    c.ellipse(m.x, m.y, rx, ry, 0, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.beginPath();
    if (bad) {
      c.moveTo(m.x - rx * 0.5, m.y - ry * 0.5);
      c.lineTo(m.x + rx * 0.5, m.y + ry * 0.5);
      c.moveTo(m.x + rx * 0.5, m.y - ry * 0.5);
      c.lineTo(m.x - rx * 0.5, m.y + ry * 0.5);
    } else {
      c.moveTo(m.x - rx * 1.4, m.y);
      c.lineTo(m.x + rx * 1.4, m.y);
      c.moveTo(m.x, m.y - ry * 1.8);
      c.lineTo(m.x, m.y + ry * 1.8);
    }
    c.stroke();
    c.globalAlpha = 1;
  }

  /** The bonus square on the far court. */
  private targetZone(): void {
    const tg = this.target;
    if (!tg || this.state === 'menu') return;
    const c = this.ctx;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 4);
    const corners = [
      { x: tg.x - TARGET, y: 0, z: tg.z - TARGET },
      { x: tg.x + TARGET, y: 0, z: tg.z - TARGET },
      { x: tg.x + TARGET, y: 0, z: tg.z + TARGET },
      { x: tg.x - TARGET, y: 0, z: tg.z + TARGET },
    ];
    this.quad(corners, `rgba(255,209,102,${0.28 + 0.17 * pulse})`);
    c.strokeStyle = `rgba(255,209,102,${0.7 + 0.3 * pulse})`;
    c.lineWidth = 3;
    for (let i = 0; i < 4; i++) this.line(corners[i]!, corners[(i + 1) % 4]!);
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

  private paintNet(): void {
    const c = this.ctx;
    const x = DOUBLES_W + 0.9;
    const a = this.at({ x: -x, y: NET_H, z: NET_Z });
    const b = this.at({ x, y: 0, z: NET_Z });
    const mesh = c.createLinearGradient(0, a.y, 0, b.y);
    mesh.addColorStop(0, 'rgba(10,20,35,0.35)');
    mesh.addColorStop(1, 'rgba(10,20,35,0.6)');
    c.fillStyle = mesh;
    c.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    c.strokeStyle = 'rgba(255,255,255,0.16)';
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 1; i < 60; i++) {
      const px = a.x + ((b.x - a.x) * i) / 60;
      c.moveTo(px, a.y);
      c.lineTo(px, b.y);
    }
    for (let i = 1; i < 6; i++) {
      const py = a.y + ((b.y - a.y) * i) / 6;
      c.moveTo(a.x, py);
      c.lineTo(b.x, py);
    }
    c.stroke();
    // white tape with a soft highlight, and the centre strap
    c.fillStyle = '#f4f7fb';
    c.fillRect(a.x, a.y - 3, b.x - a.x, 6);
    c.fillStyle = 'rgba(0,0,0,0.18)';
    c.fillRect(a.x, a.y + 1, b.x - a.x, 2);
    c.fillStyle = '#f4f7fb';
    c.fillRect((a.x + b.x) / 2 - 2, a.y, 4, b.y - a.y);
    // posts, lit from the front
    for (const px of [a.x - 4, b.x - 3]) {
      const post = c.createLinearGradient(px, 0, px + 7, 0);
      post.addColorStop(0, '#5c6b7a');
      post.addColorStop(0.5, '#dfe6ee');
      post.addColorStop(1, '#4a5866');
      c.fillStyle = post;
      c.fillRect(px, a.y - 6, 7, b.y - a.y + 6);
    }
  }

  /** The computer player at the far end: runs with a stride, swings after each hit, tosses to serve. */
  private player(): void {
    const c = this.ctx;
    const foot = this.at({ x: this.cpu.x, y: 0, z: CPU_Z });
    const s = foot.s;
    const fx = foot.x;
    const fy = foot.y;
    const run = clamp(this.cpuRun / CPU_SPEED, 0, 1);
    const stride = Math.sin(this.cpuStep) * 0.2 * run * s;
    const bob = Math.abs(Math.sin(this.cpuStep)) * 0.06 * run * s;
    const lean = (this.cpuDir * run * 0.12) * s; // leans into the run
    c.fillStyle = 'rgba(0,0,10,0.35)';
    c.beginPath();
    c.ellipse(fx, fy, 0.5 * s, 0.13 * s, 0, 0, Math.PI * 2);
    c.fill();
    c.lineCap = 'round';
    const hip = { x: fx + lean * 0.3, y: fy - 0.85 * s - bob };
    const shoulder = { x: fx + lean, y: fy - 1.4 * s - bob };
    // legs and shoes
    c.strokeStyle = '#f0c9a0';
    c.lineWidth = Math.max(2, 0.12 * s);
    c.beginPath();
    c.moveTo(hip.x - 0.09 * s, hip.y);
    c.lineTo(fx - 0.15 * s + stride, fy - 0.05 * s);
    c.moveTo(hip.x + 0.09 * s, hip.y);
    c.lineTo(fx + 0.15 * s - stride, fy - 0.05 * s);
    c.stroke();
    c.fillStyle = '#ffffff';
    for (const dx of [-0.15 * s + stride, 0.15 * s - stride]) {
      c.beginPath();
      c.ellipse(fx + dx, fy - 0.03 * s, 0.08 * s, 0.045 * s, 0, 0, Math.PI * 2);
      c.fill();
    }
    // shorts and shirt
    c.fillStyle = '#1d3557';
    c.beginPath();
    c.roundRect(hip.x - 0.2 * s, hip.y - 0.14 * s, 0.4 * s, 0.3 * s, 0.05 * s);
    c.fill();
    const shirt = c.createLinearGradient(shoulder.x - 0.25 * s, 0, shoulder.x + 0.25 * s, 0);
    shirt.addColorStop(0, '#ff8fab');
    shirt.addColorStop(1, '#d9577a');
    c.fillStyle = shirt;
    c.beginPath();
    c.roundRect(shoulder.x - 0.24 * s, shoulder.y - 0.06 * s, 0.48 * s, 0.62 * s, 0.1 * s);
    c.fill();
    // free arm, swinging against the stride
    c.strokeStyle = '#f0c9a0';
    c.lineWidth = Math.max(2, 0.09 * s);
    c.beginPath();
    c.moveTo(shoulder.x - 0.2 * s, shoulder.y + 0.04 * s);
    c.lineTo(shoulder.x - 0.32 * s - stride * 0.6, shoulder.y + 0.55 * s);
    c.stroke();
    // head with a white cap
    const head = { x: shoulder.x, y: shoulder.y - 0.24 * s };
    c.fillStyle = '#f0c9a0';
    c.beginPath();
    c.arc(head.x, head.y, 0.16 * s, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#f4f7fb';
    c.beginPath();
    c.arc(head.x, head.y - 0.02 * s, 0.17 * s, Math.PI, 0);
    c.fill();
    c.fillRect(head.x - 0.17 * s, head.y - 0.04 * s, 0.34 * s, 0.05 * s);
    // racket arm: swings forward for a moment after each hit
    // and reaches up behind the ball during the toss
    const ang = this.toss > 0 ? -1.2 - this.toss * 0.6 : -0.5 - (this.cpu.swing / 0.3) * 1.6;
    const sx = shoulder.x + 0.2 * s;
    const sy = shoulder.y + 0.05 * s;
    const hx = sx + Math.cos(ang) * 0.6 * s;
    const hy = sy + Math.sin(ang) * 0.6 * s;
    c.beginPath();
    c.moveTo(sx, sy);
    c.lineTo(hx, hy);
    c.stroke();
    const rx = hx + Math.cos(ang) * 0.27 * s;
    const ry = hy + Math.sin(ang) * 0.27 * s;
    c.fillStyle = 'rgba(255,255,255,0.2)';
    c.beginPath();
    c.ellipse(rx, ry, 0.2 * s, 0.25 * s, ang + Math.PI / 2, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = '#ff9f1c';
    c.lineWidth = Math.max(1.5, 0.05 * s);
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
    // comet trail over the last few frames: gold after a sweet-spot hit
    const trail = this.ballTrail;
    if (b === this.ball && trail.length > 2) {
      const col = this.phase === 'outgoing' && this.sweetHit ? '255,209,102' : '230,255,90';
      c.lineCap = 'round';
      for (let i = 1; i < trail.length; i++) {
        const k = i / trail.length;
        c.strokeStyle = `rgba(${col},${0.25 * k})`;
        c.lineWidth = r * 2 * k;
        c.beginPath();
        c.moveTo(trail[i - 1]!.x, trail[i - 1]!.y);
        c.lineTo(trail[i]!.x, trail[i]!.y);
        c.stroke();
      }
      c.lineCap = 'butt';
    }
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
    // felt lit from above-left, with a darker rim
    const felt = c.createRadialGradient(p.x - r * 0.35, p.y - r * 0.4, r * 0.1, p.x, p.y, r);
    felt.addColorStop(0, '#fbffc4');
    felt.addColorStop(0.55, '#dff53f');
    felt.addColorStop(1, '#93a816');
    c.fillStyle = felt;
    c.beginPath();
    c.arc(p.x, p.y, r, 0, Math.PI * 2);
    c.fill();
    // the seam turns as the ball flies
    const spin = this.time * 9;
    c.save();
    c.clip();
    c.strokeStyle = 'rgba(255,255,255,0.85)';
    c.lineWidth = Math.max(1, r * 0.14);
    c.beginPath();
    c.arc(p.x - r * 0.9 * Math.cos(spin), p.y, r, -0.9, 0.9);
    c.arc(p.x + r * 0.9 * Math.cos(spin), p.y, r, Math.PI - 0.9, Math.PI + 0.9);
    c.stroke();
    c.restore();
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
    c.globalAlpha = 0.9; // a little see-through, so the ball behind it stays visible
    // throat (the V under the head), shaft and taped grip
    c.strokeStyle = '#ff9f1c';
    c.lineWidth = Math.max(3, r * 0.08);
    c.beginPath();
    c.moveTo(-r * 0.45, r * 0.83);
    c.lineTo(0, r * 1.3);
    c.lineTo(r * 0.45, r * 0.83);
    c.stroke();
    c.fillStyle = '#2b2f3a';
    c.fillRect(-r * 0.08, r * 1.2, r * 0.16, r * 0.35);
    c.fillStyle = '#e63946';
    c.fillRect(-r * 0.11, r * 1.5, r * 0.22, r * 0.7);
    c.strokeStyle = 'rgba(0,0,0,0.3)';
    c.lineWidth = 1;
    c.beginPath();
    for (let k = 0; k < 6; k++) {
      c.moveTo(-r * 0.11, r * (1.55 + k * 0.11));
      c.lineTo(r * 0.11, r * (1.5 + k * 0.11));
    }
    c.stroke();
    c.fillStyle = '#2b2f3a';
    c.fillRect(-r * 0.13, r * 2.17, r * 0.26, r * 0.08);
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
    // frame: a dark edge under a bright face, so it reads against both court and crowd
    c.beginPath();
    c.ellipse(0, 0, r * 0.8, r, 0, 0, Math.PI * 2);
    c.strokeStyle = '#1b1f29';
    c.lineWidth = Math.max(6, r * 0.16);
    c.stroke();
    c.strokeStyle = '#ff9f1c';
    c.lineWidth = Math.max(4, r * 0.1);
    c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.45)';
    c.lineWidth = Math.max(1, r * 0.03);
    c.beginPath();
    c.ellipse(0, 0, r * 0.8, r, 0, Math.PI * 1.1, Math.PI * 1.6);
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
      // a dark panel so the text reads over the crowd
      const pw = Math.min(w - 32, 680);
      c.fillStyle = 'rgba(5,10,20,0.72)';
      c.beginPath();
      c.roundRect(mx - pw / 2, my - 24, pw, 108, 14);
      c.fill();
      c.fillStyle = 'rgba(255,255,255,0.9)';
      c.font = '600 22px system-ui, sans-serif';
      c.fillText('Press Start, then swing at the ball', mx, my);
      c.fillStyle = 'rgba(255,255,255,0.6)';
      c.font = '500 16px system-ui, sans-serif';
      c.fillText('Put the racket on the ring where the ball will arrive.', mx, my + 28);
      c.fillText('Swing faster to hit harder. Hit early to go cross-court, late to go down the line.', mx, my + 48);
      c.fillText('Hit when the outer ring closes. Land in the gold square for a bonus.' + (this.best ? `  Best: ${this.best}` : ''), mx, my + 68);
    }

    if (this.state === 'playing' || this.state === 'paused') {
      c.fillStyle = 'rgba(255,255,255,0.85)';
      c.font = '700 22px system-ui, sans-serif';
      c.textAlign = 'left';
      c.fillText(`${'♥'.repeat(this.lives)}${'♡'.repeat(LIVES - this.lives)}${this.rally > 1 ? `   Rally ${this.rally}` : ''}`, 28, 36);
      if (this.multi > 1) {
        c.fillStyle = '#7be495';
        c.fillText(`x${this.multi}`, 28, 64);
        c.fillStyle = 'rgba(255,255,255,0.85)';
      }
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
