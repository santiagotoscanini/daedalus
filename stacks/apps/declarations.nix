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
# To change an app: use daedalus (https://daedalus-app.toscanini.me), then Apply.
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
# Auth is editable from the app's page and needs nothing here: its Pocket ID
# client secret is machine-generated on the box, like every app-db password (see
# stacks/pocket-id/clients.nix). Operator secrets have no flag at all — a
# tracked <name>-env.sops IS the switch (./operator-secrets-lib.nix). VPN egress
# is the one thing still authored here, because it needs a gluetun instance to
# exist before an app can join its netns.
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

  secretName = name: "app-${name}-env";

  # Operator-managed secrets: a tracked `<name>-env.sops` at this stack's root
  # IS the switch — see ./operator-secrets-lib.nix for why it is derived from
  # the directory rather than declared in the registry. Intersected with the
  # declared apps, so a leftover file for a deleted app is inert.
  operatorSecretFiles = lib.filterAttrs (name: _: apps ? ${name}) (
    import ./operator-secrets-lib.nix { inherit lib; }
  );

  # The JSON→submodule mapping lives in ./registry-lib.nix — shared with
  # daedalus.nix's self entry, so the two readers cannot drift. What layers on
  # HERE is the one config-dependent field: operator secrets, keyed by the
  # presence of a tracked `<name>-env.sops` in this directory.
  registryLib = import ./registry-lib.nix { inherit lib; };

  mkApp =
    name: a:
    registryLib.mkApp a
    // {
      environmentFiles = lib.optional (
        operatorSecretFiles ? ${name}
      ) config.sops.secrets.${secretName name}.path;
    };
in
{
  # One sops secret per app that HAS an operator-secrets file. Same
  # mkDotenvSecret shape as every other stack; the app's own machine-generated
  # secrets/<name>/env (AUTH_SECRET) is separate and never carries operator
  # values.
  sops.secrets = lib.mapAttrs' (
    name: file: lib.nameValuePair (secretName name) (mkDotenvSecret file)
  ) operatorSecretFiles;

  fleet.apps = lib.mapAttrs mkApp apps;

  assertions = [
    {
      assertion = lib.elem registry.schemaVersion registryLib.acceptedSchemaVersions;
      message = "stacks/apps/apps.json declares schemaVersion ${toString registry.schemaVersion}, but registry-lib.nix understands ${lib.concatMapStringsSep "/" toString registryLib.acceptedSchemaVersions}. Regenerate the export from daedalus, or update the reader.";
    }
  ];
}
