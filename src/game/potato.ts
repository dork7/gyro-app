// Hot Potato for 2–8 players, a phone each. The laptop shows everyone in a circle and the
// potato on the phone of whoever holds it; that phone turns red and buzzes with the
// ticking. Flick your phone sideways (or tap an arrow) to throw it to a neighbour. The
// fuse is secret; the ticking speeds up as it burns. Holding it when it goes off costs a
// life; the last player with lives left wins.

import type { GameState, GameToPad, PadToGame } from '../shared/protocol';
import { burnt, FLIGHT, LIVES, newGame, nextRound, pass, step, type Potato, type PotatoView } from '../shared/potato';
import type { Sfx } from './audio';
import type { GameHooks, Scene } from './scene';

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const BOOM_TIME = 2.6; // seconds of explosion before the next round
const AWAY_PASS_S = 2; // an absent holder throws to the right after this long
const NAME_MAX = 12;
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Seat {
  pid: string;
  name: string;
}

function cleanName(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.replace(/[^\p{L}\p{N} _.'-]/gu, '').trim().slice(0, NAME_MAX) : '';
  return s || fallback;
}

export class PotatoGame implements Scene {
  readonly title = 'Hot Potato';
  readonly subtitle = 'Everyone scans the QR code. Flick the phone to pass the potato.';
  state: GameState = 'menu';
  score = 0;
  best = 0;
  lives = 0; // players in the game, shown on the phones

  private ctx: CanvasRenderingContext2D;
  private w = 800;
  private h = 600;
  private sc = 1;

  private seats: Seat[] = [];
  private connected = new Set<string>();
  private game: Potato | null = null;
  private boomT = 0; // > 0 while the explosion plays
  private boom: { victim: number; out: boolean } | null = null;
  private tickIn = 0;
  private log = '';
  private sparks: { x: number; y: number; vx: number; vy: number; life: number; color: string }[] = [];
  private lastFrame = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private sfx: Sfx,
    private hooks: GameHooks,
    private send: (m: GameToPad) => void,
  ) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('Canvas 2D is not available');
    this.ctx = c;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // ---------------------------------------------------------------- scene API
  enter(): void {
    this.resize();
    this.lastFrame = 0;
    this.game = null;
    this.seats = [];
    this.setState('menu');
  }

  requestStart(): void {
    if (this.state === 'menu' || this.state === 'over') this.startGame();
    else if (this.state === 'paused') this.setState('playing');
  }

  togglePause(): void {
    if (this.state === 'playing') this.setState('paused');
    else if (this.state === 'paused') this.setState('playing');
  }

  tick(t: number): void {
    const dt = Math.min(0.05, this.lastFrame ? (t - this.lastFrame) / 1000 : 0.016);
    this.lastFrame = t;
    this.update(dt);
    this.render();
  }

  // ---------------------------------------------------------------- phones
  setPads(ids: string[]): void {
    this.connected = new Set(ids);
    if (this.state === 'menu' || this.state === 'over') this.seats = this.seats.filter((s) => this.connected.has(s.pid));
    this.lives = this.seats.length;
    this.broadcast();
  }

  handle(from: string, m: Extract<PadToGame, { t: 'potato' }>): void {
    this.connected.add(from);
    if (m.a === 'hello') {
      this.sfx.unlock();
      const seat = this.seats.find((s) => s.pid === from);
      const player = this.game?.players.find((p) => p.pid === from);
      const name = cleanName(m.name, seat?.name ?? player?.name ?? `Player ${this.seats.length + 1}`);
      if (seat) seat.name = name;
      else if (this.seats.length < MAX_PLAYERS) this.seats.push({ pid: from, name });
      if (player) player.name = name;
      this.lives = this.seats.length;
      this.hooks.onChange();
      this.broadcast();
      return;
    }
    if (m.a === 'start') {
      if (this.state === 'menu' || this.state === 'over') this.startGame(from);
      return;
    }
    const g = this.game;
    if (!g || this.state !== 'playing') return;
    const who = g.players.findIndex((p) => p.pid === from);
    if (who < 0) return;
    const err = pass(g, who, m.dir === -1 ? -1 : 1);
    if (err) {
      this.broadcast(from, err);
      return;
    }
    this.log = `${g.players[who].name} → ${g.players[g.holder].name}`;
    this.sfx.jump();
    this.broadcast();
  }

  // ---------------------------------------------------------------- game
  private setState(s: GameState): void {
    this.state = s;
    document.body.dataset.state = s;
    this.hooks.onChange();
    this.broadcast();
  }

  private startGame(by?: string): void {
    const ready = this.seats.filter((s) => this.connected.has(s.pid));
    if (ready.length < MIN_PLAYERS) {
      if (by) this.broadcast(by, `Waiting for players: ${ready.length} of at least ${MIN_PLAYERS} have joined`);
      return;
    }
    this.seats = ready;
    this.game = newGame(ready, Math.random);
    this.game.held = 0.5; // the first holder may throw at once
    this.boom = null;
    this.boomT = 0;
    this.tickIn = 0;
    this.log = `${this.game.players[this.game.holder].name} has the potato!`;
    this.sfx.start();
    this.setState('playing');
  }

  private update(dt: number): void {
    for (const s of this.sparks) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += 400 * dt;
      s.life -= dt;
    }
    this.sparks = this.sparks.filter((s) => s.life > 0);
    const g = this.game;
    if (!g || this.state !== 'playing') return;

    if (this.boomT > 0) {
      this.boomT -= dt;
      if (this.boomT <= 0) {
        if (g.winner !== null) {
          this.sfx.combo();
          this.setState('over');
          return;
        }
        nextRound(g, Math.random);
        this.boom = null;
        this.log = `New fuse! ${g.players[g.holder].name} has the potato`;
        this.sfx.start();
        this.broadcast();
      }
      return;
    }

    for (const e of step(g, dt)) {
      if (e.type === 'land') {
        this.sfx.racket();
        this.send({ t: 'haptic', ms: 30, to: g.players[e.to].pid });
        this.broadcast();
      } else if (e.type === 'boom') {
        const p = g.players[e.victim];
        this.boom = { victim: e.victim, out: e.out };
        this.boomT = BOOM_TIME;
        this.log = e.out ? `BOOM! ${p.name} is out!` : `BOOM! ${p.name} loses a life`;
        this.sfx.bomb();
        this.send({ t: 'haptic', ms: 60, to: p.pid });
        const at = this.seatPos(e.victim);
        for (let i = 0; i < 60; i++) {
          const a = Math.random() * Math.PI * 2;
          const v = 150 + Math.random() * 450;
          this.sparks.push({ x: at.x, y: at.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 200, life: 0.6 + Math.random() * 0.8, color: ['#ffb703', '#fb8500', '#e63946', '#ffe066'][i % 4] });
        }
        this.hooks.onChange();
        this.broadcast();
      }
    }
    if (this.boomT > 0) return;

    // ticking: faster as the fuse burns; the holder's phone buzzes with it
    this.tickIn -= dt;
    if (this.tickIn <= 0) {
      const heat = burnt(g);
      this.tickIn = 0.6 - 0.48 * heat;
      this.sfx.tick(heat);
      if (!g.flight) {
        const pid = g.players[g.holder].pid;
        this.send({ t: 'haptic', ms: Math.round(12 + heat * 30), to: pid });
        this.broadcast(pid);
      }
    }

    // a holder whose phone is gone throws it on after a moment
    if (!g.flight && !this.connected.has(g.players[g.holder].pid) && g.held > AWAY_PASS_S) {
      const from = g.holder;
      pass(g, from, 1);
      this.log = `${g.players[from].name} is away: potato thrown to ${g.players[g.holder].name}`;
      this.broadcast();
    }
  }

  /** Send every phone (or just `only`) its own view. */
  private broadcast(only?: string, note?: string): void {
    const g = this.game;
    const lobby = this.state === 'menu' || !g;
    const list = lobby ? this.seats : g!.players;
    for (const pid of only ? [only] : this.connected) {
      const you = list.findIndex((p) => p.pid === pid);
      const v: PotatoView = {
        phase: lobby ? 'lobby' : this.state === 'over' ? 'over' : this.state === 'paused' ? 'paused' : this.boomT > 0 ? 'boom' : 'play',
        you,
        names: list.map((p) => p.name),
        lives: lobby ? list.map(() => LIVES) : g!.players.map((p) => p.lives),
        holder: lobby ? -1 : g!.holder,
        flying: !lobby && g!.flight !== null,
        heat: lobby ? 0 : burnt(g!),
        winner: lobby ? null : g!.winner,
        log: lobby ? `${this.seats.length} player${this.seats.length === 1 ? '' : 's'} in the circle` : this.log,
      };
      if (note && pid === only) v.note = note;
      this.send({ t: 'potato', to: pid, v });
    }
  }

  // ---------------------------------------------------------------- render
  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.floor(this.w * dpr);
    this.canvas.height = Math.floor(this.h * dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.sc = clamp(this.h / 800, 0.6, 1.6);
  }

  /** Seat i on the circle: player 0 at the bottom, the next one to their right. */
  private seatPos(i: number): { x: number; y: number } {
    const n = this.game?.players.length ?? 1;
    const a = Math.PI / 2 - (i / n) * Math.PI * 2;
    return {
      x: this.w / 2 + Math.cos(a) * Math.min(this.w * 0.38, this.w / 2 - 120 * this.sc),
      y: this.h * 0.52 + Math.sin(a) * Math.min(this.h * 0.33, this.h / 2 - 110 * this.sc),
    };
  }

  private render(): void {
    const { ctx, w, h } = this;
    const g = this.game;
    const heat = g && this.state === 'playing' ? burnt(g) : 0;
    const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
    bg.addColorStop(0, `rgb(${70 + heat * 80}, ${30 + heat * 10}, 40)`);
    bg.addColorStop(1, '#1a0c14');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    if (this.boomT > BOOM_TIME - 0.6) {
      const k = (this.boomT - (BOOM_TIME - 0.6)) / 0.6;
      ctx.translate((Math.random() - 0.5) * 24 * k, (Math.random() - 0.5) * 24 * k);
    }
    if (this.state === 'menu' || !g) this.drawLobby();
    else this.drawCircle(g, heat);
    ctx.restore();

    for (const s of this.sparks) {
      ctx.globalAlpha = clamp(s.life * 1.5, 0, 1);
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 4 * this.sc, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawLobby(): void {
    const { ctx, w, h } = this;
    const sc = this.sc;
    const lx = w * 0.72; // centre of the free space right of the QR panel
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${120 * sc}px ${EMOJI_FONT}`;
    ctx.fillText('🥔', lx, h * 0.3 + Math.sin(performance.now() / 120) * 4 * sc);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${23 * sc}px system-ui, sans-serif`;
    ctx.fillText('Everyone scans the QR code with their own phone', lx, h * 0.52);
    ctx.font = `500 ${15 * sc}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText('Tap "Enable motion" to pass the potato with a flick (buttons work too)', lx, h * 0.52 + 28 * sc);
    ctx.font = `700 ${20 * sc}px system-ui, sans-serif`;
    const names = this.seats.map((s) => s.name);
    ctx.fillStyle = names.length ? '#fff' : 'rgba(255,255,255,0.55)';
    ctx.fillText(names.length ? names.join('  ·  ') : 'Nobody has joined yet', lx, h * 0.52 + 78 * sc);
    ctx.font = `800 ${21 * sc}px system-ui, sans-serif`;
    ctx.fillStyle = '#ffe066';
    const ready = this.seats.filter((s) => this.connected.has(s.pid)).length;
    ctx.fillText(ready >= MIN_PLAYERS ? 'Press "Start" on any phone (or Space)' : 'Waiting for at least two players…', lx, h * 0.52 + 130 * sc);
  }

  private drawCircle(g: Potato, heat: number): void {
    const { ctx, w, h } = this;
    const sc = this.sc;

    g.players.forEach((p, i) => {
      const { x, y } = this.seatPos(i);
      const out = p.lives <= 0;
      const holding = i === g.holder && !g.flight && this.state === 'playing';
      ctx.globalAlpha = out ? 0.35 : 1;
      ctx.fillStyle = holding ? '#ff6b35' : 'rgba(255,255,255,0.12)';
      if (holding) {
        ctx.shadowColor = '#ff6b35';
        ctx.shadowBlur = (20 + heat * 30) * sc;
      }
      ctx.beginPath();
      ctx.arc(x, y, 46 * sc, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.font = `800 ${34 * sc}px system-ui, sans-serif`;
      if (out) {
        ctx.font = `${36 * sc}px ${EMOJI_FONT}`;
        ctx.fillText('💀', x, y);
      } else ctx.fillText(p.name.slice(0, 1).toUpperCase(), x, y + 2 * sc);
      ctx.textBaseline = 'alphabetic';
      ctx.font = `700 ${19 * sc}px system-ui, sans-serif`;
      ctx.fillText(p.name, x, y + 72 * sc);
      ctx.font = `${16 * sc}px ${EMOJI_FONT}`;
      ctx.fillText(Array.from({ length: LIVES }, (_, k) => (k < p.lives ? '❤️' : '🖤')).join(''), x, y + 94 * sc);
      ctx.globalAlpha = 1;
    });

    // the potato: on the holder, or flying in an arc between two players
    if (g.winner === null || this.boomT > 0) {
      let pos = this.seatPos(g.holder);
      let lift = 0;
      if (g.flight) {
        const a = this.seatPos(g.flight.from);
        const k = clamp(g.flight.t / FLIGHT, 0, 1);
        pos = { x: a.x + (pos.x - a.x) * k, y: a.y + (pos.y - a.y) * k };
        lift = Math.sin(k * Math.PI) * 120 * sc;
      }
      const x = pos.x;
      const y = pos.y - 70 * sc - lift;
      if (this.boomT > 0 && this.boom) {
        const k = 1 - this.boomT / BOOM_TIME;
        ctx.font = `${(120 + k * 80) * sc}px ${EMOJI_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.globalAlpha = clamp(this.boomT, 0, 1);
        ctx.fillText('💥', this.seatPos(this.boom.victim).x, this.seatPos(this.boom.victim).y - 30 * sc);
        ctx.globalAlpha = 1;
      } else {
        const shake = (2 + heat * 7) * sc;
        const size = (54 + heat * 26) * sc;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, size);
        glow.addColorStop(0, `rgba(255,140,40,${0.25 + heat * 0.45})`);
        glow.addColorStop(1, 'rgba(255,140,40,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = `${size}px ${EMOJI_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.save();
        ctx.translate(x + (Math.random() - 0.5) * shake, y + (Math.random() - 0.5) * shake);
        ctx.rotate(g.flight ? g.flight.t * 14 : Math.sin(performance.now() / 60) * 0.12);
        ctx.fillText('🥔', 0, 0);
        ctx.restore();
        // steam rising off a hot potato
        if (Math.random() < 0.3 + heat * 0.6) {
          this.sparks.push({ x: x + (Math.random() - 0.5) * size * 0.5, y: y - size * 0.4, vx: (Math.random() - 0.5) * 30, vy: -120 - Math.random() * 80, life: 0.5, color: 'rgba(255,255,255,0.35)' });
        }
      }
    }

    // last move and the arrow hint
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 4 * sc;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${26 * sc}px system-ui, sans-serif`;
    ctx.strokeText(this.log, w / 2, h * 0.5);
    ctx.fillText(this.log, w / 2, h * 0.5);
    ctx.font = `500 ${15 * sc}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillText('Flick your phone left or right to throw the potato to your neighbour', w / 2, h * 0.5 + 30 * sc);

    if (this.state === 'over' && g.winner !== null) {
      this.banner([
        [`🏆 ${g.players[g.winner].name} wins!`, 56, '#ffe066'],
        ['Press "Start" on any phone (or Space) to play again', 22, 'rgba(255,255,255,0.85)'],
      ]);
    } else if (this.state === 'paused') {
      this.banner([
        ['PAUSED', 64, '#fff'],
        ['Press P to carry on', 24, 'rgba(255,255,255,0.8)'],
      ]);
    }
  }

  private banner(lines: [string, number, string][]): void {
    const { ctx, w, h } = this;
    const sc = this.sc;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, h * 0.36 - 40 * sc, w, 60 * sc + lines.length * 52 * sc);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 5 * sc;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    let y = h * 0.36 + 14 * sc;
    for (const [text, size, color] of lines) {
      ctx.font = `800 ${size * sc}px system-ui, ${EMOJI_FONT}`;
      ctx.fillStyle = color;
      ctx.strokeText(text, w / 2, y);
      ctx.fillText(text, w / 2, y);
      y += (size + 22) * sc;
    }
  }
}

