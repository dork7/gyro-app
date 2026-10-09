// Phonics: the laptop says a sound out loud and shows four letters (or letter groups).
// Point the phone at the one that makes that sound and hold still on it until the ring
// fills. A wrong one fades out and the sound is said again with a hint ("like apple").
// Ten sounds make a round. The sounds come in three sets that follow Read Write Inc.
// (see shared/phonics.ts); pick the set on the start screen the same way as a letter.
//
// Pointer position comes from the same gyro aim mapping as the blade (see main.ts);
// the mouse works too (hover and hold, or click).
// Score per sound: 10 on the first guess, then 6, 3, 1.
// Press Start while playing to hear the sound again.
//
// The voice is the browser's built-in speech (speechSynthesis); the five short vowels,
// which it cannot say, are short human recordings in public/phonics.
// Press V to try the next voice.

import { hintFor, makeChoices, makeRound, pointsFor, SETS, SOUNDS, type SoundSet } from '../shared/phonics';
import type { GameState } from '../shared/protocol';
import type { Sfx } from './audio';
import type { GameHooks, Scene } from './scene';

const ROUND = 10;
const CHOICES = 4;
const DWELL = 0.9; // seconds the pointer must rest on a letter to pick it
const REPEAT = 7; // seconds of no answer before the sound is said again
const COLORS = ['#ff9f1c', '#78dcff', '#7be495', '#ff8fab'];
const SAMPLES = ['m a s', 'ay ee igh', 'ea oi a-e']; // shown under each set on the picker
const ROUNDED = 'ui-rounded, "Arial Rounded MT Bold", system-ui, sans-serif';
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Font size (as a share of the bubble radius) that fits a sound of 1 to 5 letters. */
const fit = (letter: string) => [1.25, 0.95, 0.72, 0.58, 0.48][Math.min(letter.length, 5) - 1]!;

// The most human-sounding voice the browser offers wins: Edge's "Natural" voices, then
// Apple's downloadable Premium and Enhanced voices, then Chrome's Google voices. The
// plain built-in ones (Daniel, Samantha) are the fallback. British is preferred within
// each tier, to match the Read Write Inc. reference.
// V cycles through the others while the game is open; the choice is remembered.
const HUMAN = [/\bNatural\b/, /\(Premium\)/, /\(Enhanced\)/, /^Google UK English Female/, /^Google US English/];
const CLEAR = ['Daniel', 'Microsoft Sonia', 'Microsoft Libby', 'Karen', 'Samantha'];
// macOS ships joke voices (bells, robots, whispers) under English: never offer those.
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Junior|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Ralph|Kathy)\b/;

function englishVoices(): SpeechSynthesisVoice[] {
  if (!('speechSynthesis' in window)) return [];
  return window.speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en') && !NOVELTY.test(v.name));
}

function pickVoice(saved: string | null): SpeechSynthesisVoice | null {
  const en = englishVoices();
  const kept = en.find((v) => v.name === saved);
  if (kept) return kept;
  // Asked-for voices win when the browser offers them: Gemma, then Siri (most browsers
  // offer neither: Apple keeps the Siri voices to itself).
  const wanted = en.find((v) => /gemma/i.test(v.name)) ?? en.find((v) => /siri/i.test(v.name));
  if (wanted) return wanted;
  for (const tier of HUMAN) {
    const hits = en.filter((v) => tier.test(v.name));
    const v = hits.find((x) => x.lang.replace('_', '-') === 'en-GB') ?? hits.find((x) => x.lang.replace('_', '-') === 'en-US') ?? hits[0];
    if (v) return v;
  }
  for (const name of CLEAR) {
    const v = en.find((x) => x.name.startsWith(name));
    if (v) return v;
  }
  return en.find((v) => v.lang === 'en-GB') ?? en[0] ?? null;
}

interface P {
  x: number;
  y: number;
}
interface Bubble {
  letter: number; // index into SOUNDS
  x: number;
  y: number;
  wrong: boolean;
  shake: number; // seconds of shake left
}
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

