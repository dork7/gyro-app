// Sky Rings maths: the phone as an aircraft yoke, and the course of rings to fly through.
//
// Grip: hold the phone upright in both hands like a steering wheel, screen facing you
// (portrait or landscape). Two angles come out of it:
//   roll  = the wheel angle (see wheelAngle in pointer.ts): turn clockwise to bank right
//   pitch = how far the screen faces up or down. "Up" in the phone's own axes is
//             u = ( -cos(b)·sin(g),  sin(b),  cos(b)·cos(g) )
//           and pitch = asin(uz): tilting the top edge away from you raises it.
// Like a real yoke, pulling the top edge back toward you climbs and pushing it away dives.
// Both are relative to a calibrated "level flight" pose.

import { steerValue, wheelAngle, wrap180, type Orientation } from './pointer';

const DEG = Math.PI / 180;

export interface Yoke {
  roll: number; // degrees, clockwise positive
  pitch: number; // degrees, screen facing up positive
}

export function yoke(o: Orientation): Yoke {
  const b = o.b * DEG;
  const g = (o.g ?? 0) * DEG;
  const uz = Math.cos(b) * Math.cos(g);
  return { roll: wheelAngle(o), pitch: Math.asin(Math.max(-1, Math.min(1, uz))) / DEG };
}

/** Degrees of pitch that give a full climb or dive at sensitivity 1. */
export const FULL_PITCH = 25;
const PITCH_DEAD = 2;

/** Yoke relative to level flight, as -1..1 controls: x = bank right, y = climb. */
export function yokeInput(y: Yoke, ref: Yoke, sens = 1, invert = false): { x: number; y: number } {
  const x = steerValue(y.roll - ref.roll, sens);
  const d = wrap180(ref.pitch - y.pitch) * (invert ? -1 : 1);
  const mag = Math.max(0, Math.abs(d) - PITCH_DEAD);
  return { x: x || 0, y: mag > 0 ? Math.sign(d) * Math.min(1, mag / (FULL_PITCH / sens - PITCH_DEAD)) : 0 };
}

// ---- the course ------------------------------------------------------------------------
// World units: x right, y up, z ahead of the plane. The plane flies at z = 0 inside a box
// of ±X_RANGE by ±Y_RANGE and the rings come towards it.

export const X_RANGE = 6;
export const Y_RANGE = 3.2;
/** Top sideways and vertical speed of the plane (units per second). */
export const PLANE_VX = 8;
export const PLANE_VY = 5.5;

export interface Ring {
  x: number;
  y: number;
  z: number;
  r: number;
  gold: boolean;
}

/** Forward speed grows with the distance flown. */
export function forwardSpeed(distance: number): number {
  return 18 + Math.min(14, distance / 150);
}

/**
 * The ring after `prev`, for the n-th ring of the run. It is never further off than the
 * plane can cover in the time between the two, with some margin to spare.
 */
export function nextRing(prev: { x: number; y: number; z: number }, n: number, speed: number, rng: () => number): Ring {
  const gap = Math.max(16, 26 - n * 0.12);
  const t = gap / speed;
  const reachX = PLANE_VX * t * 0.6;
  const reachY = PLANE_VY * t * 0.6;
  const gold = n % 7 === 6;
  const r = Math.max(1.05, 1.7 - n * 0.012) * (gold ? 0.75 : 1);
  const lim = (v: number, range: number) => Math.max(-range + r * 0.6, Math.min(range - r * 0.6, v));
  return {
    x: lim(prev.x + (rng() * 2 - 1) * reachX, X_RANGE),
    y: lim(prev.y + (rng() * 2 - 1) * reachY, Y_RANGE),
    z: prev.z + gap,
    r,
    gold,
  };
}

export type Verdict = 'bull' | 'pass' | 'miss';

/** How the plane at (px, py) went through a ring as it reached z = 0. */
export function judge(ring: Ring, px: number, py: number): Verdict {
  const d = Math.hypot(px - ring.x, py - ring.y);
  if (d < ring.r * 0.35) return 'bull';
  if (d < ring.r) return 'pass';
  return 'miss';
}
