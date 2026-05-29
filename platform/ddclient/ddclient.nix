# ddclient — dynamic DNS for the LAN public IP.
#
# Updates the Cloudflare A record for s2.toscanini.me every 5 minutes
# if our home public IP changes. The API token lives at
# secrets/password (mode 0600 root:root — ddclient runs as root).
#
# Long-term plan: migrate this secret (and every other on-disk env /
# password under stacks/*/secrets) to sops-nix.

{ ... }:

{
  services.ddclient = {
    enable = true;
    protocol = "cloudflare";
    zone = "toscanini.me";
    username = "cloudflare@account.toscanini.me";
    passwordFile = "/etc/nixos/platform/ddclient/secrets/password";
    ssl = true;
    usev4 = "webv4, webv4=https://cloudflare.com/cdn-cgi/trace, web-skip='ip='";
    usev6 = "disabled";
    extraConfig = "ttl=1\n";
    domains = [ "s2.toscanini.me" ];
    interval = "300s";
  };

  # First-boot race: ddclient hits cloudflare.com before pi-hole is
  # actually serving DNS. Gate on pihole-ready so the first run resolves
  # without burning ~5s of DNS retries.
  systemd.services.ddclient = {
    after = [ "pihole-ready.service" ];
    wants = [ "pihole-ready.service" ];
  };
}
