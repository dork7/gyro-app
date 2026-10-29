// Fishing: cast, strike and reel with the phone as the rod.
//
// Grip: hold the phone like the handle of a rod, top edge pointing at the screen (the same
// pointer as Fruit Slicer, so yaw aims left/right and pitch is up/down).
//   cast   - lift the rod, then whip it forward: the pitch drops fast. Faster = farther.
//   strike - when the bobber goes under, jerk the rod up: the pitch rises fast.
//   reel   - wind the reel by moving the rod tip in circles. Shaking back and forth does
//            not count, only going round.
// The line has a tension: reel while the fish pulls hard and it snaps; stop reeling for
// too long and the slack line lets the fish get away.

// ---- rod swings -------------------------------------------------------------------------
export const CAST_DPS = 220; // forward whip speed (deg/s of pitch) for a cast, at sensitivity 1
export const STRIKE_DPS = 160; // upward jerk speed for a strike

export type Swing = { type: 'cast'; power: number } | { type: 'strike' };

export class SwingDetector {
  sens = 1;
  private prev: { p: number; t: number } | null = null;
  private rate = 0; // smoothed pitch rate, deg/s
  private low = 0; // fastest forward rate of the current whip
  private coolUntil = 0;

  /** Feed the rod pitch (degrees, up positive) at time t (ms). */
  push(pitch: number, t: number): Swing | null {
    const prev = this.prev;
    this.prev = { p: pitch, t };
    if (!prev || t <= prev.t) return null;
    const dt = t - prev.t;
    const raw = ((pitch - prev.p) / dt) * 1000;
    this.rate += (raw - this.rate) * Math.min(1, dt / 40);
    if (t < this.coolUntil) return null;
    const cast = CAST_DPS / this.sens;
    if (this.rate < -cast) this.low = Math.min(this.low, this.rate);
    else if (this.low < -cast && this.rate > -cast * 0.5) {
      // the whip has peaked: cast with a power set by how fast it was
      const power = Math.max(0.15, Math.min(1, 0.2 + (-this.low - cast) / (cast * 2.5)));
      this.low = 0;
      this.coolUntil = t + 600;
      return { type: 'cast', power };
    }
    if (this.rate > STRIKE_DPS / this.sens) {
      this.coolUntil = t + 400;
      return { type: 'strike' };
    }
    return null;
  }
}

// ---- reeling ----------------------------------------------------------------------------
/**
 * Counts turns of the rod tip going round in circles. Points are in any units (degrees of
 * aim, pixels); `minRadius` is the smallest circle that counts. Only steady turning in one
 * direction counts, so shaking along a line adds (almost) nothing.
 */
export class ReelTracker {
  private cx: number | null = null;
  private cy = 0;
  private lastAngle: number | null = null;
  private lastT = 0;
  private spin = 0; // smoothed angular speed, rad/s (signed)

  constructor(private minRadius: number) {}

  /** Feed a point at time t (ms); returns the turns wound since the last call (>= 0). */
  push(x: number, y: number, t: number): number {
    const dt = this.lastT ? Math.max(1, t - this.lastT) : 16;
    this.lastT = t;
    if (this.cx === null) {
      this.cx = x;
      this.cy = y;
      return 0;
    }
    // the centre of the circles drifts with the hand
    const k = Math.min(1, dt / 500);
    this.cx += (x - this.cx) * k;
    this.cy += (y - this.cy) * k;
    const dx = x - this.cx;
    const dy = y - this.cy;
    if (Math.hypot(dx, dy) < this.minRadius) {
      this.lastAngle = null;
      this.spin *= 0.9;
      return 0;
    }
    const a = Math.atan2(dy, dx);
    if (this.lastAngle === null) {
      this.lastAngle = a;
      return 0;
    }
    let d = a - this.lastAngle;
    if (d > Math.PI) d -= 2 * Math.PI;
    else if (d < -Math.PI) d += 2 * Math.PI;
    this.lastAngle = a;
    this.spin += ((d / dt) * 1000 - this.spin) * Math.min(1, dt / 250);
    if (Math.abs(this.spin) < 2 || Math.sign(d) !== Math.sign(this.spin)) return 0;
    return Math.abs(d) / (2 * Math.PI);
  }
}

