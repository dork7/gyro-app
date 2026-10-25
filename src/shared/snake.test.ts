import { describe, expect, it } from 'vitest';
import { mulberry32 } from './marble';
import { freeCell, newSnake, START_LEN, step, stepTime, tiltDir, turn, type Snake } from './snake';

describe('tiltDir', () => {
  it('ignores a nearly level phone', () => {
    expect(tiltDir({ x: 0.2, y: -0.3 }, null)).toBeNull();
  });

  it('follows the stronger axis', () => {
    expect(tiltDir({ x: 0.8, y: 0.1 }, null)).toBe('right');
    expect(tiltDir({ x: -0.8, y: 0.3 }, null)).toBe('left');
    expect(tiltDir({ x: 0.1, y: 0.7 }, null)).toBe('down');
    expect(tiltDir({ x: -0.2, y: -0.9 }, null)).toBe('up');
  });

  it('keeps the last choice on a diagonal instead of flickering', () => {
    expect(tiltDir({ x: 0.7, y: 0.65 }, 'down')).toBe('down');
    expect(tiltDir({ x: 0.65, y: 0.7 }, 'right')).toBe('right');
    expect(tiltDir({ x: 0.7, y: 0.65 }, 'up')).toBe('right');
  });
});

/** A snake with a fixed body and food out of the way. */
function snake(body: [number, number][], dir: Snake['dir'] = 'right'): Snake {
  return { cols: 10, rows: 8, body: body.map(([x, y]) => ({ x, y })), dir, food: { x: 9, y: 7 }, grow: 0 };
}

describe('step', () => {
  const rng = mulberry32(1);

  it('moves the whole snake one cell', () => {
    const s = snake([[3, 3], [2, 3], [1, 3]]);
    expect(step(s, rng)).toBe('ok');
    expect(s.body).toEqual([{ x: 4, y: 3 }, { x: 3, y: 3 }, { x: 2, y: 3 }]);
  });

  it('grows after eating and puts new food on a free cell', () => {
    const s = snake([[3, 3], [2, 3], [1, 3]]);
    s.food = { x: 4, y: 3 };
    expect(step(s, rng)).toBe('ate');
    expect(s.body).toHaveLength(3);
    step(s, rng);
    expect(s.body).toHaveLength(4);
    expect(s.body.some((c) => c.x === s.food.x && c.y === s.food.y)).toBe(false);
  });

  it('dies at the wall and on its own body', () => {
    expect(step(snake([[9, 3], [8, 3]]), rng)).toBe('dead');
    // a loop: head at (2,2) going down into its own body at (2,3)
    const s = snake([[2, 2], [3, 2], [3, 3], [2, 3], [1, 3]], 'down');
    expect(step(s, rng)).toBe('dead');
  });

  it('may move into the cell the tail is leaving', () => {
    const s = snake([[2, 2], [3, 2], [3, 3], [2, 3]], 'down');
    expect(step(s, rng)).toBe('ok');
  });

  it('cannot reverse into its neck', () => {
    const s = snake([[3, 3], [2, 3], [1, 3]]);
    turn(s, 'left');
    expect(s.dir).toBe('right');
    turn(s, 'up');
    expect(s.dir).toBe('up');
  });
});

describe('newSnake / freeCell / stepTime', () => {
  it('starts with food off the snake', () => {
    for (let seed = 0; seed < 20; seed++) {
      const s = newSnake(12, 8, mulberry32(seed));
      expect(s.body).toHaveLength(START_LEN);
      expect(s.body.some((c) => c.x === s.food.x && c.y === s.food.y)).toBe(false);
    }
  });

  it('finds the last free cell on a nearly full board', () => {
    const s = snake([]);
    s.cols = 3;
    s.rows = 1;
    s.body = [{ x: 0, y: 0 }, { x: 2, y: 0 }];
    expect(freeCell(s, Math.random)).toEqual({ x: 1, y: 0 });
  });

  it('speeds up as the snake grows, with a floor', () => {
    expect(stepTime(20)).toBeLessThan(stepTime(START_LEN));
    expect(stepTime(500)).toBeGreaterThan(0.05);
  });
});
