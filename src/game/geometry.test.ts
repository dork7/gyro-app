import { describe, expect, it } from 'vitest';
import { segmentHitsCircle } from './geometry';

describe('segmentHitsCircle', () => {
  it('hits when the segment crosses the circle', () => {
    expect(segmentHitsCircle(-10, 0, 10, 0, 0, 0, 3)).toBe(true);
  });
  it('hits when the circle is near the middle but not on the line', () => {
    expect(segmentHitsCircle(-10, 2, 10, 2, 0, 0, 3)).toBe(true);
  });
  it('misses when the segment passes outside the radius', () => {
    expect(segmentHitsCircle(-10, 5, 10, 5, 0, 0, 3)).toBe(false);
  });
  it('misses when the segment ends before the circle (not an infinite line)', () => {
    expect(segmentHitsCircle(-10, 0, -5, 0, 0, 0, 3)).toBe(false);
  });
  it('hits when the segment ends inside the circle', () => {
    expect(segmentHitsCircle(-10, 0, -2, 0, 0, 0, 3)).toBe(true);
  });
  it('handles a zero-length segment', () => {
    expect(segmentHitsCircle(1, 1, 1, 1, 0, 0, 3)).toBe(true);
    expect(segmentHitsCircle(9, 9, 9, 9, 0, 0, 3)).toBe(false);
  });
});
