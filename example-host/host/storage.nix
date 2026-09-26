# What this box stores, and where.
#
# Container state lives under `fleet.stateRoot` (`<operator home>/selfhost`)
# without being named here. What a host names is the bulk data OUTSIDE it —
# media, photos, anything large enough to live on a different pool — one
# absolute path per name, which a module reads as `fleet.data.<name>`. `{ }`
# is a valid answer until an enabled module asks for a name.
#
# ZFS is optional: the engine enables the tooling, and a host that keeps a
# dataset table here gets it converged (`fleet.zfs.datasets`), snapshotted and
# mirrored (`fleet.backup.replications`) — see the engine's platform/zfs.nix
# and platform/backup.nix. A host on ext4 leaves both unset.
_: {
  fleet.data = { };
}
