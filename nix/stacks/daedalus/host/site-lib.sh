# Shared helpers for writing into the site directory — the one directory
# daedalus owns inside the operator's configuration repository. Inlined by the
# apply and secret-set wrappers after lib.sh; expects SITE_DIR,
# PREV_DIR, OPERATOR_USER, OPERATOR_GROUP, OPERATOR_HOME, SETPRIV, ENV_BIN,
# GIT, GIT_EMAIL and SITE_LOCK in the environment, and GIT_OPERATOR_NAME / GIT_OPERATOR_EMAIL
# for lib.sh's commit_name / commit_email.
#
# Source control is the operator's business, with one exception this code
# cannot delegate: a flake sees only git-TRACKED files. A file written here
# but never `git add`ed fails the very rebuild it was written for ("file not
# found"), so when $SITE_DIR sits inside a work tree, what is written is
# always staged. COMMITTING is the operator's switch, carried in each request
# (`commit: true|false`) so this code stays dumb about preferences.
#
# Rollback does not depend on git. Every write first keeps the previous bytes
# under $PREV_DIR (outside the tree, so a restore never shows up as untracked
# noise), and a caller that needs to undo restores them and re-stages. One
# mechanism whether or not the directory is versioned.
#
# ⚠ $PREV_DIR is NOT $APPLY_DIR, and must never become it. Rollback state is
# something this code later TRUSTS for a decision — "was this file absent, so
# delete it" or "put these bytes back" — and a rollback commits and pushes
# whatever that decision produced. It used to live in the rw-mounted apply
# directory, where the container could send an Apply that fails the build and
# then plant `prev-apps.json.absent` (or rewrite `prev-apps.json`) before the
# rollback read it: the rollback then deleted or replaced site/apps.json, or a
# vault file, and pushed the result. $PREV_DIR is a sibling of apply/ that the
# container does not mount (stacks/daedalus/daedalus.nix), owned by the
# operator at 0700. Every operation in it still runs as the operator and
# refuses links — nothing should be able to plant one there, and nothing
# here assumes that.

# The work tree $SITE_DIR belongs to, or "" when it is a plain directory.
site_toplevel() {
  [ -d "$SITE_DIR" ] || return 0
  git_op "$SITE_DIR" rev-parse --show-toplevel 2>/dev/null || true
}

# Where the previous bytes of site file $1 are kept. A name may carry a
# directory (`vault/<secret>.sops`); it is flattened so $PREV_DIR needs no
# tree of its own.
site_prev() {
  printf '%s/%s' "$PREV_DIR" "${1//\//__}"
}

# Copy $1 (read as the operator, never through a link) to $2 (published as
# the operator with mode $3, default 0644). Through a root-private temp, NEVER
# a pipe: across a pipe the publisher cannot tell a failed read from an empty
# file and publishes the empty bytes — which turned a restore that could not
# read its backup into a restore that truncated the file it was restoring.
# Seen in testing.
site_copy() {
  local from="$1" to="$2" mode="${3:-0644}" buf rc=0
  buf="$(mktemp)" || return 1
  if read_as_operator "$from" >"$buf"; then
    as_operator_fn op_publish "$to" "$mode" bytes <"$buf" || rc=1
  else
    rc=1
  fi
  rm -f "$buf"
  return "$rc"
}

# Make sure $PREV_DIR is a directory the operator can use, and not a link.
# stacks/daedalus declares it (fleet.statePaths, 0700, re-enforced at every
# boot); the mkdir only covers a run that beats state-paths.service to it, and
# is a no-op otherwise.
site_prev_dir() {
  if [ -L "$PREV_DIR" ]; then
    echo "site: refusing $PREV_DIR: it is a symlink, and rollback state is only kept in a real directory" >&2
    return 1
  fi
  as_operator mkdir -p -m 0700 -- "$PREV_DIR"
}

# Keep what $SITE_DIR/$1 holds now, so site_restore can put it back.
#
# Every step runs as the operator (lib.sh's rule). This used to be root's
# `install -o`, which copies by name and then chowns and chmods by name — each
# of those a call a planted link could redirect. op_publish creates the file
# already theirs, with the mode from the umask, through a temp and a rename.
#
# A caller records a file as written ONLY after this returned 0 for it. A
# failure here — anywhere, including half way — means this run has nothing
# of its own to restore for that file, and whatever $PREV_DIR holds for it
# belongs to an earlier run: restoring it would put back stale bytes.
#
# Returns non-zero on any failure instead of relying on errexit: callers run
# it in a `||` to report the failure, and errexit is off inside such a call.
site_backup() {
  local name="$1" prev
  prev="$(site_prev "$name")"
  site_prev_dir || return 1
  if [ -f "$SITE_DIR/$name" ]; then
    site_copy "$SITE_DIR/$name" "$prev" 0600 || return 1
    # The marker from a FIRST write must not outlive it: left behind, a later
    # restore would delete the file instead of putting the old bytes back.
    as_operator rm -f -- "$prev.absent" || return 1
  else
    as_operator rm -f -- "$prev" || return 1
    as_operator_fn op_publish "$prev.absent" 0600 bytes </dev/null || return 1
  fi
}

