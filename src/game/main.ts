import QRCode from 'qrcode';
import { aim, PointerMapper, type Aim } from '../shared/pointer';
import type { GameId } from '../shared/protocol';
import { Sfx } from './audio';
import { BowlingGame } from './bowling';
import { CarGame } from './car';
import { DuckGame } from './duck';
import { FishingGame } from './fishing';
import { Game } from './game';
import { JumpGame } from './jump';
import { MazeGame } from './maze';
import { OrbitGame } from './orbit';
import { PhonicsGame } from './phonics';
import { PotatoGame } from './potato';
import { SkyGame } from './sky';
import { SnakeGame } from './snake';
import { TennisGame } from './tennis';
import { UnoGame } from './uno';
import { YogaGame } from './yoga';
import { WriteGame } from './write';
import { HostConnection } from './net';
import type { GameHooks, Scene } from './scene';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $('stage') as HTMLCanvasElement;

const sfx = new Sfx();
const mapper = new PointerMapper();
let sens = 1;
let latest: Aim | null = null;
let lastPadSample = 0;
let samplesThisSecond = 0;
let samplesPerSec = 0;
// On-screen joystick on the phone (instead of motion). In the pointing games it moves a
// virtual mouse cursor at a speed set by how far the stick is pushed.
let joy = { x: 0, y: 0 };
let lastJoy = 0;
let joyMode = false; // the controller phone is using its joystick, not its sensors
const cursor = { x: 0, y: 0 };
const POINTING = new Set<GameId>(['fruit', 'write', 'phonics', 'tennis', 'duck', 'fish', 'bowl']);

const hooks: GameHooks = {
  onSlice: () => net.haptic(18),
  onHaptic: (ms) => net.haptic(ms),
  onChange: () => pushState(),
};
const fruit = new Game(canvas, sfx, hooks);
const car = new CarGame(canvas, sfx, hooks);
const jump = new JumpGame(canvas, sfx, hooks);
const yoga = new YogaGame(canvas, sfx, hooks);
const write = new WriteGame(canvas, sfx, hooks);
const phonics = new PhonicsGame(canvas, sfx, hooks);
const tennis = new TennisGame(canvas, sfx, hooks);
const maze = new MazeGame(canvas, sfx, hooks);
const sky = new SkyGame(canvas, sfx, hooks);
const snake = new SnakeGame(canvas, sfx, hooks);
const orbit = new OrbitGame(canvas, sfx, hooks);
const uno = new UnoGame(canvas, sfx, hooks, (m) => net.send(m));
const duck = new DuckGame(canvas, sfx, hooks);
const potato = new PotatoGame(canvas, sfx, hooks, (m) => net.send(m));
const fishing = new FishingGame(canvas, sfx, hooks);
const bowling = new BowlingGame(canvas, sfx, hooks);

// ---------------------------------------------------------------- which game is showing
let mode: GameId = 'home';
let scene: Scene | null = null;

function setMode(next: GameId): void {
  if (next === mode && next !== 'home') return;
  (scene as (Scene & { exit?: () => void }) | null)?.exit?.();
  resetMenuUi();
  mode = next;
  document.body.dataset.mode = next;
  scene = next === 'fruit' ? fruit : next === 'car' ? car : next === 'jump' ? jump : next === 'yoga' ? yoga : next === 'write' ? write : next === 'phonics' ? phonics : next === 'tennis' ? tennis : next === 'maze' ? maze : next === 'sky' ? sky : next === 'snake' ? snake : next === 'orbit' ? orbit : next === 'uno' ? uno : next === 'duck' ? duck : next === 'potato' ? potato : next === 'fish' ? fishing : next === 'bowl' ? bowling : null;
  $('home').hidden = next !== 'home';
  $('title').querySelector('h1')!.textContent = scene?.title ?? 'Gyro Arcade';
  $('title').querySelector('p')!.textContent = scene?.subtitle ?? 'Pick a game. Your phone is the controller.';
  if (scene) scene.enter();
  else document.body.dataset.state = 'home';
  pushState();
}

