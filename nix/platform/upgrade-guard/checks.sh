# The checks fleet-upgrade-preflight and upgrade-selfcheck run — one
# function per check, concatenated after the wrapper's variables
# (upgrade-guard.nix sets every UPPER_CASE name used below) and before the
# script that picks which to run.
#
# A check prints ONE line of detail and returns 0 (PASS), 1 (FAIL) or
# 2 (WARN: worth reading, never blocking). They only read: nothing here
# starts, stops or writes anything.

# ── helpers ────────────────────────────────────────────────────────────────

# podman as the operator, for the rootless containers. Absolute paths: the
# privilege-dropped child does not inherit PATH.
podman_op() {
  setpriv --reuid="$OPERATOR_USER" --regid="$OPERATOR_GROUP" --init-groups \
    env HOME="$OPERATOR_HOME" XDG_RUNTIME_DIR="$OPERATOR_RUNTIME_DIR" "$PODMAN" "$@"
}

# The ESP file name systemd-boot's installer gives a kernel or initrd:
# /nix/store/<hash>-linux-6.12.93/bzImage → <hash>-linux-6.12.93-bzImage.efi
esp_name() {
  local p="$1"
  echo "$(basename "$(dirname "$p")")-$(basename "$p").efi"
}

# ── the checks ─────────────────────────────────────────────────────────────

check_failed_units() {
  local f
  f="$(systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}' | tr '\n' ' ')"
  f="${f% }"
  if [ -z "$f" ]; then
    echo "no failed units"
    return 0
  fi
  echo "$f"
  return 1
}

check_zpool_health() {
  local o
  o="$(zpool status -x 2>&1 || true)"
  if [ "$o" = "all pools are healthy" ]; then
    echo "$o"
    return 0
  fi
  echo "$o" | head -n 4 | tr '\n' ' '
  return 1
}

check_pools_imported() {
  local p h bad="" ok=""
  for p in $POOLS; do
    h="$(zpool list -H -o health "$p" 2>/dev/null || echo "not-imported")"
    if [ "$h" = ONLINE ]; then ok="$ok $p"; else bad="$bad $p($h)"; fi
  done
  if [ -n "$bad" ]; then
    echo "missing or unhealthy:$bad"
    return 1
  fi
  echo "ONLINE:$ok"
}

# Room on the ESP for a new kernel + initrd pair, twice over. $TARGET (a
# toplevel) is the generation about to be installed; without one, the running
# pair stands in for it.
check_esp_space() {
  local t="${TARGET:-/run/current-system}" k i need avail
  k="$(stat -L -c %s "$t/kernel" 2>/dev/null || echo 0)"
  i="$(stat -L -c %s "$t/initrd" 2>/dev/null || echo 0)"
  need=$((2 * (k + i)))
  avail="$(df -B1 --output=avail "$ESP" 2>/dev/null | tail -n 1 | tr -d ' ')"
  if [ -z "$avail" ] || [ "$need" -eq 0 ]; then
    echo "could not measure ($ESP, $t)"
    return 1
  fi
  echo "$((avail / 1048576)) MiB free on $ESP, need $((need / 1048576)) MiB (2 x kernel+initrd of ${t##*/})"
  [ "$avail" -ge "$need" ]
}

# Boot entries that boot the kernel AND initrd this system is running — the
# proven way back. The booted entry itself may already be pruned by the
# configuration limit; what matters is that some entry reproduces this boot.
check_boot_entries() {
  local kern init total good selected
  kern="$(esp_name "$(readlink -f /run/booted-system/kernel)")"
  init="$(esp_name "$(readlink -f /run/booted-system/initrd)")"
  local json
  json="$(bootctl list --json=short 2>/dev/null)" || {
    echo "bootctl list failed"
    return 1
  }
  total="$(jq 'length' <<<"$json")"
  good="$(jq -r --arg k "$kern" --arg i "$init" \
    '[.[] | select((.linux // "" | endswith($k)) and ((.initrd // []) | map(endswith($i)) | any)) | .id] | join(" ")' <<<"$json")"
  selected="$(bootctl status 2>/dev/null | sed -nE 's/^ *Current Entry: (.*)$/\1/p')"
  local n
  n="$(wc -w <<<"$good")"
  local note=""
  if [ -n "$selected" ] && ! jq -e --arg s "$selected" 'any(.[]; .id == $s)' <<<"$json" >/dev/null; then
    note=" (booted entry $selected is no longer on the ESP)"
  fi
  echo "$n of $total entries boot the running kernel+initrd: ${good:-none}${note}"
  [ "$n" -ge 2 ]
}

