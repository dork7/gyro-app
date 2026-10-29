// Bowling: ten-pin scoring, pin physics, and reading a throw from the phone.
//
// Grip: hold the phone in your bowling hand, top edge pointing at the screen, and keep the
// GRIP button on the phone pressed with your thumb. Swing your arm underarm and let go of
// GRIP to release the ball. The swing speed (how fast the phone's pitch changes) sets the
// ball speed, the sideways part of the swing sets the angle, and twisting the wrist as you
// let go adds hook.
//
// Lane coordinates in metres: x across (0 = middle, right positive), z down the lane from
// the foul line. The head pin stands at z = HEAD_Z.

export const LANE_W = 1.05;
export const HEAD_Z = 18.29;
export const BALL_R = 0.109;
export const PIN_R = 0.06; // at the belly
const PIN_SPACING = 0.3048;
const ROW_DEPTH = 0.2639;
const BALL_M = 6.5;
const PIN_M = 1.5;
const SKID_Z = 6; // the ball skids straight before the hook takes over
const HOOK_ACC = 0.3; // m/s² of sideways pull at full hook: about 45 cm of curve at a normal speed
const PIN_FRICTION = 3; // m/s² of slowing for sliding pins
const DECK_END = HEAD_Z + 1.1;
const KICKBACK_X = LANE_W / 2 + 0.25; // side boards around the pin deck

// ---- scoring -------------------------------------------------------------------------------
export interface Frames {
  frames: number[][]; // rolls of each frame so far
  done: boolean;
  frame: number; // index of the frame being bowled (0..9)
  standing: number; // pins up for the next roll
  fresh: boolean; // the next roll is on a full rack
}

export function frames(rolls: number[]): Frames {
  const fs: number[][] = [];
  let i = 0;
  for (let f = 0; f < 10 && i < rolls.length; f++) {
    if (f < 9) {
      if (rolls[i] === 10) fs.push([rolls[i++]]);
      else fs.push(rolls.slice(i, i + 2)), (i += 2);
    } else fs.push(rolls.slice(i, i + 3)), (i += 3);
  }
  const last = fs[fs.length - 1];
  const lastDone = (f: number[], idx: number) => {
    if (idx < 9) return f.length === 2 || f[0] === 10;
    if (f.length === 3) return true;
    return f.length === 2 && f[0] + f[1] < 10;
  };
  if (!last) return { frames: fs, done: false, frame: 0, standing: 10, fresh: true };
  const idx = fs.length - 1;
  if (lastDone(last, idx)) {
    if (idx === 9) return { frames: fs, done: true, frame: 9, standing: 0, fresh: false };
    return { frames: fs, done: false, frame: idx + 1, standing: 10, fresh: true };
  }
  // mid-frame: what is still standing
  if (idx < 9) return { frames: fs, done: false, frame: idx, standing: 10 - last[0], fresh: false };
  // tenth frame: the rack is reset after a strike or a spare
  const [a, b] = last;
  if (last.length === 1) return { frames: fs, done: false, frame: 9, standing: a === 10 ? 10 : 10 - a, fresh: a === 10 };
  if (a === 10) return { frames: fs, done: false, frame: 9, standing: b === 10 ? 10 : 10 - b, fresh: b === 10 };
  return { frames: fs, done: false, frame: 9, standing: 10, fresh: true }; // spare
}

/** Running totals per frame; null while a strike or spare still waits for its bonus. */
export function totals(rolls: number[]): (number | null)[] {
  const out: (number | null)[] = [];
  let i = 0;
  let sum = 0;
  for (let f = 0; f < 10 && i < rolls.length; f++) {
    const a = rolls[i];
    const b = rolls[i + 1];
    const c = rolls[i + 2];
    if (a === 10) {
      if (b === undefined || c === undefined) return [...out, null];
      sum += 10 + b + c;
      i += f < 9 ? 1 : 3;
    } else {
      if (b === undefined) return [...out, null];
      if (a + b === 10) {
        if (c === undefined) return [...out, null];
        sum += 10 + c;
      } else sum += a + b;
      i += f < 9 ? 2 : a + b === 10 ? 3 : 2;
    }
    out.push(sum);
  }
  return out;
}

