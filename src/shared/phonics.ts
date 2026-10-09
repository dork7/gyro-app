// Sounds for the Phonics game, and the pure logic that picks a round.
//
// The sounds, their order and the Set 2/3 phrases follow Read Write Inc. (the reference
// is the "Read Write Inc Sets 1, 2 & 3 Sounds" video by Miss Phonics):
//   Set 1: single letters and the first "special friends" (sh th ch qu ng nk)
//   Set 2: the long vowel sounds, each with its phrase ("ay: may I play")
//   Set 3: other spellings of the Set 2 sounds ("a-e: make a cake")
//
// `say` is what the browser's speech voice is asked to read to produce the sound (not
// the letter name). It cannot make a pure, stretched "mmm" or "sss" (it reads those as
// letter names), so consonants get a short "uh". Voices differ: tune these spellings
// if one sounds off.
// The short vowels have an empty `say`: no spelling works (the macOS voices read "ih"
// as "eye" and "eh" as the letter name A). They have a recorded `clip` instead
// (public/phonics, see CREDITS.md there); if it cannot play, the game says their word
// and asks which letter it starts with.
// `group` marks sounds that are the same or too close to tell apart by ear (c/k,
// ay/a-e/ai, ...): they are never offered as choices next to each other.

export type SoundSet = 1 | 2 | 3;
export const SETS: SoundSet[] = [1, 2, 3];

export interface Sound {
  set: SoundSet;
  letter: string; // what is written on the bubble
  say: string; // empty: play `clip`, or failing that say the hint word
  group: string;
  hint: string; // Set 1: a word with the sound; Sets 2 and 3: the Read Write Inc. phrase
  emoji: string;
  clip?: string; // recorded sound: public/phonics/<clip>.mp3
}

const s = (set: SoundSet, letter: string, say: string, group: string, hint: string, emoji: string, clip?: string): Sound => ({ set, letter, say, group, hint, emoji, ...(clip ? { clip } : {}) });

