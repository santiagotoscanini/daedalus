# Move a version a stack pins as plain strings, and rebuild onto it.
#
# image-update.sh's sibling for the pins that are not digests: a game server's
# version and build, a headless binary's release — strings the image downloads
# on start, so the string in the stack IS what runs. The stack declares them in
# fleet.versionPins (version-update.nix): which `let` binding holds each value,
# what a value may look like, the container, a verifier, and optionally a ZFS
# dataset the new version may convert for good.
#
# ── what makes the edit safe ──────────────────────────────────────────────
#
# The binding line. Each field is found as `<binding> = "<old>";`, the exact
# line nix itself renders the registry's `value` from — so a match is the pin
# and nothing else, and one found in no file or in two stops the run before
# `git add`. New values are held to the stack's own pattern, anchored here, and
# additionally to a charset no nix string can be broken out of.
#
# ── what a failure undoes ─────────────────────────────────────────────────
#
# Before the switch nothing has run, so a failed build is a `git revert`.
# After it, the new version may already have rewritten what the dataset holds
# (a world opened by a newer game is one the older game refuses), so a revert
# alone would bring back a version that cannot read its own data. So the
# dataset is snapshotted right before the switch, and a failed switch or
# verify stops the container, rolls the dataset back to THAT snapshot, reverts
# the commit and switches back. `-r`: the only snapshots newer than it were
# taken of the failed state, minutes old. The snapshot is kept after a
# success, as the way back to the old version by hand.
#
# Runs as root for the rebuild and the dataset; git and every file in the
# flake or $APPLY_DIR are touched as the operator (host/lib.sh).

set -euo pipefail

REQ="$APPLY_DIR/version-request.json"
STATUS="$APPLY_DIR/version-status.json"
LOGFILE="$APPLY_DIR/version-last.log"

TARGET=""
MOVES='[]'
SNAPSHOT=""
COMMIT_SHA=""
ROLLED_BACK=false

write_status() {
  write_json_atomic "$STATUS" <<EOF
{"id":"$REQ_ID","target":$(jq -Rn --arg t "$TARGET" '$t'),"state":"$1","phase":"$2","error":$(jq -Rn --arg e "${3-}" '$e'),"moves":$MOVES,"snapshot":$(jq -Rn --arg s "$SNAPSHOT" '$s'),"rolledBack":$ROLLED_BACK,"startedAt":"$STARTED_AT","finishedAt":"$(date -Is)","commit":"$COMMIT_SHA"}
EOF
}

fail() {
  write_status failed "$1" "$2"
  echo "version update failed at $1: $2" >&2
  exit 1
}

[ -f "$REQ" ] || exit 0
REQ_JSON="$(read_request "$REQ")" || exit 1

REQ_ID="$(jq -r '.id // ""' <<<"$REQ_JSON")"
[ -n "$REQ_ID" ] || exit 0
[[ "$REQ_ID" =~ ^[0-9a-fA-F-]+$ ]] || exit 0
STARTED_AT="$(date -Is)"

# Replay guard: the path unit also fires on a daemon-reload at boot.
if [ -f "$STATUS" ] && [ "$(published_id "$STATUS")" = "$REQ_ID" ]; then
  exit 0
fi

TARGET="$(jq -r '.target // ""' <<<"$REQ_JSON")"
ACTOR="$(jq -r '.actor // "daedalus"' <<<"$REQ_JSON")"

git_() {
  "$SETPRIV" --reuid="$OPERATOR_USER" --regid="$OPERATOR_GROUP" --init-groups \
    git -C "$FLAKE" "$@"
}
flake_grep() { as_operator grep "$@"; }
flake_sed() { as_operator sed "$@"; }

# --- validate -------------------------------------------------------------
write_status running validating ""

override="$(site_engine_override)"
[ -z "$override" ] ||
  fail validating "clear the engine override first: the running system is built from $override, not from the pinned engine (Settings › Developer)"

[[ "$TARGET" =~ ^[a-z0-9-]+$ ]] || fail validating "no well-formed target named in the request"
PIN="$(jq -c --arg t "$TARGET" '.[$t] // empty' "$PINS")"
[ -n "$PIN" ] || fail validating "'$TARGET' pins no version this configuration lets daedalus move (fleet.versionPins)"
CONTAINER="$(jq -r '.container' <<<"$PIN")"
DATASET="$(jq -r '.dataset // ""' <<<"$PIN")"
VERIFY="$(jq -r '.verify // ""' <<<"$PIN")"

