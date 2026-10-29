// UNO for 2–8 players: every player scans the QR code with their own phone and plays
// their hand there (play, draw, pass, call UNO). The laptop is the table: it holds the
// game, shows the discard pile, whose turn it is and how many cards everyone has, and
// tells each phone only about its own hand.
//
// Phones are known by their pad id, which survives a page reload, so a player whose
// phone drops out gets their seat and hand back when it reconnects. If the player whose
// turn it is stays away, the table draws and passes for them after a while.

import type { GameState, GameToPad, PadToGame } from '../shared/protocol';
import {
  card,
  COLOR_NAME,
  COLORS,
  draw,
  label,
  MAX_PLAYERS,
  MIN_PLAYERS,
  newRound,
  pass,
  play,
  roundPoints,
  top,
  type Card,
  type Color,
  type Uno,
  type UnoView,
} from '../shared/uno';
import type { Sfx } from './audio';
import type { GameHooks, Scene } from './scene';

const AWAY_TURN_S = 20; // seconds before an absent player's turn is played for them
const NAME_MAX = 12;
const HEX: Record<Color, string> = { r: '#e5383b', y: '#f4c430', g: '#2a9d4b', b: '#1f6fd1' };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Seat {
  pid: string;
  name: string;
}

function cleanName(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.replace(/[^\p{L}\p{N} _.'-]/gu, '').trim().slice(0, NAME_MAX) : '';
  return s || fallback;
}

export class UnoGame implements Scene {
  readonly title = 'UNO';
  readonly subtitle = 'Everyone scans the QR code and plays from their phone.';
  state: GameState = 'menu';
  score = 0;
  best = 0;
  lives = 0; // players at the table, shown on the phones

  private ctx: CanvasRenderingContext2D;
  private w = 800;
  private h = 600;
  private sc = 1;

  private seats: Seat[] = []; // lobby, in join order
  private connected = new Set<string>();
  private game: Uno | null = null;
  private totals = new Map<string, number>();
  private rounds = 0;
  private lastPoints = 0;
  private awayFor = 0;
  private lastTop = -1;
  private popT = 1; // 0..1 animation of the newest card on the pile
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
    if (this.state === 'menu' || this.state === 'over') this.startRound();
    else if (this.state === 'paused') this.setState('playing');
  }

  togglePause(): void {
    if (this.state === 'playing') this.setState('paused');
    else if (this.state === 'paused') this.setState('playing');
  }

  tick(t: number): void {
    const dt = Math.min(0.05, this.lastFrame ? (t - this.lastFrame) / 1000 : 0.016);
    this.lastFrame = t;
    this.popT = Math.min(1, this.popT + dt * 4);
    this.updateAway(dt);
    this.render();
  }

  // ---------------------------------------------------------------- phones
  setPads(ids: string[]): void {
    this.connected = new Set(ids);
    if (this.state === 'menu' || this.state === 'over') this.seats = this.seats.filter((s) => this.connected.has(s.pid));
    this.lives = this.seats.length;
    this.broadcast();
  }

  handle(from: string, m: Extract<PadToGame, { t: 'uno' }>): void {
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
      if (this.state === 'menu' || this.state === 'over') this.startRound(from);
      return;
    }
    const g = this.game;
    if (!g || this.state !== 'playing') {
      this.broadcast(from, this.state === 'paused' ? 'The game is paused' : 'No round is running');
      return;
    }
    const who = g.players.findIndex((p) => p.pid === from);
    if (who < 0) {
      this.broadcast(from, 'You are watching this round; you will be dealt in next round');
      return;
    }
    const rng = Math.random;
    const before = g.turn;
    let err: string | null;
    if (m.a === 'play') err = play(g, who, Number(m.card), rng, m.color as Color | undefined, Boolean(m.uno));
    else if (m.a === 'draw') err = draw(g, who, rng);
    else err = pass(g, who);
    if (err) {
      this.broadcast(from, err);
      return;
    }
    this.afterMove(m.a, before);
  }

  // ---------------------------------------------------------------- rounds
  private setState(s: GameState): void {
    this.state = s;
    document.body.dataset.state = s;
    this.hooks.onChange();
    this.broadcast();
  }

  private startRound(by?: string): void {
    const ready = this.seats.filter((s) => this.connected.has(s.pid));
    if (ready.length < MIN_PLAYERS) {
      if (by) this.broadcast(by, `Waiting for players: ${ready.length} of at least ${MIN_PLAYERS} have joined`);
      return;
    }
    this.seats = ready;
    this.game = newRound(ready, Math.random, this.rounds);
    this.rounds++;
    this.lastTop = -1;
    this.awayFor = 0;
    this.sfx.start();
    this.setState('playing');
    this.buzzTurn();
  }

  private afterMove(action: string, before: number): void {
    const g = this.game!;
    this.awayFor = 0;
    if (action === 'play') {
      const c = top(g);
      if (c.kind === 'draw2' || c.kind === 'wild4') this.sfx.crash();
      else if (c.color === null) this.sfx.combo();
      else this.sfx.slice();
    } else if (action === 'draw') this.sfx.coin();
    if (g.winner !== null) {
      const pid = g.players[g.winner].pid;
      this.lastPoints = roundPoints(g);
      this.totals.set(pid, (this.totals.get(pid) ?? 0) + this.lastPoints);
      this.sfx.combo();
      this.send({ t: 'haptic', ms: 60, to: pid });
      this.setState('over');
      return;
    }
    if (g.turn !== before || action === 'pass') this.buzzTurn();
    this.hooks.onChange();
    this.broadcast();
  }

  private buzzTurn(): void {
    const g = this.game;
    if (g) this.send({ t: 'haptic', ms: 40, to: g.players[g.turn].pid });
  }

  /** Play the turn of a player whose phone has gone: draw, and pass if the card is kept. */
  private updateAway(dt: number): void {
    const g = this.game;
    if (!g || this.state !== 'playing' || this.connected.has(g.players[g.turn].pid)) {
      this.awayFor = 0;
      return;
    }
    this.awayFor += dt;
    if (this.awayFor < AWAY_TURN_S) return;
    const who = g.turn;
    if (g.drawn === null) draw(g, who, Math.random);
    if (g.turn === who) pass(g, who);
    g.log = `${g.players[who].name} is away: drew a card and passed`;
    this.afterMove('draw', who);
  }

  /** Send every phone (or just `only`) its own view of the table. */
  private broadcast(only?: string, note?: string): void {
    const g = this.game;
    const phase = this.state === 'menu' || !g ? 'lobby' : this.state === 'paused' ? 'paused' : this.state === 'over' ? 'over' : 'play';
    const list = phase === 'lobby' ? this.seats : g!.players;
    for (const pid of only ? [only] : this.connected) {
      const you = list.findIndex((p) => p.pid === pid);
      const v: UnoView = {
        phase,
        you,
        hand: g && phase !== 'lobby' && you >= 0 ? g.players[you].hand : [],
        names: list.map((p) => p.name),
        counts: g && phase !== 'lobby' ? g.players.map((p) => p.hand.length) : [],
        totals: list.map((p) => this.totals.get(p.pid) ?? 0),
        top: g && phase !== 'lobby' ? g.discard[g.discard.length - 1] : -1,
        color: g && phase !== 'lobby' ? g.color : null,
        turn: g ? g.turn : 0,
        drawn: g && you === g.turn ? g.drawn : null,
        winner: g ? g.winner : null,
        log: phase === 'lobby' ? `${this.seats.length} player${this.seats.length === 1 ? '' : 's'} at the table` : g!.log,
      };
      if (note && pid === only) v.note = note;
      this.send({ t: 'uno', to: pid, v });
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

  private render(): void {
    const { ctx, w, h } = this;
    const felt = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
    felt.addColorStop(0, '#1e7a4a');
    felt.addColorStop(1, '#0b3a23');
    ctx.fillStyle = felt;
    ctx.fillRect(0, 0, w, h);

    if (this.state === 'menu' || !this.game) this.drawLobby();
    else this.drawTable(this.game);
  }

  private drawLobby(): void {
    const { ctx, w, h } = this;
    const sc = this.sc;
    const lx = w * 0.72; // centre of the free space right of the QR panel
    // fan of cards as a logo
    const fan: Card[] = [card(9), card(34), card(60), card(84), card(104)];
    fan.forEach((c, i) => {
      ctx.save();
      ctx.translate(lx + (i - 2) * 46 * sc, h * 0.3 + Math.abs(i - 2) * 10 * sc);
      ctx.rotate((i - 2) * 0.16);
      this.drawCard(c, 0, 0, 92 * sc);
      ctx.restore();
    });

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${23 * sc}px system-ui, sans-serif`;
    ctx.fillText('Everyone scans the QR code with their own phone', lx, h * 0.52);
    ctx.font = `500 ${15 * sc}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(`${MIN_PLAYERS}–${MAX_PLAYERS} players. No need to enable motion: tap "Continue without motion"`, lx, h * 0.52 + 30 * sc);

    // players so far
    const names = this.seats.map((s) => s.name);
    let y = h * 0.52 + 80 * sc;
    if (!names.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = `600 ${20 * sc}px system-ui, sans-serif`;
      ctx.fillText('Nobody has joined yet', lx, y);
    } else {
      ctx.font = `700 ${20 * sc}px system-ui, sans-serif`;
      const pad = 14 * sc;
      const widths = names.map((n) => ctx.measureText(n).width + pad * 2);
      let row: number[] = [];
      const rows: number[][] = [];
      let rw = 0;
      widths.forEach((wd, i) => {
        if (rw + wd > w * 0.42 && row.length) {
          rows.push(row);
          row = [];
          rw = 0;
        }
        row.push(i);
        rw += wd + 10 * sc;
      });
      if (row.length) rows.push(row);
      for (const r of rows) {
        const total = r.reduce((a, i) => a + widths[i] + 10 * sc, -10 * sc);
        let x = lx - total / 2;
        for (const i of r) {
          ctx.fillStyle = 'rgba(255,255,255,0.14)';
          this.roundRect(x, y - 26 * sc, widths[i], 38 * sc, 19 * sc);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'left';
          ctx.fillText(names[i], x + pad, y);
          x += widths[i] + 10 * sc;
        }
        y += 48 * sc;
      }
      ctx.textAlign = 'center';
    }
    ctx.font = `800 ${21 * sc}px system-ui, sans-serif`;
    ctx.fillStyle = '#ffe066';
    const ready = this.seats.filter((s) => this.connected.has(s.pid)).length;
    ctx.fillText(ready >= MIN_PLAYERS ? 'Press "Start round" on any phone (or Space)' : 'Waiting for at least two players…', lx, y + 20 * sc);
  }

  private drawTable(g: Uno): void {
    const { ctx, w, h } = this;
    const sc = this.sc;
    const cx = w / 2;
    const cy = h * 0.47;
    const cw = 120 * sc; // card width at the centre

    // colour in play: a glow behind the piles
    const glow = ctx.createRadialGradient(cx, cy, cw * 0.3, cx, cy, cw * 2.2);
    glow.addColorStop(0, HEX[g.color] + 'aa');
    glow.addColorStop(1, HEX[g.color] + '00');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, cw * 2.2, 0, Math.PI * 2);
    ctx.fill();

    // direction of play: arrows running round the piles
    const rr = cw * 1.65;
    const spin = (performance.now() / 1000) * 0.5 * g.dir;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 4 * sc;
    for (let k = 0; k < 3; k++) {
      const a0 = spin + (k * Math.PI * 2) / 3;
      const a1 = a0 + 1.3 * g.dir;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, Math.min(a0, a1), Math.max(a0, a1));
      ctx.stroke();
      const hx = cx + Math.cos(a1) * rr;
      const hy = cy + Math.sin(a1) * rr;
      const tang = a1 + (Math.PI / 2) * g.dir;
      ctx.beginPath();
      ctx.moveTo(hx + Math.cos(tang) * 12 * sc, hy + Math.sin(tang) * 12 * sc);
      ctx.lineTo(hx + Math.cos(tang + 2.4) * 10 * sc, hy + Math.sin(tang + 2.4) * 10 * sc);
      ctx.lineTo(hx + Math.cos(tang - 2.4) * 10 * sc, hy + Math.sin(tang - 2.4) * 10 * sc);
      ctx.closePath();
      ctx.fill();
    }

    // draw pile
    for (let i = Math.min(5, Math.ceil(g.deck.length / 10)); i >= 0; i--) this.drawBack(cx - cw * 0.75 - i * 2, cy - i * 2, cw);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = `600 ${15 * sc}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${g.deck.length} left`, cx - cw * 0.75, cy + cw * 0.95);

    // discard pile: the last few cards, each at its own slight angle
    const topId = g.discard[g.discard.length - 1];
    if (topId !== this.lastTop) {
      this.popT = this.lastTop === -1 ? 1 : 0;
      this.lastTop = topId;
    }
    const pile = g.discard.slice(-4);
    pile.forEach((id, i) => {
      const last = i === pile.length - 1;
      const k = last ? 1 - (1 - this.popT) ** 3 : 1;
      ctx.save();
      ctx.translate(cx + cw * 0.75, cy - (last ? (1 - k) * 40 * sc : 0));
      ctx.rotate(((id * 37) % 30 - 15) * (Math.PI / 180));
      ctx.scale(last ? 1.25 - 0.25 * k : 1, last ? 1.25 - 0.25 * k : 1);
      this.drawCard(card(id), 0, 0, cw);
      ctx.restore();
    });
    if (top(g).color === null) {
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${16 * sc}px system-ui, sans-serif`;
      ctx.fillText(`colour: ${COLOR_NAME[g.color]}`, cx + cw * 0.75, cy + cw * 0.95);
    }

    // players round the table
    const n = g.players.length;
    const rx = Math.min(w * 0.4, w / 2 - 130 * sc);
    const ry = Math.min(h * 0.36, h / 2 - 90 * sc);
    g.players.forEach((_, i) => {
      // seat 0 at the bottom, going clockwise in play order
      const a = Math.PI / 2 + (i / n) * Math.PI * 2;
      const px = cx + Math.cos(a) * rx;
      const py = cy + Math.sin(a) * ry;
      this.drawSeat(g, i, px, py);
    });

    // last move
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `700 ${20 * sc}px system-ui, sans-serif`;
    ctx.lineWidth = 4 * sc;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.fillStyle = '#fff';
    ctx.strokeText(g.log, cx, 44 * sc);
    ctx.fillText(g.log, cx, 44 * sc);

    if (this.state === 'over' && g.winner !== null) {
      const name = g.players[g.winner].name;
      this.banner([
        [`${name} wins!`, 60, '#ffe066'],
        [`+${this.lastPoints} points  ·  ${g.players.map((p) => `${p.name} ${this.totals.get(p.pid) ?? 0}`).join('  ·  ')}`, 22, '#fff'],
        ['Press "Next round" on any phone (or Space). New players: scan the QR code', 22, 'rgba(255,255,255,0.85)'],
      ]);
    } else if (this.state === 'paused') {
      this.banner([
        ['PAUSED', 64, '#fff'],
        ['Press P to carry on', 24, 'rgba(255,255,255,0.8)'],
      ]);
    }
  }

  private drawSeat(g: Uno, i: number, x: number, y: number): void {
    const { ctx } = this;
    const sc = this.sc;
    const p = g.players[i];
    const active = i === g.turn && this.state === 'playing';
    const away = !this.connected.has(p.pid);
    const bw = 170 * sc;
    const bh = 58 * sc;

    // fanned card backs above the name
    const shown = Math.min(p.hand.length, 12);
    const cw = 34 * sc;
    for (let k = 0; k < shown; k++) {
      const t = shown === 1 ? 0 : k / (shown - 1) - 0.5;
      ctx.save();
      ctx.translate(x + t * Math.min(shown * 11, 120) * sc, y - bh * 0.55 + Math.abs(t) * 6 * sc);
      ctx.rotate(t * 0.6);
      this.drawBack(0, 0, cw);
      ctx.restore();
    }

    ctx.fillStyle = active ? 'rgba(255,224,102,0.95)' : 'rgba(0,0,0,0.45)';
    if (active) {
      ctx.shadowColor = '#ffe066';
      ctx.shadowBlur = 24 * sc * (0.6 + 0.4 * Math.sin(performance.now() / 200));
    }
    this.roundRect(x - bw / 2, y, bw, bh, 14 * sc);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = active ? '#1a1a1a' : '#fff';
    ctx.font = `800 ${19 * sc}px system-ui, sans-serif`;
    ctx.fillText((active ? '▶ ' : '') + p.name, x, y + 24 * sc);
    ctx.font = `600 ${14 * sc}px system-ui, sans-serif`;
    ctx.fillStyle = active ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.75)';
    const info = `${p.hand.length} card${p.hand.length === 1 ? '' : 's'}  ·  ${this.totals.get(p.pid) ?? 0} pts`;
    ctx.fillText(away ? 'phone away…' : info, x, y + 45 * sc);

    if (p.hand.length === 1 && g.winner === null) {
      ctx.save();
      ctx.translate(x + bw / 2 - 6 * sc, y - 4 * sc);
      ctx.rotate(-0.2);
      ctx.fillStyle = '#e5383b';
      this.roundRect(-30 * sc, -14 * sc, 60 * sc, 28 * sc, 8 * sc);
      ctx.fill();
      ctx.fillStyle = '#ffe066';
      ctx.font = `900 ${17 * sc}px system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillText('UNO!', 0, 1);
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------- cards
  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** A card face centred on (x, y), `cw` wide. */
  private drawCard(c: Card, x: number, y: number, cw: number): void {
    const { ctx } = this;
    const ch = cw * 1.5;
    ctx.save();
    ctx.translate(x, y);
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = cw * 0.12;
    ctx.shadowOffsetY = cw * 0.04;
    ctx.fillStyle = '#fff';
    this.roundRect(-cw / 2, -ch / 2, cw, ch, cw * 0.1);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    const m = cw * 0.06;
    ctx.fillStyle = c.color ? HEX[c.color] : '#1b1b1b';
    this.roundRect(-cw / 2 + m, -ch / 2 + m, cw - 2 * m, ch - 2 * m, cw * 0.07);
    ctx.fill();

    // the tilted white oval, or four colours for a wild
    ctx.save();
    ctx.rotate(-0.5);
    ctx.beginPath();
    ctx.ellipse(0, 0, cw * 0.36, cw * 0.58, 0, 0, Math.PI * 2);
    if (c.color) {
      ctx.fillStyle = '#fff';
      ctx.fill();
    } else {
      ctx.clip();
      COLORS.forEach((col, i) => {
        ctx.fillStyle = HEX[col];
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, cw, (i * Math.PI) / 2, ((i + 1) * Math.PI) / 2);
        ctx.fill();
      });
    }
    ctx.restore();

    const text = label(c);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${cw * (text.length > 1 ? 0.36 : 0.48)}px system-ui, sans-serif`;
    ctx.lineWidth = cw * 0.05;
    ctx.strokeStyle = c.color ? 'rgba(0,0,0,0.25)' : '#000';
    ctx.fillStyle = c.color ? HEX[c.color] : '#fff';
    ctx.strokeText(text, 0, cw * 0.02);
    ctx.fillText(text, 0, cw * 0.02);
    ctx.font = `800 ${cw * 0.16}px system-ui, sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.fillText(text, -cw * 0.3, -ch * 0.37);
    ctx.save();
    ctx.rotate(Math.PI);
    ctx.fillText(text, -cw * 0.3, -ch * 0.37);
    ctx.restore();
    ctx.restore();
  }

  /** The back of a card centred on (x, y). */
  private drawBack(x: number, y: number, cw: number): void {
    const { ctx } = this;
    const ch = cw * 1.5;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = cw * 0.1;
    this.roundRect(-cw / 2, -ch / 2, cw, ch, cw * 0.1);
    ctx.fill();
    ctx.shadowBlur = 0;
    const m = cw * 0.06;
    ctx.fillStyle = '#1b1b1b';
    this.roundRect(-cw / 2 + m, -ch / 2 + m, cw - 2 * m, ch - 2 * m, cw * 0.07);
    ctx.fill();
    ctx.rotate(-0.5);
    ctx.fillStyle = '#e5383b';
    ctx.beginPath();
    ctx.ellipse(0, 0, cw * 0.34, cw * 0.56, 0, 0, Math.PI * 2);
    ctx.fill();
    if (cw > 40) {
      ctx.fillStyle = '#ffe066';
      ctx.font = `900 italic ${cw * 0.28}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('UNO', 0, 0);
    }
    ctx.restore();
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
      ctx.font = `800 ${size * sc}px system-ui, sans-serif`;
      ctx.fillStyle = color;
      ctx.strokeText(text, w / 2, y);
      ctx.fillText(text, w / 2, y);
      y += (size + 22) * sc;
    }
  }
}
