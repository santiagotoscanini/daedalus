{
  config,
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
# /export and decodes each file through src/host/contract/ — one mechanism,
# versioned and stamped, replacing the hand-built manifest, the per-fact env
# variables and their ad-hoc JSON blobs.
#
# Why this shape:
#
#   Stable-path delivery, store-path change detection. The old manifest was a
#   store path bound straight into the container, so ANY change restarted the
#   app — during an Apply, that killed the page showing the progress bar. Here
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

  # Every image pinned as `:tag@sha256:…`, parsed once here because three
  # consumers need the same answer: the export domain the dashboard reads, the
  # daily freshness probe, and the update agent that rewrites a pin.
  #
  # ANY digest-on-a-tag pin qualifies, not just the moving channels — a
  # re-pushed `2.10.1` is the same fact as a moved `latest`, and which tags
  # count as "moving" is a judgement the reader makes with the tag in hand.
  # Local builds (mkLocalImage) and the registry-loop apps carry no digest and
  # fall out of the match.
  #
  # `digest` is the load-bearing field. It is the one part of a pin that is
  # ALWAYS a literal in the .nix source — immich's two interpolate a shared
  # version variable into the tag, so the
  # rendered `tag` appears nowhere in the file. The update agent anchors every
  # edit on the digest for exactly that reason; see host/image-update.sh.
  imagePins = lib.filterAttrs (_: v: v != null) (
    lib.mapAttrs (
      _: c:
      let
        m = builtins.match "(.*):([^@:]+)@(sha256:[0-9a-f]+)" c.image;
      in
      if m == null then
        null
      else
        {
          image = "${builtins.elemAt m 0}:${builtins.elemAt m 1}";
          repo = builtins.elemAt m 0;
          tag = builtins.elemAt m 1;
          digest = builtins.elemAt m 2;
        }
    ) config.virtualisation.oci-containers.containers
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
    }
  ) imagePins;
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
                move is not a pin edit at all. The precedent is a Nextcloud
                MAJOR, which is a version variable plus a run of `occ`
                chores that no rebuild performs.
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
                a netns ten containers ride, and a pg bounce takes pocket-id
                with it and everything pocket-id gates.
              '';
            };
          };
        }
      );
      default = { };
      description = ''
        Per-container policy for updating a digest-pinned image from
        daedalus. Every pinned container is updatable with no entry here;
        this registry exists for the ones where that is not the whole truth.
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
                (`process.env.N8N_VERSION`, `PIHOLE_URL`, `CF_TUNNEL_ID`).
                Two kinds live here. Config — an endpoint or an id the app
                needs to reach the stack — belongs here for good. A pinned
                version is the honest intermediate: the same fact already
                rides `/export/images.json`, and each `*_VERSION` entry is
                deleted the day the engine reads it from there
                (`imageTag()`) instead of by name. A key two stacks both set
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
        What a stack shows the control plane, keyed by the stack's id. The
        inversion Phase 9c made: a stack that has something daedalus needs
        CONTRIBUTES it inside its own `mkIf`, so switching the stack off
        removes the entry, and daedalus reads the whole registry with
        defaults — it never indexes another stack's config by a fixed key.
        Same shape as `fleet.logStacks` and `fleet.mcpServers`.

        Facts a PAGE renders still go through `fleet.export.domains`; this is
        the config half — how the container is wired to a stack (env by
        name, a rendered secret, a mount).
      '';
    };

    github.owner = lib.mkOption {
      type = lib.types.str;
      description = "GitHub account the app repos and CI live under. The host defines it.";
    };
  };

  config = {
    fleet.export.domains = {
      # The box's identity — everything that used to be a literal in the app.
      # After the readers flip, a grep of app/src for the domain returns prose.
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
          # What Settings › General says about the release. The channel is
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
      # — every digest-pinned container on the box, including the two dozen
      # sidecars and exporters that have no page of their own and until now
      # appeared in this app only as somebody else's log embed.
      images = {
        schemaVersion = 2;
        data = {
          tags = imageTags;
          pins = imagePinsWithPolicy;
        };
      };

      # Which stacks this box runs: `fleet.modules.<id>.enable`, one boolean
      # per switch. The control plane's rail is derived from it — each tab
      # names the nix modules it fronts, and a tab whose modules are all off
      # is not offered (engine: core/ctx.ts reads this, lib/modules/active.ts
      # decides). A flat id → bool map on purpose: the engine treats an id
      # this file does not mention as enabled, so a module the box has never
      # heard of cannot empty the rail.
      modules = {
        schemaVersion = 1;
        data = lib.mapAttrs (_: m: m.enable) cfg.modules;
      };
    };

    fleet.imagePins = imagePins;

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
