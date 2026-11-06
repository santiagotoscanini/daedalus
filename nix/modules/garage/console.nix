# garage/console.nix — a web console for the object store: Noooste's
# garage-ui (https://github.com/Noooste/garage-ui).
#
# Garage ships no UI of its own yet: Deuxfleurs' garage-webadmin is a
# pre-release with no image and no object browser, its embedding into the
# binary still a work in progress. garage-ui is maintained, speaks the v2 admin
# API, keeps the admin token on its backend (the browser talks only to the
# console), reads secrets from env files, and browses objects.
#
# Shape:
#   - `garage-ui` on garage-net, `garage.<baseDomain>` through traefik, LAN
#     only. Its own OIDC client at the identity provider (no forward-auth: the
#     console needs the identity itself), restricted to `authGroups`; the
#     console additionally refuses a login whose `groups` claim carries none of
#     them. Its password and Garage-token logins stay off — the latter always
#     grants full admin, whatever the token's scope.
#   - `garage-console-bootstrap.service` — mints the console's admin-API token
#     over the RPC loopback with exactly the endpoints it calls (`scope`
#     below), never `*` and never the layout or token endpoints.
#     assets/console-bootstrap.sh.
#   - Read-only root, sessions signed by a key generated per start in a tmpfs:
#     a restart signs everyone out, and the console keeps no state at all.
#
# What its token can do, said plainly: everything an operator does to buckets
# and keys, and READ EVERY ACCESS KEY'S SECRET — the object browser has no S3
# key of its own and borrows, per bucket, a key that already has access
# (`GetKeyInfo` with the secret). That is why the console is admins-only, and
# why it is a switch of its own. Buckets made for tenants are declared: the
# console can delete an app's key, and the bucket bootstrap then fails until
# the app's env file is deleted and a new key minted
# (assets/bucket-bootstrap.sh).
#
# The host brings:
#   fleet.modules.garage.console.enable   the switch (default off)
#   fleet.images.garage-ui                the digest-pinned image

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  pinnedImage,
  ...
}:

let
  cfg = config.fleet.modules.garage.console;
  on = config.fleet.modules.garage.enable && cfg.enable;

  envFile = "${config.fleet.machineState}/garage/console/env";
  host = config.fleet.webApps.garage.hostname;

  # Every admin endpoint the console's v2 client calls (its admin_v2.go), and
  # nothing else: no layout, no admin tokens, no workers, blocks or repairs —
  # it has no page for those, and `CreateAdminToken` in a scope is `*`.
  scope = [
    "GetClusterHealth"
    "GetClusterStatus"
    "GetClusterStatistics"
    "GetNodeInfo"
    "GetNodeStatistics"
    "ListBuckets"
    "GetBucketInfo"
    "CreateBucket"
    "UpdateBucket"
    "DeleteBucket"
    "AddBucketAlias"
    "RemoveBucketAlias"
    "AllowBucketKey"
    "DenyBucketKey"
    "ListKeys"
    "GetKeyInfo"
    "CreateKey"
    "ImportKey"
    "UpdateKey"
    "DeleteKey"
  ];

  bootstrap = pkgs.writeShellApplication {
    name = "garage-console-bootstrap";
    runtimeInputs = [
      pkgs.podman
      pkgs.coreutils
      pkgs.gnugrep
      pkgs.jq
    ];
    text = ''
      ENV_FILE=${lib.escapeShellArg envFile}
      TOKEN_NAME=garage-ui
      SCOPE=${lib.escapeShellArg (builtins.toJSON scope)}
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}

      ${builtins.readFile ./assets/console-bootstrap.sh}
    '';
  };