// ---------------------------------------------------------------- in-game menu (overlay)
// H or the Menu button pauses the current game and shows the game picker on top of it.
let menuOpen = false;
let pausedByMenu = false;

function resetMenuUi(): void {
  menuOpen = false;
  pausedByMenu = false;
  delete document.body.dataset.menu;
  $('resumeBtn').hidden = true;
  for (const c of document.querySelectorAll('#home .card')) c.classList.remove('current');
}

function openMenu(): void {
  if (mode === 'home' || menuOpen) return;
  menuOpen = true;
  pausedByMenu = scene?.state === 'playing';
  if (pausedByMenu) scene?.togglePause();
  document.body.dataset.menu = 'open';
  $('home').hidden = false;
  $('resumeBtn').hidden = false;
  for (const c of document.querySelectorAll<HTMLElement>('#home .card')) c.classList.toggle('current', c.dataset.game === mode);
  pushState();
}

function closeMenu(): void {
  if (!menuOpen) return;
  const resume = pausedByMenu;
  resetMenuUi();
  $('home').hidden = true;
  if (resume && scene?.state === 'paused') scene.togglePause();
  pushState();
}

function toggleMenu(): void {
  if (menuOpen) closeMenu();
  else openMenu();
}

/** Pick a game from the menu: the current game just resumes, anything else switches. */
function choose(game: GameId): void {
  if (menuOpen && game === mode) closeMenu();
  else setMode(game);
}

function pushState(): void {
  net.send({
    t: 'state',
    game: menuOpen ? 'home' : mode,
    state: scene?.state ?? 'menu',
    score: scene?.score ?? 0,
    lives: scene?.lives ?? 0,
    best: scene?.best ?? 0,
    ctl: net.controller,
  });
}

