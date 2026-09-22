# grocy — household ERP (groceries, chores, recipes), the linuxserver
# PHP-FPM image. Bridge-routed via the proxy (`http://grocy:80`, no host
# port) on an isolated bridge, since it trusts the identity header.
#
# PUID/PGID quirk: PHP-FPM's internal safety check refuses UID 0
# regardless of the kernel's view. Use the linuxserver default
# (PUID=911 / PGID=911) by NOT setting those env vars. Container UID
# 911 → host UID 100910 in the subuid range (100000 + 910); the data
# dir is chowned 100910:100910 to match.
#
# Auth: the identity provider's gate, and everyone through it maps to
# grocy's `admin` account (its data is shared, not per-user). API clients
# keep working through the /api bypass: GROCY-API-KEY is checked before
# the header in ReverseProxyAuthMiddleware — that is how the control plane
# reads it, through the proxy on the public hostname.
#
# The host brings:
#   fleet.modules.grocy.enable          the switch (default off, as every catalog module)
#   fleet.modules.grocy.authGroups      who may log in (default: admins)
#   fleet.modules.grocy.exposeRemotely  reachable through the tunnel (default false)
#   fleet.images.grocy                  the digest-pinned image

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  pinnedImage,
  ...
}:

let
  cfg = config.fleet.modules.grocy;
in
{
  options.fleet.modules.grocy = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Grocy — household ERP: groceries, chores, recipes.";
    };

    authGroups = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "admins" ];
      description = ''
        Identity-provider groups allowed through the login gate. Policy, so
        the host's: a household that shares the inventory adds its own group.
      '';
      example = [
        "admins"
        "household"
      ];
    };

    exposeRemotely = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Publish it through the tunnel as well as on the LAN — a phone at the
        shop. Off by default: declaring a stack must not widen the box's
        public surface by itself. The identity provider must be exposed the
        same way (its module asserts so).
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # linuxserver abc (uid 911) maps to host 100910; the config dir must
    # exist with that ownership or a fresh install fails on first write.
    fleet.statePaths = {
      "${config.fleet.stateRoot}/grocy/config".uid = 911;
      # data/ holds grocy.db — declared explicitly so a fresh restore
      # creates it abc-owned, not as a root mkdir -p side effect.
      "${config.fleet.stateRoot}/grocy/config/data".uid = 911;
      # Grocy reads highest-precedence settings from data/settingoverrides
      # (over env + config.php); the bind-mounted .txt files below land here.
      "${config.fleet.stateRoot}/grocy/config/data/settingoverrides".uid = 911;
    };
    fleet.webApps.grocy = {
      serviceName = "grocy";
      port = 80;
      inherit (cfg) exposeRemotely authGroups;
      auth = "oidc";
      healthPath = "/login";
      isolated = true;
      authBypassRule = "PathPrefix(`/api`)";
      authHeaders."Remote-User" = "admin";
    };
    # Consent screen and the identity provider's My Apps page.
    fleet.ssoClients.grocy = {
      description = "Household inventory & chores";
    };

    virtualisation.oci-containers.containers.grocy = mkRootlessContainer {
      image = pinnedImage "grocy" "docker.io/linuxserver/grocy";

      volumes = [
        "${config.fleet.stateRoot}/grocy/config:/config"
        # Enable reverse-proxy header auth declaratively (over config.php).
        "${pkgs.writeText "grocy-auth-class" "Grocy\\Middleware\\ReverseProxyAuthMiddleware"}:/config/data/settingoverrides/AUTH_CLASS.txt:ro"
        "${pkgs.writeText "grocy-auth-header" "Remote-User"}:/config/data/settingoverrides/REVERSE_PROXY_AUTH_HEADER.txt:ro"
      ];

    };
  };
}
