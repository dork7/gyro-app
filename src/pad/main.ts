import { JumpDetector, spikeThreshold } from '../shared/jump';
import { FlickDetector, neighbour, type PotatoView } from '../shared/potato';
import type { GameId, GameState, PadButton } from '../shared/protocol';
import { canPlay, card, label, sortHand, type Color, type UnoView } from '../shared/uno';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const params = new URLSearchParams(location.search);
let room = (params.get('room') ?? '').toUpperCase();

// This phone's pad id: kept for the life of the tab (also across reloads), so a phone
// that drops out gets its place back, e.g. its UNO hand.
const pid = (() => {
  let id = '';
  try {
    id = sessionStorage.getItem('pid') ?? '';
  } catch {
    /* ignore */
  }
  if (!/^[A-Za-z0-9]{4,16}$/.test(id)) {
    id = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
    try {
      sessionStorage.setItem('pid', id);
    } catch {
      /* ignore */
    }
  }
  return id;
})();

let ws: WebSocket | null = null;
let joined = false;
let gameOn = false;
let sensing = false;
let retry = 400;
let lastEvent = 0;
let sent = 0;
let gameState: GameState = 'menu';
let game: GameId = 'home';
const pedals = { gas: false, brake: false };
const detector = new JumpDetector();
let lastMotion = 0;
let meterPeak = 0;
let info = { score: 0, lives: 3, best: 0 };
let wakeLock: unknown = null;
let ctl = ''; // pad id of the phone that steers the motion games
const PARTY = new Set<GameId>(['uno', 'potato']); // games where every phone plays
let helloFor: GameId | '' = ''; // the party game this phone has joined
const flick = new FlickDetector();
let controlsOn = false;
let useJoy = false; // steer with the on-screen joystick instead of the motion sensors
const NO_JOY = new Set<GameId>(['home', 'jump', 'uno', 'potato']); // games the joystick does not steer
const POINTING = new Set<GameId>(['fruit', 'write', 'phonics', 'tennis', 'duck', 'fish', 'bowl']); // it moves a pointer
try {
  useJoy = localStorage.getItem('joy') === '1';
} catch {
  /* ignore */
}

// ---------------------------------------------------------------- status UI
function setStatus(text: string, kind: 'true' | 'false' | 'error'): void {
  const el = $('status');
  el.textContent = text;
  el.dataset.on = kind;
}
function showError(msg: string): void {
  const e = $('error');
  e.textContent = msg;
  e.hidden = false;
}
function refreshStatus(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) setStatus('Connecting…', 'false');
  else if (!joined) setStatus('Joining…', 'false');
  else if (!gameOn) setStatus('Laptop game not open', 'error');
  else setStatus(`Connected · ${room}`, 'true');
}

