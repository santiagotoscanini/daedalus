{
  config,
  options,
  lib,
  pkgs,
  ...
}:

# fleet.export — the one door through which nix facts reach daedalus.
#
# Modules contribute domains (`fleet.export.domains.<name>.data.<key> = …`);
# each domain renders to a store-path JSON document wrapped in the shared
# envelope, and a publisher oneshot installs them under /run/daedalus-export
# with a generatedAt stamp. The container mounts that directory read-only at
# /export and decodes each file through app/src/host/contract/ — one
# mechanism, versioned and stamped, instead of per-fact env variables and
# JSON blobs.
#
# Why this shape:
#
#   Stable-path delivery, store-path change detection. A store path bound
#   straight into the container would restart the app on ANY change — during
#   an Apply, killing the page showing the progress bar. Here
#   the publisher's ExecStart embeds the rendered store paths, so systemd
#   re-runs it exactly when a domain changed, and the container just sees new
#   bytes at a fixed path on its next read.
#
#   generatedAt is stamped by the publisher, not the derivation: nix eval is
#   pure, and builtins.currentTime would poison every rebuild. What eval CAN
#   carry is configurationRevision — "the manifest of which generation" — and
#   the envelope does.
#
#   builtins.toJSON at eval means a non-serialisable contribution fails the
#   BUILD, not a page three days later.

