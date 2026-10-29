import { describe, expect, it } from 'vitest';
import { mulberry32 } from './marble';
import { canPlay, card, DECK, draw, HAND_SIZE, isNumber, newRound, pass, play, points, roundPoints, sortHand, top, type Color, type Kind, type Uno } from './uno';

/** Id of a card with this colour and kind that is not already used. */
function find(color: Color | null, kind: Kind, used: Set<number>): number {
  const c = DECK.find((d) => d.color === color && d.kind === kind && !used.has(d.id));
  if (!c) throw new Error(`no ${color} ${kind} left`);
  used.add(c.id);
  return c.id;
}

/** A table with chosen hands and top card; the rest of the deck is the draw pile. */
function table(hands: [Color | null, Kind][][], up: [Color, Kind], deckTop: [Color | null, Kind][] = []): Uno {
  const used = new Set<number>();
  const players = hands.map((h, i) => ({ pid: `p${i}`, name: `P${i}`, hand: h.map(([c, k]) => find(c, k, used)) }));
  const discard = [find(up[0], up[1], used)];
  const tops = deckTop.map(([c, k]) => find(c, k, used));
  const deck = DECK.map((c) => c.id).filter((id) => !used.has(id));
  deck.push(...tops.reverse()); // first listed is drawn first
  return { players, deck, discard, color: up[0], turn: 0, dir: 1, drawn: null, winner: null, log: '' };
}

const rng = mulberry32(9);
const total = (s: Uno) => s.deck.length + s.discard.length + s.players.reduce((a, p) => a + p.hand.length, 0);

describe('deck', () => {
  it('has the 108 standard cards', () => {
    expect(DECK).toHaveLength(108);
    expect(DECK.filter((c) => c.kind === 'wild')).toHaveLength(4);
    expect(DECK.filter((c) => c.kind === 'wild4')).toHaveLength(4);
    expect(DECK.filter((c) => c.color === 'r')).toHaveLength(25);
    expect(DECK.filter((c) => c.kind === '0')).toHaveLength(4);
    expect(DECK.filter((c) => c.kind === 'draw2')).toHaveLength(8);
    DECK.forEach((c, i) => expect(c.id).toBe(i));
  });

  it('scores cards like the official game', () => {
    expect(points(DECK.find((c) => c.kind === '7')!)).toBe(7);
    expect(points(DECK.find((c) => c.kind === 'skip')!)).toBe(20);
    expect(points(DECK.find((c) => c.kind === 'wild4')!)).toBe(50);
  });

  it('matches on colour or symbol, wilds always', () => {
    const u = new Set<number>();
    const r5 = card(find('r', '5', u));
    expect(canPlay(card(find('r', '9', u)), r5, 'r')).toBe(true);
    expect(canPlay(card(find('b', '5', u)), r5, 'r')).toBe(true);
    expect(canPlay(card(find('b', '6', u)), r5, 'r')).toBe(false);
    expect(canPlay(card(find(null, 'wild4', u)), r5, 'r')).toBe(true);
    // after a wild, the chosen colour counts, not the wild's symbol
    const w = card(find(null, 'wild', u));
    expect(canPlay(card(find('g', '2', u)), w, 'g')).toBe(true);
    expect(canPlay(card(find('y', '2', u)), w, 'g')).toBe(false);
  });

  it('sorts a hand by colour with wilds last', () => {
    const u = new Set<number>();
    const ids = [find(null, 'wild', u), find('b', '3', u), find('r', 'skip', u), find('r', '2', u)];
    expect(sortHand(ids).map((id) => card(id).kind)).toEqual(['2', 'skip', '3', 'wild']);
  });
});

describe('newRound', () => {
  it('deals seven each, turns up a number card and keeps all 108 cards', () => {
    for (let seed = 0; seed < 30; seed++) {
      const s = newRound([{ pid: 'a', name: 'A' }, { pid: 'b', name: 'B' }, { pid: 'c', name: 'C' }], mulberry32(seed));
      for (const p of s.players) expect(p.hand).toHaveLength(HAND_SIZE);
      expect(isNumber(top(s))).toBe(true);
      expect(s.color).toBe(top(s).color);
      expect(total(s)).toBe(108);
      expect(new Set([...s.deck, ...s.discard, ...s.players.flatMap((p) => p.hand)]).size).toBe(108);
    }
  });
});

