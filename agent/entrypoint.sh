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
    # Replace default route so internet traffic goes through the VPN, but keep route to Docker/host
    ETH_DEV=$(ip route show default 2>/dev/null | awk '{print $5}')
    DEFGW=$(ip route show default 2>/dev/null | awk '{print $3}')
    [ -n "$ETH_DEV" ] && SAVED_ROUTES=$(ip route show dev "$ETH_DEV" 2>/dev/null | grep -v '^default' | awk '{print $1}' | tr '\n' ' ')
    ip route del default 2>/dev/null || true
    ip route add default dev "$IFACE"
    ip -6 route del default 2>/dev/null || true
    ip -6 route add default dev "$IFACE" 2>/dev/null || true
    # Re-add routes so the agent can reach the server (host.docker.internal).
    # Gateway and connected networks via eth0; other private ranges via gateway so host is reachable.
    [ -n "$ETH_DEV" ] && [ -n "$DEFGW" ] && ip route add "$DEFGW"/32 dev "$ETH_DEV" 2>/dev/null || true
    [ -n "$ETH_DEV" ] && for net in $SAVED_ROUTES; do
      [ -n "$net" ] && ip route add "$net" dev "$ETH_DEV" 2>/dev/null || true
    done
    # Docker Desktop: host.docker.internal often in 192.168.x.x; route via gateway so host is reachable
    [ -n "$ETH_DEV" ] && [ -n "$DEFGW" ] && ip route add 192.168.0.0/16 via "$DEFGW" dev "$ETH_DEV" 2>/dev/null || true
    [ -n "$ETH_DEV" ] && [ -n "$DEFGW" ] && ip route add 172.16.0.0/12 via "$DEFGW" dev "$ETH_DEV" 2>/dev/null || true
    [ -n "$ETH_DEV" ] && [ -n "$DEFGW" ] && ip route add 10.0.0.0/8 via "$DEFGW" dev "$ETH_DEV" 2>/dev/null || true
    # Set DNS from WireGuard config so resolution works through the tunnel (avoids stuck navigation)
    if grep -q -E '^DNS\s*=' "$WIREGUARD_CONFIG_PATH" 2>/dev/null; then
      DNS_LINE=$(grep -E '^DNS\s*=' "$WIREGUARD_CONFIG_PATH" | sed 's/^DNS\s*=\s*//; s/,\s*/,/g' | tr -d ' ')
      if [ -n "$DNS_LINE" ]; then
        : > /etc/resolv.conf
        for dns in $(echo "$DNS_LINE" | tr ',' '\n'); do
          [ -n "$dns" ] && echo "nameserver $dns" >> /etc/resolv.conf
        done
        echo "[entrypoint] DNS set from WireGuard config"
      fi
    fi
    echo "[entrypoint] WireGuard interface $IFACE up (minimal mode)"
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