/** Score sheet marks for each frame: X, /, - or a number. */
export function marks(rolls: number[]): string[][] {
  return frames(rolls).frames.map((f, idx) => {
    const out: string[] = [];
    f.forEach((r, k) => {
      const prev = f[k - 1];
      const afterReset = idx === 9 && (k === 0 || prev === 10 || (k === 2 && f[0] !== 10 && f[0] + f[1] === 10) || (k === 2 && f[0] === 10 && f[1] === 10));
      if (r === 10 && (k === 0 || afterReset)) out.push('X');
      else if (k > 0 && !afterReset && prev + r === 10) out.push('/');
      else out.push(r === 0 ? '-' : String(r));
    });
    return out;
  });
}

// ---- pins and ball -------------------------------------------------------------------------
export interface Body {
  x: number;
  z: number;
  vx: number;
  vz: number;
}
export interface Pin extends Body {
  n: number; // pin number 1..10
  homeX: number;
  homeZ: number;
  up: boolean; // still standing
  gone: boolean; // swept off or knocked down earlier in the frame
  tilt: number; // which way it fell (radians), for drawing
}
export interface Ball extends Body {
  hook: number;
  gutter: boolean;
}

/** The ten pins in their triangle: 1 at the front, 7–10 at the back. */
export function rack(): Pin[] {
  const pins: Pin[] = [];
  let n = 1;
  for (let row = 0; row < 4; row++) {
    for (let i = 0; i <= row; i++) {
      const x = (i - row / 2) * PIN_SPACING;
      const z = HEAD_Z + row * ROW_DEPTH;
      pins.push({ n: n++, x, z, vx: 0, vz: 0, homeX: x, homeZ: z, up: true, gone: false, tilt: 0 });
    }
  }
  return pins;
}

export interface Throw {
  speed: number; // m/s
  angle: number; // radians, right positive
  hook: number; // -1..1
}

export function launch(x: number, t: Throw): Ball {
  return { x, z: 0, vx: Math.sin(t.angle) * t.speed, vz: Math.cos(t.angle) * t.speed, hook: t.hook, gutter: false };
}

function collide(a: Body, ma: number, ra: number, b: Body, mb: number, rb: number, e: number): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const d = Math.hypot(dx, dz);
  if (d >= ra + rb || d < 1e-9) return 0;
  const nx = dx / d;
  const nz = dz / d;
  // push apart in proportion to mass
  const overlap = ra + rb - d;
  a.x -= nx * overlap * (mb / (ma + mb));
  a.z -= nz * overlap * (mb / (ma + mb));
  b.x += nx * overlap * (ma / (ma + mb));
  b.z += nz * overlap * (ma / (ma + mb));
  const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
  if (rel >= 0) return 0;
  const j = (-(1 + e) * rel) / (1 / ma + 1 / mb);
  a.vx -= (j / ma) * nx;
  a.vz -= (j / ma) * nz;
  b.vx += (j / mb) * nx;
  b.vz += (j / mb) * nz;
  return j;
}

/** Knock a pin over once it is hit hard enough or shoved off its spot. */
function settle(p: Pin): void {
  if (!p.up) return;
  if (Math.hypot(p.vx, p.vz) > 0.35 || Math.hypot(p.x - p.homeX, p.z - p.homeZ) > 0.03) {
    p.up = false;
    p.tilt = Math.atan2(p.vx, p.vz || 1e-6);
  }
}