// ---------------------------------------------------------------- connection
function connect(): void {
  if (!room) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws`);
  ws = sock;
  sock.onopen = () => {
    retry = 400;
    sock.send(JSON.stringify({ t: 'join', room, pid }));
    refreshStatus();
  };
  sock.onmessage = (ev) => {
    let m: { t: string; [k: string]: unknown };
    try {
      m = JSON.parse(ev.data as string);
    } catch {
      return;
    }
    switch (m.t) {
      case 'joined':
        joined = true;
        gameOn = Boolean(m.gameOn);
        helloFor = '';
        sendCfg();
        sendPedals();
        break;
      case 'game':
        gameOn = Boolean(m.on);
        if (gameOn) {
          sendCfg();
          sendPedals();
        }
        break;
      case 'error':
        joined = false;
        showError(String(m.msg));
        break;
      case 'ping':
        send({ t: 'pong', id: m.id });
        break;
      case 'haptic':
        if ('vibrate' in navigator) navigator.vibrate(Math.min(60, Number(m.ms) || 15));
        break;
      case 'state':
        gameState = m.state as GameState;
        game = (m.game as GameId) ?? 'fruit';
        ctl = typeof m.ctl === 'string' ? m.ctl : '';
        info = { score: Number(m.score), lives: Number(m.lives), best: Number(m.best) };
        if (!PARTY.has(game)) helloFor = '';
        else if (helloFor !== game && controlsOn) sayHello();
        renderInfo();
        break;
      case 'uno':
        uno = m.v as UnoView;
        renderUno();
        break;
      case 'potato':
        pot = m.v as PotatoView;
        renderPotato();
        break;
    }
    refreshStatus();
  };
  sock.onclose = () => {
    joined = false;
    refreshStatus();
    setTimeout(connect, retry);
    retry = Math.min(4000, retry * 2);
  };
}

function send(m: Record<string, unknown>): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

// ---------------------------------------------------------------- sensors
const round = (n: number) => Math.round(n * 100) / 100;

function onOrientation(e: DeviceOrientationEvent): void {
  if (e.alpha === null || e.beta === null) return;
  lastEvent = performance.now();
  if (!joined || !gameOn || useJoy) return;
  send({ t: 's', a: round(e.alpha), b: round(e.beta), g: round(e.gamma ?? 0) });
  sent++;
}

/** Accelerometer: detects real jumps for Jump Run (runs on the phone, so only a tiny message is sent). */
function onMotion(e: DeviceMotionEvent): void {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x === null || a.y === null || a.z === null) return;
  const now = performance.now();
  lastMotion = now;
  const strength = detector.push(Math.hypot(a.x, a.y, a.z), now);
  meterPeak = Math.max(meterPeak, detector.ratio);
  if (strength !== null && game === 'jump' && joined && gameOn) {
    send({ t: 'jump', r: round(strength) });
    if ('vibrate' in navigator) navigator.vibrate(12);
  }
  // Hot Potato: a sideways flick throws the potato, if this phone has it
  const dir = flick.push(a.x, now);
  if (dir !== null && game === 'potato' && potHolding()) passPotato(dir);
}

async function enableMotion(): Promise<boolean> {
  if (!window.isSecureContext) {
    showError('Motion sensors need HTTPS. Open the https:// link from the laptop QR code.');
    return false;
  }
  if (typeof DeviceOrientationEvent === 'undefined') {
    showError('This browser has no motion sensor support.');
    return false;
  }
  // iOS asks once for "Motion & Orientation"; ask for both sensors inside this tap.
  const asks: Promise<string>[] = [];
  for (const E of [DeviceOrientationEvent, typeof DeviceMotionEvent !== 'undefined' ? DeviceMotionEvent : undefined]) {
    const req = (E as unknown as { requestPermission?: () => Promise<string> } | undefined)?.requestPermission;
    if (typeof req === 'function') asks.push(req.call(E));
  }
  if (asks.length) {
    try {
      const res = await Promise.all(asks);
      if (res.some((r) => r !== 'granted')) {
        showError('Motion access was denied. On iPhone: Settings → Safari → Motion & Orientation Access, then reload this page.');
        return false;
      }
    } catch {
      showError('Could not ask for motion access. Reload the page and tap the button again.');
      return false;
    }
  }
  window.addEventListener('deviceorientation', onOrientation);
  window.addEventListener('devicemotion', onMotion);
  sensing = true;
  // If nothing arrives soon, explain why.
  setTimeout(() => {
    if (sensing && performance.now() - lastEvent > 1500) {
      $('info').textContent = 'No motion data yet. Check that the browser has motion access, and that Low Power Mode is off.';
    }
  }, 2000);
  return true;
}

async function requestWakeLock(): Promise<void> {
  try {
    wakeLock = await (navigator as unknown as { wakeLock?: { request(t: string): Promise<unknown> } }).wakeLock?.request('screen');
    if (wakeLock && typeof wakeLock === 'object' && 'addEventListener' in wakeLock) {
      (wakeLock as EventTarget).addEventListener('release', () => {
        wakeLock = null;
        updateWakeStatus();
        if (sensing && document.visibilityState === 'visible') void requestWakeLock();
      });
    }
    updateWakeStatus();
  } catch {
    /* not supported or denied: fine */
  }
}

async function releaseWakeLock(): Promise<void> {
  if (wakeLock && typeof wakeLock === 'object' && 'release' in wakeLock) {
    try { await (wakeLock as { release(): Promise<void> }).release(); } catch { /* ignore */ }
    wakeLock = null;
  }
  updateWakeStatus();
}

function updateWakeStatus(): void {
  const el = $('wakeStatus');
  if (wakeLock) {
    el.hidden = false;
    el.dataset.on = 'true';
  } else {
    el.hidden = true;
    el.dataset.on = 'false';
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && sensing) void requestWakeLock();
  else if (document.visibilityState === 'hidden' && wakeLock) void releaseWakeLock();
});

window.addEventListener('pagehide', () => void releaseWakeLock());
window.addEventListener('beforeunload', () => void releaseWakeLock());

// ---------------------------------------------------------------- UI wiring
function renderInfo(): void {
  document.body.dataset.game = game;
  const home = game === 'home';
  const isUno = game === 'uno';
  const isPot = game === 'potato';
  $('homeCtl').hidden = !home;
  $('gameCtl').hidden = home || isUno || isPot;
  $('unoCtl').hidden = !isUno;
  $('potCtl').hidden = !isPot;
  if (!isUno && !isPot) $('partyName').hidden = true;
  $('info').hidden = isUno || isPot;
  $('carCtl').hidden = game !== 'car';
  $('jumpCtl').hidden = game !== 'jump';
  $('duckCtl').hidden = game !== 'duck';
  $('bowlCtl').hidden = game !== 'bowl';
  const joyOn = useJoy && !NO_JOY.has(game);
  document.body.classList.toggle('joy', joyOn);
  $('joyCtl').hidden = !joyOn;
  $('actBtn').hidden = !(game === 'fish' || game === 'phonics');
  $('actBtn').textContent = game === 'fish' ? 'CAST / STRIKE' : 'PICK';
  $('centerBtn').hidden = joyOn;
  $('modeBtn').textContent = useJoy ? '📱 Use motion instead of the joystick' : '🕹️ Use joystick instead of motion';
  $('homeBtn').hidden = home || $('controls').hidden;
  $('gamesBtn').hidden = home || $('controls').hidden;
  $('centerBtn').textContent = game === 'car' ? 'Centre wheel' : game === 'yoga' ? 'Stand tall (recalibrate)' : game === 'write' ? 'Centre pen' : game === 'phonics' ? 'Centre pointer' : game === 'tennis' ? 'Centre racket' : game === 'maze' ? 'Level tray' : game === 'sky' ? 'Level flight' : game === 'snake' ? 'Level phone' : game === 'orbit' ? 'Centre cannon' : game === 'duck' ? 'Centre gun' : game === 'fish' ? 'Centre rod' : 'Centre';

  const ready =
    game === 'car'
      ? 'Tap GAS to go (tap again to stop), roll the phone like a wheel'
      : game === 'jump'
        ? 'Jump to start (or tap JUMP)'
        : game === 'yoga'
          ? 'Hold the phone to your chest, stand tall, press Start'
          : game === 'write'
            ? 'Hold the phone like a pen, point at the screen, Centre pen, then Start'
            : game === 'phonics'
              ? 'Point at the screen, Centre pointer, then Start and listen'
              : game === 'tennis'
                ? 'Hold the phone like a racket, point at the screen, Centre racket, then Start'
                : game === 'maze'
                  ? 'Hold the phone flat, screen up, Level tray, then Start and tilt'
                  : game === 'sky'
                    ? 'Hold the phone like a wheel, Level flight, then Start'
                    : game === 'snake'
                      ? 'Hold the phone flat, screen up, Level phone, then Start and tip to steer'
                      : game === 'orbit'
                        ? 'Hold the phone flat, Centre cannon, then Start and twist to aim'
                        : game === 'duck'
                          ? 'Point the phone at the screen like a gun, Centre gun, then FIRE'
                          : game === 'fish'
                            ? 'Hold the phone like a rod, Centre rod, Start, then whip forward to cast'
                            : game === 'bowl'
                              ? 'Point at the screen, Centre, then hold GRIP, swing underarm and let go'
            : 'Slice the watermelon or press Start';
  const lines = home
    ? ['Choose a game (or pick the current one to resume)']
    : gameState === 'playing'
      ? [`Score ${info.score}   ${game === 'car' ? 'Cars' : game === 'yoga' ? 'Poses left' : game === 'write' ? 'Digits left' : game === 'phonics' ? 'Sounds left' : game === 'maze' ? 'Marbles' : game === 'sky' ? 'Planes' : game === 'snake' ? 'Length' : game === 'orbit' ? 'Shields' : game === 'duck' ? 'Shells' : game === 'fish' ? 'Seconds' : game === 'bowl' ? 'Frame' : 'Lives'} ${info.lives}`]
      : gameState === 'over'
        ? [`Game over: ${info.score}  (best ${info.best})`]
        : gameState === 'paused'
          ? ['Paused']
          : [ready];
  if (joyOn && gameState !== 'playing' && !home) lines.push(game === 'fish' || game === 'phonics' ? 'Joystick: move the pointer, ACTION to cast or pick' : game === 'bowl' ? 'Joystick: line up, hold GRIP, flick the stick up and let go' : POINTING.has(game) ? 'Joystick: push to move the pointer' : 'Joystick: push the stick to steer');
  if (!home && ctl && ctl !== pid) lines.push('Another phone is the controller: press Centre or Start to take over.');
  $('info').textContent = lines.join('\n');
  $('pauseBtn').textContent = gameState === 'paused' ? 'Resume' : 'Pause';
  $('startBtn').textContent = gameState === 'over' ? 'Play again' : game === 'write' && gameState === 'playing' ? 'Skip digit' : game === 'phonics' && gameState === 'playing' ? '🔊 Hear again' : 'Start';
  if (home || game !== 'car' || gameState === 'over') releasePedals();
}

function sendPedals(): void {
  send({ t: 'pedal', gas: pedals.gas, brake: pedals.brake });
}
function releasePedals(): void {
  if (!pedals.gas && !pedals.brake) return;
  pedals.gas = false;
  pedals.brake = false;
  sendPedals();
  $('gasBtn').classList.remove('down');
  $('brakeBtn').classList.remove('down');
}
/** BRAKE is held. GAS is a toggle: tap once to keep going, tap again (or hit BRAKE) to lift off. */
function setPedal(key: 'gas' | 'brake', on: boolean): void {
  if (pedals[key] === on) return;
  pedals[key] = on;
  $(key === 'gas' ? 'gasBtn' : 'brakeBtn').classList.toggle('down', on);
  sendPedals();
}
function bindPedal(el: HTMLElement, key: 'gas' | 'brake'): void {
  el.addEventListener('pointerdown', (e) => {
    if (key === 'gas') {
      setPedal('gas', !pedals.gas);
    } else {
      el.setPointerCapture(e.pointerId);
      setPedal('gas', false);
      setPedal('brake', true);
    }
    if ('vibrate' in navigator) navigator.vibrate(8);
  });
  if (key === 'brake') {
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(ev, () => setPedal('brake', false));
  }
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
bindPedal($('gasBtn'), 'gas');
bindPedal($('brakeBtn'), 'brake');

for (const b of document.querySelectorAll<HTMLButtonElement>('#homeCtl [data-game]')) {
  b.addEventListener('click', () => {
    send({ t: 'select', game: b.dataset.game });
    claimSettings();
  });
}
for (const id of ['homeBtn', 'gamesBtn']) {
  $(id).addEventListener('click', () => send({ t: 'select', game: 'home' }));
}

function press(name: PadButton): void {
  send({ t: 'btn', name });
  claimSettings();
  if ('vibrate' in navigator) navigator.vibrate(10);
}

$('enableBtn').addEventListener('click', async () => {
  $('error').hidden = true;
  if (!room) {
    const typed = ($('roomInput') as HTMLInputElement).value.trim().toUpperCase();
    if (typed.length !== 4) {
      showError('Enter the 4-letter room code shown on the laptop.');
      return;
    }
    room = typed;
    connect();
  }
  if (await enableMotion()) {
    setJoy(false);
    showControls();
  }
});
// Card games need no sensors: join straight away (no permission prompt).
$('noMotionBtn').addEventListener('click', () => {
  $('error').hidden = true;
  if (!room) {
    const typed = ($('roomInput') as HTMLInputElement).value.trim().toUpperCase();
    if (typed.length !== 4) {
      showError('Enter the 4-letter room code shown on the laptop.');
      return;
    }
    room = typed;
    connect();
  }
  setJoy(true);
  showControls();
});

function setJoy(on: boolean): void {
  useJoy = on;
  try {
    localStorage.setItem('joy', on ? '1' : '0');
  } catch {
    /* ignore */
  }
  renderInfo();
}
$('modeBtn').addEventListener('click', async () => {
  if (useJoy && !sensing && !(await enableMotion())) return;
  setJoy(!useJoy);
});

// Joystick: the knob follows the thumb inside the ring and springs back on release. The
// position goes out on every move and at least every 50 ms while held, so the laptop
// knows the stick is still pushed.
{
  const pad = $('joy');
  const knob = $('joyKnob');
  let held: number | null = null;
  let jx = 0;
  let jy = 0;
  let lastSend = 0;
  const sendJoy = () => {
    lastSend = performance.now();
    send({ t: 'joy', x: round(jx), y: round(jy) });
  };
  const moveTo = (e: PointerEvent) => {
    const r = pad.getBoundingClientRect();
    const reach = r.width * 0.31; // ring radius minus half the knob
    let dx = (e.clientX - (r.left + r.width / 2)) / reach;
    let dy = (e.clientY - (r.top + r.height / 2)) / reach;
    const m = Math.hypot(dx, dy);
    if (m > 1) {
      dx /= m;
      dy /= m;
    }
    jx = dx;
    jy = -dy;
    knob.style.transform = `translate(${dx * reach}px, ${dy * reach}px)`;
    if (performance.now() - lastSend > 16) sendJoy();
  };
  pad.addEventListener('pointerdown', (e) => {
    pad.setPointerCapture(e.pointerId);
    held = e.pointerId;
    pad.classList.add('held');
    moveTo(e);
    if ('vibrate' in navigator) navigator.vibrate(8);
  });
  pad.addEventListener('pointermove', (e) => {
    if (e.pointerId === held) moveTo(e);
  });
  const letGo = (e: PointerEvent) => {
    if (e.pointerId !== held) return;
    held = null;
    jx = 0;
    jy = 0;
    knob.style.transform = '';
    pad.classList.remove('held');
    sendJoy();
  };
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) pad.addEventListener(ev, letGo);
  pad.addEventListener('contextmenu', (e) => e.preventDefault());
  setInterval(() => {
    if (held !== null && performance.now() - lastSend > 50) sendJoy();
  }, 50);
}
$('actBtn').addEventListener('pointerdown', () => press('act'));
$('actBtn').addEventListener('contextmenu', (e) => e.preventDefault());

function showControls(): void {
  $('enable').hidden = true;
  $('controls').hidden = false;
  controlsOn = true;
  void requestWakeLock();
  renderInfo();
  if (PARTY.has(game) && helloFor !== game) sayHello();
}
$('jumpBtn').addEventListener('pointerdown', () => {
  send({ t: 'jump', r: 0 });
  if ('vibrate' in navigator) navigator.vibrate(12);
});
$('centerBtn').addEventListener('click', () => press('center'));
// the trigger fires on touch-down: no waiting for the finger to lift
$('fireBtn').addEventListener('pointerdown', () => {
  send({ t: 'btn', name: 'fire' });
  if ('vibrate' in navigator) navigator.vibrate(25);
});
$('fireBtn').addEventListener('contextmenu', (e) => e.preventDefault());
// bowling: the ball is held while the thumb is down and released when it lifts
{
  const grip = $('gripBtn');
  let held = false;
  grip.addEventListener('pointerdown', (e) => {
    grip.setPointerCapture(e.pointerId);
    held = true;
    grip.classList.add('down');
    send({ t: 'btn', name: 'grip' });
    if ('vibrate' in navigator) navigator.vibrate(10);
  });
  const letGo = () => {
    if (!held) return;
    held = false;
    grip.classList.remove('down');
    send({ t: 'btn', name: 'release' });
  };
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) grip.addEventListener(ev, letGo);
  grip.addEventListener('contextmenu', (e) => e.preventDefault());
}
$('startBtn').addEventListener('click', () => press('start'));
$('pauseBtn').addEventListener('click', () => press('pause'));

const sens = $('sens') as HTMLInputElement;
try {
  sens.value = localStorage.getItem('sens') ?? '1';
} catch {
  /* ignore */
}
const showSens = () => {
  $('sensVal').textContent = `${Number(sens.value).toFixed(1)}×`;
  detector.sens = Number(sens.value);
  flick.sens = Number(sens.value);
  $('meterThr').style.left = `${(spikeThreshold(detector.sens) / 3) * 100}%`;
};
showSens();
sens.addEventListener('input', () => {
  showSens();
  sendCfg();
  try {
    localStorage.setItem('sens', sens.value);
  } catch {
    /* ignore */
  }
});

const lefty = $('lefty') as HTMLInputElement;
try {
  lefty.checked = localStorage.getItem('lefty') === '1';
} catch {
  /* ignore */
}
lefty.addEventListener('change', () => {
  sendCfg();
  try {
    localStorage.setItem('lefty', lefty.checked ? '1' : '0');
  } catch {
    /* ignore */
  }
});

function sendCfg(): void {
  send({ t: 'cfg', sens: Number(sens.value), lefty: lefty.checked });
}

/**
 * A button press or game pick makes this phone the controller, and the laptop only takes
 * settings from the controller: send ours right after, so they apply from now on.
 */
function claimSettings(): void {
  if (ctl !== pid) sendCfg();
}

// Jump meter: live accelerometer strength with a peak hold, so you can see what a jump looks like.
function meterLoop(): void {
  if (!$('jumpCtl').hidden) {
    const bar = $('meterBar');
    const shown = Math.min(3, Math.max(detector.ratio, meterPeak));
    bar.style.width = `${(shown / 3) * 100}%`;
    bar.classList.toggle('hot', shown >= spikeThreshold(detector.sens));
    meterPeak *= 0.94;
    if (game === 'jump' && sensing && performance.now() - lastMotion > 2500) {
      $('meterLabel').textContent = 'No accelerometer data. Check motion access in the browser settings.';
    } else {
      $('meterLabel').textContent = 'Jump meter: the bar must pass the line';
    }
  }
  requestAnimationFrame(meterLoop);
}
requestAnimationFrame(meterLoop);

// Samples sent per second, readable from the console / tests as window.__padRate
setInterval(() => {
  (window as unknown as { __padRate: number }).__padRate = sent;
  sent = 0;
}, 1000);

// ---------------------------------------------------------------- UNO
// The laptop runs the game and sends this phone a view with only its own hand.
let uno: UnoView | null = null;
let unoArmed = false; // UNO! pressed, sent with the next card
let unoHidden = false;
let pickFor: number | null = null; // wild card waiting for a colour
let wasMyTurn = false;

const nameInput = $('unoName') as HTMLInputElement;
try {
  nameInput.value = localStorage.getItem('unoName') ?? '';
} catch {
  /* ignore */
}

/** Join the party game that is open on the laptop (UNO or Hot Potato), with our name. */
function sayHello(): void {
  if (!joined || !PARTY.has(game)) return;
  helloFor = game;
  send({ t: game, a: 'hello', name: nameInput.value.trim() });
}

function cardEl(id: number, cls = ''): HTMLButtonElement {
  const c = card(id);
  const el = document.createElement('button');
  el.className = `ucard ${c.color ? 'c-' + c.color : 'wild'} ${cls}`;
  const span = document.createElement('span');
  span.textContent = label(c);
  el.append(span);
  return el;
}

function renderUno(): void {
  const v = uno;
  if (!v) return;
  const lobby = v.phase === 'lobby';
  const mine = v.phase === 'play' && v.you >= 0 && v.turn === v.you;
  $('unoLobby').hidden = !lobby && v.phase !== 'over';
  $('partyName').hidden = !lobby;
  $('unoPlay').hidden = lobby || v.you < 0;
  $('unoStart').textContent = lobby ? 'Start round' : 'Next round';
  $('unoStart').hidden = !(lobby || v.phase === 'over');

  // status line
  const status = $('unoStatus');
  status.className = mine ? 'mine' : '';
  if (lobby) status.textContent = v.you >= 0 ? `You are in · ${v.names.length} player${v.names.length === 1 ? '' : 's'}` : 'Joining…';
  else if (v.phase === 'paused') status.textContent = 'Paused';
  else if (v.phase === 'over') status.textContent = v.winner === v.you ? 'You win! 🎉' : `${v.names[v.winner ?? 0]} wins`;
  else if (v.you < 0) status.textContent = 'Watching: you join next round';
  else status.textContent = mine ? 'Your turn!' : `${v.names[v.turn]}'s turn`;
  $('unoLog').textContent = v.log;
  const note = $('unoNote');
  note.hidden = !v.note;
  note.textContent = v.note ?? '';
  if (mine && !wasMyTurn && 'vibrate' in navigator) navigator.vibrate([30, 60, 30]);
  wasMyTurn = mine;

  // top of the discard pile, painted in the colour in play
  const topEl = $('unoTop');
  topEl.replaceChildren();
  if (v.top >= 0) {
    const t = cardEl(v.top, 'mini');
    if (v.color && card(v.top).color === null) t.className = `ucard mini c-${v.color}`;
    topEl.replaceWith(t);
    t.id = 'unoTop';
  } else {
    topEl.className = 'ucard mini empty';
  }

  // lobby: who is here
  const players = $('unoPlayers');
  players.replaceChildren(
    ...v.names.map((n, i) => {
      const el = document.createElement('span');
      el.textContent = v.phase === 'over' ? `${n} · ${v.totals[i]} pts` : n;
      if (i === v.you) el.className = 'me';
      return el;
    }),
  );

  // hand
  const hand = $('unoHand');
  hand.classList.toggle('turn', mine);
  hand.classList.toggle('covered', unoHidden);
  $('unoCover').hidden = !unoHidden;
  $('unoHide').textContent = unoHidden ? '👀 Show my cards' : '🙈 Hide my cards';
  const top = v.top >= 0 ? card(v.top) : null;
  hand.replaceChildren(
    ...sortHand(v.hand).map((id) => {
      const ok = mine && top !== null && v.color !== null && canPlay(card(id), top, v.color) && (v.drawn === null || v.drawn === id);
      const el = cardEl(id, `${ok ? 'ok' : ''} ${id === v.drawn ? 'drawn' : ''}`);
      el.addEventListener('click', () => tapCard(id, ok));
      return el;
    }),
  );

  // buttons
  ($('unoDraw') as HTMLButtonElement).disabled = !mine || v.drawn !== null;
  $('unoDraw').hidden = mine && v.drawn !== null;
  $('unoPass').hidden = !(mine && v.drawn !== null);
  const sayUno = mine && v.hand.length === 2;
  if (!sayUno) unoArmed = false;
  $('unoSay').hidden = !sayUno;
  $('unoSay').classList.toggle('armed', unoArmed);
  $('unoSay').textContent = unoArmed ? 'UNO! ✓' : 'Say UNO!';
}

