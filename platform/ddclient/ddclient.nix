# ddclient — dynamic DNS for the LAN public IP.
#
# Updates the Cloudflare A record for fleet.wanHost every 5 minutes if our
# home public IP changes. The API token lives at cloudflare-token.sops
# (sops-encrypted; ddclient runs as root).
#
# ── split horizon ─────────────────────────────────────────────────────────
#
# The same name is ALSO answered on the LAN with the box's own address, via
# the fleet.dnsHosts line below. That is what lets one address work from
# everywhere: a Minecraft client, a WireGuard profile or a bookmark carrying
# `s2.toscanini.me` resolves to 192.168.0.2 at home and to the WAN address
# from a hotel, with nothing to change in between.
#
# It also means LAN traffic stops leaving the house and coming back in
# through the router's NAT hairpin to reach a box on the same switch.
#
# Both halves read one option, so the record this job maintains and the
# override pi-hole serves cannot drift apart. Note that this override is
# invisible to ddclient itself: `usev4 = "webv4"` reads the current address
# from cloudflare.com/cdn-cgi/trace and reconciles against the Cloudflare
# API, never by resolving its own name — so pi-hole answering differently
# cannot make it flap or go stale.

{ config, ... }:

let
  inherit (config.fleet) wanHost;
in
{
  fleet.dnsHosts = [ "${config.fleet.lanIp} ${wanHost}" ];

  # Cloudflare API token, sops-encrypted (cloudflare-token.sops). ddclient runs
  # as root; default root-owned /run/secrets path is correct.
  sops.secrets."ddclient-password" = {
    sopsFile = ./cloudflare-token.sops;
    format = "binary";
  };

  services.ddclient = {
    enable = true;
    protocol = "cloudflare";
    zone = "toscanini.me";
    username = "cloudflare@account.toscanini.me";
    passwordFile = config.sops.secrets."ddclient-password".path;
    ssl = true;
    usev4 = "webv4";
    usev6 = "disabled";
    extraConfig = ''
      ttl=1
      webv4=https://cloudflare.com/cdn-cgi/trace
      webv4-skip='ip='
    '';
    domains = [ wanHost ];
    interval = "300s";
  };

  # First-boot race: ddclient hits cloudflare.com before pi-hole is
  # actually serving DNS. Gate on pihole-ready so the first run resolves
  # (accepted layering inversion: platform/ depending on a stacks/ unit —
  # ddclient is host plumbing but the box resolves through the pihole stack)
  # without burning ~5s of DNS retries.
  systemd.services.ddclient = {
    after = [ "pihole-ready.service" ];
    wants = [ "pihole-ready.service" ];
  };
}
