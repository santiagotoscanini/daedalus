# cloudflared — Cloudflare Tunnel (outbound only), locally-managed.
#
# How the pieces fit together:
#   - `myStack.cloudflareRoutes.<name>.hostname` is the public FQDN.
#     `service` defaults to `http://traefik:8888` (the cfweb plain-HTTP
#     entrypoint; CF terminates TLS at the edge).
#   - `config.yml` is rendered from those entries via `pkgs.formats.yaml`
#     with a catch-all `http_status:404` appended (required by cloudflared).
#   - `cloudflared-route-sync.service` reconciles Cloudflare DNS CNAMEs
#     against `cloudflareRoutes` on every nixos-rebuild, using
#     CF_DNS_API_TOKEN from env.sops (sops). Idempotent.
#   - `credentials.json.sops` (sops) carries `{AccountTag, TunnelID,
#     TunnelSecret}` — CF exposes the secret ONLY at tunnel creation
#     (POST response), so this is the one-time output that must be
#     backed up out-of-tree to recover the tunnel identity.
#
# DNS fallback if the tunnel ever fails to register with a DNS error:
# add `"--dns=1.1.1.1"` to extraOptions below. Pasta's DNS chain
# (which forwards through pi-hole on the host) has worked since the
# podman migration, but the pre-podman compose forced 1.1.1.1 because
# its rootless-docker DNS was broken.
#
# Why :8888 (cfweb) and not :443: CF terminates TLS at the edge — using
# websecure would double-TLS with cert validation against the home cert
# from inside cloudflared. cfweb is plain HTTP, no redirect to https.

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  mkDotenvSecret,
  ...
}:

let
  cfg = config.myStack;

  # Tunnel + account identifiers. Bound here so a tunnel rotation is
  # a single-line change (also referenced from the homepage tile).
  tunnelId = "f67bc172-3096-4b17-961e-3cb3d1b5b523";
  accountId = "c08bf36c41d7bc5db11d6b35e0b4e721";

  yamlFormat = pkgs.formats.yaml { };

  configYml = yamlFormat.generate "cloudflared-config.yml" {
    tunnel = tunnelId;
    credentials-file = "/etc/cloudflared/credentials.json";
    ingress =
      (map (r: {
        inherit (r) hostname;
        inherit (r) service;
      }) (lib.attrValues cfg.cloudflareRoutes))
      ++ [ { service = "http_status:404"; } ];
  };

  # toscanini.me zone (the only zone in scope for CF_DNS_API_TOKEN).
  zoneId = "4e41da370f4833a54256624842524f38";

  # Stamped on every CNAME we create; the sweep ONLY touches records
  # carrying this exact comment, so it can never wipe a hand-edited
  # DNS record or an ACME challenge record.
  managedComment = "Managed by myStack.cloudflareRoutes";

  # Idempotent CF DNS reconciler:
  #   1. UPSERT — for each cloudflareRoutes entry, ensure a proxied
  #      CNAME `<hostname> -> <tunnelId>.cfargotunnel.com` exists.
  #   2. SWEEP — DELETE any CNAME with our managedComment whose name
  #      isn't in the declared set (so removing an entry + rebuild
  #      removes the CNAME).
  # Script body lives at assets/route-sync.sh (pure Bash, shellcheckable
  # standalone). This wrapper sets the parameters it expects as env
  # vars, then concatenates the body so writeShellApplication runs it
  # all in one shell with shellcheck across the whole.
  routeSyncScript = pkgs.writeShellApplication {
    name = "cloudflared-route-sync";
    runtimeInputs = [
      pkgs.curl
      pkgs.jq
    ];
    text = ''
      ZONE_ID='${zoneId}'
      TUNNEL_ID='${tunnelId}'
      MANAGED_COMMENT=${lib.escapeShellArg managedComment}
      HOSTS=${
        lib.escapeShellArg (
          lib.concatMapStringsSep "\n" (r: r.hostname) (lib.attrValues cfg.cloudflareRoutes)
        )
      }

      ${builtins.readFile ./assets/route-sync.sh}
    '';
  };
in

{
  # Tunnel credentials (AccountTag/TunnelID/TunnelSecret — CF shows the
  # secret only at tunnel creation) + CF_DNS_API_TOKEN for route-sync.
  # Both sops-encrypted and tracked: the tunnel identity is in the
  # rebuild trail, so no out-of-tree backup is needed.
  sops.secrets."cloudflared-env" = mkDotenvSecret ./env.sops;
  sops.secrets."cloudflared-credentials" = {
    sopsFile = ./credentials.json.sops;
    format = "binary";
    owner = "santiago";
  };

  myStack.containerNetworks.cloudflared = "traefik";

  myStack.prometheusScrapes = [
    {
      job_name = "cloudflared";
      static_configs = [ { targets = [ "cloudflared:2000" ]; } ];
    }
  ];

  myStack.homepageServices."Network" = [
    {
      name = "Cloudflare Tunnel";
      href = "https://dash.cloudflare.com/${accountId}/tunnels/${tunnelId}/overview";
      description = "Outbound CF Tunnel (locally-managed ingress)";
      icon = "cloudflare.png";
      widget = {
        type = "cloudflared";
        accountid = "{{HOMEPAGE_VAR_CF_ACCOUNT_ID}}";
        tunnelid = "{{HOMEPAGE_VAR_CF_TUNNEL_ID}}";
        key = "{{HOMEPAGE_VAR_CF_API_TOKEN}}";
      };
    }
  ];

  virtualisation.oci-containers.containers.cloudflared = mkRootlessContainer {
    image = "docker.io/cloudflare/cloudflared:2026.7.2@sha256:4f6655284ab3d252b7f28fedb19fe6c8fc82ee5b1295c20ac74d475e5398a52d";
    dependsOn = [ "traefik" ];

    volumes = [
      "${configYml}:/etc/cloudflared/config.yml:ro"
      "${config.sops.secrets."cloudflared-credentials".path}:/etc/cloudflared/credentials.json:ro"
    ];

    # `--config` flips cloudflared from "fetch ingress from CF" to
    # "use local ingress". `--metrics` exposes Prometheus on :2000
    # (reached over traefik-net, no host port).
    cmd = [
      "tunnel"
      "--config"
      "/etc/cloudflared/config.yml"
      "--metrics"
      "0.0.0.0:2000"
      "--no-autoupdate"
      "run"
    ];

    extraOptions = [
      # /etc/hosts shortcut for the `traefik` name — redundant with
      # aardvark-dns on traefik-net but harmless.
      "--add-host=traefik:host-gateway"
      "--network=traefik-net"
      # Override the image's `nonroot` user (UID 65532) so the container
      # runs as UID 0 → host santiago (UID 1000), owner of the 0600
      # credentials.json. Same idiom as the linuxserver PUID=0 trick.
      "--user=0:0"
    ];
  };

  # Runs on every rebuild (and at boot) before cloudflared starts;
  # safe if cloudflared is already up.
  systemd.services.cloudflared-route-sync = {
    description = "Reconcile CF DNS CNAMEs for myStack.cloudflareRoutes";
    after = [
      "network-online.target"
      "pihole-ready.service"
    ];
    wants = [
      "network-online.target"
      "pihole-ready.service"
    ];
    wantedBy = [ "multi-user.target" ];
    before = [ "podman-cloudflared.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      EnvironmentFile = config.sops.secrets."cloudflared-env".path;
      ExecStart = "${routeSyncScript}/bin/cloudflared-route-sync";
      Restart = "on-failure";
      RestartSec = "2s";
    };
  };
}
