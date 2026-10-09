// Tennis: ball physics and shot maths, with no canvas so it can be unit tested.
//
// World (metres): x is across the court (right is positive), y is height, z runs away
// from the player. The player's baseline is z = 0, the net is at NET_Z and the far
// baseline at LENGTH. The camera sits behind and above the player's baseline.
//
// Gravity is weaker than the real thing so the ball floats a little and there is
// time to swing. The rest follows the real game: the court grips the ball at each
// bounce (GRIP), a shot hit down into the net stays there, and a ball caught off the
// middle of the strings comes off weaker.

export const G = 7;
export const BOUNCE = 0.72;
/** Share of its speed along the ground that the ball keeps after a bounce. */
export const GRIP = 0.82;
export const HALF_W = 4.115; // singles court
export const DOUBLES_W = 5.485; // outer (doubles) sideline, drawn only
/** Distance from the net to each service line. */
export const SERVICE = 6.4;
export const NET_Z = 11.885;
export const LENGTH = 23.77;
export const NET_H = 0.914;
/** Where the computer player stands, just behind the far baseline. */
export const CPU_Z = LENGTH + 0.8;

export const CAM_Y = 3;
export const CAM_Z = -4.5;

/**
 * Swing speed (screen heights per second) that gives a full-power shot. One screen
 * height is 30° of phone movement, so this is a real swing of about 480° a second:
 * everything slower than that hits proportionally softer.
 */