// ---------------------------------------------------------------- network
const net: HostConnection = new HostConnection({
  onRoom(room) {
    $('code').textContent = room;
    void renderQr(room);
    pushState();
  },
  onPad(on) {
    const chip = $('padstatus');
    chip.dataset.on = String(on);
    chip.textContent = !on ? 'Waiting for phone…' : net.pads.length > 1 ? `${net.pads.length} phones connected ✓` : 'Phone connected ✓';
    if (!on) {
      latest = null;
      car.padLost();
      yoga.padLost();
      maze.padLost();
      sky.padLost();
      snake.padLost();
      orbit.padLost();
    }
    if (!on && scene?.state === 'playing') toast('Phone disconnected: reconnecting…');
    if (on) hideToast();
    pushState();
  },
  onSample(s) {
    samplesThisSecond++;
    const now = performance.now();
    lastPadSample = now;
    joyMode = false;
    if (mode === 'car') {
      car.setOrientation(s, now);
      return;
    }
    if (mode === 'yoga') {
      yoga.setOrientation(s, now);
      return;
    }
    if (mode === 'maze') {
      maze.setOrientation(s, now);
      return;
    }
    if (mode === 'sky') {
      sky.setOrientation(s, now);
      return;
    }
    if (mode === 'snake') {
      snake.setOrientation(s, now);
      return;
    }
    if (mode === 'orbit') {
      orbit.setOrientation(s, now);
      return;
    }
    latest = aim(s);
    if (!mapper.hasCenter) mapper.setCenter(latest);
    if (mode === 'fruit' && !menuOpen) {
      const p = mapper.map(latest, fruit.w, fruit.h, sens);
      fruit.pointerMove(p.x, p.y, now);
    } else if (mode === 'write' && !menuOpen) {
      const p = mapper.map(latest, window.innerWidth, window.innerHeight, sens);
      write.penMove(p.x + write.shiftX, p.y, now);
    } else if (mode === 'phonics' && !menuOpen) {
      const p = mapper.map(latest, window.innerWidth, window.innerHeight, sens);
      phonics.penMove(p.x, p.y, now);
    } else if (mode === 'bowl' && !menuOpen) {
      const p = mapper.map(latest, window.innerWidth, window.innerHeight, sens);
      bowling.aim(p.x);
      bowling.orient(latest.pitch, latest.yaw, s.g ?? 0, now);
    } else if (mode === 'fish' && !menuOpen) {
      const p = mapper.map(latest, window.innerWidth, window.innerHeight, sens);
      fishing.rodMove(p.x, p.y);
      fishing.rodAngles(latest.yaw, latest.pitch, now);
    } else if (mode === 'duck' && !menuOpen) {
      const p = mapper.map(latest, window.innerWidth, window.innerHeight, sens);
      duck.aim(p.x, p.y);
    } else if (mode === 'tennis' && !menuOpen) {
      const p = mapper.map(latest, window.innerWidth, window.innerHeight, sens);
      tennis.racketMove(p.x, p.y, now);
      tennis.swingAim(latest.yaw, latest.pitch, now);
    }
  },
  onButton(name) {
    sfx.unlock();
    if (menuOpen) return;
    if (name === 'center') {
      if (mode === 'car') car.calibrate();
      else if (mode === 'yoga') yoga.calibrate();
      else if (mode === 'maze') maze.calibrate();
      else if (mode === 'sky') sky.calibrate();
      else if (mode === 'snake') snake.calibrate();
      else if (mode === 'orbit') orbit.calibrate();
      else if (latest) mapper.setCenter(latest);
    } else if (name === 'fire') {
      if (mode === 'duck') duck.fire();
    } else if (name === 'grip') {
      if (mode === 'bowl') {
        if (joyMode) bowling.mouseDown();
        else bowling.grip();
      }
    } else if (name === 'release') {
      if (mode === 'bowl') {
        if (joyMode) bowling.mouseUp(performance.now());
        else bowling.release(performance.now());
      }
    } else if (name === 'act') {
      if (mode === 'fish') fishing.click();
      else if (mode === 'phonics') phonics.click(cursor.x, cursor.y);
    } else if (name === 'start') scene?.requestStart();
    else if (name === 'pause') scene?.togglePause();
  },
  onSensitivity(v) {
    if (!Number.isFinite(v)) return;
    sens = Math.max(0.3, Math.min(4, v));
    car.setSensitivity(sens);
    maze.setSensitivity(sens);
    sky.setSensitivity(sens);
    snake.setSensitivity(sens);
    orbit.setSensitivity(sens);
    fishing.setSensitivity(sens);
    bowling.setSensitivity(sens);
  },
  onLefty(lefty) {
    tennis.setLefty(lefty);
  },
  onPedal(gas, brake) {
    car.setPedals(gas, brake);
  },
  onSelect(game) {
    sfx.unlock();
    if (game === 'home') openMenu();
    else if (game === 'fruit' || game === 'car' || game === 'jump' || game === 'yoga' || game === 'write' || game === 'phonics' || game === 'tennis' || game === 'maze' || game === 'sky' || game === 'snake' || game === 'orbit' || game === 'uno' || game === 'duck' || game === 'potato' || game === 'fish' || game === 'bowl') choose(game);
  },
  onJoy(x, y) {
    const now = performance.now();
    if (now - lastJoy > 2000) {
      cursor.x = window.innerWidth / 2;
      cursor.y = window.innerHeight / 2;
    }
    lastJoy = now;
    joyMode = true;
    joy = { x, y };
    if (menuOpen) return;
    if (mode === 'car') car.joy(x, now);
    else if (mode === 'maze') maze.joy(x, y, now);
    else if (mode === 'sky') sky.joy(x, y, now);
    else if (mode === 'snake') snake.joy(x, y, now);
    else if (mode === 'orbit') orbit.joy(x, y, now);
    else if (mode === 'yoga') yoga.joy(x, y);
  },
  onJump(strength) {
    sfx.unlock();
    if (mode === 'jump' && !menuOpen) jump.jump(strength);
  },
  onUno(from, m) {
    if (mode === 'uno' && !menuOpen) uno.handle(from, m);
  },
  onPotato(from, m) {
    if (mode === 'potato' && !menuOpen) potato.handle(from, m);
  },
  onPads(ids) {
    uno.setPads(ids);
    potato.setPads(ids);
    const chip = $('padstatus');
    if (ids.length) chip.textContent = ids.length > 1 ? `${ids.length} phones connected ✓` : 'Phone connected ✓';
  },
  onServer(connected) {
    if (!connected) toast('Lost connection to the game server…');
    else hideToast();
  },
});

