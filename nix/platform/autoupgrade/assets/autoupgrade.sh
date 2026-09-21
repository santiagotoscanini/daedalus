# Weekly flake upgrade — concatenated into a writeShellApplication wrapper in
# platform/autoupgrade/autoupgrade.nix.
#
# Required env (exported by the wrapper):
#   REBUILD_LOCK     — flock path serialising every rebuild (fleet.rebuildLock)
#   GITHUB_SSH_KEY   — decrypted deploy key (platform/git, fleet.git.sshKeySopsFile)
#   FLAKE            — the configuration checkout (fleet.config.repo)
#   HOSTNAME         — the nixosConfigurations attribute to build (networking.hostName)
#   UPGRADE_INPUTS   — which inputs to move, space-separated; empty = all
#   OPERATOR_USER, OPERATOR_GROUP, OPERATOR_HOME
#                    — who owns that checkout, and so who every git call runs as
#
# writeShellApplication already prepends `set -euo pipefail` and puts
# git/openssh/util-linux/coreutils on PATH.
#
# `nix` and `nixos-rebuild` are deliberately NOT on that PATH and are called by
# absolute path below — see the note at each call.

cd "$FLAKE"

# The repo is operator-owned and builds go through the nix daemon, so only
# `nixos-rebuild boot` needs root. Everything that touches .git runs as
# the operator, or the repo grows root-owned objects that a later `git` as
# the operator cannot write. setpriv, not sudo/runuser: no PAM session per call
# (same reasoning as stacks/apps' deploy).
as_operator() {
  setpriv --reuid "$OPERATOR_USER" --regid "$OPERATOR_GROUP" --init-groups env HOME="$OPERATOR_HOME" "$@"
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

# A tree someone left dirty is not this job's to build on: the lock it
# restores on failure, and the commit it makes on success, both assume
# flake.lock was clean when it started.
if ! as_operator git diff --quiet -- flake.lock; then
  echo "flake-autoupgrade: flake.lock has uncommitted changes; skipping this run"
  exit 0
fi

# System nix, not pkgs.nix: the running nix honors /etc/gitconfig's
# safe.directory for the operator-owned repo, and a mismatched pkgs.nix trips
# libgit2's ownership check and fails the unit.
#
# Update WITHOUT committing. On 2026-09-21 this committed first and built
# second: a sops-nix bump needed a newer Go than the stable channel builds
# with, the build failed, and HEAD sat unbuildable until a person noticed —
# every rebuild on the box, daedalus's Apply included, would have failed on a
# lock nobody chose. A lock is only worth committing once it has built.
# UPGRADE_INPUTS unquoted on purpose: a space-separated list of input names
# (fleet.autoupgrade.inputs), empty meaning every input.
# shellcheck disable=SC2086
as_operator /run/current-system/sw/bin/nix flake update $UPGRADE_INPUTS

if as_operator git diff --quiet -- flake.lock; then
  echo "flake-autoupgrade: inputs unchanged; nothing to do"
  exit 0
fi

# Build the candidate from the dirty tree. `nix build`, not `nixos-rebuild
# boot`: nothing is staged until the lock is committed, so the generation
# that does get staged carries a real configurationRevision.
if ! as_operator /run/current-system/sw/bin/nix build --no-link \
  "$FLAKE#nixosConfigurations.\"$HOSTNAME\".config.system.build.toplevel"; then
  echo "flake-autoupgrade: the updated lock does not build; restoring the old one" >&2
  as_operator git checkout -- flake.lock
  exit 1
fi

as_operator git commit -m "flake.lock: Update" -- flake.lock

# `boot`, not `switch`: stage the new generation for the next boot and leave
# the running system alone. Rebooting stays a manual decision. Everything but
# the revision stamp is already in the store from the build above.
/run/current-system/sw/bin/nixos-rebuild boot --flake "$FLAKE"

# Offline must not fail the upgrade: the lock is already committed locally, so
# a failed push is swallowed and the next run carries it forward.
as_operator env \
  GIT_SSH_COMMAND="ssh -i $GITHUB_SSH_KEY -o BatchMode=yes -o IdentitiesOnly=yes" \
  git push origin main ||
  echo "flake-autoupgrade: git push failed (offline?); lock committed locally, retrying next run"
