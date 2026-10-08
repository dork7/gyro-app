// Detects a physical jump from the phone's accelerometer.
//
// The sensor reports acceleration including gravity. At rest its magnitude is 1 g
// (9.81 m/s²). A jump has two signatures:
//   1. take-off:  the legs push hard, the magnitude spikes to ~1.7-3 g
//   2. flight:    the phone is in free fall, the magnitude drops towards 0 g
// We fire on the spike (lowest delay: it happens just before your feet leave the
// ground, which also hides the network delay) and, as a backup for a gentle jump or a
// phone in a loose pocket, on a sustained free-fall.
//
// Work with the ratio magnitude / resting gravity so m/s² and g units both work.

export const REST_MS2 = 9.81;

/** Minimum time between two jumps (a human can't jump faster than this). */
export const REFRACTORY_MS = 450;
/** Free-fall must last this long to count (rules out bumps and drops of a few cm). */
export const FREEFALL_MS = 90;
export const FREEFALL_RATIO = 0.35;

/** Spike threshold (ratio to gravity) for a sensitivity of 0.3..4. Sensitivity 1 = 2.0 g. */
export function spikeThreshold(sens: number): number {
  const s = Math.max(0.3, Math.min(4, sens));
  return 1.25 + 0.75 / s;
}

export class JumpDetector {
  sens = 1;
  /** Latest magnitude relative to resting gravity (1 = at rest). For meters. */
  ratio = 1;
  private baseline = 0;
  private lastJump = -Infinity;
  private lowSince: number | null = null;

  /**
   * Feed one accelerometer magnitude. Returns the jump strength (ratio at the moment of
   * take-off, or 0.5 for a free-fall detection) when a jump is detected, else null.
   */
  push(mag: number, tMs: number): number | null {
    if (!Number.isFinite(mag)) return null;
    if (this.baseline === 0) this.baseline = mag > 5 ? REST_MS2 : 1; // m/s² or g
    this.ratio = mag / this.baseline;

    // Follow slow drift of the resting value while the phone is calm.
    if (this.ratio > 0.9 && this.ratio < 1.1) this.baseline += (mag - this.baseline) * 0.01;

    const ready = tMs - this.lastJump > REFRACTORY_MS;

    // free-fall bookkeeping
    if (this.ratio < FREEFALL_RATIO) {
      if (this.lowSince === null) this.lowSince = tMs;
    } else if (this.ratio > 0.6) {
      this.lowSince = null;
    }

    if (ready && this.ratio >= spikeThreshold(this.sens)) {
      this.lastJump = tMs;
      this.lowSince = null;
      return this.ratio;
    }
    if (ready && this.lowSince !== null && tMs - this.lowSince >= FREEFALL_MS) {
      this.lastJump = tMs;
      this.lowSince = null;
      return 0.5;
    }
    return null;
  }

  reset(): void {
    this.lastJump = -Infinity;
    this.lowSince = null;
  }
}
