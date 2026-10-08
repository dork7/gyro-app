import type { GameId, GameToPad, PadButton, SampleMsg, ServerToGame } from '../shared/protocol';

export interface HostHandlers {
  onRoom(room: string): void;
  onPad(connected: boolean): void;
  onSample(s: SampleMsg): void;
  onButton(name: PadButton): void;
  onSensitivity(v: number): void;
  onPedal(gas: boolean, brake: boolean): void;
  onSelect(game: GameId): void;
  onJump(strength: number): void;
  onServer(connected: boolean): void;
}

/** The laptop's connection to the relay server. Reconnects by itself. */
export class HostConnection {
  room = '';
  padOn = false;
  rtt: number[] = []; // recent round-trip times (ms) game -> phone -> game
  private ws: WebSocket | null = null;
  private retry = 500;

  constructor(private h: HostHandlers) {
    this.connect();
    setInterval(() => {
      if (this.padOn) this.send({ t: 'ping', id: performance.now() });
    }, 1000);
  }

  private connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 500;
      let saved: string | undefined;
      try {
        saved = sessionStorage.getItem('room') ?? undefined;
      } catch {
        /* storage may be unavailable */
      }
      ws.send(JSON.stringify({ t: 'host', room: saved }));
      this.h.onServer(true);
    };
    ws.onmessage = (ev) => {
      let m: ServerToGame | { t: string; [k: string]: unknown };
      try {
        m = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      switch (m.t) {
        case 'hosted':
          this.room = (m as { room: string }).room;
          try {
            sessionStorage.setItem('room', this.room);
          } catch {
            /* ignore */
          }
          this.h.onRoom(this.room);
          break;
        case 'pad':
          this.padOn = (m as { on: boolean }).on;
          if (!this.padOn) this.rtt = [];
          this.h.onPad(this.padOn);
          break;
        case 's':
          this.h.onSample(m as unknown as SampleMsg);
          break;
        case 'btn':
          this.h.onButton((m as unknown as { name: PadButton }).name);
          break;
        case 'cfg':
          this.h.onSensitivity((m as unknown as { sens: number }).sens);
          break;
        case 'pedal':
          this.h.onPedal(Boolean((m as unknown as { gas: boolean }).gas), Boolean((m as unknown as { brake: boolean }).brake));
          break;
        case 'jump':
          this.h.onJump(Number((m as unknown as { r: number }).r) || 0);
          break;
        case 'select':
          this.h.onSelect((m as unknown as { game: GameId }).game);
          break;
        case 'pong': {
          const rtt = performance.now() - (m as unknown as { id: number }).id;
          this.rtt.push(rtt);
          if (this.rtt.length > 20) this.rtt.shift();
          break;
        }
      }
    };
    ws.onclose = () => {
      this.padOn = false;
      this.h.onServer(false);
      this.h.onPad(false);
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(5000, this.retry * 2);
    };
  }

  send(m: GameToPad): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  medianRtt(): number | null {
    if (!this.rtt.length) return null;
    const s = [...this.rtt].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }
}