in
{
  options.fleet.modules.garage.console = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "garage-ui, a web console for the object store: cluster health, buckets, keys and an object browser, signed in through the identity provider.";
    };
    authGroups = lib.mkOption {
      type = lib.types.nonEmptyListOf lib.types.str;
      default = [ "admins" ];
      description = ''
        Identity-provider groups allowed into the console, enforced twice: by
        the provider (the client's allowed groups) and by the console (the
        `groups` claim). Everyone admitted is a full admin of the store and can
        read every access key's secret, so keep this to the operators.
      '';
    };
  };

  config = lib.mkIf on {
    fleet.bridgeMemberships.garage-ui = [ "garage" ];
    fleet.logStacks.garage = [ "garage-ui" ];

    fleet.webApps.garage = {
      hostname = lib.mkDefault "garage.${config.fleet.baseDomain}";
      serviceName = "garage-ui";
      port = 8080;
      # Static "healthy" from the console's own process; Garage's health is
      # the store's probe and alert, not this one's.
      healthPath = "/health";
    };

    fleet.ssoClients.garage-ui = {
      displayName = "Garage";
      description = "Object storage console";
      launchURL = "https://${host}";
      callbackURLs = [ "https://${host}/auth/oidc/callback" ];
      allowedGroups = cfg.authGroups;
      # Its OIDC flow sends state but no code verifier; a confidential client.
      pkce = false;
      consumers = [ "garage-ui" ];
      consumerEnv = {
        id = "GARAGE_UI_AUTH_OIDC_CLIENT_ID";
        secret = "GARAGE_UI_AUTH_OIDC_CLIENT_SECRET";
      };
      logo = ./assets/garage.svg;
    };
    # Discovery is fetched at start, and a failure there is fatal.
    fleet.sso.discoveryConsumers = [ "garage-ui" ];

    fleet.statePaths."${config.fleet.machineState}/garage/console".mode = "0700";

    systemd.services = {
      garage-console-bootstrap = {
        description = "Mint the object store console's scoped admin-API token";
        before = [ "podman-garage-ui.service" ];
        wantedBy = [ "podman-garage-ui.service" ];
        after = [ "podman-garage.service" ];
        wants = [ "podman-garage.service" ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          Restart = "on-failure";
          RestartSec = "5s";
          User = config.fleet.operator.user;
          Environment = "XDG_RUNTIME_DIR=${config.fleet.operator.runtimeDir}";
          ExecStart = lib.getExe bootstrap;
        };
      };
      # Its start-up probe of the admin API gives up after ~2 s and exits.
      podman-garage-ui = {
        after = [ "podman-garage.service" ];
        wants = [ "podman-garage.service" ];
      };
    };

    virtualisation.oci-containers.containers.garage-ui = mkRootlessContainer {
      image = pinnedImage "garage-ui" "docker.io/noooste/garage-ui";
      environmentFiles = [ envFile ];
      environment = {
        GARAGE_UI_SERVER_ROOT_URL = "https://${host}";
        GARAGE_UI_GARAGE_ENDPOINT = "http://garage:3900";
        GARAGE_UI_GARAGE_ADMIN_ENDPOINT = "http://garage:3903";
        GARAGE_UI_GARAGE_REGION = "garage";
        GARAGE_UI_GARAGE_USE_SSL = "false";
        GARAGE_UI_GARAGE_FORCE_PATH_STYLE = "true";
        GARAGE_UI_AUTH_ADMIN_ENABLED = "false";
        GARAGE_UI_AUTH_TOKEN_ENABLED = "false";
        GARAGE_UI_AUTH_OIDC_ENABLED = "true";
        GARAGE_UI_AUTH_OIDC_PROVIDER_NAME = "Pocket ID";
        GARAGE_UI_AUTH_OIDC_ISSUER_URL = config.fleet.sso.issuerUrl;
        GARAGE_UI_AUTH_OIDC_SCOPES = "openid,profile,email,groups";
        GARAGE_UI_AUTH_OIDC_ROLE_ATTRIBUTE_PATH = "groups";
        GARAGE_UI_AUTH_OIDC_ADMIN_ROLES = lib.concatStringsSep "," cfg.authGroups;
        GARAGE_UI_AUTH_OIDC_COOKIE_SECURE = "true";
        GARAGE_UI_LOGGING_LEVEL = "info";
      };
      extraOptions = [
        "--read-only"
        # The session-signing key (generated per start) and upload spill.
        "--tmpfs=/app/data:rw,size=1m,mode=1777"
        "--tmpfs=/tmp:rw,size=512m,mode=1777"
        "--cap-drop=ALL"
        "--memory=512m"
        "--memory-swap=512m"
        "--pids-limit=256"
      ];
    };
  };
}
