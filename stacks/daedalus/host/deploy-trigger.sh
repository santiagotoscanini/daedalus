# Start an app's existing deploy unit on daedalus's behalf.
#
# This does NOT deploy anything itself. `app-<name>-deploy.service`
# (stacks/apps/assets/deploy.sh) already pulls, compares the digest, restarts
# only if it actually moved, health-checks through traefik, records state in
# /var/lib/app-deploy/<name> and mails on failure. Reimplementing any of that
# here would be a second source of truth for what "deployed" means.
#
# So the whole job is: validate the app name, start that unit, wait, report.
#
# Runs as root because starting a system unit needs it. The container cannot,
# which is the entire reason this file exists — daedalus writes a request into
# a bind mount and a systemd.path unit runs this.

set -euo pipefail

REQ="$APPLY_DIR/deploy-request.json"
STATUS="$APPLY_DIR/deploy-status.json"

write_status() {
  install -m 0644 -o santiago -g users /dev/stdin "$STATUS" <<EOF
{"id":"$REQ_ID","app":$(jq -Rn --arg a "${APP-}" '$a'),"state":"$1","error":$(jq -Rn --arg e "${2-}" '$e'),"finishedAt":"$(date -Is)"}
EOF
}

[ -f "$REQ" ] || exit 0

REQ_ID="$(jq -r '.id // ""' "$REQ")"
[ -n "$REQ_ID" ] || exit 0

# The path unit re-fires on a daemon-reload replay at boot; without this a
# completed request would redeploy on every reboot.
if [ -f "$STATUS" ] && [ "$(jq -r '.id // ""' "$STATUS")" = "$REQ_ID" ]; then
  exit 0
fi

APP="$(jq -r '.app // ""' "$REQ")"

# The allowlist is the load-bearing security control here: this string becomes
# part of a systemd unit name that root then starts. DEPLOYABLE is generated
# from stacks/apps/apps.json, so it is exactly the set of apps that actually
# have a deploy unit — a local-source app (daedalus itself) has none, and
# anything else would be an injection attempt.
case " $DEPLOYABLE " in
*" $APP "*) ;;
*)
  write_status failed "unknown or non-deployable app: '$APP'"
  echo "refusing to deploy unknown app '$APP'" >&2
  exit 1
  ;;
esac

write_status running ""

# --wait blocks until the oneshot finishes and propagates its exit status, so
# a failed deploy is reported here rather than looking like a success that
# happened to leave a failed unit behind.
if systemctl start --wait "app-$APP-deploy.service"; then
  write_status "done" ""
else
  write_status failed "app-$APP-deploy.service failed — see journalctl -u app-$APP-deploy"
  exit 1
fi
