import type { GameId, GameToPad, PadButton, PadToGame, SampleMsg, ServerToGame } from '../shared/protocol';

export interface HostHandlers {
  onRoom(room: string): void;
  onPad(connected: boolean): void;
  onSample(s: SampleMsg): void;
  onButton(name: PadButton): void;
  onSensitivity(v: number): void;
  /** The player holds the racket in the left hand (tennis). */
  onLefty(lefty: boolean): void;
  onPedal(gas: boolean, brake: boolean): void;
  onSelect(game: GameId): void;
  onJump(strength: number): void;
  /** On-screen joystick, -1..1 each way (x right, y up). */
  onJoy(x: number, y: number): void;
  /** UNO moves come from every phone, tagged with the sender's pad id. */
  onUno(from: string, m: Extract<PadToGame, { t: 'uno' }>): void;
  onPotato(from: string, m: Extract<PadToGame, { t: 'potato' }>): void;
  /** The connected phones changed (pad ids, in join order). */
  onPads(ids: string[]): void;
  onServer(connected: boolean): void;
}

/**
 * The laptop's connection to the relay server. Reconnects by itself.
 *
 * Several phones can be connected. The motion games listen to one of them, the
 * controller: the phone that joined last, or that last pressed a button or picked a
 * game. Sensor data and buttons from the other phones are ignored.
 */
export class HostConnection {
  room = '';
  padOn = false;
  pads: string[] = [];
  controller = '';
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
      let m: ServerToGame | { t: string; from?: string; [k: string]: unknown };
      try {
        m = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      const from = 'from' in m && typeof m.from === 'string' ? m.from : '';
      if (from) {
        if (m.t === 'uno') {
          this.h.onUno(from, m as unknown as Extract<PadToGame, { t: 'uno' }>);
          return;
        }
        if (m.t === 'potato') {
          this.h.onPotato(from, m as unknown as Extract<PadToGame, { t: 'potato' }>);
          return;
        }
        // pressing a button, touching the joystick or picking a game makes that phone the controller
        if ((m.t === 'btn' || m.t === 'select' || m.t === 'joy') && from !== this.controller) {
          this.controller = from;
          this.h.onPad(true);
        }
        if (from !== this.controller) return;
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
        case 'pads': {
          const ids = (m as { ids: string[] }).ids;
          const joined = ids.filter((id) => !this.pads.includes(id));
          this.pads = ids;
          if (joined.length) this.controller = joined[joined.length - 1];
          else if (!ids.includes(this.controller)) this.controller = ids[ids.length - 1] ?? '';
          const on = ids.length > 0;
          if (on !== this.padOn || joined.length) {
            this.padOn = on;
            if (!on) this.rtt = [];
            this.h.onPad(on);
          }
          this.h.onPads(ids);
          break;
        }
        case 's':
          this.h.onSample(m as unknown as SampleMsg);
          break;
        case 'btn':
          this.h.onButton((m as unknown as { name: PadButton }).name);
          break;
        case 'cfg':
          this.h.onSensitivity((m as unknown as { sens: number }).sens);
          this.h.onLefty(Boolean((m as unknown as { lefty?: boolean }).lefty));
          break;
        case 'pedal':
          this.h.onPedal(Boolean((m as unknown as { gas: boolean }).gas), Boolean((m as unknown as { brake: boolean }).brake));
          break;
        case 'jump':
          this.h.onJump(Number((m as unknown as { r: number }).r) || 0);
          break;
        case 'joy': {
          const j = m as unknown as { x: number; y: number };
          const c = (v: number) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
          this.h.onJoy(c(Number(j.x)), c(Number(j.y)));
          break;
        }
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
      this.pads = [];
      this.h.onServer(false);
      this.h.onPad(false);
      this.h.onPads([]);
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(5000, this.retry * 2);
    };
  }

  send(m: GameToPad): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** Buzz the controller phone only. */
  haptic(ms: number): void {
    if (this.controller) this.send({ t: 'haptic', ms, to: this.controller });
  }

  medianRtt(): number | null {
    if (!this.rtt.length) return null;
    const s = [...this.rtt].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }
}
