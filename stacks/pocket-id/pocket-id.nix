# pocket-id — OIDC identity provider (passkey-only) for the box-wide
# SSO plan (see /etc/nixos/AUTH.md). Every service that can speak OIDC
# authenticates against this; everything else will sit behind a
# traefik forward-auth middleware that itself authenticates here.
#
# Single Go binary + SQLite. Signing keys + DB are generated on first
# boot under /app/data; the only operator secret is ENCRYPTION_KEY
# (env.sops) which encrypts the signing keys at rest — the app refuses
# to start without it. Rotating it requires re-encrypting stored keys,
# so treat it as fixed once set.
#
# First-boot setup is INTERACTIVE — open https://id.toscanini.me/setup
# once to create the admin account and register a passkey; there is no
# seed/env bootstrap.
#
# Passkey-only by design: EMAIL_ONE_TIME_ACCESS_* stays unset (off).
# Recovery if all passkeys are lost: the sqlite DB under
# ~/selfhost/pocket-id/data rides rpool/selfhost snapshots, and
# `pocket-id one-time-access-token <user>` inside the container mints
# a login link from the CLI.
#
# exposeRemotely: the IdP must be reachable through the CF tunnel —
# remote-exposed apps (nextcloud, immich, grocy, wealthfolio, anansi)
# redirect here for login from off-LAN. APP_URL pins absolute URLs to
# https regardless of the plain-HTTP cfweb entrypoint.
#
# Image sets no USER → container root → host santiago (1000:100),
# which owns the data dir. Listens on 1411 (v2 unified port).

{
  config,
  mkRootlessContainer,
  mkDotenvSecret,
  ...
}:

{
  # ENCRYPTION_KEY: sops-encrypted env.sops, decrypted to
  # /run/secrets/pocket-id-env at activation. Edit with `sops env.sops`.
  sops.secrets."pocket-id-env" = mkDotenvSecret ./env.sops;

  myStack.containerNetworks.pocket-id = "traefik";

  myStack.webApps.pocket-id = {
    hostname = "id.toscanini.me";
    serviceName = "pocket-id";
    port = 1411;
    exposeRemotely = true;
    homepage = {
      group = "Network";
      name = "Pocket ID";
      description = "OIDC provider — passkey SSO for all web UIs";
      icon = "pocket-id.png";
    };
  };

  systemd.tmpfiles.rules = [
    "d /home/santiago/selfhost/pocket-id 0755 santiago users -"
    "d /home/santiago/selfhost/pocket-id/data 0700 santiago users -"
  ];

  virtualisation.oci-containers.containers.pocket-id = mkRootlessContainer {
    image = "ghcr.io/pocket-id/pocket-id:v2.11.0@sha256:8457defd3c58d59faf11effa1a682e94c723499930b13a359bf29f5ea0317584";

    volumes = [
      "/home/santiago/selfhost/pocket-id/data:/app/data"
    ];

    environmentFiles = [ config.sops.secrets."pocket-id-env".path ];

    environment = {
      APP_URL = "https://id.toscanini.me";
      ANALYTICS_DISABLED = "true";
      # Traefik fronts everything; without this the audit log records
      # the bridge IP instead of the real client.
      TRUST_PROXY = "true";
    };

    extraOptions = [
      "--network=traefik-net"
    ];
  };
}
