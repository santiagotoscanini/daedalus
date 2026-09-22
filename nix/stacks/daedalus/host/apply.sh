# Apply a change to site/: write the files daedalus rendered, stage (and on the
# switch, commit) them, rebuild the system. Restore the bytes if the rebuild fails.
#
# Deliberately dumb. It does NOT generate, transform or validate the registry
# — daedalus renders the exact bytes (src/lib/registry-file.ts) and drops them
# at $APPLY_DIR/payload-<id>.json; this copies that file verbatim. Every
# decision about shape is application logic and belongs in TypeScript, where
# it can be typed and tested. What is left here is the part that genuinely
# needs the host: a privileged rebuild, and git.
#
# jq survives for exactly two jobs, both about *this* script's own bookkeeping
# rather than the registry: reading the request metadata, and emitting a status
# file with a correctly-escaped error string.
#
# Runs as root, because only root can `nixos-rebuild switch`. Every git call
# drops to the operator with setpriv so the repo never acquires root-owned objects
# — the same reason flake-autoupgrade does it. setpriv, not sudo/runuser:
# those open a PAM session per call.
#
# The container never runs any of this. It writes files into a bind mount; a
# systemd.path unit notices and starts this. So the app holds no privilege it
# could lose — the trust boundary is "can write into $APPLY_DIR". That
# includes the container itself (its root is the operator's uid), which is why
# nothing below touches a file in that directory as root: the request, the
# payload, the log and the status are all read and written as the operator,
# never through a link (host/lib.sh has the full argument). The previous bytes
# a rollback trusts are NOT in that directory at all — see host/site-lib.sh.

set -euo pipefail

REQ="$APPLY_DIR/request.json"
STATUS="$APPLY_DIR/status.json"
LOGFILE="$APPLY_DIR/last.log"

# Status is the ONLY channel back to the UI, so it is written at every exit
# path including the failure ones. `phase` drives the progress display;
# `error` is shown verbatim, so it carries the real message rather than
# "something went wrong". Atomic via write_json_atomic (host/lib.sh) — a
# torn status reads as "idle" in the app, which mid-rebuild is a lie.
write_status() {
  write_json_atomic "$STATUS" <<EOF
{"id":"$REQ_ID","state":"$1","phase":"$2","error":$(jq -Rn --arg e "${3-}" '$e'),"startedAt":"$STARTED_AT","finishedAt":"$(date -Is)","commit":"${COMMIT_SHA-}"}
EOF
}

fail() {
  write_status failed "$1" "$2"
  echo "apply failed at $1: $2" >&2
  exit 1
}

# What to show the operator when a rebuild fails.
#
# MUST be captured BEFORE rollback() runs. rollback appends its own
# `nixos-rebuild switch` to this same log, and that one succeeds — so a tail
# taken afterwards shows the rollback finishing with "Done. The new
# configuration is /nix/store/…" and the real error scrolled out of the
# window. That is exactly what happened to the argus/postgres apply: the panel
# reported a failure whose text read like a success, and the assertion that
# actually stopped it was 14 kB earlier in the file.
#
# The `--sdnotify=conmon` eval warnings are dropped for the same reason: there
# is one per rootless container (~40 of them, two lines each), they are
# cosmetic — see the note in platform/podman.nix — and left in they fill the
# whole window on their own.
#
# Read back as the operator, never through a link: the log sits in the
# container's directory, and what this returns is published in the status
# the container reads. Never fails, either — it runs in an assignment right
# before rollback, and under errexit an unreadable log (or grep selecting no
# lines) would otherwise end the script there, rollback never run.
errtail() {
  log_errtail "$LOGFILE"
}

[ -f "$REQ" ] || exit 0

# The request is read ONCE, as the operator, and every field below comes from
# this copy. A symlinked request.json is refused with exit 1: the app never
# writes one, so it is somebody reaching through the bridge, and a failed unit
# (mailed — see monitoredJobs) is the right amount of noise for that.
REQ_JSON="$(read_request "$REQ")" || exit 1

REQ_ID="$(jq -r '.id // ""' <<<"$REQ_JSON")"
[ -n "$REQ_ID" ] || exit 0
# The id names a path below, and request.json is written by the container —
# the far side of the trust boundary. Constrain it to UUID characters so a
# crafted id cannot traverse out of $APPLY_DIR; a request the app didn't
# write this way is not one worth answering.
[[ "$REQ_ID" =~ ^[0-9a-fA-F-]+$ ]] || exit 0
STARTED_AT="$(date -Is)"

# The payload rides under the request's own id — derived from the id HERE,
# never read as a filename from the request body. A second Apply queued while
# this one runs writes payload-<other-id>.json and cannot touch the bytes
# this run is committing; the old fixed apps.json name was the last TOCTOU
# sliver in the bridge.
PAYLOAD="$APPLY_DIR/payload-$REQ_ID.json"