// ---- fish ---------------------------------------------------------------------------------
export interface FishKind {
  name: string;
  emoji: string;
  minKg: number;
  maxKg: number;
  pointsPerKg: number;
  strength: number; // 0..1: how hard it pulls
  chance: number; // relative likelihood
  depth: number; // casts shorter than this (0..1) do not reach it
}

export const FISH: FishKind[] = [
  { name: 'Old boot', emoji: '🥾', minKg: 0.5, maxKg: 1, pointsPerKg: 5, strength: 0.05, chance: 0.6, depth: 0 },
  { name: 'Sardine', emoji: '🐟', minKg: 0.1, maxKg: 0.4, pointsPerKg: 250, strength: 0.25, chance: 3, depth: 0 },
  { name: 'Clownfish', emoji: '🐠', minKg: 0.2, maxKg: 0.6, pointsPerKg: 300, strength: 0.35, chance: 2, depth: 0.2 },
  { name: 'Pufferfish', emoji: '🐡', minKg: 0.5, maxKg: 2, pointsPerKg: 120, strength: 0.5, chance: 1.4, depth: 0.35 },
  { name: 'Squid', emoji: '🦑', minKg: 1, maxKg: 4, pointsPerKg: 90, strength: 0.65, chance: 0.9, depth: 0.5 },
  { name: 'Octopus', emoji: '🐙', minKg: 2, maxKg: 8, pointsPerKg: 60, strength: 0.75, chance: 0.6, depth: 0.6 },
  { name: 'Shark', emoji: '🦈', minKg: 20, maxKg: 60, pointsPerKg: 25, strength: 0.95, chance: 0.25, depth: 0.75 },
];

/** What bites at this depth (the cast power, 0..1). */
export function pickFish(depth: number, rng: () => number): { fish: FishKind; kg: number } {
  const pool = FISH.filter((f) => f.depth <= depth + 1e-9);
  let r = rng() * pool.reduce((a, f) => a + f.chance, 0);
  let fish = pool[pool.length - 1];
  for (const f of pool) {
    r -= f.chance;
    if (r <= 0) {
      fish = f;
      break;
    }
  }
  const kg = Math.round((fish.minKg + rng() * (fish.maxKg - fish.minKg)) * 100) / 100;
  return { fish, kg };
}

export const fishPoints = (f: FishKind, kg: number) => Math.round(f.pointsPerKg * kg);

/** Metres of water a cast of this power covers. */
export const castDistance = (power: number) => 6 + power * 24;

// ---- the fight ---------------------------------------------------------------------------
export const REEL_M_PER_TURN = 1.6;
const SLACK_LIMIT = 2.5; // seconds of slack line before the fish gets off

export interface Fight {
  dist: number; // metres of line out
  tension: number; // 0..1, snaps at 1
  pull: number; // current pull of the fish (0 between bursts)
  burst: number; // seconds left in the current burst, or until the next one if pull is 0
  slack: number; // seconds the line has been slack
  strength: number;
}

export type FightResult = 'on' | 'caught' | 'snapped' | 'escaped';

export function newFight(strength: number, dist: number): Fight {
  return { dist, tension: 0.3, pull: 0, burst: 0.8, slack: 0, strength };
}

/** Advance the fight; `reel` is the winding speed in turns per second. */
export function stepFight(f: Fight, dt: number, reel: number, rng: () => number): FightResult {
  f.burst -= dt;
  if (f.burst <= 0) {
    if (f.pull > 0) {
      f.pull = 0;
      f.burst = 0.8 + rng() * 1.8; // rest
    } else {
      f.pull = f.strength * (0.6 + rng() * 0.8); // a run
      f.burst = 0.6 + rng() * 0.9;
    }
  }
  const reeling = reel > 0.2;
  // reeling against a run strains the line; when you stop, the drag lets line out instead
  f.tension += (reel * 0.3 + f.pull * (reeling ? 0.75 : 0.25) - 0.35) * dt;
  f.tension = Math.max(0, f.tension);
  f.dist = Math.max(0, f.dist + (f.pull * 1.6 - reel * REEL_M_PER_TURN) * dt);
  if (f.tension >= 1) return 'snapped';
  if (f.dist <= 0.5) return 'caught';
  f.slack = f.tension < 0.06 ? f.slack + dt : 0;
  if (f.slack > SLACK_LIMIT) return 'escaped';
  return 'on';
}
