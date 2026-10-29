import type { WebSocket } from 'ws';
import {
  GAME_TYPES,
  isPadId,
  isRoomCode,
  PAD_TYPES,
  ROOM_ALPHABET,
  ROOM_LENGTH,
  type ServerToGame,
  type ServerToPad,
} from '../src/shared/protocol';

// A room pairs one game (laptop) with any number of pads (phones). The server just
// routes messages between them; it never looks inside sensor samples. Messages from a
// pad are stamped with its pad id (`from`); a game message with `to` goes to that pad
// only, anything else to all of them.

const MAX_PADS = 10;

interface Room {
  code: string;
  game?: WebSocket;
  pads: Map<string, WebSocket>; // pad id -> socket, in join order
  cleanup?: NodeJS.Timeout;
}

interface Peer {
  role?: 'game' | 'pad';
  room?: Room;
  pid?: string;
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

function newPadId(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

function anyPad(room: Room): boolean {
  for (const ws of room.pads.values()) if (open(ws)) return true;
  return false;
}

function padList(room: Room): ServerToGame {
  return { t: 'pads', ids: [...room.pads.keys()] };
}

function scheduleCleanup(room: Room): void {
  clearTimeout(room.cleanup);
  room.cleanup = setTimeout(() => {
    if (!open(room.game) && !anyPad(room)) rooms.delete(room.code);
  }, ROOM_TTL_MS);
}

export function attach(ws: WebSocket): void {
  const peer: Peer = { alive: true };
  peers.set(ws, peer);
  ws.on('pong', () => (peer.alive = true));

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const text = raw.toString();
    let msg: { t?: unknown; room?: unknown; pid?: unknown; to?: unknown };
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
        room = { code, pads: new Map() };
        rooms.set(code, room);
      }
      clearTimeout(room.cleanup);
      room.game = ws;
      peer.role = 'game';
      peer.room = room;
      send(ws, { t: 'hosted', room: room.code });
      send(ws, padList(room));
      for (const pad of room.pads.values()) send(pad, { t: 'game', on: true });
      return;
    }

    if (msg.t === 'join' && !peer.role) {
      const room = isRoomCode(msg.room) ? rooms.get(msg.room) : undefined;
      if (!room) {
        send(ws, { t: 'error', msg: 'No game with that code. Check the code on the laptop screen.' });
        return;
      }
      const pid = isPadId(msg.pid) ? msg.pid : newPadId();
      const old = room.pads.get(pid);
      if (!old && room.pads.size >= MAX_PADS) {
        send(ws, { t: 'error', msg: `This game already has ${MAX_PADS} phones.` });
        return;
      }
      if (old && old !== ws) {
        room.pads.delete(pid); // the same phone came back: drop the stale socket quietly
        old.close(4000, 'replaced');
      }
      room.pads.set(pid, ws);
      peer.role = 'pad';
      peer.room = room;
      peer.pid = pid;
      send(ws, { t: 'joined', gameOn: open(room.game) });
      send(room.game, padList(room));
      return;
    }

    // ---- relay ----
    const room = peer.room;
    if (!room) return;
    if (peer.role === 'pad' && PAD_TYPES.has(msg.t)) {
      if (open(room.game)) room.game.send(JSON.stringify({ ...msg, from: peer.pid }));
    } else if (peer.role === 'game' && GAME_TYPES.has(msg.t)) {
      if (typeof msg.to === 'string') {
        const pad = room.pads.get(msg.to);
        if (open(pad)) pad.send(text);
      } else {
        for (const pad of room.pads.values()) if (open(pad)) pad.send(text);
      }
    }
  });

  ws.on('close', () => {
    const room = peer.room;
    if (!room) return;
    if (peer.role === 'game' && room.game === ws) {
      room.game = undefined;
      for (const pad of room.pads.values()) send(pad, { t: 'game', on: false });
    } else if (peer.role === 'pad' && peer.pid && room.pads.get(peer.pid) === ws) {
      room.pads.delete(peer.pid);
      send(room.game, padList(room));
    }
    if (!open(room.game) && !anyPad(room)) scheduleCleanup(room);
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
