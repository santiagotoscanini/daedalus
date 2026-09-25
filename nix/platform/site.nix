{
  config,
  lib,
  options,
  ...
}:

# fleet.site — the site directory: the one place in the operator's
# configuration that daedalus writes, and the seam through which nix reads it.
#
# The end state this is a piece of: the box is two repositories. An ENGINE
# (public, a single NixOS module import) and the operator's own CONFIG flake —
# hardware, host identity, whatever they hand-write — with one directory,
# `site/`, that holds what this particular box IS as plain JSON: its domain,
# its addresses, its app registry, its encrypted secrets. Only that directory
# changes when an operator configures the box from the UI, and it is the one
# directory a web UI can safely write to, because nothing in it is code.
#
#   path     the host agents' door — the directory daedalus writes (site-write
#            and Apply). A runtime string.
#   source   the MODULE side — the same directory as nix sees it: `./site` in
#            the operator's flake, a store path at eval. Null used to mean
#            "read the legacy locations"; there are none left, so it now fails
#            eval. Nix must never read `path` directly: it is a runtime
#            string, and eval is pure.
#
# Since Phase 5, site.json is THE SOURCE of the site constants: the domain, the
# LAN address and interface, the gateway, the WAN host, the DHCP scope, the DNS
# upstreams, the mail identities, the timezone and the Cloudflare zone,
# account and tunnel ids. They are defined HERE from the document and nowhere
# else — the host config and the tunnel stack no longer carry them — so
# editing one in the UI is a commit to site/ and a rebuild, and nothing can
# drift. The parts of site.json that are NOT yet sourced (hostname, owner,
# operator) stay asserted equal to the configuration, as belt and braces,
# until a later phase moves them too.
#
# The Cloudflare identity is the BOX's, not the tunnel's, which is why it
# lives here with the box's one API token (site/vault/) rather than in
# stacks/cloudflared: traefik's DNS-01, ddclient and daedalus's DNS panel all
# read the token whether or not the tunnel runs, and Phase 9c made the tunnel
# switchable on exactly that observation.
#
# The zone travels with the domain: daedalus offers the zones the DNS token
# can see and writes the pair together, because a domain whose zone id still
# names the old zone would point traefik's ACME challenge and the tunnel's
# DNS reconciler at the wrong place.
#
# `registry.file` is the same idea for the app registry: `site/apps.json`,
# and nothing else — the legacy `stacks/apps/apps.json` was deleted, so the
# unsourced branch is a `throw` rather than a path that no longer resolves.
#
# Source control of that directory is the operator's business, with one
# exception the agents cannot delegate: a flake sees only git-TRACKED files,
# so what they write is always staged when the directory is in a work tree.
# Committing is a switch. See stacks/daedalus/host/site-lib.sh.