# Every field the request names must be one the pin declares; a field it
# leaves out keeps its value.
unknown="$(jq -r --argjson pin "$PIN" '(.values // {}) | keys - ($pin.fields | keys) | join(", ")' <<<"$REQ_JSON")"
[ -z "$unknown" ] || fail validating "'$TARGET' has no field named: $unknown"

# One jq read per value rather than a @tsv row: @tsv escapes backslashes, and
# a pattern is made of them (`\.`).
while read -r field; do
  [ -n "$field" ] || continue
  [[ "$field" =~ ^[a-z]+$ ]] || fail validating "'$field' is not a field name"
  binding="$(jq -r --arg f "$field" '.fields[$f].binding' <<<"$PIN")"
  old="$(jq -r --arg f "$field" '.fields[$f].value' <<<"$PIN")"
  pattern="$(jq -r --arg f "$field" '.fields[$f].pattern' <<<"$PIN")"
  new="$(jq -r --arg f "$field" '.values[$f] | tostring' <<<"$REQ_JSON")"
  # The stack's pattern, anchored, and then a charset that cannot leave a nix
  # string or a sed replacement whatever the pattern allowed.
  [[ "$new" =~ ^($pattern)$ ]] || fail validating "'$new' is not a valid $field for $TARGET"
  [[ "$new" =~ ^[A-Za-z0-9._+-]{1,64}$ ]] || fail validating "'$new' holds characters a pin may not"
  if [ "$new" != "$old" ]; then
    MOVES="$(jq -c --arg f "$field" --arg b "$binding" --arg o "$old" --arg n "$new" \
      '. + [{field:$f, binding:$b, from:$o, to:$n}]' <<<"$MOVES")"
  fi
done < <(jq -r '(.values // {}) | keys[]' <<<"$REQ_JSON")

if [ "$(jq length <<<"$MOVES")" = "0" ]; then
  write_status "done" "no-change" ""
  exit 0
fi

# --- serialise against every other rebuild --------------------------------
exec 9>"$LOCKFILE"
write_status running waiting ""
flock -w 1200 9 ||
  fail waiting "another rebuild held $LOCKFILE for 20 minutes. Nothing was changed."

# --- write ----------------------------------------------------------------
write_status running writing ""
esc() { printf '%s' "$1" | sed -e 's/[][\.*^$|/]/\\&/g'; }

TOUCHED=""
while IFS=$'\t' read -r field binding from to; do
  line="^[[:space:]]*$binding = \"$(esc "$from")\";[[:space:]]*(#.*)?$"
  files="$(flake_grep -rlE --include='*.nix' -- "$line" "$FLAKE" || true)"
  [ -n "$files" ] || fail writing "no .nix file holds \`$binding = \"$from\";\` — the pin is not where the registry says"
  [ "$(printf '%s\n' "$files" | wc -l)" -eq 1 ] ||
    fail writing "\`$binding = \"$from\";\` is in more than one file: $(printf '%s' "$files" | tr '\n' ' ')"
  [ "$(flake_grep -cE -- "$line" "$files")" -eq 1 ] ||
    fail writing "\`$binding = \"$from\";\` appears more than once in $files"
  flake_sed -i -E "s/^([[:space:]]*$binding = \")$(esc "$from")(\";)/\\1$to\\2/" "$files"
  flake_grep -qE -- "^[[:space:]]*$binding = \"$(esc "$to")\";" "$files" ||
    fail writing "after editing, $binding is not \"$to\" in $files — the rewrite did not land"
  case " $TOUCHED " in
  *" $files "*) ;;
  *) TOUCHED="$TOUCHED $files" ;;
  esac
done < <(jq -r '.[] | [.field, .binding, .from, .to] | @tsv' <<<"$MOVES")

# --- commit ---------------------------------------------------------------
write_status running committing ""
# shellcheck disable=SC2086 # TOUCHED is a space-separated path list by design.
git_ add -- $TOUCHED
SUMMARY="$(jq -r --arg t "$TARGET" '"\($t): " + ([.[] | "\(.field) \(.from) → \(.to)"] | join(", "))' <<<"$MOVES")"
# shellcheck disable=SC2086
git_ -c "user.name=$(commit_name)" -c "user.email=$(commit_email)" \
  commit -q -m "versions: $SUMMARY" -m "Applied from daedalus by $ACTOR." -- $TOUCHED ||
  fail committing "git commit failed"
COMMIT_SHA="$(git_ rev-parse --short HEAD)"
UPDATE_COMMIT="$COMMIT_SHA"

