# cloudflared — Cloudflare Tunnel (outbound only), locally-managed.
#
# Migrated from a dashboard-managed tunnel to a locally-managed one on
# 2026-05-20. `config_src` is set at tunnel creation time and not
# mutable via PATCH, so the migration was a rotation: created a fresh
# tunnel `s2-local` (config_src=local) via the CF API, repointed the 4
# CNAMEs at the new UUID, deleted the old `S2`. After that, ingress
# rules live here under `myStack.cloudflareRoutes` and adding a
# public hostname is a one-line `cloudflareRoutes.<name>` entry in
# the owning stack — no clicking through the dashboard, no manual
# DNS edit.
#
# How the pieces fit together:
#   - `myStack.cloudflareRoutes.<name>.hostname` is the public FQDN.
#     `service` defaults to `http://traefik:8888` (the cfweb plain-HTTP
#     entrypoint; CF terminates TLS at the edge).
#   - `config.yml` is rendered from those entries via
#     `pkgs.formats.yaml`, pinning the tunnel UUID and referencing the
#     bind-mounted credentials file. Catch-all `http_status:404` is
#     appended as required by cloudflared.
#   - `cloudflared-route-sync.service` (defined below) reconciles
#     Cloudflare DNS CNAMEs against `cloudflareRoutes` on every
#     nixos-rebuild, using the existing CF_DNS_API_TOKEN from
#     stacks/cloudflared/secrets/env. Idempotent; survives reorderings.
#   - `secrets/credentials.json` carries `{AccountTag,TunnelID,
#     TunnelSecret}` — Cloudflare exposes the secret only at tunnel
#     CREATION (POST response), so this file is the one-time output of
#     that POST and is the only thing that must be backed up out-of-tree
#     to recover the tunnel identity if the host pool is lost.
#
# All routes go to `http://traefik:8888`, a hostname that resolves on
# the old `traefik_network` docker bridge. Under rootless podman we
# alias `traefik` to `host-gateway` in cloudflared's /etc/hosts
# (resolves to 169.254.1.2, pasta's gateway alias for the host).
# Combined with publishing traefik's :8888, cloudflared can dial
# `http://traefik:8888` and reach the host's traefik via pasta.
#
# Why :8888 (cfweb) and not :443 (websecure): Cloudflare terminates
# TLS at the edge; using websecure would mean double-TLS with cert
# validation against the home cert from inside cloudflared. cfweb is
# plain HTTP and has its own no-redirect entrypoint config.
#
# Known fallback: pasta's DNS proxy forwards lookups through pi-hole
# on the host, which works for cloudflared. The pre-podman compose
# forced `dns: 1.1.1.1` because its rootless-docker DNS chain was
# broken; if the tunnel ever fails to register because of DNS, try
# adding `--dns=1.1.1.1` to extraOptions as a workaround.

{ config, lib, pkgs, mkRootlessContainer, ... }:

