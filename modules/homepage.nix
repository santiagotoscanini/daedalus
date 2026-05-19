# homepage — single-pane dashboard for the whole fleet (gethomepage.dev).
#
# Standalone, pasta networking. Reads its config from
# /home/santiago/selfhost/homepage/config (bind-mounted at /app/config).
# All widget URLs use `host.containers.internal:<host-port>` to reach
# each service via the host loopback — same pattern Traefik uses for
# its file-provider rules (see modules/traefik.nix).
#
# Secrets (per-service API keys, admin passwords) live in
# /etc/nixos/containers/homepage/env as HOMEPAGE_VAR_* keys. Homepage
# substitutes `{{HOMEPAGE_VAR_FOO}}` placeholders in any of the
# config/*.yaml files at read time. Empty values are tolerated —
# widgets that miss credentials degrade to a tile + status dot.
#
# HOMEPAGE_ALLOWED_HOSTS gates the proxy against host-header attacks
# (defense in depth; Traefik routes by host already). localhost:3000
# and 127.0.0.1:3000 are always implicitly allowed.
#
# Why no docker socket: this box runs rootless podman, and homepage's
# docker integration expects a unix socket on the host. The rootless
# podman socket exists at /run/user/1000/podman/podman.sock but
# enabling it adds enough surface area to not be worth it for the few
# "container is up" tiles homepage would gain over the explicit
# siteMonitor URLs we already set per service. The config/docker.yaml
# is left present-but-empty so adding it later is just an edit.

{ mkRootlessContainer, ... }:

{
  myStack.containerNetworks.homepage = null;
  myStack.traefikRoutes.homepage = {
    host = "homepage.s2.toscanini.me";
    port = 3001;
  };

  virtualisation.oci-containers.containers.homepage = mkRootlessContainer {
    # Pin to the current upstream stable release. Bump intentionally —
    # the YAML schema has occasionally added required fields (e.g. the
    # pihole v6 / immich v2 / wgeasy v2 widget `version:` keys).
    image = "ghcr.io/gethomepage/homepage:v1.13.1";

    # 3001 host -> 3000 container (homepage is Next.js, internal :3000;
    # host :3000 is grafana).
    ports = [ "3001:3000" ];

    volumes = [
      "/home/santiago/selfhost/homepage/config:/app/config"
    ];

    environment = {
      # Reverse-proxy host-header allow-list. Comma-separated, no
      # spaces. Localhost is always implicitly allowed.
      HOMEPAGE_ALLOWED_HOSTS = "homepage.s2.toscanini.me";
    };

    # HOMEPAGE_VAR_* placeholders referenced from services.yaml — see
    # /etc/nixos/containers/homepage/env for the full list and where
    # to find each value.
    extraOptions = [
      # Map traefik.s2.toscanini.me to the pasta gateway so the
      # traefik widget can reach the api@internal router (which is
      # only served on websecure with the right Host header). The
      # wildcard cert covers this name so TLS validates.
      "--add-host=traefik.s2.toscanini.me:host-gateway"
      # Same trick for Nextcloud — its `NC_overwriteprotocol = "https"`
      # turns every plain-HTTP request from host.containers.internal into
      # a 30x redirect to https://nextcloud.toscanini.me, which homepage's
      # proxy cannot follow (http -> https redirects are forbidden). Map
      # the FQDN to the pasta gateway so the widget can hit it directly
      # over HTTPS (wildcard cert covers *.toscanini.me).
      "--add-host=nextcloud.toscanini.me:host-gateway"
      # Same trick for NZBGet — homepage's widget uses an undici-based
      # HTTP client that ECONNRESETs on the `Connection: close` response
      # NZBGet emits. Going through traefik gets keep-alive on the
      # client-facing side, sidestepping the bug.
      "--add-host=nzbget.s2.toscanini.me:host-gateway"
      # Pi-hole `/` ping + qBittorrent widget both hit the same
      # undici quirks. Route through traefik like the others above.
      "--add-host=pihole.s2.toscanini.me:host-gateway"
      "--add-host=qbittorrent.s2.toscanini.me:host-gateway"
    ];

    environmentFiles = [
      "/etc/nixos/containers/homepage/env"
    ];
  };
}
