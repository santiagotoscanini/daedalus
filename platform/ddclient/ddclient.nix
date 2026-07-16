# ddclient — dynamic DNS for the LAN public IP.
#
# Updates the Cloudflare A record for s2.toscanini.me every 5 minutes
# if our home public IP changes. The API token lives at
# password.sops (sops-encrypted; ddclient runs as root).
#

{ config, ... }:

{
  # Cloudflare API token, sops-encrypted (password.sops). ddclient runs
  # as root; default root-owned /run/secrets path is correct.
  sops.secrets."ddclient-password" = {
    sopsFile = ./password.sops;
    format = "binary";
  };

  services.ddclient = {
    enable = true;
    protocol = "cloudflare";
    zone = "toscanini.me";
    username = "cloudflare@account.toscanini.me";
    passwordFile = config.sops.secrets."ddclient-password".path;
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
