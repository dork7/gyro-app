import { describe, expect, it } from 'vitest';
import { forwardSpeed, judge, nextRing, PLANE_VX, PLANE_VY, X_RANGE, Y_RANGE, yoke, yokeInput, type Ring } from './flight';
import { mulberry32 } from './marble';

// Phone upright in portrait, screen facing the player: beta 90.
const UPRIGHT = { a: 0, b: 90, g: 0 };

describe('yoke', () => {
  it('reads level flight as no input', () => {
    const ref = yoke(UPRIGHT);
    const v = yokeInput(yoke({ a: 0, b: 89, g: 0.5 }), ref);
    expect(v.x).toBe(0);
    expect(v.y).toBe(0);
  });

  it('banks right when the phone turns clockwise, in portrait and in landscape', () => {
    // clockwise as seen by the player: the right edge goes down (gamma > 0)
    const ref = yoke(UPRIGHT);
    expect(yokeInput(yoke({ a: 0, b: 70, g: 60 }), ref).x).toBeGreaterThan(0.3);
    expect(yokeInput(yoke({ a: 0, b: 70, g: -60 }), ref).x).toBeLessThan(-0.3);
    // landscape works too: any turn in the screen plane registers
    const land = yoke({ a: 0, b: 0, g: -80 });
    const turned = yoke({ a: 0, b: 15, g: -78 });
    expect(Math.abs(yokeInput(turned, land).x)).toBeGreaterThan(0.2);
  });

  it('climbs when the top edge comes back toward you and dives when pushed away', () => {
    const ref = yoke(UPRIGHT);
    // top edge back toward the player: the screen starts to face down (beta past 90)
    expect(yokeInput(yoke({ a: 0, b: 110, g: 0 }), ref).y).toBeGreaterThan(0.5);
    expect(yokeInput(yoke({ a: 0, b: 70, g: 0 }), ref).y).toBeLessThan(-0.5);
    expect(yokeInput(yoke({ a: 0, b: 110, g: 0 }), ref, 1, true).y).toBeLessThan(-0.5);
  });

  it('saturates at full deflection', () => {
    const ref = yoke(UPRIGHT);
    expect(yokeInput(yoke({ a: 0, b: 140, g: 0 }), ref).y).toBe(1);
  });
});

describe('course', () => {
  it('keeps every ring inside the box and within reach of the last one', () => {
    for (const seed of [1, 2, 3]) {
      const rng = mulberry32(seed);
      let prev: Ring = { x: 0, y: 0, z: 40, r: 1.5, gold: false };
      let dist = 0;
      for (let n = 0; n < 300; n++) {
        const speed = forwardSpeed(dist);
        const r = nextRing(prev, n, speed, rng);
        const t = (r.z - prev.z) / speed;
        expect(Math.abs(r.x - prev.x)).toBeLessThanOrEqual(PLANE_VX * t * 0.6 + 1e-9);
        expect(Math.abs(r.y - prev.y)).toBeLessThanOrEqual(PLANE_VY * t * 0.6 + 1e-9);
        expect(Math.abs(r.x) + r.r * 0.6).toBeLessThanOrEqual(X_RANGE + 1e-9);
        expect(Math.abs(r.y) + r.r * 0.6).toBeLessThanOrEqual(Y_RANGE + 1e-9);
        expect(r.r).toBeGreaterThan(0.7);
        dist += r.z - prev.z;
        prev = r;
      }
    }
  });

  it('gets faster and tighter as you go', () => {
    expect(forwardSpeed(3000)).toBeGreaterThan(forwardSpeed(0));
    const rng = () => 0.5;
    const early = nextRing({ x: 0, y: 0, z: 0 }, 1, 18, rng);
    const late = nextRing({ x: 0, y: 0, z: 0 }, 80, 30, rng);
    expect(late.z).toBeLessThan(early.z);
    expect(late.r).toBeLessThan(early.r);
  });

  it('judges the centre, the ring and outside it', () => {
    const ring: Ring = { x: 1, y: 1, z: 0, r: 1.5, gold: false };
    expect(judge(ring, 1.2, 1)).toBe('bull');
    expect(judge(ring, 2, 1.5)).toBe('pass');
    expect(judge(ring, 3, 1)).toBe('miss');
  });
});
