# platform/podman.nix — the rootless-podman container runtime.
#
# Exposed:
#   - `_module.args` helpers: mkRootlessContainer (oci-containers
#     decorator applying per-host defaults: podman.user=santiago,
#     autoStart=true, TZ), hostUid, mkDotenvSecret, mkSecretRender,
#     mkLocalImage. ALL _module.args live in this one module — a module
#     that defines _module.args cannot itself consume a custom arg
#     (evaluating the args option recurses through the module call).
#     The gluetun family is a by-path library (platform/gluetun-lib.nix)
#     for the same reason: its consumers force it inside a top-level
#     config mkMerge, where a module arg would recurse.
#   - Runtime options: fleet.bridgeMemberships (the single source of
#     bridge membership), fleet.bridgeSubnets, fleet.statePaths — plus
#     the machinery they drive: the Type=oneshot unit override per
#     container, bridge-creation oneshots, state-paths.service, and the
#     1:1 registry assertion.
#
# The publishing layer (webApps and friends) lives in
# platform/publishing.nix; appDatabases, logStacks and monitoredJobs
# are declared in their owning modules.

{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.fleet;

  # Bridge-membership spec parsing lives in fleet-lib (shared with
  # publishing.nix — one parser, no hand-synced mirror).
  inherit (import ./fleet-lib.nix { inherit lib; }) bridgeOf networkFlag;

  # Applied to every podman-<name>.service. Without this override
  # oci-containers ships Type=notify + Restart=always, which doesn't
  # survive rootless + system-unit boundaries.
  #
  # Also emits `RequiresMountsFor` for every absolute host path in the
  # container's volumes — closes the cold-boot race where a container
  # starts before a ZFS dataset mounts, silently bind-mounting the
  # unmounted underlay (empty dir), then the dataset mounts on top
  # and the container writes into an orphan inode. Silent data loss.
  # systemd resolves each path to its nearest mount, so paths on the
  # root filesystem cost nothing.
  mkContainerOverride =
    name: nets:
    let
      container = config.virtualisation.oci-containers.containers.${name} or { };
      volumes = container.volumes or [ ];
      # Volume strings: "host:container[:opts]" → first segment is host path.
      hostPaths = map (v: lib.head (lib.splitString ":" v)) volumes;
      mountPaths = lib.unique (lib.filter (lib.hasPrefix "/") hostPaths);
      bridgeUnits = map (b: "podman-network-${b}-net.service") (lib.unique (map bridgeOf nets));
    in
    {
      serviceConfig = {
        Type = lib.mkForce "oneshot";
        RemainAfterExit = true;
        Restart = lib.mkForce "on-failure";
        RestartSec = "15s";
      };
      # StartLimit* and RequiresMountsFor are [Unit] keys; systemd drops
      # them silently from [Service], turning the guards above into no-ops.
      unitConfig = {
        # systemd default (5 in 10s) trips first-boot races where
        # app-db tenants wait on pg. 20 retries x 15s = 5 min of retry
        # headroom inside the 10-min window; slow paths converge.
        StartLimitBurst = 20;
        StartLimitIntervalSec = 600;
      }
      // lib.optionalAttrs (mountPaths != [ ]) {
        RequiresMountsFor = mountPaths;
      };
    }
    // {
      # user@1000.service in after/wants: at shutdown systemd stops each
      # container BEFORE santiago's user manager and /run/user/1000 tear
      # down. Without it, `podman stop` finds the rootless runtime gone
      # ("RunRoot not writable" → crun not found), the stop fails, and the
      # container is cgroup-killed — dirty DB shutdowns / WAL recovery next
      # boot (app-db pg is stopped last, so it is the most exposed).
      after = bridgeUnits ++ [
        "state-paths.service"
        "user@1000.service"
      ];
      wants = bridgeUnits ++ [
        "state-paths.service"
        "user@1000.service"
      ];
    };

  # Container-UID -> host-UID under santiago's subuid range
  # (100000:65536) for uids >= 1: www-data 33 -> 100032, linuxserver
  # abc 911 -> 100910. NOT for uid 0 (container root is santiago,
  # 1000, outside the subuid range). Exposed via _module.args below.
  hostUid = containerUid: 99999 + containerUid;

  # Shared shell for "run rootless podman as santiago at boot" oneshots
  # (bridge creation, local image builds): linger ordering so
  # /run/user/1000 exists, /run/wrappers on PATH (newuidmap is a setuid
  # wrapper only there — the boot's first rootless podman needs it to
  # create santiago's userns, and the store-only default PATH cannot
  # see it), oneshot + retry. `needsNetwork = false` for work that only
  # writes local state (a network-online edge would delay boot and add
  # a spurious failure dependency).
  mkRootlessOneshot =
    {
      description,
      execStart,
      needsNetwork ? true,
      needsDns ? false,
      before ? [ ],
      wantedBy ? [ "multi-user.target" ],
    }:
    let
      # network-online.target means the link is up, NOT that DNS answers.
      # pi-hole is this box's only resolver and is Type=simple (its unit
      # goes active before it serves), so work that resolves a hostname
      # at boot must also gate on pihole-ready.service — the oneshot that
      # blocks until FTL actually answers queries. Without it a build that
      # pulls its FROM base races and fails with "no such host".
      netEdges =
        lib.optional needsNetwork "network-online.target" ++ lib.optional needsDns "pihole-ready.service";
    in
    {
      inherit description before wantedBy;
      after = [ "linger-users.service" ] ++ netEdges;
      wants = [ "linger-users.service" ] ++ netEdges;
      path = [ "/run/wrappers" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        User = "santiago";
        Group = "users";
        Environment = "XDG_RUNTIME_DIR=/run/user/1000";
        Restart = "on-failure";
        RestartSec = "1s";
        ExecStart = execStart;
      };
    };

  # Idempotent — `--ignore` returns 0 if the network already exists,
  # so this can re-run on every rebuild without churn. NOTE: `--ignore`
  # also means a changed `bridgeSubnets` pin does NOT renumber an
  # existing bridge — that needs a manual `podman network rm` while its
  # members are stopped.
  mkBridgeUnit =
    net:
    mkRootlessOneshot {
      description = "Create the ${net}-net podman bridge";
      # `podman network create` only writes local config.
      needsNetwork = false;
      execStart = "${pkgs.podman}/bin/podman network create --ignore${
        lib.optionalString (cfg.bridgeSubnets ? ${net}) " --subnet ${cfg.bridgeSubnets.${net}}"
      } ${net}-net";
    };

  distinctBridges = lib.unique (
    map bridgeOf (lib.concatLists (lib.attrValues cfg.bridgeMemberships))
  );

  # Body of _module.args.mkRootlessContainer — bound in the let so
  # in-file helpers can compose with it.
  mkRootlessContainer =
    args:
    let
      nnp = args.noNewPrivileges or true;
      cleanArgs = removeAttrs args [ "noNewPrivileges" ];
      secOpts = lib.optional nnp "--security-opt=no-new-privileges:true";
    in
    {
      autoStart = true;
    }
    // cleanArgs
    // {
      # Deep-merged (not `// cleanArgs`-overridable as a whole): a stack
      # passing its own `podman = { ... }` must not silently drop
      # `user = "santiago"` and turn the container rootful.
      podman = {
        user = "santiago";
      }
      // (cleanArgs.podman or { });
      environment = {
        TZ = config.time.timeZone;
      }
      // (cleanArgs.environment or { });
      extraOptions = secOpts ++ (cleanArgs.extraOptions or [ ]);
    };

