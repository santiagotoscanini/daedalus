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

# The restart decision keys on IMAGE IDs, comparing what the CONTAINER runs
# against what the tag points at after the pull. Not registry digests of the
# local tag: (a) a crash between pull and restart would leave the tag moved
# with the old container still running, and a digest-of-tag comparison then
# reads "no change" forever — silent stale deploy; (b) a container's
# .ImageDigest is the arch manifest digest while image .Digest is the list
# digest, so those two never compare equal. IDs are config-blob hashes,
# identical on both sides. `none` (no container yet) reads as "deploy".
running=$(podman_ container inspect --format '{{.Image}}' "app-$APP" 2>/dev/null || echo none)
last=$(cat "$STATE" 2>/dev/null || true)

# A pull of an unchanged tag is one manifest request, so this is cheap to run
# every couple of minutes. --retry rides out a transient ghcr.io blip; a real
# pull failure (expired GHCR PAT is the classic) alerts once on transition and
# keeps the unit failed so `systemctl --failed` shows it.
if ! podman_ pull --authfile "$AUTHFILE" --retry 3 --retry-delay 5s --quiet "$IMAGE" >/dev/null; then
  if [ "$last" != "pull-failed" ]; then
    echo "pull-failed" > "$STATE"
    send_alert "[s2-server] DEPLOY PULL FAILED: app-$APP" <<EOF
podman pull $IMAGE failed (after retries).
Classic cause: the GHCR classic PAT in stacks/apps/ghcr-auth.json.sops expired.
Deploys for app-$APP are stalled until the pull succeeds; this alerts once.
Investigate: journalctl -u app-$APP-deploy
EOF
  fi
  echo "PULL FAILED for $IMAGE"
  exit 1
fi

new_id=$(podman_ image inspect --format '{{.Id}}' "$IMAGE")
after=$(podman_ image inspect --format '{{.Digest}}' "$IMAGE")

if [ "$new_id" = "$running" ]; then
  # Nothing new upstream. If what we're already serving failed its health
  # check when it was deployed, keep failing: a quiet exit 0 here would clear
  # the unit's failed state and the report would evaporate two minutes later.
  if [ "$last" = "$after failed" ]; then
    echo "app-$APP is serving $after, which failed its health check on deploy"
    exit 1
  fi
  if [ "$last" = "pull-failed" ]; then
    echo "$after ok" > "$STATE"
    send_alert "[s2-server] RECOVERED: app-$APP deploys" <<EOF
podman pull works again for app-$APP; the running image is current ($after).
EOF
  fi
  echo "no change ($after)"
  exit 0
fi

# The image the container was running is what this deploy supersedes (rmi'd
# after a healthy deploy so a moving :latest doesn't fill rpool/selfhost).
old_id=$running
[ "$old_id" = "none" ] && old_id=""

echo "new image: $running -> $new_id ($after) — restarting $UNIT"

# Write the failed sentinel BEFORE the restart: if systemctl itself
# dies here (bad entrypoint, podman run failure), set -e aborts this
# script with no state written — and since the image is already
# pulled, the next tick would see after == before, read the OLD "ok"
# state, and exit 0, silently clearing the unit's failed status. The
# pre-written sentinel keeps that tick loud; the health-check below
# overwrites it with "ok" on success.
echo "$after failed" > "$STATE"
systemctl restart "$UNIT"

# The container unit is Type=oneshot (see platform/podman.nix): `podman run -d`
# returns in milliseconds, so systemd calls the restart a success even for a
# container that dies on startup. Asking traefik is the only honest signal.
# --resolve rather than DNS, so a pi-hole hiccup can't read as a dead app.
# -k because this root unit has no CA bundle in its env; --resolve already
# pins the connection to our own traefik, so verification adds nothing here.
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