export const SOUNDS: Sound[] = [
  // ---- Set 1, in teaching order
  s(1, 'm', 'muh', 'm', 'moon', '🌙'),
  s(1, 'a', '', 'ah', 'apple', '🍎', 'a'),
  s(1, 's', 'suh', 's', 'sun', '☀️'),
  s(1, 'd', 'duh', 'd', 'dog', '🐶'),
  s(1, 't', 'tuh', 't', 'tiger', '🐯'),
  s(1, 'i', '', 'eh', 'insect', '🐞', 'i'),
  s(1, 'n', 'nuh', 'n', 'nose', '👃'),
  s(1, 'p', 'puh', 'p', 'pig', '🐷'),
  s(1, 'g', 'guh', 'g', 'goat', '🐐'),
  s(1, 'o', '', 'ah', 'octopus', '🐙', 'o'),
  s(1, 'c', 'kuh', 'k', 'cat', '🐱'),
  s(1, 'k', 'kuh', 'k', 'kite', '🪁'),
  s(1, 'u', '', 'uh', 'umbrella', '☂️', 'u'),
  s(1, 'b', 'buh', 'b', 'ball', '⚽'),
  s(1, 'f', 'fuh', 'f', 'fish', '🐟'),
  s(1, 'e', '', 'eh', 'egg', '🥚', 'e'),
  s(1, 'l', 'luh', 'l', 'lion', '🦁'),
  s(1, 'h', 'huh', 'h', 'hat', '🎩'),
  s(1, 'sh', 'shh', 'sh', 'ship', '🚢'),
  s(1, 'r', 'ruh', 'r', 'rabbit', '🐰'),
  s(1, 'j', 'juh', 'j', 'juice', '🧃'),
  s(1, 'v', 'vuh', 'v', 'van', '🚐'),
  s(1, 'y', 'yuh', 'y', 'yo-yo', '🪀'),
  s(1, 'w', 'wuh', 'w', 'web', '🕸️'),
  s(1, 'th', 'thuh', 'th', 'thumb', '👍'),
  s(1, 'z', 'zuh', 'z', 'zebra', '🦓'),
  s(1, 'ch', 'chuh', 'ch', 'cheese', '🧀'),
  s(1, 'qu', 'kwuh', 'k', 'queen', '👑'),
  s(1, 'x', 'ksuh', 'x', 'fox', '🦊'),
  s(1, 'ng', 'ung', 'ng', 'ring', '💍'),
  s(1, 'nk', 'unk', 'ng', 'pink', '🩷'),

  // ---- Set 2
  s(2, 'ay', 'eigh', 'ay', 'may I play', '🛝'),
  s(2, 'ee', 'ee', 'ee', 'what can you see', '👀'),
  s(2, 'igh', 'eye', 'igh', 'fly high', '🪁'),
  s(2, 'ow', 'oh', 'oh', 'blow the snow', '❄️'),
  s(2, 'oo', 'ooh', 'oo', 'poo at the zoo', '💩'),
  s(2, 'oo', 'ooh', 'oo', 'look at a book', '📖'),
  s(2, 'ar', 'are', 'ar', 'start the car', '🚗'),
  s(2, 'or', 'or', 'or', 'shut the door', '🚪'),
  s(2, 'air', 'air', 'air', "that's not fair", '⚖️'),
  s(2, 'ir', 'er', 'er', 'whirl and twirl', '🌀'),
  s(2, 'ou', 'ow', 'ou', 'shout it out', '📣'),
  s(2, 'oy', 'oy', 'oy', 'toy for a boy', '🧸'),

  // ---- Set 3
  s(3, 'ea', 'ee', 'ee', 'cup of tea', '🍵'),
  s(3, 'oi', 'oy', 'oy', 'spoil the boy', '👦'),
  s(3, 'a-e', 'eigh', 'ay', 'make a cake', '🎂'),
  s(3, 'i-e', 'eye', 'igh', 'nice smile', '😊'),
  s(3, 'o-e', 'oh', 'oh', 'phone home', '📞'),
  s(3, 'u-e', 'ooh', 'oo', 'huge brute', '🦣'),
  s(3, 'aw', 'aw', 'or', 'yawn at dawn', '🥱'),
  s(3, 'are', 'air', 'air', 'care and share', '🤝'),
  s(3, 'ur', 'er', 'er', 'nurse with a purse', '👛'),
  s(3, 'er', 'er', 'er', 'a better letter', '✉️'),
  s(3, 'ow', 'ow', 'ou', 'brown cow', '🐄'),
  s(3, 'ai', 'eigh', 'ay', 'snail in the rain', '🐌'),
  s(3, 'oa', 'oh', 'oh', 'goat in a boat', '🐐'),
  s(3, 'ew', 'ooh', 'oo', 'chew the stew', '🍲'),
  s(3, 'ire', 'ire', 'ire', 'fire, fire', '🔥'),
  s(3, 'ear', 'ear', 'ear', 'hear with your ear', '👂'),
  s(3, 'ure', 'your', 'ure', "sure it's pure", '💧'),
  s(3, 'tion', 'shun', 'shun', "pay attention, it's a celebration", '🎉'),
  s(3, 'cious', 'shus', 'shus', 'scrumptious, delicious', '😋'),
];

type Rng = () => number;

function shuffle<T>(items: T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Indices into SOUNDS of every sound in a set, in teaching order. */
export function soundsIn(set: SoundSet): number[] {
  return SOUNDS.flatMap((x, i) => (x.set === set ? [i] : []));
}

/** Indices into SOUNDS for one round: up to `n` sounds of a set that all sound different, in random order. */
export function makeRound(n: number, set: SoundSet, rng: Rng = Math.random): number[] {
  const used = new Set<string>();
  const picked: number[] = [];
  for (const i of shuffle(soundsIn(set), rng)) {
    if (picked.length >= n) break;
    const g = SOUNDS[i]!.group;
    if (used.has(g)) continue;
    used.add(g);
    picked.push(i);
  }
  return picked;
}

/** The answer plus `count - 1` other sounds of the same set that all sound different, shuffled. */
export function makeChoices(answer: number, count: number, rng: Rng = Math.random): number[] {
  const used = new Set([SOUNDS[answer]!.group]);
  const picked = [answer];
  for (const i of shuffle(soundsIn(SOUNDS[answer]!.set), rng)) {
    if (picked.length >= count) break;
    const g = SOUNDS[i]!.group;
    if (used.has(g)) continue;
    used.add(g);
    picked.push(i);
  }
  return shuffle(picked, rng);
}

/** The spoken and written hint: "like apple" for Set 1, the phrase itself for Sets 2 and 3. */
export function hintFor(x: Sound): string {
  return x.set === 1 ? `like ${x.hint}` : x.hint;
}

/** Points for finding the sound after `wrong` wrong guesses. */
export function pointsFor(wrong: number): number {
  return [10, 6, 3, 1][Math.min(wrong, 3)]!;
}