# The path unit fires on any write to the request file, and again on a
# daemon-reload replay at boot. Without this guard a completed apply could
# re-run its own rebuild forever.
if [ -f "$STATUS" ] && [ "$(published_id "$STATUS")" = "$REQ_ID" ]; then
  exit 0
fi

COMMIT_SHA=""

# --- serialise against every other rebuild --------------------------------
# One lock for anything that rebuilds this system or commits to /etc/nixos.
# The other holder in practice is flake-autoupgrade, which does `nix flake
# update --commit-lock-file` AND `nixos-rebuild boot` — so it can be building,
# committing and pushing at the same moment an apply is doing all three.
# Overlapping activations and interleaved commits on a shared repo are exactly
# how this ends up with a system that matches neither branch.
#
# A shared path, not a daedalus-private one: a lock only this script respects
# would protect nothing. platform/autoupgrade takes the same one, and a human
# running `nixos-rebuild` by hand can take it with
# `flock /run/lock/fleet-rebuild.lock nixos-rebuild switch`.
#
# WAIT rather than fail: the common case is a weekly upgrade that finishes in
# minutes, and the UI shows the wait as its own phase. Released implicitly when
# fd 9 closes at exit — including on failure, so a crashed apply cannot wedge
# every future rebuild.
exec 9>"$LOCKFILE"
write_status running waiting ""
if ! flock -w 1200 9; then
  fail waiting "another rebuild held $LOCKFILE for 20 minutes (flake-autoupgrade, or a manual nixos-rebuild). Nothing was changed."
fi

write_status running validating ""

# request.json is written after the payload precisely so this cannot race,
# but check rather than assume: a missing payload here would otherwise commit
# an empty registry and take every app down.
#
# A symlinked payload is the attack this bridge was hardened against, not a
# payload: linked at /run/secrets/<x>, root would have copied a secret into
# site/ and committed it. Refused by name, and then read — once, as the
# operator, never through a link — into a root-private copy that every step
# below works from, so nothing can change the bytes between validating them
# and committing them.
if [ -L "$PAYLOAD" ]; then
  fail validating "payload-$REQ_ID.json is a symlink — the bridge only accepts regular files, so it was not read"
fi
[ -s "$PAYLOAD" ] || fail validating "no payload-$REQ_ID.json alongside the request"
PAYLOAD_COPY="$(mktemp)"
trap 'rm -f "$PAYLOAD_COPY"' EXIT
read_as_operator "$PAYLOAD" >"$PAYLOAD_COPY" ||
  fail validating "payload-$REQ_ID.json could not be read as $OPERATOR_USER"

SUMMARY="$(jq -r '.summary // "update app registry"' <<<"$REQ_JSON")"
ACTOR="$(jq -r '.actor // "daedalus"' <<<"$REQ_JSON")"

# --- write ----------------------------------------------------------------
# Into site/, the one directory daedalus writes (host/site-lib.sh). The
# payload is a map of file name → bytes, and the names this will write are
# fixed HERE, never taken from the document. `jq -j` and a redirect, never a
# command substitution: these files end in a newline. Previous bytes are kept
# for the rollback below; the id-stamped payload is removed once copied so a
# failure path cannot leave payloads accumulating in the mount.
write_status running writing ""
jq -e .files "$PAYLOAD_COPY" >/dev/null 2>&1 || fail writing "payload-$REQ_ID.json is not a map of files"
# The vault entries are ciphertext the app encrypted in its container
# (Settings › Integrations); this script copies bytes and never sees a value.
# daedalus.json is the provenance stamp and rides every Apply; it is LAST so
# the order of WRITTEN still reads site.json-before-vault for the subject
# below, which drops it anyway.
#
# $VAULT_APP_SECRETS is the per-app half: `vault/apps/<name>-env.sops`, the
# operator-supplied environment of a platform app (stacks/apps —
# operator-secrets-lib.nix turns a tracked one into that app's env file). It is
# a LIST, not a pattern, and Nix builds it from the committed registry into
# this script's wrapper — so the names are still fixed host-side, which is the
# only property that matters here: a name taken from the request would be a
# path traversal with extra steps, and `jq -r '.files | keys'` would be exactly
# that. An app the box does not know about therefore has no writable path at
# all, and a payload naming one is skipped like any other unmanaged key.
# It goes after the vault root entries and before daedalus.json, so both
# orderings the subject below relies on still hold.
MANAGED=(apps.json site.json vault/cloudflare-api-token.sops vault/github-app.sops "${VAULT_APP_SECRETS[@]}" daedalus.json)
WRITTEN=()
for f in "${MANAGED[@]}"; do
  [ "$(jq -r --arg f "$f" 'if (.files[$f] | type) == "string" then "yes" else "no" end' "$PAYLOAD_COPY")" = "yes" ] || continue
  tmp="$(mktemp)"
  jq -j --arg f "$f" '.files[$f]' "$PAYLOAD_COPY" >"$tmp"
  # Recorded only once THIS run's backup of it exists: a backup that failed
  # leaves nothing of this run to restore, and what $PREV_DIR holds for the
  # name is an earlier Apply's — restoring that would put back stale bytes.
  # Recorded BEFORE the put, so a put that fails is still restored by name.
  if ! site_backup "$f"; then
    rm -f "$tmp"
    for w in "${WRITTEN[@]}"; do site_restore "$w"; done
    fail writing "could not keep the previous bytes of $f as $OPERATOR_USER, so it was not written (see the journal)"
  fi
  WRITTEN+=("$f")
  if ! site_put "$f" "$tmp"; then
    rm -f "$tmp"
    for w in "${WRITTEN[@]}"; do site_restore "$w"; done
    fail writing "could not write $f into $SITE_DIR as $OPERATOR_USER (see the journal)"
  fi
  rm -f "$tmp"
