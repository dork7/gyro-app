import type { PotatoView } from './potato';
import type { UnoView } from './uno';

// Messages exchanged over the WebSocket relay (JSON text frames).
//
//   phone (/pad)  <--->  server (rooms)  <--->  laptop (game)
//
// The server only routes messages; it never interprets samples.
//
// A room has one laptop and any number of phones. Each phone has a pad id (kept across
// page reloads), the server stamps it on everything the phone sends (`from`), and the
// laptop can address one phone with `to`; messages without `to` go to every phone.

/** Raw device orientation sample in degrees (W3C DeviceOrientationEvent). */
export interface SampleMsg {
  t: 's';
  a: number; // alpha: compass-ish heading, 0..360
  b: number; // beta: front/back tilt, -180..180
  g: number; // gamma: left/right tilt, -90..90
}

export type PadButton = 'center' | 'start' | 'pause' | 'fire' | 'grip' | 'release' | 'act';

/** Which screen the laptop is showing. */
export type GameId = 'home' | 'fruit' | 'car' | 'jump' | 'yoga' | 'write' | 'phonics' | 'tennis' | 'maze' | 'sky' | 'snake' | 'orbit' | 'uno' | 'duck' | 'potato' | 'fish' | 'bowl';

// ---- first message from each side -------------------------------------------------
export interface HostMsg {
  t: 'host';
  room?: string; // reuse a room code after a page refresh
}
export interface JoinMsg {
  t: 'join';
  room: string;
  pid?: string; // pad id; a phone that reconnects with the same id takes its old place
}

export type UnoAction = 'hello' | 'start' | 'play' | 'draw' | 'pass';

// ---- phone -> laptop ---------------------------------------------------------------
export type PadToGame =
  | SampleMsg
  | { t: 'btn'; name: PadButton }
  | { t: 'cfg'; sens: number }
  | { t: 'pedal'; gas: boolean; brake: boolean }
  | { t: 'select'; game: GameId }
  | { t: 'jump'; r: number } // r = take-off strength (ratio to gravity), 0 for a tap
  | { t: 'joy'; x: number; y: number } // on-screen joystick instead of motion: -1..1, x right, y up
  | { t: 'uno'; a: UnoAction; name?: string; card?: number; color?: string; uno?: boolean }
  | { t: 'potato'; a: 'hello' | 'start' | 'pass'; name?: string; dir?: 1 | -1 }
  | { t: 'pong'; id: number };

// ---- laptop -> phone ---------------------------------------------------------------
export type GameState = 'menu' | 'playing' | 'paused' | 'over';
export type GameToPad =
  | { t: 'ping'; id: number }
  | { t: 'haptic'; ms: number; to?: string }
  | { t: 'uno'; to: string; v: UnoView }
  | { t: 'potato'; to: string; v: PotatoView }
  // ctl: pad id of the phone that steers the motion games (the others only watch)
  | { t: 'state'; game: GameId; state: GameState; score: number; lives: number; best: number; ctl?: string };

// ---- server -> client --------------------------------------------------------------
export type ServerToGame = { t: 'hosted'; room: string } | { t: 'pads'; ids: string[] }; // ids: connected phones, in join order
export type ServerToPad = { t: 'joined'; gameOn: boolean } | { t: 'game'; on: boolean } | { t: 'error'; msg: string };

export const PAD_TYPES = new Set(['s', 'btn', 'cfg', 'pedal', 'select', 'jump', 'joy', 'uno', 'potato', 'pong']);
export const GAME_TYPES = new Set(['ping', 'haptic', 'state', 'uno', 'potato']);

export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O
export const ROOM_LENGTH = 4;

export function isPadId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9]{4,16}$/.test(v);
}

export function isRoomCode(v: unknown): v is string {
  return typeof v === 'string' && v.length === ROOM_LENGTH && [...v].every((c) => ROOM_ALPHABET.includes(c));
}
