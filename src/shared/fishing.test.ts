import { describe, expect, it } from 'vitest';
import { castDistance, CAST_DPS, FISH, fishPoints, newFight, pickFish, ReelTracker, stepFight, SwingDetector, type FightResult } from './fishing';
import { mulberry32 } from './marble';

/** Feed pitch samples at 60 Hz; returns the swings detected. */
function swings(d: SwingDetector, pitches: number[], t0 = 0) {
  return pitches.map((p, i) => d.push(p, t0 + i * 16)).filter((s) => s !== null);
}
const ramp = (from: number, to: number, n: number) => Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));

describe('SwingDetector', () => {
  it('casts on a forward whip, farther when faster', () => {
    const slowWhip = [...ramp(0, 40, 30), ...ramp(40, -30, 15), ...ramp(-30, -30, 20)];
    const fastWhip = [...ramp(0, 40, 30), ...ramp(40, -30, 7), ...ramp(-30, -30, 20)];
    const a = swings(new SwingDetector(), slowWhip);
    const b = swings(new SwingDetector(), fastWhip);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.type).toBe('cast');
    expect(b[0]!.type).toBe('cast');
    if (a[0]!.type === 'cast' && b[0]!.type === 'cast') expect(b[0]!.power).toBeGreaterThan(a[0]!.power);
  });

  it('ignores slow movements of the rod', () => {
    expect(swings(new SwingDetector(), [...ramp(0, 30, 60), ...ramp(30, -20, 60)])).toEqual([]);
  });

  it('strikes on an upward jerk', () => {
    const s = swings(new SwingDetector(), [...ramp(-10, -10, 20), ...ramp(-10, 25, 8), ...ramp(25, 25, 20)]);
    expect(s).toEqual([{ type: 'strike' }]);
  });

  it('a lighter setting needs less speed', () => {
    const gentle = [...ramp(0, 30, 30), ...ramp(30, -10, 14), ...ramp(-10, -10, 20)];
    expect(swings(new SwingDetector(), gentle).filter((s) => s.type === 'cast')).toHaveLength(0);
    const d = new SwingDetector();
    d.sens = 2;
    expect(swings(d, gentle).filter((s) => s.type === 'cast')).toHaveLength(1);
    expect(CAST_DPS).toBeGreaterThan(0);
  });
});

describe('ReelTracker', () => {
  const run = (pts: [number, number][]) => {
    const r = new ReelTracker(3);
    return pts.reduce((sum, [x, y], i) => sum + r.push(x, y, i * 16), 0);
  };
  const circles = (turns: number, perTurn = 50, radius = 8, dir = 1): [number, number][] =>
    Array.from({ length: Math.round(turns * perTurn) }, (_, i) => {
      const a = (dir * i * 2 * Math.PI) / perTurn;
      return [Math.cos(a) * radius, Math.sin(a) * radius];
    });

  it('counts turns going round, either way', () => {
    expect(run(circles(5))).toBeGreaterThan(3.5);
    expect(run(circles(5))).toBeLessThan(5.5);
    expect(run(circles(5, 50, 8, -1))).toBeGreaterThan(3.5);
  });

  it('does not count shaking along a line or tiny circles', () => {
    const shake = Array.from({ length: 250 }, (_, i): [number, number] => [Math.sin(i * 0.5) * 10, 0]);
    expect(run(shake)).toBeLessThan(0.5);
    expect(run(circles(5, 50, 1))).toBe(0);
  });
});

describe('fish', () => {
  it('only big casts reach the big fish', () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 300; i++) expect(pickFish(0.1, rng).fish.depth).toBeLessThanOrEqual(0.1);
    const deep = new Set(Array.from({ length: 2000 }, () => pickFish(1, rng).fish.name));
    expect(deep.has('Shark')).toBe(true);
  });

  it('weighs each catch inside its range and scores it', () => {
    const rng = mulberry32(8);
    for (let i = 0; i < 200; i++) {
      const { fish, kg } = pickFish(rng(), rng);
      expect(kg).toBeGreaterThanOrEqual(fish.minKg - 0.01);
      expect(kg).toBeLessThanOrEqual(fish.maxKg + 0.01);
      expect(fishPoints(fish, kg)).toBeGreaterThan(0);
    }
    expect(castDistance(1)).toBeGreaterThan(castDistance(0));
  });
});

describe('the fight', () => {
  /** Play a fight with a reeling policy for up to 60 s. */
  function fight(strength: number, policy: (tension: number) => number, seed = 1): FightResult {
    const rng = mulberry32(seed);
    const f = newFight(strength, 20);
    for (let t = 0; t < 60; t += 1 / 30) {
      const r = stepFight(f, 1 / 30, policy(f.tension), rng);
      if (r !== 'on') return r;
    }
    return 'on';
  }
  const careful = (t: number) => (t < 0.65 ? 1.6 : 0); // reel, but ease off when the line is tight

  it('a careful angler lands every kind of fish', () => {
    for (const f of FISH) for (const seed of [1, 2, 3]) expect(fight(f.strength, careful, seed)).toBe('caught');
  });

  it('reeling flat out snaps the line on a strong fish', () => {
    expect(fight(0.95, () => 3)).toBe('snapped');
  });

  it('never reeling lets the fish get away', () => {
    expect(fight(0.5, () => 0)).toBe('escaped');
  });
});
