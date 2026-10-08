// Digit outlines for the number-writing game.
//
// Each digit is a few strokes; a stroke is a polyline in a unit box that is 0.6 wide and
// 1.0 tall (x right, y DOWN, origin top-left), written in the usual stroke order and
// direction. Pure maths, so it can be unit-tested.

export interface P {
  x: number;
  y: number;
}
export type Stroke = P[];

export const GLYPH_W = 0.6;
export const GLYPH_H = 1;

const rad = (d: number) => (d * Math.PI) / 180;

/** Points on an ellipse arc. Angles in degrees; with y pointing down, increasing = clockwise. */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): Stroke {
  const n = Math.max(6, Math.ceil(Math.abs(a1 - a0) / 8));
  const out: Stroke = [];
  for (let i = 0; i <= n; i++) {
    const a = rad(a0 + ((a1 - a0) * i) / n);
    out.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return out;
}

function bez(p0: P, p1: P, p2: P, p3: P, n = 14): Stroke {
  const out: Stroke = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return out;
}

const pts = (...c: number[]): Stroke => {
  const out: Stroke = [];
  for (let i = 0; i < c.length; i += 2) out.push({ x: c[i]!, y: c[i + 1]! });
  return out;
};

const join = (...parts: Stroke[]): Stroke => parts.flatMap((p, i) => (i === 0 ? p : p.slice(1)));

export const DIGITS: Record<number, Stroke[]> = {
  0: [arc(0.3, 0.5, 0.28, 0.5, -90, -450)],
  1: [pts(0.1, 0.22, 0.32, 0.0, 0.32, 1.0)],
  2: [join(arc(0.3, 0.27, 0.27, 0.27, -170, 40), pts(0.507, 0.443, 0.02, 1.0, 0.6, 1.0))],
  3: [join(arc(0.3, 0.26, 0.27, 0.24, -150, 90), arc(0.3, 0.74, 0.3, 0.26, -90, 150))],
  4: [pts(0.42, 0.0, 0.0, 0.68, 0.6, 0.68), pts(0.42, 0.0, 0.42, 1.0)],
  5: [join(pts(0.55, 0.0, 0.14, 0.0, 0.1, 0.43), arc(0.3, 0.68, 0.3, 0.32, -125, 140))],
  6: [join(bez({ x: 0.52, y: 0.02 }, { x: 0.2, y: 0.1 }, { x: 0.02, y: 0.4 }, { x: 0.02, y: 0.7 }), arc(0.3, 0.7, 0.28, 0.3, 180, -180))],
  7: [pts(0.0, 0.02, 0.6, 0.02, 0.2, 1.0)],
  8: [join(arc(0.3, 0.25, 0.25, 0.23, 90, -270), arc(0.3, 0.74, 0.3, 0.26, -90, 270))],
  9: [join(arc(0.3, 0.3, 0.28, 0.3, 0, -360), bez({ x: 0.58, y: 0.3 }, { x: 0.58, y: 0.65 }, { x: 0.35, y: 0.98 }, { x: 0.05, y: 0.95 }))],
};

export const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);

/** Evenly spaced points along a set of strokes. `spacing` is in the same units as the strokes. */
export function resample(strokes: Stroke[], spacing: number): { pts: P[]; stroke: number[] } {
  const out: P[] = [];
  const which: number[] = [];
  strokes.forEach((s, si) => {
    let carry = 0;
    let prev = s[0]!;
    out.push(prev);
    which.push(si);
    for (let i = 1; i < s.length; i++) {
      const cur = s[i]!;
      let d = dist(prev, cur);
      if (d === 0) continue;
      let from = prev;
      while (carry + d >= spacing) {
        const t = (spacing - carry) / d;
        const np = { x: from.x + (cur.x - from.x) * t, y: from.y + (cur.y - from.y) * t };
        out.push(np);
        which.push(si);
        d -= spacing - carry;
        carry = 0;
        from = np;
      }
      carry += d;
      prev = cur;
    }
    const last = s[s.length - 1]!;
    const tail = out[out.length - 1]!;
    if (dist(tail, last) > spacing * 0.4) {
      out.push(last);
      which.push(si);
    }
  });
  return { pts: out, stroke: which };
}

/** Mark every path point within `r` of the segment a→b as covered. Returns how many were newly covered. */
export function cover(path: P[], done: Uint8Array, a: P, b: P, r: number): number {
  let added = 0;
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  for (let i = 0; i < path.length; i++) {
    const p = path[i]!;
    let t = len2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = a.x + abx * t - p.x;
    const dy = a.y + aby * t - p.y;
    if (dx * dx + dy * dy <= r * r && !done[i]) {
      done[i] = 1;
      added++;
    }
  }
  return added;
}

/** Is a point within `r` of any path point? (used to tell tracing from scribbling) */
export function nearPath(path: P[], p: P, r: number): boolean {
  const r2 = r * r;
  for (const q of path) {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}
