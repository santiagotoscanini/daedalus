# Per-app declarations — READ FROM the committed registry, not written by hand.
#
# The authoritative copy of this data lives in daedalus's `apps` table
# (stacks/daedalus). daedalus's Apply flow exports it to site/apps.json, commits
# that file, and rebuilds; this module turns the JSON back into `fleet.apps`
# entries, which the apps platform (modules/apps/apps.nix) composes into
# container + traefik + observability + (optionally) postgres.
#
# Why a file and not a database query: nix eval is pure and a flake only sees
# git-tracked files, so nixos-rebuild cannot reach Postgres — and must not need
# to. A committed export keeps "the repo IS the system" true: a fresh checkout
# rebuilds this exact box with no database in the loop. The DB is the editing
# surface; this file is the contract.
#
# To change an app: use daedalus, then Apply.
# Editing apps.json directly works for one rebuild but daedalus will report the
# app as drifted, and the next Apply overwrites it.
#
# NOT in here: the control plane's own entry. stacks/daedalus/daedalus.nix
# builds it from its hand-written self.json through the same registry-lib —
# deliberately outside this file, so a bad edit to daedalus's own entry can't
# take down the app you'd use to fix it.
#
# Defaults still inferred from the app's key by modules/apps/apps.nix:
#   image     = <registry hostname>/<name>:latest (the box's own zot)
#   hostname  = <name>.<baseDomain>
#   container = app-<name>
#
# Workflow for a NEW app, all of it from Apps -> Add an app in daedalus:
#   1. Install the daedalus GitHub App on github.com/<owner>/<name>,
#      so its pushes reach the webhook and the box may fetch it. No workflows
#      and no repo secrets are needed — the box builds the image itself.
#   2. Create the entry. It is created at `stage = "declared"`: the registry
#      row, its postgres role and database, its data dir and its generated
#      AUTH_SECRET — and no container, no deploy unit, no ingress.
#   3. Apply. Nothing starts; what this buys is the app's presence in
#      apps.json, which is what makes it buildable at all (build.sh's
#      BUILDABLE is generated from this file).
#   4. Push, or press Build now: daedalus-build fetches the commit, runs the
#      repo's checks inside the image build, and pushes `sha-<sha>` + `latest`
#      to zot. Watch it with `journalctl -fu daedalus-build.service` or the
#      build page.
#   5. Promote it to "lab" (or "live") and Apply again. THAT is the Apply that
#      creates the container, the route, the DNS record and the probe.
#
# The order is load-bearing, and it runs entry-first for two reasons that
# point the same way. The box only builds apps already declared here, so an
# app that is not in this file can never get a first image. And a declaration
# above "declared" whose image does not exist makes `podman run` fail, which
# makes switch-to-configuration exit 4, which makes daedalus's apply revert
# its own commit. "declared" is the rung that satisfies both: it declares
# everything durable and starts nothing.
#
# Nothing in the create path writes code to GitHub. The only writes daedalus
# makes there are a check run named `daedalus` and a Deployment, both
# reporting a build this box already ran.
#
# Auth is editable from the app's page and needs nothing here: its Pocket ID
# client secret is machine-generated on the box, like every app-db password (see
# modules/pocket-id/clients.nix). Operator secrets have no flag at all — a
# tracked site/vault/apps/<name>-env.sops IS the switch
# (platform/lib/operator-secrets-lib.nix). VPN egress is the one setting the
# app's page does not make, because it needs a gluetun instance to exist
# before an app can join its netns.
#
# From then on, every push to main goes live on its own: the box builds the
# image and its build agent starts `app-<name>-deploy.service` the moment that
# build publishes (`app-<name>-deploy.timer` polls every 2 minutes behind it, for
# the deploy that start missed). The deploy pulls, and when the digest moved
# it restarts the container and health-checks it through traefik. Watch a deploy
# with `journalctl -fu app-<name>-deploy.service`; a deploy that comes back
# unhealthy leaves the unit failed (and the new image running — there is no
# auto-rollback). See modules/apps/apps.nix + assets/deploy.sh.

{
  config,
  enginePath,
  lib,
  mkDotenvSecret,
  ...
}:

let
  registry = builtins.fromJSON (builtins.readFile config.fleet.registry.file);

  inherit (registry) apps;

  secretName = name: "app-${name}-env";

  # Operator-managed secrets: a tracked `site/vault/apps/<name>-env.sops` IS
  # the switch — see platform/lib/operator-secrets-lib.nix for why it is derived from the
  # directory rather than declared in the registry, and why the site directory
  # is handed to it instead of being derived from its own location.
  # Intersected with the declared apps, so a leftover file for a deleted app is
  # inert.
  operatorSecretFiles = lib.filterAttrs (name: _: apps ? ${name}) (
    import (enginePath + "/platform/lib/operator-secrets-lib.nix") {
      inherit lib;
      site = config.fleet.site.source;
    }
  );

  # The JSON→submodule mapping lives in platform/lib/registry-lib.nix — shared with
  # daedalus.nix's self entry, so the two readers cannot drift. What layers on
  # HERE is the one config-dependent field: operator secrets, keyed by the
  # presence of a tracked `<name>-env.sops` in the site vault.
  registryLib = import (enginePath + "/platform/lib/registry-lib.nix") { inherit lib; };

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
  config = lib.mkIf config.fleet.modules.apps.enable {
    # One sops secret per app that HAS an operator-secrets file. Same
    # mkDotenvSecret shape as every other stack; the app's own machine-generated
    # <machineState>/apps/<name>/env (AUTH_SECRET) is separate and never carries
    # operator values.
    #
    # `restartUnits` is the half that makes a ROTATION reach the app, and it is
    # not decoration. sops-nix re-decrypts every `sops.secrets.<n>` at every
    # activation, so after a rebuild /run/secrets/app-<name>-env already holds
    # the new value — but the container read that file once, at `podman run`, and
    # nothing about the unit's text changed, so systemd has no reason to restart
    # it. Without this line a rebuild that "applied" a new secret would leave the
    # app serving the old one, with every unit green: mkSecretRender's
    # false-success trap, arriving by a different road. sops-nix restarts the unit only when the decrypted bytes
    # actually changed, so an unrelated rebuild still bounces nothing.
    #
    # This is what the app-secrets editor (stacks/daedalus, host/secret-set.sh)
    # depends on: it commits a new ciphertext and says "the container reads it on
    # the next Apply", which is true because of this list.
    sops.secrets = lib.mapAttrs' (
      name: file:
      lib.nameValuePair (secretName name) (
        mkDotenvSecret file // { restartUnits = [ "podman-app-${name}.service" ]; }
      )
    ) operatorSecretFiles;

    fleet.apps = lib.mapAttrs mkApp apps;

    assertions = [
      {
        assertion = lib.elem registry.schemaVersion registryLib.acceptedSchemaVersions;
        message = "${toString config.fleet.registry.file} declares schemaVersion ${toString registry.schemaVersion}, but registry-lib.nix understands ${
          lib.concatMapStringsSep "/" toString registryLib.acceptedSchemaVersions
        }. Regenerate the export from daedalus, or update the reader.";
      }
    ];
  };
}
