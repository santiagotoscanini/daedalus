# garage — one shared S3 object store, one private bucket per tenant.
#
# The object-storage counterpart of modules/app-db: where app-db gives an app a
# role and a database on one cluster, this gives it a bucket and an access key
# on one Garage node. Active when `fleet.modules.garage.enable` is on; tenants
# are `fleet.appBuckets` entries (the apps platform writes one per app with
# `objectStorage.enable`), and declaring an entry IS the request. See
# README.md beside this file for the tenant's side.
#
# Materializes:
#
#   - One `garage` container (dxflrs/garage, a static binary FROM scratch) on
#     its own `garage-net` bridge, which every tenant joins. State under
#     <stateRoot>/garage/{meta,data} — metadata and blocks in ONE dataset, so
#     a filesystem snapshot captures both at the same instant (a restore that
#     paired newer metadata with older blocks, or the reverse, loses objects).
#     `garage server --single-node` assigns and applies the one-node layout on
#     first start and does nothing afterwards; ExecStartPost holds the unit
#     until `garage health` reports the cluster available.
#   - `garage-cluster-bootstrap.service` — generates the RPC secret and the
#     metrics token into <machineState>/garage/cluster/env, once.
#   - Per tenant, `garage-<name>-bootstrap.service` — the bucket (global alias
#     <name>), an access key `app-<name>` with read+write on it and nothing
#     else, the bucket's one lifecycle rule (abort a multipart upload left
#     unfinished for a day), and <machineState>/garage/<name>/env, ordered
#     before the tenant's containers. Bucket settings are the platform's: no
#     tenant key owns its bucket. assets/bucket-bootstrap.sh says why the env file,
#     not Garage, is the source of truth for the key.
#   - `s3.<baseDomain>` — the S3 API through traefik, LAN only, for the
#     operator's own tools (rclone, a desktop client). Tenants never use it:
#     they dial `garage:3900` on the bridge, and serve their objects to
#     browsers through their own routes.
#   - With monitoring on: the `garage` scrape (bearer token) and
#     `garage-bucket-metrics.timer`, which copies per-bucket usage — which
#     Garage exports only through its admin API — into node-exporter's
#     textfile collector as `garage_bucket_*`.
#
# Isolation:
#   - A key per tenant, scoped to its own bucket; no key may create buckets.
#     There are no bucket policies or ACLs in Garage: the key IS the boundary.
#   - No master admin token exists. The admin API's mutating endpoints need a
#     token, and none is configured; every bootstrap drives `garage json-api`
#     over the RPC port, which binds the container's loopback only. /health
#     is open by design; /metrics requires the metrics token.
#   - The admin (3903) and RPC (3901) ports are published nowhere. The S3 port
#     is published on the host only when a tenant sits inside a VPN netns
#     (`reach = "hostPort"`), which has no bridge to dial — on every address,
#     because a rootless publish bound to 127.0.0.1 is unreachable through
#     `host.containers.internal`, and with no firewall opening, so the LAN
#     still cannot reach it.
#
# Settings the module fixes (assets/garage.toml explains each): SQLite
# metadata with fsync, block fsync, Garage's own metadata snapshot every 6h,
# no Garage-side compression or scrub (the filesystem does both), path-style
# addressing, region `garage`.
#
# Upgrades: a newer Garage refuses to be downgraded once it has opened the
# store, so the image pin is a ceremony on System › Updates.
#
# The host brings:
#   fleet.modules.garage.enable   the switch (default off, as every catalog module)
#   fleet.images.garage           the digest-pinned image
# Requires the reverse proxy (the LAN route) and, for the scrape and the bucket
# metrics, monitoring.

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  mkSecretRender,
  pinnedImage,
  ...
}:

