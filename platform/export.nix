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
# /export and decodes each file through src/lib/contract/ — one mechanism,
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
        data = domain.data;
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
in
{
  options.fleet = {
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

    operator = {
      user = lib.mkOption {
        type = lib.types.str;
        default = "santiago";
        description = "The box's sole human admin — the user host agents chown container-readable files to.";
      };
      group = lib.mkOption {
        type = lib.types.str;
        default = "users";
        description = "The operator's primary group.";
      };
      uid = lib.mkOption {
        type = lib.types.int;
        default = 1000;
        description = "The operator's uid — container UID 0 maps onto it under rootless podman.";
      };
    };

    github.owner = lib.mkOption {
      type = lib.types.str;
      default = "santiagotoscanini";
      description = "GitHub account the app repos and CI live under.";
    };
  };

  config = {
    fleet.export.domains = {
      # The box's identity — everything that used to be a literal in the app.
      # After the readers flip, `grep -r 'toscanini' app/src` returns prose.
      site = {
        data = {
          inherit (cfg)
            baseDomain
            wanHost
            lanIp
            stateRoot
            ;
          owner = cfg.github.owner;
          operator = {
            inherit (cfg.operator) user group uid;
          };
          registryUrl = "https://${cfg.webApps.registry.hostname}";
          grafanaUrl = "https://${cfg.webApps.grafana.hostname}";
          mail = {
            inherit (cfg.mail) sender alertTo;
          };
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
      images.data.tags = imageTags;
    };

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
      '';
    };

    # A publisher that fails at boot leaves /export empty and every consuming
    # page degrading visibly — mail on it like the other platform oneshots.
    fleet.monitoredJobs.daedalus-export-publish = { };
  };
}
