#!/bin/sh
# Start Xvfb so Chrome can run in headed mode (real Chrome) when HEADLESS=false.
# Harmless when headless: Chrome simply doesn't use the display.
# Optionally bring up WireGuard so all traffic (including Chromium) goes through the VPN.
set -e
# Remove stale lock from a previous run (e.g. container restart) so Xvfb can start.
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1280x800x24 -ac &
export DISPLAY=:99

# WireGuard: if WIREGUARD_CONFIG_PATH is set and the config exists, bring up the interface
# so all outbound traffic (including browser) goes through the VPN.
if [ -n "$WIREGUARD_CONFIG_PATH" ] && [ -f "$WIREGUARD_CONFIG_PATH" ]; then
  echo "[entrypoint] Bringing up WireGuard from $WIREGUARD_CONFIG_PATH"
  IFACE="$(basename "$WIREGUARD_CONFIG_PATH" .conf)"
  if ! wg-quick up "$WIREGUARD_CONFIG_PATH" 2>/dev/null; then
    echo "[entrypoint] wg-quick failed, trying minimal WireGuard bring-up (no policy routing)"
    ip link add "$IFACE" type wireguard
    # wg setconf only accepts PrivateKey, ListenPort, [Peer] PublicKey, Endpoint, AllowedIPs, PersistentKeepalive
    WG_CONF="$(mktemp)"
    sed -e '/^Address\s*=/d' -e '/^DNS\s*=/d' -e '/^MTU\s*=/d' -e '/^Table\s*=/d' "$WIREGUARD_CONFIG_PATH" > "$WG_CONF"
    wg setconf "$IFACE" "$WG_CONF"
    rm -f "$WG_CONF"
    # Add addresses from config (Address = 1.2.3.4/24 or Address = 1.2.3.4/24, 2001::/64)
    grep -E '^Address\s*=' "$WIREGUARD_CONFIG_PATH" | sed 's/^Address\s*=\s*//; s/,\s*/\n/g' | while read -r addr; do
      [ -n "$addr" ] && (ip -4 address add "$addr" dev "$IFACE" 2>/dev/null || ip -6 address add "$addr" dev "$IFACE" 2>/dev/null) || true
    done
    # Apply MTU from config if set (avoids fragmentation / stuck connections)
    MTU=$(grep -E '^MTU\s*=' "$WIREGUARD_CONFIG_PATH" | sed 's/^MTU\s*=\s*//; s/\s.*//; q')
    [ -n "$MTU" ] && ip link set dev "$IFACE" mtu "$MTU" 2>/dev/null || true
    ip link set up dev "$IFACE"
    # Route only browser traffic through the VPN via a local SOCKS proxy.
    # The proxy binds outgoing connections to the WireGuard IP; source-based policy
    # routing sends those packets through the tunnel. DNS stays on the main table.
    WG_ADDR=$(grep -E '^Address\s*=' "$WIREGUARD_CONFIG_PATH" | sed 's/^Address\s*=\s*//; s|/.*||; s/,.*//; s/\s//g; q')
    WG_TABLE=200
    ip route add default dev "$IFACE" table $WG_TABLE 2>/dev/null || true
    ip rule add from "$WG_ADDR" lookup $WG_TABLE priority 100 2>/dev/null || true
    SOCKS_PORT="${WIREGUARD_SOCKS_PORT:-1080}"
    export WIREGUARD_SOCKS_PROXY="socks5://127.0.0.1:${SOCKS_PORT}"
    export WIREGUARD_LOCAL_ADDR="$WG_ADDR"
    NODE=$(command -v node)
    [ -z "$NODE" ] && NODE=/usr/local/bin/node
    ($NODE /app/socks-server.js &)
    sleep 1
    echo "[entrypoint] WireGuard interface $IFACE up (proxy: $WIREGUARD_SOCKS_PROXY, bind: $WG_ADDR)"
  fi
  # WireGuard status and auth
  if command -v wg >/dev/null 2>&1; then
    echo "[entrypoint] WireGuard status:"
    wg show "$IFACE" 2>/dev/null || wg show 2>/dev/null || true
    if wg show "$IFACE" latest-handshakes 2>/dev/null | grep -q '[1-9]'; then
      echo "[entrypoint] WireGuard auth: handshake seen (tunnel OK)"
    else
      echo "[entrypoint] WireGuard auth: no handshake yet (check endpoint, key, firewall)"
    fi
  fi
fi

exec "$@"
