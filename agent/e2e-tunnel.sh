#!/usr/bin/env bash
# The machine's tunnel end to end, against a real wg-easy (the box's WireGuard
# server) in rootless podman — the kernel's WireGuard on the other end, where
# src/tunnel/tests.rs has boringtun on both. What the log-in does, minus the
# browser: the steps the app takes through wg-easy's API (HTTP Basic, the
# password account), then the agent's tunnel with the config wg-easy made.
#
#   1. wg-easy 15.4.0 (the box's pin) with password auth on; Basic refuses a
#      wrong password.
#   2. The per-client firewall on (GET /api/admin/interface, POST it back).
#   3. The box's host ports at its LAN address: a DNAT in wg-easy's netns,
#      as `wg-easy-host-ports` does on the box, to a stand-in host (an
#      echo container on 7788, 7789 and 2222). TARGET stands in for the LAN
#      address.
#   4. A client made as the app makes it: POST /api/client, then the whole
#      client posted back with AllowedIPs = TARGET/32 and a firewall of the
#      link's and the session host's ports, MTU 1280, keepalive 25; its
#      configuration read (GET …/configuration) and turned into tunnel.toml.
#   5. The agent's tunnel (`tunnel::tests::e2e_against_wg_easy`, in a rust
#      container on the same bridge): 7788 and 7789 echo a MiB each, 2222 is
#      dropped by the firewall.
#   6. The client deleted (DELETE /api/client/:id): the same config gets no
#      handshake.
#
# Needs podman and jq on the host and the network for the images. Prints
# E2E_OK at the end; each step its own E2E_*_OK marker.
#
# Usage: agent/e2e-tunnel.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
WG_IMAGE="ghcr.io/wg-easy/wg-easy:15.4.0@sha256:0e7bc9d34e86ddcaa92bc700d4d7dc9b33291dbc07ac8d13382f7c2095f949ec"
RUST_IMAGE="docker.io/library/rust:1-bookworm"
BOX_IMAGE="docker.io/library/alpine:3.20"
net="e2e-wg-net"
wg="e2e-wg-easy"
box="e2e-wg-box"
user="daedalus-api"
TARGET="192.0.2.2" # TEST-NET-1: the box's LAN address, for the tunnel

work="$(mktemp -d)"
cleanup() {
  podman rm -f "$wg" "$box" > /dev/null 2>&1 || true
  podman network rm "$net" > /dev/null 2>&1 || true
  rm -rf "$work"
}
die() {
  echo "E2E FAILED: $*" >&2
  exit 1
}
podman rm -f "$wg" "$box" > /dev/null 2>&1 || true
podman network rm "$net" > /dev/null 2>&1 || true
trap cleanup EXIT
mkdir -p "$work/alt" /tmp/agent-cargo /tmp/agent-target

podman network create "$net" > /dev/null

# The stand-in host: an echo on the link's port, the session host's, and one
# the firewall must drop.
podman run -d --name "$box" --network "$net" "$BOX_IMAGE" \
  sh -c 'for p in 7788 7789 2222; do nc -lk -p $p -e cat & done; wait' > /dev/null