let
  cfg = config.fleet;
  sourced = cfg.site.source != null;

  # site.json as the module sees it — read only when a source is set.
  siteDoc =
    if sourced then builtins.fromJSON (builtins.readFile "${cfg.site.source}/site.json") else null;

  # site/nodes.json — the approved nodes, as an Apply writes them
  # (platform/nodes.nix says what is in it and why so little). Optional: a
  # site written before nodes existed, or a box with none, has no file and
  # no nodes. One schema version so far; a document from a newer control
  # plane fails here by name rather than as a missing attribute.
  nodesFile = "${cfg.site.source}/nodes.json";
  nodesDoc =
    if sourced && builtins.pathExists nodesFile then
      builtins.fromJSON (builtins.readFile nodesFile)
    else
      null;
  nodesSchemaVersions = [ 1 ];

  # site.json `modules.enabled` — the switches the control plane flips.
  #
  # An object, id → bool, holding ONLY the modules the operator moved from
  # their page ("Switch off" on a service's page, or Settings › Modules): a
  # module the document does not name keeps whatever the host's own files
  # say, so an old document changes nothing. A named id becomes a definition
  # of `fleet.modules.<id>.enable` at priority 60 — stronger than the plain
  # definition in a host's `host/modules.nix` or a stack's `default = true`,
  # weaker than a `mkForce` a host writes on purpose. Two things are refused
  # at eval rather than crashing it: an id no imported module declares (a
  # document from a box that runs a stack this one lacks), and a structural
  # module switched off (below).
  siteSwitches = if sourced then (siteDoc.modules or { }).enabled or { } else { };
  declaredSwitches = builtins.attrNames options.fleet.modules;
  knownSwitches = lib.filterAttrs (id: _: builtins.elem id declaredSwitches) siteSwitches;
  unknownSwitches = builtins.attrNames (removeAttrs siteSwitches declaredSwitches);
  structuralOff = builtins.attrNames (
    lib.filterAttrs (id: on: !on && builtins.elem id cfg.structuralModules) knownSwitches
  );

  # site.json `modules.web` — where a module's published hostnames answer
  # and whether the tunnel carries them: the two facts a service's page
  # lets the operator move beside its switch (the cog on the page, or
  # Settings › Modules). Keyed by the webApp's name, `fleet.webApps.<name>`,
  # holding only what the operator set. `label` is the one label under the
  # base domain — the hostname becomes `<label>.<baseDomain>`, never a full
  # hostname in the document, because one label is all the wildcard
  # certificate matches and the control plane already validates it as such.
  # `public` is `exposeRemotely`. Each present, non-null field becomes a
  # definition at priority 60, like a switch: stronger than a module's own
  # hostname (`hc.` for healthchecks, `status.` for gatus) or its policy's
  # default, weaker than a host's mkForce. A name this host publishes
  # nothing under is refused by the assertion below, by name; the stray
  # entry would also trip publishing.nix's one-upstream assertion.
  siteWeb = if sourced then (siteDoc.modules or { }).web or { } else { };
  webOverride =
    w:
    lib.optionalAttrs (w.label or null != null) {
      hostname = lib.mkOverride 60 "${w.label}.${cfg.baseDomain}";
    }
    // lib.optionalAttrs (w.public or null != null) { exposeRemotely = lib.mkOverride 60 w.public; };
  # site.json `modules.players` — who may join a game server, moved from its
  # page. Keyed by module id, each a list of accounts: the name as the
  # vendor spells it, the vendor's id for it, and whether it runs commands.
  # The control plane resolves both from the vendor before it writes one, so
  # a stack can admit by id and never looks a name up at start. Unlike
  # `enabled` and `web` this is not an override of anything: a stack that
  # reads it takes it as its whole roster. An id no imported module declares
  # is refused below, like a switch.
  sitePlayers = if sourced then (siteDoc.modules or { }).players or { } else { };
  unknownPlayers = builtins.attrNames (removeAttrs sitePlayers declaredSwitches);

  unknownWeb = builtins.attrNames (
    lib.filterAttrs (
      n: _:
      let
        w = cfg.webApps.${n};
      in
      w.serviceName == null && w.serviceUrl == null && w.traefikService == null
    ) siteWeb
  );

  same = name: a: b: {
    assertion = a == b;
    message = "site.json disagrees with the configuration about ${name}: site.json says ${builtins.toJSON a}, configuration.nix says ${builtins.toJSON b}. This value is not yet sourced from site.json; write site.json again from Settings › Site.";
  };
