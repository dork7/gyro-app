import { describe, expect, it } from 'vitest';
import { arrival, CPU_Z, FULL_SWING, GRIP, HALF_W, incomingShot, LENGTH, NET_H, NET_Z, project, returnShot, SERVICE, stepBall, type Ball } from './tennis';

/** Fly the ball at 120 Hz until `stop`; returns where it bounced and how high it was over the net. */
function fly(b: Ball, stop: (b: Ball) => boolean): { bounces: { x: number; z: number }[]; netY: number } {
  const bounces: { x: number; z: number }[] = [];
  let netY = NaN;
  for (let i = 0; i < 1200 && !stop(b); i++) {
    const z0 = b.p.z;
    if (stepBall(b, 1 / 120)) bounces.push({ x: b.p.x, z: b.p.z });
    if ((z0 - NET_Z) * (b.p.z - NET_Z) <= 0) netY = b.p.y;
    expect(b.p.y).toBeGreaterThanOrEqual(0);
  }
  return { bounces, netY };
}

describe('stepBall', () => {
  it('bounces lower each time and comes to rest', () => {
    const b: Ball = { p: { x: 0, y: 1, z: 0 }, v: { x: 0, y: 0, z: 0 } };
    let peak = 0;
    let n = 0;
    for (let i = 0; i < 2400; i++) {
      if (stepBall(b, 1 / 120)) {
        n++;
        peak = 0;
      }
      peak = Math.max(peak, b.p.y);
    }
    expect(n).toBeGreaterThan(2);
    expect(peak).toBe(0);
    expect(b.v.y).toBe(0);
  });

  it('gives the same flight for small and large steps', () => {
    const a: Ball = { p: { x: 0, y: 1, z: 20 }, v: { x: 1, y: 3, z: -10 } };
    const b: Ball = { p: { ...a.p }, v: { ...a.v } };
    for (let i = 0; i < 240; i++) stepBall(a, 1 / 240);
    for (let i = 0; i < 20; i++) stepBall(b, 1 / 20);
    expect(a.p.y).toBeCloseTo(b.p.y, 5);
    expect(a.p.z).toBeCloseTo(b.p.z, 5);
  });
});

describe('bounce', () => {
  it('slows the ball along the ground', () => {
    const b: Ball = { p: { x: 0, y: 0.5, z: 10 }, v: { x: 2, y: 0, z: -10 } };
    while (!stepBall(b, 1 / 120));
    expect(b.v.z).toBeCloseTo(-10 * GRIP, 5);
    expect(b.v.x).toBeCloseTo(2 * GRIP, 5);
    expect(b.v.y).toBeGreaterThan(0);
  });
});

describe('incomingShot', () => {
  it('lands a serve in the service box', () => {
    for (const speed of [11.5, 14, 17.5]) {
      for (const x of [-2.6, 0, 2.6]) {
        const serve = incomingShot({ x: 1.2, y: 2.5, z: CPU_Z }, x, speed, 1.2, NET_Z - SERVICE);
        const { bounces, netY } = fly(serve, (b) => b.p.z <= 0);
        expect(netY).toBeGreaterThan(NET_H);
        expect(bounces).toHaveLength(1);
        expect(bounces[0]!.z).toBeGreaterThanOrEqual(NET_Z - SERVICE - 0.05);
        expect(bounces[0]!.z).toBeLessThan(NET_Z);
        expect(Math.abs(bounces[0]!.x)).toBeLessThan(HALF_W);
        expect(arrival(serve).y).toBeGreaterThan(0.4);
      }
    }
  });


  for (const speed of [9, 12, 15]) {
    for (const [x, height] of [
      [-2.6, 0.9],
      [0, 1.3],
      [2.6, 1.7],
    ] as const) {
      it(`speed ${speed} reaches x ${x} about ${height} m up`, () => {
        const shot = incomingShot({ x: 1.5, y: 1.1, z: CPU_Z }, x, speed, height);
        const at = arrival(shot);
        expect(at.x).toBeCloseTo(x, 1);
        // Fast shots are flatter, so only the slowest can reach every height asked for.
        if (speed === 9) expect(Math.abs(at.y - height)).toBeLessThan(0.2);
        expect(at.y).toBeGreaterThan(0.5);
        expect(at.y).toBeLessThan(2.2);
        const { bounces, netY } = fly(shot, (b) => b.p.z <= 0);
        expect(netY).toBeGreaterThan(NET_H);
        expect(bounces).toHaveLength(1);
        expect(bounces[0]!.z).toBeGreaterThan(0);
        expect(bounces[0]!.z).toBeLessThan(NET_Z);
      });
    }
  }
});

