import { describe, expect, it } from 'vitest';
import { mulberry32 } from './marble';
import { angleOf, bigChance, cannonAngle, dirOf, heading, inArc, meteorSpeed, spawnAngle, spawnGap, turnToward } from './orbit';

describe('heading / cannonAngle', () => {
  it('turns clockwise when the flat phone is twisted clockwise', () => {
    // seen from above, clockwise means alpha goes down
    const ref = heading({ a: 40, b: 0, g: 0 });
    expect(cannonAngle(heading({ a: 40, b: 0, g: 0 }), ref)).toBeCloseTo(0, 6);
    expect(cannonAngle(heading({ a: 20, b: 0, g: 0 }), ref)).toBeCloseTo(40, 6);
    expect(cannonAngle(heading({ a: 60, b: 0, g: 0 }), ref)).toBeCloseTo(-40, 6);
  });

  it('reaches the whole circle with a quarter turn each way', () => {
    const ref = heading({ a: 0, b: 0, g: 0 });
    expect(Math.abs(cannonAngle(heading({ a: -90, b: 0, g: 0 }), ref))).toBeCloseTo(180, 6);
    expect(Math.abs(cannonAngle(heading({ a: 90, b: 0, g: 0 }), ref))).toBeCloseTo(180, 6);
  });

  it('keeps working across the 0/360 seam of alpha', () => {
    const ref = heading({ a: 355, b: 0, g: 0 });
    expect(cannonAngle(heading({ a: 5, b: 0, g: 0 }), ref)).toBeCloseTo(-20, 6);
  });

  it('works with the phone tilted up a little', () => {
    const ref = heading({ a: 0, b: 20, g: 0 });
    expect(cannonAngle(heading({ a: -30, b: 20, g: 0 }), ref)).toBeGreaterThan(40);
  });
});

describe('angles', () => {
  it('converts between angles and screen directions', () => {
    expect(dirOf(0).y).toBeCloseTo(-1);
    expect(dirOf(90).x).toBeCloseTo(1);
    expect(angleOf(1, 0)).toBeCloseTo(90);
    expect(angleOf(0, 1)).toBeCloseTo(180);
    for (const a of [-170, -45, 0, 30, 135]) {
      const d = dirOf(a);
      expect(angleOf(d.x, d.y)).toBeCloseTo(a);
    }
  });

  it('tests arcs across the ±180 seam', () => {
    expect(inArc(175, -175, 30)).toBe(true);
    expect(inArc(140, -175, 30)).toBe(false);
    expect(inArc(10, 0, 70)).toBe(true);
  });

  it('turns the short way round without overshooting', () => {
    expect(turnToward(170, -170, 5)).toBeCloseTo(175);
    expect(turnToward(10, 12, 5)).toBeCloseTo(12);
  });
});

describe('storm pacing', () => {
  it('gets busier and faster, with limits', () => {
    expect(spawnGap(60)).toBeLessThan(spawnGap(0));
    expect(spawnGap(1e4)).toBeGreaterThan(0.3);
    expect(meteorSpeed(60)).toBeGreaterThan(meteorSpeed(0));
    expect(meteorSpeed(1e4)).toBeLessThan(0.5);
    expect(bigChance(5)).toBe(0);
    expect(bigChance(1e4)).toBeLessThanOrEqual(0.3);
  });

  it('spreads meteors around the circle', () => {
    const rng = mulberry32(5);
    let prev: number | null = null;
    for (let i = 0; i < 200; i++) {
      const a = spawnAngle(prev, rng);
      if (prev !== null) expect(Math.abs(((a - prev + 540) % 360) - 180)).toBeGreaterThanOrEqual(50);
      prev = a;
    }
  });
});