# Write $2 (a file of bytes) as $SITE_DIR/$1, as the operator. Call only
# after site_backup succeeded for the same name.
#
# $2 is opened by the caller's root shell, which is safe because callers make
# it with mktemp in root's own /tmp; the copy is what crosses over. A
# directory in the name is created as the operator.
site_put() {
  local name="$1" src="$2"
  as_operator mkdir -p -m 0755 -- "$SITE_DIR" "$(dirname "$SITE_DIR/$name")" || return 1
  as_operator_fn op_publish "$SITE_DIR/$name" 0644 bytes <"$src"
}

# Put back what site_put replaced, and re-stage if versioned.
#
# The previous bytes come back out of $PREV_DIR, read as the operator and
# never through a link. Best-effort per file: this runs inside a rollback, and
# one file that cannot be restored must not abandon the rest of it, or the
# rebuild back.
site_restore() {
  local name="$1" prev
  prev="$(site_prev "$name")"
  if [ -L "$PREV_DIR" ] || [ -L "$prev" ] || [ -L "$prev.absent" ]; then
    echo "site: refusing to restore $SITE_DIR/$name — its rollback state under $PREV_DIR is a symlink; restore it by hand" >&2
  elif [ -f "$prev.absent" ]; then
    as_operator rm -f -- "$SITE_DIR/$name" "$prev.absent" ||
      echo "site: could not remove $SITE_DIR/$name — remove it by hand" >&2
  elif [ -f "$prev" ]; then
    site_copy "$prev" "$SITE_DIR/$name" ||
      echo "site: could not restore $SITE_DIR/$name from $prev — restore it by hand" >&2
  else
    echo "site: no rollback state for $SITE_DIR/$name under $PREV_DIR — check it by hand" >&2
  fi
  if [ -n "$(site_toplevel)" ]; then
    git_op "$SITE_DIR" add -A -- "$SITE_DIR/$name" >/dev/null 2>&1 || true
  fi
}

# Stage the named files. Mandatory when versioned — see the header.
site_stage() {
  [ -n "$(site_toplevel)" ] || return 0
  local f
  for f in "$@"; do
    git_op "$SITE_DIR" add -- "$SITE_DIR/$f"
  done
}

# Commit the named site files ($3…), and nothing else. The index and the work
# tree are shared with a person and with the other agents that write here: a
# commit of everything under $SITE_DIR swept an uncommitted Apply's
# apps.json into a secret's commit and pushed it. Of the named files, only
# those with a staged change are committed; prints the short hash, or
# nothing when none had one. Push is best-effort and only when an upstream
# exists.
site_commit() {
  local summary="$1" actor="$2" top f
  shift 2
  top="$(site_toplevel)"
  [ -n "$top" ] || return 0
  local -a paths=() changed=()
  for f in "$@"; do paths+=("$SITE_DIR/$f"); done
  [ "${#paths[@]}" -gt 0 ] || return 0
  # Toplevel-relative names, committed from the toplevel: the pathspec then
  # names only what git knows, so a file that was added and removed again
  # cannot fail the commit.
  mapfile -t changed < <(git_op "$SITE_DIR" diff --cached --name-only -- "${paths[@]}")
  [ "${#changed[@]}" -gt 0 ] || return 0
  git_op "$top" -c "user.name=$(commit_name)" -c "user.email=$(commit_email)" \
    commit -q -m "$summary" -m "Applied from daedalus by $actor." -- "${changed[@]}"
  git_op "$SITE_DIR" rev-parse --short HEAD
  if git_op "$SITE_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
    git_op "$SITE_DIR" push -q >/dev/null 2>&1 || echo "site: push failed (the commit is local only)" >&2
  fi
}

# One writer in the site directory at a time. Apply and secret-set both keep
# previous bytes in $PREV_DIR under the same names, stage, commit and
# restore; interleaved, one's rollback would put back the other's bytes or
# commit them. Taken on fd 7 and held until exit. $SITE_LOCK is under
# /run/lock, which only root can write, and both agents run as root. $1 is
# how many seconds to wait.
site_lock() {
  exec 7>"$SITE_LOCK"
  flock -w "$1" 7
}
