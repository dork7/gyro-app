// Torso angles from a phone held against the chest, and the yoga poses built on them.
//
// Hold the phone to your chest with both hands, screen facing in or out (either works).
// Gravity direction in the phone's own axes (x right, y up the screen, z out of the screen):
//     u = ( -cos(b)·sin(g),  sin(b),  cos(b)·cos(g) )
// Standing tall, u points along the phone's y axis. Then:
//   fold  = how far the torso is bent forward   = atan2(|uz|, uy)   0° upright, 90° flat, 120° head down
//   lean  = how far it is bent to the side      = atan2(-ux, uy)    only meaningful while fold is small
// Both are measured relative to a calibration pose ("stand tall").

import { wrap180, type Orientation } from './pointer';

const DEG = Math.PI / 180;

export interface Torso {
  fold: number; // degrees, >= 0
  lean: number; // degrees, sign depends on how the phone is held (the game accepts either side)
}

/** Above this fold the sideways angle is unreliable, so it is reported as 0. */
export const LEAN_FOLD_LIMIT = 50;

export function torsoRaw(o: Orientation): Torso {
  const b = o.b * DEG;
  const g = (o.g ?? 0) * DEG;
  const ux = -Math.cos(b) * Math.sin(g);
  const uy = Math.sin(b);
  const uz = Math.cos(b) * Math.cos(g);
  return { fold: Math.atan2(Math.abs(uz), uy) / DEG, lean: Math.atan2(-ux, uy) / DEG };
}

/** Angles relative to the "stand tall" reference. */
export function torsoRel(raw: Torso, ref: Torso): Torso {
  const fold = Math.max(0, raw.fold - ref.fold);
  const lean = fold < LEAN_FOLD_LIMIT ? wrap180(raw.lean - ref.lean) : 0;
  return { fold, lean };
}

// ---- poses ---------------------------------------------------------------------------
export type PoseKind = 'stand' | 'side' | 'otherSide' | 'fold';

export interface Pose {
  kind: PoseKind;
  name: string;
  cue: string;
}

export const FLOW: Pose[] = [
  { kind: 'stand', name: 'Mountain', cue: 'Stand tall, feet together, phone to your heart' },
  { kind: 'side', name: 'Crescent', cue: 'Reach up and bend gently to one side' },
  { kind: 'otherSide', name: 'Crescent, other side', cue: 'Now bend to the opposite side' },
  { kind: 'fold', name: 'Forward fold', cue: 'Hinge at the hips and fold forward' },
  { kind: 'stand', name: 'Mountain', cue: 'Roll up slowly and stand tall' },
];

/** Does this torso position count as the pose? `sideSign` is the lean sign used in the first side bend (0 if none yet). */
export function matches(kind: PoseKind, t: Torso, sideSign: number): boolean {
  const l = Math.abs(t.lean);
  switch (kind) {
    case 'stand':
      return t.fold < 14 && l < 10;
    case 'side':
      return t.fold < 22 && l >= 22 && l <= 60;
    case 'otherSide':
      return t.fold < 22 && l >= 22 && l <= 60 && (sideSign === 0 || Math.sign(t.lean) === -sideSign);
    case 'fold':
      return t.fold >= 55 && t.fold <= 135;
  }
}

/** A representative position for the pose, used to draw the ghost figure. */
export function targetOf(kind: PoseKind, sideSign: number): Torso {
  switch (kind) {
    case 'stand':
      return { fold: 0, lean: 0 };
    case 'side':
      return { fold: 0, lean: 35 };
    case 'otherSide':
      return { fold: 0, lean: sideSign === 0 ? -35 : -sideSign * 35 };
    case 'fold':
      return { fold: 100, lean: 0 };
  }
}

/** Angular speed (deg/s) below which the pose counts as calm and steady. */
export const CALM_DEG_PER_S = 14;
