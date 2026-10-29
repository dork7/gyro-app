// UNO rules, shared by the laptop (which runs the game) and the phones (which show hands).
//
// Cards travel as numbers 0..107: both sides look them up in the same DECK table, so a
// hand is just a short list of ids. The laptop holds the only copy of the game state and
// sends each phone its own hand; nobody else's cards ever leave the laptop.
//
// Rules follow the standard game, with a few simplifications:
//   - the first card turned up is always a number card
//   - no stacking of +2/+4, and no challenging a Wild +4
//   - draw one card when you cannot (or do not want to) play; you may play that card
//     straight away, otherwise your turn ends
//   - press UNO before playing your second-to-last card, or draw 2 as a penalty

export type Color = 'r' | 'y' | 'g' | 'b';
export type Kind = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'skip' | 'rev' | 'draw2' | 'wild' | 'wild4';

export interface Card {
  id: number;
  color: Color | null; // null for wild cards
  kind: Kind;
}

export const COLORS: Color[] = ['r', 'y', 'g', 'b'];
export const COLOR_NAME: Record<Color, string> = { r: 'red', y: 'yellow', g: 'green', b: 'blue' };

function buildDeck(): Card[] {
  const deck: Card[] = [];
  const add = (color: Color | null, kind: Kind) => deck.push({ id: deck.length, color, kind });
  for (const c of COLORS) {
    add(c, '0');
    for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'rev', 'draw2'] as Kind[]) {
      add(c, k);
      add(c, k);
    }
  }
  for (let i = 0; i < 4; i++) add(null, 'wild');
  for (let i = 0; i < 4; i++) add(null, 'wild4');
  return deck;
}

export const DECK: readonly Card[] = buildDeck();
export const HAND_SIZE = 7;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

export const card = (id: number): Card => DECK[id];
export const isNumber = (c: Card) => c.kind.length === 1;

/** Short label for a card face. */
export function label(c: Card): string {
  switch (c.kind) {
    case 'skip':
      return '⊘';
    case 'rev':
      return '⇄';
    case 'draw2':
      return '+2';
    case 'wild':
      return 'W';
    case 'wild4':
      return '+4';
    default:
      return c.kind;
  }
}

/** Points a card left in a hand is worth to the winner. */
export function points(c: Card): number {
  if (isNumber(c)) return Number(c.kind);
  return c.color === null ? 50 : 20;
}

export function canPlay(c: Card, top: Card, color: Color): boolean {
  return c.color === null || c.color === color || c.kind === top.kind;
}

/** Hand order for display: by colour, then kind; wilds last. */
export function sortHand(ids: number[]): number[] {
  const order = (id: number) => {
    const c = card(id);
    const ci = c.color === null ? 4 : COLORS.indexOf(c.color);
    const ki = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'rev', 'draw2', 'wild', 'wild4'].indexOf(c.kind);
    return ci * 100 + ki;
  };
  return [...ids].sort((a, b) => order(a) - order(b) || a - b);
}

// ---- game state ----------------------------------------------------------------------
export interface UnoPlayer {
  pid: string;
  name: string;
  hand: number[];
}

export interface Uno {
  players: UnoPlayer[];
  deck: number[]; // draw pile, top is the last element
  discard: number[]; // top is the last element
  color: Color; // colour in play (chosen colour after a wild)
  turn: number;
  dir: 1 | -1;
  drawn: number | null; // card the current player just drew and may still play
  winner: number | null;
  log: string;
}

function shuffle<T>(a: T[], rng: () => number): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const top = (s: Uno): Card => card(s.discard[s.discard.length - 1]);
const next = (s: Uno, steps = 1) => (((s.turn + s.dir * steps) % s.players.length) + s.players.length) % s.players.length;

export function newRound(players: { pid: string; name: string }[], rng: () => number, first = 0): Uno {
  const deck = shuffle(DECK.map((c) => c.id), rng);
  const ps = players.map((p) => ({ pid: p.pid, name: p.name, hand: [] as number[] }));
  for (let k = 0; k < HAND_SIZE; k++) for (const p of ps) p.hand.push(deck.pop()!);
  // turn up cards until a number card shows; the others go back under the pile
  let up = deck.pop()!;
  while (!isNumber(card(up))) {
    deck.unshift(up);
    up = deck.pop()!;
  }
  return {
    players: ps,
    deck,
    discard: [up],
    color: card(up).color!,
    turn: first % ps.length,
    dir: 1,
    drawn: null,
    winner: null,
    log: `${ps[first % ps.length].name} starts`,
  };
}

