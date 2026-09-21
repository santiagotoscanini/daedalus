# The ONE mapper from a registry entry to a `fleet.apps.<name>` value.
#
# Two readers consume the registry schema: declarations.nix (every app in
# site/apps.json, via fleet.registry.file) and stacks/daedalus/daedalus.nix (its own entry, from
# ./self.json — hand-tracked, so an Apply that broke it can't take down the
# UI you'd use to undo it). As two copies of the field mapping they would
# drift the first time the schema grows a field — one reader learns it, the
# other silently drops it. So the mapping lives here, once, next to the list
# of schema versions it understands.
#
# A `*-lib.nix` file: never listed in configuration.nix's imports (same
# convention as its neighbour gluetun-lib.nix), imported by path from the two
# readers. It is pure JSON→attrset — no config reads, which is what lets
# daedalus.nix use it without the fleet.apps self-reference loop its header
# warns about.
#
# NOT in here: `environmentFiles`. Operator secrets are keyed by the presence
# of a tracked `site/vault/apps/<name>-env.sops` and resolve through
# `config.sops.secrets` — a config read, and specific to registry apps.
# declarations.nix layers that on; daedalus binds its own rendered env files.

{ lib }:

{
  # Kept in lockstep with the writer (the daedalus app,
  # REGISTRY_SCHEMA_VERSION in ~operator/projects/daedalus/app): ONE version,
  # not a range. The writer is bind-mounted from the operator's own clone on
  # this same box, so a version flip is still one person changing both sides
  # on one machine in one sitting — two commits now that the repos are
  # separate, but one act (writer + reader + a regenerated apps.json), never
  # a migration window. The day the app ships as a published image to other
  # boxes (plan Phase 12) the writer moves independently of any one reader
  # and this becomes a RANGE. A list only so the assertion message can print
  # it.
  #
  # v2 added `deploy: { enable }` per entry — the freeze switch.
  acceptedSchemaVersions = [ 2 ];

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

      # Scheduled tasks. Same `or` default as `resources`, for the same
      # reason: an apps.json predating the field still evaluates, and a
      # revert of that file alone stays a legitimate recovery move. The
      # per-field shapes (id charset, unique ids, non-empty command,
      # positive timeout) are asserted in apps.nix, where the message can
      # name the app; `timeoutSec` is left to the option's own default when
      # the entry omits it.
      tasks = a.tasks or [ ];

      # `env` is a LIST of {key, value, note} rather than an attrset: the note is
      # the reason a flag is set the way it is, which used to live in a nix
      # comment here and would otherwise be lost in the round-trip through the
      # database. daedalus renders them next to the value; nix only needs the pair.
      env = lib.listToAttrs (map (e: lib.nameValuePair e.key e.value) a.env);
    }
    # Emitted ONLY when the entry carries it: the option's default is
    # `source.mode == "registry"`, so writing `true` unconditionally would
    # turn the deploy machinery on for a local-source entry (daedalus's
    # self.json, which carries no `deploy` key), and there is no registry
    # image to poll there.
    // lib.optionalAttrs (a ? deploy) {
      deploy.enable = a.deploy.enable or true;
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