check_rebuild_idle() {
  local busy=""
  if pgrep -f '(^|/)(nixos-rebuild|switch-to-configuration)( |$)' >/dev/null 2>&1; then busy="$busy a nixos-rebuild/switch process;"; fi
  local u
  for u in $REBUILD_UNITS; do
    case "$(systemctl is-active "$u" 2>/dev/null || true)" in
    active | activating | reloading) busy="$busy $u running;" ;;
    esac
  done
  if ! flock -n "$LOCKFILE" true 2>/dev/null; then busy="$busy $LOCKFILE is held;"; fi
  if [ -n "$busy" ]; then
    echo "${busy% ;}"
    return 1
  fi
  echo "no rebuild running, $LOCKFILE free"
}

# Not within five minutes of the hour: network-heavy jobs land at :00 on this
# fleet (a speed test saturates the uplink and DNS drops for a minute or two).
check_clock() {
  local m
  m="$((10#$(date +%M)))"
  if [ "$m" -ge 55 ] || [ "$m" -le 5 ]; then
    echo "$(date +%H:%M) is within 5 minutes of the hour"
    return 1
  fi
  date +%H:%M
}

check_sops_identity() {
  local k missing=""
  for k in $AGE_KEYS; do
    [ -s "$k" ] || missing="$missing $k"
  done
  if [ -n "$missing" ]; then
    echo "missing:$missing"
    return 1
  fi
  echo "present: ${AGE_KEYS:-none}"
}

check_secrets() {
  local n
  n="$(find /run/secrets/ -mindepth 1 -maxdepth 1 2>/dev/null | wc -l)"
  echo "$n entries in /run/secrets, $EXPECTED_SECRETS expected"
  [ "$n" -eq "$EXPECTED_SECRETS" ]
}

check_containers() {
  local running missing="" c n=0 total=0
  running=" $(podman_op ps --format '{{.Names}}' 2>/dev/null | tr '\n' ' ') "
  while read -r c; do
    [ -n "$c" ] || continue
    total=$((total + 1))
    case "$running" in
    *" $c "*) n=$((n + 1)) ;;
    *) missing="$missing $c" ;;
    esac
  done <"$DECLARED_CONTAINERS"
  echo "$n/$total declared containers running${missing:+; not running:$missing}"
  [ -z "$missing" ]
}

# The containers the selfcheck insists on, and a floor on the total.
check_critical_containers() {
  local running c missing="" count
  running=" $(podman_op ps --format '{{.Names}}' 2>/dev/null | tr '\n' ' ') "
  for c in $CRITICAL_CONTAINERS; do
    case "$running" in *" $c "*) ;; *) missing="$missing $c" ;; esac
  done
  count="$(wc -w <<<"$running")"
  echo "$count running (floor $MIN_CONTAINERS)${missing:+; critical not running:$missing}"
  [ -z "$missing" ] && [ "$count" -ge "$MIN_CONTAINERS" ]
}

check_sso() {
  [ -n "$SSO_HOST" ] || {
    echo "no identity provider on this box"
    return 2
  }
  local code
  code="$(curl -sk --max-time 10 --resolve "$SSO_HOST:443:$LAN_IP" -o /dev/null -w '%{http_code}' \
    "https://$SSO_HOST/.well-known/openid-configuration" 2>/dev/null || true)"
  echo "https://$SSO_HOST/.well-known/openid-configuration -> ${code:-no answer}"
  [ "$code" = 200 ]
}