done
as_operator rm -f -- "$PAYLOAD"
[ "${#WRITTEN[@]}" -gt 0 ] || fail writing "the payload carries none of ${MANAGED[*]}"

# --- the engine override --------------------------------------------------
# site.json's `developer.engineOverride` (host/lib.sh site_engine_override):
# an engine clone on this box to build from instead of the pinned input.
# Read AFTER the write, so the Apply that sets it is already the first one
# built from the clone, and the Apply that clears it is the switch back onto
# the pinned engine — the document governs the rebuild that carries it.
#
# While it is set, every rebuild below takes the engine from that tree
# (`--override-input`, and the lock is left alone: nixos-rebuild would
# otherwise write the override into flake.lock) and the activation is `test`,
# never `switch`. The running system follows the clone as it stands,
# uncommitted files included, and the next boot still comes up on the last
# switched generation — which is the point: engine work is testable through
# an Apply before a commit is pinned, and a reboot undoes it. The status says
# so: `testing` where it would say `switching`, `tested` where `complete`.
ENGINE_OVERRIDE="$(site_engine_override)"
REBUILD_FLAGS=()
ACTIVATE="switch"
if [ -n "$ENGINE_OVERRIDE" ]; then
  if [ ! -f "$ENGINE_OVERRIDE/flake.nix" ]; then
    for w in "${WRITTEN[@]}"; do site_restore "$w"; done
    fail writing "developer.engineOverride names $ENGINE_OVERRIDE, which has no flake.nix — not an engine clone. Nothing was rebuilt; the written files were put back."
  fi
  REBUILD_FLAGS=(--override-input daedalus "path:$ENGINE_OVERRIDE" --no-write-lock-file)
  ACTIVATE="test"
fi

# `build`, or the activation, with the override's flags when there is one.
rebuild() {
  nixos-rebuild "$1" --flake "$FLAKE#$HOSTNAME" "${REBUILD_FLAGS[@]}"
}

# --- stage, and commit if asked -----------------------------------------
# A flake only sees git-tracked files, so staging is not bookkeeping — an
# unstaged new file is invisible to the rebuild below. Committing is the
# operator's switch, carried in the request; when it is on, the commit is
# scoped to site/ because this index is shared with a person (a bare commit
# once swept a human's staged work into an "apps:" commit and pushed it).
write_status running committing ""
site_stage "${WRITTEN[@]}" || fail committing "git add failed"

if [ -n "$(site_toplevel)" ] && site_git diff --quiet HEAD -- "$SITE_DIR" 2>/dev/null; then
  write_status "done" "no-change" ""
  exit 0
fi

WANT_COMMIT="$(jq -r 'if .commit == true then "yes" else "no" end' <<<"$REQ_JSON")"
# The subject names what was written: `apps:` for the registry, `site:` for
# the document, `vault:` for a secret, `apply:` for any other mix.
#
# One mix still reads as `vault:`: site.json beside exactly ONE vault file.
# That is how a secret whose identity lives in the document lands — the
# GitHub App's callback writes vault/github-app.sops and site.json's
# `github.app` together, and the change is the credential, not the document.
# MANAGED lists site.json before every vault entry, so WRITTEN is always in
# that order; the count keeps "site.json and two vault files" out of it.
#
# daedalus.json is dropped first. The stamp rides EVERY Apply and names
# nothing that changed, so leaving it in would make every subject read
# `apply:` — the exact opposite of what these cases are for.
#
# `vault/*` is deliberately a bare glob and needs to stay one: it is what makes
# a nested `vault/apps/<name>-env.sops` read as `vault:` rather than falling
# through to `apply:`. An app secret IS a vault write, so it wants no arm of
# its own — but tightening this pattern to something like `vault/*.sops` would
# take that away silently, and the only symptom would be a vague commit
# subject.
SUBJECT=()
for w in "${WRITTEN[@]}"; do
  [ "$w" = daedalus.json ] || SUBJECT+=("$w")
