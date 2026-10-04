# Register a new app: write site/apps.json with entries that wait for their
# first image, stage it (and on the operator's switch, commit and push it),
# and rebuild NOTHING. The root helper's `register` verb (daedalus-verbs.nix),
# the rendered file its payload, the same shape as an Apply's
# (`{actor, summary, commit, files: {"apps.json": …}}`).
#
# Why no rebuild is safe: an entry carrying `awaitingImage: true` materializes
# nothing (modules/apps/declarations.nix filters it out before any reader),
# and this refuses any file whose OTHER entries differ from the ones on disk.
# So what a register can change is which awaiting entries exist, and nothing
# a rebuild would build; what that buys an app is its first build, which the
# builder authorizes from the committed registry (host/build.sh, "which apps
# it builds"). The rules, all of them checked before a byte is written:
#
#   - the payload's apps.json is a JSON object whose `schemaVersion` is the
#     file's on disk, and whose `apps` is an object of objects;
#   - every name is ^[a-z0-9][a-z0-9-]{0,62}$ (the app-name rule);
#   - its entries that are not awaiting are exactly the file's entries that
#     are not awaiting (compared as JSON values: key order is not a change).
#
# Like apply.sh it writes the bytes it was handed, and every write and git
# call runs as the operator (host/site-lib.sh). It takes the rebuild lock
# too: it commits to the configuration repository, and that lock is the one
# every committer and rebuilder there holds.

set -euo pipefail

STATUS="$VERBS_DIR/register-status.json"

write_status() {
  write_json_atomic "$STATUS" <<EOF
{"id":"$REQ_ID","state":"$1","phase":"$2","error":$(jq -Rn --arg e "${3-}" '$e'),"startedAt":"$STARTED_AT","finishedAt":"$(date -Is)","commit":"${COMMIT_SHA-}"}
EOF
}

fail() {
  write_status failed "$1" "$2"
  echo "register failed at $1: $2" >&2
  exit 1
}

REQ_ID="$(run_id)" || exit 1
STARTED_AT="$(date -Is)"
COMMIT_SHA=""
PAYLOAD="$(mktemp)"
NEW="$(mktemp)"
OLD="$(mktemp)"
trap 'rm -f "$PAYLOAD" "$NEW" "$OLD"' EXIT
run_payload >"$PAYLOAD"

exec 9>"$LOCKFILE"
write_status running waiting ""
flock -w 1200 9 || fail waiting "another rebuild held $LOCKFILE for 20 minutes. Nothing was changed."
site_lock 120 || fail waiting "a secret write held $SITE_LOCK for 2 minutes. Nothing was changed."

write_status running validating ""
[ -n "$(site_toplevel)" ] || fail validating "$SITE_DIR is not in a git work tree: the builder reads the committed registry, so there is nothing to register into"
jq -e '.files["apps.json"] | type == "string"' "$PAYLOAD" >/dev/null 2>&1 || fail validating "the payload carries no apps.json"
jq -j '.files["apps.json"]' "$PAYLOAD" >"$NEW"
read_as_operator "$SITE_DIR/apps.json" >"$OLD" 2>/dev/null || fail validating "could not read $SITE_DIR/apps.json as $OPERATOR_USER"

INVALID="$(jq -rn --slurpfile new "$NEW" --slurpfile old "$OLD" '
  def settled: with_entries(select(.value.awaitingImage != true));
  ($new[0] // null) as $n | ($old[0] // null) as $o
  | if ($n | type) != "object" or ($n.apps | type) != "object" then "apps.json is not an object with an `apps` object"
    elif ($o | type) != "object" or ($o.apps | type) != "object" then "the apps.json on disk is not an object with an `apps` object"
    elif $n.schemaVersion != $o.schemaVersion then "schemaVersion \($n.schemaVersion) is not the one on disk (\($o.schemaVersion))"
    elif ([$n.apps[] | type == "object"] | all | not) then "every entry must be an object"
    elif ([$n.apps | keys[] | test("^[a-z0-9][a-z0-9-]{0,62}\\z") | not] | any) then "not an app name: " + ([$n.apps | keys[] | select(test("^[a-z0-9][a-z0-9-]{0,62}\\z") | not)] | join(", "))[0:200]
    elif ($n.apps | settled) != ($o.apps | settled) then "it changes entries that are not awaiting their first image; that is an Apply"
    else "" end' 2>/dev/null || echo "apps.json is not valid JSON")"
[ -z "$INVALID" ] || fail validating "$INVALID"

SUMMARY="$(jq -r '.summary // "register"' "$PAYLOAD")"
ACTOR="$(jq -r '.actor // "daedalus"' "$PAYLOAD")"
WANT_COMMIT="$(jq -r 'if .commit == true then "yes" else "no" end' "$PAYLOAD")"

write_status running writing ""
site_backup apps.json || fail writing "could not keep the previous bytes of apps.json as $OPERATOR_USER, so it was not written"
if ! site_put apps.json "$NEW"; then
  site_restore apps.json
  fail writing "could not write apps.json into $SITE_DIR as $OPERATOR_USER"
fi

write_status running committing ""
if ! site_stage apps.json; then
  site_restore apps.json
  fail committing "git add failed; apps.json was put back"
fi
if git_op "$SITE_DIR" diff --quiet HEAD -- "$SITE_DIR/apps.json" 2>/dev/null; then
  write_status "done" "no-change" ""
  exit 0
fi
if [ "$WANT_COMMIT" = "yes" ]; then
  if ! COMMIT_SHA="$(site_commit "apps: $SUMMARY" "$ACTOR" apps.json)"; then
    site_restore apps.json
    fail committing "git commit failed; apps.json was put back"
  fi
fi
write_status "done" "complete" ""
