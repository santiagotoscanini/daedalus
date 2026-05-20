# Pi-hole 6 — native NixOS service (NOT a container).
#
# Pi-hole 6 packaged via services.pihole-ftl + services.pihole-web
# (added late 2025 / early 2026 by upstream PR #361571). This replaces
# the docker pi-hole that used to run on the system docker daemon.
#
# All pi-hole *config* is declared here and rendered into
# /etc/pihole/pihole.toml as a read-only symlink into /nix/store (see
# the environment.etc override at the bottom). That makes the TOML
# truly immutable: even with misc.readOnly = true, the pi-hole API
# has a separate file-write code path (used by the teleporter import)
# that bypasses the readOnly flag and would corrupt the file — we hit
# this empirically. A symlink into /nix/store cannot be written to at
# all, so the UI can never break the config.
#
# Pi-hole *data* (gravity.db with blocklists/custom domains,
# pihole-FTL.db with query history, macvendor.db, tls.pem) lives in
# /var/lib/pihole and remains fully mutable — the UI can still manage
# blocklists, add/remove allow/deny domains, etc. (those changes are
# recorded in gravity.db, not in pihole.toml). The pihole user
# (UID 995) owns that directory.
#
# The settings below were translated 1:1 from the docker pi-hole's
# teleporter export. Two bare-metal adjustments: dns.interface
# changed from "eth0" (docker NIC) to "enp3s0" (host NIC);
# webserver.port is driven by services.pihole-web.ports below (plain
# HTTP on 8080, behind Traefik's TLS).
#
# Per-stack DNS entries can now be contributed via
# `myStack.dnsHosts` (see modules/common.nix). The literal list below
# is the legacy set — stacks haven't been migrated yet, except
# supabase whose entries flow in through the new option. Other stacks
# can drain into their owning modules over time.

{ config, lib, ... }:

{
  # Pi-hole's web UI gets routed via Traefik like everything else, but
  # the upstream isn't a container — file-provider rule dials the
  # native pihole-web on host.containers.internal:8080.
  myStack.webApps.pihole = {
    hostname = "pihole.toscanini.me";
    port = 8080;
  };

  myStack.homepageServices."Network" = [{
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
  }];

  services.pihole-ftl = {
    enable = true;
    openFirewallDNS = true;       # 53 TCP + UDP
    openFirewallDHCP = true;      # 67 UDP
    openFirewallWebserver = true; # 8080 TCP (from services.pihole-web.ports)

    settings = {
      dns = {
        interface = "enp3s0";
        listeningMode = "ALL";
        upstreams = [ "8.8.8.8" "8.8.4.4" ];
        bogusPriv = false;
        hosts = config.myStack.dnsHosts ++ [
          "192.168.0.120 gaming-pc.local.toscanini.me"
        ];
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
        # Static DHCP reservations: "MAC,IP,hostname"
        hosts = [
          "74:56:3C:CB:12:31,192.168.0.120,Gaming-PC"
          "F4:D4:88:85:CE:8C,192.168.0.100,MBP-Santiago"
          "80:A9:97:24:05:E6,192.168.0.101,MBP-Sofi"
          "96:AD:09:FF:6B:6E,192.168.0.102,GalaxyS20FE-Sofia"
          "3C:E4:41:5B:75:EE,192.168.0.202,EchoDot-Office"
          "0E:7C:E2:7A:01:AE,192.168.0.103,iPhone-Santiago"
          "C0:E7:BF:7B:DC:AE,192.168.0.207,SmartVacuum"
          "44:5D:5E:42:FB:3C,192.168.0.208,SmartUSB-Mousepad"
        ];
      };

      webserver = {
        # Preserve the admin password hash from the previous (docker)
        # pi-hole. The hash sits in /nix/store world-readable — for a
        # single-user home server this is acceptable; if it ever leaks
        # off-box, rotate via the UI (UI changes go into gravity-side
        # state, not pihole.toml, so they survive). The "real" file-
        # extraction migration would need an activation-script
        # workaround (the pihole-ftl module has no `pwhashFile`); see
        # the secrets discussion in CLAUDE.md.
        api.pwhash = "$BALLOON-SHA256$v=1$s=1024,t=32$c/EYhJu7DAKW0woakpKHsg==$1fjHBU91iHJ9Nx5mRCW8x7RiWbhmEDZPK5wx+qPXrS0=";
        # App password for the homepage widget. Hash of HOMEPAGE_VAR_PIHOLE_KEY
        # in /etc/nixos/containers/homepage/env (computed via nettle's
        # balloon_sha256 — same library pi-hole-FTL uses, so the digest
        # matches byte-for-byte). Generated declaratively because the
        # rendered pihole.toml is a read-only symlink into /nix/store, so
        # app passwords created via the UI never persist.
        api.app_pwhash = "$BALLOON-SHA256$v=1$s=1024,t=32$OeHTN/2zWCM7vQvqf4INHQ==$RT/Nw6suYL0rO4cDBGzB/KQPefmvRsWYg9szqpqKtws=";
        # Relaxed CSP from the teleporter (the upstream default is too
        # strict for Chart.js and inline scripts on this dashboard).
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
        # readOnly = true blocks the API config-write path so the UI
        # can't mutate the rendered TOML at runtime. The teleporter
        # file-write path is separately neutralized by making
        # /etc/pihole/pihole.toml a symlink into /nix/store (see
        # environment.etc override below). Net effect: pihole.toml is
        # fully reproducible from this nix file; UI changes only land
        # in /var/lib/pihole (gravity.db, etc.) which is intentional.
        readOnly = true;
      };
    };
  };

  services.pihole-web = {
    enable = true;
    ports = [ 8080 ];   # HTTP only — Traefik does TLS termination on 443
    hostName = "pihole.toscanini.me";
  };

  # Force /etc/pihole/pihole.toml to be a symlink into /nix/store
  # instead of a regular-file copy. The pihole-ftl module sets
  # mode = "400", which tells NixOS to copy the file into /etc;
  # NixOS's activation script then refuses to overwrite that copy on
  # subsequent rebuilds — so a teleporter-corrupted toml survives
  # across nixos-rebuild switch (we hit this empirically). As a
  # symlink, the file can never be written to (/nix/store is
  # read-only) and every rebuild re-points it at the latest rendered
  # toml — exactly the immutable-config behavior we want.
  environment.etc."pihole/pihole.toml".mode = lib.mkForce "symlink";
}
