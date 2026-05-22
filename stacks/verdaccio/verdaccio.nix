# verdaccio — private npm proxy registry. LAN-only.
#
# Single container, pasta networking. The published port is 4873 (the
# npm registry convention); traefik routes verdaccio.toscanini.me on
# the LAN HTTPS entrypoint. No Cloudflare tunnel — the registry is
# only meant for clients on the LAN / WireGuard.
#
# UID/permissions
# ---------------
# Defense-in-depth: this stack does NOT use the fleet's usual
# `--user=0:0` shortcut. Verdaccio is a LAN-facing Node app that
# deserializes arbitrary tarballs uploaded via `npm publish`, so the
# extra hardening from running as a non-root container user is worth
# the small chown dance.
#
# Upstream image creates the `verdaccio` user at UID 10001 and chowns
# `/verdaccio/storage` + `/verdaccio/conf` to `10001:0` (root group)
# with `chmod -R g=u`. We pin `--user=10001:0` to match that exactly
# (default `USER 10001` in the image would pick up GID 65533/nogroup
# from /etc/passwd, mismatching the chowned dirs).
#
# In rootless podman with santiago's subuid/subgid (100000:65536):
#   container UID 10001 → host UID 110000   (= 99999 + 10001)
#   container GID 0     → host GID 100      (= santiago's primary
#                                            group "users")
# So the host data dir is owned `110000:100` mode 0775. Owner is the
# unprivileged "verdaccio" identity; group is `users` (santiago is in
# it), so host-side `cp` from ZFS snapshots works without sudo.
#
# Security implication of a container/userns escape: attacker lands as
# host UID 110000 — no sudo, no shell, owns only the verdaccio storage
# dir. Compare to `--user=0:0`, where an escape would land as santiago
# (NOPASSWD wheel) — instant root on the box.
#
# Config strategy
# ---------------
# `/verdaccio/conf/config.yaml` is a /nix/store-backed file generated
# below (single source of truth). `/verdaccio/storage` is a writable
# bind mount under /home/santiago/selfhost/verdaccio/storage that
# holds tarballs, the .verdaccio-db metadata file, and the htpasswd
# user database (created lazily on first `npm adduser`).
#
# Plugins dir is left at the in-image empty `/verdaccio/plugins` —
# we don't ship any third-party plugins.
#
# VERDACCIO_PUBLIC_URL pins the externally-visible base URL so
# verdaccio's tarball links and login redirects always advertise
# https://verdaccio.toscanini.me, regardless of how traefik passes
# Host / X-Forwarded-Proto. The verdaccio docs explicitly call this
# out as the reverse-proxy-safe way to get URL generation right.
#
# Observability
# -------------
# Verdaccio has no built-in Prometheus metrics endpoint (upstream issue
# #1815 has sat in the "Next" milestone since 2020; no plugin in the
# verdaccio org provides this either). Rather than ship a third-party
# plugin, we lean on traefik's existing metrics: every request the
# registry serves goes through traefik, which exposes per-service /
# per-router series (`stacks/traefik/traefik.nix` already sets
# `addServicesLabels=true` + `addRoutersLabels=true`). The dashboard
# in `assets/dashboard.json` filters those series to
# `service=~"verdaccio.*"` for an at-a-glance view of RPS, status
# codes, latency, and bandwidth.

{ config, lib, pkgs, mkRootlessContainer, ... }:

let
  # Default docker.yaml from the upstream image, trimmed to what we
  # actually customize. Tracks the shipped defaults closely so that
  # bumps to the image don't drift unnoticed — diff against
  # https://github.com/verdaccio/verdaccio/blob/master/packages/config/src/conf/docker.yaml
  # when bumping the image tag.
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
        # Public sign-up is open — this registry only listens on the
        # LAN entrypoint, so "anyone on the LAN" is the trust boundary.
        # Drop to `-1` here once the initial users are bootstrapped if
        # you want to lock further registration.
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
      # Trust traefik as a forwarding proxy so `req.ip` resolves to
      # the original client. Pasta's gateway alias sits in 169.254/16
      # (linklocal); traefik itself dials us from host.containers.
      # internal (also linklocal from inside the container netns).
      # `loopback,linklocal,uniquelocal` covers all the RFC1918-ish
      # ranges a LAN proxy can come from.
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
  myStack.containerNetworks.verdaccio = null;

  myStack.webApps.verdaccio = {
    hostname = "verdaccio.toscanini.me";
    port = 4873;
    # LAN only. Off-LAN clients can still reach this through WireGuard.
  };

  myStack.homepageServices."Productivity" = [{
    name = "Verdaccio";
    href = "https://verdaccio.toscanini.me";
    description = "Private npm registry (LAN-only)";
    icon = "verdaccio.png";
    siteMonitor = "http://host.containers.internal:4873/-/ping";
  }];

  # Dashboard derives all its panels from traefik metrics filtered by
  # service=~"verdaccio.*" — see the header note above.
  myStack.grafanaDashboards.verdaccio = builtins.readFile ./assets/dashboard.json;

  # Storage dir is owned by the rootless-mapped verdaccio user (host
  # UID 110000 = container UID 10001) with group `users` so santiago
  # can still inspect/cp from snapshots without sudo. See the header
  # comment for the security rationale.
  systemd.tmpfiles.rules = [
    "d /home/santiago/selfhost/verdaccio 0755 santiago users -"
    "d /home/santiago/selfhost/verdaccio/storage 0775 110000 100 -"
  ];

  virtualisation.oci-containers.containers.verdaccio = mkRootlessContainer {
    image = "docker.io/verdaccio/verdaccio:6.7.1";

    ports = [ "4873:4873" ];

    volumes = [
      "/home/santiago/selfhost/verdaccio/storage:/verdaccio/storage"
      "${configYaml}:/verdaccio/conf/config.yaml:ro"
    ];

    environment = {
      # Pin the externally-visible base URL. With this set, verdaccio
      # ignores `Host` / `X-Forwarded-Proto` and always advertises
      # https://verdaccio.toscanini.me in tarball URLs and OAuth
      # redirects — exactly what we want behind traefik.
      VERDACCIO_PUBLIC_URL = "https://verdaccio.toscanini.me";
    };

    extraOptions = [
      # Run as the image's `verdaccio` user (UID 10001) with GID 0
      # to match the Dockerfile's `chown 10001:root` on the storage
      # and conf dirs. Container UID 10001 → host UID 110000 in our
      # rootless mapping; a container/userns escape lands as an
      # unprivileged host UID with no sudo. See header comment.
      "--user=10001:0"
    ];
  };
}
