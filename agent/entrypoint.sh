#!/bin/sh
# Start Xvfb so Chrome can run in headed mode (real Chrome) when HEADLESS=false.
# Harmless when headless: Chrome simply doesn't use the display.
# Optionally bring up WireGuard so all traffic (including Chromium) goes through the VPN.
set -e
Xvfb :99 -screen 0 1280x800x24 -ac &
export DISPLAY=:99

# WireGuard: if WIREGUARD_CONFIG_PATH is set and the config exists, bring up the interface
# so all outbound traffic (including browser) goes through the VPN.
if [ -n "$WIREGUARD_CONFIG_PATH" ] && [ -f "$WIREGUARD_CONFIG_PATH" ]; then
  echo "[entrypoint] Bringing up WireGuard from $WIREGUARD_CONFIG_PATH"
  wg-quick up "$WIREGUARD_CONFIG_PATH" || { echo "[entrypoint] WireGuard up failed"; exit 1; }
fi

exec "$@"
