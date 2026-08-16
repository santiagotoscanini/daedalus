# Clone a project's repo into the workspace root on daedalus's behalf — the
# sixth file-drop verb. On a repo that is already cloned it fast-forwards
# instead, so the one button is honestly "make the workspace exist and make it
# current".
#
# Why the host does this: the clone lands in the operator's home, over the
# operator's GitHub SSH identity (platform/git) — a credential that can push
# to every repo on the account and therefore must never enter the container.
# What crosses the bridge is a repo slug; the key stays in /run/secrets.
#
# The slug is a FULL owner/name, unlike the ci bridge's bare name: the
# off-box projects live under other owners (santree-ai/*), and pinning the
# owner here would make those unclonable by construction. The gate in front
# of daedalus is what authorises the click; this validates the slug's SHAPE
# so it cannot become an argument, a path escape, or a unit name — and the
# app side only offers repos it actually lists.

set -euo pipefail

REQ="$APPLY_DIR/workspace-request.json"
STATUS="$APPLY_DIR/workspace-status.json"

REPO=""

write_status() {
  write_json_atomic "$STATUS" <<EOF
{"id":"$REQ_ID","repo":$(jq -Rn --arg r "$REPO" '$r'),"state":"$1","detail":$(jq -Rn --arg d "${2-}" '$d'),"error":$(jq -Rn --arg e "${3-}" '$e'),"startedAt":"$STARTED_AT","finishedAt":"$(date -Is)"}
EOF
}

# Same split as ci.sh, same reason: a request this agent correctly refuses (a
# malformed slug, a directory collision, a repo the key cannot reach) is
# reported on the page and exits 0. Only the agent being unable to work at
# all exits 1 and leaves a failed unit.
reject() {
  write_status failed "" "$1"
  echo "workspace request rejected: $1" >&2
  exit 0
}

[ -f "$REQ" ] || exit 0

REQ_ID="$(jq -r '.id // ""' "$REQ")"
[ -n "$REQ_ID" ] || exit 0
STARTED_AT="$(date -Is)"

# The path unit re-fires on a daemon-reload replay at boot; without this a
# completed request would re-clone (or re-sync) on every reboot.
if [ -f "$STATUS" ] && [ "$(jq -r '.id // ""' "$STATUS")" = "$REQ_ID" ]; then
  exit 0
fi

REPO="$(jq -r '.repo // ""' "$REQ")"
ACTOR="$(jq -r '.actor // "unknown"' "$REQ")"

# owner/name, exactly one slash. Owner follows GitHub's account rule
# (alphanumerics and hyphens, no leading hyphen); the name additionally
# allows dot and underscore but must not start with either — which also
# rules out "." and "..", the two names that would escape the root.
case "$REPO" in
*/*/* | "") reject "refusing repo slug '$REPO'" ;;
*/*) ;;
*) reject "refusing repo slug '$REPO' — need owner/name" ;;
esac
OWNER_PART="${REPO%%/*}"
NAME_PART="${REPO#*/}"
case "$OWNER_PART" in
*[!A-Za-z0-9-]* | "" | -*) reject "refusing repo owner '$OWNER_PART'" ;;
esac
case "$NAME_PART" in
*[!A-Za-z0-9._-]* | "" | -* | .*) reject "refusing repo name '$NAME_PART'" ;;
esac

echo "workspace request: $REPO (requested by $ACTOR)"

ensure_dirs
lock_workspaces

DEST="$WORKSPACE_ROOT/$NAME_PART"

if [ -e "$DEST" ]; then
  [ -d "$DEST/.git" ] || reject "$DEST exists and is not a git clone"
  EXISTING="$(slug_of "$(git_op -C "$DEST" remote get-url origin 2>/dev/null || true)")"
  if [ "$EXISTING" != "$REPO" ]; then
    reject "$DEST already holds a clone of '${EXISTING:-something else}'"
  fi
  write_status running "already cloned — pulling" ""
  sync_workspace "$DEST"
  publish_workspaces
  OUTCOME="$(jq -r '.result + (if (.detail // "") == "" then "" else " — " + .detail end)' \
    "$OUT_DIR/.state/$NAME_PART" 2>/dev/null || echo ok)"
  write_status "done" "already at $DEST — $OUTCOME" ""
  exit 0
fi

write_status running "cloning $REPO" ""

# Into a dot-prefixed temp INSIDE the root (publish skips non-repo dirs and
# hidden names), renamed only once complete — a half-transferred clone must
# never be something the sync timer or a Claude session can walk into.
TMP="$WORKSPACE_ROOT/.$NAME_PART.cloning"
rm -rf "$TMP"
ERR="$(mktemp)"
if ! git_op clone --quiet -- "git@github.com:$REPO.git" "$TMP" 2>"$ERR"; then
  rm -rf "$TMP"
  reject "git clone failed: $(tail -c 300 "$ERR" | tr '\n' ' ')"
fi
rm -f "$ERR"
mv "$TMP" "$DEST"

jq -n --arg at "$(date -Is)" '{result: "ok", detail: "cloned", at: $at}' \
  >"$OUT_DIR/.state/$NAME_PART"
publish_workspaces
write_status "done" "cloned $REPO into $DEST" ""