describe('play', () => {
  it('plays a matching card and passes the turn on', () => {
    const s = table([[['r', '9'], ['b', '1'], ['b', '2']], [['g', '1']], [['y', '1']]], ['r', '5']);
    expect(play(s, 0, s.players[0].hand[0], rng)).toBeNull();
    expect(top(s).kind).toBe('9');
    expect(s.turn).toBe(1);
    expect(s.players[0].hand).toHaveLength(2);
  });

  it('refuses out-of-turn, non-matching and unowned cards', () => {
    const s = table([[['b', '6'], ['b', '1']], [['r', '1'], ['g', '1']]], ['r', '5']);
    expect(play(s, 1, s.players[1].hand[0], rng)).toBe('Not your turn');
    expect(play(s, 0, s.players[0].hand[0], rng)).toMatch(/does not match/);
    expect(play(s, 0, s.players[1].hand[0], rng)).toBe('That card is not in your hand');
    expect(s.turn).toBe(0);
  });

  it('skip jumps over the next player', () => {
    const s = table([[['r', 'skip'], ['b', '1']], [['g', '1']], [['y', '1']]], ['r', '5']);
    play(s, 0, s.players[0].hand[0], rng);
    expect(s.turn).toBe(2);
  });

  it('reverse turns the order round, and acts as a skip with two players', () => {
    const three = table([[['r', 'rev'], ['b', '1']], [['g', '1']], [['y', '1']]], ['r', '5']);
    play(three, 0, three.players[0].hand[0], rng);
    expect(three.dir).toBe(-1);
    expect(three.turn).toBe(2);
    const two = table([[['r', 'rev'], ['b', '1']], [['g', '1']]], ['r', '5']);
    play(two, 0, two.players[0].hand[0], rng);
    expect(two.turn).toBe(0);
  });

  it('+2 and wild +4 make the next player draw and lose their turn', () => {
    const s = table([[['r', 'draw2'], ['b', '1'], ['b', '2']], [['g', '1']], [['y', '1']]], ['r', '5']);
    play(s, 0, s.players[0].hand[0], rng);
    expect(s.players[1].hand).toHaveLength(3);
    expect(s.turn).toBe(2);
    const w = table([[[null, 'wild4'], ['b', '1'], ['b', '2']], [['g', '1']], [['y', '1']]], ['r', '5']);
    expect(play(w, 0, w.players[0].hand[0], rng)).toBe('Pick a colour');
    expect(play(w, 0, w.players[0].hand[0], rng, 'b')).toBeNull();
    expect(w.color).toBe('b');
    expect(w.players[1].hand).toHaveLength(5);
    expect(w.turn).toBe(2);
  });

  it('a wild sets the colour in play', () => {
    const s = table([[[null, 'wild'], ['b', '1'], ['b', '2']], [['g', '1'], ['y', '5']]], ['r', '5']);
    play(s, 0, s.players[0].hand[0], rng, 'g');
    expect(s.color).toBe('g');
    expect(play(s, 1, s.players[1].hand[1], rng)).toMatch(/does not match/);
    expect(play(s, 1, s.players[1].hand[0], rng)).toBeNull();
  });

  it('penalises a missing UNO call with two cards', () => {
    const s = table([[['r', '9'], ['b', '1']], [['g', '1']]], ['r', '5']);
    play(s, 0, s.players[0].hand[0], rng);
    expect(s.players[0].hand).toHaveLength(3);
    expect(s.log).toMatch(/forgot to say UNO/);
    const t = table([[['r', '9'], ['b', '1']], [['g', '1']]], ['r', '5']);
    play(t, 0, t.players[0].hand[0], rng, undefined, true);
    expect(t.players[0].hand).toHaveLength(1);
  });

  it('ends the round on the last card and scores the other hands', () => {
    const s = table([[['r', '9']], [['g', '1'], [null, 'wild']], [['y', 'skip']]], ['r', '5']);
    expect(play(s, 0, s.players[0].hand[0], rng)).toBeNull();
    expect(s.winner).toBe(0);
    expect(roundPoints(s)).toBe(1 + 50 + 20);
    expect(play(s, 1, s.players[1].hand[0], rng)).toBe('The round is over');
  });
});

describe('draw / pass', () => {
  it('lets you play a playable card you drew, or keep it and pass', () => {
    const s = table([[['b', '1']], [['g', '1']]], ['r', '5'], [['r', '7']]);
    expect(draw(s, 0, rng)).toBeNull();
    expect(s.drawn).not.toBeNull();
    expect(s.turn).toBe(0);
    expect(draw(s, 0, rng)).toMatch(/already drew/);
    expect(play(s, 0, s.players[0].hand[0], rng)).toMatch(/only play the card you just drew/);
    const keep = structuredClone(s);
    expect(play(s, 0, s.drawn!, rng)).toBeNull();
    expect(top(s).kind).toBe('7');
    expect(pass(keep, 0)).toBeNull();
    expect(keep.turn).toBe(1);
    expect(keep.players[0].hand).toHaveLength(2);
  });

  it('ends the turn when the drawn card cannot be played', () => {
    const s = table([[['b', '1']], [['g', '1']]], ['r', '5'], [['g', '8']]);
    draw(s, 0, rng);
    expect(s.turn).toBe(1);
    expect(s.drawn).toBeNull();
    expect(pass(s, 1)).toBe('Draw a card first');
  });

  it('shuffles the discards back in when the pile runs out', () => {
    const s = table([[['b', '1']], [['g', '1']]], ['r', '5']);
    s.discard.push(...s.deck.splice(0, s.deck.length - 1)); // leave one card to draw
    const before = total(s);
    const topId = s.discard[s.discard.length - 1];
    for (let i = 0; i < 4; i++) {
      s.turn = 0;
      s.drawn = null;
      draw(s, 0, rng);
    }
    expect(total(s)).toBe(before);
    expect(s.discard[s.discard.length - 1]).toBe(topId);
    expect(s.players[0].hand.length).toBe(5);
  });
});
