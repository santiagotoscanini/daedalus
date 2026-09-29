# upgrade-selfcheck — the first boot of a reboot-level upgrade, checked, with
# a way back. INERT unless "$STATE_DIR/armed" exists.
#
# The arming (the runbook; nothing here writes it): the new generation is
# installed with `nixos-rebuild boot`, the bootloader's persistent default is
# pinned to the OLD entry (`bootctl set-default`), the new one is booted ONCE
# (`bootctl set-oneshot`), and "$STATE_DIR/armed" holds the new toplevel's
# store path. Then, at boot:
#
#   - booted something other than the armed toplevel → this is the fallback
#     (or the one-shot never took): say so by mail, disarm, stop.
#   - booted the armed toplevel → run the checks every 30 s until they all
#     pass or DEADLINE_MIN minutes after boot. Pass: mail the report, disarm.
#     Deadline: mail what failed, disarm, and reboot — which lands on the
#     persistent default, the old generation. It refuses to reboot if the
#     default IS this entry, because that would only boot this again.
#
#   upgrade-selfcheck --dry-run [--mail]   run the checks once, print the
#                                          report (and mail it); never reboots,
#                                          ignores the marker
#
# Started after basic.target, not after multi-user.target, so a boot that
# stalls short of multi-user is still inside the deadline's reach.

ARMED="$STATE_DIR/armed"
DRY=""
MAIL_DRY=""
while [ "$#" -gt 0 ]; do
  case "$1" in
  --dry-run) DRY=yes ;;
  --mail) MAIL_DRY=yes ;;
  *)
    echo "unknown argument: $1" >&2
    exit 2
    ;;
  esac
  shift
done

send_mail() {
  # $1 subject; the body on stdin. Best-effort: a box that failed its checks
  # may well have no DNS, and the reboot must not wait on the relay.
  {
    echo "From: $MAIL_FROM"
    echo "To: $MAIL_TO"
    echo "Subject: [$(hostname)] $1"
    echo
    cat
  } | timeout 60 "$MSMTP" --account=default -t || echo "upgrade-selfcheck: mail not sent" >&2
}

run_all() {
  REPORT=""
  FAILS=0
  WARNS=0
  run_check sshd check_sshd
  run_check lan-ip check_lan_ip
  run_check pools-imported check_pools_imported
  run_check lan-dns check_dns
  run_check containers check_critical_containers
  run_check sso-discovery check_sso
  run_check controller check_controller
  run_check start-jobs check_start_jobs
  run_check failed-units check_failed_units
}

# failed-units is reported but does not decide: right after a boot a unit can
# be failed for a minute and then restart on its own.
blocking_fails() {
  grep -E '^FAIL' <<<"$REPORT" | grep -vcE '^FAIL +failed-units ' || true
}

boot_facts() {
  echo "booted:  $(readlink -f /run/booted-system)"
  echo "kernel:  $(uname -r)   zfs: $(cat /sys/module/zfs/version 2>/dev/null || echo '?')   uptime: $(awk '{printf "%d min", $1/60}' /proc/uptime)"
  bootctl list --json=short 2>/dev/null |
    jq -r '.[] | select(.isDefault or .isSelected) | "entry:   \(.id)\(if .isDefault then " (default)" else "" end)\(if .isSelected then " (booted)" else "" end)"' 2>/dev/null || true
}

if [ -n "$DRY" ]; then
  run_all
  body="$(
    echo "DRY RUN — nothing was armed, nothing will reboot."
    echo
    printf '%s' "$REPORT"
    echo
    boot_facts
  )"
  echo "$body"
  echo "-- $(blocking_fails) blocking failure(s)"
  [ -z "$MAIL_DRY" ] || send_mail "upgrade-selfcheck DRY RUN: $(blocking_fails) blocking failure(s)" <<<"$body"
  exit 0
fi

if [ ! -f "$ARMED" ]; then
  echo "upgrade-selfcheck: not armed ($ARMED absent); nothing to do"
  exit 0
fi

target="$(head -n 1 "$ARMED" | tr -d '[:space:]')"
booted="$(readlink -f /run/booted-system)"
disarm() {
  mv -f "$ARMED" "$STATE_DIR/disarmed-$(date +%Y%m%dT%H%M%S)" 2>/dev/null || rm -f "$ARMED"
  sync
}

if [ -z "$target" ] || [ "$booted" != "$(readlink -f "$target" 2>/dev/null || echo "$target")" ]; then
  body="$(
    echo "The armed upgrade target was not the system that booted."
    echo "armed:   ${target:-<empty marker>}"
    boot_facts
    echo
    echo "Either the one-shot boot of the new generation failed and the box fell back to"
    echo "the default entry, or the one-shot was never set. The marker is now disarmed."
  )"
  echo "$body" >"$STATE_DIR/last-result"
  send_mail "upgrade-selfcheck: booted $(basename "$booted"), NOT the armed upgrade (fell back?)" <<<"$body"
  disarm
  exit 0
fi

deadline=$(($(date +%s) + DEADLINE_MIN * 60 - $(cut -d. -f1 /proc/uptime)))
echo "upgrade-selfcheck: armed for $target; checking until $(date -d "@$deadline" +%H:%M:%S)"

while :; do
  run_all
  if [ "$(blocking_fails)" -eq 0 ]; then
    body="$(
      echo "The upgrade boot passed its checks. The persistent default is still the OLD entry"
      echo "until you commit: bootctl set-default '' (see the runbook)."
      echo
      printf '%s' "$REPORT"
      echo
      boot_facts
    )"
    echo "$body" | tee "$STATE_DIR/last-result"
    send_mail "upgrade-selfcheck PASSED on $(uname -r)" <<<"$body"
    disarm
    exit 0
  fi
  [ "$(date +%s)" -lt "$deadline" ] || break
  sleep 30
done

default_id="$(bootctl list --json=short 2>/dev/null | jq -r '.[] | select(.isDefault) | .id' 2>/dev/null || true)"
selected_id="$(bootctl list --json=short 2>/dev/null | jq -r '.[] | select(.isSelected) | .id' 2>/dev/null || true)"
will_reboot=yes
if [ -z "$default_id" ] || [ "$default_id" = "$selected_id" ]; then will_reboot=""; fi

body="$(
  echo "The upgrade boot FAILED its checks within $DEADLINE_MIN minutes of boot."
  echo
  printf '%s' "$REPORT"
  echo
  boot_facts
  echo
  if [ -n "$will_reboot" ]; then
    echo "Rebooting now into the default entry ($default_id)."
  else
    echo "NOT rebooting: the default entry (${default_id:-unknown}) is the one that booted, so a reboot"
    echo "would only come back here. Pick the old generation at the console."
  fi
)"
echo "$body" | tee "$STATE_DIR/last-result"
send_mail "upgrade-selfcheck FAILED on $(uname -r)$([ -n "$will_reboot" ] && echo ' — rebooting into the old generation')" <<<"$body"
disarm
if [ -n "$will_reboot" ]; then
  systemctl reboot
  # A reboot that hangs (a unit that will not stop) is forced after five minutes.
  sleep 300
  systemctl reboot --force
fi
exit 1
