# Write the site files daedalus rendered into the site directory — the one
# directory daedalus owns inside the operator's configuration repository.
#
# Deliberately dumb, exactly like apply.sh. It does NOT generate, transform or
# validate any of the files — daedalus renders the exact bytes
# (src/core/site/file.ts) into $APPLY_DIR/payload-<id>.json and this writes
# them out verbatim. Every decision about shape is application logic and
# belongs in TypeScript. jq appears here for this script's own bookkeeping and
# to lift a string out of the payload, never to build one.
#
# What genuinely needs the host: writing into a directory the container does
# not mount, and git as the operator (the repository is theirs). Whether the
# directory is versioned, and whether to commit, is decided by the operator —
# see host/site-lib.sh for the one thing this cannot delegate (staging).
#
# ⚠ The filenames are fixed HERE. The payload is a map keyed by name, and the
# names it is asked for come from this script's own list — never from the
# document. A filename that travelled across the trust boundary is a path
# traversal with extra steps.
#
# Idempotent by construction: re-running writes the same bytes, stages them,
# finds nothing changed and says so. Nothing is rebuilt: the files this writes
# are read by nix only from Phase 4 on, and by Apply, which has its own agent.

set -euo pipefail

REQ="$APPLY_DIR/site-request.json"
STATUS="$APPLY_DIR/site-status.json"

# The files this agent may write. apps.json is deliberately NOT among them:
# it is written only by an Apply, so it can never hold unapplied drift.
# daedalus.json is the provenance stamp: which engine wrote this directory,
# when, and on whose say-so. Rendered app-side like everything else here, and
# refreshed by every write — that is the whole point of it.
MANAGED=(site.json README.md daedalus.json)
REQUIRED=(site.json)

ACTION=""
PHASE=""
COMMIT=""

write_status() {
  write_json_atomic "$STATUS" <<EOF2
{"id":"$REQ_ID","action":$(jq -Rn --arg a "$ACTION" '$a'),"state":"$1","phase":"$PHASE","detail":$(jq -Rn --arg d "${2-}" '$d'),"error":$(jq -Rn --arg e "${3-}" '$e'),"startedAt":"$STARTED_AT","finishedAt":"$(date -Is)","commit":$(jq -Rn --arg c "$COMMIT" '$c')}
EOF2
}

# Rejection vs malfunction, exiting differently on purpose — the same split as
# power.sh. A refused request exits 0, because the agent worked.
reject() {
  write_status failed "" "$1"
  echo "site request rejected: $1" >&2
  exit 0
}

fail() {
  write_status failed "" "$1"
  echo "site agent failure: $1" >&2
  exit 1
}

[ -f "$REQ" ] || exit 0

# Read once, as the operator, never through a link (host/lib.sh); a symlinked
# request is refused with a failed unit — the app never writes one.
REQ_JSON="$(read_request "$REQ")" || exit 1

REQ_ID="$(jq -r '.id // ""' <<<"$REQ_JSON")"
[ -n "$REQ_ID" ] || exit 0
case "$REQ_ID" in
*[!0-9a-fA-F-]*) exit 0 ;;
esac
STARTED_AT="$(date -Is)"

# The path unit re-fires on a daemon-reload replay at boot.
if [ -f "$STATUS" ] && [ "$(published_id "$STATUS")" = "$REQ_ID" ]; then
  exit 0
fi

PAYLOAD="$APPLY_DIR/payload-$REQ_ID.json"

ACTION="$(jq -r '.action // ""' <<<"$REQ_JSON")"
WANT_COMMIT="$(jq -r 'if .commit == true then "yes" else "no" end' <<<"$REQ_JSON")"
SUMMARY="$(jq -r '.summary // "site: update"' <<<"$REQ_JSON")"
ACTOR="$(jq -r '.actor // "daedalus"' <<<"$REQ_JSON")"

PHASE=validating
write_status running "" ""

[ "$ACTION" = "write" ] || reject "unknown action '$ACTION'"
# A symlinked payload is refused rather than read — root copying one into the
# repository is the hole apply.sh documents. The bytes are then read once, as
# the operator and never through a link, into a root-private copy that every
# step below works from.
[ ! -L "$PAYLOAD" ] || reject "payload-$REQ_ID.json is a symlink — the bridge only accepts regular files, so it was not read"
[ -s "$PAYLOAD" ] || reject "no payload-$REQ_ID.json alongside the request"
PAYLOAD_COPY="$(mktemp)"
trap 'rm -f "$PAYLOAD_COPY"' EXIT
read_as_operator "$PAYLOAD" >"$PAYLOAD_COPY" || reject "payload-$REQ_ID.json could not be read as $OPERATOR_USER"

has_file() {
  [ "$(jq -r --arg f "$1" 'if (.files[$f] | type) == "string" then "yes" else "no" end' "$PAYLOAD_COPY")" = "yes" ]
}
for f in "${REQUIRED[@]}"; do
  has_file "$f" || reject "the payload carries no $f"
done

# --- write ----------------------------------------------------------------
# `jq -j` and a redirect, never a command substitution: `$(...)` strips
# trailing newlines, and these files END in one.
PHASE=writing
write_status running "" ""

WRITTEN=()
for f in "${MANAGED[@]}"; do
  has_file "$f" || continue
  tmp="$(mktemp)"
  jq -j --arg f "$f" '.files[$f]' "$PAYLOAD_COPY" >"$tmp" || fail "could not read $f out of the payload"
  # No backup: a site write never rolls back (nothing is rebuilt), and its
  # backups would share PREV_DIR with an Apply in flight — without taking the
  # rebuild lock, a write mid-build would replace the Apply's copy of site.json
  # with bytes the rollback then "restores".
  site_put "$f" "$tmp" || fail "could not write $f into $SITE_DIR as $OPERATOR_USER (see the journal)"
  rm -f "$tmp"
  WRITTEN+=("$f")
done
as_operator rm -f -- "$PAYLOAD"

# --- stage, and commit if asked -----------------------------------------
PHASE=staging
write_status running "" ""
TOPLEVEL="$(site_toplevel)"
if [ -n "$TOPLEVEL" ]; then
  site_stage "${WRITTEN[@]}" || fail "git add failed in $TOPLEVEL"
fi

CHANGED=no
if [ -n "$TOPLEVEL" ]; then
  if ! site_git diff --cached --quiet -- "$SITE_DIR"; then CHANGED=yes; fi
  if [ "$WANT_COMMIT" = "yes" ] && [ "$CHANGED" = "yes" ]; then
    PHASE=committing
    write_status running "" ""
    COMMIT="$(site_commit "$SUMMARY" "$ACTOR")" || fail "git commit failed"
  fi
fi

# --- publish -------------------------------------------------------------
# Refresh the repository facts before reporting done, so the page's
# invalidation reads current state rather than the five-minute timer's last.
PHASE=publishing
write_status running "" ""
"$SYSTEMCTL" start daedalus-repo-snapshot.service || true

# --- done -----------------------------------------------------------------
PHASE=complete
if [ -z "$TOPLEVEL" ]; then
  DETAIL="wrote ${WRITTEN[*]} to $SITE_DIR (not under source control)"
elif [ "$CHANGED" = "no" ]; then
  DETAIL="the directory already holds exactly this"
elif [ -n "$COMMIT" ]; then
  DETAIL="wrote ${WRITTEN[*]}, committed $COMMIT"
else
  DETAIL="wrote and staged ${WRITTEN[*]} — not committed (the switch is off)"
fi
write_status "done" "$DETAIL" ""
echo "site write: $DETAIL"