# The LAN resolver, asked on the LAN address the house uses.
check_dns() {
  local name="${SSO_HOST:-$DNS_PROBE}" a
  a="$(dig +short +time=3 +tries=2 @"$LAN_IP" "$name" A 2>/dev/null | tail -n 1)"
  echo "$name @$LAN_IP -> ${a:-no answer}"
  [ -n "$a" ]
}

check_controller() {
  [ -n "$STATUS_PORT" ] || {
    echo "no control plane on this box"
    return 2
  }
  local h
  h="$(curl -s --max-time 5 "http://127.0.0.1:$STATUS_PORT/healthz" 2>/dev/null || true)"
  echo "controller /healthz: ${h:-no answer}"
  [ "$h" = ok ]
}

# Every approved machine's link. WARN, not FAIL: a machine may simply be off.
check_node_links() {
  [ -n "$STATUS_PORT" ] || {
    echo "no control plane on this box"
    return 2
  }
  local m up="" down=""
  m="$(curl -s --max-time 5 "http://127.0.0.1:$STATUS_PORT/nodes/metrics" 2>/dev/null || true)"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if grep -qE "^daedalus_agent_link_up\{[^}]*machine=\"$name\"[^}]*\} 1(\.0+)?$" <<<"$m"; then
      up="$up, $name ($(grep -oE "^daedalus_agent_link_up\{[^}]*machine=\"$name\"[^}]*\}" <<<"$m" | sed -nE 's/.*host="([^"]*)".*/\1/p'))"
    else
      down="$down, $name"
    fi
  done <"$NODE_NAMES"
  echo "linked: ${up#, }${down:+; NOT linked: ${down#, }}"
  [ -z "$down" ] || return 2
}

check_syncoid() {
  local u r t now age bad="" ok=""
  now="$(date +%s)"
  for u in $SYNCOID_UNITS; do
    r="$(systemctl show -p Result --value "$u" 2>/dev/null)"
    t="$(systemctl show -p ExecMainExitTimestamp --value "$u" 2>/dev/null)"
    if [ -z "$t" ] || [ "$t" = "n/a" ]; then
      bad="$bad $u(never ran this boot)"
      continue
    fi
    age=$((now - $(date -d "$t" +%s)))
    if [ "$r" != success ] || [ "$age" -gt "$SYNCOID_MAX_AGE" ]; then
      bad="$bad $u($r, $((age / 60)) min ago)"
    else
      ok="$ok ${u#syncoid-}($((age / 60))m)"
    fi
  done
  echo "${ok:+ok:$ok}${bad:+; BAD:$bad}"
  [ -z "$bad" ]
}

check_sshd() {
  if ss -Hltn 'sport = :22' 2>/dev/null | grep -q .; then
    echo "listening on :22"
    return 0
  fi
  echo "nothing listens on :22"
  return 1
}

check_lan_ip() {
  local a
  a="$(ip -4 -o addr show dev "$LAN_IF" 2>/dev/null | awk '{print $4}' | tr '\n' ' ')"
  echo "$LAN_IF: ${a:-no IPv4}; default route: $(ip -4 route show default 2>/dev/null | head -n 1)"
  case " $a " in *" $LAN_IP/"*) return 0 ;; esac
  return 1
}

# ── the runner ─────────────────────────────────────────────────────────────

REPORT=""
FAILS=0
WARNS=0

# run_check NAME — runs check_NAME (or a host check), records one report line.
run_check() {
  local name="$1" fn="$2" detail rc=0 word
  detail="$("$fn" 2>&1)" || rc=$?
  case "$rc" in
  0) word=PASS ;;
  2) word=WARN WARNS=$((WARNS + 1)) ;;
  *) word=FAIL FAILS=$((FAILS + 1)) ;;
  esac
  REPORT="$REPORT$(printf '%-4s  %-20s  %s' "$word" "$name" "$detail")"$'\n'
}
