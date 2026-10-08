// Turns phone orientation into a 2D pointer on the laptop screen.
//
// Grip assumption ("sword grip"): the phone is held in portrait and its TOP EDGE
// points at the screen, like the blade of a sword. We track where that top edge
// points (heading + elevation) and ignore twisting around it, which avoids gimbal
// trouble and makes the result independent of how the screen is facing.
//
// With the W3C ZXY Euler convention, the device's +Y axis in world space is
//     f = ( -sin(a)·cos(b),  cos(a)·cos(b),  sin(b) )
// so  yaw = atan2(fx, fy)  (clockwise from above = right)  and  pitch = asin(fz).
//
// Everything is relative to a calibrated centre pose, because absolute heading
// (alpha) has no fixed reference on most phones.

const DEG = Math.PI / 180;

export interface Orientation {
  a: number;
  b: number;
  g?: number;
}

export interface Aim {
  yaw: number; // degrees, right is positive
  pitch: number; // degrees, up is positive
}

export function wrap180(d: number): number {
  let x = (d + 180) % 360;
  if (x < 0) x += 360;
  return x - 180;
}

export function aim(o: Orientation): Aim {
  const a = o.a * DEG;
  const b = o.b * DEG;
  const fx = -Math.sin(a) * Math.cos(b);
  const fy = Math.cos(a) * Math.cos(b);
  const fz = Math.sin(b);
  return {
    yaw: Math.atan2(fx, fy) / DEG,
    pitch: Math.asin(Math.max(-1, Math.min(1, fz))) / DEG,
  };
}

/** Degrees of phone movement that sweep the full screen at sensitivity 1. */
export const RANGE_X = 50;
export const RANGE_Y = 30;

export class PointerMapper {
  private center: Aim | null = null;

  get hasCenter(): boolean {
    return this.center !== null;
  }

  setCenter(a: Aim): void {
    this.center = { ...a };
  }

  /** Map an aim to pixel coordinates inside a w×h screen. Higher sens = smaller wrist movement. */
  map(a: Aim, w: number, h: number, sens = 1): { x: number; y: number } {
    const c = this.center ?? a;
    const dx = wrap180(a.yaw - c.yaw);
    const dy = a.pitch - c.pitch;
    const x = w / 2 + (dx / (RANGE_X / sens)) * w;
    const y = h / 2 - (dy / (RANGE_Y / sens)) * h;
    return { x: Math.max(0, Math.min(w, x)), y: Math.max(0, Math.min(h, y)) };
  }
}

// ---------------------------------------------------------------------------------
// Steering-wheel mode: roll of the phone around its screen normal.
//
// Where "up" is, seen from the phone's own axes (x right, y up the screen, z out of
// the screen), follows from the same Euler convention:
//     ux = -cos(b)·sin(g)     uy = sin(b)
// Its angle in the screen plane, atan2(uy, ux), grows as the phone turns clockwise
// (as seen by the player), in portrait or either landscape. Relative to a calibrated
// neutral angle it is the wheel angle.

export function wheelAngle(o: Orientation): number {
  const b = o.b * DEG;
  const g = (o.g ?? 0) * DEG;
  const ux = -Math.cos(b) * Math.sin(g);
  const uy = Math.sin(b);
  return Math.atan2(uy, ux) / DEG;
}

/** Degrees of wheel rotation that give full lock at sensitivity 1. */
export const FULL_LOCK = 40;
const DEAD_ZONE = 1.5;

/** Wheel angle difference (degrees, clockwise positive) to a steering value in -1..1. */
export function steerValue(deltaDeg: number, sens = 1): number {
  const d = wrap180(deltaDeg);
  const mag = Math.max(0, Math.abs(d) - DEAD_ZONE);
  const v = Math.min(1, mag / (FULL_LOCK / sens - DEAD_ZONE));
  return Math.sign(d) * v;
}