function tapCard(id: number, ok: boolean): void {
  if (!uno || !ok) {
    if ('vibrate' in navigator) navigator.vibrate(8);
    return;
  }
  if (card(id).color === null) {
    pickFor = id;
    $('unoColors').hidden = false;
    return;
  }
  playCard(id);
}

function playCard(id: number, color?: Color): void {
  send({ t: 'uno', a: 'play', card: id, color, uno: unoArmed });
  unoArmed = false;
  if ('vibrate' in navigator) navigator.vibrate(12);
}

for (const b of document.querySelectorAll<HTMLButtonElement>('#unoColors [data-color]')) {
  b.addEventListener('click', () => {
    $('unoColors').hidden = true;
    if (pickFor !== null) playCard(pickFor, b.dataset.color as Color);
    pickFor = null;
  });
}
$('unoColorCancel').addEventListener('click', () => {
  $('unoColors').hidden = true;
  pickFor = null;
});
$('unoDraw').addEventListener('click', () => send({ t: 'uno', a: 'draw' }));
$('unoPass').addEventListener('click', () => send({ t: 'uno', a: 'pass' }));
$('unoStart').addEventListener('click', () => send({ t: 'uno', a: 'start' }));
$('unoSay').addEventListener('click', () => {
  unoArmed = !unoArmed;
  renderUno();
});
for (const id of ['unoHide', 'unoCover']) {
  $(id).addEventListener('click', () => {
    unoHidden = !unoHidden;
    renderUno();
  });
}
nameInput.addEventListener('change', () => {
  try {
    localStorage.setItem('unoName', nameInput.value.trim());
  } catch {
    /* ignore */
  }
  if (PARTY.has(game)) sayHello();
});

