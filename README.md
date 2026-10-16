# Gyro Arcade

## Quick install (any Mac, Linux machine or Raspberry Pi)

```bash
curl -fsSL https://raw.githubusercontent.com/dork7/gyro-app/main/setup.sh | bash
```

To start the server right after setup:

```bash
curl -fsSL https://raw.githubusercontent.com/dork7/gyro-app/main/setup.sh | bash -s -- --start
```

This downloads the project into `~/gyro-app`, installs Node.js if it is missing, installs the dependencies, runs the checks and builds. On Windows, run it inside WSL. More options are in [Set up and run](#set-up-and-run).


Four small games that run in the browser on your laptop and use **your phone's motion sensors as the controller**.

| # | Game | How you play |
|---|---|---|
| 1 | 🍉 **Fruit Slicer** | Swing the phone like a sword; the gyroscope moves the blade |
| 2 | 🏎️ **Gyro Racer** | Roll the phone like a steering wheel; tap GAS on the phone to go (tap again to lift off), hold BRAKE |
| 3 | 🦘 **Jump Run** | Really jump. The accelerometer detects it and the runner jumps over obstacles |
| 4 | 🧘 **Yoga Flow** | Phone against your chest, move through five poses and hold them still |
| 7 | 🎾 **Tennis** | Swing the phone like a racket; put it on the ball and hit it back over the net |

```
phone (/pad page)  ──WebSocket──▶  Node server (rooms)  ──WebSocket──▶  laptop (games)
 gyro + accelerometer              pairs by room code                    rendering, physics, scoring
```

## Set up and run

On any Mac, Linux machine, Raspberry Pi or WSL, one script does everything:

```bash
cd gyro-fruit-slicer
bash setup.sh            # installs Node.js if missing, installs dependencies, checks and builds
bash setup.sh --start    # same, then starts the server
bash setup.sh --service  # same, and installs a service that starts at boot (Linux/systemd, good for a Pi)
```

On a machine that has nothing yet, once the code is on GitHub (public repo `dork7/gyro-app`), one line downloads the project into `~/gyro-app` and sets it up:

```bash
curl -fsSL https://raw.githubusercontent.com/dork7/gyro-app/main/setup.sh | bash
curl -fsSL https://raw.githubusercontent.com/dork7/gyro-app/main/setup.sh | bash -s -- --start   # and start it
```

`--skip-tests` makes it faster on a slow machine. It is safe to run again. Node.js is installed with Homebrew (macOS), NodeSource (Debian/Ubuntu/Raspberry Pi OS), dnf or pacman, or nvm as a fallback. On Windows, use WSL.

Or by hand (Node 18+):

```bash
npm install
npm run dev
```

1. Open **https://localhost:5566** on the laptop (accept the certificate warning once).
2. Scan the QR code with your phone. Phone and laptop must be on the **same Wi-Fi**.
3. On the phone, accept the certificate warning, then tap **Enable motion** (iPhone shows a permission prompt).
4. Pick a game on the laptop (click a card, or keys `1`–`4`) or on the phone.

### Changing game

| Where | How |
|---|---|
| Laptop | **☰ Menu** button (top right) or `H` opens the game menu on top of the current game; it pauses the game. Click a card or press `1` Fruit Slicer, `2` Racer, `3` Jump Run, `4` Yoga Flow, `7` Tennis. **Resume** / `Esc` / `H` closes it. |
| Phone | **☰ Choose game** button (bottom of the controller, also **☰ Menu** at the top) opens the same menu on the laptop and shows the game buttons |

### Controls

| Control | Action |
|---|---|
| Phone: Centre | Set the current pose as "neutral" (sword centre, straight wheel, standing tall) |
| Phone: Start / Pause | Start, play again, pause, resume |
| Phone: Sensitivity | Smaller movement for the same effect (jump: easier to trigger) |
| Laptop `Space` / `Enter` | Start (in Jump Run, also jumps) |
| Laptop `P` / `Esc` | Pause (`Esc` closes the menu when it is open) |
| Laptop `C` | Centre |
| Laptop `M` | Mute |
| Laptop `D` | Debug overlay: sample rate and round-trip latency |

Click the laptop page once to enable sound.

### Game notes

**Fruit Slicer.** Hold the phone like a sword, top edge pointing at the screen, press **Centre**, then slice the watermelon to start. Without a phone, a fast mouse works as the blade.

**Gyro Racer.** Hold the phone upright like a wheel, press **Centre**, tap **GAS** once to keep the pedal down and tap it again to lift off. **BRAKE** is held, and it also releases GAS. On the laptop, `↑` / `W` is gas. Arrow keys also work on the laptop.

**Jump Run.** Hold the phone in your hand or keep it in a pocket and jump. The phone page shows a live **jump meter**: a jump must push the bar past the white line. Raise the sensitivity if it misses jumps; lower it if it fires when you walk. Jumping starts the game and restarts it after a game over. The JUMP button, `Space` and `↑` also work (for testing). Collect coins; you have three lives.

**Yoga Flow.** Hold the phone against your chest with both hands, screen facing in or out. After a 4-second "stand tall" countdown the flow starts:
1. Mountain: stand tall
2. Crescent: bend to one side
3. Crescent, other side: bend to the opposite side
4. Forward fold
5. Mountain again

Each pose must be held for 8 seconds and held **still**; if you wobble, progress slows. Slow, steady breathing scores best (60–100 points per pose, up to 500). If the figure leans the wrong way for you, press `F` on the laptop to mirror it. Without a phone, use the arrow keys (left/right = side bend, down/up = fold).

**Tennis.** Hold the phone like a racket handle, top edge pointing at the screen, press **Centre**, then **Start**. The racket on screen follows the phone. A dashed ring shows where the ball will arrive: have the racket there when the ball does. Holding still blocks the ball back softly; the faster you swing the phone, the faster and deeper the ball goes (its speed in km/h shows after each shot), and the direction of the swing aims it (a full upward swing goes long). 1 point for each return that lands in, 3 more when the computer player cannot reach it. Each point starts with a serve into the service box. Swing down at a low ball and it goes into the net; catch it off the middle of the strings and it comes off weak. Letting a ball past costs one of three lives. The mouse also works as the racket.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload (HTTPS, games + controller + WebSocket on one port) |
| `npm start` | Builds, then serves the production build (lighter; use this on a Raspberry Pi) |
| `npm test` | Unit tests (pointer mapping, slice geometry, jump detector, yoga poses) |
| `npm run typecheck` | TypeScript check |

Use another port with `PORT=8443 npm run dev`.

## Running on a Raspberry Pi

Run only the server on the Pi and play on the laptop. This is the easy option and works on a Pi 3.

1. Install Node 20+ on 64-bit Raspberry Pi OS.
2. Copy the project to the Pi (without `node_modules`), then `npm install && npm start`.
3. On the laptop open `https://<pi-ip>:5566` and scan the QR code with the phone.

Notes: use the Pi's IP address (the certificate covers IP addresses, not `raspberrypi.local`); the first start generates the certificate, which takes 10–30 s on a Pi 3; to start it at boot, run `npm start` from a systemd service. Running the games *on* the Pi (Chromium on a monitor) is possible but a Pi 3 will struggle with the Racer; a Pi 4 or 5 is better. Not tested on a Pi yet.

## Why HTTPS?

Phone browsers only give web pages motion-sensor access on HTTPS. The server creates a self-signed certificate for `localhost` and your Wi-Fi address (cached in `.certs/`, regenerated if your IP changes). The cost is a one-time certificate warning on each device.

## How it works

- **`server/`**: HTTPS server, Vite dev middleware, and `rooms.ts`, which pairs one laptop with one phone per 4-letter room code and relays messages. Reconnection is built in on both sides; the laptop keeps its room code across refreshes.
- **`src/shared/`**: code used by both sides: the message types (`protocol.ts`), orientation maths (`pointer.ts`), the jump detector (`jump.ts`) and the yoga pose maths (`yoga.ts`). All of it is unit-tested.
- **`src/game/`**: one file per game (`game.ts` = Fruit Slicer, `car.ts`, `jump.ts`, `yoga.ts`) behind a shared `Scene` interface, plus `main.ts` that connects them to the network.
- **`src/pad/`**: the phone page: permission flow, sensor streaming, jump detection, buttons, wake lock, vibration feedback (Android only).

Jump detection runs **on the phone**: it watches the accelerometer for the take-off spike (about 2 g at default sensitivity) or a short free-fall, and only sends a tiny "jump" message.

## Troubleshooting

| Problem | Fix |
|---|---|
| QR code opens nothing | Phone and laptop must be on the same network. Guest and office Wi-Fi often block device-to-device traffic: try home Wi-Fi or the laptop's hotspot. |
| macOS asks about incoming connections | Allow it for Node. |
| "Motion access denied" on iPhone | Settings → Safari → Motion & Orientation Access, then reload the page. |
| Phone page says motion needs HTTPS | Open the `https://` link from the QR code, not `http://`. |
| "No motion data yet" | Turn off Low Power Mode; make sure the browser has motion access. |
| Jump Run misses jumps or fires too easily | Use the jump meter on the phone and the sensitivity slider. |
| Aim drifts | Press **Centre**. |
| Laggy | Press `D` on the laptop. A round trip above ~40 ms usually means a congested Wi-Fi; try 5 GHz or a hotspot. |

## Status

Tested in a headless browser with simulated phone sensor events: pairing, game switching from the phone and laptop, Fruit Slicer (swipe, speed threshold, bombs), Racer (gas, steering both ways), Jump Run (accelerometer jump, bump rejection, collisions, clearing obstacles), and Yoga Flow (calibration, holding, the opposite-side rule, wobble rejection). Unit tests cover the maths.

**Not yet tested on a real phone.** First things to check on a real device: the certificate flow, which way the sensors move things (flip a sign in `src/shared/pointer.ts` if inverted), the jump meter against your real jumps, and the yoga thresholds (`CALM_DEG_PER_S` in `src/shared/yoga.ts`).
