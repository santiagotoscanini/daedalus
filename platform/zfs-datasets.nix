# Declarative s2-pool child datasets.
#
# Single source of truth for the per-stack datasets on s2-pool. Adding
# a new dataset is a one-line change in `s2Children` below; this module
# emits both the `fileSystems."/s2/<name>"` mount entry and a systemd
# oneshot that creates the dataset (`zfs create -o mountpoint=legacy`)
# before the corresponding `.mount` unit runs. Idempotent — re-running
# on an existing dataset is a no-op.
#
# Why this exists: previously each dataset was created imperatively
# (`sudo zfs create ...`) at install time. A fresh-install recovery
# would silently skip dataset creation, and the next boot would fail
# on the mount unit. With this module, `nixos-rebuild switch` on a
# fresh import-only `s2-pool` materializes every missing child.
#
# Properties (recordsize, compression, atime) inherit from the pool
# defaults — `lz4` compression, `128K` recordsize, `atime=on`. If a
# dataset needs different properties, set them in this module with
# additional `-o` flags in the ExecStart loop. Existing datasets are
# NOT touched by this script (idempotency); apply property changes
# imperatively with `zfs set` if you need to retune.
#
# What this does NOT do: the root pool dataset `s2-pool` itself (which
# mounts at `/s2`) — that's created by `zpool create` at install time,
# not by `zfs create`, so configuration.nix still owns the
# `fileSystems."/s2"` entry for the pool root.

{ config, lib, pkgs, utils, ... }:

let
  # Children of s2-pool. Each entry creates:
  #   - dataset s2-pool/<name>
  #   - mount  /s2/<name> (fileSystems entry)
  #   - systemd ordering: ensure-s2-datasets.service runs before the
  #     corresponding /s2/<name>.mount unit.
  s2Children = [
    "santi"
    "sofi"
    "shared"
    "tv"
    "immich"
    "supabase-storage"
  ];

  mountUnit = name: "${utils.escapeSystemdPath "/s2/${name}"}.mount";
in
{
  # Auto-emit fileSystems entries — keeps the dataset registry above
  # as the single source of truth (no need to also edit configuration.nix
  # when adding a new dataset).
  fileSystems = lib.listToAttrs (map
    (name: lib.nameValuePair "/s2/${name}" {
      device = "s2-pool/${name}";
      fsType = "zfs";
    })
    s2Children);

  systemd.services.ensure-s2-datasets = {
    description = "Create missing s2-pool/* datasets (idempotent)";
    after = [ "zfs-import-s2-pool.service" ];
    wants = [ "zfs-import-s2-pool.service" ];
    # The .mount units are created by systemd-fstab-generator from the
    # fileSystems block above. Run before each one so any missing
    # dataset is created before mount(8) tries to mount it.
    before = map mountUnit s2Children;
    # requiredBy makes the mount units pull us in transitively — fresh
    # installs that only declare the mounts (and forget to enable
    # ensure-s2-datasets in some target) still get the bootstrap.
    requiredBy = map mountUnit s2Children;
    unitConfig.DefaultDependencies = false;
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = pkgs.writeShellScript "ensure-s2-datasets" ''
        set -eu
        ZFS=${pkgs.zfs}/bin/zfs
        ${lib.concatMapStringsSep "\n" (name: ''
          ds="s2-pool/${name}"
          if ! $ZFS list -H -o name "$ds" >/dev/null 2>&1; then
            echo "Creating $ds..."
            $ZFS create -o mountpoint=legacy "$ds"
          fi
        '') s2Children}
      '';
    };
  };
}
