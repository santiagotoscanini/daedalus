# cloudflared — Cloudflare Tunnel (outbound only), locally-managed.
#
# How the pieces fit together:
#   - `fleet.cloudflareRoutes.<name>.hostname` is the public FQDN.
#     `service` defaults to `http://traefik:8888` (the cfweb plain-HTTP
#     entrypoint; CF terminates TLS at the edge).
#   - `config.yml` is rendered from those entries via `pkgs.formats.yaml`
#     with a catch-all `http_status:404` appended (required by cloudflared).
#   - `cloudflared-route-sync.service` reconciles Cloudflare DNS CNAMEs
#     against `cloudflareRoutes` on every nixos-rebuild, using
#     the box's CF_DNS_API_TOKEN (platform/site.nix renders it from
#     site/vault/cloudflare-api-token.sops). Idempotent.
#   - `credentials.json.sops` (sops) carries `{AccountTag, TunnelID,
#     TunnelSecret}` — CF exposes the secret ONLY at tunnel creation
#     (POST response). Encrypted and tracked, the tunnel identity is in
#     the rebuild trail; no out-of-tree backup is needed.
#
# DNS fallback if the tunnel ever fails to register with a DNS error:
# add `"--dns=1.1.1.1"` to extraOptions below (pasta's normal DNS chain
# forwards through pi-hole on the host, so a broken pi-hole would
# otherwise take the tunnel registration down with it).
#
# Why :8888 (cfweb) and not :443: CF terminates TLS at the edge — using
# websecure would double-TLS with cert validation against the home cert
# from inside cloudflared. cfweb is plain HTTP, no redirect to https.
#
# The host brings:
#   fleet.modules.cloudflared.enable               the switch (default off, as every catalog module)
#   fleet.modules.cloudflared.credentialsSopsFile  the tunnel credentials, encrypted
#   fleet.images.cloudflared                        the digest-pinned image
# The account, tunnel and zone ids come from site.json (platform/site.nix),
# the API token from site/vault; the routes from every stack's
# `fleet.webApps.<n>.exposeRemotely`.

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  pinnedImage,
  ...
}:

let
  cfg = config.fleet;

  # Tunnel + account identifiers, read from site/site.json with the zone
  # (platform/site.nix defines `fleet.cloudflare`): a tunnel rotation is an
  # edit to the document, and nothing here restates the literals.
  inherit (cfg.cloudflare) tunnelId accountId;

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

  # The baseDomain zone. Read from site/site.json with the domain
  # (platform/site.nix sets `fleet.cloudflare.zoneId`), so a domain picked in
  # daedalus carries its zone with it. CF_DNS_API_TOKEN must be scoped to
  # whatever zone this is; daedalus only offers the zones that token can see.
  inherit (cfg.cloudflare) zoneId;

  # Stamped on every CNAME we create; the sweep ONLY touches records
  # carrying this exact comment, so it can never wipe a hand-edited
  # DNS record or an ACME challenge record.
  managedComment = "Managed by fleet.cloudflareRoutes";

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
  options.fleet.modules.cloudflared = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "The Cloudflare tunnel — the only way public HTTP reaches the box.";
    };

    credentialsSopsFile = lib.mkOption {
      type = lib.types.path;
      example = lib.literalExpression "./host/sops/cloudflared/credentials.json.sops";
      description = ''
        The tunnel's credentials file — `{AccountTag, TunnelID, TunnelSecret}`,
        which Cloudflare shows only when the tunnel is created — as sops
        ciphertext (binary format). Host data: the engine carries no box's
        ciphertext. Only read while the module is on.
      '';
    };
  };

  config = lib.mkIf config.fleet.modules.cloudflared.enable {
    # The box's one Cloudflare API token is platform (platform/site.nix renders
    # site/vault/cloudflare-api-token.sops as `fleet.cloudflare.tokenEnvFile`);
    # this stack is one of its readers. A rotation re-runs the DNS reconciler.
    sops.templates."cloudflare-api-token.env".restartUnits = [ "cloudflared-route-sync.service" ];

    # What daedalus's Network page needs to query the tunnel, present exactly
    # while the tunnel runs: the ids are the box's (site.json), but a tunnel
    # panel for a tunnel that is switched off is a panel about nothing. The
    # token it queries with is platform and reaches the app on its own.
    fleet.dashboard.cloudflared.env = {
      CF_ACCOUNT_ID = accountId;
      CF_TUNNEL_ID = tunnelId;
    };

    # Tunnel credentials (AccountTag/TunnelID/TunnelSecret — CF shows the
    # secret only at tunnel creation). Sops-encrypted and tracked: the tunnel
    # identity is in the rebuild trail, so no out-of-tree backup is needed.
    sops.secrets."cloudflared-credentials" = {
      sopsFile = cfg.modules.cloudflared.credentialsSopsFile;
      format = "binary";
      owner = cfg.operator.user;
    };

    fleet.bridgeMemberships.cloudflared = [ "traefik" ];

    fleet.prometheusScrapes = [
      {
        job_name = "cloudflared";
        static_configs = [ { targets = [ "cloudflared:2000" ]; } ];
      }
    ];

    virtualisation.oci-containers.containers.cloudflared = mkRootlessContainer {
      image = pinnedImage "cloudflared" "docker.io/cloudflare/cloudflared";
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
        # `traefik` resolves via aardvark-dns on traefik-net — do NOT add
        # an --add-host shortcut for it: /etc/hosts wins over aardvark,
        # and a host-gateway entry silently reroutes the whole tunnel
        # through the host-published port instead of the bridge.
        # Override the image's `nonroot` user (UID 65532) so the container
        # runs as UID 0 → the operator on the host, owner of the 0600
        # credentials.json. Same idiom as the linuxserver PUID=0 trick.
        "--user=0:0"
      ];
    };

    # Runs on every rebuild (and at boot) before cloudflared starts;
    # safe if cloudflared is already up.
    systemd.services.cloudflared-route-sync = {
      description = "Reconcile CF DNS CNAMEs for fleet.cloudflareRoutes";
      # pihole-ftl as well as pihole-ready: the latter is RemainAfterExit, so on
      # a rebuild it stays active and provides NO ordering barrier — only
      # pihole-ftl actually restarts, and this unit would otherwise start
      # alongside it with no resolver. Ordering is not sufficient on its own
      # (started != answering queries), which is why the script also retries
      # DNS failures; this just narrows the window.
      after = [
        "network-online.target"
        "pihole-ready.service"
        "pihole-ftl.service"
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
        EnvironmentFile = cfg.cloudflare.tokenEnvFile;
        ExecStart = "${routeSyncScript}/bin/cloudflared-route-sync";
        Restart = "on-failure";
        RestartSec = "2s";
      };
    };
  };
}
