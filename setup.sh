#!/usr/bin/env bash
# Gyro Arcade: one-command setup for macOS, Linux (Debian/Ubuntu/Raspberry Pi OS, Fedora, Arch) and WSL.
#
#   bash setup.sh              install Node.js if needed, install dependencies, check and build
#   bash setup.sh --start      ...and then start the server
#   bash setup.sh --service    ...and install it as a service that starts at boot (Linux, systemd; good for a Raspberry Pi)
#   bash setup.sh --skip-tests skip the unit tests (faster on a Raspberry Pi)
#
# Safe to run again at any time.

set -euo pipefail

MIN_NODE=18
WANT_NODE=20
PORT="${PORT:-5173}"
START=0
SERVICE=0
TESTS=1

for arg in "$@"; do
  case "$arg" in
    --start) START=1 ;;
    --service) SERVICE=1 ;;
    --skip-tests) TESTS=0 ;;
    -h | --help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd)"

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=''; G=''; Y=''; R=''; N=''; fi
step() { printf '\n%s==>%s %s%s%s\n' "$G" "$N" "$B" "$*" "$N"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$*"; }
die() { printf '%sError:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

if [ ! -f package.json ]; then die "package.json not found. Run this script from the project folder."; fi

SUDO=''
if [ "$(id -u)" -ne 0 ]; then
  if have sudo; then SUDO='sudo'; fi
fi

OS="$(uname -s)"
ARCH="$(uname -m)"
step "System: $OS $ARCH"

# ---------------------------------------------------------------- Node.js
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

install_with_nvm() {
  warn "Installing Node $WANT_NODE with nvm (into your home folder, no admin rights needed)."
  if ! have curl && ! have wget; then die "Need curl or wget to download nvm. Install one and run this script again."; fi
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    if have curl; then
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | PROFILE=/dev/null bash
    else
      wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | PROFILE=/dev/null bash
    fi
  fi
  # shellcheck disable=SC1091
  set +u; . "$NVM_DIR/nvm.sh"; nvm install "$WANT_NODE"; nvm use "$WANT_NODE"; set -u
  warn "To use Node in new terminals, add this to your shell profile (~/.zshrc or ~/.bashrc):"
  echo '    export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'
}

install_node() {
  case "$OS" in
    Darwin)
      if have brew; then
        brew install "node@$WANT_NODE" && brew link --overwrite --force "node@$WANT_NODE" || install_with_nvm
      else
        install_with_nvm
      fi
      ;;
    Linux)
      if have apt-get; then
        if ! have curl; then $SUDO apt-get update -y && $SUDO apt-get install -y curl ca-certificates; fi
        if curl -fsSL "https://deb.nodesource.com/setup_${WANT_NODE}.x" | $SUDO -E bash - && $SUDO apt-get install -y nodejs; then
          :
        else
          install_with_nvm
        fi
      elif have dnf; then
        $SUDO dnf install -y "nodejs" || install_with_nvm
      elif have pacman; then
        $SUDO pacman -S --noconfirm nodejs npm || install_with_nvm
      else
        install_with_nvm
      fi
      ;;
    *)
      die "Unsupported system ($OS). On Windows, use WSL (Ubuntu) and run this script inside it."
      ;;
  esac
  hash -r
}

step "Checking Node.js (need $MIN_NODE or newer)"
if have node && [ "$(node_major)" -ge "$MIN_NODE" ]; then
  echo "Found Node $(node -v)"
else
  if have node; then warn "Node $(node -v) is too old."; else warn "Node.js is not installed."; fi
  install_node
  have node || die "Node installation did not work. Install Node $WANT_NODE from https://nodejs.org and run this script again."
  [ "$(node_major)" -ge "$MIN_NODE" ] || die "Node $(node -v) is still too old. Install Node $WANT_NODE from https://nodejs.org."
  echo "Installed Node $(node -v)"
fi
have npm || die "npm is missing. Reinstall Node.js from https://nodejs.org."

case "$ARCH" in
  armv6l | armv7l) warn "32-bit ARM detected. Node $WANT_NODE may not be available; use 64-bit Raspberry Pi OS if install fails." ;;
esac

# ---------------------------------------------------------------- dependencies
step "Installing dependencies"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund || { warn "npm ci failed, trying npm install"; npm install --no-audit --no-fund; }
else
  npm install --no-audit --no-fund
fi

# ---------------------------------------------------------------- checks
step "Checking the code"
npm run --silent typecheck
if [ "$TESTS" -eq 1 ]; then
  npm test --silent
else
  echo "Tests skipped."
fi

step "Building"
npx vite build >/dev/null
echo "Build ok."

# ---------------------------------------------------------------- network info
LAN_IP=''
if [ "$OS" = Darwin ]; then
  for i in en0 en1 en2; do LAN_IP="$(ipconfig getifaddr "$i" 2>/dev/null || true)"; [ -n "$LAN_IP" ] && break; done
elif have hostname; then
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi

# ---------------------------------------------------------------- systemd service (optional)
if [ "$SERVICE" -eq 1 ]; then
  step "Installing a service that starts at boot"
  [ "$OS" = Linux ] && have systemctl || die "--service needs Linux with systemd."
  [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ] || die "--service needs sudo."
  NODE_BIN_DIR="$(dirname "$(command -v node)")"
  UNIT=/etc/systemd/system/gyro-arcade.service
  $SUDO tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=Gyro Arcade game server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$ROOT
Environment=PORT=$PORT
Environment=PATH=$NODE_BIN_DIR:/usr/local/bin:/usr/bin:/bin
ExecStart=$(command -v npm) start
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now gyro-arcade.service
  echo "Service installed and started. Logs: journalctl -u gyro-arcade -f"
  echo "Remove it later with: sudo systemctl disable --now gyro-arcade && sudo rm $UNIT"
fi

# ---------------------------------------------------------------- done
step "All set"
cat <<EOF
Start the game server:   ${B}npm run dev${N}     (hot reload)  or  ${B}npm start${N}  (lighter, for a Raspberry Pi)

Then:
  1. Open https://localhost:${PORT} on the computer that shows the games (accept the certificate warning once).
EOF
if [ -n "$LAN_IP" ]; then
  echo "     From another computer use: https://${LAN_IP}:${PORT}"
fi
cat <<EOF
  2. Scan the QR code with your phone (same Wi-Fi), accept the certificate warning, tap "Enable motion".
  3. Pick a game with the ☰ Menu button, or keys 1-4.
EOF

if [ "$START" -eq 1 ] && [ "$SERVICE" -eq 0 ]; then
  step "Starting the server (Ctrl+C to stop)"
  exec npm start
fi
