# Pi-hole 6 — native NixOS service (NOT a container).
#
# Config lives in /etc/pihole/pihole.toml, which we force to a /nix/store
# symlink (see environment.etc override at bottom). That makes the TOML
# truly immutable: even with misc.readOnly = true, pi-hole's teleporter-
# import code path bypasses readOnly and would corrupt the file (hit
# empirically). A /nix/store symlink can't be written to at all.
#
# Pi-hole *data* (gravity.db blocklists/custom domains, pihole-FTL.db
# query history, macvendor.db, tls.pem) lives in /var/lib/pihole and
# is fully mutable — UI changes go there, not into pihole.toml.
#
# Per-stack DNS entries flow in via `myStack.dnsHosts`. The literal
# list below catches non-stack hosts.

{
  config,
  lib,
  pkgs,
  ...
}:

let
  hostEntries = config.myStack.dnsHosts ++ [
    "192.168.0.120 gaming-pc.local.toscanini.me"
  ];

  # Hostname half of each entry — used for the per-name `local=` lines below.
  localOnlyHostnames = map (e: lib.elemAt (lib.splitString " " e) 1) hostEntries;
in
{
  # Native NixOS service, not a container — traefik dials it through
  # pasta's host gateway alias instead of via traefik-net.
  myStack.webApps.pihole = {
    hostname = "pihole.toscanini.me";
    port = 8080;
    serviceUrl = "http://host.containers.internal:8080";
  };

  myStack.homepageServices."Network" = [
    {
      name = "Pi-hole";
      href = "https://pihole.toscanini.me";
      description = "LAN DNS, DHCP, ad-blocking";
      icon = "pi-hole.png";
      siteMonitor = "https://pihole.toscanini.me";
      widget = {
        type = "pihole";
        url = "http://host.containers.internal:8080";
        version = 6;
        key = "{{HOMEPAGE_VAR_PIHOLE_KEY}}";
      };
    }
  ];

  services.pihole-ftl = {
    enable = true;
    openFirewallDNS = true; # 53 TCP + UDP
    openFirewallDHCP = true; # 67 UDP
    # 8080 (admin web UI) is NOT opened to the LAN. traefik + the homepage
    # widget reach pihole-FTL's UI via host.containers.internal, which is
    # 192.168.0.2 -> 192.168.0.2 (host-to-self, routed over `lo` and accepted
    # by the firewall's `-i lo` rule). LAN devices (192.168.0.x on enp3s0)
    # hitting :8080 are dropped -> admin is HTTPS-only via pihole.toscanini.me.
    openFirewallWebserver = false; # 8080 TCP: LAN-blocked (see above)

    settings = {
      dns = {
        interface = "enp3s0";
        listeningMode = "ALL";
        upstreams = [
          "8.8.8.8"
          "8.8.4.4"
        ];
        bogusPriv = false;
        hosts = hostEntries;
        domain = {
          name = "lan";
          local = true;
        };
        reply.host.force4 = true;
      };

      dhcp = {
        active = true;
        router = "192.168.0.1";
        start = "192.168.0.100";
        end = "192.168.0.250";
        leaseTime = "8h";
        # Static reservations: "MAC,IP,hostname". s2-server is included for
        # LAN-DNS only — dnsmasq populates a `s2-server.lan → .2` A record
        # from this entry. No DHCP transaction (it IS the DHCP server;
        # static IP from configuration.nix).
        hosts = [
          "XX:XX:XX:XX:XX:00,192.168.0.2,s2-server"
          "XX:XX:XX:XX:XX:01,192.168.0.120,Gaming-PC"
          "XX:XX:XX:XX:XX:02,192.168.0.100,MBP-Santiago"
          "XX:XX:XX:XX:XX:03,192.168.0.101,MBP-B"
          "XX:XX:XX:XX:XX:04,192.168.0.102,Galaxy-B"
          "XX:XX:XX:XX:XX:05,192.168.0.202,EchoDot-Office"
          "XX:XX:XX:XX:XX:06,192.168.0.103,iPhone-Santiago"
          "XX:XX:XX:XX:XX:07,192.168.0.207,SmartVacuum"
          "XX:XX:XX:XX:XX:08,192.168.0.208,SmartUSB-Mousepad"
        ];
      };

      webserver = {
        # Admin password hash. World-readable via /nix/store — acceptable
        # for a single-user home server; rotate via UI if leaked (UI
        # password changes go into gravity-side state, which survives).
        api.pwhash = "$BALLOON-SHA256$v=1$s=1024,t=32$c/EYhJu7DAKW0woakpKHsg==$1fjHBU91iHJ9Nx5mRCW8x7RiWbhmEDZPK5wx+qPXrS0=";
        # App password for the homepage widget. balloon_sha256 of
        # HOMEPAGE_VAR_PIHOLE_KEY from homepage/secrets/env. Declared here
        # because UI-created app passwords don't persist (toml is RO).
        api.app_pwhash = "$BALLOON-SHA256$v=1$s=1024,t=32$OeHTN/2zWCM7vQvqf4INHQ==$RT/Nw6suYL0rO4cDBGzB/KQPefmvRsWYg9szqpqKtws=";
        # Relaxed CSP (upstream default is too strict for Chart.js inline scripts).
        headers = [
          "X-DNS-Prefetch-Control: off"
          "Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;"
          "X-Frame-Options: DENY"
          "X-XSS-Protection: 0"
          "X-Content-Type-Options: nosniff"
          "Referrer-Policy: strict-origin-when-cross-origin"
        ];
      };

      misc = {
        # Blocks the API config-write path. Paired with the /nix/store
        # symlink override below, pihole.toml is fully reproducible from
        # this file; UI changes only land in /var/lib/pihole.
        readOnly = true;

        # Per-name `local=` (not zone-wide). For each LAN-resolved name,
        # dnsmasq answers exclusively from local sources: A → 192.168.0.2,
        # AAAA → NODATA. Kills the iOS Happy-Eyeballs trap where an
        # upstream-forwarded AAAA returns CF anycast IPv6 for tunnel-
        # proxied hostnames and outraces the LAN A. Names NOT in
        # dns.hosts fall through to upstreams normally (so apex
        # `toscanini.me`, blog, travel, etc. resolve to their real
        # public records — previous zone-wide `local=/toscanini.me/`
        # NXDOMAIN'd all of them).
        dnsmasq_lines = map (h: "local=/${h}/") localOnlyHostnames;
      };
    };
  };

  services.pihole-web = {
    enable = true;
    ports = [ 8080 ]; # HTTP only — traefik terminates TLS on 443
    hostName = "pihole.toscanini.me";
  };

  # Force a /nix/store symlink (not a copy). The pihole-ftl module sets
  # mode="400", which makes NixOS copy the file into /etc and then refuse
  # to overwrite it on rebuilds — so a teleporter-corrupted toml survives
  # across nixos-rebuild switch (hit empirically). As a symlink, the file
  # can never be written to and every rebuild re-points it at the latest
  # rendered toml.
  environment.etc."pihole/pihole.toml".mode = lib.mkForce "symlink";

  # pihole-ftl is Type=simple — it declares "active" the instant the FTL
  # process starts, well before it's loaded gravity.db and bound :53. So
  # `After=pihole-ftl.service` only orders, it doesn't wait for readiness.
  # This oneshot polls upstream DNS until it actually resolves, providing
  # a readiness gate for anything that does DNS at boot — depend on
  # pihole-ready.service instead of pihole-ftl.service.
  systemd.services.pihole-ready = {
    description = "Gate: pi-hole is actually answering DNS queries";
    after = [
      "pihole-ftl.service"
      "network-online.target"
    ];
    wants = [
      "pihole-ftl.service"
      "network-online.target"
    ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = pkgs.writeShellScript "wait-pihole-dns" ''
        for i in $(seq 1 60); do
          ${pkgs.curl}/bin/curl -s --max-time 1 -o /dev/null --head \
            https://api.cloudflare.com/ && exit 0
          sleep 0.25
        done
        # Don't block boot forever if upstream DNS is unreachable.
        exit 0
      '';
    };
  };
}
