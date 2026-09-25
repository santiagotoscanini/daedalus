# Move the Claude Code pin — the engine's own `nix/platform/claude-code/
# manifest.json` — and hand the rebuild to the engine-update verb.
#
# The CLI on this box is a nix package, and platform/claude-code/ seals it
# with DISABLE_UPDATES precisely so that nothing else can move it. That makes
# this the only path, and it is two acts in two repositories:
#
#   1. put a newer release manifest in the ENGINE, commit it, push it;
#   2. move the configuration's `daedalus` lock onto that commit and rebuild.
#
# Only (1) is this script's. (2) is `daedalus-engine-update` — already
# written, already proven, already holding the rebuild lock and the revert —
# so the last thing this does is publish an `engine-request.json`, exactly
# the file System › Updates writes, and stop. Two small agents composed beat
# one that re-implements a switch-and-verify it would drift from.
#
# ── what "latest" means, and why the signature is checked ─────────────────
#
# Upstream publishes `claude-code-releases/latest` (a version string) and,
# per version, `manifest.json` with the per-platform checksums plus a
# detached `manifest.json.sig`. The manifest is what nixpkgs' own package
# takes as its `manifest` argument, so pointing the packaged expression at a
# newer copy is the supported override — platform/claude-code/claude-code.nix
# has the full argument.
#
# The signature check is not optional here, and the reason is this script's
# existence: until now that file was fetched by a person, who could see what
# they were committing. A machine fetching it on a button press has no such
# moment, and the file it writes decides which binary every `claude` on this
# box will be. `gpg --verify` against Anthropic's published release key, in a
# throwaway keyring, and the fingerprint is compared literally — importing a
# key proves nothing about whose it is.
#
# ── what makes this refuse ────────────────────────────────────────────────
#
# An engine override, for engine-update.sh's reason: the running system is
# then built from a local tree and moving pins under it commits a rev nothing
# runs. A clone that is diverged from origin, or whose manifest is dirty —
# this pushes, and neither case is ours to resolve. A manifest that is not
# newer than the one committed, which is a no-op and says so.
#
# Runs as root because it writes into the engine clone; every git call drops
# to the operator with setpriv, since that tree is theirs and one root-owned
# object under .git is the "unable to open loose object" push failure. The
# fetch and the verify are root's own work in a temp directory — they touch
# nothing anyone owns.

set -euo pipefail

REQ="$APPLY_DIR/claude-code-request.json"
STATUS="$APPLY_DIR/claude-code-status.json"
LOGFILE="$APPLY_DIR/claude-code-last.log"

# The flake input that carries the manifest, and the manifest's path inside
# it. Both are the engine's own layout; a configuration that renames the
# input fails validating with the name rather than writing the wrong tree.
INPUT=daedalus
MANIFEST_REL=nix/platform/claude-code/manifest.zst.json

# The manifest upstream publishes for the ZSTD artifact, which is the one
# nixpkgs' expression vendors and unpacks. There is a second, `manifest.json`,
# naming the plain binary; pinning that one does not fail, it makes the
# engine's override unreachable and the whole run a no-op that reports
# success. platform/claude-code/claude-code.nix carries the incident.
MANIFEST_FILE=manifest.zst.json

RELEASES=https://downloads.claude.ai/claude-code-releases
RELEASE_KEY=https://downloads.claude.ai/keys/claude-code.asc
# Anthropic's release signing key, as their documentation publishes it.
# Compared literally against what gpg reports for the imported key: an
# import is not a trust decision, and a key fetched over the same connection
# as the file it signs proves nothing on its own.
RELEASE_FPR=31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE

FROM_VERSION=""
TO_VERSION=""
COMMIT_SHA=""

write_status() {
  write_json_atomic "$STATUS" <<EOF
{"id":"$REQ_ID","state":"$1","phase":"$2","error":$(jq -Rn --arg e "${3-}" '$e'),"from":"$FROM_VERSION","to":"$TO_VERSION","startedAt":"$STARTED_AT","finishedAt":"$(date -Is)","commit":"$COMMIT_SHA"}
EOF
}

fail() {
  write_status failed "$1" "$2"
  echo "claude-code update failed at $1: $2" >&2
  exit 1
}

errtail() {
  log_errtail "$LOGFILE"
}

[ -f "$REQ" ] || exit 0

REQ_JSON="$(read_request "$REQ")" || exit 1

REQ_ID="$(jq -r '.id // ""' <<<"$REQ_JSON")"
[ -n "$REQ_ID" ] || exit 0
[[ "$REQ_ID" =~ ^[0-9a-fA-F-]+$ ]] || exit 0
STARTED_AT="$(date -Is)"

# Replay guard: the path unit fires on a daemon-reload at boot as well as on
# a write, and without this a completed bump would re-run on every reboot.
if [ -f "$STATUS" ] && [ "$(published_id "$STATUS")" = "$REQ_ID" ]; then
  exit 0
fi

ACTOR="$(jq -r '.actor // "daedalus"' <<<"$REQ_JSON")"

