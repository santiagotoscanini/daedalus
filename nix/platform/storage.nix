# Bulk data roots — where the large things live, by name.
#
# Two kinds of storage back a stack, and they are deliberately different
# places. STATE is `fleet.stateRoot`: small, hot, snapshotted every 15
# minutes and mirrored to a second pool — configs, SQLite files, databases.
# DATA is this: large, cold, on the big pool, snapshotted slowly or not at
# all — a media library, a photo archive, a game's backup tarballs.
#
# DECLARED here with NO defaults, DEFINED by the host (this box:
# host/storage.nix). A stack reads `config.fleet.data.<name>` and builds its
# sub-paths from it; it never spells a mountpoint. A stack that reads a name
# the host did not define fails evaluation on the missing attribute, which
# is the right failure — there is no sensible default for where a terabyte
# goes.
#
# Nothing here mounts anything. A root that is a ZFS dataset gets its mount
# from `fleet.zfs.datasets`; the container units pick up RequiresMountsFor
# from their volume strings (platform/podman.nix) either way.
{ lib, ... }:

{
  options.fleet.data = lib.mkOption {
    type = lib.types.attrsOf lib.types.str;
    example = lib.literalExpression ''
      {
        tv = "/tank/tv";
        photos = "/tank/photos";
      }
    '';
    description = ''
      Name → absolute path of a bulk-data root that lives outside
      `fleet.stateRoot`. The names are the contract between a stack and the
      host (`tv`, `books`, `photos`, `minecraft`, `shared`); the paths are the
      host's business.
    '';
  };
}
