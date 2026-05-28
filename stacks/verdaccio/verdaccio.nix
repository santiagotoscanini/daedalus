# verdaccio — private npm proxy registry. LAN-only.
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

{ config, lib, pkgs, mkRootlessContainer, ... }:

let
  # Trimmed default docker.yaml — diff against
  # https://github.com/verdaccio/verdaccio/blob/master/packages/config/src/conf/docker.yaml
  # when bumping the image tag to catch upstream drift.
  configYaml = pkgs.writeText "verdaccio-config.yaml" ''
    # Auto-generated from /etc/nixos/stacks/verdaccio/verdaccio.nix.
    # Edit the nix module, not this file (it lives in /nix/store).

    storage: /verdaccio/storage/data
    plugins: /verdaccio/plugins

    web:
      title: s2 Verdaccio
      darkMode: true
      gravatar: false

    auth:
      htpasswd:
        file: /verdaccio/storage/htpasswd
        # LAN-only registry → "anyone on the LAN" is the trust boundary.
        # Drop to `-1` after bootstrap to lock further sign-up.
        max_users: 1000

    uplinks:
      npmjs:
        url: https://registry.npmjs.org/

    packages:
      '@*/*':
        access: $all
        publish: $authenticated
        unpublish: $authenticated
        proxy: npmjs

      '**':
        access: $all
        publish: $authenticated
        unpublish: $authenticated
        proxy: npmjs

    server:
      keepAliveTimeout: 60
      # Trust LAN proxies so `req.ip` resolves to the original client.
      trustProxy: 'loopback,linklocal,uniquelocal'

    middlewares:
      audit:
        enabled: true

    log:
      type: stdout
      format: pretty
      level: http

    i18n:
      web: en-US
  '';
in
{
  myStack.containerNetworks.verdaccio = "traefik";

  myStack.webApps.verdaccio = {
    hostname = "verdaccio.toscanini.me";
    serviceName = "verdaccio";
    port = 4873;
    # LAN only — off-LAN clients reach it via WireGuard.
  };

  myStack.homepageServices."Productivity" = [{
    name = "Verdaccio";
    href = "https://verdaccio.toscanini.me";
    description = "Private npm registry (LAN-only)";
    icon = "verdaccio.png";
    siteMonitor = "https://verdaccio.toscanini.me/-/ping";
  }];

  myStack.grafanaDashboards.verdaccio = builtins.readFile ./assets/dashboard.json;

  # 110000:100 = container UID 10001 : GID 0 in santiago's subuid range.
  systemd.tmpfiles.rules = [
    "d /home/santiago/selfhost/verdaccio 0755 santiago users -"
    "d /home/santiago/selfhost/verdaccio/storage 0775 110000 100 -"
  ];

  virtualisation.oci-containers.containers.verdaccio = mkRootlessContainer {
    image = "docker.io/verdaccio/verdaccio:6.7.1";

    volumes = [
      "/home/santiago/selfhost/verdaccio/storage:/verdaccio/storage"
      "${configYaml}:/verdaccio/conf/config.yaml:ro"
    ];

    environment = {
      # Pin the externally-visible base URL so verdaccio always
      # advertises https://verdaccio.toscanini.me in tarball URLs +
      # OAuth redirects, regardless of how traefik passes Host headers.
      VERDACCIO_PUBLIC_URL = "https://verdaccio.toscanini.me";
    };

    extraOptions = [
      "--user=10001:0"          # See header for UID rationale.
      "--network=traefik-net"
    ];
  };
}