export class PhonicsGame implements Scene {
  readonly title = 'Phonics';
  readonly subtitle = 'Listen to the sound, then point at its letter.';
  state: GameState = 'menu';
  score = 0;
  best = 0;
  /** Sounds still to guess (shown as "Sounds left" on the phone). */
  lives = ROUND;
  /** Which Read Write Inc. set the round is drawn from. */
  level: SoundSet = 1;

  private ctx: CanvasRenderingContext2D;
  private w = 800;
  private h = 600;
  private lastFrame = 0;
  private time = 0;

  // the sound being asked
  private order: number[] = [];
  private idx = 0;
  private bubbles: Bubble[] = [];
  private tries = 0;
  private phase: 'asking' | 'right' = 'asking';
  private doneT = 0;
  private askIn = 0; // seconds until the sound is said (again)
  private talkT = 0; // speaker animation
  private voiceNoteT = 0; // seconds the voice name stays on screen after V
  private R = 80; // bubble radius in px

  // pointer
  private target: P | null = null;
  private pen: P | null = null;
  private hover = -1;
  private dwell = 0;

  // round
  private stars: number[] = []; // per sound: 0 = not done, 1-3
  private particles: Particle[] = [];
  private overAt = -10;
  private voice: SpeechSynthesisVoice | null = null;
  private savedVoice: string | null = null;
  private clipEl: HTMLAudioElement | null = null;
  private clipBad = false; // a recorded clip would not play: say the word instead

  constructor(
    private canvas: HTMLCanvasElement,
    private sfx: Sfx,
    private hooks: GameHooks,
  ) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('Canvas 2D is not available');
    this.ctx = c;
    try {
      this.best = Number(localStorage.getItem('bestPhonics') ?? 0) || 0;
      this.level = SETS.find((x) => String(x) === localStorage.getItem('phonicsSet')) ?? 1;
      this.savedVoice = localStorage.getItem('phonicsVoice');
    } catch {
      /* ignore */
    }
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // ---------------------------------------------------------------- scene API
  enter(): void {
    this.resize();
    this.idx = 0;
    this.order = [];
    this.bubbles = [];
    this.stars = [];
    this.score = 0;
    this.lives = ROUND;
    this.particles = [];
    this.lastFrame = 0;
    this.hover = -1;
    this.setState('menu');
  }

  exit(): void {
    this.target = null;
    this.hush();
  }

  /** Start / play again / resume; while playing it says the sound again. */
  requestStart(): void {
    if (this.state === 'menu' || this.state === 'over') {
      if (this.state === 'over' && this.time - this.overAt < 0.8) return;
      this.startRound();
    } else if (this.state === 'paused') this.togglePause();
    else if (this.state === 'playing' && this.phase === 'asking') this.askIn = 0;
  }

  togglePause(): void {
    if (this.state === 'playing') {
      this.hush();
      this.setState('paused');
    } else if (this.state === 'paused') {
      this.askIn = Math.min(this.askIn, 0.4);
      this.setState('playing');
    }
  }

  /** Pointer position in screen pixels (from the phone's aim, or the mouse). */
  penMove(x: number, y: number, _now: number): void {
    this.target = { x: clamp(x, 0, this.w), y: clamp(y, 0, this.h) };
  }

  /** Mouse click: pick the letter (or, before a round, the set) under it straight away. */
  click(x: number, y: number): void {
    this.target = { x, y };
    this.pen = { x, y };
    if (this.picking) {
      const k = this.levelAt(this.pen);
      if (k >= 0) this.setLevel(k);
      return;
    }
    if (this.state !== 'playing' || this.phase !== 'asking') return;
    const i = this.bubbleAt(this.pen);
    if (i >= 0) this.pick(i);
  }

  tick(t: number): void {
    const dt = Math.min(0.05, this.lastFrame ? (t - this.lastFrame) / 1000 : 0.016);
    this.lastFrame = t;
    this.update(dt);
    this.render();
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
    this.layout();
  }

