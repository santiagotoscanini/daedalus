# The fleet's per-service read-only API keys — the credentials the control
# plane reads other services' numbers with — rendered into the env file its
# container reads (`DASH_<n>`), beside the box's Cloudflare token. Part of the
# daedalus stack (daedalus.nix holds the switch); never imports its siblings.
#
# Two keys are NOT in the host's file, on purpose: pocket-id's read-only key
# and the litellm master key each reach the container as an env file THAT
# stack renders (fleet.dashboard.<id>.envFiles), so nothing in the secret tree
# exists twice and this module never greps another stack's secret. A missing
# key renders empty and its panel shows no data, rather than the page
# failing. The render dir is not /run/app-daedalus: that is the container
# unit's RuntimeDirectory, wiped whenever the container stops.
{
  config,
  lib,
  mkDotenvSecret,
  mkSecretRender,
  ...
}:

{
  options.fleet.daedalus.serviceKeysSopsFile = lib.mkOption {
    type = lib.types.path;
    example = lib.literalExpression "./sops/service-keys.sops";
    description = ''
      The sops-encrypted dotenv of per-service read-only API keys the control
      plane reads other services' numbers with (rendered as `DASH_<n>`). The
      host's file, handed in: every key in it was minted by a service on that
      box. A key missing from it renders empty and its panel shows no data.
    '';
  };

  config = lib.mkIf config.fleet.modules.daedalus.enable {
    sops.secrets."daedalus-service-keys" = mkDotenvSecret config.fleet.daedalus.serviceKeysSopsFile;

    # A rotation of the Cloudflare token (site/vault, rendered by
    # platform/site.nix): re-render the keys, then restart the app that reads
    # them at start.
    sops.templates."cloudflare-api-token.env".restartUnits = [
      "daedalus-dashboard-keys.service"
      "podman-app-daedalus.service"
    ];

    systemd.services."daedalus-dashboard-keys" =
      let
        store = config.sops.secrets."daedalus-service-keys".path;
        # <n> in the store → DASH_<n> in the container's environment.
        serviceKeys = [
          "JELLYFIN_API_KEY"
          "SONARR_API_KEY"
          "RADARR_API_KEY"
          "BAZARR_API_KEY"
          "PROWLARR_API_KEY"
          "SEERR_API_KEY"
          "QBT_USER"
          "QBT_PASS"
          "IMMICH_API_KEY"
          "NEXTCLOUD_KEY"
          "HASS_API_KEY"
          "GROCY_API_KEY"
          "N8N_API_KEY"
          "OPENWEBUI_KEY"
          "CALIBREWEB_USER"
          "CALIBREWEB_PASS"
          "GRAFANA_USER"
          "GRAFANA_PASS"
          "HEALTHCHECKS_API_KEY"
          "WGEASY_USER"
          "WGEASY_PASS"
        ];
      in
      mkSecretRender {
        description = "Render the per-service API keys daedalus's dashboard reads";
        gates = [ "podman-app-daedalus.service" ];
        dir = "/run/daedalus-dashboard";
        file = "/run/daedalus-dashboard/env";
        prep = lib.concatStringsSep "\n" (
          map (k: "${k}=$(grep -m1 '^${k}=' ${store} | cut -d= -f2- || true)") serviceKeys
          ++ [
            # The box's one Cloudflare API token, read from its single encrypted
            # home (site/vault, rendered by platform/site.nix — platform, not a
            # stack, which is what makes this a read of the box's own secret
            # rather than another stack's). One token carries every scope
            # daedalus reads with: Zone:Read + DNS for the domain picker and
            # the DNS panel, "Cloudflare One Connector: cloudflared" Read for
            # the tunnel panels. It is DNS-edit-capable (lego and route-sync
            # need that); daedalus only ever GETs with it.
            "CF_TOKEN=$(grep -m1 '^CF_DNS_API_TOKEN=' ${config.fleet.cloudflare.tokenEnvFile} | cut -d= -f2- | tr -d '\"' || true)"
            # No GitHub token is rendered here: the GitHub reads use the App's
            # installation token (GITHUB_TOKEN_PATH).
          ]
        );
        content = lib.concatStringsSep "\n" (
          map (k: "DASH_${k}=\${${k}}") serviceKeys ++ [ "DASH_CF_API_TOKEN=\${CF_TOKEN}" ]
        );
        # Each read above tolerates a missing key (`|| true`): a panel whose
        # key is absent says "no data" rather than the page failing.
        optional = serviceKeys ++ [ "CF_TOKEN" ];
      };
  };
}