let
  cfg = config.fleet;

  inherit (import ./lib/fleet-lib.nix { inherit lib; }) parsePin;

  publishDir = "/run/daedalus-export";

  envelope =
    name: domain:
    pkgs.writeText "daedalus-export-${name}.json" (
      builtins.toJSON {
        daedalusExport = 1;
        domain = name;
        inherit (domain) schemaVersion;
        source = "nix";
        revision = config.system.configurationRevision or null;
        inherit (domain) data;
      }
    );

  rendered = lib.mapAttrs envelope cfg.export.domains;

  # Every container's image tag, WHATEVER shape it is: `10.11.11ubu2404-ls42`,
  # `jvm-stable`, `latest`, `8`. Deciding whether a tag names a version is the
  # reader's job — a channel name arriving intact is exactly what lets a panel
  # say "this pin carries no version" rather than show a wrong one.
  imageTags = lib.mapAttrs (
    _: c:
    let
      pinned = builtins.match ".*:([^@:]+)@sha256:.*" c.image;
      plain = builtins.match ".*:([^@:]+)" c.image;
    in
    if pinned != null then
      builtins.head pinned
    else if plain != null then
      builtins.head plain
    else
      ""
  ) config.virtualisation.oci-containers.containers;

  # Every image pinned as `:tag@sha256:…`, parsed once (fleet-lib's
  # `parsePin`) because three consumers need the same answer: the export
  # domain the dashboard reads, the daily freshness probe, and the update
  # agent that rewrites a pin.
  #
  # ANY digest-on-a-tag pin qualifies, not just the moving channels — a
  # re-pushed `2.10.1` is the same fact as a moved `latest`, and which tags
  # count as "moving" is a judgement the reader makes with the tag in hand.
  # Local builds (mkLocalImage) and the registry-loop apps carry no digest and
  # fall out of the match; a local build's BASE is a `fleet.manualPins` entry.
  #
  # `digest` is the load-bearing field. It is the one part of a pin that is
  # ALWAYS a literal in the .nix source — two containers on one release may
  # interpolate a shared version variable into the tag, so the
  # rendered `tag` appears nowhere in the file. The update agent anchors every
  # edit on the digest for exactly that reason; see
  # stacks/daedalus/host/image-update.sh.
  imagePins = lib.filterAttrs (_: v: v != null) (
    lib.mapAttrs (_: c: parsePin c.image) config.virtualisation.oci-containers.containers
  );

  # The pin plus what the fleet knows about moving it. Kept separate from
  # `imagePins` because the freshness probe wants only the ref to ask about,
  # while the dashboard needs the policy to decide whether to draw a button.
  imagePinsWithPolicy = lib.mapAttrs (
    name: pin:
    let
      p = cfg.imageUpdates.${name} or null;
    in
    pin
    // {
      updatable = if p == null then true else p.updatable;
      lockstep = if p == null then [ ] else p.lockstep;
      ceremony = if p == null then null else p.ceremony;
      majorCeremony = if p == null then null else p.majorCeremony;
    }
  ) imagePins;

  # ── the hand-moved pins (fleet.manualPins) ──────────────────────────────
  #
  # Which file holds each pin's literal, so its Updates row can say where a
  # bump is made — and, for the configuration's, whether the Update button
  # can make it. The module system already records it: every definition of
  # an option carries its file. An engine file is named from the engine's
  # root (`nix/…`), anything else from the root of the flake source it came
  # from — the configuration checkout.
  #
  # Two ways to find the file. A catalog module that builds its image reads
  # each base from `fleet.images` (keyed by the pin's id), so the literal is
  # wherever the HOST defined that key; otherwise it is the file that defined
  # the entry — the first to name the id, since an entry whose fields are
  # spread over two files is still one pin, bumped where its `image` or
  # `version` is.
  engineRoot = toString ../..;
  firstFileOf =
    defs:
    lib.foldl' (
      acc: def:
      acc // lib.genAttrs (lib.filter (id: !(acc ? ${id})) (lib.attrNames def.value)) (_: def.file)
    ) { } defs;
  definedIn = firstFileOf options.fleet.manualPins.definitionsWithLocations;
  imagesDefinedIn = firstFileOf options.fleet.images.definitionsWithLocations;
  pinnedIn =
    id: p:
    let
      hostDefined = p.image != null && (cfg.images.${id} or null) == p.image;
      file = if hostDefined then imagesDefinedIn.${id} or "" else definedIn.${id} or "";
      inEngine = lib.hasPrefix "${engineRoot}/" file;
      inStore = builtins.match "/nix/store/[^/]+/(.*)" file;
    in
    {
      repo = if inEngine then "engine" else "config";
      path =
        if p.pinnedIn != null && !hostDefined then
          p.pinnedIn
        else if inEngine then
          lib.removePrefix "${engineRoot}/" file
        else if inStore != null then
          builtins.head inStore
        else
          file;
    };

  # What the Update button may move: an image pin whose literal is in the
  # configuration checkout (the only tree the agent edits), built with the
  # label that proves the move landed (the agent's verify step reads it), and
  # not ruled out by policy. Everything else stays a row with the file to
  # edit — an engine pin is an engine commit, then Engine › Update.
  manualPins = lib.mapAttrs (
    id: p:
    let
      where = pinnedIn id p;
      policy = cfg.imageUpdates.${id} or null;
    in
    {
      inherit (p)
        repo
        tag
        digest
        version
        upstream
        branch
        parts
        containers
        note
        label
        ;
      image = if p.repo == null then null else "${p.repo}:${p.tag}";
      pinnedIn = where;
      updatable =
        p.repo != null && p.label != null && where.repo == "config" && (policy == null || policy.updatable);
      lockstep = [ ];
      ceremony = if policy == null then null else policy.ceremony;
      majorCeremony = if policy == null then null else policy.majorCeremony;
    }
  ) cfg.manualPins;
