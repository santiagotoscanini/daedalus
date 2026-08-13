# Move a container's image pin, and rebuild onto it.
#
# The fifth file-drop bridge, and the only one that EDITS the flake. Apply
# copies bytes daedalus rendered (host/apply.sh); this one rewrites nix source
# in place, so almost all of the care here is about making that rewrite
# something a machine is allowed to do unattended.
#
# ── what makes the edit safe ──────────────────────────────────────────────
#
# The digest. A pin is `<repo>:<tag>@sha256:<digest>`, and of those three
# parts the digest is the only one that is ALWAYS a literal in the source:
# eight pins on this box (plane's six, immich's two) interpolate a shared
# version variable into the tag, so the rendered tag appears nowhere in the
# file. A digest is also globally unique and 64 hex characters long, which
# makes `grep -F` on it an exact, unambiguous locator with no escaping
# question and no chance of matching prose.
#
# So every edit is anchored on the digest: find the one file holding it,
# replace it, and only then — with the new digest already written and
# therefore unique — touch the tag beside it. A tag move that finds no literal
# falls through to the version-variable case, which is looked up by the
# PRIMARY's old tag (`immichVersion = "v3.1.0"`). Neither matching is a
# failure, not a guess: the script stops before `git add`, so a pin it does
# not understand costs nothing.
#
# ── what it deliberately does not decide ──────────────────────────────────
#
# Which tag to move TO. `toTag` arrives in the request, chosen by a person who
# read the changelog; absent, it means "re-resolve the tag I am already on",
# which is the whole update for a channel pin like `:latest`. The daily
# freshness probe publishes the shortlist that person picked from — see
# host/image-freshness.sh for why candidates are shape-matched rather than
# newest-wins.
#
# ── failure ───────────────────────────────────────────────────────────────
#
# Identical to apply.sh, because it is the same risk: `build` before `switch`
# so an eval error never reaches the running system, one retry on switch
# (pi-hole restarting takes cloudflared-route-sync down with it, transiently),
# and `git revert` rather than `reset --hard` because this repo is shared with
# a human at a shell and with flake-autoupgrade.
#
# Runs as root, because only root can `nixos-rebuild switch`. Every git call
# drops to the operator with setpriv so the repo never acquires root-owned
# objects; podman drops the same way because the images live in santiago's
# rootless store.

set -euo pipefail

REQ="$APPLY_DIR/image-request.json"
STATUS="$APPLY_DIR/image-status.json"
LOGFILE="$APPLY_DIR/image-last.log"

# Every move this run intends, as a JSON array — published in the status so
# the page can name what is changing while it changes, including the lockstep
# members the operator never picked.
MOVES='[]'

write_status() {
  write_json_atomic "$STATUS" <<EOF
{"id":"$REQ_ID","container":$(jq -Rn --arg c "${CONTAINER-}" '$c'),"state":"$1","phase":"$2","error":$(jq -Rn --arg e "${3-}" '$e'),"moves":$MOVES,"startedAt":"$STARTED_AT","finishedAt":"$(date -Is)","commit":"${COMMIT_SHA-}"}
EOF
}

fail() {
  write_status failed "$1" "$2"
  echo "image update failed at $1: $2" >&2
  exit 1
}

# Captured BEFORE rollback runs, for the reason apply.sh spells out: rollback
# appends its own successful switch to this same log, so a tail taken
# afterwards shows a success and the real error scrolled out of the window.
errtail() {
  grep -vE '^(evaluation warning: Podman container|[[:space:]]+with `--sdnotify=conmon)' "$LOGFILE" |
    tail -c 1200
}

[ -f "$REQ" ] || exit 0

REQ_ID="$(jq -r '.id // ""' "$REQ")"
[ -n "$REQ_ID" ] || exit 0
# The id names nothing on disk here, but it is still written by the container
# and lands in a status file and a log line. Same UUID constraint as the other
# bridges rather than a different rule per verb.
[[ "$REQ_ID" =~ ^[0-9a-fA-F-]+$ ]] || exit 0
STARTED_AT="$(date -Is)"
COMMIT_SHA=""

# Replay guard: the path unit fires on a daemon-reload at boot as well as on a
# write, and without this a completed update would rebuild the box on every
# reboot.
if [ -f "$STATUS" ] && [ "$(jq -r '.id // ""' "$STATUS")" = "$REQ_ID" ]; then
  exit 0
fi

CONTAINER="$(jq -r '.container // ""' "$REQ")"
TO_TAG="$(jq -r '.toTag // ""' "$REQ")"
ACTOR="$(jq -r '.actor // "daedalus"' "$REQ")"

git_() {
  setpriv --reuid="$OPERATOR_USER" --regid="$OPERATOR_GROUP" --init-groups \
    git -C "$FLAKE" "$@"
}

