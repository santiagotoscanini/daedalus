# Per-app declarations — READ FROM ./apps.json, not written by hand.
#
# The authoritative copy of this data lives in daedalus's `apps` table
# (stacks/daedalus). daedalus's Apply flow exports it to ./apps.json, commits
# that file, and rebuilds; this module turns the JSON back into `fleet.apps`
# entries, which the apps platform (stacks/apps/apps.nix) composes into
# container + traefik + observability + (optionally) postgres.
#
# Why a file and not a database query: nix eval is pure and a flake only sees
# git-tracked files, so nixos-rebuild cannot reach Postgres — and must not need
# to. A committed export keeps "the repo IS the system" true: a fresh checkout
# rebuilds this exact box with no database in the loop. The DB is the editing
# surface; this file is the contract.
#
# To change an app: use daedalus (https://daedalus.toscanini.me), then Apply.
# Editing apps.json directly works for one rebuild but daedalus will report the
# app as drifted, and the next Apply overwrites it.
#
# NOT in here: `source.mode = "local"` apps, which carry source and a
# Containerfile alongside their declaration and so own a stack folder of their
# own. stacks/daedalus is the only one — deliberately hand-written, so a bad
# edit to daedalus's own entry can't take down the app you'd use to fix it.
#
# Defaults still inferred from the app's key by stacks/apps/apps.nix:
#   image     = registry.toscanini.me/<name>:latest (the box's own zot)
#   hostname  = <name>.toscanini.me
#   container = app-<name>
#
# Workflow for a NEW app, all of it from Apps -> Add an app in daedalus:
#   1. Push the code to github.com/santiagotoscanini/<name>, with the ci/image
#      workflows copied from an existing app.
#   2. Pick the repo. The page checks it: workflows present, one of them pushes
#      to zot:5000 and can be dispatched, no `services:`/`container:` job (our
#      runners have no Docker API), every `secrets.*` the YAML reads exists,
#      and whether the image is in the registry yet.
#   3. `Set it` on REGISTRY_PASSWORD — the host writes the registry's ci
#      password into the repo's Actions secrets; it never enters the container.
#   4. `Run CI`. For a repo that is not an app yet this also starts a one-shot
#      `gha-runner-bootstrap@<repo>`, because the runner set IS fleet.apps and
#      the publishing workflow is `runs-on: self-hosted` pushing to zot over
#      registry-net — no hosted runner can do it, so the first image can only
#      be built by a runner this box lends the repo.
#   5. Create the entry, then Apply.
#
# The order is load-bearing, and the image check blocks for a reason: a
# declaration whose image does not exist makes `podman run` fail, which makes
# switch-to-configuration exit 4, which makes daedalus's apply revert its own
# commit. Declaring an app that cannot start is not a slow failure, it is a
# self-undoing one.
#
# Nothing in the create path writes code or workflows to GitHub. The two
# writes it can make are a repo secret whose value this box owns, and a
# workflow dispatch.
#
# Auth, operator secrets and VPN egress are NOT part of creating an app. Each
# needs state authored in this repo first — `SSO_SECRET_<NAME>` in
# stacks/pocket-id/clients.sops, a tracked <name>-env.sops, or a gluetun
# instance — after which the flag is editable like any other.
#
# From then on, every push to main goes live on its own: `app-<name>-deploy.timer`
# polls the registry every 2 minutes, and when the digest moves it pulls,
# restarts the container, and health-checks it through traefik. Watch a deploy
# with `journalctl -fu app-<name>-deploy.service`; a deploy that comes back
# unhealthy leaves the unit failed (and the new image running — there is no
# auto-rollback). See stacks/apps/apps.nix + assets/deploy.sh.

{
  config,
  lib,
  mkDotenvSecret,
  ...
}:

let
  registry = builtins.fromJSON (builtins.readFile ./apps.json);

  inherit (registry) apps;

  # Operator-managed secrets are a per-app sops file at this stack's root,
  # `<name>-env.sops` (tracked, edited with `sops <file>`). The registry
  # carries only the boolean — the path is derived, so the two can never
  # disagree and a future Apply that enables secrets for an app has exactly
  # one filename to write.
  sopsFileFor = name: ./. + "/${name}-env.sops";
  secretName = name: "app-${name}-env";

  withSecrets = lib.filterAttrs (_: a: a.operatorSecrets) apps;

  # JSON → the `fleet.apps.<name>` submodule. Every field is emitted
  # unconditionally where the option's default matches the exported value, so
  # the mapping stays uniform; only genuinely optional shapes (image override,
  # egress, auth paths) are conditional, because setting them to null is not
  # the same as leaving them unset.
  mkApp =
    name: a:
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
        inherit (a.presentation) description icon;
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

      environmentFiles = lib.optional a.operatorSecrets config.sops.secrets.${secretName name}.path;
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
in
{
  # One sops secret per app that declares operator-managed values. Same
  # mkDotenvSecret shape as every other stack; the app's own machine-generated
  # secrets/<name>/env (AUTH_SECRET) is separate and never carries operator
  # values.
  sops.secrets = lib.mapAttrs' (
    name: _: lib.nameValuePair (secretName name) (mkDotenvSecret (sopsFileFor name))
  ) withSecrets;

  fleet.apps = lib.mapAttrs mkApp apps;

  assertions = [
    {
      assertion = registry.schemaVersion == 1;
      message = "stacks/apps/apps.json declares schemaVersion ${toString registry.schemaVersion}, but declarations.nix understands 1. Regenerate the export from daedalus, or update this reader.";
    }
  ];
}