# git in the engine clone, as the operator. Absolute paths, because the
# privilege-dropped child does not inherit writeShellApplication's PATH —
# the trap every sibling script documents. No prompts: a push that wants a
# passphrase must fail, not hang the unit.
git_clone() {
  "$SETPRIV" --reuid="$OPERATOR_USER" --regid="$OPERATOR_GROUP" --init-groups --inh-caps=-all \
    "$ENV_BIN" HOME="$OPERATOR_HOME" GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes" \
    "$GIT" -C "$CLONE" "$@"
}

# The lock's node for $INPUT, as JSON, read as the operator.
lock_node() {
  { read_as_operator "$FLAKE/flake.lock" 2>/dev/null || true; } |
    jq -c --arg i "$INPUT" '.nodes[.nodes.root.inputs[$i] // ""] // empty' 2>/dev/null || true
}

# --- validate -------------------------------------------------------------
write_status "running" "validating" ""

override="$(site_engine_override)"
[ -z "$override" ] ||
  fail validating "clear the engine override first: the running system is built from $override, not from the pinned engine (site.json developer.engineOverride, Settings › Developer)"

node="$(lock_node)"
[ -n "$node" ] || fail validating "flake.lock in $FLAKE has no '$INPUT' input"

# Only a local clone can be written to. A `github:` engine is somebody
# else's tree; the manifest would have to be changed there and pushed from
# wherever that checkout lives.
kind="$(jq -r '.original.type // ""' <<<"$node")"
url="$(jq -r '.original.url // ""' <<<"$node")"
REF="$(jq -r '.original.ref // "main"' <<<"$node")"
[ "$kind" = git ] ||
  fail validating "the '$INPUT' input is of type '$kind'; this agent writes to a local clone (git+file) and cannot edit a remote engine"
case "$url" in
file://*) CLONE="${url#file://}" ;;
*) fail validating "the '$INPUT' input is not a local clone ($url)" ;;
esac
[ -d "$CLONE/.git" ] || fail validating "$CLONE (the '$INPUT' input's clone) is not a git checkout"

MANIFEST="$CLONE/$MANIFEST_REL"
[ -f "$MANIFEST" ] ||
  fail validating "$CLONE has no $MANIFEST_REL — this engine does not pin Claude Code"

FROM_VERSION="$(jq -r '.version // ""' <"$MANIFEST")"
[ -n "$FROM_VERSION" ] || fail validating "$MANIFEST_REL has no version"

current="$(git_clone rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
[ "$current" = "$REF" ] ||
  fail validating "the clone $CLONE is on '${current:-?}', not '$REF' — check it out first"

# The one file this writes must be clean, or the commit below would carry
# somebody's work-in-progress. The rest of the tree may be dirty; that is
# the operator's business and git will not be asked about it.
if ! git_clone diff --quiet -- "$MANIFEST_REL"; then
  fail validating "$MANIFEST_REL has uncommitted changes in $CLONE — commit or restore it first"
fi

log_reset "$LOGFILE"

# --- resolve --------------------------------------------------------------
# The release, its manifest and the detached signature, into a temp dir root
# owns. Nothing is written into the clone until the signature has been
# checked.
write_status "running" "resolving" ""

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fetch() {
  curl -fsSL --max-time 60 --retry 2 --retry-delay 2 -o "$2" "$1"
}

TO_VERSION="$(curl -fsSL --max-time 30 --retry 2 "$RELEASES/latest" 2>/dev/null | tr -d '[:space:]')" ||
  fail resolving "could not ask $RELEASES/latest what the current release is"
