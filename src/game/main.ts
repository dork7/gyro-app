import QRCode from 'qrcode';
import { aim, PointerMapper, type Aim } from '../shared/pointer';
import type { GameId } from '../shared/protocol';
import { Sfx } from './audio';
import { CarGame } from './car';
import { Game } from './game';
import { JumpGame } from './jump';
import { YogaGame } from './yoga';
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

const hooks: GameHooks = {
  onSlice: () => net.send({ t: 'haptic', ms: 18 }),
  onHaptic: (ms) => net.send({ t: 'haptic', ms }),
  onChange: () => pushState(),
};
const fruit = new Game(canvas, sfx, hooks);
const car = new CarGame(canvas, sfx, hooks);
const jump = new JumpGame(canvas, sfx, hooks);
const yoga = new YogaGame(canvas, sfx, hooks);

// ---------------------------------------------------------------- which game is showing
let mode: GameId = 'home';
let scene: Scene | null = null;

function setMode(next: GameId): void {
  if (next === mode && next !== 'home') return;
  (scene as (Scene & { exit?: () => void }) | null)?.exit?.();
  resetMenuUi();
  mode = next;
  document.body.dataset.mode = next;
  scene = next === 'fruit' ? fruit : next === 'car' ? car : next === 'jump' ? jump : next === 'yoga' ? yoga : null;
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
    chip.textContent = on ? 'Phone connected ✓' : 'Waiting for phone…';
    if (!on) {
      latest = null;
      car.padLost();
      yoga.padLost();
    }
    if (!on && scene?.state === 'playing') toast('Phone disconnected: reconnecting…');
    if (on) hideToast();
    pushState();
  },
  onSample(s) {
    samplesThisSecond++;
    const now = performance.now();
    lastPadSample = now;
    if (mode === 'car') {
      car.setOrientation(s, now);
      return;
    }
    if (mode === 'yoga') {
      yoga.setOrientation(s, now);
      return;
    }
    latest = aim(s);
    if (!mapper.hasCenter) mapper.setCenter(latest);
    if (mode === 'fruit' && !menuOpen) {
      const p = mapper.map(latest, fruit.w, fruit.h, sens);
      fruit.pointerMove(p.x, p.y, now);
    }
  },
  onButton(name) {
    sfx.unlock();
    if (menuOpen) return;
    if (name === 'center') {
      if (mode === 'car') car.calibrate();
      else if (mode === 'yoga') yoga.calibrate();
      else if (latest) mapper.setCenter(latest);
    } else if (name === 'start') scene?.requestStart();
    else if (name === 'pause') scene?.togglePause();
  },
  onSensitivity(v) {
    if (!Number.isFinite(v)) return;
    sens = Math.max(0.3, Math.min(4, v));
    car.setSensitivity(sens);
  },
  onPedal(gas, brake) {
    car.setPedals(gas, brake);
  },
  onSelect(game) {
    sfx.unlock();
    if (game === 'home') openMenu();
    else if (game === 'fruit' || game === 'car' || game === 'jump' || game === 'yoga') choose(game);
  },
  onJump(strength) {
    sfx.unlock();
    if (mode === 'jump' && !menuOpen) jump.jump(strength);
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
window.addEventListener('pointermove', (e) => {
  if (mode !== 'fruit' || menuOpen) return;
  if (performance.now() - lastPadSample < 1500) return; // phone wins while it is streaming
  fruit.pointerMove(e.clientX, e.clientY, performance.now());
});
window.addEventListener('pointerdown', () => sfx.unlock());
window.addEventListener('keydown', (e) => {
  sfx.unlock();
  if (!menuOpen) {
    car.keyDown(e.code);
    if (mode === 'jump') jump.keyDown(e.code);
    if (mode === 'yoga') yoga.keyDown(e.code);
  }
  if (e.repeat) {
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    return;
  }
  if (e.code === 'Digit1') choose('fruit');
  else if (e.code === 'Digit2') choose('car');
  else if (e.code === 'Digit3') choose('jump');
  else if (e.code === 'Digit4') choose('yoga');
  else if (e.code === 'KeyH') toggleMenu();
  else if (e.code === 'Escape' && menuOpen) closeMenu();
  else if (menuOpen) {
    /* game keys are ignored while the menu is open */
  } else if (e.code === 'Space' || e.code === 'Enter') scene?.requestStart();
  else if (e.code === 'KeyP' || e.code === 'Escape') scene?.togglePause();
  else if (e.code === 'KeyC') {
    if (mode === 'car') car.calibrate();
    else if (mode === 'yoga') yoga.calibrate();
    else if (latest) mapper.setCenter(latest);
  } else if (e.code === 'KeyM') sfx.muted = !sfx.muted;
  else if (e.code === 'KeyD') $('debug').hidden = !$('debug').hidden;
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  car.keyUp(e.code);
  jump.keyUp(e.code);
  yoga.keyUp(e.code);
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
      `phone    ${net.padOn ? 'connected' : 'no'}`,
      `samples  ${samplesPerSec}/s`,
      `rtt      ${rtt === null ? '-' : rtt.toFixed(1) + ' ms'} (laptop→phone→laptop)`,
      `one-way  ~${rtt === null ? '-' : (rtt / 2).toFixed(1) + ' ms'}`,
      `game     ${mode} / ${scene?.state ?? '-'}`,
    ].join('\n');
  }
}, 500);

// ---------------------------------------------------------------- go
function loop(t: number): void {
  scene?.tick(t);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Handy for debugging from the browser console (and used by the automated test).
Object.assign(window, { __game: fruit, __car: car, __jump: jump, __yoga: yoga, __app: { setMode, openMenu, closeMenu, get mode() { return mode; }, get menuOpen() { return menuOpen; } } });

setMode('home');
