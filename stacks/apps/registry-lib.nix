# The ONE mapper from a registry entry to a `fleet.apps.<name>` value.
#
# Two readers consume the registry schema: declarations.nix (every app in
# ./apps.json) and stacks/daedalus/daedalus.nix (its own entry, from
# ./self.json — hand-tracked, so an Apply that broke it can't take down the
# UI you'd use to undo it). As two copies of the field mapping they would
# drift the first time the schema grows a field — one reader learns it, the
# other silently drops it. So the mapping lives here, once, next to the list
# of schema versions it understands.
#
# A `*-lib.nix` file: EXCLUDED from configuration.nix's auto-import (same
# convention as platform/gluetun-lib.nix), imported by path from the two
# readers. It is pure JSON→attrset — no config reads, which is what lets
# daedalus.nix use it without the fleet.apps self-reference loop its header
# warns about.
#
# NOT in here: `environmentFiles`. Operator secrets are keyed by the presence
# of a tracked `<name>-env.sops` beside declarations.nix and resolve through
# `config.sops.secrets` — a config read, and specific to registry apps.
# declarations.nix layers that on; daedalus binds its own rendered env files.

{ lib }:

{
  # Grown in lockstep with the writer (stacks/daedalus/app,
  # REGISTRY_SCHEMA_VERSION): the reader learns a version FIRST, the writer
  # flips after the reader is live — the other order builds a system that
  # cannot eval its own committed registry.
  acceptedSchemaVersions = [ 1 ];

  # JSON → the `fleet.apps.<name>` submodule. Every field is emitted
  # unconditionally where the option's default matches the exported value, so
  # the mapping stays uniform; only genuinely optional shapes (image override,
  # egress, auth paths) are conditional, because setting them to null is not
  # the same as leaving them unset.
  mkApp =
    a:
    {
      inherit (a) stage;

      postgres.enable = a.postgres;
      storage.enable = a.storage;
      litellm.enable = a.litellm;
      prometheus.enable = a.prometheus;

      auth = {
        inherit (a.auth) mode;
      }
      // lib.optionalAttrs (a.auth.healthPath or null != null) {
        inherit (a.auth) healthPath;
      }
      // lib.optionalAttrs (a.auth.allowedGroups or null != null) {
        inherit (a.auth) allowedGroups;
      }
      // lib.optionalAttrs (a.auth.bypassRule or null != null) {
        authBypassRule = a.auth.bypassRule;
      }
      // lib.optionalAttrs (a.auth.isolated or false) {
        inherit (a.auth) isolated;
      };

      presentation = {
        inherit (a.presentation) description;
      };

      # cgroup caps. Read with `or` defaults so an apps.json predating this
      # field still evaluates — the file is under git and a revert of it alone
      # is a legitimate recovery move.
      resources = {
        cpus = a.resources.cpus or null;
        memoryMb = a.resources.memoryMb or null;
        pids = a.resources.pids or null;
      };

      # `env` is a LIST of {key, value, note} rather than an attrset: the note is
      # the reason a flag is set the way it is, which used to live in a nix
      # comment here and would otherwise be lost in the round-trip through the
      # database. daedalus renders them next to the value; nix only needs the pair.
      env = lib.listToAttrs (map (e: lib.nameValuePair e.key e.value) a.env);
    }
    // lib.optionalAttrs (a.hostname or null != null) {
      inherit (a) hostname;
    }
    // lib.optionalAttrs (a.image != null) {
      inherit (a) image;
    }
    // lib.optionalAttrs (a.egress != null) {
      egress = {
        inherit (a.egress) container hostPort;
      };
    };
}
