import { describe, expect, it } from 'vitest';
import { JumpDetector, REFRACTORY_MS, spikeThreshold } from './jump';

/** Feed `ms` of samples at 60 Hz with a constant magnitude; returns detections as [t, strength]. */
function run(d: JumpDetector, t0: number, ms: number, mag: number): { t: number; s: number }[] {
  const out: { t: number; s: number }[] = [];
  for (let t = t0; t < t0 + ms; t += 1000 / 60) {
    const s = d.push(mag, t);
    if (s !== null) out.push({ t, s });
  }
  return out;
}

describe('spikeThreshold', () => {
  it('is 2 g at sensitivity 1 and lower when more sensitive', () => {
    expect(spikeThreshold(1)).toBeCloseTo(2);
    expect(spikeThreshold(2)).toBeLessThan(spikeThreshold(1));
    expect(spikeThreshold(0.5)).toBeGreaterThan(spikeThreshold(1));
  });
});

describe('JumpDetector', () => {
  it('stays quiet at rest', () => {
    const d = new JumpDetector();
    expect(run(d, 0, 2000, 9.81)).toEqual([]);
  });

  it('ignores ordinary movement such as walking or waving', () => {
    const d = new JumpDetector();
    run(d, 0, 500, 9.81);
    expect(run(d, 500, 300, 9.81 * 1.5)).toEqual([]); // 1.5 g bump
  });

  it('fires on the take-off spike and not again for the free-fall that follows', () => {
    const d = new JumpDetector();
    run(d, 0, 1000, 9.81);
    const spike = run(d, 1000, 50, 9.81 * 2.4);
    expect(spike).toHaveLength(1);
    expect(spike[0].s).toBeGreaterThan(2);
    expect(run(d, 1050, 300, 9.81 * 0.1)).toEqual([]); // flight (still inside the refractory period)
  });

  it('can jump again after the refractory period', () => {
    const d = new JumpDetector();
    run(d, 0, 1000, 9.81);
    expect(run(d, 1000, 30, 9.81 * 2.5)).toHaveLength(1);
    run(d, 1030, REFRACTORY_MS + 200, 9.81);
    expect(run(d, 1030 + REFRACTORY_MS + 200, 30, 9.81 * 2.5)).toHaveLength(1);
  });

  it('detects a free-fall without a clear spike (soft jump or phone in a pocket)', () => {
    const d = new JumpDetector();
    run(d, 0, 1000, 9.81);
    const r = run(d, 1000, 300, 9.81 * 0.1);
    expect(r).toHaveLength(1);
    expect(r[0].t - 1000).toBeGreaterThanOrEqual(80);
  });

  it('does not treat a one-sample dip as a jump', () => {
    const d = new JumpDetector();
    run(d, 0, 1000, 9.81);
    d.push(0.5, 1000);
    expect(run(d, 1017, 500, 9.81)).toEqual([]);
  });

  it('works when the sensor reports in g instead of m/s²', () => {
    const d = new JumpDetector();
    run(d, 0, 1000, 1.0);
    expect(run(d, 1000, 30, 2.4)).toHaveLength(1);
  });

  it('is more sensitive with a higher sensitivity setting', () => {
    const lo = new JumpDetector();
    lo.sens = 0.6;
    const hi = new JumpDetector();
    hi.sens = 2.5;
    run(lo, 0, 1000, 9.81);
    run(hi, 0, 1000, 9.81);
    expect(run(lo, 1000, 30, 9.81 * 1.7)).toHaveLength(0);
    expect(run(hi, 1000, 30, 9.81 * 1.7)).toHaveLength(1);
  });
});
