import { describe, expect, it } from 'vitest';
import { DUCK_R, escape, flyTime, GRASS_Y, HIT_R, needed, pickKind, points, shoot, spawnDuck, stepDuck, type Duck } from './duck';
import { mulberry32 } from './marble';

const ASPECT = 16 / 9;

describe('flight', () => {
  it('takes off upward from the grass and stays in the sky while flying', () => {
    for (let seed = 0; seed < 20; seed++) {
      const rng = mulberry32(seed);
      const d = spawnDuck(ASPECT, 3, rng);
      expect(d.vy).toBeLessThan(0);
      for (let i = 0; i < 600 && d.state === 'fly'; i++) {
        stepDuck(d, 1 / 120, ASPECT, rng);
        expect(d.x).toBeGreaterThanOrEqual(DUCK_R - 1e-9);
        expect(d.x).toBeLessThanOrEqual(ASPECT - DUCK_R + 1e-9);
        expect(d.y).toBeGreaterThanOrEqual(DUCK_R - 1e-9);
        expect(d.y).toBeLessThanOrEqual(GRASS_Y - DUCK_R + 1e-9);
      }
    }
  });

  it('flies away when its time is up and is then gone', () => {
    const rng = mulberry32(4);
    const d = spawnDuck(ASPECT, 1, rng);
    let t = 0;
    while (d.state === 'fly') {
      stepDuck(d, 1 / 60, ASPECT, rng);
      t += 1 / 60;
    }
    expect(d.state).toBe('escape');
    expect(t).toBeCloseTo(flyTime(1), 1);
    for (let i = 0; i < 600 && d.state !== 'gone'; i++) stepDuck(d, 1 / 60, ASPECT, rng);
    expect(d.state).toBe('gone');
  });
});

describe('shoot', () => {
  const duck = (): Duck => ({ x: 1, y: 0.4, vx: 0.3, vy: -0.2, kind: 'green', state: 'fly', t: 0, turn: 1, speed: 0.36, flyTime: 7 });

  it('hits within the radius and misses outside it', () => {
    expect(shoot(duck(), 1 + HIT_R * 0.9, 0.4)).toBe(true);
    expect(shoot(duck(), 1 + HIT_R * 1.1, 0.4)).toBe(false);
  });

  it('a hit duck hangs, falls into the grass, and cannot be hit twice', () => {
    const d = duck();
    const rng = mulberry32(1);
    expect(shoot(d, 1, 0.4)).toBe(true);
    expect(shoot(d, 1, 0.4)).toBe(false);
    stepDuck(d, 0.2, ASPECT, rng);
    expect(d.state).toBe('hit');
    expect(d.y).toBe(0.4);
    for (let i = 0; i < 200 && d.state !== 'gone'; i++) stepDuck(d, 1 / 60, ASPECT, rng);
    expect(d.state).toBe('gone');
  });

  it('can still hit a duck that is escaping', () => {
    const d = duck();
    escape(d);
    expect(d.state).toBe('escape');
    expect(shoot(d, d.x, d.y)).toBe(true);
  });
});

describe('rounds', () => {
  it('asks for more hits and gives shorter flights as rounds go on', () => {
    expect(needed(1)).toBe(6);
    expect(needed(4)).toBe(9);
    expect(needed(20)).toBe(10);
    expect(flyTime(10)).toBeLessThan(flyTime(1));
    expect(flyTime(100)).toBeGreaterThanOrEqual(4);
  });

  it('pays more for rarer ducks and later rounds', () => {
    expect(points('blue', 1)).toBeGreaterThan(points('green', 1));
    expect(points('gold', 1)).toBeGreaterThan(points('blue', 1));
    expect(points('green', 6)).toBeGreaterThan(points('green', 1));
  });

  it('has no gold ducks in round 1', () => {
    const rng = mulberry32(2);
    for (let i = 0; i < 500; i++) expect(pickKind(1, rng)).not.toBe('gold');
  });
});
