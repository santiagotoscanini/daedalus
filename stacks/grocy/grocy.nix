# grocy — linuxserver PHP-FPM image. Split-horizon publish: LAN +
# CF tunnel reach the same hostname. Bridge-routed via traefik
# (`http://grocy:80`, no host port).
#
# PUID/PGID quirk: PHP-FPM's internal safety check refuses UID 0
# regardless of the kernel's view. Use the linuxserver default
# (PUID=911 / PGID=911) by NOT setting those env vars. Container UID
# 911 → host UID 100910 in the subuid range (100000 + 910); the data
# dir is chowned 100910:100910 to match.

{
  pkgs,
  mkRootlessContainer,
  ...
}:

{

  # linuxserver abc (uid 911) maps to host 100910; the config dir must
  # exist with that ownership or a fresh install fails on first write.
  fleet.statePaths = {
    "/home/santiago/selfhost/grocy/config".uid = 911;
    # data/ holds grocy.db — declared explicitly so a fresh restore
    # creates it abc-owned, not as a root mkdir -p side effect.
    "/home/santiago/selfhost/grocy/config/data".uid = 911;
    # Grocy reads highest-precedence settings from data/settingoverrides
    # (over env + config.php); the bind-mounted .txt files below land here.
    "/home/santiago/selfhost/grocy/config/data/settingoverrides".uid = 911;
  };
  fleet.webApps.grocy = {
    serviceName = "grocy";
    port = 80;
    exposeRemotely = true;
    # Pocket ID gate (AUTH.md tier 2). Everyone through the gate maps to
    # grocy's existing `admin` account (single-user; grocy data is shared,
    # not per-user). GROCY-API-KEY auth is checked before the header in
    # ReverseProxyAuthMiddleware, so the /api bypass keeps API clients
    # working — incl. the homepage widget, which dials through traefik
    # on the public hostname (isolated = no shared bridge with homepage).
    auth = "oidc";
    # Household app: santi + sofi, not admins-only.
    authGroups = [ "admins" "family" ];
    healthPath = "/login";
    isolated = true;
    authBypassRule = "PathPrefix(`/api`)";
    authHeaders."Remote-User" = "admin";
    homepage = {
      group = "Productivity";
      description = "Household inventory & chores";
      icon = "grocy.png";
      widget = {
        type = "customapi";
        # /api/stock/volatile?days=3 → {due_products, overdue_products,
        # expired_products, missing_products} — each is an array. `size`
        # counts entries, so each block is "items needing attention".
        # `missing_products` = below min_stock_amount; `due_products` =
        # best_before within the days window; `overdue_products` =
        # best_before already past; `expired_products` = past use_by.
        url = "https://grocy.toscanini.me/api/stock/volatile?days=3";
        refreshInterval = 300000;
        headers = {
          "GROCY-API-KEY" = "{{HOMEPAGE_VAR_GROCY_API_KEY}}";
        };
        mappings = [
          {
            field = "missing_products";
            label = "Missing";
            format = "size";
          }
          {
            field = "due_products";
            label = "Due";
            format = "size";
          }
          {
            field = "overdue_products";
            label = "Overdue";
            format = "size";
          }
          {
            field = "expired_products";
            label = "Expired";
            format = "size";
          }
        ];
      };
    };
  };

  virtualisation.oci-containers.containers.grocy = mkRootlessContainer {
    image = "docker.io/linuxserver/grocy:v4.6.0-ls334@sha256:35b2c85b1238f8249c9b349fb03619d1915917e61b2e4bff580729ec87397b4c";

    volumes = [
      "/home/santiago/selfhost/grocy/config:/config"
      # Enable reverse-proxy header auth declaratively (over config.php).
      "${pkgs.writeText "grocy-auth-class" "Grocy\\Middleware\\ReverseProxyAuthMiddleware"}:/config/data/settingoverrides/AUTH_CLASS.txt:ro"
      "${pkgs.writeText "grocy-auth-header" "Remote-User"}:/config/data/settingoverrides/REVERSE_PROXY_AUTH_HEADER.txt:ro"
    ];

  };
}
