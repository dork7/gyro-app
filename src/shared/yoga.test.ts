import { describe, expect, it } from 'vitest';
import { FLOW, matches, targetOf, torsoRaw, torsoRel } from './yoga';

const stand = torsoRaw({ a: 0, b: 90, g: 0 });

describe('torsoRaw', () => {
  it('standing tall is fold 0, lean 0', () => {
    expect(stand.fold).toBeCloseTo(0);
    expect(stand.lean).toBeCloseTo(0);
  });
  it('bending forward 60° gives fold 60', () => {
    const t = torsoRaw({ a: 0, b: 150, g: 0 });
    expect(t.fold).toBeCloseTo(60);
    expect(t.lean).toBeCloseTo(0);
  });
  it('a deep fold (head below hips) is more than 90', () => {
    expect(torsoRaw({ a: 0, b: -150, g: 0 }).fold).toBeCloseTo(120);
  });
  it('bending forward with the screen facing the other way gives the same fold', () => {
    // phone turned over: screen faces the opposite way
    expect(torsoRaw({ a: 0, b: 30, g: 0 }).fold).toBeCloseTo(60);
  });
  it('leaning sideways 30° gives lean ±30 and no fold', () => {
    const r = torsoRaw({ a: 0, b: 60, g: 90 });
    expect(r.fold).toBeCloseTo(0);
    expect(Math.abs(r.lean)).toBeCloseTo(30);
    const l = torsoRaw({ a: 0, b: 60, g: -90 });
    expect(Math.sign(l.lean)).toBe(-Math.sign(r.lean));
  });
});

describe('torsoRel', () => {
  it('is measured from the calibration pose', () => {
    const ref = torsoRaw({ a: 0, b: 80, g: 0 }); // phone slightly tilted while standing
    const t = torsoRel(torsoRaw({ a: 0, b: 80, g: 0 }), ref);
    expect(t.fold).toBeCloseTo(0);
    expect(t.lean).toBeCloseTo(0);
  });
  it('ignores the sideways angle during a deep fold', () => {
    const t = torsoRel(torsoRaw({ a: 0, b: 170, g: 20 }), stand);
    expect(t.fold).toBeGreaterThan(60);
    expect(t.lean).toBe(0);
  });
});

describe('poses', () => {
  it('matches each pose and rejects the others', () => {
    expect(matches('stand', { fold: 3, lean: 2 }, 0)).toBe(true);
    expect(matches('stand', { fold: 3, lean: 30 }, 0)).toBe(false);
    expect(matches('side', { fold: 5, lean: 35 }, 0)).toBe(true);
    expect(matches('side', { fold: 5, lean: -35 }, 0)).toBe(true); // either side
    expect(matches('side', { fold: 5, lean: 10 }, 0)).toBe(false);
    expect(matches('fold', { fold: 90, lean: 0 }, 0)).toBe(true);
    expect(matches('fold', { fold: 30, lean: 0 }, 0)).toBe(false);
  });
  it('the second side bend must be the opposite side', () => {
    expect(matches('otherSide', { fold: 5, lean: -35 }, 1)).toBe(true);
    expect(matches('otherSide', { fold: 5, lean: 35 }, 1)).toBe(false);
  });
  it("each pose's ghost target satisfies the pose", () => {
    for (const p of FLOW) expect(matches(p.kind, targetOf(p.kind, 1), 1)).toBe(true);
  });
});
