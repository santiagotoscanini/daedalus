# The fleet's per-service read-only API keys — the credentials the control
# plane reads other services' numbers with — rendered into the env file its
# container reads (`DASH_<n>`), beside the box's Cloudflare token. Each stack
# names the keys it is read with (`fleet.dashboard.<id>.serviceKeys`, inside
# its own switch); the values are the host's one sops file. Part of the
# daedalus stack (daedalus.nix holds the switch); never imports its siblings.
#
# A stack that already keeps its key in its own secret renders that copy
# itself (fleet.dashboard.<id>.envFiles: pocket-id's, litellm's), so nothing
# in the secret tree exists twice and this module never greps another stack's
# secret. A missing key renders empty and its panel shows no data, rather than
# the page failing. The render dir is not /run/app-daedalus: that is the
# container unit's RuntimeDirectory, wiped whenever the container stops.
{
  config,
  lib,
  mkDotenvSecret,
  mkSecretRender,
  ...
}:

let
  storeFile = config.fleet.daedalus.serviceKeysSopsFile;

  # <n> in the store → DASH_<n> in the container's environment: every key a
  # switched-on stack asks for, once, in name order.
  serviceKeys = lib.optionals (storeFile != null) (
    lib.sort lib.lessThan (
      lib.unique (lib.concatMap (d: d.serviceKeys) (lib.attrValues config.fleet.dashboard))
    )
  );
in
{
  options.fleet.daedalus.serviceKeysSopsFile = lib.mkOption {
    type = lib.types.nullOr lib.types.path;
    default = null;
    example = lib.literalExpression "./sops/service-keys.sops";
    description = ''
      The sops-encrypted dotenv of per-service read-only API keys the control
      plane reads other services' numbers with (the keys each stack names in
      `fleet.dashboard.<id>.serviceKeys`, rendered as `DASH_<n>`). The host's
      file, handed in: every key in it was minted by a service on that box.
      Null renders none.
    '';
  };

  config = lib.mkIf config.fleet.modules.daedalus.enable {
    sops.secrets."daedalus-service-keys" = lib.mkIf (storeFile != null) (mkDotenvSecret storeFile);

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
      in
      mkSecretRender {
        description = "Render the per-service API keys daedalus's dashboard reads";
        gates = [ "podman-app-daedalus.service" ];
        dir = "/run/daedalus-dashboard";
        file = "/run/daedalus-dashboard/env";
        prep = lib.concatStringsSep "\n" (
          map (k: "${k}=$(grep -m1 '^${k}=' ${store} | cut -d= -f2- || true)") serviceKeys
          ++ [
            # The box's one Cloudflare API token, from its single encrypted
            # home (site/vault, rendered by platform/site.nix). It carries
            # every scope daedalus reads with — Zone:Read + DNS for the domain
            # picker and the DNS panel, the tunnel connector's Read for the
            # tunnel panels — and DNS edit for lego and route-sync; daedalus
            # only ever GETs with it. The GitHub reads use the App's
            # installation token (GITHUB_TOKEN_PATH), not a key here.
            "CF_TOKEN=$(grep -m1 '^CF_DNS_API_TOKEN=' ${config.fleet.cloudflare.tokenEnvFile} | cut -d= -f2- | tr -d '\"' || true)"
          ]
        );
        content = lib.concatStringsSep "\n" (
          map (k: "DASH_${k}=\${${k}}") serviceKeys ++ [ "DASH_CF_API_TOKEN=\${CF_TOKEN}" ]
        );
        # Each read above tolerates a missing key (`|| true`).
        optional = serviceKeys ++ [ "CF_TOKEN" ];
      };
  };
}