// ---------------------------------------------------------------- Hot Potato
// The laptop runs the game; this phone shows who has the potato and, when it is ours,
// turns red and lets us throw it with a flick or the arrow buttons.
let pot: PotatoView | null = null;
let lastPass = 0;

function potHolding(): boolean {
  return !!pot && pot.phase === 'play' && pot.you >= 0 && pot.holder === pot.you && !pot.flying;
}

function passPotato(dir: 1 | -1): void {
  const now = performance.now();
  if (now - lastPass < 400) return;
  lastPass = now;
  send({ t: 'potato', a: 'pass', dir });
  if ('vibrate' in navigator) navigator.vibrate(20);
}

function renderPotato(): void {
  const v = pot;
  if (!v) return;
  const lobby = v.phase === 'lobby';
  const mine = potHolding();
  const out = v.you >= 0 && v.lives[v.you] <= 0;
  $('partyName').hidden = !lobby;
  $('potStart').hidden = !(lobby || v.phase === 'over');
  $('potStart').textContent = lobby ? 'Start' : 'Play again';
  $('potHot').hidden = !mine;
  document.body.classList.toggle('hot', mine);
  document.body.style.setProperty('--heat', String(v.heat));

  const status = $('potStatus');
  if (lobby) status.textContent = v.you >= 0 ? `You are in · ${v.names.length} player${v.names.length === 1 ? '' : 's'}` : 'Joining…';
  else if (v.phase === 'over') status.textContent = v.winner === v.you ? 'You win! 🏆' : `${v.names[v.winner ?? 0]} wins`;
  else if (v.phase === 'paused') status.textContent = 'Paused';
  else if (v.phase === 'boom') status.textContent = v.holder === v.you ? '💥 BOOM! It went off on you' : `💥 BOOM! ${v.names[v.holder]}`;
  else if (v.you < 0) status.textContent = 'Watching: you join next game';
  else if (out) status.textContent = 'You are out 💀';
  else if (mine) status.textContent = 'You have the potato!';
  else status.textContent = v.flying ? `Potato flying to ${v.names[v.holder]}…` : `${v.names[v.holder]} has the potato`;
  $('potLog').textContent = v.log;
  const note = $('potNote');
  note.hidden = !v.note;
  note.textContent = v.note ?? '';
  $('potLives').textContent = v.you >= 0 && !lobby ? Array.from({ length: 3 }, (_, k) => (k < v.lives[v.you] ? '❤️' : '🖤')).join(' ') : '';

  if (mine) {
    $('potLeft').textContent = `◀ ${v.names[neighbour(v.lives, v.you, -1)]}`;
    $('potRight').textContent = `${v.names[neighbour(v.lives, v.you, 1)]} ▶`;
    $('potCall').textContent = sensing ? 'FLICK TO PASS!' : 'TAP TO PASS!';
  }

  $('potPlayers').replaceChildren(
    ...v.names.map((n, i) => {
      const el = document.createElement('span');
      el.textContent = lobby ? n : `${n} ${v.lives[i] > 0 ? '❤️'.repeat(v.lives[i]) : '💀'}`;
      if (i === v.you) el.className = 'me';
      if (!lobby && i === v.holder) el.className += ' has';
      return el;
    }),
  );
}

$('potLeft').addEventListener('pointerdown', () => potHolding() && passPotato(-1));
$('potRight').addEventListener('pointerdown', () => potHolding() && passPotato(1));
$('potStart').addEventListener('click', () => send({ t: 'potato', a: 'start' }));

// ---------------------------------------------------------------- start
if (!room) {
  $('manual').hidden = false;
  $('hint').textContent = 'Enter the room code from the laptop, then tap the button.';
  setStatus('No room code', 'false');
} else {
  connect();
}