async function renderQr(room: string): Promise<void> {
  let host = location.host;
  try {
    // If we were opened as localhost, swap in the laptop's LAN address for the phone.
    if (/^(localhost|127\.0\.0\.1)/.test(location.hostname)) {
      const info = (await (await fetch('/api/info')).json()) as { lan: string[]; port: number };
      if (info.lan[0]) host = `${info.lan[0]}:${info.port}`;
    }
  } catch {
    /* fall back to the current host */
  }
  const url = `https://${host}/pad?room=${room}`;
  $('url').textContent = url;
  await QRCode.toCanvas($('qr') as HTMLCanvasElement, url, { width: 180, margin: 1, errorCorrectionLevel: 'M' });
}

// ---------------------------------------------------------------- mouse and keyboard
/** Mouse (or the joystick's cursor) at x, y: whatever the current game does with a mouse. */
function pointerAt(x: number, y: number, now: number): void {
  if (mode === 'write') write.penMove(x, y, now);
  else if (mode === 'phonics') phonics.penMove(x, y, now);
  else if (mode === 'tennis') tennis.racketMove(x, y, now);
  else if (mode === 'orbit') orbit.aimAt(x, y);
  else if (mode === 'duck') duck.aim(x, y);
  else if (mode === 'fish') fishing.mouseMove(x, y, now);
  else if (mode === 'bowl') bowling.mouseMove(x, y, now);
  else if (mode === 'fruit') fruit.pointerMove(x, y, now);
}

window.addEventListener('pointermove', (e) => {
  if ((mode !== 'fruit' && mode !== 'write' && mode !== 'phonics' && mode !== 'tennis' && mode !== 'orbit' && mode !== 'duck' && mode !== 'fish' && mode !== 'bowl') || menuOpen) return;
  const now = performance.now();
  if (now - lastPadSample < 1500 || now - lastJoy < 1500) return; // phone wins while it is streaming
  pointerAt(e.clientX, e.clientY, now);
});

/** Joystick cursor: speed grows with the square of the push, up to ~1.8 screen heights a second. */
function moveCursor(dt: number, now: number): void {
  if (!POINTING.has(mode) || menuOpen || now - lastJoy > 300) return;
  const v = window.innerHeight * 1.8 * sens;
  const mag = Math.hypot(joy.x, joy.y);
  cursor.x = Math.max(0, Math.min(window.innerWidth, cursor.x + joy.x * mag * v * dt));
  cursor.y = Math.max(0, Math.min(window.innerHeight, cursor.y - joy.y * mag * v * dt));
  pointerAt(cursor.x, cursor.y, now);
}
window.addEventListener('pointerdown', (e) => {
  sfx.unlock();
  if (mode === 'phonics' && !menuOpen && e.target === canvas) phonics.click(e.clientX, e.clientY);
  if (mode === 'duck' && !menuOpen && e.target === canvas) duck.fire();
  if (mode === 'fish' && !menuOpen && e.target === canvas) fishing.click();
  if (mode === 'bowl' && !menuOpen && e.target === canvas) bowling.mouseDown();
});
window.addEventListener('pointerup', () => {
  if (mode === 'bowl' && !menuOpen) bowling.mouseUp(performance.now());
});
window.addEventListener('keydown', (e) => {
  sfx.unlock();
  if (!menuOpen) {
    car.keyDown(e.code);
    if (mode === 'jump') jump.keyDown(e.code);
    if (mode === 'yoga') yoga.keyDown(e.code);
    if (mode === 'maze') maze.keyDown(e.code);
    if (mode === 'sky') sky.keyDown(e.code);
    if (mode === 'snake') snake.keyDown(e.code);
    if (mode === 'orbit') orbit.keyDown(e.code);
  }
  if (e.repeat) {
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    return;
  }
  if (e.code === 'Digit1') choose('fruit');
  else if (e.code === 'Digit2') choose('car');
  else if (e.code === 'Digit3') choose('jump');
  else if (e.code === 'Digit4') choose('yoga');
  else if (e.code === 'Digit5') choose('write');
  else if (e.code === 'Digit6') choose('phonics');
  else if (e.code === 'Digit7') choose('tennis');
  else if (e.code === 'Digit8') choose('maze');
  else if (e.code === 'Digit9') choose('sky');
  else if (e.code === 'Digit0') choose('snake');
  else if (e.code === 'Minus') choose('orbit');
  else if (e.code === 'Equal') choose('uno');
  else if (e.code === 'BracketLeft') choose('duck');
  else if (e.code === 'BracketRight') choose('potato');
  else if (e.code === 'Backslash') choose('fish');
  else if (e.code === 'Semicolon') choose('bowl');
  else if (e.code === 'KeyH') toggleMenu();
  else if (e.code === 'Escape' && menuOpen) closeMenu();
  else if (menuOpen) {
    /* game keys are ignored while the menu is open */
  } else if (e.code === 'Space' || e.code === 'Enter') scene?.requestStart();
  else if (e.code === 'KeyP' || e.code === 'Escape') scene?.togglePause();
  else if (e.code === 'KeyC') {
    if (mode === 'car') car.calibrate();
    else if (mode === 'yoga') yoga.calibrate();
    else if (mode === 'maze') maze.calibrate();
    else if (mode === 'sky') sky.calibrate();
    else if (mode === 'snake') snake.calibrate();
    else if (mode === 'orbit') orbit.calibrate();
    else if (latest) mapper.setCenter(latest);
  } else if (e.code === 'KeyM') sfx.muted = !sfx.muted;
  else if (e.code === 'KeyV' && mode === 'phonics') phonics.nextVoice();
  else if (e.code === 'KeyD') $('debug').hidden = !$('debug').hidden;
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  car.keyUp(e.code);
  jump.keyUp(e.code);
  yoga.keyUp(e.code);
  maze.keyUp(e.code);
  sky.keyUp(e.code);
  orbit.keyUp(e.code);
});
window.addEventListener('blur', () => {
  for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD']) car.keyUp(k);
});

