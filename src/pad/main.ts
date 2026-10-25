import { JumpDetector, spikeThreshold } from '../shared/jump';
import type { GameId, GameState, PadButton } from '../shared/protocol';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const params = new URLSearchParams(location.search);
let room = (params.get('room') ?? '').toUpperCase();

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
    sock.send(JSON.stringify({ t: 'join', room }));
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
        send({ t: 'cfg', sens: Number(($('sens') as HTMLInputElement).value) });
        sendPedals();
        break;
      case 'game':
        gameOn = Boolean(m.on);
        if (gameOn) {
          send({ t: 'cfg', sens: Number(($('sens') as HTMLInputElement).value) });
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
        info = { score: Number(m.score), lives: Number(m.lives), best: Number(m.best) };
        renderInfo();
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
  if (!joined || !gameOn) return;
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
  $('homeCtl').hidden = !home;
  $('gameCtl').hidden = home;
  $('carCtl').hidden = game !== 'car';
  $('jumpCtl').hidden = game !== 'jump';
  $('homeBtn').hidden = home || $('controls').hidden;
  $('gamesBtn').hidden = home || $('controls').hidden;
  $('centerBtn').textContent = game === 'car' ? 'Centre wheel' : game === 'yoga' ? 'Stand tall (recalibrate)' : game === 'write' ? 'Centre pen' : game === 'phonics' ? 'Centre pointer' : game === 'tennis' ? 'Centre racket' : game === 'maze' ? 'Level tray' : game === 'sky' ? 'Level flight' : game === 'snake' ? 'Level phone' : game === 'orbit' ? 'Centre cannon' : 'Centre';

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
            : 'Slice the watermelon or press Start';
  const lines = home
    ? ['Choose a game (or pick the current one to resume)']
    : gameState === 'playing'
      ? [`Score ${info.score}   ${game === 'car' ? 'Cars' : game === 'yoga' ? 'Poses left' : game === 'write' ? 'Digits left' : game === 'phonics' ? 'Sounds left' : game === 'maze' ? 'Marbles' : game === 'sky' ? 'Planes' : game === 'snake' ? 'Length' : game === 'orbit' ? 'Shields' : 'Lives'} ${info.lives}`]
      : gameState === 'over'
        ? [`Game over: ${info.score}  (best ${info.best})`]
        : gameState === 'paused'
          ? ['Paused']
          : [ready];
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
  b.addEventListener('click', () => send({ t: 'select', game: b.dataset.game }));
}
for (const id of ['homeBtn', 'gamesBtn']) {
  $(id).addEventListener('click', () => send({ t: 'select', game: 'home' }));
}

function press(name: PadButton): void {
  send({ t: 'btn', name });
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
    $('enable').hidden = true;
    $('controls').hidden = false;
    void requestWakeLock();
    renderInfo();
  }
});
$('jumpBtn').addEventListener('pointerdown', () => {
  send({ t: 'jump', r: 0 });
  if ('vibrate' in navigator) navigator.vibrate(12);
});
$('centerBtn').addEventListener('click', () => press('center'));
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
  $('meterThr').style.left = `${(spikeThreshold(detector.sens) / 3) * 100}%`;
};
showSens();
sens.addEventListener('input', () => {
  showSens();
  send({ t: 'cfg', sens: Number(sens.value) });
  try {
    localStorage.setItem('sens', sens.value);
  } catch {
    /* ignore */
  }
});

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

// ---------------------------------------------------------------- start
if (!room) {
  $('manual').hidden = false;
  $('hint').textContent = 'Enter the room code from the laptop, then tap the button.';
  setStatus('No room code', 'false');
} else {
  connect();
}
