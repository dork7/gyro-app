// Marble Maze maths: the tilt of a phone held flat like a tray, maze generation, and a
// marble rolling between the walls.
//
// Grip: the phone lies flat on your palm, screen up, top edge pointing at the laptop.
// "Up" in the phone's own axes (x right, y up the screen, z out of the screen) is
//     u = ( -cos(b)·sin(g),  sin(b),  cos(b)·cos(g) )
// and the marble rolls downhill, along -u in the screen plane. In maze coordinates
// (x right, y down the laptop screen) that is
//     slope = ( cos(b)·sin(g),  sin(b) )
// Each component is the sine of the slope in that direction: 0 when flat, ±1 on edge.
// Everything is relative to a calibrated "level" pose, so a slightly tilted hand is fine.
//
// Maze units: one cell is 1×1; cell (c, r) spans x in [c, c+1], y in [r, r+1].

import type { Orientation } from './pointer';

const DEG = Math.PI / 180;

export interface Vec {
  x: number;
  y: number;
}

export function slope(o: Orientation): Vec {
  const b = o.b * DEG;
  const g = (o.g ?? 0) * DEG;
  return { x: Math.cos(b) * Math.sin(g), y: Math.sin(b) };
}

/** Degrees of tilt that give full push at sensitivity 1. */
export const FULL_TILT = 22;
const DEAD = Math.sin(1.2 * DEG);

/** Slope relative to the level pose, as a push in -1..1 on each axis. */
export function tiltInput(s: Vec, ref: Vec, sens = 1): Vec {
  const full = Math.sin(FULL_TILT * DEG) / sens;
  const axis = (d: number) => {
    const mag = Math.max(0, Math.abs(d) - DEAD);
    return Math.sign(d) * Math.min(1, mag / (full - DEAD));
  };
  return { x: axis(s.x - ref.x), y: axis(s.y - ref.y) };
}

// ---- maze ------------------------------------------------------------------------------
export interface Maze {
  cols: number;
  rows: number;
  /** east[i]: wall on the right of cell i. south[i]: wall below cell i. */
  east: boolean[];
  south: boolean[];
}

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Open neighbours of cell i. */
export function neighbours(m: Maze, i: number): number[] {
  const c = i % m.cols;
  const out: number[] = [];
  if (c < m.cols - 1 && !m.east[i]) out.push(i + 1);
  if (c > 0 && !m.east[i - 1]) out.push(i - 1);
  if (i + m.cols < m.cols * m.rows && !m.south[i]) out.push(i + m.cols);
  if (i - m.cols >= 0 && !m.south[i - m.cols]) out.push(i - m.cols);
  return out;
}

/** A perfect maze (exactly one route between any two cells), by depth-first carving. */
export function makeMaze(cols: number, rows: number, rng: () => number): Maze {
  const n = cols * rows;
  const m: Maze = { cols, rows, east: new Array(n).fill(true), south: new Array(n).fill(true) };
  const seen = new Array(n).fill(false);
  const stack = [0];
  seen[0] = true;
  while (stack.length) {
    const i = stack[stack.length - 1];
    const c = i % cols;
    const opts: number[] = [];
    if (c < cols - 1 && !seen[i + 1]) opts.push(i + 1);
    if (c > 0 && !seen[i - 1]) opts.push(i - 1);
    if (i + cols < n && !seen[i + cols]) opts.push(i + cols);
    if (i - cols >= 0 && !seen[i - cols]) opts.push(i - cols);
    if (!opts.length) {
      stack.pop();
      continue;
    }
    const j = opts[Math.floor(rng() * opts.length)];
    if (j === i + 1) m.east[i] = false;
    else if (j === i - 1) m.east[j] = false;
    else if (j === i + cols) m.south[i] = false;
    else m.south[j] = false;
    seen[j] = true;
    stack.push(j);
  }
  return m;
}

/** Cells on the route from `from` to `to`, both included. */
export function solve(m: Maze, from: number, to: number): number[] {
  const prev = new Array(m.cols * m.rows).fill(-1);
  prev[from] = from;
  const queue = [from];
  while (queue.length) {
    const i = queue.shift()!;
    if (i === to) break;
    for (const j of neighbours(m, i)) {
      if (prev[j] === -1) {
        prev[j] = i;
        queue.push(j);
      }
    }
  }
  const path = [to];
  while (path[0] !== from) path.unshift(prev[path[0]]);
  return path;
}

export const center = (m: Maze, i: number): Vec => ({ x: (i % m.cols) + 0.5, y: Math.floor(i / m.cols) + 0.5 });

// ---- levels ----------------------------------------------------------------------------
export interface Level {
  maze: Maze;
  start: number;
  goal: number;
  path: number[];
  holes: number[];
  gems: number[];
  /** Seconds for the full time bonus to run out. */
  par: number;
}

