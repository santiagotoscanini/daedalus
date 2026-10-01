# Hand the nodes' DHCP name bindings to the resolver (daedalus-nodes.nix).
#
# Two ways in. The root helper's `nodes-dhcp` (daedalus-nodes-dhcp@<run>)
# brings the lines as its run file's payload (host/lib.sh take_request): one
# dnsmasq `dhcp-host` line per approved node, which the app rendered. They are
# held to the only two shapes the app writes, kept in $STORE (root's, in the
# verbs directory, which outlives a reboot and which the app reads back to
# know what it last handed over), then copied to $DST, where the resolver
# reads them. At boot, daedalus-nodes-dhcp copies $STORE to $DST again,
# checked again. A body that fails a check changes nothing: the resolver
# keeps the last good copy, and the outcome says why.
#
# Expects STORE, DST and PIHOLE ("1" when the resolver runs on this box).

set -euo pipefail

if [ -n "${CREDENTIALS_DIRECTORY:-}" ]; then
  body="$(take_request | jq -r 'if (.payload | type) == "string" then .payload else "" end')"
  from="the request"
else
  body="$(cat -- "$STORE")"
  from="$STORE"
fi

# `<MAC>,<name>` or `<MAC>,<IPv4>,<name>` (app/src/host/dhcp-hosts.ts), a
# name being one DNS label. Nothing else is a line this file may carry: a
# dnsmasq option smuggled in here would be parsed by the resolver.
mac='[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}'
ip='[0-9]{1,3}(\.[0-9]{1,3}){3}'
label='[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
if [ -n "$body" ]; then
  if bad="$(printf '%s\n' "$body" | grep -Evx -m1 "$mac,($ip,)?$label")"; then
    refuse "not handing $from to the resolver: a line is not <MAC>,[<IPv4>,]<name>: ${bad:0:80}"
  fi
  [ "$(printf '%s\n' "$body" | wc -l)" -le 1024 ] ||
    refuse "not handing $from to the resolver: more than 1024 lines"
  body="$body"$'\n'
fi

# Root's own directories, so root's direct writes are safe; temp and rename
# so neither the app nor the resolver ever reads half a file.
put() {
  printf '%s' "$body" | install -m 0644 -o root -g root /dev/stdin "$1.tmp"
  mv -f -- "$1.tmp" "$1"
}
[ -z "${CREDENTIALS_DIRECTORY:-}" ] || put "$STORE"
put "$DST"

if [ "$PIHOLE" = 1 ]; then
  # A HUP is only safe once FTL is up: in its first moments no handler is
  # installed and the signal's default action ends the process — which is how
  # the first activation of this unit took LAN DNS down for four minutes
  # (2026-09-23). A resolver that started less than half a minute ago has read
  # the directory itself, and dnsmasq picks up a NEW file there without any
  # signal; the HUP is for a changed or removed line, and can wait for the next
  # write if it lands in that window.
  if systemctl is-active --quiet pihole-ftl.service; then
    started=$(systemctl show -p ActiveEnterTimestampMonotonic --value pihole-ftl.service)
    # Microseconds since boot, the unit systemd reports. Whole seconds are
    # enough for a thirty-second window, so the fraction is simply dropped.
    up=$(cut -d' ' -f1 /proc/uptime)
    now=$((${up%.*} * 1000000))
    if [ -n "$started" ] && [ "$((now - started))" -gt 30000000 ]; then
      systemctl kill --kill-whom=main -s HUP pihole-ftl.service
    else
      echo "pihole-ftl started under 30 s ago; leaving the HUP to the next write"
    fi
  fi
fi
verb_done "$(printf '%s' "$body" | grep -c . || true) node name(s) handed to the resolver"
