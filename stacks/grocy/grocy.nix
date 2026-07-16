# grocy — linuxserver PHP-FPM image. Split-horizon publish: LAN +
# CF tunnel reach the same hostname. Bridge-routed via traefik
# (`http://grocy:80`, no host port).
#
# PUID/PGID quirk: PHP-FPM's internal safety check refuses UID 0
# regardless of the kernel's view. Use the linuxserver default
# (PUID=911 / PGID=911) by NOT setting those env vars. Container UID
# 911 → host UID 100910 in the subuid range (100000 + 910); the data
# dir is chowned 100910:100910 to match.

{ config, mkRootlessContainer, ... }:

{
  myStack.containerNetworks.grocy = "traefik";
  myStack.webApps.grocy = {
    hostname = "grocy.toscanini.me";
    serviceName = "grocy";
    port = 80;
    exposeRemotely = true;
  };

  myStack.homepageServices."Productivity" = [
    {
      name = "Grocy";
      href = "https://grocy.toscanini.me";
      description = "Household inventory & chores";
      icon = "grocy.png";
      siteMonitor = "https://grocy.toscanini.me";
      widget = {
        type = "customapi";
        # /api/stock/volatile?days=3 → {due_products, overdue_products,
        # expired_products, missing_products} — each is an array. `size`
        # counts entries, so each block is "items needing attention".
        # `missing_products` = below min_stock_amount; `due_products` =
        # best_before within the days window; `overdue_products` =
        # best_before already past; `expired_products` = past use_by.
        url = "http://grocy:80/api/stock/volatile?days=3";
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
    }
  ];

  virtualisation.oci-containers.containers.grocy = mkRootlessContainer {
    image = "docker.io/linuxserver/grocy:v4.6.0-ls332@sha256:20aaee6b741178035a0c538c87917a8d72113ce2686368183a28f38e823f785c";

    volumes = [
      "/home/santiago/selfhost/grocy/config:/config"
    ];

    extraOptions = [
      "--network=traefik-net"
    ];
  };
}
