// Gyro Snake rules: turning tilt into a direction, and the snake on its grid.
//
// Grip: like Marble Maze, the phone lies flat, screen up, top edge toward the laptop.
// Tilt it toward where the snake should go (tiltInput in marble.ts gives the push).
// Only the stronger axis counts, and a diagonal tilt keeps the last choice, so the
// direction does not flicker when the phone is tilted at about 45°.

import type { Vec } from './marble';

export type Dir = 'up' | 'down' | 'left' | 'right';

export const STEP: Record<Dir, { x: number; y: number }> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' };

/** Push (-1..1) beyond which a tilt counts as a turn. */
export const TURN_PUSH = 0.4;
const DOMINANCE = 1.25;

/** The direction a tilt asks for, or null when the phone is near level. */
export function tiltDir(push: Vec, prev: Dir | null): Dir | null {
  const ax = Math.abs(push.x);
  const ay = Math.abs(push.y);
  if (Math.max(ax, ay) < TURN_PUSH) return null;
  const horizontal: Dir = push.x > 0 ? 'right' : 'left';
  const vertical: Dir = push.y > 0 ? 'down' : 'up';
  if (ax > ay * DOMINANCE) return horizontal;
  if (ay > ax * DOMINANCE) return vertical;
  // about diagonal: keep the previous choice if it is one of the two, else the stronger axis
  if (prev === horizontal || prev === vertical) return prev;
  return ax >= ay ? horizontal : vertical;
}

export interface Cell {
  x: number;
  y: number;
}

export interface Snake {
  cols: number;
  rows: number;
  body: Cell[]; // head first
  dir: Dir;
  food: Cell;
  grow: number; // segments still to add
}

export type StepResult = 'ok' | 'ate' | 'dead';

export const START_LEN = 4;

export function newSnake(cols: number, rows: number, rng: () => number): Snake {
  const y = Math.floor(rows / 2);
  const x = Math.floor(cols / 3);
  const body = Array.from({ length: START_LEN }, (_, i) => ({ x: x - i, y }));
  const s: Snake = { cols, rows, body, dir: 'right', food: { x: 0, y: 0 }, grow: 0 };
  s.food = freeCell(s, rng);
  return s;
}

/** A random empty cell (not under the snake). */
export function freeCell(s: Snake, rng: () => number, avoid: Cell[] = []): Cell {
  const taken = new Set([...s.body, ...avoid].map((c) => c.y * s.cols + c.x));
  const free: number[] = [];
  for (let i = 0; i < s.cols * s.rows; i++) if (!taken.has(i)) free.push(i);
  const i = free[Math.floor(rng() * free.length)] ?? 0;
  return { x: i % s.cols, y: Math.floor(i / s.cols) };
}

/** Change direction, unless it would reverse straight into the neck. */
export function turn(s: Snake, d: Dir): void {
  if (d !== OPPOSITE[s.dir]) s.dir = d;
}

/** Move one cell. Walls and the snake's own body are deadly; food makes it grow by `growBy`. */
export function step(s: Snake, rng: () => number, growBy = 1): StepResult {
  const head = s.body[0];
  const next = { x: head.x + STEP[s.dir].x, y: head.y + STEP[s.dir].y };
  if (next.x < 0 || next.y < 0 || next.x >= s.cols || next.y >= s.rows) return 'dead';
  // the tail moves out of the way this step unless the snake is growing
  const body = s.grow > 0 ? s.body : s.body.slice(0, -1);
  if (body.some((c) => c.x === next.x && c.y === next.y)) return 'dead';
  s.body.unshift(next);
  if (s.grow > 0) s.grow--;
  else s.body.pop();
  if (next.x === s.food.x && next.y === s.food.y) {
    s.grow += growBy;
    s.food = freeCell(s, rng);
    return 'ate';
  }
  return 'ok';
}

/** Seconds per step: starts relaxed and speeds up as the snake grows. */
export function stepTime(length: number): number {
  return Math.max(0.075, 0.2 - (length - START_LEN) * 0.004);
}