export function makeLevel(level: number, seed: number): Level {
  const rng = mulberry32(seed);
  const rows = Math.min(10, 3 + level);
  const cols = Math.min(16, Math.round(rows * 1.6));
  const maze = makeMaze(cols, rows, rng);
  const start = 0;
  const goal = cols * rows - 1;
  const path = solve(maze, start, goal);
  const onPath = new Set(path);

  // Holes sit just off the route, in the mouth of a side branch: overshoot a turn and you drop.
  const mouths: number[] = [];
  for (let i = 0; i < cols * rows; i++) {
    if (!onPath.has(i) && neighbours(maze, i).some((j) => onPath.has(j))) mouths.push(i);
  }
  shuffle(mouths, rng);
  const holes = mouths.slice(0, Math.min(mouths.length, 1 + level * 2));
  const taken = new Set([...holes, start, goal]);

  // Gems reward exploring the dead ends that are not holes.
  const deadEnds: number[] = [];
  for (let i = 0; i < cols * rows; i++) if (!taken.has(i) && neighbours(maze, i).length === 1) deadEnds.push(i);
  shuffle(deadEnds, rng);
  const gems = deadEnds.slice(0, Math.min(deadEnds.length, 2 + level));

  return { maze, start, goal, path, holes, gems, par: 8 + path.length * 1.4 };
}

function shuffle<T>(a: T[], rng: () => number): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

// ---- walls and the rolling marble ------------------------------------------------------
export const WALL = 0.14;
export const MARBLE_R = 0.25;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Walls as rectangles centred on the grid lines, border included. */
export function wallRects(m: Maze): Rect[] {
  const t = WALL / 2;
  const out: Rect[] = [
    { x: -t, y: -t, w: m.cols + WALL, h: WALL },
    { x: -t, y: m.rows - t, w: m.cols + WALL, h: WALL },
    { x: -t, y: -t, w: WALL, h: m.rows + WALL },
    { x: m.cols - t, y: -t, w: WALL, h: m.rows + WALL },
  ];
  for (let i = 0; i < m.cols * m.rows; i++) {
    const c = i % m.cols;
    const r = Math.floor(i / m.cols);
    if (m.east[i] && c < m.cols - 1) out.push({ x: c + 1 - t, y: r - t, w: WALL, h: 1 + WALL });
    if (m.south[i] && r < m.rows - 1) out.push({ x: c - t, y: r + 1 - t, w: 1 + WALL, h: WALL });
  }
  return out;
}

export interface Marble {
  p: Vec;
  v: Vec;
}

/** Cells per second² at full tilt, top speed, and rolling friction (per second). */
export const ACCEL = 9;
export const MAX_SPEED = 7;
const FRICTION = 0.9;
const BOUNCE = 0.35;

/** Push the marble out of any wall it overlaps; returns the hardest impact speed. */
function collide(m: Marble, rects: Rect[]): number {
  let hit = 0;
  for (const r of rects) {
    const cx = Math.max(r.x, Math.min(r.x + r.w, m.p.x));
    const cy = Math.max(r.y, Math.min(r.y + r.h, m.p.y));
    let nx = m.p.x - cx;
    let ny = m.p.y - cy;
    const d = Math.hypot(nx, ny);
    if (d >= MARBLE_R) continue;
    if (d > 1e-9) {
      nx /= d;
      ny /= d;
    } else {
      // centre inside the wall: leave by the nearest side
      const left = m.p.x - r.x;
      const right = r.x + r.w - m.p.x;
      const top = m.p.y - r.y;
      const bottom = r.y + r.h - m.p.y;
      const least = Math.min(left, right, top, bottom);
      nx = least === left ? -1 : least === right ? 1 : 0;
      ny = least === top ? -1 : least === bottom ? 1 : 0;
    }
    const depth = d > 1e-9 ? MARBLE_R - d : MARBLE_R;
    m.p.x += nx * depth;
    m.p.y += ny * depth;
    const vn = m.v.x * nx + m.v.y * ny;
    if (vn < 0) {
      m.v.x -= (1 + BOUNCE) * vn * nx;
      m.v.y -= (1 + BOUNCE) * vn * ny;
      hit = Math.max(hit, -vn);
    }
  }
  return hit;
}

/** Advance the marble by dt seconds under `push` (-1..1 per axis). Returns the hardest wall impact. */
export function stepMarble(m: Marble, push: Vec, dt: number, rects: Rect[]): number {
  const steps = Math.max(1, Math.ceil((MAX_SPEED * dt) / (MARBLE_R * 0.4)));
  const h = dt / steps;
  const keep = Math.exp(-FRICTION * h);
  let hit = 0;
  for (let s = 0; s < steps; s++) {
    m.v.x = (m.v.x + push.x * ACCEL * h) * keep;
    m.v.y = (m.v.y + push.y * ACCEL * h) * keep;
    const sp = Math.hypot(m.v.x, m.v.y);
    if (sp > MAX_SPEED) {
      m.v.x *= MAX_SPEED / sp;
      m.v.y *= MAX_SPEED / sp;
    }
    m.p.x += m.v.x * h;
    m.p.y += m.v.y * h;
    hit = Math.max(hit, collide(m, rects));
  }
  return hit;
}

/** Holes and the goal: radius in cells. The marble drops in once its centre is this close. */
export const HOLE_R = 0.3;
export const DROP_R = 0.22;
export const GOAL_R = 0.3;
