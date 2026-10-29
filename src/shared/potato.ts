// Hot Potato: a party game for 2–8 phones. The potato sits on one player's phone; flick
// the phone sideways (or tap an arrow) to throw it to the player on your left or right.
// A hidden fuse burns down, and whoever holds the potato when it goes off loses a life.
// The last player with lives left wins.
//
// The laptop runs these rules and draws the circle of players; each phone detects its
// own flicks (FlickDetector) and only sends "pass left" or "pass right".

export const LIVES = 3;
export const MIN_HOLD = 0.5; // seconds you must hold a potato you just caught before you can throw it
export const FLIGHT = 0.45; // seconds a throw takes
const FUSE_MIN = 12;
const FUSE_MAX = 28;

export interface PotatoPlayer {
  pid: string;
  name: string;
  lives: number;
}

export interface Potato {
  players: PotatoPlayer[];
  holder: number; // who has it (the catcher while it is in the air)
  flight: { from: number; t: number } | null;
  held: number; // seconds the holder has had it
  fuse: number; // seconds left, secret
  fuseTotal: number;
  boomed: boolean; // went off; waiting for nextRound
  winner: number | null;
}

export type PotatoEvent = { type: 'land'; to: number } | { type: 'boom'; victim: number; out: boolean } | { type: 'win'; winner: number };

const alive = (s: Potato, i: number) => s.players[i].lives > 0;

/** The next player with lives left, going `dir` (+1 right, -1 left) round the circle. */
export function neighbour(lives: number[], from: number, dir: 1 | -1): number {
  const n = lives.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (lives[i] > 0) return i;
  }
  return from;
}

export function nextAlive(s: Potato, from: number, dir: 1 | -1): number {
  return neighbour(s.players.map((p) => p.lives), from, dir);
}

export function newFuse(rng: () => number): number {
  return FUSE_MIN + rng() * (FUSE_MAX - FUSE_MIN);
}

export function newGame(players: { pid: string; name: string }[], rng: () => number): Potato {
  const fuse = newFuse(rng);
  return {
    players: players.map((p) => ({ pid: p.pid, name: p.name, lives: LIVES })),
    holder: Math.floor(rng() * players.length),
    flight: null,
    held: 0,
    fuse,
    fuseTotal: fuse,
    boomed: false,
    winner: null,
  };
}

/** Throw the potato. Returns an error message, or null when it is on its way. */
export function pass(s: Potato, who: number, dir: 1 | -1): string | null {
  if (s.winner !== null) return 'The game is over';
  if (s.boomed) return 'It already went off';
  if (who !== s.holder) return 'You do not have the potato';
  if (s.flight) return 'It is already flying';
  if (s.held < MIN_HOLD) return 'Too quick: catch it first';
  s.flight = { from: who, t: 0 };
  s.holder = nextAlive(s, who, dir);
  s.held = 0;
  return null;
}

/** Burn the fuse and fly the potato. A potato that goes off in the air goes off on the catcher. */
export function step(s: Potato, dt: number): PotatoEvent[] {
  if (s.winner !== null || s.boomed) return [];
  const out: PotatoEvent[] = [];
  if (s.flight) {
    s.flight.t += dt;
    if (s.flight.t >= FLIGHT) {
      s.flight = null;
      out.push({ type: 'land', to: s.holder });
    }
  } else {
    s.held += dt;
  }
  s.fuse -= dt;
  if (s.fuse <= 0 && !s.flight) {
    s.boomed = true;
    const victim = s.holder;
    s.players[victim].lives--;
    const gone = s.players[victim].lives <= 0;
    out.push({ type: 'boom', victim, out: gone });
    const left = s.players.map((_, i) => i).filter((i) => alive(s, i));
    if (left.length <= 1) {
      s.winner = left[0] ?? victim;
      out.push({ type: 'win', winner: s.winner });
    }
  }
  return out;
}

/** After a boom: the next round starts with the victim, or the next player if they are out. */
export function nextRound(s: Potato, rng: () => number): void {
  if (!alive(s, s.holder)) s.holder = nextAlive(s, s.holder, 1);
  s.flight = null;
  s.boomed = false;
  s.held = MIN_HOLD; // can throw straight away
  s.fuse = newFuse(rng);
  s.fuseTotal = s.fuse;
}

/** How far the fuse has burnt, 0..1 (drives the ticking and the heat on the holder's phone). */
export const burnt = (s: Potato) => 1 - Math.max(0, s.fuse) / s.fuseTotal;

// ---- what a phone is told --------------------------------------------------------------
export interface PotatoView {
  phase: 'lobby' | 'play' | 'boom' | 'paused' | 'over';
  you: number;
  names: string[];
  lives: number[];
  holder: number; // -1 in the lobby
  flying: boolean;
  heat: number; // 0..1, how close it feels to going off
  winner: number | null;
  log: string;
  note?: string;
}

// ---- flick detection (runs on the phone) -----------------------------------------------
// A sideways flick shows up as a sharp spike in the phone's x acceleration. Gravity and slow
// tilting are removed with a high-pass filter, so the raw accelerationIncludingGravity.x
// works as input. The first big spike sets the direction: a flick to the right starts
// with a push to the right (+x), then brakes.

export const FLICK_MS2 = 14; // m/s² of sideways push for a flick at sensitivity 1
const FLICK_COOLDOWN_MS = 500;
const LP_TAU_MS = 300;

export class FlickDetector {
  sens = 1;
  private lp: number | null = null;
  private lastT = 0;
  private lastFire = -1e9;
  private armed = true;

  /** Feed one accelerometer x reading (m/s²) at time t (ms). Returns ±1 on a flick. */
  push(ax: number, t: number): 1 | -1 | null {
    const dt = this.lastT ? Math.max(1, t - this.lastT) : 16;
    this.lastT = t;
    if (this.lp === null) this.lp = ax;
    this.lp += (ax - this.lp) * Math.min(1, dt / LP_TAU_MS);
    const hp = ax - this.lp;
    const thr = FLICK_MS2 / this.sens;
    if (Math.abs(hp) < thr * 0.4) this.armed = true;
    if (!this.armed || Math.abs(hp) < thr || t - this.lastFire < FLICK_COOLDOWN_MS) return null;
    this.armed = false;
    this.lastFire = t;
    return hp > 0 ? 1 : -1;
  }
}
