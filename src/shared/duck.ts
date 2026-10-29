// Duck Shoot rules: ducks flying about, shots, and the round structure (the classic
// light-gun game). The phone is the gun: it aims like the Fruit Slicer blade (a pointer
// from where the top edge points) and the FIRE button on the phone pulls the trigger.
//
// Units: the screen is `aspect` wide and 1 high (y down), so distances mean the same
// across the screen whatever its shape. Ducks fly above the grass line.

export const GRASS_Y = 0.74;
export const DUCK_R = 0.05;
export const HIT_R = DUCK_R * 1.25; // a little forgiving: the crosshair moves with your hand
export const DUCKS_PER_ROUND = 10;
export const DUCKS_PER_WAVE = 2;
export const SHELLS_PER_WAVE = 3;
const HIT_FREEZE = 0.4; // seconds a hit duck hangs in the air before it drops
const FALL_SPEED = 1.1;

export type DuckKind = 'green' | 'blue' | 'gold';
export type DuckState = 'fly' | 'escape' | 'hit' | 'fall' | 'gone';

export interface Duck {
  x: number;
  y: number;
  vx: number;
  vy: number;
  kind: DuckKind;
  state: DuckState;
  t: number; // seconds in the current state
  turn: number; // seconds until the next change of direction
  speed: number;
  flyTime: number; // seconds before it gives up and escapes
}

export function duckSpeed(kind: DuckKind, round: number): number {
  const base = Math.min(0.75, 0.32 + round * 0.04);
  return base * (kind === 'gold' ? 1.8 : kind === 'blue' ? 1.35 : 1);
}

/** Seconds a duck stays before flying away. */
export function flyTime(round: number): number {
  return Math.max(4, 7.5 - round * 0.35);
}

/** Hits needed out of ten to go on to the next round. */
export function needed(round: number): number {
  return Math.min(DUCKS_PER_ROUND, 5 + round);
}

export function points(kind: DuckKind, round: number): number {
  const base = kind === 'gold' ? 1000 : kind === 'blue' ? 300 : 100;
  return base * Math.min(5, Math.ceil(round / 2));
}

export function pickKind(round: number, rng: () => number): DuckKind {
  const r = rng();
  if (round >= 2 && r < 0.06) return 'gold';
  if (r < 0.06 + Math.min(0.45, 0.15 + round * 0.05)) return 'blue';
  return 'green';
}

/** Point the duck in a new random direction, mostly sideways and up. */
function steer(d: Duck, rng: () => number): void {
  const a = (-0.15 - rng() * 0.7) * Math.PI; // between straight-ish left and right, upward half
  d.vx = Math.cos(a) * d.speed;
  d.vy = Math.sin(a) * d.speed * (rng() < 0.3 ? -0.6 : 1); // sometimes dives a little
  d.turn = 0.6 + rng() * 1.1;
}

export function spawnDuck(aspect: number, round: number, rng: () => number): Duck {
  const kind = pickKind(round, rng);
  const d: Duck = {
    x: aspect * (0.15 + rng() * 0.7),
    y: GRASS_Y,
    vx: 0,
    vy: 0,
    kind,
    state: 'fly',
    t: 0,
    turn: 0,
    speed: duckSpeed(kind, round),
    flyTime: flyTime(round),
  };
  steer(d, rng);
  d.vy = -Math.abs(d.vy); // always take off upward
  return d;
}

/** Move a duck on by dt seconds. */
export function stepDuck(d: Duck, dt: number, aspect: number, rng: () => number): void {
  d.t += dt;
  switch (d.state) {
    case 'fly': {
      d.turn -= dt;
      if (d.turn <= 0) steer(d, rng);
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      // bounce inside the sky
      if (d.x < DUCK_R) {
        d.x = DUCK_R;
        d.vx = Math.abs(d.vx);
      } else if (d.x > aspect - DUCK_R) {
        d.x = aspect - DUCK_R;
        d.vx = -Math.abs(d.vx);
      }
      if (d.y < DUCK_R) {
        d.y = DUCK_R;
        d.vy = Math.abs(d.vy);
      } else if (d.y > GRASS_Y - DUCK_R) {
        d.y = GRASS_Y - DUCK_R;
        d.vy = -Math.abs(d.vy);
      }
      if (d.t >= d.flyTime) escape(d);
      break;
    }
    case 'escape':
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      if (d.y < -DUCK_R * 2) setState(d, 'gone');
      break;
    case 'hit':
      if (d.t >= HIT_FREEZE) setState(d, 'fall');
      break;
    case 'fall':
      d.y += FALL_SPEED * dt;
      if (d.y > GRASS_Y + DUCK_R) setState(d, 'gone');
      break;
  }
}

function setState(d: Duck, s: DuckState): void {
  d.state = s;
  d.t = 0;
}

/** Fly straight up and away (time ran out, or the wave's shells are gone). */
export function escape(d: Duck): void {
  if (d.state !== 'fly') return;
  setState(d, 'escape');
  d.vx *= 0.2;
  d.vy = -d.speed * 1.4;
}

/** A shot at (x, y): true if it hits this duck. */
export function shoot(d: Duck, x: number, y: number): boolean {
  if (d.state !== 'fly' && d.state !== 'escape') return false;
  if (Math.hypot(d.x - x, d.y - y) > HIT_R) return false;
  setState(d, 'hit');
  d.vx = 0;
  d.vy = 0;
  return true;
}
