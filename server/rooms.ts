import type { WebSocket } from 'ws';
import {
  GAME_TYPES,
  isRoomCode,
  PAD_TYPES,
  ROOM_ALPHABET,
  ROOM_LENGTH,
  type ServerToGame,
  type ServerToPad,
} from '../src/shared/protocol';

// A room pairs one game (laptop) with one pad (phone). The server just routes
// messages between them; it never looks inside sensor samples.

interface Room {
  code: string;
  game?: WebSocket;
  pad?: WebSocket;
  cleanup?: NodeJS.Timeout;
}

interface Peer {
  role?: 'game' | 'pad';
  room?: Room;
  alive: boolean;
}

const ROOM_TTL_MS = 5 * 60_000;

const rooms = new Map<string, Room>();
const peers = new WeakMap<WebSocket, Peer>();

function open(ws?: WebSocket): ws is WebSocket {
  return !!ws && ws.readyState === ws.OPEN;
}

function send(ws: WebSocket | undefined, msg: ServerToGame | ServerToPad): void {
  if (open(ws)) ws.send(JSON.stringify(msg));
}

function newCode(): string {
  for (;;) {
    let c = '';
    for (let i = 0; i < ROOM_LENGTH; i++) c += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
}

function scheduleCleanup(room: Room): void {
  clearTimeout(room.cleanup);
  room.cleanup = setTimeout(() => {
    if (!open(room.game) && !open(room.pad)) rooms.delete(room.code);
  }, ROOM_TTL_MS);
}

export function attach(ws: WebSocket): void {
  const peer: Peer = { alive: true };
  peers.set(ws, peer);
  ws.on('pong', () => (peer.alive = true));

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const text = raw.toString();
    let msg: { t?: unknown; room?: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null || typeof msg.t !== 'string') return;

    // ---- handshake ----
    if (msg.t === 'host' && !peer.role) {
      let room = isRoomCode(msg.room) ? rooms.get(msg.room) : undefined;
      if (room && open(room.game)) room = undefined; // already hosted by another tab
      if (!room) {
        const code = isRoomCode(msg.room) && !rooms.has(msg.room) ? msg.room : newCode();
        room = { code };
        rooms.set(code, room);
      }
      clearTimeout(room.cleanup);
      room.game = ws;
      peer.role = 'game';
      peer.room = room;
      send(ws, { t: 'hosted', room: room.code });
      if (open(room.pad)) {
        send(ws, { t: 'pad', on: true });
        send(room.pad, { t: 'game', on: true });
      }
      return;
    }

    if (msg.t === 'join' && !peer.role) {
      const room = isRoomCode(msg.room) ? rooms.get(msg.room) : undefined;
      if (!room) {
        send(ws, { t: 'error', msg: 'No game with that code. Check the code on the laptop screen.' });
        return;
      }
      if (open(room.pad) && room.pad !== ws) room.pad.close(4000, 'replaced');
      room.pad = ws;
      peer.role = 'pad';
      peer.room = room;
      send(ws, { t: 'joined', gameOn: open(room.game) });
      send(room.game, { t: 'pad', on: true });
      return;
    }

    // ---- relay ----
    const room = peer.room;
    if (!room) return;
    if (peer.role === 'pad' && PAD_TYPES.has(msg.t)) {
      if (open(room.game)) room.game.send(text);
    } else if (peer.role === 'game' && GAME_TYPES.has(msg.t)) {
      if (open(room.pad)) room.pad.send(text);
    }
  });

  ws.on('close', () => {
    const room = peer.room;
    if (!room) return;
    if (peer.role === 'game' && room.game === ws) {
      room.game = undefined;
      send(room.pad, { t: 'game', on: false });
    } else if (peer.role === 'pad' && room.pad === ws) {
      room.pad = undefined;
      send(room.game, { t: 'pad', on: false });
    }
    if (!open(room.game) && !open(room.pad)) scheduleCleanup(room);
  });
}

/** Drop sockets that stopped answering (e.g. a phone that locked its screen). */
export function startHeartbeat(clients: Set<WebSocket>): NodeJS.Timeout {
  return setInterval(() => {
    for (const ws of clients) {
      const peer = peers.get(ws);
      if (!peer) continue;
      if (!peer.alive) {
        ws.terminate();
        continue;
      }
      peer.alive = false;
      ws.ping();
    }
  }, 15_000);
}
