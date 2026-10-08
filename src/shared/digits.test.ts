import { describe, expect, it } from 'vitest';
import { cover, DIGITS, dist, GLYPH_H, GLYPH_W, nearPath, resample, type P } from './digits';

describe('digit outlines', () => {
  it('has strokes for 0-9 that stay inside the glyph box', () => {
    for (let d = 0; d <= 9; d++) {
      const strokes = DIGITS[d]!;
      expect(strokes.length).toBeGreaterThan(0);
      for (const s of strokes)
        for (const p of s) {
          expect(p.x).toBeGreaterThanOrEqual(-0.01);
          expect(p.x).toBeLessThanOrEqual(GLYPH_W + 0.01);
          expect(p.y).toBeGreaterThanOrEqual(-0.01);
          expect(p.y).toBeLessThanOrEqual(GLYPH_H + 0.01);
        }
    }
  });

  it('resamples evenly', () => {
    const { pts } = resample(DIGITS[7]!, 0.02);
    for (let i = 1; i < pts.length - 1; i++) expect(dist(pts[i - 1]!, pts[i]!)).toBeCloseTo(0.02, 2);
    expect(pts.length).toBeGreaterThan(60);
  });

  it('marks which stroke each point belongs to', () => {
    const { pts, stroke } = resample(DIGITS[4]!, 0.03);
    expect(stroke.length).toBe(pts.length);
    expect(new Set(stroke)).toEqual(new Set([0, 1]));
  });

  it('a perfect trace covers every point, in any digit', () => {
    for (let d = 0; d <= 9; d++) {
      const { pts } = resample(DIGITS[d]!, 0.02);
      const done = new Uint8Array(pts.length);
      for (const s of DIGITS[d]!) for (let i = 1; i < s.length; i++) cover(pts, done, s[i - 1]!, s[i]!, 0.03);
      expect(done.reduce((a, b) => a + b, 0) / pts.length).toBeGreaterThan(0.97);
    }
  });

  it('a trace shifted far off the path covers (almost) nothing', () => {
    const { pts } = resample(DIGITS[8]!, 0.02);
    const done = new Uint8Array(pts.length);
    const off = (p: P): P => ({ x: p.x + 0.4, y: p.y });
    for (const s of DIGITS[8]!) for (let i = 1; i < s.length; i++) cover(pts, done, off(s[i - 1]!), off(s[i]!), 0.03);
    expect(done.reduce((a, b) => a + b, 0) / pts.length).toBeLessThan(0.3);
  });

  it('cover() only counts new points', () => {
    const { pts } = resample(DIGITS[1]!, 0.02);
    const done = new Uint8Array(pts.length);
    const a = DIGITS[1]![0]![1]!;
    const b = DIGITS[1]![0]![2]!;
    const first = cover(pts, done, a, b, 0.03);
    expect(first).toBeGreaterThan(10);
    expect(cover(pts, done, a, b, 0.03)).toBe(0);
  });

  it('nearPath tells tracing from scribbling', () => {
    const { pts } = resample(DIGITS[0]!, 0.02);
    expect(nearPath(pts, { x: 0.3, y: 0.0 }, 0.03)).toBe(true);
    expect(nearPath(pts, { x: 0.3, y: 0.5 }, 0.03)).toBe(false);
  });
});