revert_commit() {
  log_run "$LOGFILE" git_ -c "user.name=$(commit_name)" -c "user.email=$(commit_email)" \
    revert --no-edit "$UPDATE_COMMIT" ||
    log_line "$LOGFILE" "revert of $UPDATE_COMMIT failed — repo left as-is, resolve by hand"
  COMMIT_SHA=""
}

# After the switch: the new version may have converted the dataset, so the
# container stops BEFORE the rollback (nothing may hold or rewrite the files
# while they are replaced) and starts again only from the reverted switch.
rollback_all() {
  write_status running rolling-back ""
  log_run "$LOGFILE" systemctl stop "podman-$CONTAINER.service" || true
  if [ -n "$SNAPSHOT" ]; then
    log_run "$LOGFILE" zfs rollback -r "$SNAPSHOT" ||
      log_line "$LOGFILE" "zfs rollback to $SNAPSHOT failed — the dataset is as the new version left it"
  fi
  revert_commit
  log_run "$LOGFILE" nixos-rebuild switch --flake "$FLAKE#$HOSTNAME" || true
  ROLLED_BACK=true
}

# --- build ----------------------------------------------------------------
write_status running building ""
log_reset "$LOGFILE"
if ! log_run "$LOGFILE" nixos-rebuild build --flake "$FLAKE#$HOSTNAME"; then
  build_error="$(log_errtail "$LOGFILE")"
  revert_commit
  ROLLED_BACK=true
  fail building "$build_error"
fi

# --- snapshot -------------------------------------------------------------
if [ -n "$DATASET" ]; then
  write_status running snapshotting ""
  SNAPSHOT="$DATASET@daedalus-pre-$TARGET-$(date -u +%Y%m%dT%H%M%SZ)"
  if ! log_run "$LOGFILE" zfs snapshot "$SNAPSHOT"; then
    SNAPSHOT=""
    revert_commit
    ROLLED_BACK=true
    fail snapshotting "could not snapshot $DATASET — nothing was switched, and the commit is reverted"
  fi
fi

# --- switch ---------------------------------------------------------------
write_status running switching ""
if ! log_run "$LOGFILE" nixos-rebuild switch --flake "$FLAKE#$HOSTNAME"; then
  log_line "$LOGFILE" "switch failed once — retrying in 20s before rolling back"
  sleep 20
  if ! log_run "$LOGFILE" nixos-rebuild switch --flake "$FLAKE#$HOSTNAME"; then
    switch_error="$(log_errtail "$LOGFILE")"
    rollback_all
    fail switching "$switch_error"
  fi
fi

# --- verify ---------------------------------------------------------------
# A green unit proves nothing here (Type=oneshot + --rm). The stack's verifier
# asks the service itself; without one, the container must at least be running.
write_status running verifying ""
verify_env=()
while IFS=$'\t' read -r field to; do
  verify_env+=("NEW_${field^^}=$to")
done < <(jq -r '.[] | [.field, .to] | @tsv' <<<"$MOVES")
while IFS=$'\t' read -r field value; do
  case " ${verify_env[*]} " in
  *" NEW_${field^^}="*) ;;
  *) verify_env+=("NEW_${field^^}=$value") ;;
  esac
done < <(jq -r '.fields | to_entries[] | [.key, .value.value] | @tsv' <<<"$PIN")

if [ -n "$VERIFY" ]; then
  if ! log_run "$LOGFILE" timeout 1200 env "${verify_env[@]}" "$VERIFY"; then
    rollback_all
    fail verifying "the switch succeeded but $TARGET did not come up on the new version (see the verifier's lines in the log) — rolled back${SNAPSHOT:+, $DATASET restored to $SNAPSHOT}"
  fi
else
  sleep 15
  # Absolute paths: the privilege-dropped child does not inherit this
  # script's PATH (image-update.sh's podman_).
  running="$(as_operator "$ENV_BIN" HOME="$OPERATOR_HOME" XDG_RUNTIME_DIR="$OPERATOR_RUNTIME_DIR" \
    "$PODMAN" inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)"
  if [ "$running" != "true" ]; then
    rollback_all
    fail verifying "$CONTAINER is not running after the switch — rolled back"
  fi
fi

# --- push -----------------------------------------------------------------
write_status running pushing ""
log_run "$LOGFILE" git_ push ||
  log_line "$LOGFILE" "push failed (the switch succeeded; the commit is local only)"

write_status "done" "complete" ""