done
case "${SUBJECT[*]}" in
apps.json) PREFIX=apps ;;
site.json) PREFIX=site ;;
vault/*) PREFIX=vault ;;
"site.json vault/"*)
  if [ "${#SUBJECT[@]}" -eq 2 ]; then PREFIX=vault; else PREFIX=apply; fi
  ;;
*) PREFIX=apply ;;
esac
if [ "$WANT_COMMIT" = "yes" ]; then
  COMMIT_SHA="$(site_commit "$PREFIX: $SUMMARY" "$ACTOR")" || fail committing "git commit failed"
fi

# --- roll back ------------------------------------------------------------
# Put the previous bytes of every file this run wrote back, re-stage, commit
# the restore if we committed, and put the running system back on the result.
# Bytes, not `git revert`: the same mechanism whether or not the directory is
# versioned or the switch is on, and it cannot eat a commit somebody else
# made meanwhile — it touches only what it wrote.
rollback() {
  local f
  for f in "${WRITTEN[@]}"; do site_restore "$f"; done
  if [ "$WANT_COMMIT" = "yes" ] && [ -n "$COMMIT_SHA" ]; then
    log_run "$LOGFILE" site_commit "$PREFIX: revert — $SUMMARY (the rebuild failed)" "$ACTOR" ||
      log_line "$LOGFILE" "the restore is in the tree but could not be committed — commit it by hand"
  fi
  # The same activation as the run: under an override that is `test` again,
  # so a failed tested Apply is undone the way it was done.
  log_run "$LOGFILE" rebuild "$ACTIVATE" || true
  COMMIT_SHA=""
}

# --- build ----------------------------------------------------------------
# `build` first: it catches eval errors and build failures without touching
# the running system, which is the difference between a rejected change and a
# broken box. A malformed registry dies here.
#
# The log lives in the container's directory, so it is emptied and appended
# as the operator (log_reset / log_run in host/lib.sh) — born theirs, no chown
# by name afterwards.
write_status running building ""
log_reset "$LOGFILE"
if ! log_run "$LOGFILE" rebuild build; then
  build_error="$(errtail)"
  rollback
  fail building "$build_error"
fi

# --- switch (or test, under an engine override) ---------------------------
# Retried once before giving up. `switch` exits non-zero if ANY unit fails to
# come back, and some of those failures are transient rather than caused by the
# change: DNS is briefly unavailable while pi-hole restarts, so a unit that
# talks to the network (cloudflared-route-sync, reconciling CF CNAMEs) can fail
# and then succeed on its own Restart=on-failure seconds later. Rolling back on
# that is both unnecessary and destructive — it reverts a change that was
# perfectly good. Observed in practice; the second attempt succeeds.
#
# The phase names the verb: `testing` is what the Apply bar shows in
# `switching`'s slot, and a status ending `tested` is how the Repository tab
# says the last Apply did not become the next boot.
if [ "$ACTIVATE" = "test" ]; then
  ACTIVATE_PHASE=testing
  DONE_PHASE=tested
else
  ACTIVATE_PHASE=switching
  DONE_PHASE=complete
fi
write_status running "$ACTIVATE_PHASE" ""
if ! log_run "$LOGFILE" rebuild "$ACTIVATE"; then
  log_line "$LOGFILE" "$ACTIVATE failed once — retrying in 20s before rolling back"
  sleep 20
  if ! log_run "$LOGFILE" rebuild "$ACTIVATE"; then
    switch_error="$(errtail)"
    rollback
    fail "$ACTIVATE_PHASE" "$switch_error"
  fi
  log_line "$LOGFILE" "$ACTIVATE succeeded on retry (first failure was transient)"
fi

# --- push -----------------------------------------------------------------
# Only when this apply committed. site_commit already pushed the site commit
# if the branch has an upstream; this is the belt to that brace — best-effort,
# because the configuration checkout usually sits on a root dataset (no snapshots, not mirrored) so the
# remote is the only backup, but a network blip must not turn a successful
# rebuild into a reported failure.
write_status running pushing ""
if [ "$WANT_COMMIT" = "yes" ] && [ -n "$COMMIT_SHA" ]; then
  log_run "$LOGFILE" setpriv --reuid="$OPERATOR_USER" --regid="$OPERATOR_GROUP" --init-groups \
    env HOME="$OPERATOR_HOME" GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes" \
    git -C "$FLAKE" push ||
    log_line "$LOGFILE" "push failed (the switch succeeded; the commit is local only)"
fi

write_status "done" "$DONE_PHASE" ""
