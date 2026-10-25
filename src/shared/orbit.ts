// Orbit Defender maths: the phone's heading as a cannon that turns all the way around,
// and the pacing of the meteor storm.
//
// Grip: hold the phone flat like a dial, top edge pointing at the laptop, and twist it
// (or turn on the spot). The heading is where the top edge points (aim().yaw in
// pointer.ts), relative to a calibrated "straight up" pose. GAIN makes a quarter-turn of
// the wrist swing the cannon half way round, so the whole circle is in reach without
// spinning on the spot. Angles: 0 = up the screen, clockwise positive, in degrees.

import { aim, wrap180, type Orientation } from './pointer';

const DEG = Math.PI / 180;

export const GAIN = 2;

export function heading(o: Orientation): number {
  return aim(o).yaw;
}

/** Cannon angle for a heading, relative to the calibrated heading. */
export function cannonAngle(yaw: number, ref: number, sens = 1): number {
  return wrap180(wrap180(yaw - ref) * GAIN * sens);
}

/** Unit vector for an angle, in screen axes (x right, y down). */
export function dirOf(angleDeg: number): { x: number; y: number } {
  return { x: Math.sin(angleDeg * DEG), y: -Math.cos(angleDeg * DEG) };
}

/** Screen angle of a point relative to the centre. */
export function angleOf(x: number, y: number): number {
  return Math.atan2(x, -y) / DEG;
}

/** Is `angle` within `width` degrees centred on `center`? */
export function inArc(angle: number, center: number, width: number): boolean {
  return Math.abs(wrap180(angle - center)) <= width / 2;
}

/** Turn `from` toward `to` by at most `maxStep` degrees, the short way round. */
export function turnToward(from: number, to: number, maxStep: number): number {
  const d = wrap180(to - from);
  return wrap180(from + Math.max(-maxStep, Math.min(maxStep, d)));
}

// ---- the storm -------------------------------------------------------------------------
// Distances are in arena radii: meteors start just outside 1 and fall towards 0.

export const PLANET_R = 0.13;
export const SHIELD_R = 0.22;
export const SHIELD_W = 70; // degrees
export const SPAWN_R = 1.08;

/** Seconds between meteors, `t` seconds into the run. */
export function spawnGap(t: number): number {
  return Math.max(0.45, 1.8 - t * 0.02);
}

/** Inward speed (radii per second) of a new meteor. */
export function meteorSpeed(t: number): number {
  return Math.min(0.42, 0.15 + t * 0.002);
}

/** Chance that a new meteor is a big one (3 hits, splits in two). */
export function bigChance(t: number): number {
  return t < 20 ? 0 : Math.min(0.3, 0.1 + (t - 20) * 0.003);
}

/**
 * Pick a spawn angle that is not too close to the previous one, so meteors come from
 * all round and the player has to keep turning.
 */
export function spawnAngle(prev: number | null, rng: () => number): number {
  for (let i = 0; i < 8; i++) {
    const a = wrap180(rng() * 360);
    if (prev === null || Math.abs(wrap180(a - prev)) >= 50) return a;
  }
  return wrap180((prev ?? 0) + 180);
}
