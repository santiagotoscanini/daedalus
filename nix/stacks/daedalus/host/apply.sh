# Apply a change to site/: write the files daedalus rendered, stage (and on the
# switch, commit) them, rebuild the system. Restore the bytes if the rebuild fails.
#
# Deliberately dumb. It does NOT generate, transform or validate the registry
# — daedalus renders the exact bytes (src/lib/registry-file.ts) and hands
# them over as the run's payload; this writes them verbatim. Every
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
# The container never runs any of this. It asks the root helper's `apply`
# verb (daedalus-verbs.nix) through the controller, with the rendered files
# as the payload; the helper hands that to this unit as its run file (host/lib.sh
# take_request), one run at a time. So the app holds no privilege it could
# lose: it chooses bytes, never a name — the names written are MANAGED, below,
# fixed here — and root reads nothing the container wrote into a directory.
# The status and the log are root's, in $VERBS_DIR, which the container reads
# and cannot write. The previous bytes a rollback trusts are in $PREV_DIR,
# which the container cannot reach either (host/site-lib.sh).

set -euo pipefail

STATUS="$VERBS_DIR/apply-status.json"
LOGFILE="$VERBS_DIR/apply-last.log"

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

# The run (host/lib.sh run_id, run_payload): its id, which the status carries
# and the page waits on, and the payload — the files the app rendered and
# what to record — copied once into a root-private file that every step below
# works from, so nothing can change the bytes between validating them and
# committing them.
REQ_ID="$(run_id)" || exit 1
STARTED_AT="$(date -Is)"
PAYLOAD_COPY="$(mktemp)"
trap 'rm -f "$PAYLOAD_COPY"' EXIT
run_payload >"$PAYLOAD_COPY"
REQ_JSON="$(jq -c 'del(.files)' "$PAYLOAD_COPY")"

COMMIT_SHA=""

# --- serialise against every other rebuild --------------------------------
# One lock for anything that rebuilds this system or commits to the configuration repo.
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
# And the site directory's own lock (host/site-lib.sh site_lock), which a
# secret write holds for seconds.
if ! site_lock 120; then
  fail waiting "a secret write held $SITE_LOCK for 2 minutes. Nothing was changed."
fi

write_status running validating ""

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
jq -e '.files | type == "object"' "$PAYLOAD_COPY" >/dev/null 2>&1 || fail writing "the payload carries no map of files"
# The vault entries are ciphertext the app encrypted in its container
# (Settings › Integrations); this script copies bytes and never sees a value.
# README.md (rendered from site.json) and daedalus.json (the provenance stamp)
# ride every Apply; they are LAST so the order of WRITTEN still reads
# site.json-before-vault for the subject below, which drops both anyway.
#
# $VAULT_APP_SECRETS is the per-app half: `vault/apps/<name>-env.sops`, the
# operator-supplied environment of a platform app (modules/apps —
# operator-secrets-lib.nix turns a tracked one into that app's env file). It is
# a LIST, not a pattern, and Nix builds it from the committed registry into
# this script's wrapper — so the names are still fixed host-side, which is the
# only property that matters here: a name taken from the request would be a
# path traversal with extra steps, and `jq -r '.files | keys'` would be exactly
# that. An app the box does not know about therefore has no writable path at
# all, and a payload naming one is skipped like any other unmanaged key.
# It goes after the vault root entries and before README.md, so both
# orderings the subject below relies on still hold.
MANAGED=(apps.json nodes.json site.json vault/cloudflare-api-token.sops vault/github-app.sops "${VAULT_APP_SECRETS[@]}" README.md daedalus.json)
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
[ "${#WRITTEN[@]}" -gt 0 ] || fail writing "the payload carries none of ${MANAGED[*]}"

# --- the engine override --------------------------------------------------
# site.json's `developer.engineOverride` (host/lib.sh site_engine_override):
# build from the engine clone on this box (ENGINE_CLONE, nix's own fact —
# never a path from the document) instead of the pinned input.
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
  if [ ! -f "$ENGINE_CLONE/flake.nix" ] || [ -L "$ENGINE_CLONE" ]; then
    for w in "${WRITTEN[@]}"; do site_restore "$w"; done
    fail writing "the engine override is on, but $ENGINE_CLONE holds no engine clone (no flake.nix). Nothing was rebuilt; the written files were put back."
  fi
  REBUILD_FLAGS=(--override-input daedalus "path:$ENGINE_CLONE" --no-write-lock-file)
  ACTIVATE="test"
fi

# `build`, or the activation, with the override's flags when there is one.
rebuild() {
  nixos-rebuild "$1" --flake "$FLAKE#$HOSTNAME" "${REBUILD_FLAGS[@]}"
}

# --- stage ----------------------------------------------------------------
# A flake only sees git-tracked files, so staging is not bookkeeping — an
# unstaged new file is invisible to the rebuild below.
write_status running committing ""
site_stage "${WRITTEN[@]}" || fail committing "git add failed"

