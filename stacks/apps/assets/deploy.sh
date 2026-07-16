# Body of app-<name>-deploy.service — poll ghcr.io, redeploy on a new digest.
#
# Nix injects APP / IMAGE / UNIT / APP_HOST / HEALTH_PATH / HEALTH_TIMEOUT /
# AUTHFILE / LAN_IP / STATE / SETPRIV / ENV_BIN / PODMAN above this body, and
# writeShellApplication prepends `set -euo pipefail`.
#
# Why this exists at all: the generated container unit runs
# `podman run --pull missing`, which matches on TAG, not digest. Once
# `:latest` is in local storage it is never re-fetched, so `systemctl restart
# podman-app-<name>` re-runs the stale cached image forever, and a
# nixos-rebuild doesn't help either (the ExecStart string embeds the literal
# tag, so systemd sees nothing to restart). Something has to pull explicitly.
#
# This runs as ROOT — it has to `systemctl restart` a system unit — and drops
# to santiago for every podman call, because the images live in santiago's
# rootless store, not root's.
#
# setpriv, not runuser/sudo: those open a PAM session per call and log a pair
# of `session opened/closed` lines each time. At a 2-minute tick across every
# app that's thousands of lines a day into journald and Loki, for nothing.
# setpriv does the same uid/gid drop without PAM. Absolute paths because the
# child doesn't inherit writeShellApplication's PATH.

podman_() {
  "$SETPRIV" --reuid=santiago --regid=users --init-groups --inh-caps=-all \
    "$ENV_BIN" HOME=/home/santiago XDG_RUNTIME_DIR=/run/user/1000 \
    "$PODMAN" "$@"
}

# Email on a deploy state TRANSITION (ok->failed or failed->ok), never on the
# per-tick re-fail below. Runs in the root context (before any setpriv drop)
# so msmtp can read /run/secrets/mail-relay-password. Best-effort: a mail
# failure must never fail the deploy.
send_alert() {  # $1 = subject; body on stdin
  {
    echo "From: $NOTIFY_FROM"
    echo "To: $NOTIFY_TO"
    echo "Subject: $1"
    echo
    cat
  } | msmtp --account=default -t 2>/dev/null || true
}

# One inspect for both fields — see the setpriv note above; each podman call
# costs a process spawn. Missing image (first boot, or untagged) yields an
# empty id and the sentinel digest `none`, which reads as "everything is new".
info=$(podman_ image inspect --format '{{.Id}}|{{.Digest}}' "$IMAGE" 2>/dev/null || echo "|none")
old_id=${info%%|*}
before=${info#*|}

# A pull of an unchanged tag is one manifest request, so this is cheap to run
# every couple of minutes. --retry rides out a transient ghcr.io blip rather
# than reporting a failed deploy over one.
podman_ pull --authfile "$AUTHFILE" --retry 3 --retry-delay 5s --quiet "$IMAGE" >/dev/null

after=$(podman_ image inspect --format '{{.Digest}}' "$IMAGE")
last=$(cat "$STATE" 2>/dev/null || true)

if [ "$after" = "$before" ]; then
  # Nothing new upstream. If what we're already serving failed its health
  # check when it was deployed, keep failing: a quiet exit 0 here would clear
  # the unit's failed state and the report would evaporate two minutes later.
  if [ "$last" = "$after failed" ]; then
    echo "app-$APP is serving $after, which failed its health check on deploy"
    exit 1
  fi
  echo "no change ($after)"
  exit 0
fi

echo "new image: $before -> $after — restarting $UNIT"
systemctl restart "$UNIT"

# The container unit is Type=oneshot (see platform/common.nix): `podman run -d`
# returns in milliseconds, so systemd calls the restart a success even for a
# container that dies on startup. Asking traefik is the only honest signal.
# --resolve rather than DNS, so a pi-hole hiccup can't read as a dead app.
# Anything under 500 counts as alive — an Auth.js app 302-ing to a login page
# is a working app.
deadline=$((SECONDS + HEALTH_TIMEOUT))
code=000
while [ "$SECONDS" -lt "$deadline" ]; do
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \
           --resolve "$APP_HOST:443:$LAN_IP" \
           "https://$APP_HOST$HEALTH_PATH" || echo 000)

  if [ "$code" != "000" ] && [ "$code" -lt 500 ]; then
    echo "$after ok" > "$STATE"
    echo "deployed $after — healthy (HTTP $code)"
    # Recovered? Alert once on failed -> ok (not on every healthy deploy).
    case "$last" in
      *" failed")
        send_alert "[s2-server] RECOVERED: app-$APP deploy" <<EOF
app-$APP is healthy again (HTTP $code) on image $after.
Previous deploy state was: $last
EOF
        ;;
    esac

    # Drop only the image this deploy superseded, so a moving :latest doesn't
    # slowly fill rpool/selfhost with <none> layers.
    if [ -n "$old_id" ]; then
      podman_ rmi "$old_id" >/dev/null 2>&1 || true
    fi
    exit 0
  fi
  sleep 3
done

# Deploy-and-report: the new image stays running. We don't roll back, we just
# refuse to go quiet about it.
echo "$after failed" > "$STATE"
echo "DEPLOY FAILED: app-$APP did not answer within ${HEALTH_TIMEOUT}s (last HTTP $code)"
# Alert here, on the ok->failed transition only. The per-tick re-fail path
# above (after == before, last == "$after failed") deliberately stays silent
# so a broken app doesn't email every 2 minutes.
send_alert "[s2-server] DEPLOY FAILED: app-$APP" <<EOF
app-$APP failed to deploy image $after.
It did not return HTTP < 500 within ${HEALTH_TIMEOUT}s (last HTTP $code).
The new image is still running (deploy-and-report; no auto-rollback).
Investigate: journalctl -u app-$APP-deploy ; state file: $STATE
EOF
exit 1
