# Body of app-<name>-deploy.service — poll the image registry (the box's
# own zot by default), redeploy on a new digest.
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

# Two independent state axes, two files: $STATE holds deploy health
# (`<digest> ok|failed`), the $STATE.pull marker means "pulls are
# failing". Sharing one file would let a pull blip overwrite a failed
# deploy record — and the pull recovery would then report all-clear
# over a still-unhealthy app.
#
# A pull of an unchanged tag is one manifest request, so this is cheap to run
# every couple of minutes. --retry rides out a sub-15s registry blip within one
# tick; the debounce below rides out a longer outage that spans ticks (for a
# ghcr-hosted override — the default registry is local and has no WAN leg).
#
# The nightly dynamic-IP reset (Argentine ISP, ~04:00) drops the WAN for
# anywhere from a minute to ~10 min — long enough to blow past --retry and span
# several ticks. Alerting on that is pure noise (and the alert email can't even
# send while the WAN is down: "No route to host", so a threshold crossed
# mid-outage yields only a confusing lone RECOVERED). So the $STATE.pull marker
# is a CONSECUTIVE-FAILURE COUNTER, not a boolean: we only email once the pull
# has failed PULL_ALERT_AFTER ticks running (~16 min at a 2-min tick), mirroring
# Grafana's `for:` pending period. The threshold is set ABOVE the longest
# expected WAN outage so a reset stays fully silent; a real failure (expired
# GHCR PAT is the classic) persists well past that and still alerts — just
# later, which is fine for a stalled pull — and keeps the unit failed so
# `systemctl --failed` shows it. Marker existence still means "pulls are
# failing"; only its contents changed to a count.
PULL_ALERT_AFTER=8
if ! podman_ pull --authfile "$AUTHFILE" --retry 3 --retry-delay 5s --quiet "$IMAGE" >/dev/null; then
  fails=$(( $(cat "$STATE.pull" 2>/dev/null || echo 0) + 1 ))
  echo "$fails" > "$STATE.pull"
  if [ "$fails" -eq "$PULL_ALERT_AFTER" ]; then
    send_alert "[s2-server] DEPLOY PULL FAILED: app-$APP" <<EOF
podman pull $IMAGE has failed $fails ticks running (past a transient blip).
Local-registry image (the default): check podman-zot / registry-config-render.
GHCR-hosted override: the classic PAT in stacks/apps/ghcr-auth.json.sops
may have expired.
Deploys for app-$APP are stalled until the pull succeeds; this alerts once.
Investigate: journalctl -u app-$APP-deploy
EOF
  fi
  echo "PULL FAILED for $IMAGE ($fails consecutive)"
  exit 1
fi
if [ -e "$STATE.pull" ]; then
  # Only announce recovery if we actually alerted on the failure — a blip that
  # cleared before crossing the threshold stayed silent, so its recovery must too.
  fails=$(cat "$STATE.pull" 2>/dev/null || echo 0)
  rm -f "$STATE.pull"
  if [ "$fails" -ge "$PULL_ALERT_AFTER" ]; then
    send_alert "[s2-server] RECOVERED: app-$APP pulls" <<EOF
podman pull works again for app-$APP.
Deploy health is tracked separately; current state: ${last:-none}
EOF
  fi
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
  echo "no change ($after)"
  exit 0
fi

# The image the container was running is what this deploy supersedes (rmi'd
# after a healthy deploy so a moving :latest doesn't fill rpool/selfhost).
old_id=$running
[ "$old_id" = "none" ] && old_id=""

# --- deploy journal -------------------------------------------------------
# $STATE holds only the LATEST result, overwritten every time, so on its own
# there is no history: daedalus could say what is running but never what ran
# before, when, or for how long. This appends one JSON line per real deploy to
# $STATE.log, which daedalus ingests into Postgres for its Deployments view.
#
# Written HERE rather than by daedalus because most deploys never touch it —
# the 2-minute timer and a manual `systemctl start` both land in this script.
# Recording at the one place that always runs is what makes the history
# complete instead of "the deploys daedalus happened to trigger".
#
# Only real deploys are recorded. A "no change" tick returns above, so the
# journal is not flooded with one line every two minutes per app.
deploy_started=$(date -Is)
deploy_started_s=$SECONDS
prev_digest=${last%% *}
[ "$prev_digest" = "$last" ] && prev_digest=""

record_deploy() {
  # All values are shell-generated (digests, ISO timestamps, an app name
  # constrained by the platform, ok|failed, integers), so printf is safe here
  # and avoids pulling jq into this unit's closure.
  printf '{"startedAt":"%s","finishedAt":"%s","app":"%s","digest":"%s","previousDigest":"%s","result":"%s","durationMs":%s,"http":"%s"}\n' \
    "$deploy_started" "$(date -Is)" "$APP" "$after" "$prev_digest" "$1" \
    "$(( (SECONDS - deploy_started_s) * 1000 ))" "${2-}" >>"$STATE.log"

  # Bound it. Deploys are infrequent (digest changes only), but this file is
  # append-only on a dataset with 16K recordsize and frequent snapshots.
  if [ "$(wc -l <"$STATE.log")" -gt 200 ]; then
    tail -n 200 "$STATE.log" >"$STATE.log.tmp" && mv "$STATE.log.tmp" "$STATE.log"
  fi
}

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

# No ingress (stage = "off") means no way to ask whether the new image serves.
# Record the deploy honestly as unverified rather than failing it: the check is
# absent, not negative. `podman run -d` returning is the only signal available,
# and this says so out loud instead of implying a passed health check.
if [ "$EXPOSED" != "1" ]; then
  echo "$after ok" > "$STATE"
  record_deploy ok unverified
  echo "deployed $after — NOT health-checked (stage=off: no ingress to probe)"
  if [ -n "$old_id" ]; then
    podman_ rmi "$old_id" >/dev/null 2>&1 || true
  fi
  exit 0
fi

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
  # The fallback must be an assignment, not appended output: curl prints
  # its -w format (000) even on a failed transfer, so `|| echo 000` inside
  # the substitution would yield "000000" — which passes both guards below.
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \
           --resolve "$APP_HOST:443:$LAN_IP" \
           "https://$APP_HOST$HEALTH_PATH") || code=000

  if [ "$code" != "000" ] && [ "$code" -lt 500 ]; then
    echo "$after ok" > "$STATE"
    record_deploy ok "$code"
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
record_deploy failed "$code"
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
