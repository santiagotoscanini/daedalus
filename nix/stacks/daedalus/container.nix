# What the control plane's container is handed: its environment, its env
# files, its bridges beyond the apps platform's and its mounts. The entry
# itself (image, address, auth) is daedalus.nix; the app reads each variable
# through its env schema (app/src/host/env.ts). Part of the daedalus stack
# (daedalus.nix holds the switch); never imports its siblings.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; })
    verbsDir
    workspaceIconsDir
    boardsDir
    hooksHost
    haveGithubApp
    githubRenderDir
    githubTokenDir
    workspaceRoot
    engineRoot
    workspacesDir
    envDir
    imageDir
    systemDir
    repoDir
    builderDir
    controllerDir
    ;

  # What the stacks show the control plane — `fleet.dashboard` (platform/
  # export.nix), read whole and never indexed by a fixed key: each stack
  # contributes inside its own `mkIf`, so a stack switched off leaves nothing
  # behind and this module never fails on another stack's absence.
  dashboard = lib.attrValues config.fleet.dashboard;

  daedalusDev = config.fleet.daedalus.source == "dev";
in

{
  config = lib.mkIf config.fleet.modules.daedalus.enable {
    # The bridges the stacks ask for (fleet.dashboard.<id>.bridges), each
    # joined once. Merges with what modules/apps contributes for this container
    # (app-db, the iso bridge). Bridges are two-way, which is why the app
    # trusts no request without traefik's proxy proof (daedalus.nix).
    fleet.bridgeMemberships."app-daedalus" = lib.unique (lib.concatMap (d: d.bridges) dashboard);

    fleet.apps.daedalus = {
      # The per-service read keys (dashboard-keys.nix), then the env file each
      # stack renders for it (fleet.dashboard.<id>.envFiles) — every one a copy
      # the owning stack makes of its own secret.
      environmentFiles = [
        "/run/daedalus-dashboard/env"
      ]
      ++ lib.concatMap (d: d.envFiles) dashboard;

      # mkMerge, not `//`, for the stacks' contributions: a name two of them
      # both set (or one of them and this block) is a conflicting definition,
      # never a silent override.
      env = lib.mkMerge (
        map (d: d.env) dashboard
        ++ [
          (lib.optionalAttrs haveGithubApp {
            BUILD_LOGS_PATH = "/builds";
            # The builder's machinery, from daedalus-builder-snapshot.
            BUILDER_FACTS_PATH = "/builder/builder.json";
          })
          {
            # The registry nix last built: a stable path daedalus-registry-snapshot
            # refreshes on every rebuild, so an Apply updates it without
            # restarting this app.
            NIX_REGISTRY_PATH = "/export/applied.json";
            # The fleet.export domains (platform/export.nix): the facts the
            # pages render.
            EXPORT_DIR = "/export";
            # The box's identity, read at run time and handed to the browser by
            # the root loader, so a built image is right for any box. The
            # per-service addresses arrive through fleet.dashboard from the stack
            # that owns each hostname.
            BASE_DOMAIN = config.fleet.baseDomain;
            GITHUB_OWNER = config.fleet.github.owner;
            # Where the root verbs publish their status, and the two
            # directories this app writes for the operator's readers.
            VERBS_DIR = "/verbs";
            WORKSPACE_ICONS_DIR = "/workspace-icons";
            BOARDS_DIR = "/boards";

            # The GitHub App's webhook name: Vite refuses any Host it was not
            # told about (vite.config.ts allowedHosts), so the cfweb router
            # (daedalus-github.nix) would reach a server that refuses it.
            APP_EXTRA_HOSTS = hooksHost;
            # The token minter's installation.json and the webhook secret's
            # dir; mounted only once the App exists, and read as "no App yet"
            # until then.
            GITHUB_TOKEN_PATH = "/github-token/installation.json";
            # Read-only tokens for every other installation (another account or
            # org): what the off-box list discovers Pages sites with.
            GITHUB_INSTALLATIONS_PATH = "/github-token/installations.json";
            GITHUB_APP_DIR = "/github";

            # The non-secret half of what the DNS panel needs; the token rides
            # dashboard-keys.nix's env file, the tunnel's ids modules/cloudflared.
            CF_ZONE_ID = config.fleet.cloudflare.zoneId;
            # The router's retail name, the one fact its login page's build
            # stamp (model, revision, firmware, date) does not carry.
            ROUTER_PRODUCT = config.fleet.daedalus.routerProduct;
            # Two URLs for one device: the read is a machine fetching an
            # unauthenticated login page over plain HTTP (the router's
            # certificate is self-signed, and the page carries no secret); the
            # link is a person about to type an admin password.
            ROUTER_URL = "http://${config.fleet.gateway}";
            ROUTER_ADMIN_URL = config.fleet.daedalus.routerAdminUrl;
            # Snapshots the host publishes into the read-only mounts below.
            IMAGE_LABELS_PATH = "/images/labels.json";
            WORKSPACES_PATH = "/workspaces/workspaces.json";
            WORKSPACE_ROOT = workspaceRoot;
            IMAGE_FRESHNESS_PATH = "/images/freshness.json";
            HOST_FACTS_PATH = "/system/system.json";
            REPO_FACTS_PATH = "/repo/repo.json";
            # The committed site.json, for the diff preview and for editing:
            # the directory itself, read-only, never the repository root.
            SITE_PATH = "/site";
            # The controller's local API (controller.nix), mounted below.
            CONTROLLER_SOCKET = "/controller/api.sock";
            # How the ddns job is set up, read from the service definition so
            # a changed poll interval cannot leave a stale number on a page.
            DDNS_HOST = lib.head (config.services.ddclient.domains ++ [ "" ]);
            DDNS_INTERVAL = config.services.ddclient.interval;
            DDCLIENT_VERSION = config.services.ddclient.package.version;
          }
        ]
      );
    };

    # The mounts. Every snapshot is mounted as its DIRECTORY, never a file: each is
    # replaced by rename, and a single-file bind would pin the old inode.
    virtualisation.oci-containers.containers = {
      app-daedalus.volumes = [
        # The fleet.export domains: versioned, stamped JSON per domain at a
        # stable path, so no fact nix hands the app restarts it.
        "/run/daedalus-export:/export:ro"
        # The root verbs' status files: root writes them, the container only
        # reads.
        "${verbsDir}:/verbs:ro"
        # What this app writes for the operator's readers, never root's: the
        # session host's workspace icons, and the vendor pages a host job reads.
        "${workspaceIconsDir}:/workspace-icons"
        "${boardsDir}:/boards"
        # Last deploy result per app (`<digest> ok|failed`), written by
        # app-<name>-deploy.service.
        "/var/lib/app-deploy:/deploy-state:ro"
        # The merged per-container environment (daedalus-env-snapshot).
        "${envDir}:/env-snapshot:ro"
        # Running image labels (daedalus-image-snapshot).
        "${imageDir}:/images:ro"
        # SMART, pools, snapshots, replication and generations
        # (daedalus-system-snapshot); no secret in it.
        "${systemDir}:/system:ro"
        # Facts about the configuration repository, never the repository: a
        # checkout can hold untracked or gitignored plaintext.
        "${repoDir}:/repo:ro"
        # site/ — the one directory daedalus writes — read-only here: the
        # writes go through the root helper (`apply`, `secret-set`).
        "${config.fleet.site.path}:/site:ro"
        # Live git facts for every clone under the workspace root.
        "${workspacesDir}:/workspaces:ro"
        # The controller's socket directory: read-write, because connecting
        # to a unix socket is a write; tmpfiles makes it before any unit
        # starts, and who may connect is the agent's peer check.
        "${controllerDir}:/controller"
      ]
      # The GitHub App's read-only mounts, only once the App exists: a bind
      # of a missing source fails the whole container start.
      ++ lib.optionals haveGithubApp [
        # The webhook secret alone (daedalus-github-render), never the key.
        "${githubRenderDir}:/github:ro"
        # installation.json, from daedalus-github-token.
        "${githubTokenDir}:/github-token:ro"
        # The box builds' logs (build-agent.nix): root-written, redacted.
        "${config.fleet.builder.logDir}:/builds:ro"
        # The builder's machinery (daedalus-builder-snapshot): nothing secret.
        "${builderDir}:/builder:ro"
      ]
      # What the stacks mount into the control plane (fleet.dashboard.<id>.volumes).
      ++ lib.concatMap (d: d.volumes) dashboard
      # Dev mode: the whole engine checkout, read-only, for the app's tests run
      # inside the container, which read files beside app/.
      ++ lib.optional daedalusDev "${engineRoot}:/engine:ro";

      # Every source runs as container uid 0 — the operator on the host, who
      # owns the writable directories above and the controller's socket
      # directory. Dev mode gets the same flag from `source.dev` (modules/apps).
      app-daedalus.extraOptions = lib.optional (!daedalusDev) "--user=0:0";
    };
  };
}
