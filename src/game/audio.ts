// Tiny synthesized sound effects (no audio files needed).
// Browsers only allow audio after a click/keypress on the laptop page, so
// call unlock() from a user gesture.

export class Sfx {
  private ctx: AudioContext | null = null;
  muted = false;

  unlock(): void {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  get ready(): boolean {
    return this.ctx?.state === 'running';
  }

  private noise(dur: number, f0: number, f1: number, gain: number): void {
    const c = this.ctx;
    if (!c || this.muted || c.state !== 'running') return;
    const n = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, n, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(f0, c.currentTime);
    bp.frequency.exponentialRampToValueAtTime(f1, c.currentTime + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    src.connect(bp).connect(g).connect(c.destination);
    src.start();
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, gain: number, delay = 0): void {
    const c = this.ctx;
    if (!c || this.muted || c.state !== 'running') return;
    const t0 = c.currentTime + delay;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  slice(): void {
    this.noise(0.12, 5000, 1800, 0.35);
    this.tone('triangle', 520, 260, 0.08, 0.12);
  }
  bomb(): void {
    this.noise(0.5, 900, 80, 0.7);
    this.tone('sine', 140, 35, 0.5, 0.6);
  }
  miss(): void {
    this.tone('triangle', 300, 150, 0.22, 0.25);
  }
  combo(): void {
    this.tone('square', 660, 660, 0.09, 0.12);
    this.tone('square', 880, 880, 0.12, 0.12, 0.09);
  }
  start(): void {
    this.tone('triangle', 330, 660, 0.18, 0.2);
  }
  crash(): void {
    this.noise(0.45, 1400, 120, 0.8);
    this.tone('sawtooth', 120, 40, 0.35, 0.3);
  }
  /** Singing-bowl strike: a few soft partials with a long decay. */
  bowl(): void {
    this.tone('sine', 220, 218, 2.6, 0.14);
    this.tone('sine', 607, 604, 2.0, 0.07);
    this.tone('sine', 1188, 1184, 1.4, 0.04);
  }
  jump(): void {
    this.tone('square', 260, 620, 0.14, 0.1);
  }
  land(): void {
    this.noise(0.07, 400, 150, 0.18);
  }
  coin(): void {
    this.tone('square', 988, 988, 0.05, 0.08);
    this.tone('square', 1319, 1319, 0.12, 0.08, 0.05);
  }
  /** Ball on racket strings. */
  racket(): void {
    this.noise(0.06, 2600, 900, 0.5);
    this.tone('sine', 240, 120, 0.09, 0.3);
  }
  pass(): void {
    this.tone('sine', 900, 1300, 0.07, 0.1);
  }

  // ---- engine hum: one oscillator whose pitch follows the car's speed ----
  private eng: { osc: OscillatorNode; gain: GainNode } | null = null;

  engine(speedPct: number, on: boolean): void {
    const c = this.ctx;
    if (!c || c.state !== 'running') return;
    if (!this.eng) {
      const osc = c.createOscillator();
      osc.type = 'sawtooth';
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 500;
      const gain = c.createGain();
      gain.gain.value = 0;
      osc.connect(lp).connect(gain).connect(c.destination);
      osc.start();
      this.eng = { osc, gain };
    }
    const t = c.currentTime;
    this.eng.osc.frequency.setTargetAtTime(55 + speedPct * 150, t, 0.05);
    this.eng.gain.gain.setTargetAtTime(on && !this.muted ? 0.05 + speedPct * 0.04 : 0, t, 0.08);
  }
}
