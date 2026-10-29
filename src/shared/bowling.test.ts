import { describe, expect, it } from 'vitest';
import { frames, HEAD_Z, LANE_W, laneSettled, launch, marks, rack, stepLane, ThrowTracker, totals, type Throw } from './bowling';

describe('scoring', () => {
  it('scores a perfect game as 300', () => {
    const rolls = new Array(12).fill(10);
    expect(totals(rolls)[9]).toBe(300);
    expect(frames(rolls).done).toBe(true);
    expect(marks(rolls)[9]).toEqual(['X', 'X', 'X']);
  });

  it('scores all spares of 5 as 150, and all nines as 90', () => {
    expect(totals(new Array(21).fill(5))[9]).toBe(150);
    expect(totals(new Array(20).fill(0).map((_, i) => (i % 2 ? 0 : 9)))[9]).toBe(90);
  });

  it('adds strike and spare bonuses once the next balls are known', () => {
    expect(totals([10, 3])).toEqual([null]);
    expect(totals([10, 3, 4])).toEqual([17, 24]);
    expect(totals([7, 3, 5, 2])).toEqual([15, 22]);
    expect(totals([7, 3])).toEqual([null]);
  });

  it('knows what is standing and which frame is next', () => {
    expect(frames([])).toMatchObject({ frame: 0, standing: 10, fresh: true });
    expect(frames([7])).toMatchObject({ frame: 0, standing: 3, fresh: false });
    expect(frames([7, 2])).toMatchObject({ frame: 1, standing: 10, fresh: true });
    expect(frames([10])).toMatchObject({ frame: 1, standing: 10, fresh: true });
  });

  it('handles the tenth frame: bonus balls only after a strike or spare', () => {
    const nine = new Array(18).fill(0);
    expect(frames([...nine, 3, 4]).done).toBe(true);
    expect(frames([...nine, 3, 7])).toMatchObject({ done: false, standing: 10, fresh: true });
    expect(frames([...nine, 10])).toMatchObject({ done: false, standing: 10, fresh: true });
    expect(frames([...nine, 10, 6])).toMatchObject({ done: false, standing: 4, fresh: false });
    expect(frames([...nine, 10, 6, 4]).done).toBe(true);
    expect(totals([...nine, 10, 6, 4])[9]).toBe(20);
  });

  it('writes the score sheet marks', () => {
    expect(marks([10, 7, 3, 0, 5])).toEqual([['X'], ['7', '/'], ['-', '5']]);
    const nine = new Array(18).fill(0);
    expect(marks([...nine, 9, 1, 10])[9]).toEqual(['9', '/', 'X']);
  });
});

describe('the lane', () => {
  /** Roll a ball and let everything come to rest; returns how many pins went down. */
  function roll(x: number, t: Throw): { down: number; gutter: boolean } {
    const pins = rack();
    const ball = launch(x, t);
    for (let i = 0; i < 2000 && !laneSettled(ball, pins); i++) stepLane(ball, pins, 1 / 60);
    return { down: pins.filter((p) => !p.up).length, gutter: ball.gutter };
  }

  it('racks ten pins in a triangle behind the head pin', () => {
    const pins = rack();
    expect(pins).toHaveLength(10);
    expect(pins[0]).toMatchObject({ n: 1, x: 0, z: HEAD_Z });
    expect(Math.max(...pins.map((p) => p.z))).toBeGreaterThan(HEAD_Z + 0.7);
  });

  it('a fast ball into the pocket knocks most pins down', () => {
    const r = roll(0.06, { speed: 8, angle: 0, hook: 0 });
    expect(r.gutter).toBe(false);
    expect(r.down).toBeGreaterThanOrEqual(7);
  });

  it('a ball down the edge clips a few pins; one off the lane goes in the gutter', () => {
    const edge = roll(0.42, { speed: 7, angle: 0, hook: 0 });
    expect(edge.down).toBeGreaterThan(0);
    expect(edge.down).toBeLessThan(6);
    const gutter = roll(0.2, { speed: 7, angle: 0.05, hook: 0 });
    expect(gutter.gutter).toBe(true);
    expect(gutter.down).toBe(0);
  });

  it('hook bends the ball after the skid', () => {
    const ball = launch(-0.3, { speed: 7, angle: 0, hook: 1 });
    const pins = rack();
    for (let i = 0; i < 300 && ball.z < HEAD_Z - 1; i++) stepLane(ball, pins, 1 / 60);
    expect(ball.x).toBeGreaterThan(-0.3 + 0.1);
    expect(Math.abs(ball.x)).toBeLessThan(LANE_W / 2);
  });
});

describe('ThrowTracker', () => {
  /** A swing at `dps` deg/s that lets go 30° above level, with optional yaw and roll rates. */
  function swing(dps: number, yawDps = 0, rollDps = 0, sens = 1): Throw | null {
    const tr = new ThrowTracker();
    tr.sens = sens;
    for (let t = 0; t <= 400; t += 16) tr.push(30 - (dps * (400 - t)) / 1000, (yawDps * t) / 1000, (rollDps * t) / 1000, t);
    return tr.release(400);
  }

  it('needs a real swing', () => {
    expect(swing(40)).toBeNull();
    expect(swing(300)).not.toBeNull();
  });

  it('a faster arm gives a faster ball, within limits', () => {
    expect(swing(600)!.speed).toBeGreaterThan(swing(250)!.speed);
    expect(swing(5000)!.speed).toBeLessThanOrEqual(10);
    expect(swing(130)!.speed).toBeGreaterThanOrEqual(3);
  });

  it('sideways swing aims it and a wrist twist hooks it', () => {
    expect(swing(500, 120)!.angle).toBeGreaterThan(0);
    expect(swing(500, -120)!.angle).toBeLessThan(0);
    expect(swing(500, 0, 400)!.hook).toBeGreaterThan(0.3);
    expect(swing(500)!.hook).toBe(0);
  });

  it('ignores the heading flip when the phone passes straight up or down', () => {
    const tr = new ThrowTracker();
    // pitch sweeps past 90°, where the heading of the top edge jumps by 180°
    for (let t = 0; t <= 400; t += 16) {
      const pitch = -60 + (450 * t) / 1000;
      tr.push(pitch, pitch > 90 ? 180 : 0, 0, t);
    }
    expect(tr.release(400)!.angle).toBe(0);
  });

  it('a lighter setting turns a gentle swing into a proper throw', () => {
    expect(swing(80)).toBeNull();
    expect(swing(80, 0, 0, 2)).not.toBeNull();
  });
});