  /** Letters sit in a row across the middle of the screen. */
  private layout(): void {
    const n = Math.max(1, this.bubbles.length);
    this.R = clamp(Math.min(this.w / (n * 2.6 + 0.6), this.h * 0.13), 36, 120);
    const gap = this.R * 2.6;
    const x0 = this.w / 2 - (gap * (n - 1)) / 2;
    this.bubbles.forEach((b, i) => {
      b.x = x0 + i * gap;
      b.y = this.h * 0.62;
    });
  }

  // ---------------------------------------------------------------- set picker
  /** The set picker is on screen before a round and after one. */
  private get picking(): boolean {
    return this.state === 'menu' || this.state === 'over';
  }

  /** Where set `k` sits: right of the pairing card before a round, under the result after one. */
  private levelPos(k: number): P & { r: number } {
    const r = clamp(this.h * 0.07, 36, 64);
    const menu = this.state === 'menu';
    const mx = menu && this.w >= 1000 ? this.w * 0.62 : this.w / 2;
    return { x: mx + (k - 1) * r * 2.8, y: this.h * (menu ? 0.4 : 0.66), r };
  }

  private levelAt(p: P): number {
    return SETS.findIndex((_, k) => {
      const q = this.levelPos(k);
      return Math.hypot(q.x - p.x, q.y - p.y) <= q.r * 1.1;
    });
  }

  private setLevel(k: number): void {
    this.hover = -1;
    this.dwell = 0;
    if (SETS[k] === this.level) return;
    this.level = SETS[k]!;
    try {
      localStorage.setItem('phonicsSet', String(this.level));
    } catch {
      /* ignore */
    }
    this.sfx.pass();
    this.hooks.onHaptic(20);
  }

  private loadSound(i: number): void {
    this.bubbles = makeChoices(this.order[i]!, CHOICES).map((letter) => ({ letter, x: 0, y: 0, wrong: false, shake: 0 }));
    this.tries = 0;
    this.phase = 'asking';
    this.askIn = 0.6;
    this.hover = -1;
    this.dwell = 0;
    this.layout();
  }

  private setState(s: GameState): void {
    this.state = s;
    document.body.dataset.state = s;
    this.hooks.onChange();
  }

  private startRound(): void {
    this.score = 0;
    this.idx = 0;
    this.stars = [];
    this.lives = ROUND;
    this.particles = [];
    this.order = makeRound(ROUND, this.level);
    this.loadSound(0);
    this.sfx.start();
    this.setState('playing');
  }

  private get answer() {
    return SOUNDS[this.order[this.idx]!]!;
  }

  // ---------------------------------------------------------------- voice
  private speak(text: string): void {
    this.talkT = 1.6;
    if (this.sfx.muted || !('speechSynthesis' in window)) return;
    const synth = window.speechSynthesis;
    this.voice ??= pickVoice(this.savedVoice);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = this.voice?.lang ?? 'en-US';
    u.rate = 0.9;
    u.pitch = 1;
    if (this.voice) u.voice = this.voice;
    synth.cancel();
    synth.speak(u);
  }

  /** Play a recorded sound `times` times, then run `then`. False when clips cannot be used. */
  private playClip(name: string, times: number, then?: () => void): boolean {
    if (this.clipBad) return false;
    this.hush();
    this.talkT = 1.6;
    if (this.sfx.muted) return true;
    const el = new Audio(`/phonics/${name}.mp3`);
    this.clipEl = el;
    let left = times;
    const failed = () => {
      if (this.clipEl !== el) return;
      this.clipBad = true;
      this.askIn = 0; // ask again, this time with the word
    };
    el.onended = () => {
      if (this.clipEl !== el) return;
      if (--left > 0) setTimeout(() => this.clipEl === el && void el.play().catch(() => {}), 450);
      else then?.();
    };
    el.onerror = failed;
    el.play().catch((e: unknown) => {
      if ((e as { name?: string })?.name !== 'AbortError') failed();
    });
    return true;
  }