in
{
  options.fleet = {
    # The modules a running box cannot do without: the control plane refuses
    # to switch these off from its pages, and site.json naming one off is an
    # eval error. The engine's default is its own spine — the proxy every
    # hostname rides, the identity provider that gates the control plane,
    # the cluster, the resolver the box itself resolves through, the
    # registry the apps pull from, the log and metric pipeline, the apps
    # platform daedalus IS an app on, and daedalus itself. A host appends
    # what its own stacks make structural (a netns owner with tenants, a
    # gateway whose sidecars write into another stack's bridge) in
    # host/modules.nix; the module-system rule in the reference host's
    # repository is the reasoning per stack. The spine is a DEFINITION below,
    # not the option's default: list definitions concatenate, a default is
    # replaced by the first one.
    structuralModules = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Module ids the control plane must not switch off; site.json switching one off fails evaluation. The engine defines its spine; a host appends its own.";
    };

    site = {
      path = lib.mkOption {
        type = lib.types.str;
        default = "${cfg.config.repo}/site";
        defaultText = lib.literalExpression ''"''${config.fleet.config.repo}/site"'';
        description = ''
          The site directory on disk: `site/` inside the operator's
          configuration repository, where the host agents write. Stating it
          is only needed when the configuration lives somewhere else.

          A path for HOST AGENTS only. The module side reads `fleet.site.source`,
          which is the same directory as nix sees it — a store path.
        '';
      };

      source = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        description = ''
          Where nix READS site data from: `./site` in the operator's flake
          (a store path), never `fleet.site.path`. Null was "read the legacy
          locations" while the constants still lived in `configuration.nix`
          and the registry in `stacks/apps/apps.json`; neither exists now, so
          leaving it null fails eval rather than falling back.
        '';
      };

      players = lib.mkOption {
        type = lib.types.attrsOf (
          lib.types.listOf (
            lib.types.submodule {
              options = {
                # Held to the charsets the vendors allow: these reach rendered
                # files and RCON command lines.
                name = lib.mkOption {
                  type = lib.types.strMatching "[A-Za-z0-9_]{1,16}";
                  description = "The account's name as the vendor spells it.";
                };
                uuid = lib.mkOption {
                  type = lib.types.strMatching "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
                  description = "The vendor's id for the account, dashed and lower-case. What a server admits on; a rename does not change it.";
                };
                op = lib.mkOption {
                  type = lib.types.bool;
                  default = false;
                  description = "Whether the account may run server commands.";
                };
              };
            }
          )
        );
        default = { };
        description = ''
          Who may join each game server, by module id (site.json
          `modules.players`), as the control plane wrote it from the server's
          page. Defined from the document only; a host does not set it. A module absent here has no roster from the document; what it
          does then is its own choice.
        '';
      };
    };

    registry.file = lib.mkOption {
      type = lib.types.path;
      default =
        if sourced then
          "${cfg.site.source}/apps.json"
        else
          throw "fleet.registry.file: the app registry lives at site/apps.json now — the legacy stacks/apps/apps.json is gone. Set fleet.site.source (configuration.nix does: site.source = ./site).";
      description = ''
        The app registry daedalus exports and `stacks/apps/declarations.nix`
        builds from — NOT the container registry (`fleet.webApps.registry`,
        the zot).
      '';
    };

    # The network facts that used to be literals in configuration.nix and
    # stacks/pihole. Declared here because site.json is their source; a
    # configuration without a site would set them by hand.
    lanInterface = lib.mkOption {
      type = lib.types.str;
      description = "The NIC carrying fleet.lanIp. Hardware, and the one place the name is written.";
    };
    gateway = lib.mkOption {
      type = lib.types.str;
      description = "The LAN's default gateway — the router.";
    };
    dnsUpstreams = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      description = "Where pi-hole forwards what it does not answer itself.";
    };
    dhcp = {
      active = lib.mkOption {
        type = lib.types.bool;
        description = "Whether pi-hole serves DHCP for the LAN.";
      };
      router = lib.mkOption {
        type = lib.types.str;
        description = "The router pi-hole hands out to DHCP clients.";
      };
      start = lib.mkOption {
        type = lib.types.str;
        description = "First address of the DHCP pool.";
      };
      end = lib.mkOption {
        type = lib.types.str;
        description = "Last address of the DHCP pool.";
      };
      leaseTime = lib.mkOption {
        type = lib.types.str;
        description = "DHCP lease time, in dnsmasq's notation (`8h`).";
      };
    };

    # The daedalus GitHub App — who it is, never its secrets (those are
    # site/vault/github-app.sops). Written by the App's manifest callback
    # together with the vault file, and read by stacks/daedalus: the token
    # minter signs as `clientId` and finds the installation on `ownerId`.
    github.app = lib.mkOption {
      type = lib.types.nullOr (
        lib.types.submodule {
          options = {
            id = lib.mkOption {
              type = lib.types.ints.positive;
              description = "The App's numeric id.";
            };
            # slug and owner are held to GitHub's own charset for slugs and
            # logins: they reach shell variables and journal lines (the
            # minter's "not installed on <owner>"), where a newline could
            # forge a log line.
            slug = lib.mkOption {
              type = lib.types.strMatching "[A-Za-z0-9-]+";
              description = "The App's URL name (`github.com/apps/<slug>`).";
            };
            clientId = lib.mkOption {
              type = lib.types.strMatching "[A-Za-z0-9._-]+";
              description = "The App's client id — the JWT issuer the token minter signs as.";
            };
            htmlUrl = lib.mkOption {
              type = lib.types.strMatching "https://github\\.com/.+";
              description = "The App's settings page on GitHub.";
            };
            owner = lib.mkOption {
              type = lib.types.strMatching "[A-Za-z0-9-]+";
              description = "Login of the account that owns the App.";
            };
            ownerId = lib.mkOption {
              type = lib.types.ints.positive;
              description = "Numeric id of that account — what the minter matches the installation on, because a login can be renamed.";
            };
          };
        }
      );
      default = null;
      description = ''
        The GitHub App as site.json records it (`github.app`), or null when
        none has been created. Present if and only if
        site/vault/github-app.sops is (asserted in stacks/daedalus).
      '';
    };

    # The account the box trusts to own the App and every repository it
    # builds. A constant of this box, NOT sourced from site.json: the daedalus
    # container writes site.json through Apply, and a planted `ownerId` there
    # must not steer the token minter or the build agent to another account's
    # installation. The assertion below holds site.json's copy to it.
    github.expectedOwnerId = lib.mkOption {
      type = lib.types.ints.positive;
      description = "Numeric GitHub account id that must own the daedalus GitHub App and the repositories it builds. The HOST defines it, in nix: the one copy the control plane cannot rewrite.";
    };

    # The control plane's own address, as a label under the domain. Sourced
    # here and consumed by stacks/daedalus: the label is the only part a person
    # edits — the scheme is always https and the domain is `baseDomain`.
    controlPlane = {
      label = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = ''
          `<label>.<baseDomain>` is where the control plane answers
          (site.json `identity.controlPlane`). Null keeps the hostname its
          module declares (stacks/daedalus/self.json).
        '';
      };
      previousLabel = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = ''
          The label before the last rename, still served as an alias until
          the operator confirms the new address from the new address itself
          (site.json `identity.controlPlanePrevious`). Null once confirmed —
          a rename can never lock the operator out of the page that undoes it.
        '';
      };
    };
  };

  config = lib.mkMerge [
    {
      # The engine's spine, structural on every host.
      fleet.structuralModules = [
        "app-db"
        "apps"
        "cloudflared"
        "daedalus"
        "gatus"
        "healthchecks"
        "logging"
        "monitoring"
        "pihole"
        "pocket-id"
        "registry"
        "traefik"
      ];
    }
    (lib.mkIf sourced {
      # The sourced constants. Plain definitions, not mkDefault: there must be
      # exactly one place these are written, and it is the document.
      fleet = {
        # The switches the document names, at a priority the host's own files
        # yield to. Only declared ids reach a definition; the rest are the
        # assertion below, which is why this cannot be an "option does not
        # exist" crash.
        modules = lib.mapAttrs (_: on: {
          enable = lib.mkOverride 60 on;
        }) knownSwitches;

        # The hostnames and exposure the document moves (`modules.web`).
        webApps = lib.mapAttrs (_: webOverride) siteWeb;

        # Fields picked by name, for the reason `nodes` gives below.
        site.players = lib.mapAttrs (
          _:
          map (p: {
            inherit (p) name uuid;
            op = p.op or false;
          })
        ) sitePlayers;

        # The fields are picked by name so a key the control plane adds later
        # cannot fail the submodule's type check before this module learns it.
        nodes = map (n: {
          inherit (n)
            id
            name
            os
            ;
          providers = lib.mapAttrs (_: p: { inherit (p) port; }) (n.providers or { });
        }) (if nodesDoc == null then [ ] else nodesDoc.nodes);
        inherit (siteDoc.identity) baseDomain;
        inherit (siteDoc.network) lanIp;
        inherit (siteDoc.network) wanHost;
        lanInterface = siteDoc.network.interface;
        inherit (siteDoc.network) gateway;
        inherit (siteDoc.network) dnsUpstreams;
        dhcp = {
          inherit (siteDoc.network.dhcp)
            active
            router
            start
            end
            leaseTime
            ;
        };
        mail = {
          inherit (siteDoc.mail) sender alertTo;
        };
        cloudflare = {
          inherit (siteDoc.cloudflare) zoneId accountId tunnelId;
          tokenEnvFile = config.sops.templates."cloudflare-api-token.env".path;
        };
        # `or`: a site.json written before these fields existed still builds,
        # and keeps the address stacks/daedalus declares. "" reads as unset.
        controlPlane =
          let
            unset = v: if v == "" then null else v;
          in
          {
            label = unset (siteDoc.identity.controlPlane or null);
            previousLabel = unset (siteDoc.identity.controlPlanePrevious or null);
          };
        # `or`: absent (or `"github": null`) until an App exists. The fields are
        # picked by name so a key the engine adds later cannot fail the
        # submodule's type check before this module learns about it.
        github.app =
          let
            app = siteDoc.github.app or null;
          in
          if app == null then
            null
          else
            {
              inherit (app)
                id
                slug
                clientId
                htmlUrl
                owner
                ownerId
                ;
            };
      };

      # The box's ONE Cloudflare API token. Its only home is site/vault/, where
      # Settings › Integrations writes a replacement: a binary sops file holding
      # the raw value. The one template renders it under lego's variable name
      # CF_DNS_API_TOKEN, the dotenv line every consumer reads (traefik's
      # DNS-01, ddclient, route-sync, daedalus), and each consumer adds its own
      # unit to `restartUnits`, so a rotation reaches them without the manual
      # restart the false-success trap otherwise demands.
      # Scopes it needs: Zone:Read + DNS:Edit (all zones) and Account "Cloudflare
      # One Connector: cloudflared" Read (daedalus's tunnel panels).
      sops.secrets."cloudflare-api-token" = {
        sopsFile = "${cfg.site.source}/vault/cloudflare-api-token.sops";
        format = "binary";
      };
      sops.templates."cloudflare-api-token.env" = {
        content = ''
          CF_DNS_API_TOKEN=${config.sops.placeholder."cloudflare-api-token"}
        '';
        owner = cfg.operator.user;
      };

      # Every container gets it as TZ (platform/podman.nix), so a change here
      # restarts the fleet on the next switch. That is what changing a timezone
      # means on this box, not a side effect of how it is sourced.
      time.timeZone = siteDoc.identity.timezone;

      # Belt and braces for what is NOT sourced yet: these must agree exactly,
      # and a stale copy fails the build rather than a page three days later.
      assertions = [
        {
          assertion = unknownSwitches == [ ];
          message = "site.json modules.enabled names modules this host does not import: ${lib.concatStringsSep ", " unknownSwitches}. Switch them from a host that runs them, or remove the entries.";
        }
        {
          assertion = structuralOff == [ ];
          message = "site.json modules.enabled switches off structural modules: ${lib.concatStringsSep ", " structuralOff}. These are in fleet.structuralModules; a running box cannot do without them.";
        }
        {
          assertion = unknownPlayers == [ ];
          message = "site.json modules.players names modules this host does not import: ${lib.concatStringsSep ", " unknownPlayers}. Move the roster from a host that runs them, or remove the entries.";
        }
        {
          assertion = unknownWeb == [ ];
          message = "site.json modules.web names hostnames this host does not publish: ${lib.concatStringsSep ", " unknownWeb}. Move them from a host that publishes them, or remove the entries.";
        }
        (same "hostname" siteDoc.identity.hostname config.networking.hostName)
        (same "owner" siteDoc.identity.owner cfg.github.owner)
        (same "operator.user" siteDoc.identity.operator.user cfg.operator.user)
        {
          assertion = cfg.github.app == null || cfg.github.app.ownerId == cfg.github.expectedOwnerId;
          message = "site.json github.app.ownerId (${toString cfg.github.app.ownerId}) is not fleet.github.expectedOwnerId (${toString cfg.github.expectedOwnerId}): the GitHub App must belong to the account this box trusts. If the account really changed, change fleet.github.expectedOwnerId in the host config deliberately.";
        }
      ]
      ++ lib.optional (nodesDoc != null) {
        assertion = lib.elem (nodesDoc.schemaVersion or null) nodesSchemaVersions;
        message = "site/nodes.json declares schemaVersion ${
          builtins.toJSON (nodesDoc.schemaVersion or null)
        }, but this engine understands ${builtins.toJSON nodesSchemaVersions}.";
      };
    })
  ];
}