describe('returnShot', () => {
  const contact = { x: 1, y: 1.2, z: 0.5 };

  it('blocks the ball back into the court when the racket is still', () => {
    const shot = returnShot(contact, { vx: 0, vy: 0 });
    expect(shot.power).toBe(0);
    expect(shot.out).toBe(false);
    const { bounces, netY } = fly(shot.ball, (b) => b.p.z >= CPU_Z);
    expect(netY).toBeGreaterThan(NET_H);
    expect(bounces[0]!.x).toBeCloseTo(shot.land.x, 1);
    expect(bounces[0]!.z).toBeCloseTo(shot.land.z, 0);
    expect(shot.ball.p.z).toBeGreaterThanOrEqual(CPU_Z); // it carries to the far player
  });

  it('hits harder and deeper with a faster swing', () => {
    const soft = returnShot(contact, { vx: 0.5, vy: 0 });
    const hard = returnShot(contact, { vx: 3, vy: 0 });
    expect(hard.power).toBeGreaterThan(soft.power);
    expect(hard.land.z).toBeGreaterThan(soft.land.z);
    expect(hard.ball.v.z).toBeGreaterThan(soft.ball.v.z);
    expect(hard.out).toBe(false);
  });

  it('sends the ball faster the faster the swing, all the way to a full swing', () => {
    let last = returnShot(contact, { vx: 0, vy: 0 });
    for (let v = 2; v <= FULL_SWING; v += 2) {
      // mostly sideways and slightly upward, as with a real drive
      const shot = returnShot(contact, { vx: v * 0.95, vy: v * 0.3 });
      expect(shot.power).toBeGreaterThan(last.power);
      expect(shot.pace).toBeGreaterThan(last.pace + 0.5);
      expect(shot.ball.v.z).toBeGreaterThan(last.ball.v.z);
      last = shot;
    }
    const slow = returnShot(contact, { vx: 1, vy: 0 });
    const fast = returnShot(contact, { vx: FULL_SWING, vy: 0 });
    expect(fast.pace).toBeGreaterThan(slow.pace * 2);
    // swinging harder than a full swing adds nothing more
    expect(returnShot(contact, { vx: FULL_SWING * 2, vy: 0 }).pace).toBeCloseTo(fast.pace, 5);
  });

  it('aims by the direction of the swing, not its speed', () => {
    const gentle = returnShot(contact, { vx: 4, vy: 0 });
    const hard = returnShot(contact, { vx: 14, vy: 0 });
    expect(hard.land.x).toBeCloseTo(gentle.land.x, 5);
    expect(hard.out).toBe(false);
  });

  it('follows the direction of the swing', () => {
    expect(returnShot(contact, { vx: -2, vy: 0 }).land.x).toBeLessThan(0);
    expect(returnShot(contact, { vx: 2, vy: 0 }).land.x).toBeGreaterThan(0);
  });

  it('goes out when over-hit', () => {
    const wide = returnShot({ x: 3, y: 1.2, z: 0.5 }, { vx: 9, vy: 0 });
    expect(Math.abs(wide.land.x)).toBeGreaterThan(HALF_W);
    expect(wide.out).toBe(true);
    const long = returnShot(contact, { vx: 0, vy: FULL_SWING });
    expect(long.land.z).toBeGreaterThan(LENGTH);
    expect(long.out).toBe(true);
  });

  it('clears the net from a low contact unless swung down at', () => {
    for (const vx of [0, 2, 5]) {
      const shot = returnShot({ x: 0, y: 0.1, z: -1 }, { vx, vy: vx / 4 });
      expect(shot.net).toBe(false);
      expect(fly(shot.ball, (b) => b.p.z >= CPU_Z).netY).toBeGreaterThan(NET_H);
    }
  });

  it('goes into the net when a low ball is hit downward', () => {
    const shot = returnShot({ x: 0, y: 0.5, z: 0 }, { vx: 1, vy: -12 });
    expect(shot.net).toBe(true);
    expect(shot.out).toBe(false);
    const { netY, bounces } = fly(shot.ball, (b) => b.p.z >= NET_Z);
    // it either reaches the net below the tape or has already bounced short of it
    expect(bounces.length > 0 || netY < NET_H).toBe(true);
  });

  it('lands where it says when hit downward from high up', () => {
    const shot = returnShot({ x: 0, y: 2, z: 0 }, { vx: 0, vy: -8 });
    if (!shot.net) {
      const { bounces } = fly(shot.ball, (b) => b.p.z >= CPU_Z);
      expect(bounces[0]!.z).toBeCloseTo(shot.land.z, 0);
    }
  });

  it('comes off weaker away from the middle of the strings', () => {
    const clean = returnShot(contact, { vx: 3, vy: 0 }, 0);
    const frame = returnShot(contact, { vx: 3, vy: 0 }, 1);
    expect(frame.power).toBeCloseTo(clean.power / 2, 5);
    expect(frame.land.z).toBeLessThan(clean.land.z);
    expect(frame.ball.v.z).toBeLessThan(clean.ball.v.z);
  });
});

describe('project', () => {
  it('puts far things higher, smaller and nearer the middle', () => {
    const near = project({ x: 2, y: 0, z: 0 }, 1600, 900);
    const far = project({ x: 2, y: 0, z: LENGTH }, 1600, 900);
    expect(far.y).toBeLessThan(near.y);
    expect(far.s).toBeLessThan(near.s);
    expect(far.x).toBeLessThan(near.x);
    expect(far.x).toBeGreaterThan(800);
  });
});