# Absolute paths, because the privilege-dropped child does not inherit
# writeShellApplication's PATH — the trap every sibling script documents.
podman_() {
  "$SETPRIV" --reuid="$OPERATOR_USER" --regid="$OPERATOR_GROUP" --init-groups --inh-caps=-all \
    "$ENV_BIN" HOME=/home/"$OPERATOR_USER" XDG_RUNTIME_DIR=/run/user/1000 \
    "$PODMAN" "$@"
}

# --- validate -------------------------------------------------------------
write_status running validating ""

[ -n "$CONTAINER" ] || fail validating "no container named in the request"

# The pin registry is rendered by nix from the running config, so a container
# absent from it is one that has no digest pin — a local build, or an app on
# the registry loop, neither of which is updated by editing a pin. This is
# also the allowlist: nothing reaches skopeo or sed that nix did not name.
PIN="$(jq -c --arg c "$CONTAINER" '.[$c] // empty' "$PINS")"
[ -n "$PIN" ] || fail validating "'$CONTAINER' has no digest-pinned image in this configuration"

[ "$(jq -r '.updatable' <<<"$PIN")" = "true" ] ||
  fail validating "'$CONTAINER' is declared not updatable from daedalus (fleet.imageUpdates)"

FROM_TAG="$(jq -r '.tag' <<<"$PIN")"
[ -n "$TO_TAG" ] || TO_TAG="$FROM_TAG"

# A tag is a registry reference that becomes part of a `docker://` URL and a
# nix string literal. Constrain it to what a tag may actually contain rather
# than trusting the picker to have offered only real ones.
[[ "$TO_TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$ ]] ||
  fail validating "'$TO_TAG' is not a well-formed image tag"

# --- resolve --------------------------------------------------------------
# Every container that must move, and what each moves to. The primary is
# whatever was asked for; a lockstep member follows by substituting the
# primary's old tag for the new one inside its OWN tag, which is what carries
# `v3.1.0-openvino` along with `v3.1.0`.
write_status running resolving ""

members="$CONTAINER $(jq -r '.lockstep[]?' <<<"$PIN" | tr '\n' ' ')"

for m in $members; do
  mpin="$(jq -c --arg c "$m" '.[$c] // empty' "$PINS")"
  [ -n "$mpin" ] || fail resolving "lockstep member '$m' has no digest pin"

  m_repo="$(jq -r '.repo' <<<"$mpin")"
  m_tag="$(jq -r '.tag' <<<"$mpin")"
  m_digest="$(jq -r '.digest' <<<"$mpin")"

  if [ "$m" = "$CONTAINER" ]; then
    m_new_tag="$TO_TAG"
  elif [ "$TO_TAG" = "$FROM_TAG" ]; then
    # A same-tag re-resolve: every member keeps its own tag and only the
    # digest moves. Nothing to substitute.
    m_new_tag="$m_tag"
  else
    case "$m_tag" in
    *"$FROM_TAG"*) m_new_tag="${m_tag//"$FROM_TAG"/"$TO_TAG"}" ;;
    *)
      # Refused rather than guessed. A member whose tag does not embed the
      # primary's is not a variant of it, and inventing one would pull an
      # unrelated image into a commit nobody reviewed.
      fail resolving "cannot derive a tag for '$m': its tag '$m_tag' does not contain '$FROM_TAG'"
      ;;
    esac
  fi

  m_new_digest="$(timeout 60 skopeo inspect --no-tags --format '{{.Digest}}' \
    "docker://$m_repo:$m_new_tag" 2>&1)" ||
    fail resolving "the registry would not resolve $m_repo:$m_new_tag — $(printf '%s' "$m_new_digest" | tail -n 1 | cut -c1-200)"

  # No-ops are carried through the list rather than dropped, so the status
  # says "this one was already there" instead of silently omitting a
  # container the operator was told would move.
  changed=true
  [ "$m_new_tag" = "$m_tag" ] && [ "$m_new_digest" = "$m_digest" ] && changed=false

  MOVES="$(jq -c \
    --arg c "$m" --arg repo "$m_repo" \
    --arg ft "$m_tag" --arg fd "$m_digest" \
    --arg tt "$m_new_tag" --arg td "$m_new_digest" \
    --argjson ch "$changed" \
    '. + [{container:$c, repo:$repo, fromTag:$ft, fromDigest:$fd, toTag:$tt, toDigest:$td, changed:$ch}]' \
    <<<"$MOVES")"
done

if [ "$(jq -r '[.[] | select(.changed)] | length' <<<"$MOVES")" = "0" ]; then
  write_status "done" "no-change" ""
  exit 0
fi

# --- pull -----------------------------------------------------------------
# Before anything is edited, so a registry that will not serve the new image
# costs a failed request rather than a reverted commit. It also makes the
# container bounce during the switch seconds rather than minutes.
write_status running pulling ""

