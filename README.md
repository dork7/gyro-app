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


Small games that run in the browser on your laptop and use **your phone's motion sensors as the controller**.

| # | Game | How you play |
|---|---|---|
| 1 | 🍉 **Fruit Slicer** | Swing the phone like a sword; the gyroscope moves the blade |
| 2 | 🏎️ **Gyro Racer** | Roll the phone like a steering wheel; tap GAS on the phone to go (tap again to lift off), hold BRAKE |
| 3 | 🦘 **Jump Run** | Really jump. The accelerometer detects it and the runner jumps over obstacles |
| 4 | 🧘 **Yoga Flow** | Phone against your chest, move through five poses and hold them still |
| 7 | 🎾 **Tennis** | Swing the phone like a racket; put it on the ball and hit it back over the net |
| 8 | 🎱 **Marble Maze** | Hold the phone flat like a tray and tilt it to roll a marble through the maze |
| 9 | ✈️ **Sky Rings** | Hold the phone like an aircraft yoke: turn to bank, pull back to climb, fly through the rings |
| 0 | 🐍 **Gyro Snake** | Hold the phone flat and tip it toward where the snake should go |
| − | 🪐 **Orbit Defender** | Hold the phone flat and twist it like a dial to swing a cannon round your planet |
| = | 🃏 **UNO** | 2–8 players: everyone scans the QR code and plays their own hand on their phone |
| [ | 🦆 **Duck Shoot** | Aim the phone like a gun and press FIRE to shoot the ducks |
| ] | 🥔 **Hot Potato** | 2–8 players: flick your phone to throw the potato to a neighbour before it blows |
| \\ | 🎣 **Fishing** | Whip the phone forward to cast, jerk it up to strike, move it in circles to reel |
| ; | 🎳 **Bowling** | Hold GRIP on the phone, swing your arm underarm, and let go to bowl |

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
4. Pick a game on the laptop (click a card, or keys `1`–`9`, `0`, `-`, `=`, `[`, `]`, `\` and `;`) or on the phone.

### Changing game

| Where | How |
|---|---|
| Laptop | **☰ Menu** button (top right) or `H` opens the game menu on top of the current game; it pauses the game. Click a card or press `1` Fruit Slicer, `2` Racer, `3` Jump Run, `4` Yoga Flow, `7` Tennis, `8` Marble Maze, `9` Sky Rings, `0` Gyro Snake, `-` Orbit Defender, `=` UNO, `[` Duck Shoot, `]` Hot Potato, `\` Fishing, `;` Bowling. **Resume** / `Esc` / `H` closes it. |
| Phone | **☰ Choose game** button (bottom of the controller, also **☰ Menu** at the top) opens the same menu on the laptop and shows the game buttons |

### Controls

| Control | Action |
|---|---|
| Phone: Centre | Set the current pose as "neutral" (sword centre, straight wheel, standing tall, level tray, level flight, level phone, cannon up) |
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

**Tennis.** Hold the phone like a racket handle, top edge pointing at the screen, press **Centre**, then **Start**. The racket on screen follows the phone. A dashed ring shows where the ball will arrive: have the racket there when the ball does. An outer ring closes onto it as the ball gets there, and both turn green while the racket is in reach. Holding still blocks the ball back softly; the faster you swing the phone, the faster and deeper the ball goes (its speed in km/h shows after each shot), but never long. Timing aims it: hit early and it goes cross-court, hit late and it goes down the line (from the middle of the court, early goes left and late goes right; tick **Left-handed** on the phone to flip that). A marker on the far court shows where the shot would land if you hit now, and turns red where a badly mistimed shot would go wide. The racket reaches generously: a ball caught near the edge still goes back, just weakly. 1 point for each return that lands in, 3 more when the computer player cannot reach it. Every 4 shots in a rally raise the points multiplier by one, up to x4 (it applies to winners too). A ball hit off the sweet spot of the strings scores 1 more, and one that lands in the pulsing gold square on the far court scores 2 more; the square moves after each point. A 10-shot rally wins back a lost life. Each point starts with a serve into the service box. Swing down at a low ball and it goes into the net; catch it off the middle of the strings and it comes off weak. Letting a ball past costs one of three lives. The mouse also works as the racket.

**Marble Maze.** Hold the phone flat on your palm, screen up, top edge pointing at the screen, and press **Level tray** (it sets how you hold it as "flat"), then **Start**. Tilt the phone to roll the marble to the 🏁; a bubble level in the corner shows the tilt. Holes wait in the mouths of side passages, so take turns carefully: a marble that drops in costs one of three. 💎 in dead ends are worth 25. Each cleared maze scores 100 × its number plus a time bonus, and the next one is bigger. Without a phone, the arrow keys tilt the tray.

**Sky Rings.** Hold the phone upright in both hands like a steering wheel, screen facing you, press **Level flight**, then **Start**. Turn the phone to bank left or right; like a real yoke, pull the top edge back toward you to climb and push it away to dive (press `I` on the laptop to invert that; it is remembered). Fly through the rings: 10 points, 20 through the white centre, triple for gold rings, and every 5 rings in a row raise the multiplier (up to ×5). A missed ring costs one of three planes and resets the multiplier. The course speeds up and the rings shrink as you go. Without a phone, the arrow keys fly the plane.

**Gyro Snake.** Hold the phone flat, screen up, top edge pointing at the screen, press **Level phone**, then **Start**. Tip the phone toward where the snake should go: forward is up, toward you is down. Only the stronger tilt counts, and once it has turned you can level the phone again. The indicator in the corner shows your tilt and the direction it asks for. 🍎 are 10 points; every fifth apple a ⭐ appears for 6 seconds, worth 50 and three extra segments. The snake speeds up as it grows; walls and its own tail end the run. Without a phone, use the arrow keys.

**Orbit Defender.** Hold the phone flat like a dial, top edge pointing at the screen, press **Centre cannon** (the cannon then points up), then **Start**. Twist the phone to swing the cannon round the planet: a quarter turn of the wrist each way covers the whole circle, or turn on the spot for finer aim. The cannon fires by itself, and the glowing shield arc in front of it stops meteors that get through (2 points). Shot meteors are 10; big rocks take three hits, are worth 30 and split in two. Shoot a ⚡ for six seconds of triple rapid fire. Three hits on the planet end the run. It uses the phone's compass heading, which can drift on some phones: press **Centre cannon** again if the aim wanders. Without a phone, the mouse aims (or the left/right arrow keys).

**UNO.** A card game for 2–8 players, each with their own phone. Pick UNO on the laptop, then every player scans the QR code and taps **Continue without motion** (no sensors needed), types a name, and anyone presses **Start round**. Each phone shows only its owner's hand: when it is your turn (the phone buzzes), tap a highlighted card to play it (wilds ask for a colour), or tap **Draw card**; a drawn card that fits can be played straight away, or **Keep & pass**. With two cards left, tap **Say UNO!** before playing one, or you draw two. **Hide my cards** covers the hand when someone is looking. The laptop is the table: discard pile, colour in play, direction of play, everyone's card count and points. Standard rules, simplified: the first card turned up is always a number, no stacking of +2/+4, and no challenging a Wild +4. The winner of a round scores the cards left in the other hands. A phone that drops out gets its hand back when it reconnects; if it stays away on its turn, the table draws and passes for it after 20 seconds. Players who join during a round are dealt in next round.

**Duck Shoot.** Point the phone at the screen like a gun, top edge first, and press **Centre gun**; the red crosshair follows where you point. Press the big **FIRE** button with your thumb to start and to shoot. Ducks come two at a time with three shells for each pair; a round is ten ducks, and you must hit six to go on (one more each round, up to all ten). Blue ducks are fast, gold ducks are rare and very fast; points grow with the round, and ten out of ten earns a 10,000 bonus. The dog shows the ducks you hit, or laughs when you miss. Without a phone, aim with the mouse and click to shoot.

**Hot Potato.** A party game for 2–8 players, each with their own phone. Pick Hot Potato on the laptop; every player scans the QR code, taps **Enable motion** and types a name, and anyone presses **Start**. The laptop shows everyone in a circle. Whoever has the potato sees their phone turn red and buzz with the ticking: flick the phone sideways to throw it to the player on that side (or tap the arrow with their name). You must catch it for half a second before throwing it on. The fuse is secret and different every time; the ticking speeds up as it burns. Holding the potato when it goes off (or catching it as it goes off) costs one of three lives; the last player with lives left wins. How hard a flick must be follows the phone's Sensitivity slider, as last set in one of the motion games.

**Fishing.** Two minutes on the lake. Hold the phone like the handle of a rod, top edge pointing at the screen, press **Centre rod**, then **Start**. Lift the rod and whip it forward to cast: the harder the whip, the farther the bobber flies, and farther out are the bigger fish (sharks only bite on the longest casts). Where you point aims the cast left or right. When the bobber goes under (the phone buzzes), jerk the phone up to strike; too slow and the fish steals the bait, too early and it is scared off. Then wind the reel by moving the phone in circles. Watch the tension meter: winding while the fish runs snaps the line, and stopping for too long lets it slip the hook. Fish score by weight and kind. Without a phone, click to cast (higher on the screen = farther) and to strike, and move the mouse in circles to reel.

**Bowling.** Ten frames of ten-pin. Hold the phone in your bowling hand, top edge pointing at the screen, and press **Centre**. Point left or right to line up along the foul line, then press and hold the big **GRIP** button with your thumb, swing your arm underarm like a real bowl, and let go of GRIP to release the ball. How fast your arm swings sets the ball speed; swinging a little sideways angles it; twisting your wrist as you let go adds hook, which bends the ball in the last part of the lane. The pins knock each other over with real collisions, and the pinsetter clears what fell before your second ball. Scored like the real thing: strikes, spares and the tenth-frame bonus balls, up to 300. Without a phone, move the mouse to line up, then press, flick the mouse upward and let go.

**More than one phone.** Any number of phones can join the same room. The motion games are steered by one of them, the controller: the phone that joined last, or the last one to press a button. Press **Centre** or **Start** on another phone to take over.

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

- **`server/`**: HTTPS server, Vite dev middleware, and `rooms.ts`, which pairs one laptop with any number of phones per 4-letter room code and relays messages (to one phone or all). Reconnection is built in on both sides; the laptop keeps its room code across refreshes.
- **`src/shared/`**: code used by both sides: the message types (`protocol.ts`), orientation maths (`pointer.ts`), the jump detector (`jump.ts`) the yoga pose maths (`yoga.ts`) the marble maze physics (`marble.ts`) the flight yoke and ring course (`flight.ts`) the snake rules (`snake.ts`) the orbit cannon and meteor pacing (`orbit.ts`) the UNO rules (`uno.ts`) the duck flight and rounds (`duck.ts`) the Hot Potato rules and flick detector (`potato.ts`) the fishing swings, reel and fight (`fishing.ts`) and ten-pin scoring, pin physics and the swing reader (`bowling.ts`). All of it is unit-tested.
- **`src/game/`**: one file per game (`game.ts` = Fruit Slicer, `car.ts`, `jump.ts`, `yoga.ts`, `maze.ts`, `sky.ts`, `snake.ts`, `orbit.ts`, `uno.ts`, `duck.ts`, `potato.ts`, `fishing.ts`, `bowling.ts`, …) behind a shared `Scene` interface, plus `main.ts` that connects them to the network.
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
