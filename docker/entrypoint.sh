#!/bin/sh
set -e

# Start virtual display so the agent can run real (headed) Chrome when HEADLESS=false
Xvfb :99 -screen 0 1280x800x24 -ac &
export DISPLAY=:99

# WireGuard: if WIREGUARD_CONFIG_PATH is set and the config exists, bring up the interface
# so all outbound traffic (including Chromium) goes through the VPN.
# Try wg-quick first; if it fails (e.g. sysctl permission denied in Docker), fall back to
# a minimal bring-up without policy routing (no sysctl needed).
if [ -n "$WIREGUARD_CONFIG_PATH" ] && [ -f "$WIREGUARD_CONFIG_PATH" ]; then
  echo "[entrypoint] Bringing up WireGuard from $WIREGUARD_CONFIG_PATH"
  IFACE="$(basename "$WIREGUARD_CONFIG_PATH" .conf)"
  WG_UP=0
  if wg-quick up "$WIREGUARD_CONFIG_PATH" 2>/dev/null; then
    WG_UP=1
    echo "[entrypoint] WireGuard up via wg-quick"
  else
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
    MTU=$(grep -E '^MTU\s*=' "$WIREGUARD_CONFIG_PATH" | sed 's/^MTU\s*=\s*//; s/\s.*//; q')
    [ -n "$MTU" ] && ip link set dev "$IFACE" mtu "$MTU" 2>/dev/null || true
    ip link set up dev "$IFACE"
    # Route only browser traffic through the VPN via a SOCKS proxy (avoids ERR_BLOCKED_BY_CLIENT).
    # Exclude DNS/local (127.0.0.0/8) from the mark so the proxy can resolve hostnames.
    WG_TABLE=200
    SOCKS_UID=65534
    ip route add default dev "$IFACE" table $WG_TABLE 2>/dev/null || true
    ip -6 route add default dev "$IFACE" table $WG_TABLE 2>/dev/null || true
    ip rule add fwmark 1 table $WG_TABLE 2>/dev/null || true
    iptables -t mangle -A OUTPUT -m owner --uid-owner $SOCKS_UID -d 127.0.0.0/8 -j ACCEPT 2>/dev/null || true
    iptables -t mangle -A OUTPUT -m owner --uid-owner $SOCKS_UID -d ::1/128 -j ACCEPT 2>/dev/null || true
    iptables -t mangle -A OUTPUT -m owner --uid-owner $SOCKS_UID -j MARK --set-mark 1 2>/dev/null || true
    SOCKS_PORT="${WIREGUARD_SOCKS_PORT:-1080}"
    export WIREGUARD_SOCKS_PROXY="socks5://127.0.0.1:${SOCKS_PORT}"
    NODE=$(command -v node)
    [ -z "$NODE" ] && NODE=/usr/local/bin/node
    (su nobody -s /bin/sh -c "cd /app/agent && exec $NODE socks-server.js" &)
    sleep 1
    WG_UP=1
    echo "[entrypoint] WireGuard interface $IFACE up (proxy mode: browser uses $WIREGUARD_SOCKS_PROXY)"
  fi
  # WireGuard status and auth
  if [ "$WG_UP" = 1 ] && command -v wg >/dev/null 2>&1; then
    echo "[entrypoint] WireGuard status:"
    wg show "$IFACE" 2>/dev/null || wg show 2>/dev/null || true
    if wg show "$IFACE" latest-handshakes 2>/dev/null | grep -q '[1-9]'; then
      echo "[entrypoint] WireGuard auth: handshake seen (tunnel OK)"
    else
      echo "[entrypoint] WireGuard auth: no handshake yet (check endpoint, key, firewall)"
    fi
  fi
fi

# Run the Rust server in the background from /app (serves UI from ./web, DB from DATABASE_PATH)
cd /app && /usr/local/bin/carabistouille &
SERVER_PID=$!

# Give the server a moment to bind
sleep 2

# Run the Node agent (connects to server via SERVER_URL)
cd /app/agent && exec node src/index.js &
AGENT_PID=$!

# Wait for either process to exit (e.g. SIGTERM from docker stop)
wait -n 2>/dev/null || true
EXIT_CODE=$?

# Clean up: kill both so the container exits
kill $SERVER_PID $AGENT_PID 2>/dev/null || true
exit ${EXIT_CODE:-0}
