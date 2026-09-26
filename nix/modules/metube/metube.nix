# metube — yt-dlp web UI.
#
# Standalone (no VPN); joins the reverse proxy's bridge so it is dialled at
# `http://metube:8081`, no host port published. Writes into a directory the
# host names — on the reference host, the videos folder of a media library,
# so anything pulled here surfaces there.
#
# UID/GID env vars on this image are `UID`/`GID` (not the linuxserver
# `PUID`/`PGID`). Container UID 0 maps to the operator in the rootless
# setup, so UID=0 GID=0 = run as the user that owns the downloads dir.
#
# The host brings:
#   fleet.modules.metube.enable        the switch (default off, as every catalog module)
#   fleet.modules.metube.downloadsDir  where downloads land (required)
#   fleet.modules.metube.authGroups    who may log in (default: admins)
#   fleet.images.metube                the digest-pinned image

{
  config,
  lib,
  mkRootlessContainer,
  pinnedImage,
  ...
}:

let
  cfg = config.fleet.modules.metube;
in
{
  options.fleet.modules.metube = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "MeTube — yt-dlp web UI.";
    };

    downloadsDir = lib.mkOption {
      type = lib.types.str;
      example = lib.literalExpression ''"''${config.fleet.data.media}/videos"'';
      description = ''
        Host directory downloads are written to, owned by the operator (the
        container runs as uid 0, which is them). Named by the host because
        it is usually a corner of a library another stack owns.
      '';
    };

    authGroups = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "admins" ];
      description = ''
        Identity-provider groups allowed through the login gate. Policy, so
        the host's: a household that shares the downloader adds its own
        group.
      '';
      example = [
        "admins"
        "household"
      ];
    };
  };

  config = lib.mkIf cfg.enable {
    fleet.bridgeMemberships.metube = [ "traefik" ];
    fleet.webApps.metube = {
      serviceName = "metube";
      port = 8081;
      # No auth of its own (upstream: none planned), so the identity
      # provider's gate is the only thing in front of it.
      auth = "oidc";
      inherit (cfg) authGroups;
      healthPath = "/favicon.ico";
      # The control plane is `isolated` (off the proxy's shared bridge), so
      # it cannot dial metube container-direct; it reads the queue through
      # this hostname instead. GET only, and only that one path; every
      # mutating route (/add, /delete, the socket.io channel) still goes
      # through the login gate.
      authBypassRule = "Method(`GET`) && Path(`/history`)";
    };
    # Consent screen and the identity provider's My Apps page.
    fleet.ssoClients.metube = {
      displayName = "MeTube";
      description = "yt-dlp web UI";
    };

    virtualisation.oci-containers.containers.metube = mkRootlessContainer {
      image = pinnedImage "metube" "ghcr.io/alexta69/metube";

      volumes = [
        "${cfg.downloadsDir}:/downloads"
      ];

      environment = {
        UID = "0";
        GID = "0";
        # Default INFO logs "Sending download history" to stderr on every
        # poll — journald err-priority noise.
        LOGLEVEL = "WARNING";
      };

    };
  };
}