for (const btn of document.querySelectorAll<HTMLButtonElement>('#home [data-game]')) {
  btn.addEventListener('click', () => choose(btn.dataset.game as GameId));
}
$('menuBtn').addEventListener('click', () => {
  sfx.unlock();
  openMenu();
});
$('resumeBtn').addEventListener('click', closeMenu);

// ---------------------------------------------------------------- small UI helpers
function toast(msg: string): void {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
}
function hideToast(): void {
  $('toast').hidden = true;
}

setInterval(() => {
  samplesPerSec = samplesThisSecond;
  samplesThisSecond = 0;
  $('sound').hidden = sfx.ready;
  const dbg = $('debug');
  if (!dbg.hidden) {
    const rtt = net.medianRtt();
    dbg.textContent = [
      `room     ${net.room || '-'}`,
      `phones   ${net.pads.length} (controller ${net.controller || '-'})`,
      `samples  ${samplesPerSec}/s`,
      `rtt      ${rtt === null ? '-' : rtt.toFixed(1) + ' ms'} (laptop→phone→laptop)`,
      `one-way  ~${rtt === null ? '-' : (rtt / 2).toFixed(1) + ' ms'}`,
      `game     ${mode} / ${scene?.state ?? '-'}`,
    ].join('\n');
  }
}, 500);

// ---------------------------------------------------------------- go
let lastLoop = 0;
function loop(t: number): void {
  moveCursor(Math.min(0.05, lastLoop ? (t - lastLoop) / 1000 : 0.016), performance.now());
  lastLoop = t;
  scene?.tick(t);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Handy for debugging from the browser console (and used by the automated test).
Object.assign(window, { __game: fruit, __car: car, __jump: jump, __yoga: yoga, __write: write, __phonics: phonics, __tennis: tennis, __maze: maze, __sky: sky, __snake: snake, __orbit: orbit, __uno: uno, __duck: duck, __potato: potato, __fishing: fishing, __bowling: bowling, __app: { setMode, openMenu, closeMenu, get mode() { return mode; }, get menuOpen() { return menuOpen; } } });

setMode('home');
