# Weekly flake upgrade — concatenated into a writeShellApplication wrapper in
# platform/autoupgrade/autoupgrade.nix.
#
# Required env (exported by the wrapper):
#   REBUILD_LOCK     — flock path serialising every rebuild (fleet.rebuildLock)
#   GITHUB_SSH_KEY   — decrypted deploy key (platform/git's github-key.sops)
#
# writeShellApplication already prepends `set -euo pipefail` and puts
# git/openssh/util-linux/coreutils on PATH.
#
# `nix` and `nixos-rebuild` are deliberately NOT on that PATH and are called by
# absolute path below — see the note at each call.

cd /etc/nixos

# The repo is santiago-owned and builds go through the nix daemon, so only
# `nixos-rebuild boot` needs root. Everything that touches .git runs as
# santiago, or the repo grows root-owned objects that a later `git` as
# santiago cannot write. setpriv, not sudo/runuser: no PAM session per call
# (same reasoning as stacks/apps' deploy).
as_santiago() {
  setpriv --reuid santiago --regid users --init-groups env HOME=/home/santiago "$@"
}

# Serialise against daedalus's apply (fleet.rebuildLock). Waits rather than
# failing: this is a weekly unattended job with no one watching, and an apply
# finishes in minutes. If it somehow cannot get the lock in 30 minutes, skip
# this run entirely — the timer is Persistent and next week's run carries the
# update forward, which is much better than rebuilding on top of someone
# else's half-applied change.
exec 9>"$REBUILD_LOCK"
if ! flock -w 1800 9; then
  echo "flake-autoupgrade: another rebuild holds $REBUILD_LOCK; skipping this run"
  exit 0
fi

# System nix, not pkgs.nix: the running nix honors /etc/gitconfig's
# safe.directory for the santiago-owned repo, and a mismatched pkgs.nix trips
# libgit2's ownership check and fails the unit.
as_santiago /run/current-system/sw/bin/nix flake update --commit-lock-file

# `boot`, not `switch`: stage the new generation for the next boot and leave
# the running system alone. Rebooting stays a manual decision.
/run/current-system/sw/bin/nixos-rebuild boot --flake /etc/nixos

# Offline must not fail the upgrade: the lock is already committed locally, so
# a failed push is swallowed and the next run carries it forward.
as_santiago env \
  GIT_SSH_COMMAND="ssh -i $GITHUB_SSH_KEY -o BatchMode=yes -o IdentitiesOnly=yes" \
  git push origin main ||
  echo "flake-autoupgrade: git push failed (offline?); lock committed locally, retrying next run"