/** Advance ball and pins by dt seconds (small substeps inside). */
export function stepLane(ball: Ball, pins: Pin[], dt: number): void {
  const steps = Math.max(1, Math.ceil(dt / (1 / 300)));
  const h = dt / steps;
  for (let s = 0; s < steps; s++) {
    // ball: straight while skidding, then the hook bends it
    if (!ball.gutter && ball.z > SKID_Z && ball.z < HEAD_Z) ball.vx += ball.hook * HOOK_ACC * h;
    ball.x += ball.vx * h;
    ball.z += ball.vz * h;
    if (!ball.gutter && Math.abs(ball.x) > LANE_W / 2 && ball.z < HEAD_Z - 0.2) {
      ball.gutter = true;
      ball.vx = 0;
      ball.x = Math.sign(ball.x) * (LANE_W / 2 + BALL_R);
    }
    const live = pins.filter((p) => !p.gone && p.z < DECK_END + 1);
    for (const p of live) {
      if (!p.up || p.vx || p.vz) {
        const sp = Math.hypot(p.vx, p.vz);
        if (sp > 0) {
          const k = Math.max(0, sp - PIN_FRICTION * h) / sp;
          p.vx *= k;
          p.vz *= k;
        }
        p.x += p.vx * h;
        p.z += p.vz * h;
        // side boards kick pins back onto the deck
        if (Math.abs(p.x) > KICKBACK_X && p.z > HEAD_Z - 0.4) {
          p.x = Math.sign(p.x) * KICKBACK_X;
          p.vx = -p.vx * 0.5;
        }
      }
    }
    if (!ball.gutter) for (const p of live) collide(ball, BALL_M, BALL_R, p, PIN_M, PIN_R, 0.5);
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) collide(live[i], PIN_M, PIN_R, live[j], PIN_M, PIN_R, 0.6);
    for (const p of live) settle(p);
  }
}

/** Nothing on the deck is moving any more and the ball has gone into the pit. */
export function laneSettled(ball: Ball, pins: Pin[]): boolean {
  if (ball.z < DECK_END) return false;
  return pins.every((p) => p.gone || p.z > DECK_END + 1 || Math.hypot(p.vx, p.vz) < 0.05);
}

// ---- reading the swing ---------------------------------------------------------------------
export const MIN_SWING_DPS = 120;

interface Sample {
  pitch: number;
  yaw: number;
  roll: number;
  t: number;
}

const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Keeps the last moments of phone orientation and turns them into a throw on release. */
export class ThrowTracker {
  sens = 1;
  private s: Sample[] = [];

  push(pitch: number, yaw: number, roll: number, t: number): void {
    this.s.push({ pitch, yaw, roll, t });
    while (this.s.length && this.s[0].t < t - 600) this.s.shift();
  }

  /** The throw made by letting go at time t, or null if the arm was hardly moving. */
  release(t: number): Throw | null {
    const s = this.s.filter((x) => x.t >= t - 300 && x.t <= t + 20);
    if (s.length < 3) return null;
    let peak = 0;
    const rate = (k: 'pitch' | 'yaw' | 'roll', a: Sample, b: Sample) => (wrap(b[k] - a[k]) / Math.max(1, b.t - a.t)) * 1000;
    for (let i = 1; i < s.length; i++) peak = Math.max(peak, Math.abs(rate('pitch', s[i - 1], s[i])));
    peak *= this.sens;
    if (peak < MIN_SWING_DPS) return null;
    // heading means nothing while the phone points nearly straight up or down (the bottom of
    // the swing, or a big follow-through), so only level-ish moments count for the angle
    const avg = (k: 'yaw' | 'roll', ms: number) => {
      const w = s.filter((x) => x.t >= t - ms && Math.abs(x.pitch) < 60);
      if (w.length < 2) return 0;
      return rate(k, w[0], w[w.length - 1]);
    };
    const speed = Math.max(3, Math.min(10, 3 + ((peak - MIN_SWING_DPS) / 500) * 6));
    const angle = Math.max(-0.08, Math.min(0.08, (avg('yaw', 150) / Math.max(peak, 1)) * 0.25));
    const hook = Math.max(-1, Math.min(1, avg('roll', 200) / 600));
    return { speed, angle, hook };
  }
}