let
  cfg = config.fleet.modules.garage;
  buckets = config.fleet.appBuckets;
  bucketNames = lib.attrNames buckets;

  # Clients sign with this; it must match `[s3_api].s3_region` exactly.
  region = "garage";
  s3Port = 3900;
  adminPort = 3903;

  # S3 bucket names: 3–63 of [a-z0-9.-], no leading/trailing separator. Dots
  # are legal in S3 but not here: a tenant's name is also a hostname label
  # and a machine-state directory, and app names carry none.
  nameRegex = "[a-z0-9][a-z0-9-]{1,61}[a-z0-9]";
  reserved = [
    "cluster"
    "console"
  ];

  root = "${config.fleet.stateRoot}/garage";
  metaDir = "${root}/meta";
  dataDir = "${root}/data";

  envBase = "${config.fleet.machineState}/garage";
  clusterEnv = "${envBase}/cluster/env";

  # A tenant in a VPN netns dials the S3 port published on the host.
  anyHostPort = lib.any (b: b.reach == "hostPort") (lib.attrValues buckets);

  monitoring = config.fleet.modules.monitoring.enable;

  configFile = pkgs.writeText "garage.toml" (
    builtins.replaceStrings [ "@region@" "@publicHost@" ] [ region config.fleet.webApps.s3.hostname ] (
      builtins.readFile ./assets/garage.toml
    )
  );

  operatorUnit = {
    User = config.fleet.operator.user;
    Environment = "XDG_RUNTIME_DIR=${config.fleet.operator.runtimeDir}";
  };

  waitReady = pkgs.writeShellApplication {
    name = "garage-wait-ready";
    runtimeInputs = [
      pkgs.podman
      pkgs.coreutils
    ];
    text = builtins.readFile ./assets/wait-ready.sh;
  };

  clusterBootstrap = pkgs.writeShellApplication {
    name = "garage-cluster-bootstrap";
    runtimeInputs = [
      pkgs.openssl
      pkgs.coreutils
    ];
    text = ''
      CLUSTER_ENV=${lib.escapeShellArg clusterEnv}
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}

      ${builtins.readFile ./assets/cluster-bootstrap.sh}
    '';
  };

  bucketBootstrap =
    name:
    pkgs.writeShellApplication {
      name = "garage-${name}-bootstrap";
      runtimeInputs = [
        pkgs.podman
        pkgs.openssl
        pkgs.coreutils
        pkgs.gnugrep
        pkgs.jq
      ];
      text = ''
        BUCKET=${lib.escapeShellArg name}
        KEY_NAME=${lib.escapeShellArg "app-${name}"}
        ENV_FILE=${lib.escapeShellArg buckets.${name}.envFile}
        ENDPOINT=${lib.escapeShellArg buckets.${name}.endpoint}
        REGION=${lib.escapeShellArg region}
        OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
        OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}

        ${builtins.readFile ./assets/bucket-bootstrap.sh}
      '';
    };

  bucketMetrics = pkgs.writeShellApplication {
    name = "garage-bucket-metrics";
    runtimeInputs = [
      pkgs.podman
      pkgs.coreutils
      pkgs.jq
    ];
    text = ''
      OUT=${lib.escapeShellArg "${config.fleet.modules.monitoring.textfileDir}/garage-buckets.prom"}

      ${builtins.readFile ./assets/bucket-metrics.sh}
    '';
  };
