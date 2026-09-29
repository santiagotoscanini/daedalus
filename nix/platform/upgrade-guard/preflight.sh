# fleet-upgrade-preflight — is this box in a state to take a reboot-level
# upgrade right now? Read-only: prints PASS / WARN / FAIL per check and exits
# 1 if anything FAILed. Run as root (the pools, the ESP, the secrets).
#
#   fleet-upgrade-preflight                      the box as it is
#   fleet-upgrade-preflight --target TOPLEVEL    also: the ESP room and the
#                                                switch guard for the
#                                                generation about to be installed
#
# The checks are checks.sh's; the host adds its own (fleet.upgradeGuard.checks,
# e.g. "nobody is playing on the game servers") and they run last.

TARGET=""
while [ "$#" -gt 0 ]; do
  case "$1" in
  --target)
    TARGET="$(readlink -f -- "${2:?--target needs a toplevel}")"
    shift 2
    ;;
  -h | --help)
    sed -n '2,12p' "$0" 2>/dev/null || true
    exit 0
    ;;
  *)
    echo "unknown argument: $1" >&2
    exit 2
    ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "fleet-upgrade-preflight: run as root (sudo); it reads the pools, the ESP and /run/secrets" >&2
  exit 2
fi

check_target_guard() {
  local out rc=0
  out="$(fleet-switch-guard "$TARGET" 2>&1)" || rc=$?
  case "$rc" in
  0)
    echo "live activation allowed"
    return 0
    ;;
  3)
    echo "reboot-level change ($(tail -n +2 <<<"$out" | sed -E 's/^ +//; s/:.*//' | sort -u | tr '\n' ' ')): install with \`nixos-rebuild boot\` only"
    return 2
    ;;
  *)
    echo "$out"
    return 1
    ;;
  esac
}

run_check failed-units check_failed_units
run_check zpool-health check_zpool_health
run_check pools-imported check_pools_imported
run_check esp-space check_esp_space
run_check boot-entries check_boot_entries
run_check rebuild-idle check_rebuild_idle
run_check clock check_clock
run_check sops-identity check_sops_identity
run_check secrets check_secrets
run_check containers check_containers
run_check sso-discovery check_sso
run_check lan-dns check_dns
run_check controller check_controller
run_check node-links check_node_links
run_check syncoid check_syncoid
[ -z "$TARGET" ] || run_check switch-guard check_target_guard
for c in $HOST_CHECKS; do
  run_check "$c" "host_check_$c"
done

printf '%s' "$REPORT"
echo "--"
echo "$FAILS failed, $WARNS warning(s) — $(date -Is) on $(hostname)"
[ "$FAILS" -eq 0 ]
