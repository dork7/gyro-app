import { describe, expect, it } from 'vitest';
import { makeLevel, makeMaze, MARBLE_R, mulberry32, neighbours, slope, solve, stepMarble, tiltInput, wallRects, type Marble } from './marble';

describe('slope', () => {
  it('is zero when the phone lies flat', () => {
    const s = slope({ a: 0, b: 0, g: 0 });
    expect(s.x).toBeCloseTo(0, 6);
    expect(s.y).toBeCloseTo(0, 6);
  });

  it('rolls right when the right edge dips and down the screen when the top edge lifts', () => {
    expect(slope({ a: 0, b: 0, g: 15 }).x).toBeGreaterThan(0.2);
    expect(slope({ a: 0, b: 15, g: 0 }).y).toBeGreaterThan(0.2);
    expect(slope({ a: 0, b: -15, g: -15 }).x).toBeLessThan(-0.2);
    expect(slope({ a: 0, b: -15, g: -15 }).y).toBeLessThan(-0.2);
  });
});

describe('tiltInput', () => {
  const flat = { x: 0, y: 0 };
  it('ignores tiny wobbles and saturates at full tilt', () => {
    expect(tiltInput(slope({ a: 0, b: 0.5, g: 0.5 }), flat)).toEqual({ x: 0, y: 0 });
    expect(tiltInput(slope({ a: 0, b: 40, g: -40 }), flat)).toEqual({ x: -1, y: 1 });
  });

  it('is relative to the level pose and scales with sensitivity', () => {
    const ref = slope({ a: 0, b: 10, g: 0 });
    expect(tiltInput(ref, ref).y).toBe(0);
    const s = slope({ a: 0, b: 15, g: 0 });
    expect(tiltInput(s, ref, 2).y).toBeGreaterThan(tiltInput(s, ref, 1).y);
  });
});

describe('makeMaze', () => {
  it('is a perfect maze: every cell reachable, no loops', () => {
    for (const seed of [1, 2, 3, 99]) {
      const m = makeMaze(9, 6, mulberry32(seed));
      const seen = new Set([0]);
      const queue = [0];
      let edges = 0;
      while (queue.length) {
        const i = queue.shift()!;
        for (const j of neighbours(m, i)) {
          edges++;
          if (!seen.has(j)) {
            seen.add(j);
            queue.push(j);
          }
        }
      }
      expect(seen.size).toBe(54);
      expect(edges / 2).toBe(53);
    }
  });

  it('solves from start to goal through open passages', () => {
    const m = makeMaze(8, 5, mulberry32(7));
    const path = solve(m, 0, 39);
    expect(path[0]).toBe(0);
    expect(path[path.length - 1]).toBe(39);
    for (let k = 1; k < path.length; k++) expect(neighbours(m, path[k - 1])).toContain(path[k]);
  });
});

describe('makeLevel', () => {
  it('never puts a hole on the route, and gems never on holes', () => {
    for (let level = 1; level <= 8; level++) {
      const L = makeLevel(level, 1000 + level);
      const route = new Set(L.path);
      expect(L.holes.length).toBeGreaterThan(0);
      for (const h of L.holes) expect(route.has(h)).toBe(false);
      for (const g of L.gems) {
        expect(L.holes).not.toContain(g);
        expect(g).not.toBe(L.start);
        expect(g).not.toBe(L.goal);
      }
    }
  });

  it('grows with the level and stays the same for the same seed', () => {
    expect(makeLevel(5, 1).maze.rows).toBeGreaterThan(makeLevel(1, 1).maze.rows);
    expect(makeLevel(3, 42)).toEqual(makeLevel(3, 42));
  });
});

describe('stepMarble', () => {
  it('rolls with the tilt on an open floor', () => {
    const m: Marble = { p: { x: 5, y: 5 }, v: { x: 0, y: 0 } };
    for (let i = 0; i < 30; i++) stepMarble(m, { x: 1, y: 0 }, 1 / 60, []);
    expect(m.p.x).toBeGreaterThan(5.5);
    expect(m.p.y).toBeCloseTo(5, 6);
  });

  it('never passes through a wall, even at full tilt and with big steps', () => {
    const maze = makeMaze(6, 4, mulberry32(3));
    const rects = wallRects(maze);
    const m: Marble = { p: { x: 0.5, y: 0.5 }, v: { x: 0, y: 0 } };
    let cell = 0;
    for (let i = 0; i < 600; i++) {
      const push = { x: Math.sin(i / 40), y: Math.cos(i / 23) };
      const hit = stepMarble(m, push, i % 2 ? 1 / 20 : 1 / 120, rects);
      expect(hit).toBeGreaterThanOrEqual(0);
      expect(m.p.x).toBeGreaterThan(MARBLE_R - 1e-6);
      expect(m.p.y).toBeGreaterThan(MARBLE_R - 1e-6);
      expect(m.p.x).toBeLessThan(6 - MARBLE_R + 1e-6);
      expect(m.p.y).toBeLessThan(4 - MARBLE_R + 1e-6);
      // moving to another cell must go through an open passage
      const now = Math.floor(m.p.y) * 6 + Math.floor(m.p.x);
      if (now !== cell) {
        expect([cell, ...neighbours(maze, cell)]).toContain(now);
        cell = now;
      }
    }
  });
});
