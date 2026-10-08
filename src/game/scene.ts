import type { GameState } from '../shared/protocol';

/** Callbacks a game uses to talk to the page around it. */
export interface GameHooks {
  /** Short vibration on the phone, e.g. on a slice. */
  onSlice(): void;
  /** Longer or custom vibration (ms). */
  onHaptic(ms: number): void;
  /** State, score or lives changed: push an update to the phone. */
  onChange(): void;
}

/** A game that can be shown on the shared canvas. */
export interface Scene {
  readonly title: string;
  readonly subtitle: string;
  state: GameState;
  score: number;
  best: number;
  lives: number;
  /** Called when the scene becomes the active one. */
  enter(): void;
  /** Called every animation frame while active. */
  tick(nowMs: number): void;
  requestStart(): void;
  togglePause(): void;
}
