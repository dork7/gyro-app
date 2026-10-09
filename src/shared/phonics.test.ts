import { describe, expect, it } from 'vitest';
import { hintFor, makeChoices, makeRound, pointsFor, SETS, SOUNDS, soundsIn } from './phonics';

/** Small deterministic generator so the tests do not depend on Math.random. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe('phonics', () => {
  it('has the Read Write Inc. sets in teaching order', () => {
    const letters = (set: 1 | 2 | 3) => soundsIn(set).map((i) => SOUNDS[i]!.letter).join(' ');
    expect(letters(1)).toBe('m a s d t i n p g o c k u b f e l h sh r j v y w th z ch qu x ng nk');
    expect(letters(2)).toBe('ay ee igh ow oo oo ar or air ir ou oy');
    expect(letters(3).startsWith('ea oi a-e i-e o-e u-e aw are ur er ow ai oa ew ire ear ure')).toBe(true);
    // only the five short vowels have no spoken spelling; they have a recorded clip instead
    expect(SOUNDS.filter((x) => x.clip).map((x) => x.clip).join('')).toBe('aioue');
    expect(SOUNDS.filter((x) => !x.say).map((x) => x.letter).join('')).toBe('aioue');
  });

  it('makes a round of sounds from one set that all sound different', () => {
    for (const set of SETS) {
      const round = makeRound(10, set, seeded(set));
      expect(round.length).toBe(10);
      expect(new Set(round.map((i) => SOUNDS[i]!.group)).size).toBe(10);
      for (const i of round) expect(SOUNDS[i]!.set).toBe(set);
    }
  });

  it('offers the answer among choices of the same set that all sound different', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = seeded(seed);
      for (let answer = 0; answer < SOUNDS.length; answer++) {
        const choices = makeChoices(answer, 4, rng);
        expect(choices.length).toBe(4);
        expect(choices).toContain(answer);
        expect(new Set(choices.map((i) => SOUNDS[i]!.group)).size).toBe(4);
        for (const i of choices) expect(SOUNDS[i]!.set).toBe(SOUNDS[answer]!.set);
      }
    }
  });

  it('words the hint by set', () => {
    expect(hintFor(SOUNDS[1]!)).toBe('like apple');
    expect(hintFor(SOUNDS[soundsIn(2)[0]!]!)).toBe('may I play');
  });

  it('gives fewer points after wrong guesses', () => {
    expect(pointsFor(0)).toBe(10);
    expect(pointsFor(1)).toBeLessThan(pointsFor(0));
    expect(pointsFor(9)).toBe(1);
  });
});