[[ "$TO_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  fail resolving "$RELEASES/latest answered '${TO_VERSION:-<empty>}', which is not a version"

if [ "$TO_VERSION" = "$FROM_VERSION" ]; then
  write_status "done" "complete" ""
  echo "claude-code update: already pinned to $TO_VERSION"
  exit 0
fi

fetch "$RELEASES/$TO_VERSION/$MANIFEST_FILE" "$WORK/manifest.json" ||
  fail resolving "could not fetch $MANIFEST_FILE for $TO_VERSION"
fetch "$RELEASES/$TO_VERSION/$MANIFEST_FILE.sig" "$WORK/manifest.json.sig" ||
  fail resolving "could not fetch the signature for $TO_VERSION (signatures exist from 2.1.89 onward)"
fetch "$RELEASE_KEY" "$WORK/key.asc" ||
  fail resolving "could not fetch the release signing key from $RELEASE_KEY"

# The artifact shape must match the one already pinned, or the engine's
# override goes dormant and this whole run is a no-op that reported success —
# the failure platform/claude-code/claude-code.nix documents. Compared
# against the committed manifest rather than against a literal, so the day
# upstream renames its artifacts this refuses loudly instead of pinning
# something the build will ignore.
want="$(jq -r '.platforms | to_entries[0].value.binary // ""' <"$MANIFEST" 2>/dev/null || true)"
got="$(jq -r '.platforms | to_entries[0].value.binary // ""' <"$WORK/manifest.json" 2>/dev/null || true)"
if [ -n "$want" ] && [ -n "$got" ] && [ "${want##*.}" != "${got##*.}" ]; then
  fail resolving "the pinned manifest names '$want' and $TO_VERSION's names '$got' — pinning it would make the engine's override unreachable and change nothing. platform/claude-code/claude-code.nix has the argument."
fi

# The manifest must actually be about the release it was fetched for.
# Upstream has never served a mismatch; this is here so that a redirect or a
# cache that does would not be committed as the version it is not.
said="$(jq -r '.version // ""' <"$WORK/manifest.json" 2>/dev/null || true)"
[ "$said" = "$TO_VERSION" ] ||
  fail resolving "the manifest at $TO_VERSION says it is version '${said:-<none>}'"

# --- verify ---------------------------------------------------------------
# A throwaway keyring: this proves a signature, it does not add anyone to a
# trust store the box keeps.
write_status "running" "verifying" ""

export GNUPGHOME="$WORK/gnupg"
mkdir -p "$GNUPGHOME"
chmod 700 "$GNUPGHOME"

log_run "$LOGFILE" gpg --batch --import "$WORK/key.asc" ||
  fail verifying "could not import the release signing key — $(errtail)"

# `--with-colons` so the fingerprint is a field rather than something to
# parse out of prose. Every fpr the key carries is considered, because a key
# with a subkey prints more than one and only one of them is the primary.
if ! gpg --batch --with-colons --fingerprint 2>/dev/null | grep -q "^fpr:::::::::$RELEASE_FPR:"; then
  fail verifying "the key served by $RELEASE_KEY is not $RELEASE_FPR — refusing to trust this manifest"
fi

if ! log_run "$LOGFILE" gpg --batch --verify "$WORK/manifest.json.sig" "$WORK/manifest.json"; then
  fail verifying "the manifest for $TO_VERSION is not signed by $RELEASE_FPR — $(errtail)"
fi

# --- commit ---------------------------------------------------------------
# Written as the operator, so the file keeps the ownership the rest of the
# tree has and the commit below can be made by the same user.
write_status "running" "committing" ""

if ! as_operator_fn op_publish "$MANIFEST" 0644 json <"$WORK/manifest.json"; then
  fail committing "could not write $MANIFEST_REL in $CLONE"
fi

# Pull origin in before committing on top of it, so the push below is a
# fast-forward. Refuses a diverged clone rather than deciding what to do
# with unpushed work — push it, then press this again.
if ! log_run "$LOGFILE" git_clone fetch --quiet --prune origin "$REF"; then
  fail committing "could not fetch origin/$REF in $CLONE — $(errtail)"
fi
ahead="$(git_clone rev-list --count "origin/$REF..$REF" 2>/dev/null || echo 0)"
if [ "${ahead:-0}" != "0" ]; then
  git_clone checkout --quiet -- "$MANIFEST_REL" || true
  fail committing "$CLONE has $ahead commit(s) on '$REF' that are not on origin — push them first"
fi
if ! log_run "$LOGFILE" git_clone merge --ff-only "origin/$REF"; then
  git_clone checkout --quiet -- "$MANIFEST_REL" || true
  fail committing "could not fast-forward $CLONE to origin/$REF — $(errtail)"
fi

if ! log_run "$LOGFILE" git_clone -c "user.email=$(commit_email)" -c "user.name=$(commit_name "$HOSTNAME")" \
  commit --quiet -m "claude-code: pin $FROM_VERSION → $TO_VERSION

The release manifest for $TO_VERSION, signature-verified against
$RELEASE_FPR before it was written.

Pinned from daedalus by $ACTOR." -- "$MANIFEST_REL"; then
  git_clone checkout --quiet -- "$MANIFEST_REL" || true
  fail committing "could not commit $MANIFEST_REL in $CLONE — $(errtail)"
fi
COMMIT_SHA="$(git_clone rev-parse --short HEAD 2>/dev/null || true)"

# Pushed before the handoff, not after: the engine update fast-forwards this
# same clone from origin, so a commit that only exists locally would be
# fast-forwarded away before nix ever resolved it.
if ! log_run "$LOGFILE" git_clone push origin "$REF"; then
  git_clone reset --quiet --hard "origin/$REF" || true
  fail committing "could not push $REF to origin — $(errtail). The commit was rolled back; nothing is pinned."
fi

# --- hand off -------------------------------------------------------------
# The same file System › Updates writes. From here the engine verb owns the
# rebuild: it takes the rebuild lock, re-resolves the input, builds, commits
# the configuration's flake.lock, switches, verifies that the control plane
# answers, reverts if it does not, and pushes.
write_status "running" "handing-off" ""

handoff="$(
  jq -nc --arg id "$(cat /proc/sys/kernel/random/uuid)" --arg at "$(date -Is)" --arg a "$ACTOR" \
    '{id: $id, requestedAt: $at, actor: $a}'
)"
if ! printf '%s\n' "$handoff" | write_json_atomic "$APPLY_DIR/engine-request.json"; then
  fail handing-off "pinned $TO_VERSION and pushed it, but could not ask for an engine update. Press Update daedalus on System › Updates to finish the move."
fi

write_status "done" "complete" ""
echo "claude-code update: pinned $FROM_VERSION → $TO_VERSION ($COMMIT_SHA), engine update requested"
