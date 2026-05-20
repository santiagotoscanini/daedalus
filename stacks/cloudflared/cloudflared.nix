# cloudflared — Cloudflare Tunnel (outbound only).
#
# Token-authenticated tunnel that reverses the usual "open a port on
# your router" pattern: cloudflared establishes an outbound QUIC/HTTP2
# connection to Cloudflare's edge, and Cloudflare routes requests for
# the public hostnames bound to this tunnel (configured in the
# Cloudflare Zero Trust dashboard, not here) into local services.
#
# The Zero Trust dashboard config routes everything to
# `http://traefik:8888` — a hostname that resolved on the old
# `traefik_network` docker bridge. To preserve that config without
# touching the dashboard, we alias `traefik` to `host-gateway` in
# cloudflared's /etc/hosts (resolves to 169.254.1.2, pasta's gateway
# alias for the host). Combined with publishing traefik's :8888,
# cloudflared can dial `http://traefik:8888` and it reaches the host's
# traefik via pasta.
#
# Why :8888 (cfweb) and not :443 (websecure): Cloudflare terminates
# TLS at the edge; using websecure would mean double-TLS with cert
# validation against the home cert from inside cloudflared. cfweb is
# plain HTTP and has its own no-redirect entrypoint config.
#
# cloudflared reads TUNNEL_TOKEN as an env var.
#
# Known fallback: pasta's DNS proxy forwards lookups through pi-hole
# on the host, which works for cloudflared. The pre-podman compose
# forced `dns: 1.1.1.1` because its rootless-docker DNS chain was
# broken; if the tunnel ever fails to register because of DNS, try
# adding `--dns=1.1.1.1` to extraOptions as a workaround.

{ mkRootlessContainer, ... }:

{
  myStack.containerNetworks.cloudflared = null;


  myStack.prometheusScrapes = [{
    job_name = "cloudflared";
    static_configs = [{ targets = [ "host.containers.internal:2000" ]; }];
  }];

  myStack.homepageServices."Network" = [{
    name = "Cloudflare Tunnel";
    href = "https://dash.cloudflare.com/c08bf36c41d7bc5db11d6b35e0b4e721/tunnels/e2dc540a-c1d5-4d7e-b134-e0a7e21cab24/overview";
    description = "Outbound CF Tunnel (nextcloud, grocy, wealthfolio, immich public)";
    icon = "cloudflare.png";
    widget = {
      type = "cloudflared";
      accountid = "{{HOMEPAGE_VAR_CF_ACCOUNT_ID}}";
      tunnelid  = "{{HOMEPAGE_VAR_CF_TUNNEL_ID}}";
      key       = "{{HOMEPAGE_VAR_CF_API_TOKEN}}";
    };
  }];

  virtualisation.oci-containers.containers.cloudflared = mkRootlessContainer {
    image = "docker.io/cloudflare/cloudflared:latest";
    dependsOn = [ "traefik" ];

    # `--metrics` exposes Prometheus metrics on the tunnel daemon's
    # internal port 2000. We publish to 127.0.0.1 only — Prometheus
    # reaches the host via host.containers.internal, which routes
    # through pasta's gateway to the loopback bind.
    ports = [ "2000:2000" ];

    cmd = [ "tunnel" "--metrics" "0.0.0.0:2000" "--no-autoupdate" "run" ];

    environmentFiles = [ "/etc/nixos/stacks/cloudflared/secrets/env" ];

    extraOptions = [
      "--add-host=traefik:host-gateway"
    ];
  };
}