in
{
  options.fleet.modules.garage.enable = lib.mkOption {
    type = lib.types.bool;
    default = false;
    description = "Garage, the shared S3 object store: one private bucket and access key per tenant.";
  };

  options.fleet.appBuckets = lib.mkOption {
    # An entry's presence IS the request; per-tenant fields live in the
    # submodule, mirroring fleet.appDatabases.
    type = lib.types.attrsOf (
      lib.types.submodule (
        { name, config, ... }:
        {
          options.consumers = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ "app-${name}" ];
            example = [ "my-stack" ];
            description = ''
              Container names that must not start before this tenant's
              bootstrap has made the bucket, the key and the env file — the
              generated ordering is `podman-<consumer>.service` after/wants
              `garage-<name>-bootstrap.service`. The default fits the apps
              platform (container `app-<name>`).
            '';
          };
          options.reach = lib.mkOption {
            type = lib.types.enum [
              "bridge"
              "hostPort"
            ];
            default = "bridge";
            description = ''
              How this tenant dials the store, which is what the generated
              S3_ENDPOINT says. "bridge": `garage:${toString s3Port}` over
              garage-net, which the tenant joins. "hostPort":
              `host.containers.internal:${toString s3Port}`, the port
              published on the host (firewall-closed) — for a tenant inside another
              container's network namespace (a VPN egress), which has no
              bridge; the netns owner must allow egress to the pasta host
              alias (`mkGluetunInstance`'s `hostEgress`).
            '';
          };
          options.endpoint = lib.mkOption {
            type = lib.types.str;
            readOnly = true;
            default =
              if config.reach == "bridge" then
                "http://garage:${toString s3Port}"
              else
                "http://host.containers.internal:${toString s3Port}";
            description = "The S3 endpoint this tenant dials. Derived from `reach`.";
          };
          options.envFile = lib.mkOption {
            type = lib.types.str;
            readOnly = true;
            default = "${envBase}/${name}/env";
            description = ''
              The bootstrap-written env file: S3_ENDPOINT, S3_REGION,
              S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and the same
              values under the AWS SDK's names. Reference this instead of
              hardcoding the path.
            '';
          };
        }
      )
    );
    default = { };
    description = ''
      Per-tenant buckets on the shared Garage store. The attribute key is the
      bucket's name (its global alias), the access key's name (`app-<key>`)
      and the env-file directory. See modules/garage/README.md.
    '';
  };

  config = lib.mkIf cfg.enable {
    assertions =
      (map (n: {
        assertion = builtins.match nameRegex n != null;
        message = "fleet.appBuckets.\"${n}\": invalid bucket name. Must match ${nameRegex} — it is the bucket's global alias and the env-file directory.";
      }) bucketNames)
      ++ (map (n: {
        assertion = !(lib.elem n reserved);
        message = "fleet.appBuckets.\"${n}\": reserved name — `cluster` and `console` hold the store's own secrets under the machine state.";
      }) bucketNames);

    # garage-net carries the store and its tenants; traefik joins it for the
    # LAN route, prometheus reaches the admin port over monitoring-net.
    fleet.bridgeMemberships.garage = [ "garage" ] ++ lib.optional monitoring "monitoring";
    fleet.bridgeMemberships.traefik = [ "garage" ];

    fleet.logStacks.garage = [ "garage" ];

    # The S3 API for the operator's own clients, LAN only. Signed requests
    # only, so no forward-auth: a gate in front of SigV4 would break every
    # client. The probe's anonymous request is answered by Garage itself (403),
    # which a dead store cannot do (traefik answers 502).
    fleet.webApps.s3 = {
      hostname = lib.mkDefault "s3.${config.fleet.baseDomain}";
      serviceName = "garage";
      port = s3Port;
      healthPath = "/";
    };

    fleet.imageUpdates.garage.ceremony = "every app's files live in it, and a newer Garage cannot be downgraded once it has opened the store — the only way back from a bad bump is forward";

    fleet.statePaths = {
      "${root}" = { };
      "${metaDir}".mode = "0700";
      "${dataDir}".mode = "0700";
      "${envBase}".mode = "0700";
      "${envBase}/cluster".mode = "0700";
    }
    // lib.listToAttrs (map (n: lib.nameValuePair "${envBase}/${n}" { mode = "0700"; }) bucketNames);

    systemd.services = lib.mkMerge [
      {
        garage-cluster-bootstrap = {
          description = "Bootstrap the object store: generate its RPC secret and metrics token";
          before = [ "podman-garage.service" ];
          wantedBy = [ "podman-garage.service" ];
          after = [ "local-fs.target" ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            Restart = "on-failure";
            RestartSec = "5s";
            ExecStart = lib.getExe clusterBootstrap;
          };
        };

        # "podman-garage finished" only means `podman run -d` returned. Hold
        # the unit — and every bootstrap and tenant ordered after it — until
        # the cluster answers healthy (assets/wait-ready.sh).
        podman-garage.serviceConfig.ExecStartPost = lib.getExe waitReady;
      }

      (lib.listToAttrs (
        map (
          name:
          lib.nameValuePair "garage-${name}-bootstrap" {
            description = "Materialize bucket `${name}` and its access key on the object store";
            before = map (c: "podman-${c}.service") buckets.${name}.consumers;
            wantedBy = map (c: "podman-${c}.service") buckets.${name}.consumers;
            after = [ "podman-garage.service" ];
            wants = [ "podman-garage.service" ];
            serviceConfig = operatorUnit // {
              Type = "oneshot";
              RemainAfterExit = true;
              Restart = "on-failure";
              RestartSec = "5s";
              ExecStart = lib.getExe (bucketBootstrap name);
            };
          }
        ) bucketNames
      ))

      # The direct edge on every consumer, for the reason app-db gives: a mass
      # restart re-queues consumers while an already-active bootstrap stays
      # put, so the transitive ordering alone does not hold in every
      # transaction.
      (lib.listToAttrs (
        lib.concatMap (
          name:
          map (
            c:
            lib.nameValuePair "podman-${c}" {
              after = [ "podman-garage.service" ];
              wants = [ "podman-garage.service" ];
            }
          ) buckets.${name}.consumers
        ) bucketNames
      ))

      (lib.mkIf monitoring {
        garage-bucket-metrics = {
          description = "Copy per-bucket usage from the object store into node-exporter's textfile collector";
          after = [ "podman-garage.service" ];
          serviceConfig = operatorUnit // {
            Type = "oneshot";
            ExecStart = lib.getExe bucketMetrics;
          };
        };

        garage-prom-token = mkSecretRender {
          description = "Render the object store's metrics token for prometheus";
          gates = [ "podman-prometheus.service" ];
          after = [ "garage-cluster-bootstrap.service" ];
          wants = [ "garage-cluster-bootstrap.service" ];
          dir = "/run/garage-prom";
          file = "/run/garage-prom/token";
          prep = ''
            METRICS_TOKEN=$(grep -m1 '^GARAGE_METRICS_TOKEN=' ${clusterEnv} | cut -d= -f2-)
          '';
          content = "\${METRICS_TOKEN}";
        };
      })
    ];

    systemd.timers = lib.mkIf monitoring {
      garage-bucket-metrics = {
        wantedBy = [ "timers.target" ];
        timerConfig = {
          OnBootSec = "3min";
          OnUnitActiveSec = "5min";
        };
      };
    };

    fleet.prometheusScrapes = lib.optional monitoring {
      # The upstream Grafana dashboard's queries name this job.
      job_name = "garage";
      authorization = {
        type = "Bearer";
        credentials_file = "/run/secrets/garage-prom/token";
      };
      static_configs = [ { targets = [ "garage:${toString adminPort}" ]; } ];
    };

    virtualisation.oci-containers.containers = lib.mkMerge [
      {
        garage = mkRootlessContainer {
          image = pinnedImage "garage" "docker.io/dxflrs/garage";
          cmd = [
            "/garage"
            "server"
            "--single-node"
          ];
          environmentFiles = [ clusterEnv ];
          environment = {
            NO_COLOR = "1";
          };
          volumes = [
            "${configFile}:/etc/garage.toml:ro"
            "${metaDir}:/var/lib/garage/meta"
            "${dataDir}:/var/lib/garage/data"
          ];
          # Every address: a 127.0.0.1 publish is unreachable through
          # host.containers.internal. No firewall opening, so not the LAN.
          ports = lib.optional anyHostPort "${toString s3Port}:${toString s3Port}";
          extraOptions = [
            # A static binary that writes only under its two mounts and binds
            # unprivileged ports: no capability, no writable root.
            "--cap-drop=ALL"
            "--read-only"
            "--memory=2g"
            "--memory-swap=2g"
            "--pids-limit=512"
          ];
        };
      }
      (lib.mkIf monitoring {
        prometheus.volumes = [ "/run/garage-prom:/run/secrets/garage-prom:ro" ];
      })
    ];
  };
}