  private hush(): void {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    this.clipEl?.pause();
    this.clipEl = null;
    this.talkT = 0;
  }

  /** V key: switch to the next English voice, say who it is, and remember it. */
  nextVoice(): void {
    const en = englishVoices();
    if (!en.length) return;
    this.voice = en[(en.findIndex((v) => v.name === this.voice?.name) + 1) % en.length]!;
    this.savedVoice = this.voice.name;
    try {
      localStorage.setItem('phonicsVoice', this.savedVoice);
    } catch {
      /* ignore */
    }
    this.voiceNoteT = 3;
    const asking = this.state === 'playing' && this.phase === 'asking';
    if (asking) this.askIn = 0;
    else this.speak('Hello. I will say the sounds.');
  }

  /**
   * Say the sound twice; after a wrong guess add the word that starts with it.
   * Short vowels have no spelling the voice reads right: they use a recorded clip, or
   * failing that their word is said instead.
   */
  private ask(): void {
    const a = this.answer;
    this.hush();
    const hint = this.tries > 0 ? () => this.speak(`${hintFor(a)}.`) : undefined;
    if (a.clip && this.playClip(a.clip, 2, hint)) {
      /* the recording is playing */
    } else if (!a.say) this.speak(`${a.hint}. ${a.hint}.`);
    else this.speak(this.tries > 0 ? `${a.say}. ${a.say}. ${hintFor(a)}.` : `${a.say}. ${a.say}.`);
    this.askIn = REPEAT;
  }

  // ---------------------------------------------------------------- answering
  private bubbleAt(p: P): number {
    return this.bubbles.findIndex((b) => !b.wrong && Math.hypot(b.x - p.x, b.y - p.y) <= this.R * 1.1);
  }

  private pick(i: number): void {
    const b = this.bubbles[i]!;
    this.hover = -1;
    this.dwell = 0;
    if (b.letter !== this.order[this.idx]) {
      b.wrong = true;
      b.shake = 0.45;
      this.tries++;
      this.sfx.miss();
      this.hooks.onHaptic(60);
      this.askIn = 0.6;
      return;
    }
    this.score += pointsFor(this.tries);
    this.stars[this.idx] = this.tries === 0 ? 3 : this.tries === 1 ? 2 : 1;
    this.phase = 'right';
    this.doneT = 2.2;
    this.sfx.coin();
    this.hooks.onHaptic(30);
    this.speak(`Well done. ${this.answer.say ? `${this.answer.say}. ` : ''}${this.answer.hint}.`);
    for (let k = 0; k < 40; k++) {
      const a = Math.random() * Math.PI * 2;
      const v = (80 + Math.random() * 260) * (this.R / 80);
      this.particles.push({ x: b.x, y: b.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, life: 0.7 + Math.random() * 0.5, color: COLORS[k % COLORS.length]! });
    }
    this.hooks.onChange();
  }

  private next(): void {
    this.idx++;
    this.lives = ROUND - this.idx;
    if (this.idx >= ROUND) {
      if (this.score > this.best) {
        this.best = this.score;
        try {
          localStorage.setItem('bestPhonics', String(this.best));
        } catch {
          /* ignore */
        }
      }
      this.overAt = this.time;
      this.sfx.bowl();
      this.idx = ROUND - 1;
      this.bubbles = [];
      this.hover = -1;
      this.setState('over');
      return;
    }
    this.loadSound(this.idx);
    this.hooks.onChange();
  }

