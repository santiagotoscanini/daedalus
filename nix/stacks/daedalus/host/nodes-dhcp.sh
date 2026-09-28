# Hand the nodes' DHCP name bindings to the resolver (daedalus-nodes.nix).
#
# The app writes `$SRC` (<apply dir>/nodes/dhcp-hosts) — one dnsmasq
# `dhcp-host` line per approved node — into a directory the container can
# write. This agent runs as root and copies it where pi-hole reads it, so it
# is held to host/lib.sh's rule: root never touches a file there by name. The
# bytes are read with read_request (a link at the name is refused, the read
# runs as the operator with O_NOFOLLOW), every line is checked against the
# only two shapes the app writes, and root writes the validated bytes into its
# own directory. A file that fails any check changes nothing: the resolver
# keeps the last good copy, and the journal says why.
#
# Expects SRC, DST and PIHOLE ("1" when the resolver runs on this box).

refuse() {
  echo "not handing $SRC to the resolver: $1" >&2
  exit 1
}

if [ -L "$SRC" ] || [ -e "$SRC" ]; then
  body="$(read_request "$SRC")" || refuse "it is not a regular file this agent will read"
  # `<MAC>,<name>` or `<MAC>,<IPv4>,<name>` (app/src/host/dhcp-hosts.ts), a
  # name being one DNS label. Nothing else is a line this file may carry: a
  # dnsmasq option smuggled in here would be parsed by the resolver.
  mac='[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}'
  ip='[0-9]{1,3}(\.[0-9]{1,3}){3}'
  label='[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
  if [ -n "$body" ]; then
    if bad="$(printf '%s\n' "$body" | grep -Evx -m1 "$mac,($ip,)?$label")"; then
      refuse "a line is not <MAC>,[<IPv4>,]<name>: ${bad:0:80}"
    fi
    [ "$(printf '%s\n' "$body" | wc -l)" -le 1024 ] || refuse "more than 1024 lines"
    body="$body"$'\n'
  fi
  # Root's own directory, so root's direct write is safe; temp and rename so
  # the resolver never reads half a file.
  printf '%s' "$body" | install -m 0644 -o root -g root /dev/stdin "$DST.tmp"
  mv -f -- "$DST.tmp" "$DST"
else
  # No file at all: the app removed it. The resolver's copy goes too.
  rm -f -- "$DST"
fi

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
