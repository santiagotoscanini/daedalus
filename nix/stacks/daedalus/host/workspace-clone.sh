# Clone a project's repo into the workspace root on daedalus's behalf: the
# root helper's `workspace-clone` (daedalus-verbs.nix), started as
# `daedalus-workspace-clone@<run id>` with the request in its run file
# (host/lib.sh take_run_file). On a repo that is already cloned it
# fast-forwards instead, so the one button is honestly "make the workspace
# exist and make it current".
#
# Why the host does this: the clone lands in the operator's home, over the
# operator's GitHub SSH identity (platform/git) — a credential that can push
# to every repo on the account and therefore must never enter the container.
# What crosses is a repo slug; the key stays in /run/secrets.
#
# The slug is a FULL owner/name, unlike the build's bare app name: the
# off-box projects live under other owners (santree-ai/*), and pinning the
# owner here would make those unclonable by construction. The gate in front
# of daedalus is what authorises the click; the helper holds the slug to its
# pattern (the verb's `patterns.repo`), and this checks its SHAPE again so it
# cannot become an argument, a path escape, or a unit name — and the app side
# only offers repos it actually lists.
#
# Every refusal (a malformed slug, a directory collision, a repo the key
# cannot reach) is exit 0 with a last line `refused: <reason>`, the helper's
# word for it. Only the agent being unable to work at all exits 1.

set -euo pipefail

refuse() {
  echo "refused: $1"
  exit 0
}

REQ_JSON="$(take_run_file "${1-}")" || exit 1
REPO="$(jq -r '.selectors.repo // ""' <<<"$REQ_JSON")"
ACTOR="$(jq -r '.selectors.actor // "unknown"' <<<"$REQ_JSON")"

# owner/name, exactly one slash. Owner follows GitHub's account rule
# (alphanumerics and hyphens, no leading hyphen); the name additionally
# allows dot and underscore but must not start with either — which also
# rules out "." and "..", the two names that would escape the root.
case "$REPO" in
*/*/* | "") refuse "refusing repo slug '$REPO'" ;;
*/*) ;;
*) refuse "refusing repo slug '$REPO' — need owner/name" ;;
esac
OWNER_PART="${REPO%%/*}"
NAME_PART="${REPO#*/}"
case "$OWNER_PART" in
*[!A-Za-z0-9-]* | "" | -*) refuse "refusing repo owner '$OWNER_PART'" ;;
esac
case "$NAME_PART" in
*[!A-Za-z0-9._-]* | "" | -* | .*) refuse "refusing repo name '$NAME_PART'" ;;
esac

echo "workspace request: $REPO (requested by $ACTOR)"

ensure_dirs
lock_workspaces

DEST="$WORKSPACE_ROOT/$NAME_PART"

if [ -e "$DEST" ]; then
  [ -d "$DEST/.git" ] || refuse "$DEST exists and is not a git clone"
  EXISTING="$(slug_of "$(git_op -C "$DEST" remote get-url origin 2>/dev/null || true)")"
  if [ "$EXISTING" != "$REPO" ]; then
    refuse "$DEST already holds a clone of '${EXISTING:-something else}'"
  fi
  echo "already cloned — pulling"
  sync_workspace "$DEST"
  publish_workspaces
  OUTCOME="$(jq -r '.result + (if (.detail // "") == "" then "" else " — " + .detail end)' \
    "$OUT_DIR/.state/$NAME_PART" 2>/dev/null || echo ok)"
  echo "already at $DEST — $OUTCOME"
  exit 0
fi

echo "cloning $REPO"

# Into a dot-prefixed temp INSIDE the root (publish skips non-repo dirs and
# hidden names), renamed only once complete — a half-transferred clone must
# never be something the sync timer or a Claude session can walk into.
#
# The removals and the rename run as the operator: the workspace root is
# theirs, and a root `mv` into a DEST that became a link between the check
# above and here would move the clone wherever the link pointed (host/lib.sh).
# -T for the same race from the other side: a directory that appeared at DEST
# fails the rename instead of swallowing the clone.
TMP="$WORKSPACE_ROOT/.$NAME_PART.cloning"
as_operator rm -rf -- "$TMP"
ERR="$(mktemp)"
if ! git_op clone --quiet -- "git@github.com:$REPO.git" "$TMP" 2>"$ERR"; then
  as_operator rm -rf -- "$TMP"
  refuse "git clone failed: $(tail -c 300 "$ERR" | tr '\n' ' ')"
fi
rm -f "$ERR"
as_operator mv -T -- "$TMP" "$DEST" || refuse "$DEST appeared while cloning — the clone is left at $TMP"

jq -n --arg at "$(date -Is)" '{result: "ok", detail: "cloned", at: $at}' \
  >"$OUT_DIR/.state/$NAME_PART"
publish_workspaces
echo "cloned $REPO into $DEST"
