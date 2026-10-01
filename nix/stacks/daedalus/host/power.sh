# Restart the box: the root helper's `reboot` verb (stacks/daedalus
# controller.nix, `root`). The helper starts this unit and streams what it
# prints; its outcome entry (host/lib.sh `outcome`) is the answer.
#
# There is deliberately no poweroff, halt or shutdown here, nor a verb for
# one in the helper's table: the operator's rule is that this machine is never
# turned OFF from a browser, because the way back on is physical and the
# browser is usually not in the house. A verb that does not exist is reachable
# neither by a mistake in the app nor by a compromised controller.
#
# `done` = the reboot is queued; `refuse` = refused, still exit 0 (so a
# refusal is not a failed unit); a non-zero exit = the agent itself broke. No replay guard:
# nothing starts this unit but the helper — no path unit re-fires it at boot.

set -euo pipefail

# A reboot in the middle of a `nixos-rebuild switch` is the one way this button
# can leave the box worse than it found it: the bootloader entry, the store
# paths and the activation script land at different moments, so a switch cut in
# half can boot a generation that was never finished being installed. The three
# checks are the same question asked of the three things that rebuild this
# system.
if systemctl is-active --quiet daedalus-apply.service; then
  refuse "an apply is running — rebooting mid-rebuild would leave a half-applied generation. Wait for it to finish."
fi

if pgrep -f nixos-rebuild >/dev/null 2>&1; then
  refuse "a nixos-rebuild is running on this box — rebooting mid-switch would leave a half-applied generation. Wait for it to finish."
fi

# fleet.rebuildLock, taken NON-blocking: held means somebody is rebuilding
# (flake-autoupgrade, an apply past its waiting phase, or a human who took it),
# and this is a request from someone watching a page — refused with a reason,
# not queued behind twenty minutes of silence. Held until this script exits,
# which is after the reboot job is queued: no rebuild starts in between.
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  refuse "another rebuild holds $LOCKFILE (flake-autoupgrade, or a manual nixos-rebuild) — try again when it finishes"
fi

verb_done "rebooting"
sync

# --no-block: this agent is itself a unit, and the shutdown transaction it asks
# for includes stopping it; waiting for that job would be waiting for its own
# SIGTERM.
systemctl --no-block reboot