let
  cfg = config.myStack;

  # Tunnel + account identifiers. The tunnel UUID is baked into both
  # the config.yml and the homepage dashboard link; keeping them as
  # `let` bindings means a tunnel rotation is a single-line change.
  tunnelId  = "f67bc172-3096-4b17-961e-3cb3d1b5b523";
  accountId = "c08bf36c41d7bc5db11d6b35e0b4e721";

  yamlFormat = pkgs.formats.yaml { };

  configYml = yamlFormat.generate "cloudflared-config.yml" {
    tunnel = tunnelId;
    credentials-file = "/etc/cloudflared/credentials.json";
    # Metrics endpoint is also configurable here, but we pass it on
    # the CLI to keep all runtime flags colocated below.
    ingress =
      (map
        (r: { hostname = r.hostname; service = r.service; })
        (lib.attrValues cfg.cloudflareRoutes))
      ++ [ { service = "http_status:404"; } ];
  };

  # Public toscanini.me zone — the only zone exposed to this box's
  # CF_DNS_API_TOKEN (verified by listing zones with that token).
  # Hardcoded because the token's scope is `Zone:DNS:Edit` on this
  # specific zone, and looking it up at runtime would just be one
  # extra API call per rebuild for no benefit.
  zoneId = "4e41da370f4833a54256624842524f38";

  # Marker comment stamped onto every CNAME we create. The orphan
  # sweep below ONLY touches records carrying this exact comment, so
  # it can never wipe a hand-edited DNS record (different or missing
  # comment) or a Traefik ACME challenge record.
  managedComment = "Managed by myStack.cloudflareRoutes";

  # Idempotent CF DNS reconciler:
  #   1. UPSERT — for each entry in cloudflareRoutes, ensure a proxied
  #      CNAME `<hostname> -> <tunnelId>.cfargotunnel.com` exists.
  #         missing          -> POST   (stamped with managedComment)
  #         matches exactly  -> no-op
  #         differs          -> PATCH  (content + proxied + comment)
  #   2. SWEEP — list every CNAME in the zone carrying `managedComment`;
  #      DELETE any whose name is not in the declared set. Removing
  #      `cloudflareRoutes.<name>` from nix + rebuild therefore also
  #      removes the CNAME.
  #
  # The comment-marker is load-bearing: it's the only filter that
  # prevents the sweep from touching unrelated records in the zone.
  routeSyncScript = pkgs.writeShellApplication {
    name = "cloudflared-route-sync";
    runtimeInputs = [ pkgs.curl pkgs.jq ];
    text = ''
      set -euo pipefail

      ZONE_ID='${zoneId}'
      TUNNEL_ID='${tunnelId}'
      MANAGED_COMMENT=${lib.escapeShellArg managedComment}
      TARGET="''${TUNNEL_ID}.cfargotunnel.com"

      if [[ -z "''${CF_DNS_API_TOKEN:-}" ]]; then
        echo "ERROR: CF_DNS_API_TOKEN not set in EnvironmentFile" >&2
        exit 1
      fi

      api() {
        local method="$1" path="$2"
        shift 2
        curl -sS -X "$method" \
          -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
          -H "Content-Type: application/json" \
          "$@" \
          "https://api.cloudflare.com/client/v4''${path}"
      }

      HOSTS=( ${lib.concatMapStringsSep " "
        (r: lib.escapeShellArg r.hostname)
        (lib.attrValues cfg.cloudflareRoutes)} )

      # --- 1. Upsert declared hostnames ----------------------------
      for HOST in "''${HOSTS[@]}"; do
        EXISTING=$(api GET "/zones/$ZONE_ID/dns_records?type=CNAME&name=$HOST")
        COUNT=$(echo "$EXISTING" | jq '.result | length')

        if [ "$COUNT" -eq 0 ]; then
          echo "[create] $HOST -> $TARGET"
          api POST "/zones/$ZONE_ID/dns_records" \
            -d "$(jq -n --arg n "$HOST" --arg c "$TARGET" --arg m "$MANAGED_COMMENT" \
              '{type:"CNAME",name:$n,content:$c,proxied:true,ttl:1,comment:$m}')" \
            | jq -e '.success' >/dev/null
        else
          RID=$(echo "$EXISTING" | jq -r '.result[0].id')
          CONTENT=$(echo "$EXISTING" | jq -r '.result[0].content')
          PROXIED=$(echo "$EXISTING" | jq -r '.result[0].proxied')
          COMMENT=$(echo "$EXISTING" | jq -r '.result[0].comment // ""')

          if [ "$CONTENT" = "$TARGET" ] && [ "$PROXIED" = "true" ] \
             && [ "$COMMENT" = "$MANAGED_COMMENT" ]; then
            echo "[ok]     $HOST -> $TARGET"
          else
            echo "[patch]  $HOST  $CONTENT (proxied=$PROXIED, comment=\"$COMMENT\") -> $TARGET (proxied=true, marked)"
            api PATCH "/zones/$ZONE_ID/dns_records/$RID" \
              -d "$(jq -n --arg c "$TARGET" --arg m "$MANAGED_COMMENT" \
                '{content:$c,proxied:true,comment:$m}')" \
              | jq -e '.success' >/dev/null
          fi
        fi
      done

      # --- 2. Sweep orphan managed records -------------------------
      # Fetch every CNAME in the zone (default page size 100 — fine
      # for a personal zone; if it ever exceeds that, add explicit
      # pagination). Filter to ours via the comment marker, then
      # delete any name not in the declared HOSTS set.
      ALL=$(api GET "/zones/$ZONE_ID/dns_records?type=CNAME&per_page=100")
      DECLARED=$(printf '%s\n' "''${HOSTS[@]}")

      while IFS=$'\t' read -r RID NAME; do
        [ -z "''${RID:-}" ] && continue
        if ! grep -qxF "$NAME" <<<"$DECLARED"; then
          echo "[delete] $NAME (orphan; was managed, no longer in cloudflareRoutes)"
          api DELETE "/zones/$ZONE_ID/dns_records/$RID" \
            | jq -e '.success' >/dev/null
        fi
      done < <(echo "$ALL" | jq -r --arg m "$MANAGED_COMMENT" \
        '.result | map(select(.comment == $m)) | .[] | .id + "\t" + .name')
    '';
  };
in

{
  myStack.containerNetworks.cloudflared = null;


  myStack.prometheusScrapes = [{
    job_name = "cloudflared";
    static_configs = [{ targets = [ "host.containers.internal:2000" ]; }];
  }];

  myStack.homepageServices."Network" = [{
    name = "Cloudflare Tunnel";
    href = "https://dash.cloudflare.com/${accountId}/tunnels/${tunnelId}/overview";
    description = "Outbound CF Tunnel (locally-managed ingress)";
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

    volumes = [
      "${configYml}:/etc/cloudflared/config.yml:ro"
      "/etc/nixos/stacks/cloudflared/secrets/credentials.json:/etc/cloudflared/credentials.json:ro"
    ];

    # Local-management mode: tunnel UUID + credentials file come from
    # config.yml, not TUNNEL_TOKEN. The `--config` flag is what flips
    # cloudflared from "fetch ingress from CF" to "use local ingress".
    cmd = [
      "tunnel"
      "--config" "/etc/cloudflared/config.yml"
      "--metrics" "0.0.0.0:2000"
      "--no-autoupdate"
      "run"
    ];

    extraOptions = [
      "--add-host=traefik:host-gateway"
      # Override the image's `nonroot` user (UID 65532 → host 165531
      # via subuid mapping) so cloudflared runs as container UID 0,
      # which maps to santiago (UID 1000) — the owner of the 0600
      # credentials.json bind-mounted from secrets/. Same idiom as
      # the linuxserver PUID=0 trick documented in CLAUDE.md.
      "--user=0:0"
    ];
  };

  # DNS reconciler. Runs on every nixos-rebuild (and at boot) before
  # cloudflared starts; safe if it runs while cloudflared is up too.
  # Re-runs on rebuild because both the script content (hostnames,
  # tunnelId) and the systemd unit are derived from the nix expression
  # — any change to cloudflareRoutes mutates the unit, which systemd
  # then restarts.
  systemd.services.cloudflared-route-sync = {
    description = "Reconcile CF DNS CNAMEs for myStack.cloudflareRoutes";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];
    before = [ "podman-cloudflared.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      EnvironmentFile = "/etc/nixos/stacks/cloudflared/secrets/env";
      ExecStart = "${routeSyncScript}/bin/cloudflared-route-sync";
      Restart = "on-failure";
      RestartSec = "10s";
    };
  };
}
