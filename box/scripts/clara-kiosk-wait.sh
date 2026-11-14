#!/usr/bin/env bash
# Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/scripts/sophi-screen-wait.sh.
# clara-kiosk.service runs: clara-kiosk-wait.sh /usr/bin/cage ... -- /usr/bin/chromium ... <page>
# Waits until a screen is plugged in and the page answers, then replaces itself with that command (exec), so
# boot never waits for a screen. The kiosk shows only local pages (localhost, 127.0.0.1 or file:///).
# CLARA_SCREEN_WAIT_SECONDS sets a time limit, after which it exits 1 (for tests; unset on the Pi).
set -uo pipefail

url="${CLARA_SCREEN_URL:-}"
limit="${CLARA_SCREEN_WAIT_SECONDS:-}"
drm="${CLARA_SCREEN_DRM_DIR:-/sys/class/drm}"

# The port must be digits followed by "/", so "http://localhost:x@example.com/" (a web site) is refused.
local_page='^(file:///|http://(127\.0\.0\.1|localhost)(:[0-9]+)?/)'
if [[ ! "$url" =~ $local_page ]]; then
  echo "CLARA_SCREEN_URL is '$url'. The screen shows only local pages: http://localhost:<port>/... or file:///..."
  exit 1
fi

screen_connected() {
  local f
  for f in "$drm"/card*-HDMI-A-*/status; do
    [[ -r "$f" && "$(cat "$f")" == connected ]] && return 0
  done
  return 1
}

page_answers() {
  case "$url" in
    file://*) [[ -r "${url#file://}" ]] ;;
    *) curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null ;;
  esac
}

start=$SECONDS
said=""
while true; do
  if ! screen_connected; then
    reason="no screen is connected (no HDMI port reads 'connected' in $drm)"
  elif ! page_answers; then
    reason="the page doesn't answer yet: $url"
  else
    echo "Screen connected and the page answers: starting the kiosk."
    if (( $# == 0 )); then exit 0; fi
    exec "$@"
  fi
  if [[ "$reason" != "$said" ]]; then
    echo "Waiting: $reason"
    said="$reason"
  fi
  if [[ -n "$limit" ]] && (( SECONDS - start >= limit )); then
    echo "Gave up after ${limit} s: $reason."
    exit 1
  fi
  sleep 2
done
