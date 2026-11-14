#!/usr/bin/env bash
# Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/scripts/install-pi.sh and install-screen.sh.
# Sets up a Raspberry Pi 5 (Raspberry Pi OS, 64-bit) as a Clara box, from a checkout of this repo:
#   sudo ./box/scripts/install-pi.sh [--no-kiosk]
# It installs Node 24 (NodeSource) if Node is missing or older, the apt packages (ALSA tools, espeak-ng, cage,
# Chromium, curl), the repo's npm packages (as you, not root), adds you to audio/dialout/video (serial port and
# sound without sudo), installs clara-box.service (`npm run dev -w @clara/box` from this checkout, as you),
# /etc/clara-box.env (only if missing), the soundbar's udev name and volume, and the Chromium kiosk
# (clara-kiosk.service, showing http://localhost:8787). It enables both services but starts neither.
# Not yet run on a Pi: the steps match what Sophi's script did on a Pi 5 (trixie) in Oct 2026.
set -euo pipefail

kiosk=1
for arg in "$@"; do
  case "$arg" in
    --no-kiosk) kiosk=0 ;;
    *) echo "Usage: sudo $0 [--no-kiosk]" >&2; exit 2 ;;
  esac
done
if [[ "$(id -u)" != 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi
user="${SUDO_USER:-}"
if [[ -z "$user" || "$user" == root ]]; then
  echo "Run this with sudo from your own account (the service runs as that user)." >&2
  exit 1
fi
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
if [[ ! -f "$repo/package.json" || ! -d "$repo/box" ]]; then
  echo "Can't find the Clara checkout around $here." >&2
  exit 1
fi

# ---- packages ----
apt-get update
apt-get install -y alsa-utils espeak-ng curl ca-certificates
if (( kiosk )); then apt-get install -y cage chromium; fi

major=0
if command -v node >/dev/null; then major="$(node -p 'process.versions.node.split(".")[0]')"; fi
if (( major < 24 )); then
  echo "Installing Node 24 from NodeSource (found: ${major})."
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
echo "Node $(node --version)."

# serialport's native addon builds on install if no prebuilt binary matches.
apt-get install -y build-essential python3
if [[ ! -d "$repo/node_modules" ]]; then
  echo "Installing npm packages as $user."
  sudo -u "$user" -H bash -c "cd '$repo' && npm ci"
fi

# ---- permissions: serial port, sound, camera ----
for group in audio dialout video; do
  if getent group "$group" >/dev/null; then usermod -aG "$group" "$user"; else echo "Note: no '$group' group on this system." >&2; fi
done

# ---- the box service ----
if [[ ! -f /etc/clara-box.env ]]; then
  install -m 0640 -o root -g "$(id -gn "$user")" "$here/systemd/clara-box.env.example" /etc/clara-box.env
  echo "Wrote /etc/clara-box.env from the example: check the ALSA names (arecord -L, aplay -L)."
fi
sed -e "s|@USER@|$user|g" -e "s|@REPO@|$repo|g" "$here/systemd/clara-box.service" > /etc/systemd/system/clara-box.service
chmod 0644 /etc/systemd/system/clara-box.service
install -d -m 0755 /etc/systemd/system/clara-box.service.d
install -m 0644 "$here/systemd/clara-box.service.d/10-volume.conf" /etc/systemd/system/clara-box.service.d/10-volume.conf

# ---- audio: the soundbar is always ALSA card "Speaker" ----
install -m 0644 "$here/systemd/85-clara-audio.rules" /etc/udev/rules.d/85-clara-audio.rules
udevadm control --reload-rules
udevadm trigger --subsystem-match=sound || true

# ---- the kiosk screen ----
if (( kiosk )); then
  id -u clara-kiosk >/dev/null 2>&1 || useradd --system --home-dir /run/clara-kiosk --no-create-home --shell /usr/sbin/nologin clara-kiosk
  for group in video render input; do
    if getent group "$group" >/dev/null; then usermod -aG "$group" clara-kiosk; fi
  done
  install -d -m 0755 /opt/clara
  install -m 0755 "$here/clara-kiosk-wait.sh" /opt/clara/clara-kiosk-wait.sh
  install -m 0644 "$here/systemd/clara-kiosk.pam" /etc/pam.d/clara-kiosk
  install -m 0644 "$here/systemd/clara-kiosk.service" /etc/systemd/system/clara-kiosk.service
fi

systemctl daemon-reload
systemctl enable clara-box.service
if (( kiosk )); then systemctl enable clara-kiosk.service; fi
echo
echo "Installed and enabled (not started)."
echo "Next: edit /etc/clara-box.env, plug in the ESP32, then run the self-test (log out and in first, for the dialout group):"
echo "  cd $repo && npx tsx box/src/check/index.ts --leds --beep --sound"
echo "Then: sudo systemctl start clara-box (or reboot to start the kiosk too)."
