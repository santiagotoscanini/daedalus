# verdaccio — private npm proxy registry. LAN-only.
#
# Config lives at assets/config.yaml — bind-mounted read-only into
# the container. Edit the YAML directly; the .nix module owns
# wiring/UID/networking only.
#
# UID strategy (defense-in-depth — verdaccio deserializes arbitrary
# uploaded tarballs):
#   - `--user=10001:0` matches the image's `chown 10001:root` on the
#     storage/conf dirs (image's default USER 10001 alone picks up
#     GID 65533/nogroup and mismatches the chowned dirs).
#   - Rootless mapping: container UID 10001 → host UID 110000,
#     container GID 0 → host GID 100 (the operator's `users`). So the
#     host data dir is 110000:100 — the operator can still `cp` from
#     snapshots without sudo, but a container/userns escape lands
#     as an unprivileged UID with no sudo (vs `--user=0:0` which
#     would land as the operator, a wheel member = instant root).
#
# Web UI shows CACHED packages, not just published ones — upstream
# serves both index routes from the private-publish list, so a pure
# proxy registry renders an empty page. The local
# assets/cached-packages middleware shadows those two routes and
# serves them from a storage scan; its header has the full rationale.
#
# Observability: no upstream Prometheus endpoint (upstream issue
# #1815 stale since 2020). Dashboard derives panels from traefik
# metrics filtered by `service=~"verdaccio.*"`.
#
# The box's builds install through it: the module contributes
# `fleet.builder.npmMirrorHost`, and the control plane's dev container is
# handed the same mirror. Switch it off and both go to npmjs.
#
# The host brings:
#   fleet.modules.verdaccio.enable  the switch (default off, as every catalog module)
# The image is built here from assets/Containerfile (the base pin is bumped
# by hand, in the engine); no `fleet.images` entry.

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  mkLocalImage,
  ...
}:

let
  # verdaccio 6.9.0 base + the verdaccio-openid and cached-packages
  # plugins, built locally from assets/Containerfile. The tag carries
  # the build-context hash, so editing either plugin (or the
  # Containerfile) produces a new tag and restarts the consumer.
  verdaccioImage = mkLocalImage {
    name = "verdaccio-openid";
    tagPrefix = "6.9.0";
    contextDir = ./assets;
    gates = [ "podman-verdaccio.service" ];
  };
in
{
  options.fleet.modules.verdaccio.enable = lib.mkOption {
    type = lib.types.bool;
    default = false;
    description = "Verdaccio private npm proxy registry.";
  };

  config = lib.mkIf config.fleet.modules.verdaccio.enable {
    # The box's builds install through this mirror (the build agent pins the
    # name to the LAN address inside BuildKit). Contributed from here — the
    # stack that publishes the mirror — so a host without one builds from
    # npmjs and the engine names no stack it does not ship.
    fleet.builder.npmMirrorHost = config.fleet.webApps.verdaccio.hostname;

    fleet.bridgeMemberships.verdaccio = [ "traefik" ];

    # verdaccio-openid fetches the IdP discovery document at plugin load
    # and does not retry on failure, leaving OIDC npm login broken until a
    # restart — with no crash to make that visible.
    fleet.sso.discoveryConsumers = [ "verdaccio" ];

    # Pocket ID client — id `verdaccio`, secret generated on the box,
    # rendered into the container as the
    # VERDACCIO_OPENID_CLIENT_* pair config.yaml references by name.
    # Three callbacks: the web UI, `npm login --auth-type=web` (authn) and
    # the CLI flow. PKCE off — the plugin doesn't send a verifier.
    fleet.ssoClients.verdaccio = {
      description = "Private npm registry";
      launchURL = "https://${config.fleet.webApps.verdaccio.hostname}";
      callbackURLs = [
        "https://${config.fleet.webApps.verdaccio.hostname}/-/oauth/callback"
        "https://${config.fleet.webApps.verdaccio.hostname}/-/oauth/callback/authn"
        "https://${config.fleet.webApps.verdaccio.hostname}/-/oauth/callback/cli"
      ];
      logoutCallbackURLs = [ "https://${config.fleet.webApps.verdaccio.hostname}" ];
      pkce = false;
      consumers = [ "verdaccio" ];
      consumerEnv = {
        id = "VERDACCIO_OPENID_CLIENT_ID";
        secret = "VERDACCIO_OPENID_CLIENT_SECRET";
      };
    };

    fleet.webApps.verdaccio = {
      serviceName = "verdaccio";
      port = 4873;
    };

    fleet.grafanaDashboardsByFolder."Services".verdaccio = builtins.readFile ./assets/dashboard.json;

    # 110000:100 = container UID 10001 : GID 0 in the operator's subuid range.
    fleet.statePaths = {
      "${config.fleet.stateRoot}/verdaccio" = { };
      "${config.fleet.stateRoot}/verdaccio/storage" = {
        uid = 10001;
        gid = 0;
        mode = "0775";
      };
    };

    virtualisation.oci-containers.containers.verdaccio = mkRootlessContainer {
      # Built by verdaccio-image-build below.
      inherit (verdaccioImage) image;

      volumes = [
        "${config.fleet.stateRoot}/verdaccio/storage:/verdaccio/storage"
        # A template: @ssoIssuer@ is the one value the file cannot know.
        "${
          pkgs.writeText "verdaccio-config.yaml" (
            builtins.replaceStrings [ "@ssoIssuer@" ] [ config.fleet.sso.issuerUrl ] (
              builtins.readFile ./assets/config.yaml
            )
          )
        }:/verdaccio/conf/config.yaml:ro"
      ];

      environment = {
        # Pin the externally-visible base URL so verdaccio always
        # advertises its published hostname in tarball URLs +
        # OAuth redirects, regardless of how traefik passes Host headers.
        VERDACCIO_PUBLIC_URL = "https://${config.fleet.webApps.verdaccio.hostname}";
      };

      extraOptions = [
        "--user=10001:0" # See header for UID rationale.
        "--stop-timeout=30" # >10s so storage/registry writes flush before SIGKILL at reboot.
      ];
    };

    systemd.services.verdaccio-image-build = verdaccioImage.service;
  };
}
