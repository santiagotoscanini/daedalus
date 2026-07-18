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
#     container GID 0 → host GID 100 (santiago's `users`). So the
#     host data dir is 110000:100 — santiago can still `cp` from
#     snapshots without sudo, but a container/userns escape lands
#     as an unprivileged UID with no sudo (vs `--user=0:0` which
#     would land as santiago/wheel = instant root).
#
# Observability: no upstream Prometheus endpoint (upstream issue
# #1815 stale since 2020). Dashboard derives panels from traefik
# metrics filtered by `service=~"verdaccio.*"`.

{
  config,
  lib,
  mkDotenvSecret,
  mkRootlessContainer,
  mkImageBuild,
  ...
}:

let
  # verdaccio 6.7.4 base + verdaccio-openid plugin, built locally from
  # assets/Containerfile. The tag carries the build-context hash so a
  # plugin/Containerfile bump restarts the consumer.
  verdaccioImage = mkImageBuild {
    name = "verdaccio-openid";
    tagPrefix = "6.7.4";
    contextDir = ./assets;
    gates = [ "podman-verdaccio.service" ];
  };
in
{
  # VERDACCIO_OPENID_CLIENT_ID + VERDACCIO_OPENID_CLIENT_SECRET (Pocket ID
  # SSO): sops-encrypted env.sops. Edit with `sops env.sops`.
  sops.secrets."verdaccio-env" = mkDotenvSecret ./env.sops;

  myStack.containerNetworks.verdaccio = [ "traefik" ];

  # verdaccio-openid fetches the IdP discovery document at plugin load
  # and does not retry on failure, leaving OIDC npm login broken until
  # a restart. Start after traefik + pocket-id — whose ExecStartPost
  # readiness gate holds until the IdP answers — so discovery succeeds
  # on the first attempt.
  systemd.services.podman-verdaccio = {
    after = [
      "podman-traefik.service"
      "podman-pocket-id.service"
    ];
    wants = [ "podman-pocket-id.service" ];
  };

  myStack.webApps.verdaccio = {
    serviceName = "verdaccio";
    port = 4873;
    # LAN only — off-LAN clients reach it via WireGuard.
    homepage = {
      group = "Productivity";
      description = "Private npm registry (LAN-only)";
      icon = "verdaccio.png";
      siteMonitor = "https://verdaccio.toscanini.me/-/ping";
      widget = {
        type = "customapi";
        # /-/v1/search?text=* → {"total": <n>, "objects": [...], "time": "..."}
        # `total` is the count of locally-published packages (uplinks
        # are not included), which is the stat that matters here.
        url = "http://verdaccio:4873/-/v1/search?text=*";
        refreshInterval = 300000;
        mappings = [
          {
            field = "total";
            label = "Packages";
            format = "number";
          }
        ];
      };
    };
  };

  myStack.grafanaDashboardsByFolder."Services".verdaccio = builtins.readFile ./assets/dashboard.json;

  # 110000:100 = container UID 10001 : GID 0 in santiago's subuid range.
  myStack.stateDirs = {
    "/home/santiago/selfhost/verdaccio" = { };
    "/home/santiago/selfhost/verdaccio/storage" = {
      uid = 10001;
      gid = 0;
      mode = "0775";
    };
  };

  virtualisation.oci-containers.containers.verdaccio = mkRootlessContainer {
    # Built by verdaccio-image-build below.
    inherit (verdaccioImage) image;

    volumes = [
      "/home/santiago/selfhost/verdaccio/storage:/verdaccio/storage"
      "${./assets/config.yaml}:/verdaccio/conf/config.yaml:ro"
    ];

    environment = {
      # Pin the externally-visible base URL so verdaccio always
      # advertises https://verdaccio.toscanini.me in tarball URLs +
      # OAuth redirects, regardless of how traefik passes Host headers.
      VERDACCIO_PUBLIC_URL = "https://verdaccio.toscanini.me";
    };

    # VERDACCIO_OPENID_CLIENT_ID + _SECRET (referenced by name in config.yaml).
    environmentFiles = [ config.sops.secrets."verdaccio-env".path ];

    extraOptions = [
      "--user=10001:0" # See header for UID rationale.
    ];
  };

  systemd.services.verdaccio-image-build = verdaccioImage.service;
}
