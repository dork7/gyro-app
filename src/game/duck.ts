// Duck Shoot: the classic light-gun game with the phone as the gun. Point the top edge
// at the screen to aim, press FIRE on the phone to shoot.
//
// Ducks come two at a time and you have three shells for each pair. A round is ten ducks;
// hit enough of them (six in round 1, one more each round) to go on. Blue ducks are fast,
// gold ones are rare and very fast. The dog shows what you got, or laughs at you.

import { DUCK_R, DUCKS_PER_ROUND, DUCKS_PER_WAVE, escape, GRASS_Y, needed, points, SHELLS_PER_WAVE, shoot, spawnDuck, stepDuck, type Duck, type DuckKind } from '../shared/duck';
import type { GameState } from '../shared/protocol';
import type { Sfx } from './audio';
import type { GameHooks, Scene } from './scene';

const INTRO_TIME = 1.6;
const DOG_TIME = 1.5;
const ROUND_END_TIME = 2.4;
const PERFECT_BONUS = 10000;
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
const COLORS: Record<DuckKind, { body: string; head: string; wing: string }> = {
  green: { body: '#8a5a3c', head: '#1f7a3a', wing: '#5c3a26' },
  blue: { body: '#3e6fd8', head: '#1d3f8f', wing: '#2a4fa8' },
  gold: { body: '#f2c230', head: '#d99a00', wing: '#c48a00' },
};

