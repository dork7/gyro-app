import { describe, expect, it } from 'vitest';
import { aim, PointerMapper, steerValue, wheelAngle, wrap180 } from './pointer';

describe('wrap180', () => {
  it('wraps into -180..180', () => {
    expect(wrap180(190)).toBeCloseTo(-170);
    expect(wrap180(-190)).toBeCloseTo(170);
    expect(wrap180(360)).toBeCloseTo(0);
  });
});

describe('aim', () => {
  it('is zero when flat and facing north', () => {
    const r = aim({ a: 0, b: 0 });
    expect(r.yaw).toBeCloseTo(0);
    expect(r.pitch).toBeCloseTo(0);
  });
  it('turning right (alpha decreasing) increases yaw', () => {
    expect(aim({ a: -30, b: 0 }).yaw).toBeCloseTo(30);
    expect(aim({ a: 330, b: 0 }).yaw).toBeCloseTo(30);
  });
  it('tipping the top edge up increases pitch', () => {
    expect(aim({ a: 0, b: 20 }).pitch).toBeCloseTo(20);
  });
  it('ignores gamma (twist around the top edge)', () => {
    const r1 = aim({ a: 10, b: 15, g: 0 });
    const r2 = aim({ a: 10, b: 15, g: 60 });
    expect(r1.yaw).toBeCloseTo(r2.yaw);
    expect(r1.pitch).toBeCloseTo(r2.pitch);
  });
});

describe('PointerMapper', () => {
  it('puts the centre pose in the middle of the screen', () => {
    const m = new PointerMapper();
    m.setCenter(aim({ a: 100, b: 10 }));
    const p = m.map(aim({ a: 100, b: 10 }), 1000, 600);
    expect(p.x).toBeCloseTo(500);
    expect(p.y).toBeCloseTo(300);
  });
  it('moves right and up for right/up movement', () => {
    const m = new PointerMapper();
    m.setCenter(aim({ a: 0, b: 0 }));
    const p = m.map(aim({ a: -10, b: 6 }), 1000, 600);
    expect(p.x).toBeGreaterThan(500);
    expect(p.y).toBeLessThan(300);
  });
  it('clamps to the screen and handles the 0/360 seam', () => {
    const m = new PointerMapper();
    m.setCenter(aim({ a: 358, b: 0 }));
    const p = m.map(aim({ a: 2, b: 0 }), 1000, 600); // 4 degrees to the left across the seam
    expect(p.x).toBeLessThan(500);
    const far = m.map(aim({ a: 270, b: 80 }), 1000, 600);
    expect(far.x).toBeGreaterThanOrEqual(0);
    expect(far.x).toBeLessThanOrEqual(1000);
    expect(far.y).toBe(0);
  });
  it('higher sensitivity moves further for the same wrist movement', () => {
    const m = new PointerMapper();
    m.setCenter(aim({ a: 0, b: 0 }));
    const lo = m.map(aim({ a: -5, b: 0 }), 1000, 600, 1);
    const hi = m.map(aim({ a: -5, b: 0 }), 1000, 600, 2);
    expect(hi.x).toBeGreaterThan(lo.x);
  });
});

describe('wheelAngle / steerValue', () => {
  it('portrait upright reads 90 degrees', () => {
    expect(wheelAngle({ a: 0, b: 60, g: 0 })).toBeCloseTo(90);
  });
  it('rolling clockwise (right edge down, gamma > 0) increases the angle', () => {
    expect(wheelAngle({ a: 0, b: 60, g: 20 })).toBeGreaterThan(90);
    expect(wheelAngle({ a: 0, b: 60, g: -20 })).toBeLessThan(90);
  });
  it('is zero at neutral and steers right for clockwise rotation', () => {
    expect(steerValue(0)).toBe(0);
    expect(steerValue(1)).toBe(0); // inside the dead zone
    expect(steerValue(20)).toBeGreaterThan(0);
    expect(steerValue(-20)).toBeLessThan(0);
    expect(steerValue(20)).toBeCloseTo(-steerValue(-20));
  });
  it('saturates at full lock and respects sensitivity', () => {
    expect(steerValue(90)).toBe(1);
    expect(steerValue(-90)).toBe(-1);
    expect(steerValue(15, 2)).toBeGreaterThan(steerValue(15, 1));
  });
  it('handles the 180 degree seam', () => {
    expect(steerValue(wrap180(175 - -175))).toBeLessThan(0.5); // 350 degrees apart = -10 degrees
  });
});