in
{
  options.fleet = {

    stateRoot = lib.mkOption {
      type = lib.types.str;
      default = "/home/santiago/selfhost";
      readOnly = true;
      description = ''
        The one host tree for container state (rpool/selfhost: 16K
        recordsize, frequent+hourly+daily snapshots, syncoid-mirrored).
        Interpolate this instead of restating the literal.

        Layout convention — grouped stacks nest one level:
          <stateRoot>/ai/<service>     lemonade-logs, litellm, open-webui
          <stateRoot>/apps/<app>       the apps platform (data/, and
                                       app-adjacent state like argus's
                                       gluetun/ or daedalus's apply/)
          <stateRoot>/books/<service>  calibre-web, shelfmark
          <stateRoot>/tv/<service>     the media fleet, incl. its
                                       janitors (cleanuparr, janitorr,
                                       recyclarr, seerr)
        Everything else is <stateRoot>/<stack>. A new stack that serves
        an existing group joins the group's directory, not the root.
      '';
    };

    bridgeMemberships = lib.mkOption {
      type = lib.types.attrsOf (lib.types.listOf lib.types.str);
      default = { };
      description = ''
        Map: container name -> list of bridge memberships. `[ ]` means
        default pasta networking. Elements are bridge short names
        ("traefik" -> the traefik-net bridge), optionally with a podman
        network-option suffix ("nextcloud:alias=redis" ->
        `--network=nextcloud-net:alias=redis`).

        This is the single source of bridge membership: each entry
        produces the Type=oneshot systemd unit override, injects the
        `--network=<bridge>-net` flags into the container's
        extraOptions (do NOT also write them by hand), orders the unit
        after every listed bridge, and queues each bridge for creation
        by a generated podman-network-<bridge>-net.service. Lists merge
        across modules, so another stack can append a membership to a
        container it doesn't own (app-db does this to put traefik on
        pg-wire-net).

        Non-bridge networking (`--network=host`,
        `--network=container:<owner>`) stays in extraOptions with an
        `[ ]` entry here. A key without a matching oci-container fails
        eval (the injected extraOptions define the container, whose
        mandatory `image` is then missing).

        Per-stack modules add their own containers here.
      '';
      example = lib.literalExpression ''
        {
          wealthfolio = [ ];
          nextcloud-app = [ "nextcloud" "app-db" "traefik" ];
        }
      '';
    };

    statePaths = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.submodule (_: {
          options = {
            uid = lib.mkOption {
              type = lib.types.int;
              default = 0;
              description = ''
                CONTAINER uid that owns the path (0 = container root =
                santiago on the host; N >= 1 maps to host 99999+N via
                the subuid range). Declaring the container-side id keeps
                the 70-vs-105 postgres class of trap visible: the value
                here must match what the image actually runs as.
              '';
            };
            gid = lib.mkOption {
              type = lib.types.nullOr lib.types.int;
              default = null;
              description = "CONTAINER gid (same mapping; 0 = users). Default: same as uid.";
            };
            mode = lib.mkOption {
              type = lib.types.str;
              default = "0755";
            };
            type = lib.mkOption {
              type = lib.types.enum [
                "d"
                "f"
              ];
              default = "d";
              description = "tmpfiles entry type: directory or (empty-if-missing) file.";
            };
          };
        })
      );
      default = { };
      description = ''
        Host paths a container binds for persistent state, keyed by
        absolute path and declared with their CONTAINER-side ownership.
        Applied by the root `state-paths.service` oneshot with the
        subuid mapping — the single convention for pre-creating
        bind-mount sources so a fresh restore (repo clone + rebuild)
        starts every container with correctly-owned dirs instead of
        podman-created root ones. Ownership and mode are re-enforced
        (non-recursively) at boot, so a wrong uid here actively breaks
        the app: match the image.
      '';
      example = lib.literalExpression ''
        {
          "/home/santiago/selfhost/grocy/config" = { uid = 911; };
          "/home/santiago/selfhost/app-db/postgres" = { uid = 70; mode = "0700"; };
        }
      '';
    };

    bridgeSubnets = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = ''
        Optional subnet pin per bridge (short name -> CIDR), passed as
        `--subnet` when the bridge is created. Pin a bridge when
        something references its addresses (e.g. TRUSTED_PROXIES
        derives from `bridgeSubnets.traefik`) so podman can't renumber
        it on a fresh install. The owning stack declares its own pin.
      '';
      example = lib.literalExpression ''
        {
          traefik = "10.89.7.0/24";
        }
      '';
    };

  };

  config = {
    # Decorator exposed to per-stack modules:
    #   virtualisation.oci-containers.containers.foo = mkRootlessContainer { ... };
    #
    # Injects `--security-opt=no-new-privileges:true` fleet-wide: once set,
    # no process in the container can gain privileges via a setuid/setgid
    # binary or file capabilities on execve. It does NOT strip already-granted
    # capabilities (--cap-add NET_ADMIN etc. still work), so the VPN/wireguard
    # stacks keep functioning. Opt out per-container with
    # `noNewPrivileges = false` (the key is stripped before reaching
    # oci-containers) for the rare image that legitimately needs to escalate.
    # Container runtime for the whole fleet: rootless podman as santiago
    # (subuid 100000:65536). dockerCompat installs a `docker` shim.
    virtualisation.podman = {
      enable = true;
      dockerCompat = true;
    };
    virtualisation.oci-containers.backend = "podman";

    _module.args.mkRootlessContainer = mkRootlessContainer;

    # Locally-built image + its build oneshot, as one helper:
    #   inherit (mkLocalImage { ... }) image service;
    # The tag embeds the build context's store hash, so ANY change to
    # the context (base-image digest bump, Containerfile edit, asset
    # change) changes the consumer unit's ExecStart and restarts it.
    # Without that, a rebuilt image sits unused behind an unchanged tag
    # until something else happens to restart the container — a silent
    # partial deploy. Layer cache keeps no-change rebuilds ~instant.
    _module.args.mkLocalImage =
      {
        name, # localhost/<name>
        tagPrefix, # human-readable tag part (e.g. the app version)
        contextDir, # store path with the Containerfile + context
        gates, # consumer units; build runs before= / wantedBy= them
      }:
      let
        # Interpolation imports a literal path into its own
        # content-addressed store path (a derivation is already one) —
        # /nix/store/<hash32>-…, where the hash IS the fingerprint of
        # exactly this context, not of the whole repo.
        ctx = "${contextDir}";
        ctxHash = builtins.substring 11 8 ctx;
        image = "localhost/${name}:${tagPrefix}-${ctxHash}";
      in
      {
        inherit image;
        # A cold cache pulls the FROM base from its registry, so this
        # needs real DNS (needsDns), not just network-online.
        service = mkRootlessOneshot {
          description = "Build ${image}";
          needsDns = true;
          before = gates;
          wantedBy = gates;
          execStart = pkgs.writeShellScript "build-${name}-image" ''
            set -eu
            cd ${ctx}
            ${pkgs.podman}/bin/podman build \
              --tag ${image} \
              --file Containerfile \
              .
          '';
        };
      };

    # See the let-binding's doc; state-paths below uses the same mapping.
    _module.args.hostUid = hostUid;

    # Standard operator-managed dotenv secret: age-encrypted file at
    # the stack root, decrypted to /run/secrets/<name> owned by
    # santiago so rootless podman reads it pre-userns-remap.
    #   sops.secrets."foo-env" = mkDotenvSecret ./env.sops;
    _module.args.mkDotenvSecret = sopsFile: {
      inherit sopsFile;
      format = "dotenv";
      key = "";
      owner = "santiago";
    };

    # Activation-render idiom: a oneshot that materializes a small file
    # on tmpfs before its consumers start — a bare token, an --env-file,
    # a DSN — sourced from an already-decrypted secret. `prep` computes
    # shell vars; `content` is the heredoc body written to `file`.
    # The dir is 0755 santiago so rootless podman can traverse it at
    # --env-file mount time (pre-userns-remap); the file itself stays
    # `mode` (default 0400).
    #   systemd.services."foo-render" = mkSecretRender { ... };
    _module.args.mkSecretRender =
      {
        description,
        gates, # consumer units; the render runs before= / wantedBy= them
        dir,
        file,
        content,
        mode ? "0400",
        # Owner of the rendered FILE (the dir stays santiago 0755). Set
        # to a subuid (hostUid N) when the consumer container reads the
        # file as a non-root user after its entrypoint privilege-drop.
        owner ? "santiago",
        group ? "users",
        prep ? "",
        after ? [ ],
        wants ? [ ],
      }:
      {
        inherit description wants;
        before = gates;
        wantedBy = gates;
        # /run/secrets/* are materialized during activation, ahead of
        # every multi-user unit — no explicit sops ordering needed.
        after = [ "local-fs.target" ] ++ after;
        path = [
          pkgs.coreutils
          pkgs.gnugrep
        ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          Restart = "on-failure";
          RestartSec = "5s";
        };
        script = ''
          set -eu
          install -d -m 0755 -o santiago -g users ${dir}
          umask 077
          ${prep}
          install -m ${mode} -o ${toString owner} -g ${toString group} /dev/stdin ${file} <<RENDER_EOF
          ${content}
          RENDER_EOF
        '';
      };

    # systemd overrides + bridge units generated from the registry.
    # Per-stack `systemd.services.<X>` additions merge with these.
    systemd.services =
      (lib.mapAttrs' (
        name: nets: lib.nameValuePair "podman-${name}" (mkContainerOverride name nets)
      ) cfg.bridgeMemberships)
      // (lib.listToAttrs (
        map (net: lib.nameValuePair "podman-network-${net}-net" (mkBridgeUnit net)) distinctBridges
      ))
      // {
        # statePaths → a root oneshot (subuid-mapped). NOT tmpfiles:
        # systemd-tmpfiles refuses to descend from the santiago-owned
        # /home prefix into differently-owned children ("unsafe path
        # transition") and silently skips every rule under /home.
        # Sorted paths create declared parents before children; missing
        # UNdeclared parents are created santiago-owned first (the
        # fresh-restore path — existing directories are never re-owned).
        # Ownership and mode are enforced non-recursively at boot and
        # whenever the declaration changes. Every podman-<name> unit
        # orders after this via mkContainerOverride.
        #
        # Failure semantics: one bad entry logs and continues (the other
        # entries still apply), then the unit fails at the end — loud via
        # monitoredJobs email + the failed-units alert. Containers deliberately
        # only `wants` this unit: `requires` would propagate every
        # state-paths restart (any declaration change) into a fleet-wide
        # container restart.
        state-paths = {
          description = "Create and own declared container state paths";
          wantedBy = [ "multi-user.target" ];
          unitConfig.RequiresMountsFor = lib.attrNames cfg.statePaths;
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
          };
          script = ''
            fail=0
            # Create missing parents santiago-owned; never re-own an
            # existing directory ([ -d ] walk stops at the first one).
            ensure_parents() {
              local missing=() parent i
              parent=$(dirname "$1")
              while [ ! -d "$parent" ]; do
                missing+=("$parent")
                parent=$(dirname "$parent")
              done
              for ((i = ''${#missing[@]} - 1; i >= 0; i--)); do
                install -d -o santiago -g users "''${missing[$i]}"
              done
            }
          ''
          + lib.concatMapStrings (
            path:
            let
              d = cfg.statePaths.${path};
              mapId = id: name: if id == 0 then name else toString (hostUid id);
              owner = "${mapId d.uid "santiago"}:${mapId (if d.gid != null then d.gid else d.uid) "users"}";
              p = lib.escapeShellArg path;
            in
            ''
              { ensure_parents ${p} \
                && ${if d.type == "d" then "mkdir -p ${p}" else "[ -e ${p} ] || : > ${p}"} \
                && chown ${owner} ${p} && chmod ${d.mode} ${p}; } \
                || { echo "state-paths: failed to apply ${p}" >&2; fail=1; }
            ''
          ) (lib.sort lib.lessThan (lib.attrNames cfg.statePaths))
          + ''exit "$fail"'';
        };
      };

    # A broken state-paths run means containers may start against
    # wrongly-owned dirs — make that loud.
    fleet.monitoredJobs.state-paths = { };

    # Bridge membership → --network flags, injected from the registry.
    # List options merge, so these compose with each stack's own
    # extraOptions (which keep only non-bridge flags: host/netns
    # sharing, devices, caps).
    virtualisation.oci-containers.containers = lib.mapAttrs (_: nets: {
      extraOptions = map networkFlag nets;
    }) (lib.filterAttrs (_: nets: nets != [ ]) cfg.bridgeMemberships);

    # The registry and the container set must stay 1:1 — a stale
    # registry key with `[ ]` would otherwise emit an inert ghost
    # unit, and an unregistered container would silently miss the
    # oneshot override, mount ordering, and state-paths edge.
    assertions = [
      (
        let
          registered = lib.attrNames cfg.bridgeMemberships;
          declared = lib.attrNames config.virtualisation.oci-containers.containers;
          ghostKeys = lib.subtractLists declared registered;
          unregistered = lib.subtractLists registered declared;
        in
        {
          assertion = ghostKeys == [ ] && unregistered == [ ];
          message = ''
            fleet.bridgeMemberships and oci-containers must stay 1:1.
            Registered without a container: [${toString ghostKeys}].
            Container without a registry entry: [${toString unregistered}]
            — add `fleet.bridgeMemberships.<name>` (`[ ]` = pasta).
          '';
        }
      )
    ];
  };
}