  // ---------------------------------------------------------------- update
  private update(dt: number): void {
    if (this.state === 'paused') return;
    this.time += dt;
    this.talkT = Math.max(0, this.talkT - dt);
    this.voiceNoteT = Math.max(0, this.voiceNoteT - dt);

    if (this.target) {
      if (!this.pen) this.pen = { ...this.target };
      const d = Math.hypot(this.target.x - this.pen.x, this.target.y - this.pen.y);
      const a = clamp(0.18 + d / Math.max(dt, 0.001) / 2500, 0.18, 0.85);
      this.pen = { x: this.pen.x + (this.target.x - this.pen.x) * a, y: this.pen.y + (this.target.y - this.pen.y) * a };
    }

    for (const b of this.bubbles) b.shake = Math.max(0, b.shake - dt);

    if (this.state === 'playing' && this.phase === 'asking') {
      this.askIn -= dt;
      if (this.askIn <= 0) this.ask();
      const over = this.pen ? this.bubbleAt(this.pen) : -1;
      if (over !== this.hover) {
        this.hover = over;
        this.dwell = 0;
      } else if (over >= 0) {
        this.dwell += dt;
        if (this.dwell >= DWELL) this.pick(over);
      }
    }

    if (this.picking) {
      const over = this.pen ? this.levelAt(this.pen) : -1;
      if (over !== this.hover) {
        this.hover = over;
        this.dwell = 0;
      } else if (over >= 0 && SETS[over] !== this.level) {
        this.dwell += dt;
        if (this.dwell >= DWELL) this.setLevel(over);
      }
    }

    if (this.state === 'playing' && this.phase === 'right') {
      this.doneT -= dt;
      if (this.doneT <= 0) this.next();
    }

    for (const p of this.particles) {
      p.vy += 500 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  // ---------------------------------------------------------------- drawing
  private render(): void {
    const c = this.ctx;
    const { w, h, R } = this;
    c.clearRect(0, 0, w, h);
    const bg = c.createRadialGradient(w / 2, h * 0.4, 0, w / 2, h * 0.4, Math.max(w, h) * 0.75);
    bg.addColorStop(0, '#1d3557');
    bg.addColorStop(1, '#0b1320');
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);
    c.textAlign = 'center';
    c.textBaseline = 'middle';

    if (this.state === 'menu') {
      this.intro();
    } else {
      this.speaker(w / 2, h * 0.26, clamp(h * 0.09, 40, 80));
      const right = this.phase === 'right' && this.state !== 'over';
      const a = this.answer;

      // word hint: after a wrong guess, and with the answer
      if (this.state !== 'over' && (this.tries > 0 || right)) {
        c.font = `${Math.round(R * 0.7)}px system-ui, sans-serif`;
        c.fillText(a.emoji, w / 2 + clamp(h * 0.09, 40, 80) * 2.2, h * 0.26);
      }

      this.bubbles.forEach((b, i) => {
        const win = right && b.letter === this.order[this.idx];
        const x = b.x + (b.shake > 0 ? Math.sin(b.shake * 60) * R * 0.12 : 0);
        const r = R * (win ? 1.15 + 0.05 * Math.sin(this.time * 10) : i === this.hover ? 1.06 : 1);
        c.globalAlpha = b.wrong || (right && !win) ? 0.22 : 1;
        c.fillStyle = COLORS[i % COLORS.length]!;
        c.beginPath();
        c.arc(x, b.y, r, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = '#10202e';
        const letter = SOUNDS[b.letter]!.letter;
        c.font = `800 ${Math.round(r * fit(letter))}px ${ROUNDED}`;
        c.fillText(letter, x, b.y - r * 0.06);
        c.globalAlpha = 1;
        if (i === this.hover && this.dwell > 0) {
          c.strokeStyle = '#fff';
          c.lineWidth = Math.max(5, R * 0.1);
          c.lineCap = 'round';
          c.beginPath();
          c.arc(x, b.y, r + c.lineWidth, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(this.dwell / DWELL, 0, 1));
          c.stroke();
        }
      });

      if (this.state !== 'over') {
        c.fillStyle = right ? '#7be495' : 'rgba(255,255,255,0.75)';
        c.font = `700 ${Math.round(clamp(w * 0.022, 18, 30))}px system-ui, sans-serif`;
        const line = right ? `${a.letter} · ${a.hint}` : this.tries > 0 ? `Listen again… ${hintFor(a)}` : a.say || (a.clip && !this.clipBad) ? 'Which one makes this sound?' : 'Which letter does this word start with?';
        c.fillText(line, w / 2, h * 0.62 + R * 1.75);
      }
    }

    for (const p of this.particles) {
      c.globalAlpha = clamp(p.life * 2, 0, 1);
      c.fillStyle = p.color;
      c.fillRect(p.x - 3, p.y - 3, 6, 6);
    }
    c.globalAlpha = 1;

    this.hud();

    if (this.pen) {
      c.strokeStyle = 'rgba(255,255,255,0.8)';
      c.lineWidth = 3;
      c.beginPath();
      c.arc(this.pen.x, this.pen.y, 16, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = '#fff';
      c.beginPath();
      c.arc(this.pen.x, this.pen.y, 5, 0, Math.PI * 2);
      c.fill();
    }
  }

  /** The speaker that "says" the sound, with rings while it talks. */
  private speaker(x: number, y: number, r: number): void {
    const c = this.ctx;
    if (this.talkT > 0) {
      for (let k = 0; k < 3; k++) {
        const f = (this.time * 1.4 + k / 3) % 1;
        c.strokeStyle = `rgba(120,220,255,${0.5 * (1 - f)})`;
        c.lineWidth = 4;
        c.beginPath();
        c.arc(x, y, r * (1 + f * 0.9), 0, Math.PI * 2);
        c.stroke();
      }
    }
    c.fillStyle = 'rgba(255,255,255,0.1)';
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#fff';
    c.font = `${Math.round(r * 1.05)}px system-ui, sans-serif`;
    c.fillText(this.talkT > 0 ? '🔊' : '🔈', x, y + r * 0.04);
  }

  /** Before the first round: what to do, drawn clear of the pairing card on wide screens. */
  private intro(): void {
    const c = this.ctx;
    const { w, h } = this;
    const mx = w >= 1000 ? w * 0.62 : w / 2;
    const r = this.levelPos(0).r;
    this.levels();
    const my = h * 0.4 + r * 2.7;
    c.fillStyle = '#fff';
    c.font = '700 22px system-ui, sans-serif';
    c.fillText('Pick a set, press Start, listen to the sound', mx, my);
    c.fillStyle = 'rgba(255,255,255,0.6)';
    c.font = '500 15px system-ui, sans-serif';
    c.fillText('Point the phone at the letter that makes it', mx, my + 28);
    c.fillText('and hold still until the ring fills.' + (this.best ? `  Best: ${this.best}` : ''), mx, my + 48);
    c.fillText(`Voice: ${this.voice?.name ?? pickVoice(this.savedVoice)?.name ?? 'browser default'} · press V to change`, mx, my + 76);
    if (!('speechSynthesis' in window)) {
      c.fillStyle = '#ff8fab';
      c.fillText('This browser cannot speak: try Chrome or Safari.', mx, my + 104);
    }
  }

  /** The three sets to choose from; the chosen one is ringed. */
  private levels(): void {
    const c = this.ctx;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    SETS.forEach((set, k) => {
      const { x, y, r } = this.levelPos(k);
      const on = set === this.level;
      c.globalAlpha = on || k === this.hover ? 1 : 0.5;
      c.fillStyle = COLORS[k]!;
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#10202e';
      c.font = `800 ${Math.round(r * 1.1)}px ${ROUNDED}`;
      c.fillText(String(set), x, y - r * 0.04);
      c.fillStyle = '#fff';
      c.font = `600 ${Math.round(clamp(r * 0.3, 13, 18))}px system-ui, sans-serif`;
      c.fillText(`${SAMPLES[k]}…`, x, y + r + 22);
      c.globalAlpha = 1;
      c.strokeStyle = '#fff';
      c.lineWidth = Math.max(4, r * 0.09);
      c.lineCap = 'round';
      if (on) {
        c.beginPath();
        c.arc(x, y, r + c.lineWidth, 0, Math.PI * 2);
        c.stroke();
      } else if (k === this.hover && this.dwell > 0) {
        c.beginPath();
        c.arc(x, y, r + c.lineWidth, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(this.dwell / DWELL, 0, 1));
        c.stroke();
      }
    });
  }

  private hud(): void {
    const c = this.ctx;
    const { w, h } = this;
    c.textBaseline = 'middle';

    if (this.state !== 'menu') {
      // progress strip (bottom centre): one dot per sound, the letter once it is found
      const cell = clamp(w * 0.028, 28, 42);
      const gap = 8;
      const x0 = w / 2 - (ROUND * cell + (ROUND - 1) * gap) / 2;
      const y0 = h - 30 - cell;
      for (let i = 0; i < ROUND; i++) {
        const x = x0 + i * (cell + gap) + cell / 2;
        const st = this.stars[i] ?? 0;
        const cur = i === this.idx && this.state !== 'over';
        c.fillStyle = st > 0 ? 'rgba(123,228,149,0.25)' : 'rgba(255,255,255,0.08)';
        c.strokeStyle = cur ? '#78dcff' : st > 0 ? 'rgba(123,228,149,0.7)' : 'rgba(255,255,255,0.14)';
        c.lineWidth = cur ? 2.5 : 1;
        c.beginPath();
        c.arc(x, y0 + cell / 2, cell / 2, 0, Math.PI * 2);
        c.fill();
        c.stroke();
        if (st > 0) {
          c.textAlign = 'center';
          c.fillStyle = '#7be495';
          const letter = SOUNDS[this.order[i]!]!.letter;
          c.font = `700 ${Math.round(cell * 0.44 * fit(letter))}px ${ROUNDED}`;
          c.fillText(letter, x, y0 + cell / 2);
          c.fillStyle = '#ffe066';
          c.font = `${Math.round(cell * 0.3)}px system-ui, sans-serif`;
          c.fillText('★'.repeat(st), x, y0 + cell + 10);
        }
      }
    }

    if (this.state === 'playing' || this.state === 'paused') {
      c.fillStyle = 'rgba(255,255,255,0.85)';
      c.font = '700 22px system-ui, sans-serif';
      c.textAlign = 'left';
      c.fillText(`Set ${this.level} · Sound ${this.idx + 1} of ${ROUND}`, 28, 36);
      c.textAlign = 'right';
      c.fillText(`Score ${this.score}`, w - 170, 36);
      c.textAlign = 'center';
      c.fillStyle = 'rgba(255,255,255,0.4)';
      c.font = '500 14px system-ui, sans-serif';
      c.fillText('Start button = hear the sound again.', w / 2, h * 0.26 + clamp(h * 0.09, 40, 80) + 26);
    }

    if (this.voiceNoteT > 0 && this.state !== 'menu') {
      c.textAlign = 'center';
      c.fillStyle = `rgba(255,255,255,${clamp(this.voiceNoteT, 0, 1) * 0.85})`;
      c.font = '600 18px system-ui, sans-serif';
      c.fillText(`Voice: ${this.voice?.name ?? ''}`, w / 2, 36);
    }

    if (this.state === 'paused') this.banner('Paused', 'Press Start or P to continue');
    if (this.state === 'over') {
      const first = this.stars.filter((s) => s === 3).length;
      this.banner(`Well done: ${this.score} points`, `${first} of ${ROUND} sounds on the first guess${this.score >= this.best && this.score > 0 ? ' · new best!' : ` · best ${this.best}`} · Press Start to play again`);
      this.levels();
    }
  }

  private banner(title: string, sub: string): void {
    const c = this.ctx;
    c.fillStyle = 'rgba(11,19,32,0.78)';
    c.fillRect(0, 0, this.w, this.h);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#fff';
    c.font = `800 ${Math.round(clamp(this.w * 0.04, 32, 56))}px system-ui, sans-serif`;
    c.fillText(title, this.w / 2, this.h * 0.42);
    c.fillStyle = 'rgba(255,255,255,0.7)';
    c.font = '500 20px system-ui, sans-serif';
    c.fillText(sub, this.w / 2, this.h * 0.42 + 46);
  }
}