box_ip="$(podman inspect -f "{{(index .NetworkSettings.Networks \"$net\").IPAddress}}" "$box")"

# ── 1. wg-easy, as the module runs it (iptables = iptables-nft) ──────────────
for t in iptables ip6tables; do
  for s in "" -restore -save; do ln -s "/usr/sbin/$t-nft$s" "$work/alt/$t$s"; done
done
pw="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
podman run -d --name "$wg" --network "$net" -p 127.0.0.1::51821 \
  --cap-add=NET_ADMIN --cap-add=NET_RAW \
  --sysctl=net.ipv4.ip_forward=1 --sysctl=net.ipv4.conf.all.src_valid_mark=1 \
  -v "$work/alt":/etc/alternatives:ro \
  -e INIT_ENABLED=true -e INIT_USERNAME="$user" -e INIT_PASSWORD="$pw" \
  -e INIT_HOST="$wg" -e INIT_PORT=51820 -e INIT_DNS=10.8.0.1 \
  -e DISABLE_IPV6=true -e INSECURE=true -e DISABLE_PASSWORD_AUTH=false \
  "$WG_IMAGE" > /dev/null
base="http://127.0.0.1:$(podman port "$wg" 51821/tcp | cut -d: -f2)"
api() {
  local method="$1" path="$2"
  shift 2
  curl -fsS -u "$user:$pw" -X "$method" -H 'content-type: application/json' "$base$path" "$@"
}
for _ in $(seq 1 60); do
  api GET /api/admin/interface > /dev/null 2>&1 && break
  sleep 1
done
api GET /api/admin/interface > /dev/null || die "wg-easy's API never answered"
code="$(curl -s -o /dev/null -w '%{http_code}' -u "$user:wrong" "$base/api/client")"
[ "$code" = 401 ] || die "a wrong password got $code, not 401"
echo "E2E_BASIC_OK"

# ── 2. the per-client firewall ───────────────────────────────────────────────
api GET /api/admin/interface | jq '.firewallEnabled = true' > "$work/interface.json"
api POST /api/admin/interface --data @"$work/interface.json" > /dev/null
[ "$(api GET /api/admin/interface | jq -r .firewallEnabled)" = true ] || die "the firewall is off"
echo "E2E_FIREWALL_ON_OK"

# ── 3. the box's host ports at TARGET (wg-easy-host-ports) ───────────────────
for port in 7788 7789 2222; do
  podman exec "$wg" iptables-nft -t nat -A PREROUTING -d "$TARGET/32" -i wg0 \
    -p tcp -m tcp --dport "$port" -j DNAT --to-destination "$box_ip:$port"
done
echo "E2E_DNAT_OK"

# ── 4. the client, as the app makes it ───────────────────────────────────────
id="$(api POST /api/client --data '{"name":"mac-e2e","expiresAt":null}' | jq -r .clientId)"
[ -n "$id" ] && [ "$id" != null ] || die "no client id"
api GET "/api/client/$id" | jq --arg t "$TARGET/32" --arg b "$box_ip" \
  '. + {allowedIps: [$t], firewallIps: ["\($b):7788/tcp", "\($b):7789/tcp"], mtu: 1280, persistentKeepalive: 25}' \
  > "$work/client.json"
api POST "/api/client/$id" --data @"$work/client.json" > /dev/null
api GET "/api/client/$id/configuration" > "$work/client.conf"
conf() { awk -F' = ' -v k="$1" '$1 == k { print $2; exit }' "$work/client.conf"; }
[ "$(conf AllowedIPs)" = "$TARGET/32" ] || die "AllowedIPs is $(conf AllowedIPs)"
# The redeem answer's `wireguard`, as tunnel.toml keeps it (api/wire.rs).
(
  umask 077
  cat > "$work/tunnel.toml" << EOF
private_key = "$(conf PrivateKey)"
address = "$(conf Address)"
server_public_key = "$(conf PublicKey)"
preshared_key = "$(conf PresharedKey)"
endpoint = "$(conf Endpoint)"
allowed_ips = ["$(conf AllowedIPs)"]
EOF
)
echo "E2E_CLIENT_OK"

# ── 5./6. the agent's tunnel ─────────────────────────────────────────────────
tunnel() {
  podman run --rm --network "$net" -v "$here":/w -w /w -v "$work":/e2e \
    -v /tmp/agent-cargo:/tmp/agent-cargo -v /tmp/agent-target:/tmp/agent-target \
    -e CARGO_HOME=/tmp/agent-cargo -e CARGO_TARGET_DIR=/tmp/agent-target \
    -e E2E_TUNNEL=/e2e/tunnel.toml -e E2E_EXPECT="$1" \
    "$RUST_IMAGE" cargo test --locked --no-default-features --lib \
    tunnel::tests::e2e_against_wg_easy -- --ignored --exact --nocapture
}
tunnel open | tee "$work/open.log"
grep -q '^E2E_TUNNEL_OPEN_OK' "$work/open.log" || die "the tunnel did not carry the link"

api DELETE "/api/client/$id" > /dev/null
tunnel gone | tee "$work/gone.log"
grep -q '^E2E_TUNNEL_GONE_OK' "$work/gone.log" || die "a deleted client still had a tunnel"

echo "E2E_OK"
