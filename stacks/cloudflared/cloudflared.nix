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
#     CF_DNS_API_TOKEN from secrets/env. Idempotent.
#   - `secrets/credentials.json` carries `{AccountTag, TunnelID,
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

{ config, lib, pkgs, mkRootlessContainer, ... }:

let
  cfg = config.myStack;

  # Tunnel + account identifiers. Bound here so a tunnel rotation is
  # a single-line change (also referenced from the homepage tile).
  tunnelId  = "f67bc172-3096-4b17-961e-3cb3d1b5b523";
  accountId = "c08bf36c41d7bc5db11d6b35e0b4e721";

  yamlFormat = pkgs.formats.yaml { };

  configYml = yamlFormat.generate "cloudflared-config.yml" {
    tunnel = tunnelId;
    credentials-file = "/etc/cloudflared/credentials.json";
    ingress =
      (map
        (r: { hostname = r.hostname; service = r.service; })
        (lib.attrValues cfg.cloudflareRoutes))
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

      # 1. Upsert declared hostnames
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

      # 2. Sweep orphan managed records (default page size 100 is fine
      # for a personal zone; add pagination if it ever exceeds that).
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
  myStack.containerNetworks.cloudflared = "traefik";

  myStack.prometheusScrapes = [{
    job_name = "cloudflared";
    static_configs = [{ targets = [ "cloudflared:2000" ]; }];
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

    volumes = [
      "${configYml}:/etc/cloudflared/config.yml:ro"
      "/etc/nixos/stacks/cloudflared/secrets/credentials.json:/etc/cloudflared/credentials.json:ro"
    ];

    # `--config` flips cloudflared from "fetch ingress from CF" to
    # "use local ingress". `--metrics` exposes Prometheus on :2000
    # (reached over traefik-net, no host port).
    cmd = [
      "tunnel"
      "--config" "/etc/cloudflared/config.yml"
      "--metrics" "0.0.0.0:2000"
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