export const FULL_SWING = 16;
/** Below this swing speed the direction of the swing is too vague to aim the shot fully. */
export const AIM_SWING = 3;
/** Speed off the racket (m/s) for a still racket and for a full swing. */
export const PACE_MIN = 9;
export const PACE_MAX = 26;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Ball {
  p: Vec3;
  v: Vec3;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Move the ball by dt seconds. Returns true if it touched the ground in that time. */
export function stepBall(b: Ball, dt: number): boolean {
  const along = (t: number) => {
    b.p.x += b.v.x * t;
    b.p.z += b.v.z * t;
  };
  let bounced = false;
  let rest = dt;
  for (let i = 0; i < 4 && rest > 0; i++) {
    if (b.p.y === 0 && b.v.y === 0) break; // rolling
    const y = b.p.y + b.v.y * rest - 0.5 * G * rest * rest;
    if (y >= 0) {
      along(rest);
      b.p.y = y;
      b.v.y -= G * rest;
      rest = 0;
      break;
    }
    // exact time of impact inside this step
    const t = (b.v.y + Math.sqrt(b.v.y * b.v.y + 2 * G * b.p.y)) / G;
    along(t);
    const up = -(b.v.y - G * t) * BOUNCE;
    b.p.y = 0;
    b.v.y = up < 0.5 ? 0 : up;
    b.v.x *= GRIP;
    b.v.z *= GRIP;
    rest -= t;
    bounced = true;
  }
  along(rest);
  return bounced;
}

/**
 * A shot from the far end that bounces once on the player's side and crosses the
 * player's baseline (z = 0) at x = targetX, about `height` metres up.
 * `speed` is how fast it leaves the racket down the court (m/s); the bounce slows it.
 * `minBounce` is the nearest to the player's baseline it may bounce: a serve passes
 * NET_Z - SERVICE so that it lands in the service box.
 */
export function incomingShot(from: Vec3, targetX: number, speed: number, height: number, minBounce = 3): Ball {
  let best = { vy: 0, err: Infinity, reach: from.z / speed };
  for (let zb = minBounce; zb <= 10; zb += 0.25) {
    const t1 = (from.z - zb) / speed; // time to the bounce
    const vy = (0.5 * G * t1 * t1 - from.y) / t1;
    const tn = (from.z - NET_Z) / speed;
    if (from.y + vy * tn - 0.5 * G * tn * tn < NET_H + 0.25) continue; // would hit the net
    const up = -(vy - G * t1) * BOUNCE;
    const t2 = zb / (speed * GRIP); // slower after the bounce
    const err = Math.abs(up * t2 - 0.5 * G * t2 * t2 - height);
    // sideways it covers vx·t1 before the bounce and vx·GRIP·t2 after it
    if (err < best.err) best = { vy, err, reach: t1 + GRIP * t2 };
  }
  return { p: { ...from }, v: { x: (targetX - from.x) / best.reach, y: best.vy, z: -speed } };
}

/** Where and when an incoming ball crosses the player's baseline (z = 0). */
export function arrival(b: Ball): { x: number; y: number; t: number } {
  const c: Ball = { p: { ...b.p }, v: { ...b.v } };
  const dt = 1 / 240;
  let t = 0;
  while (c.p.z > 0 && t < 8) {
    stepBall(c, dt);
    t += dt;
  }
  return { x: c.p.x, y: c.p.y, t };
}

export interface Swing {
  /** Racket speed across the screen, in screen heights per second. Right is positive. */
  vx: number;
  /** Up is positive. */
  vy: number;
}
export interface ReturnShot {
  ball: Ball;
  /** Where the ball first lands. */
  land: { x: number; z: number };
  /** Lands outside the far court (wide or long). */
  out: boolean;
  /** Does not get over the net. */
  net: boolean;
  /** 0 (racket held still) to 1 (full swing). */
  power: number;
  /** How fast the ball leaves the racket, m/s. */
  pace: number;
}

/** A swing more downward than this (share of a full swing) drives the ball down instead of lifting it over the net. */
const DOWN = -0.3;

/**
 * The player's shot. A still racket blocks the ball back softly; the faster the swing,
 * the faster and deeper the ball goes, all the way up to FULL_SWING. The direction of
 * the swing aims it: sideways sends it across the court, upward adds depth. A full
 * upward swing or one aimed wide from a wide ball goes out; swing down at it and it is driven low,
 * which from normal hitting height means into the net. `off` is how far from the middle of the strings the ball
 * was caught (0 centre, 1 the edge of the reach): off-centre hits lose up to half
 * their power.
 */
export function returnShot(contact: Vec3, swing: Swing, off = 0): ReturnShot {
  const speed = Math.hypot(swing.vx, swing.vy);
  const power = clamp(speed / FULL_SWING, 0, 1) * (1 - 0.5 * clamp(off, 0, 1));
  // Which way the racket was moving aims the shot; how fast it was moving sets the pace.
  const side = speed ? (swing.vx / speed) * clamp(speed / AIM_SWING, 0, 1) : 0;
  const lift = speed ? (swing.vy / speed) * power : 0;
  let land = {
    x: contact.x * 0.35 + side * 3.4,
    z: NET_Z + 4 + 6.5 * power + 2.5 * lift,
  };
  const from: Vec3 = { x: contact.x, y: Math.max(0.3, contact.y), z: contact.z };
  const dx = land.x - from.x;
  const dz = land.z - from.z;
  let t = Math.hypot(dx, dz) / (PACE_MIN + (PACE_MAX - PACE_MIN) * power);
  let vy = 0;
  const overNet = () => {
    const tn = (t * (NET_Z - from.z)) / dz;
    return from.y + vy * tn - 0.5 * G * tn * tn;
  };
  // Loft the ball more (slower, higher) until it clears the net.
  for (let i = 0; i < 12; i++) {
    vy = (0.5 * G * t * t - from.y) / t;
    if (overNet() >= NET_H + 0.2) break;
    t *= 1.12;
  }
  if (lift < DOWN) {
    // Hit downward: the ball leaves lower than that and comes down sooner.
    vy += lift * 4;
    const tg = (vy + Math.sqrt(vy * vy + 2 * G * from.y)) / G;
    land = { x: from.x + (dx / t) * tg, z: from.z + (dz / t) * tg };
  }
  const net = overNet() < NET_H;
  return {
    ball: { p: from, v: { x: dx / t, y: vy, z: dz / t } },
    land,
    out: !net && (Math.abs(land.x) > HALF_W || land.z > LENGTH),
    net,
    power,
    pace: Math.hypot(dx / t, vy, dz / t),
  };
}

/** Pinhole projection of a world point onto a w×h screen. `s` is pixels per metre at that depth. */
export function project(p: Vec3, w: number, h: number): { x: number; y: number; s: number } {
  const f = Math.min(h * 0.95, w * 0.62);
  const s = f / Math.max(0.5, p.z - CAM_Z);
  return { x: w / 2 + p.x * s, y: h * 0.3 + (CAM_Y - p.y) * s, s };
}
