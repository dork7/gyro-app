// The blade: a smoothed pointer plus a short fading trail.
// Smoothing uses the One Euro filter (Casiez et al. 2012): steady when the hand
// is still, almost no lag when it moves fast, which is what a slicing game needs.

class LowPass {
  private y: number | null = null;
  filter(x: number, alpha: number): number {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
  last(): number | null {
    return this.y;
  }
  reset(): void {
    this.y = null;
  }
}

class OneEuro {
  private x = new LowPass();
  private dx = new LowPass();
  private prev: number | null = null;
  constructor(
    private minCutoff = 2.0, // Hz: lower = steadier when still
    private beta = 0.012, // higher = less lag when fast (units: px/s)
    private dCutoff = 1.0,
  ) {}
  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(value: number, dt: number): number {
    const d = this.prev === null ? 0 : (value - this.prev) / dt;
    this.prev = value;
    const edx = this.dx.filter(d, OneEuro.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(value, OneEuro.alpha(cutoff, dt));
  }
  reset(): void {
    this.x.reset();
    this.dx.reset();
    this.prev = null;
  }
}

export interface Segment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dt: number; // seconds between the two points
}

interface TrailPoint {
  x: number;
  y: number;
  t: number;
}

const TRAIL_MS = 170;

export class Blade {
  x = 0;
  y = 0;
  active = false; // true once we have had at least one point
  private fx = new OneEuro();
  private fy = new OneEuro();
  private lastT = 0;
  private trail: TrailPoint[] = [];

  /** Feed a raw pointer position. Returns the segment travelled since the last point, if any. */
  push(rawX: number, rawY: number, now: number): Segment | null {
    if (!this.active || now - this.lastT > 500) {
      // first sample, or a long gap: jump without making a slice segment
      this.fx.reset();
      this.fy.reset();
      this.trail = [];
      this.x = this.fx.filter(rawX, 1 / 60);
      this.y = this.fy.filter(rawY, 1 / 60);
      this.lastT = now;
      this.active = true;
      this.trail.push({ x: this.x, y: this.y, t: now });
      return null;
    }
    const dt = Math.max(1 / 240, Math.min(0.1, (now - this.lastT) / 1000));
    const x0 = this.x;
    const y0 = this.y;
    this.x = this.fx.filter(rawX, dt);
    this.y = this.fy.filter(rawY, dt);
    this.lastT = now;
    this.trail.push({ x: this.x, y: this.y, t: now });
    return { x0, y0, x1: this.x, y1: this.y, dt };
  }

  /** Forget the trail (e.g. when the game restarts). */
  clear(): void {
    this.trail = [];
  }

  draw(ctx: CanvasRenderingContext2D, now: number, scale: number): void {
    this.trail = this.trail.filter((p) => now - p.t < TRAIL_MS);
    const pts = this.trail;
    if (pts.length < 2) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < pts.length; i++) {
      const age = (now - pts[i].t) / TRAIL_MS; // 0 new .. 1 old
      const k = 1 - age;
      ctx.strokeStyle = `rgba(120, 220, 255, ${0.55 * k})`;
      ctx.lineWidth = (16 * scale) * k + 2;
      ctx.beginPath();
      ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
      ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.95 * k})`;
      ctx.lineWidth = (6 * scale) * k + 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** A small dot where the pointer is, so you can aim before you swing. */
  drawCursor(ctx: CanvasRenderingContext2D, scale: number): void {
    if (!this.active) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(this.x, this.y, 7 * scale, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.shadowColor = 'rgba(120,220,255,0.9)';
    ctx.shadowBlur = 14 * scale;
    ctx.fill();
    ctx.restore();
  }
}