type Phase = 'intro' | 'wave' | 'dog' | 'roundEnd';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class DuckGame implements Scene {
  readonly title = 'Duck Shoot';
  readonly subtitle = 'Your phone is the gun. Aim, then press FIRE.';
  state: GameState = 'menu';
  score = 0;
  best = 0;
  lives = SHELLS_PER_WAVE; // shells left, shown on the phone

  private ctx: CanvasRenderingContext2D;
  private w = 800;
  private h = 600;
  private sc = 1;

  private round = 1;
  private phase: Phase = 'intro';
  private phaseT = 0;
  private ducks: Duck[] = [];
  private results: (boolean | null)[] = []; // per duck of the round: hit, missed, or still to come
  private next = 0; // index of the next duck of the round
  private shells = SHELLS_PER_WAVE;
  private waveHits = 0;
  private perfect = false;

  // aim, in screen pixels
  private ax = 400;
  private ay = 300;
  private flash = 0;
  private kick = 0;
  private clouds = [0.1, 0.45, 0.8].map((x, i) => ({ x, y: 0.1 + i * 0.07, s: 0.8 + i * 0.25 }));
  private pops: { x: number; y: number; text: string; life: number }[] = [];
  private lastFrame = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private sfx: Sfx,
    private hooks: GameHooks,
  ) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('Canvas 2D is not available');
    this.ctx = c;
    try {
      this.best = Number(localStorage.getItem('bestDuck') ?? 0) || 0;
    } catch {
      /* ignore */
    }
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // ---------------------------------------------------------------- scene API
  enter(): void {
    this.resize();
    this.lastFrame = 0;
    this.ducks = [];
    this.pops = [];
    this.results = [];
    this.setState('menu');
  }

  requestStart(): void {
    if (this.state === 'menu' || this.state === 'over') this.startRun();
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

  // ---------------------------------------------------------------- input
  aim(x: number, y: number): void {
    this.ax = clamp(x, 0, this.w);
    this.ay = clamp(y, 0, this.h);
  }

  /** Pull the trigger. In the menu or after a game over it starts a new game. */
  fire(): void {
    if (this.state === 'menu' || this.state === 'over') {
      this.startRun();
      return;
    }
    if (this.state !== 'playing' || this.phase !== 'wave' || this.shells <= 0) return;
    this.shells--;
    this.lives = this.shells;
    this.flash = 1;
    this.kick = 1;
    this.sfx.shot();
    this.hooks.onHaptic(25);
    const x = this.ax / this.h;
    const y = this.ay / this.h;
    for (const d of this.ducks) {
      if (!shoot(d, x, y)) continue;
      const pts = points(d.kind, this.round);
      this.score += pts;
      this.waveHits++;
      this.results[this.results.indexOf(null)] = true;
      this.pops.push({ x: d.x, y: d.y - DUCK_R * 1.5, text: String(pts), life: 1 });
      this.sfx.quack();
    }
    if (this.shells === 0) for (const d of this.ducks) escape(d); // out of shells: the rest fly off
    this.hooks.onChange();
  }

  // ---------------------------------------------------------------- setup
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

  private setState(s: GameState): void {
    this.state = s;
    document.body.dataset.state = s;
    this.hooks.onChange();
  }

  private startRun(): void {
    this.score = 0;
    this.round = 1;
    this.sfx.start();
    this.setState('playing');
    this.startRound();
  }

  private startRound(): void {
    this.results = new Array(DUCKS_PER_ROUND).fill(null);
    this.next = 0;
    this.ducks = [];
    this.setPhase('intro');
  }

  private setPhase(p: Phase): void {
    this.phase = p;
    this.phaseT = 0;
  }

  private startWave(): void {
    const n = Math.min(DUCKS_PER_WAVE, DUCKS_PER_ROUND - this.next);
    this.ducks = Array.from({ length: n }, () => spawnDuck(this.w / this.h, this.round, Math.random));
    this.next += n;
    this.shells = SHELLS_PER_WAVE;
    this.lives = this.shells;
    this.waveHits = 0;
    this.setPhase('wave');
    this.sfx.quack();
    this.hooks.onChange();
  }

  private gameOver(): void {
    if (this.score > this.best) {
      this.best = this.score;
      try {
        localStorage.setItem('bestDuck', String(this.best));
      } catch {
        /* ignore */
      }
    }
    this.setState('over');
  }

  // ---------------------------------------------------------------- update
  private update(dt: number): void {
    this.flash = Math.max(0, this.flash - dt * 10);
    this.kick = Math.max(0, this.kick - dt * 6);
    for (const c of this.clouds) c.x = (c.x + dt * 0.004 * c.s) % 1.2;
    if (this.state === 'paused') return;
    for (const p of this.pops) {
      p.life -= dt;
      p.y -= dt * 0.05;
    }
    this.pops = this.pops.filter((p) => p.life > 0);
    if (this.state !== 'playing') return;

    this.phaseT += dt;
    const aspect = this.w / this.h;
    switch (this.phase) {
      case 'intro':
        if (this.phaseT >= INTRO_TIME) this.startWave();
        break;
      case 'wave': {
        for (const d of this.ducks) {
          const was = d.state;
          stepDuck(d, dt, aspect, Math.random);
          if (was === 'fly' && d.state === 'escape') this.sfx.quack();
        }
        if (this.ducks.every((d) => d.state === 'gone')) {
          // ducks that got away count as misses
          const missed = this.ducks.length - this.waveHits;
          for (let k = 0; k < missed; k++) this.results[this.results.indexOf(null)] = false;
          this.setPhase('dog');
          if (this.waveHits === 0) this.sfx.miss();
          else this.sfx.coin();
        }
        break;
      }
      case 'dog':
        if (this.phaseT >= DOG_TIME) {
          if (this.next < DUCKS_PER_ROUND) this.startWave();
          else this.endRound();
        }
        break;
      case 'roundEnd':
        if (this.phaseT >= ROUND_END_TIME) {
          this.round++;
          this.startRound();
          this.hooks.onChange();
        }
        break;
    }
  }

  private endRound(): void {
    const hits = this.results.filter((r) => r === true).length;
    if (hits < needed(this.round)) {
      this.sfx.crash();
      this.gameOver();
      return;
    }
    this.perfect = hits === DUCKS_PER_ROUND;
    if (this.perfect) this.score += PERFECT_BONUS;
    this.sfx.combo();
    this.setPhase('roundEnd');
    this.hooks.onChange();
  }

  // ---------------------------------------------------------------- render
  private render(): void {
    const { ctx, w, h } = this;
    const U = h; // world units -> pixels
    const sky = ctx.createLinearGradient(0, 0, 0, h * GRASS_Y);
    sky.addColorStop(0, '#5aa9ff');
    sky.addColorStop(1, '#bfe3ff');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // clouds
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (const c of this.clouds) {
      const x = (c.x - 0.1) * w;
      const y = c.y * h;
      const r = 34 * this.sc * c.s;
      ctx.beginPath();
      ctx.ellipse(x, y, r * 1.8, r * 0.7, 0, 0, Math.PI * 2);
      ctx.ellipse(x - r, y + r * 0.15, r, r * 0.6, 0, 0, Math.PI * 2);
      ctx.ellipse(x + r * 0.8, y - r * 0.3, r * 1.1, r * 0.75, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // far hills and a tree
    ctx.fillStyle = '#8cc97a';
    ctx.beginPath();
    ctx.moveTo(0, h * GRASS_Y);
    for (let x = 0; x <= w; x += 20) ctx.lineTo(x, h * (GRASS_Y - 0.06 - 0.04 * Math.sin(x / w * 7 + 1)));
    ctx.lineTo(w, h * GRASS_Y);
    ctx.fill();
    const tx = w * 0.12;
    ctx.fillStyle = '#6b4a2b';
    ctx.fillRect(tx - 14 * this.sc, h * (GRASS_Y - 0.32), 28 * this.sc, h * 0.34);
    ctx.fillStyle = '#3f8f3a';
    for (const [dx, dy, r] of [[0, -0.42, 0.12], [-0.07, -0.35, 0.09], [0.07, -0.34, 0.09], [0, -0.3, 0.1]]) {
      ctx.beginPath();
      ctx.arc(tx + dx * h, h * (GRASS_Y + dy), r * h, 0, Math.PI * 2);
      ctx.fill();
    }

    // ducks (behind the grass, so they rise out of it and fall into it)
    for (const d of this.ducks) if (d.state !== 'gone') this.drawDuck(d, d.x * U, d.y * U);

    // the dog pops up between waves
    if (this.state === 'playing' && this.phase === 'dog') this.drawDog();

    // grass
    ctx.fillStyle = '#3e9b3a';
    ctx.fillRect(0, h * GRASS_Y, w, h * (1 - GRASS_Y));
    ctx.fillStyle = '#2f7f2c';
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w + 12; x += 12 * this.sc) {
      const tip = h * GRASS_Y - (10 + 14 * Math.abs(Math.sin(x * 0.37))) * this.sc;
      ctx.lineTo(x, tip);
      ctx.lineTo(x + 6 * this.sc, h * GRASS_Y + 6 * this.sc);
    }
    ctx.lineTo(w, h);
    ctx.fill();

    // floating points
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `800 ${22 * this.sc}px system-ui, sans-serif`;
    ctx.lineWidth = 4 * this.sc;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    for (const p of this.pops) {
      ctx.globalAlpha = Math.min(1, p.life * 2);
      ctx.fillStyle = '#fff';
      ctx.strokeText(p.text, p.x * U, p.y * U);
      ctx.fillText(p.text, p.x * U, p.y * U);
    }
    ctx.globalAlpha = 1;

    this.drawHud();
    this.drawBanner();
    this.drawCrosshair();

    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${this.flash * 0.35})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  private drawDuck(d: Duck, x: number, y: number): void {
    const { ctx } = this;
    const r = DUCK_R * this.h;
    const c = COLORS[d.kind];
    const flap = Math.sin(performance.now() / (d.kind === 'gold' ? 45 : 70));
    ctx.save();
    ctx.translate(x, y);
    if (d.state === 'fall') ctx.rotate(Math.PI / 2 + Math.sin(d.t * 18) * 0.25);
    const face = d.vx < 0 ? -1 : 1;
    ctx.scale(face, 1);
    // body
    ctx.fillStyle = c.body;
    ctx.beginPath();
    ctx.ellipse(-r * 0.1, r * 0.1, r * 0.85, r * 0.5, d.state === 'escape' ? -0.6 : -0.15, 0, Math.PI * 2);
    ctx.fill();
    // tail
    ctx.beginPath();
    ctx.moveTo(-r * 0.85, 0);
    ctx.lineTo(-r * 1.25, -r * 0.25);
    ctx.lineTo(-r * 1.1, r * 0.25);
    ctx.closePath();
    ctx.fill();
    // head and white neck ring
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(r * 0.6, -r * 0.3, r * 0.36, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = c.head;
    ctx.beginPath();
    ctx.arc(r * 0.68, -r * 0.42, r * 0.34, 0, Math.PI * 2);
    ctx.fill();
    // beak
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(r * 0.95, -r * 0.45);
    ctx.lineTo(r * 1.35, -r * 0.35);
    ctx.lineTo(r * 0.95, -r * 0.25);
    ctx.closePath();
    ctx.fill();
    // eye: wide open when hit
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(r * 0.78, -r * 0.5, r * (d.state === 'hit' ? 0.14 : 0.09), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(r * 0.8, -r * 0.5, r * 0.05, 0, Math.PI * 2);
    ctx.fill();
    // wing
    if (d.state === 'fly' || d.state === 'escape') {
      ctx.fillStyle = c.wing;
      ctx.beginPath();
      ctx.moveTo(-r * 0.5, -r * 0.05);
      ctx.lineTo(r * 0.25, -r * 0.05);
      ctx.lineTo(-r * 0.25, -r * 0.05 - flap * r * 0.95);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    if (d.kind === 'gold' && (d.state === 'fly' || d.state === 'escape')) {
      ctx.fillStyle = `rgba(255,230,120,${0.25 + 0.2 * Math.sin(performance.now() / 90)})`;
      ctx.beginPath();
      ctx.arc(x, y, r * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawDog(): void {
    const { ctx, w, h } = this;
    const t = this.phaseT / DOG_TIME;
    const rise = Math.sin(Math.min(1, t) * Math.PI); // up, then back down
    const size = 110 * this.sc;
    const x = w / 2;
    const y = h * GRASS_Y + size * 0.5 - rise * size * 0.95;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${size}px ${EMOJI_FONT}`;
    const laughing = this.waveHits === 0;
    ctx.save();
    if (laughing) ctx.translate(Math.sin(performance.now() / 50) * 4 * this.sc, 0);
    ctx.fillText('🐕', x, y);
    ctx.restore();
    if (laughing) {
      ctx.font = `800 ${26 * this.sc}px system-ui, sans-serif`;
      ctx.fillStyle = '#fff';
      ctx.lineWidth = 5 * this.sc;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.strokeText('HA HA!', x, y - size * 0.75);
      ctx.fillText('HA HA!', x, y - size * 0.75);
    } else {
      ctx.font = `${size * 0.45}px ${EMOJI_FONT}`;
      for (let i = 0; i < this.waveHits; i++) ctx.fillText('🦆', x + (i - (this.waveHits - 1) / 2) * size * 0.5, y - size * 0.55);
    }
  }

  private drawCrosshair(): void {
    const { ctx } = this;
    const r = 24 * this.sc * (1 + this.kick * 0.35);
    const x = this.ax;
    const y = this.ay - this.kick * 10 * this.sc;
    ctx.lineWidth = 3 * this.sc;
    for (const [color, width] of [['rgba(0,0,0,0.45)', 6], ['#ff3b30', 3]] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width * this.sc;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.moveTo(x - r * 1.5, y);
      ctx.lineTo(x - r * 0.4, y);
      ctx.moveTo(x + r * 0.4, y);
      ctx.lineTo(x + r * 1.5, y);
      ctx.moveTo(x, y - r * 1.5);
      ctx.lineTo(x, y - r * 0.4);
      ctx.moveTo(x, y + r * 0.4);
      ctx.lineTo(x, y + r * 1.5);
      ctx.stroke();
    }
    ctx.fillStyle = '#ff3b30';
    ctx.beginPath();
    ctx.arc(x, y, 3 * this.sc, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawHud(): void {
    const { ctx, w, h } = this;
    const sc = this.sc;
    const pad = 24 * sc;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.lineWidth = 5 * sc;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${46 * sc}px system-ui, sans-serif`;
    ctx.strokeText(String(this.score), pad, pad + 38 * sc);
    ctx.fillText(String(this.score), pad, pad + 38 * sc);
    ctx.font = `600 ${18 * sc}px system-ui, sans-serif`;
    const sub = this.state === 'menu' ? `BEST ${this.best}` : `ROUND ${this.round}   ·   BEST ${this.best}`;
    ctx.strokeText(sub, pad, pad + 66 * sc);
    ctx.fillText(sub, pad, pad + 66 * sc);
    if (this.state === 'menu') return;

    // bottom bar: shells, the ten ducks of the round, and how many are needed
    const barH = 58 * sc;
    const y = h - pad - barH;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.roundRect(pad, y, w - 2 * pad, barH, 12 * sc);
    ctx.fill();
    const cy = y + barH / 2;
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${15 * sc}px system-ui, sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.fillText('SHOT', pad + 16 * sc, cy);
    for (let i = 0; i < SHELLS_PER_WAVE; i++) {
      ctx.fillStyle = i < this.shells ? '#e63946' : 'rgba(255,255,255,0.2)';
      ctx.beginPath();
      ctx.roundRect(pad + 70 * sc + i * 20 * sc, cy - 13 * sc, 12 * sc, 26 * sc, 4 * sc);
      ctx.fill();
      if (i < this.shells) {
        ctx.fillStyle = '#d4a017';
        ctx.fillRect(pad + 70 * sc + i * 20 * sc, cy + 6 * sc, 12 * sc, 7 * sc);
      }
    }
    const x0 = pad + 160 * sc;
    ctx.fillStyle = '#fff';
    ctx.fillText('HIT', x0, cy);
    const need = needed(this.round);
    for (let i = 0; i < DUCKS_PER_ROUND; i++) {
      const r = this.results[i];
      const x = x0 + 50 * sc + i * 30 * sc;
      ctx.fillStyle = r === true ? '#ff6b6b' : r === false ? 'rgba(255,255,255,0.18)' : '#fff';
      ctx.beginPath();
      ctx.arc(x, cy - 4 * sc, 9 * sc, 0, Math.PI * 2);
      ctx.fill();
      if (i < need) {
        ctx.fillStyle = '#7fe7ff';
        ctx.fillRect(x - 10 * sc, cy + 12 * sc, 20 * sc, 3 * sc); // the bar under the ducks you need
      }
    }
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(`hit ${need} of ${DUCKS_PER_ROUND} to go on`, w - pad - 16 * sc, cy);
  }

  private drawBanner(): void {
    const { ctx, w, h } = this;
    const sc = this.sc;
    const lines: [string, number, string][] = [];
    if (this.state === 'menu') {
      lines.push(['Point the phone at the screen like a gun, press Centre', 24, '#fff']);
      lines.push(['Then press FIRE on your phone (or click) to start', 30, '#ffe066']);
    } else if (this.state === 'over') {
      lines.push(['GAME OVER', 64, '#ff6b6b']);
      lines.push([`Score ${this.score}   ·   Round ${this.round}   ·   Best ${this.best}`, 30, '#fff']);
      lines.push(['Press FIRE to play again', 26, '#ffe066']);
    } else if (this.state === 'paused') {
      lines.push(['PAUSED', 64, '#fff']);
      lines.push(['Press P, or Resume on your phone', 24, 'rgba(255,255,255,0.8)']);
    } else if (this.phase === 'intro') {
      lines.push([`ROUND ${this.round}`, 64, '#fff']);
      lines.push([`Hit ${needed(this.round)} of ${DUCKS_PER_ROUND} ducks`, 26, '#ffe066']);
    } else if (this.phase === 'roundEnd') {
      lines.push([this.perfect ? 'PERFECT!' : 'ROUND CLEAR', 60, '#7be495']);
      if (this.perfect) lines.push([`+${PERFECT_BONUS} bonus`, 30, '#ffe066']);
    } else {
      return;
    }
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fillRect(0, h * 0.3 - 40 * sc, w, 60 * sc + lines.length * 52 * sc);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 5 * sc;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    let y = h * 0.3 + 14 * sc;
    for (const [text, size, color] of lines) {
      ctx.font = `800 ${size * sc}px system-ui, sans-serif`;
      ctx.fillStyle = color;
      ctx.strokeText(text, w / 2, y);
      ctx.fillText(text, w / 2, y);
      y += (size + 22) * sc;
    }
  }
}