while read -r m repo tag digest; do
  [ -n "$m" ] || continue
  podman_ pull "$repo:$tag@$digest" >/dev/null 2>&1 ||
    fail pulling "could not pull $repo:$tag@$digest for '$m' — nothing was changed"
done < <(jq -r '.[] | select(.changed) | [.container, .repo, .toTag, .toDigest] | @tsv' <<<"$MOVES")

# --- serialise against every other rebuild --------------------------------
# The shared lock, same as apply.sh and flake-autoupgrade: overlapping
# activations and interleaved commits on one repo are how this box ends up
# matching neither branch. Waits rather than fails; released when fd 9 closes
# at exit, including on failure.
exec 9>"$LOCKFILE"
write_status running waiting ""
if ! flock -w 1200 9; then
  fail waiting "another rebuild held $LOCKFILE for 20 minutes (flake-autoupgrade, or a manual nixos-rebuild). Nothing was changed."
fi

# --- write ----------------------------------------------------------------
write_status running writing ""

# sed pattern escaping. Digests are hex and safe; tags admit `.`, which would
# otherwise match any character. Cheap to do properly, and this is the one
# place in the bridge where a regex touches source code.
esc() { printf '%s' "$1" | sed -e 's/[][\.*^$|]/\\&/g'; }

TOUCHED=""

while read -r m repo from_tag from_digest to_tag to_digest; do
  [ -n "$m" ] || continue

  files="$(grep -rlF --include='*.nix' -- "$from_digest" "$FLAKE" || true)"

  if [ -z "$files" ]; then
    # Already gone. The legitimate case is a shared literal: gluetun and
    # gluetun-argus reach ONE image string, so the first member's edit moved
    # the second's pin too. Confirm that is what happened rather than
    # assuming it.
    if grep -rqF --include='*.nix' -- "$to_digest" "$FLAKE"; then
      continue
    fi
    fail writing "no .nix file holds '$m'’s pinned digest $from_digest"
  fi

  if [ "$(printf '%s\n' "$files" | wc -l)" -ne 1 ]; then
    fail writing "'$m'’s digest $from_digest appears in more than one file: $(printf '%s' "$files" | tr '\n' ' ')"
  fi

  # Digest first, so the tag edit below can anchor on a string that is now
  # unique in the file.
  sed -i "s|$(esc "$from_digest")|$to_digest|g" "$files"

  if [ "$to_tag" != "$from_tag" ]; then
    if grep -qF -- ":$from_tag@$to_digest" "$files"; then
      # The literal case: `repo:6.3.0-ls312@sha256:…`.
      sed -i "s|:$(esc "$from_tag")@$(esc "$to_digest")|:$to_tag@$to_digest|g" "$files"
    elif grep -qE "= \"$(esc "$FROM_TAG")\";" "$files"; then
      # The interpolated case: the tag is `${immichVersion}` and the version
      # lives in a `let`. Matched on the PRIMARY's old tag, because that is
      # what the variable holds — a member's `-openvino` suffix is in the
      # image string, not in the variable.
      sed -i "s|= \"$(esc "$FROM_TAG")\";|= \"$TO_TAG\";|" "$files"
    elif grep -qE "= \"$(esc "$TO_TAG")\";" "$files"; then
      # A lockstep sibling arriving after the primary already moved the shared
      # variable. immich's ML image and plane's other five reach the SAME
      # `let` binding, so by the time they are processed the tag they were
      # looking for is gone and the one they want is in its place — which is
      # success, not the failure it looks like. Their own digests still had to
      # be rewritten individually, and that happened above.
      :
    else
      fail writing "'$m' moves to tag '$to_tag' but neither a literal tag nor a version variable holding '$FROM_TAG' was found in $files"
    fi
  fi

  case " $TOUCHED " in
  *" $files "*) ;;
  *) TOUCHED="$TOUCHED $files" ;;
  esac
done < <(jq -r '.[] | select(.changed) | [.container, .repo, .fromTag, .fromDigest, .toTag, .toDigest] | @tsv' <<<"$MOVES")

# Prove the rewrite landed before committing it. A sed that matched nothing
# exits 0, so this is the only thing standing between a silent no-op and a
# commit titled "update image" that changes nothing.
while read -r to_digest; do
  [ -n "$to_digest" ] || continue
  grep -rqF --include='*.nix' -- "$to_digest" "$FLAKE" ||
    fail writing "after editing, $to_digest is not in the flake — the rewrite did not land"
done < <(jq -r '.[] | select(.changed) | .toDigest' <<<"$MOVES")

# --- commit ---------------------------------------------------------------
# The flake only sees git-tracked files, so `git add` is not bookkeeping.
# Scoped to the files this run touched, both here and in the emptiness check
# below: this repo's index is shared with a human at a shell, and a bare
# `git commit` would sweep their staged work into a commit titled after an
# image bump and then push it.
write_status running committing ""