/** Take n cards from the pile, shuffling the discards back in when it runs out. */
function give(s: Uno, who: number, n: number, rng: () => number): number {
  let got = 0;
  for (let i = 0; i < n; i++) {
    if (!s.deck.length) {
      const keep = s.discard.pop()!;
      s.deck = shuffle(s.discard, rng);
      s.discard = [keep];
    }
    const id = s.deck.pop();
    if (id === undefined) break; // every card is in someone's hand
    s.players[who].hand.push(id);
    got++;
  }
  return got;
}

function endTurn(s: Uno, steps = 1): void {
  s.turn = next(s, steps);
  s.drawn = null;
}

/** Play a card. Returns an error message, or null when the move was made. */
export function play(s: Uno, who: number, id: number, rng: () => number, chosen?: Color, saidUno = false): string | null {
  if (s.winner !== null) return 'The round is over';
  if (who !== s.turn) return 'Not your turn';
  const hand = s.players[who].hand;
  const at = hand.indexOf(id);
  if (at < 0) return 'That card is not in your hand';
  if (s.drawn !== null && id !== s.drawn) return 'You can only play the card you just drew';
  const c = card(id);
  if (!canPlay(c, top(s), s.color)) return `That card does not match ${COLOR_NAME[s.color]} or ${label(top(s))}`;
  if (c.color === null && (!chosen || !COLORS.includes(chosen))) return 'Pick a colour';

  hand.splice(at, 1);
  s.discard.push(id);
  s.color = c.color ?? chosen!;
  const me = s.players[who].name;
  const n = s.players.length;

  if (!hand.length) {
    s.winner = who;
    s.drawn = null;
    s.log = `${me} wins the round!`;
    return null;
  }
  const extra: string[] = [];
  if (hand.length === 1) {
    if (saidUno) extra.push(`${me}: UNO!`);
    else extra.push(`${me} forgot to say UNO: +${give(s, who, 2, rng)}`);
  }

  const victim = s.players[next(s)];
  let what = `${me} played ${c.color ? COLOR_NAME[c.color] + ' ' : ''}${label(c)}`;
  switch (c.kind) {
    case 'skip':
      what += `, ${victim.name} is skipped`;
      endTurn(s, 2);
      break;
    case 'rev':
      s.dir = s.dir === 1 ? -1 : 1;
      what += n === 2 ? `, ${victim.name} is skipped` : ', direction reversed';
      endTurn(s, n === 2 ? 2 : 1);
      break;
    case 'draw2':
      what += `, ${victim.name} draws ${give(s, next(s), 2, rng)}`;
      endTurn(s, 2);
      break;
    case 'wild4':
      what += `, ${victim.name} draws ${give(s, next(s), 4, rng)}`;
      endTurn(s, 2);
      break;
    default:
      endTurn(s);
  }
  if (c.color === null) what += ` (${COLOR_NAME[s.color]})`;
  s.log = [what, ...extra].join(' · ');
  return null;
}

/** Draw one card. If it can be played the player may play it or pass; otherwise the turn ends. */
export function draw(s: Uno, who: number, rng: () => number): string | null {
  if (s.winner !== null) return 'The round is over';
  if (who !== s.turn) return 'Not your turn';
  if (s.drawn !== null) return 'You already drew: play that card or pass';
  const me = s.players[who].name;
  if (!give(s, who, 1, rng)) {
    s.log = `${me} could not draw (no cards left) and passes`;
    endTurn(s);
    return null;
  }
  const id = s.players[who].hand[s.players[who].hand.length - 1];
  if (canPlay(card(id), top(s), s.color)) {
    s.drawn = id;
    s.log = `${me} drew a card`;
  } else {
    s.log = `${me} drew a card and passes`;
    endTurn(s);
  }
  return null;
}

/** Keep the card just drawn and end the turn. */
export function pass(s: Uno, who: number): string | null {
  if (s.winner !== null) return 'The round is over';
  if (who !== s.turn) return 'Not your turn';
  if (s.drawn === null) return 'Draw a card first';
  s.log = `${s.players[who].name} passes`;
  endTurn(s);
  return null;
}

/** Points the winner scores: everything left in the other hands. */
export function roundPoints(s: Uno): number {
  return s.players.reduce((sum, p, i) => (i === s.winner ? sum : sum + p.hand.reduce((a, id) => a + points(card(id)), 0)), 0);
}

// ---- what a phone is told --------------------------------------------------------------
export type Phase = 'lobby' | 'play' | 'paused' | 'over';

/** One phone's view of the table. `you` is -1 for a phone that is only watching. */
export interface UnoView {
  phase: Phase;
  you: number;
  hand: number[];
  names: string[];
  counts: number[];
  totals: number[]; // points over the rounds so far
  top: number; // -1 in the lobby
  color: Color | null;
  turn: number;
  drawn: number | null;
  winner: number | null;
  log: string;
  note?: string; // for this phone only, e.g. why a move was refused
}
