# Publish each app container's MERGED environment for daedalus to display.
#
# The container's own env is the only place everything is already combined:
# what the platform injects, what the registry declares, what the image bakes
# in, and every value that arrives through an --env-file (database URL,
# AUTH_SECRET, OIDC client secret, operator sops vars). Re-deriving that in the
# app would mean reimplementing stacks/apps and drifting from it.
#
# Written to /run — tmpfs — and never to /home/santiago/selfhost. These are
# real secrets: on the selfhost dataset they would land in every ZFS snapshot
# and ride the syncoid mirror to the backup pool, which is a far worse exposure
# than showing them in a LAN-only UI behind OIDC. On tmpfs they vanish at
# reboot, exactly like /run/secrets.
#
# Runs as root and drops to santiago for podman, because the containers live in
# santiago's rootless store. Same setpriv-not-sudo reasoning as deploy.sh: no
# PAM session per call.

set -euo pipefail

install -d -m 0750 -o santiago -g users "$OUT_DIR"

# Absolute paths, because the privilege-dropped child does NOT inherit
# writeShellApplication's PATH — the same trap deploy.sh documents. Getting
# this wrong fails silently: podman is simply not found and the snapshot
# directory stays empty with no error.
podman_() {
  "$SETPRIV" --reuid=santiago --regid=users --init-groups --inh-caps=-all \
    "$ENV_BIN" HOME=/home/santiago XDG_RUNTIME_DIR=/run/user/1000 \
    "$PODMAN" "$@"
}

# $APPS is injected from nix — the registry's apps plus daedalus itself.
#
# NOT discovered by matching `^app-` on running containers: `app-db-exporter`
# is the shared postgres exporter, not an app, and it would have been
# snapshotted as an app called "db-exporter". Any future app-prefixed
# infrastructure container would do the same. The nix list is exactly the set
# that has a page in the UI, and an Apply rebuilds anyway, so it is never stale.
for app in $APPS; do
  cname="app-$app"

  # A stopped app has no environment to read; that is a normal state, not an
  # error. Leave any previous snapshot in place rather than deleting it — the
  # UI shows the file's age, so a stale-but-labelled env beats none at all.
  if ! podman_ container exists "$cname" 2>/dev/null; then
    continue
  fi

  # A temp file then a rename: daedalus reads these on every settings render,
  # and `install` writing in place would let it read a half-written file.
  # 0600 — the file holds secrets and the only reader is daedalus, which runs
  # as container-root = santiago.
  if podman_ inspect "$cname" --format '{{json .Config.Env}}' >"$OUT_DIR/.$app.tmp" 2>/dev/null; then
    chown santiago:users "$OUT_DIR/.$app.tmp"
    chmod 0600 "$OUT_DIR/.$app.tmp"
    mv "$OUT_DIR/.$app.tmp" "$OUT_DIR/$app.json"
  else
    rm -f "$OUT_DIR/.$app.tmp"
    echo "could not snapshot env for $cname" >&2
  fi
done

# Drop snapshots for apps that no longer exist, so a removed app does not leave
# its secrets sitting in tmpfs until reboot.
#
# $APPS is whitespace-separated and `case` patterns are matched literally, so
# the haystack is normalised to single spaces first. Getting this wrong is not
# harmless: an unmatched name means EVERY snapshot is deleted immediately after
# being written, which is exactly what happened the first time.
haystack=" $(printf '%s' "$APPS" | tr -s '[:space:]' ' ') "
for f in "$OUT_DIR"/*.json; do
  [ -e "$f" ] || continue
  name=$(basename "$f" .json)
  case "$haystack" in
  *" $name "*) ;;
  *) rm -f "$f" ;;
  esac
done