in
{
  options.fleet = {
    imageUpdates = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            updatable = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = ''
                Whether daedalus may rewrite this container's pin.

                False draws the changelog and no button — for a pin whose
                move is not a pin edit at all — a database image whose next
                major needs its data directory upgraded first.
              '';
            };
            lockstep = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = ''
                Containers that MUST move in the same commit as this one,
                because they are two halves of one release.

                Two shapes, both real here. Immich's server and
                machine-learning read the same `immichVersion` and a version
                skew between them is unsupported upstream. The gluetun
                pair is the other shape — one literal image string reached by
                two containers, so moving either moves both whether or not
                anyone declared it.

                The agent resolves each member's own new tag by substituting
                the primary's old tag for the new one INSIDE the member's tag,
                which is what makes `v3.1.0-openvino` follow `v3.1.0`. A
                member whose tag does not contain the primary's is refused
                rather than guessed at.
              '';
            };
            ceremony = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = ''
                What ELSE this update takes down, in one clause.

                Non-null makes the UI demand the container's name be typed
                before the button arms, and shows this string while asking.
                It is not a warning label for risk in general — every update
                here builds, switches and reverts on failure. It is for blast
                radius the container's own name does not carry: gluetun owns
                a netns other containers ride, and a pg bounce takes pocket-id
                with it and everything pocket-id gates.
              '';
            };
            majorCeremony = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "needs the upgrade chores in the module header run by hand, one major at a time";
              description = ''
                `ceremony`, but only for a move that changes the tag's
                leading version number (`34` → `35`, `v2.x` → `v3.x`): what a
                new MAJOR takes that a rebuild does not do. A re-pull or a
                minor on the same line arms like any other update.
              '';
            };
          };
        }
      );
      default = { };
      description = ''
        Per-pin policy for updating an image from daedalus, keyed by
        container — or by a `fleet.manualPins` id, for a base the Update
        button moves. Every pin is updatable with no entry here; this
        registry exists for the ones where that is not the whole truth.
      '';
    };

    manualPins = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.submodule (
          { config, ... }:
          let
            pin = if config.image == null then null else parsePin config.image;
          in
          {
            options = {
              image = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                example = "docker.io/library/node:24-slim@sha256:<digest>";
                description = ''
                  The pinned image, `repo:tag@sha256:…`, when the pin is one.
                  Null for a pin that is a source commit or a release
                  number with no image of its own.
                '';
              };
              repo = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                readOnly = true;
                internal = true;
                default = if pin == null then null else pin.repo;
                description = "`image`'s repository, parsed.";
              };
              tag = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                readOnly = true;
                internal = true;
                default = if pin == null then null else pin.tag;
                description = "`image`'s tag, parsed.";
              };
              digest = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                readOnly = true;
                internal = true;
                default = if pin == null then null else pin.digest;
                description = "`image`'s digest, parsed.";
              };
              version = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = if pin == null then null else pin.tag;
                defaultText = lib.literalMD "the tag of `image`";
                description = ''
                  What the row shows as running. A commit when `branch` is
                  set; otherwise the release, compared against `upstream`'s.
                '';
              };
              upstream = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                example = "nodejs/node";
                description = ''
                  The GitHub `owner/repo` whose releases (or, with `branch`,
                  commits) are this pin's notes. Null: whatever the control
                  plane already reads for the first of `containers`.
                '';
              };
              branch = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                example = "main";
                description = "Compare `version` as a commit on this branch of `upstream`, not as a release.";
              };
              parts = lib.mkOption {
                type = lib.types.attrsOf lib.types.str;
                default = { };
                example = {
                  cli = "0.39.0";
                  mise = "2026.8.16";
                };
                description = "Versions that move WITH this one, as one set — shown beside it.";
              };
              containers = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
                description = "Containers that run on this pin; empty for a pin no container runs.";
              };
              note = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = "What a bump takes beyond the edit, in one sentence.";
              };
              pinnedIn = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                example = "Dockerfile";
                description = ''
                  The file the literal lives in, relative to the root of the
                  repository whose module defines this entry. Null: that
                  module's own file, which is right unless the module reads
                  the pin from somewhere else. Ignored for a base the host
                  defines in `fleet.images`: that file is found by itself.
                '';
              };
              label = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                example = "org.opencontainers.image.base.digest";
                description = ''
                  The label of the built image that carries this base's
                  digest — set by mkLocalImage's `pins`. It is how the
                  image-update agent proves a moved base reached the running
                  containers, so a configuration pin without one gets no
                  Update button.
                '';
              };
            };
          }
        )
      );
      default = { };
      description = ''
        The pins that are not a container's own image: the base of a locally
        built image (mkLocalImage's `bases`, whose `pins` land here), a build
        tool's release, a source commit an image is built from. Each entry is
        a row on System › Updates that says what runs, whether its registry
        has something newer, and which file a bump edits.

        A base whose literal is in the configuration checkout — a host
        stack's, or a catalog module's read from `fleet.images` — is moved by
        the Update button like any container's pin: the agent rewrites it,
        rebuilds, and checks the running containers' images carry the new
        base (`label`). The rest are ordinary commits: the agent cannot write
        into the engine, so an engine pin is an engine commit, then
        Engine › Update; a version or a source commit is an edit by hand.

        Every container whose image is built on the box must appear in some
        entry's `containers` (asserted), so a new local image cannot be the
        one nothing lists.
      '';
    };

    imagePins = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      readOnly = true;
      internal = true;
      description = "Parsed `:tag@sha256:` pins, container → { image, repo, tag, digest }.";
    };

    export.domains = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            schemaVersion = lib.mkOption {
              type = lib.types.ints.positive;
              default = 1;
              description = "Version of this domain's data shape. Bump on breaking change; the app-side decoder gates on it.";
            };
            data = lib.mkOption {
              type = lib.types.attrsOf lib.types.anything;
              default = { };
              description = "The domain payload. Multiple modules may contribute keys; they merge.";
            };
          };
        }
      );
      default = { };
      description = ''
        Versioned JSON export domains published to daedalus at
        /run/daedalus-export/<domain>.json (mounted read-only at /export in
        the container). The fact-vs-config rule: env vars carry what daedalus
        needs to BE itself (endpoints, paths, credentials); these domains
        carry fleet facts its pages RENDER. A JSON blob in an env var is a
        rule violation by definition.
      '';
    };

    dashboard = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            env = lib.mkOption {
              type = lib.types.attrsOf lib.types.str;
              default = { };
              description = ''
                Environment the control plane's container carries on this
                stack's behalf, read by the engine BY NAME
                (`ctx.env('PIHOLE_URL')`, `CF_TUNNEL_ID`). Two kinds live
                here. Config — an endpoint or an id the app needs to reach
                the stack — belongs here for good. A pinned version
                (`*_VERSION`) belongs here only where the image tag is not
                the version: a tag that IS the version the engine reads from
                `/export/images.json` (`imageTag()` in
                app/src/lib/dashboard/images.ts). A key two stacks both set
                is a conflicting definition, not a silent override.
              '';
            };
            envFiles = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = ''
                `--env-file`s the stack renders for the control plane — the
                one secret it hands over (an API key, a shared token) copied
                out of its own decrypted secret by a `mkSecretRender` unit
                the stack owns, under a name the engine reads. The control
                plane never greps another stack's secret file: the owner
                decides what leaves it, and the render is gated by the
                owner's switch like everything else here.
              '';
            };
            volumes = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = ''
                Bind mounts the stack contributes to the control plane's
                container (`<host>:<container>:ro`). The DIRECTORY, never a
                file: every source here is replaced by rename or re-render,
                and a single-file bind would pin the old inode.
              '';
            };
          };
        }
      );
      default = { };
      description = ''
        What a stack shows the control plane, keyed by the stack's id. A
        stack that has something daedalus needs CONTRIBUTES it inside its
        own `mkIf`, so switching the stack off removes the entry, and
        daedalus reads the whole registry with defaults — it never indexes
        another stack's config by a fixed key. Same shape as
        `fleet.logStacks`.

        Facts a PAGE renders still go through `fleet.export.domains`; this is
        the config half — how the container is wired to a stack (env by
        name, a rendered secret, a mount).
      '';
    };
  };

  config = {
    fleet.export.domains = {
      # The box's identity, so the app never spells a domain, an address or
      # an account of its own.
      site = {
        data = {
          inherit (cfg)
            baseDomain
            wanHost
            lanIp
            stateRoot
            ;
          # What the box calls itself, where it is, and what it was built
          # as: the identity block Settings › General renders. All facts nix
          # already holds; restating them as exports is what stops the app
          # from ever typing one out.
          hostname = config.networking.hostName;
          timezone = config.time.timeZone;
          nixosVersion = config.system.nixos.version;
          # What System › Updates says about the release. The channel is
          # `nixos-<release>`; `revision` is the nixpkgs commit the flake
          # locked; `kernel` is this generation's, which a switch without a
          # reboot can leave ahead of the one running.
          nixos = {
            inherit (config.system.nixos)
              version
              release
              codeName
              revision
              ;
            kernel = config.boot.kernelPackages.kernel.version;
            inherit (config.system) stateVersion;
          };
          network = {
            interface = cfg.lanInterface;
            inherit (cfg) gateway;
          };
          inherit (cfg.github) owner;
          operator = {
            inherit (cfg.operator) user group uid;
          };
          mail = {
            inherit (cfg.mail) sender alertTo;
          };
          # The git identities site.json's `commits.author` chooses between,
          # for the picker on Settings › Site. The host agents carry the same
          # two values baked in (stacks/daedalus/host/lib.sh `commit_name`);
          # the document only ever names which.
          git = {
            box = {
              name = "daedalus";
              email = cfg.mail.sender;
            };
            operator = {
              name = cfg.operator.gitName;
              email = cfg.operator.gitEmail;
            };
          };
          # The control plane's address as Settings › General edits it: the
          # label site.json carries (null = not written yet), the one still
          # served after a rename until it is confirmed, and what the box
          # actually answers at.
          controlPlane =
            let
              w = cfg.webApps.daedalus or null;
            in
            {
              inherit (cfg.controlPlane) label previousLabel;
              hostname = if w == null then null else w.hostname;
              aliases = if w == null then [ ] else w.aliases;
            };
        }
        # The two services Settings links to, present only while they are
        # published: a stack that is switched off has no URL, and the decoder
        # reads an absent key as "" rather than a page-breaking null.
        // lib.optionalAttrs (cfg.webApps ? registry) {
          registryUrl = "https://${cfg.webApps.registry.hostname}";
        }
        // lib.optionalAttrs (cfg.webApps ? grafana) {
          grafanaUrl = "https://${cfg.webApps.grafana.hostname}";
        };
      };

      # Scheduled jobs worth noticing, and HOW each is noticed: `email` means
      # a failing run mails, `slug` means a run that stops happening pages
      # through healthchecks. Different guarantees; this registry is the only
      # place the pair is stated.
      jobs.data.monitoredJobs = lib.mapAttrsToList (unit: j: {
        inherit unit;
        inherit (j) email slug;
      }) cfg.monitoredJobs;

      # One map over every container rather than a variable per service,
      # because the alternative is a nix edit — and a rebuild — every time a
      # page wants to report a version that is already written down here.
      #
      # `pins` is the same containers seen from the other end: not what tag
      # they carry but what ref that tag was frozen from, and whether the
      # dashboard may move it. Together they are what the Updates page renders
      # — every digest-pinned container on the box, including the sidecars
      # and exporters that have no page of their own. `manual` is the rest:
      # the local builds' bases and the other hand-moved pins.
      images = {
        schemaVersion = 2;
        data = {
          tags = imageTags;
          pins = imagePinsWithPolicy;
          # The pins that are not a container's own image, with the file each
          # one is bumped in and whether the button moves it —
          # fleet.manualPins. Additive: a reader that predates it ignores it.
          manual = manualPins;
        };
      };

      # Which stacks this box runs: `fleet.modules.<id>.enable`, one boolean
      # per switch. The control plane's rail is derived from it — each tab
      # names the nix modules it fronts, and a tab whose modules are all off
      # is not offered (app/src/core/ctx.ts reads this,
      # app/src/lib/modules/active.ts decides). A flat id → bool map on purpose: the engine treats an id
      # this file does not mention as enabled, so a module the box has never
      # heard of cannot empty the rail.
      modules = {
        schemaVersion = 1;
        data = lib.mapAttrs (_: m: m.enable) cfg.modules;
      };

      # What switching a module off would take with it, and which ones may
      # not be switched at all. `structural` is fleet.structuralModules;
      # `stacks` is the log-stack registry (stack → containers), the one
      # place a multi-container stack names its members — a stack absent
      # from it is its one container of the same name. The page turns a
      # container list into the hostnames that stop answering through the
      # publishing export's serviceName.
      switches = {
        schemaVersion = 1;
        data = {
          structural = cfg.structuralModules;
          stacks = cfg.logStacks;
        };
      };
    };

    fleet.imagePins = imagePins;

    assertions =
      let
        covered = lib.concatMap (p: p.containers) (lib.attrValues cfg.manualPins);
        localBuilt = lib.attrNames (
          lib.filterAttrs (
            _: c: lib.hasPrefix "localhost/" c.image
          ) config.virtualisation.oci-containers.containers
        );
        shared = lib.intersectLists (lib.attrNames cfg.manualPins) (lib.attrNames imagePins);
        uncovered = lib.subtractLists covered localBuilt;
      in
      lib.mapAttrsToList (id: p: {
        assertion = (p.image == null || p.repo != null) && p.version != null;
        message = "fleet.manualPins.${id}: `image` must be `repo:tag@sha256:<digest>`, and a pin without one needs a `version`.";
      }) cfg.manualPins
      ++ [
        {
          # The probe publishes both registries into one freshness file, keyed
          # by id; a shared key would make one row read the other's verdict.
          assertion = shared == [ ];
          message = "fleet.manualPins ids must not name a digest-pinned container: ${toString shared}";
        }
        {
          # "Nothing hidden" stays true for the next local image too: one built
          # on the box has no digest pin, so without an entry it is on no list.
          assertion = uncovered == [ ];
          message = "containers built on the box but in no fleet.manualPins entry's `containers`: ${toString uncovered} (contribute the image's mkLocalImage `pins`, or an entry of your own)";
        }
      ];

    systemd.services.daedalus-export-publish = {
      description = "Publish fleet export domains for daedalus";
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      # The store paths in this script are the change detector: a domain edit
      # changes the unit, and switch-to-configuration re-runs it.
      script = ''
        mkdir -p ${publishDir}
        chmod 0755 ${publishDir}
        stamp="$(date -Is)"
        ${lib.concatStringsSep "\n" (
          lib.mapAttrsToList (name: file: ''
            ${pkgs.jq}/bin/jq --arg g "$stamp" '. + {generatedAt: $g}' ${file} > ${publishDir}/.${name}.tmp
            mv ${publishDir}/.${name}.tmp ${publishDir}/${name}.json
          '') rendered
        )}
        # The zone list of the tzdata this system is built with, which is the
        # set `time.timeZone` can name. daedalus's timezone picker offers
        # these and refuses anything else. Copied as tzdata's own file rather
        # than a domain: the app parses it, and a new tzdata changes this
        # store path, which re-runs the publisher.
        install -m 0644 ${config.environment.etc.zoneinfo.source}/zone.tab ${publishDir}/.zone.tab.tmp
        mv ${publishDir}/.zone.tab.tmp ${publishDir}/zone.tab
      '';
    };

    # A publisher that fails at boot leaves /export empty and every consuming
    # page degrading visibly — mail on it like the other platform oneshots.
    fleet.monitoredJobs.daedalus-export-publish = { };
  };
}
