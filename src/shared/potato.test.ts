import { describe, expect, it } from 'vitest';
import { mulberry32 } from './marble';
import { burnt, FLICK_MS2, FlickDetector, FLIGHT, LIVES, MIN_HOLD, newGame, nextAlive, nextRound, pass, step, type Potato } from './potato';

const players = (n: number) => Array.from({ length: n }, (_, i) => ({ pid: `p${i}`, name: `P${i}` }));

/** A game with player `holder` holding, ready to throw, and `fuse` seconds left. */
function game(n: number, holder = 0, fuse = 20): Potato {
  const s = newGame(players(n), mulberry32(1));
  s.holder = holder;
  s.held = MIN_HOLD;
  s.fuse = fuse;
  s.fuseTotal = fuse;
  return s;
}

/** Run the game for `secs` seconds in small steps, collecting events. */
function run(s: Potato, secs: number) {
  const ev = [];
  for (let t = 0; t < secs; t += 0.01) ev.push(...step(s, 0.01));
  return ev;
}

describe('passing', () => {
  it('throws to the right or left neighbour, round the circle', () => {
    const s = game(4, 0);
    expect(pass(s, 0, 1)).toBeNull();
    expect(s.holder).toBe(1);
    run(s, FLIGHT + MIN_HOLD + 0.05);
    expect(pass(s, 1, -1)).toBeNull();
    expect(s.holder).toBe(0);
    run(s, FLIGHT + MIN_HOLD + 0.05);
    expect(pass(s, 0, -1)).toBeNull();
    expect(s.holder).toBe(3);
  });

  it('refuses a throw by someone else, while flying, or straight after a catch', () => {
    const s = game(3, 0);
    expect(pass(s, 1, 1)).toBe('You do not have the potato');
    pass(s, 0, 1);
    expect(pass(s, 1, 1)).toBe('It is already flying');
    run(s, FLIGHT + 0.01);
    expect(pass(s, 1, 1)).toMatch(/Too quick/);
    run(s, MIN_HOLD);
    expect(pass(s, 1, 1)).toBeNull();
  });

  it('skips players who are out', () => {
    const s = game(4, 0);
    s.players[1].lives = 0;
    expect(nextAlive(s, 0, 1)).toBe(2);
    s.players[3].lives = 0;
    expect(nextAlive(s, 0, -1)).toBe(2);
  });
});

describe('the fuse', () => {
  it('goes off on the holder, who loses a life', () => {
    const s = game(3, 2, 1);
    const ev = run(s, 1.1);
    expect(ev).toContainEqual({ type: 'boom', victim: 2, out: false });
    expect(s.players[2].lives).toBe(LIVES - 1);
    expect(run(s, 2)).toEqual([]); // and only once: it waits for the next round
    expect(s.players[2].lives).toBe(LIVES - 1);
  });

  it('goes off on the catcher if it runs out mid-air', () => {
    const s = game(3, 0, 0.2);
    pass(s, 0, 1);
    const ev = run(s, 0.3);
    expect(ev.find((e) => e.type === 'boom')).toBeUndefined(); // still in the air
    const later = run(s, FLIGHT);
    expect(later).toContainEqual({ type: 'land', to: 1 });
    expect(later).toContainEqual({ type: 'boom', victim: 1, out: false });
  });

  it('knocks a player out on their last life and ends with one left', () => {
    const s = game(2, 0, 0.5);
    s.players[0].lives = 1;
    const ev = run(s, 0.6);
    expect(ev).toContainEqual({ type: 'boom', victim: 0, out: true });
    expect(ev).toContainEqual({ type: 'win', winner: 1 });
    expect(s.winner).toBe(1);
    expect(pass(s, 1, 1)).toBe('The game is over');
  });

  it('starts the next round with a fresh fuse, passing over a knocked-out holder', () => {
    const s = game(3, 1, 0.1);
    s.players[1].lives = 1;
    run(s, 0.2);
    nextRound(s, mulberry32(3));
    expect(s.holder).toBe(2);
    expect(s.fuse).toBeGreaterThan(10);
    expect(burnt(s)).toBe(0);
    expect(pass(s, 2, 1)).toBeNull();
  });

  it('fuses vary between games', () => {
    const rng = mulberry32(5);
    const fuses = new Set(Array.from({ length: 10 }, () => Math.round(newGame(players(3), rng).fuse)));
    expect(fuses.size).toBeGreaterThan(3);
  });
});

describe('FlickDetector', () => {
  /** Feed a series of x accelerations at 60 Hz on top of a tilt (gravity share). */
  function feed(d: FlickDetector, xs: number[], tilt = 3, t0 = 0) {
    const out: (1 | -1)[] = [];
    xs.forEach((x, i) => {
      const r = d.push(tilt + x, t0 + i * 16);
      if (r) out.push(r);
    });
    return out;
  }
  const still = (n: number) => new Array(n).fill(0);
  const flick = (dir: 1 | -1) => [0.6, 1.2, 1.4, 0.4, -0.9, -1.3, -0.6].map((k) => k * dir * FLICK_MS2 * 1.1);

  it('ignores holding still and slow tilting', () => {
    const d = new FlickDetector();
    expect(feed(d, still(60))).toEqual([]);
    expect(feed(d, Array.from({ length: 120 }, (_, i) => i * 0.05), 3, 1000)).toEqual([]);
  });

  it('reads the direction of a flick from its first push', () => {
    const d = new FlickDetector();
    expect(feed(d, [...still(30), ...flick(1), ...still(30)])).toEqual([1]);
    expect(feed(d, [...still(30), ...flick(-1), ...still(30)], 3, 5000)).toEqual([-1]);
  });

  it('fires once per flick, and a harder setting catches gentler flicks', () => {
    const gentle = flick(1).map((x) => x * 0.6);
    expect(feed(new FlickDetector(), [...still(30), ...gentle, ...still(30)])).toEqual([]);
    const d = new FlickDetector();
    d.sens = 2;
    expect(feed(d, [...still(30), ...gentle, ...still(30)])).toEqual([1]);
  });
});
