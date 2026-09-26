# ddclient — dynamic DNS for the house's public IP.
#
# Updates the Cloudflare A record for fleet.wanHost every 5 minutes if our
# home public IP changes. It authenticates with the box's one Cloudflare API
# token, whose only home is site/vault/cloudflare-api-token.sops (rendered as
# a dotenv file by platform/site.nix); a render unit below hands ddclient the
# bare value (ddclient runs as root).
#
# ── split horizon ─────────────────────────────────────────────────────────
#
# The same name is ALSO answered on the LAN with the box's own address, via
# the fleet.dnsHosts line below. That is what lets one address work from
# everywhere: a Minecraft client, a WireGuard profile or a bookmark carrying
# `fleet.wanHost` resolves to the LAN address at home and to the WAN address
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

{
  config,
  mkSecretRender,
  ...
}:

let
  inherit (config.fleet) wanHost;
  tokenDir = "/run/ddclient-token";
  tokenFile = "${tokenDir}/token";
in
{
  fleet.dnsHosts = [ "${config.fleet.lanIp} ${wanHost}" ];

  # ddclient's module splices passwordFile verbatim into `password=`, so it
  # needs the bare token, not the dotenv line it lives in. Rendered from the
  # one source rather than stored a second time. `LINE=$(grep …)` fails the
  # unit under `set -e` if the key is missing: an empty token here would only
  # surface the next time the WAN address changes, which is the worst moment.
  # A rotation (site/vault, rendered by platform/site.nix) re-renders the bare
  # token; ddclient itself reads it on its next timer run.
  sops.templates."cloudflare-api-token.env".restartUnits = [ "ddclient-token.service" ];

  systemd.services.ddclient-token = mkSecretRender {
    description = "Render the Cloudflare API token for ddclient";
    gates = [ "ddclient.service" ];
    dir = tokenDir;
    file = tokenFile;
    owner = "root";
    group = "root";
    prep = ''
      LINE=$(grep -m1 '^CF_DNS_API_TOKEN=' ${config.fleet.cloudflare.tokenEnvFile})
      TOKEN=$(printf '%s' "$LINE" | cut -d= -f2- | tr -d '"')
    '';
    content = "\${TOKEN}";
  };

  services.ddclient = {
    enable = true;
    protocol = "cloudflare";
    zone = config.fleet.baseDomain;
    # No `username`: ddclient 4 defaults `login` to `token` and sends the
    # password as a Bearer API token. Any other login (an email address, as
    # this once had) makes it send the password as the account's Global API
    # Key instead.
    passwordFile = tokenFile;
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
  # (accepted layering inversion: platform/ depending on a catalog unit —
  # ddclient is host plumbing but the box resolves through modules/pihole;
  # with that module off the `wants` names no unit and is a no-op)
  # without burning ~5s of DNS retries.
  systemd.services.ddclient = {
    after = [ "pihole-ready.service" ];
    wants = [ "pihole-ready.service" ];
  };
}