# shellcheck disable=SC2086 # TOUCHED is a space-separated path list by design.
git_ add -- $TOUCHED

SUMMARY="$(jq -r '[.[] | select(.changed) | "\(.container): \(.fromTag) → \(.toTag)"] | join(", ")' <<<"$MOVES")"
BODY="$(jq -r '.[] | select(.changed) | "\(.container)\n  \(.repo):\(.fromTag)@\(.fromDigest)\n  → \(.repo):\(.toTag)@\(.toDigest)"' <<<"$MOVES")"

# shellcheck disable=SC2086
if git_ diff --cached --quiet -- $TOUCHED; then
  write_status "done" "no-change" ""
  exit 0
fi

# shellcheck disable=SC2086
git_ -c "user.name=daedalus" -c "user.email=$GIT_EMAIL" \
  commit -q -m "images: $SUMMARY" -m "$BODY" -m "Applied from daedalus by $ACTOR." -- $TOUCHED ||
  fail committing "git commit failed"

COMMIT_SHA="$(git_ rev-parse --short HEAD)"
UPDATE_COMMIT="$COMMIT_SHA"

# --- roll back ------------------------------------------------------------
# `git revert`, not `reset --hard`: this repo is shared, and a reset really
# did eat an unrelated commit the first time an apply's switch failed.
rollback() {
  git_ -c "user.name=daedalus" -c "user.email=$GIT_EMAIL" \
    revert --no-edit "$UPDATE_COMMIT" >>"$LOGFILE" 2>&1 ||
    echo "revert of $UPDATE_COMMIT failed — repo left as-is, resolve by hand" >>"$LOGFILE"
  nixos-rebuild switch --flake "$FLAKE#$HOSTNAME" >>"$LOGFILE" 2>&1 || true
  COMMIT_SHA=""
}

# --- build ----------------------------------------------------------------
# Without touching the running system: an eval error or a bad digest dies
# here, which is the difference between a rejected update and a broken box.
write_status running building ""
: >"$LOGFILE"
chown "$OPERATOR_USER:$OPERATOR_GROUP" "$LOGFILE"
if ! nixos-rebuild build --flake "$FLAKE#$HOSTNAME" >>"$LOGFILE" 2>&1; then
  build_error="$(errtail)"
  rollback
  fail building "$build_error"
fi

# --- switch ---------------------------------------------------------------
# One retry before rolling back, for the reason apply.sh documents: `switch`
# exits non-zero if ANY unit fails to come back, and some of those failures
# are transient rather than caused by the change.
write_status running switching ""
if ! nixos-rebuild switch --flake "$FLAKE#$HOSTNAME" >>"$LOGFILE" 2>&1; then
  echo "switch failed once — retrying in 20s before rolling back" >>"$LOGFILE"
  sleep 20
  if ! nixos-rebuild switch --flake "$FLAKE#$HOSTNAME" >>"$LOGFILE" 2>&1; then
    switch_error="$(errtail)"
    rollback
    fail switching "$switch_error"
  fi
  echo "switch succeeded on retry (first failure was transient)" >>"$LOGFILE"
fi

# --- verify ---------------------------------------------------------------
# The unit going green proves nothing — `Type=oneshot` + `--rm` leaves an
# active unit over a container that died seconds in, which is the single most
# repeated failure mode on this box. So ask the container what image it is
# actually running, and treat a mismatch as a failed update.
#
# A short grace first: the switch returns when systemd is done starting units,
# which is before a container that pulls, migrates or waits on a dependency is
# answering for itself.
write_status running verifying ""
sleep 15

bad=""
while read -r m to_digest; do
  [ -n "$m" ] || continue
  running="$(podman_ inspect "$m" --format '{{.ImageDigest}}' 2>/dev/null || true)"
  if [ -z "$running" ]; then
    bad="$bad $m(no container)"
  elif [ "$running" != "$to_digest" ]; then
    bad="$bad $m(running $running)"
  fi
done < <(jq -r '.[] | select(.changed) | [.container, .toDigest] | @tsv' <<<"$MOVES")

if [ -n "$bad" ]; then
  echo "verification failed for:$bad" >>"$LOGFILE"
  rollback
  fail verifying "the switch succeeded but these are not running the new image:$bad — rolled back"
fi

# --- push -----------------------------------------------------------------
# Best-effort: /etc/nixos lives on rpool/root, which has no snapshots and is
# not in the syncoid mirror, so the remote is the only backup — but a network
# blip must not turn a successful rebuild into a reported failure.
write_status running pushing ""
git_ push >>"$LOGFILE" 2>&1 ||
  echo "push failed (the switch succeeded; the commit is local only)" >>"$LOGFILE"

write_status "done" "complete" ""