WRITTEN_PATHS=()
for w in "${WRITTEN[@]}"; do WRITTEN_PATHS+=("$SITE_DIR/$w"); done
if [ -n "$(site_toplevel)" ] && git_op "$SITE_DIR" diff --quiet HEAD -- "${WRITTEN_PATHS[@]}" 2>/dev/null; then
  write_status "done" "no-change" ""
  exit 0
fi

# --- build ----------------------------------------------------------------
# `build` first, before anything is committed: it catches eval errors and
# build failures without touching the running system, which is the
# difference between a rejected change and a broken box. A malformed
# registry dies here — and then only the written files are put back. Nothing
# was activated and nothing committed, so there is nothing to switch back
# to; a switch here would only activate whatever else is uncommitted in the
# checkout.
#
# The log lives in the container's directory, so it is emptied and appended
# as the operator (log_reset / log_run in host/lib.sh) — born theirs, no chown
# by name afterwards.
write_status running building ""
log_reset "$LOGFILE"
if ! log_run "$LOGFILE" rebuild build; then
  build_error="$(errtail)"
  for w in "${WRITTEN[@]}"; do site_restore "$w"; done
  fail building "$build_error"
fi

# --- commit, if asked -----------------------------------------------------
# Committing is the operator's switch, carried in the request; when it is on,
# the commit names exactly the files this run wrote, because this index is
# shared with a person (a bare commit once swept a human's staged work into
# an "apps:" commit and pushed it).
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
# README.md and daedalus.json are dropped first. Both ride EVERY Apply and
# name nothing that changed, so leaving them in would make every subject read
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
  case "$w" in README.md | daedalus.json) ;; *) SUBJECT+=("$w") ;; esac
done
case "${SUBJECT[*]}" in
apps.json) PREFIX=apps ;;
nodes.json) PREFIX=nodes ;;
site.json) PREFIX=site ;;
vault/*) PREFIX=vault ;;
"site.json vault/"*)
  if [ "${#SUBJECT[@]}" -eq 2 ]; then PREFIX=vault; else PREFIX=apply; fi
  ;;
*) PREFIX=apply ;;
esac
if [ "$WANT_COMMIT" = "yes" ]; then
  COMMIT_SHA="$(site_commit "$PREFIX: $SUMMARY" "$ACTOR" "${WRITTEN[@]}")" || fail committing "git commit failed"
fi

# --- roll back ------------------------------------------------------------
# For an activation that failed: put the previous bytes of every file this
# run wrote back, re-stage, commit the restore if we committed, and put the
# running system back on the result. Bytes, not `git revert`: the same
# mechanism whether or not the directory is versioned or the switch is on,
# and it cannot eat a commit somebody else made meanwhile — it touches only
# what it wrote.
rollback() {
  local f
  for f in "${WRITTEN[@]}"; do site_restore "$f"; done
  if [ "$WANT_COMMIT" = "yes" ] && [ -n "$COMMIT_SHA" ]; then
    log_run "$LOGFILE" site_commit "$PREFIX: revert — $SUMMARY (the rebuild failed)" "$ACTOR" "${WRITTEN[@]}" ||
      log_line "$LOGFILE" "the restore is in the tree but could not be committed — commit it by hand"
  fi
  # The same activation as the run: under an override that is `test` again,
  # so a failed tested Apply is undone the way it was done.
  log_run "$LOGFILE" rebuild "$ACTIVATE" || true
  COMMIT_SHA=""
}

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
#
# Unless the build is a reboot-level change (host/lib.sh, the live-switch
# guard): then nothing is activated, the commit stands — it is the operator's
# change, and it is valid, it built — and the run ends `done` /
# `reboot-required` with the reasons and the command that installs it for the
# next boot. Not a failure, so nothing is rolled back.
REBOOT_REASONS=""
if REBOOT_REASONS="$(reboot_required "$LOGFILE")"; then
  log_line "$LOGFILE" "$REBOOT_REASONS"
else
  REBOOT_REASONS=""
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
fi

# --- push -----------------------------------------------------------------
# Only when this apply committed. site_commit already pushed the site commit
# if the branch has an upstream; this is the belt to that brace — best-effort,
# because the configuration checkout usually sits on a root dataset (no snapshots, not mirrored) so the
# remote is the only backup, but a network blip must not turn a successful
# rebuild into a reported failure.
write_status running pushing ""
if [ "$WANT_COMMIT" = "yes" ] && [ -n "$COMMIT_SHA" ]; then
  log_run "$LOGFILE" git_op "$FLAKE" push ||
    log_line "$LOGFILE" "push failed (the switch succeeded; the commit is local only)"
fi

if [ -n "$REBOOT_REASONS" ]; then
  write_status "done" "reboot-required" \
    "$(reboot_note "$REBOOT_REASONS" "Nothing was activated; the change is committed and built.")"
  exit 0
fi
write_status "done" "$DONE_PHASE" ""
