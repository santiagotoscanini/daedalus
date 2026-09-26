# The site-format samples, evaluated through the engine's own readers.
#
# `site-formats/` at the repository root holds one directory per document per
# schema version: `site/v<N>/` is a whole site directory whose site.json is at
# version N, `apps/v<N>/apps.json` is the app registry at version N, and
# `nodes/v<N>/nodes.json` the nodes document at version N. A site sample
# carries an apps.json and a nodes.json of its own — COPIES of the current
# samples, since a link would not survive the store copy a nix path literal
# makes of the directory — and each pair is asserted equal below.
# The daedalus app's vitest reads the same files through its readers
# (app/src/host/contract/site-formats.test.ts); this is the nix half, so that a
# reader that drifts from the writer fails in `nix flake check` and in
# `pnpm test`, never on a box.
#
# Two readers, exercised the way a host exercises them:
#
#   site.json     platform/site.nix defines the fleet constants FROM the
#                 document, inside a NixOS evaluation. So each site sample is
#                 handed to the example host as its `fleet.site.source` and the
#                 whole system is instantiated — every option read resolves,
#                 every assertion holds — exactly as `checks.example-host` does
#                 for the current version.
#   apps.json     platform/lib/registry-lib.nix is the ONE mapper from an
#                 entry to a `fleet.apps.<name>` value, a pure function on the
#                 JSON. Each registry sample is asserted to be at a version
#                 the mapper accepts and every entry is mapped and forced.
#   nodes.json    platform/site.nix reads it into `fleet.nodes`, and
#                 platform/nodes.nix asserts the names; the copy inside the
#                 site sample is what the example host evaluates.
#
# EVALUATED, never built: forcing a toplevel's drvPath instantiates every
# derivation of a system without realising one. A new schema version is a
# new sample directory and nothing here changes.
{
  nixpkgs,
  nixpkgs-unstable,
  sops-nix,
  engine,
  system ? "x86_64-linux",
}:
let
  inherit (nixpkgs) lib;
  pkgs = nixpkgs.legacyPackages.${system};

  samples = ../../site-formats;

  # The `v<N>` directories under one document's sample root.
  versionsOf =
    doc:
    lib.attrNames (
      lib.filterAttrs (name: kind: kind == "directory" && lib.hasPrefix "v" name) (
        builtins.readDir (samples + "/${doc}")
      )
    );

  # One minimal host per site sample — the example host, as checks.example-host
  # evaluates it (nix/tests/example-host), with the site directory swapped for
  # the sample. mkForce, because the example host names its own site directory.
  siteHosts = lib.genAttrs (versionsOf "site") (
    v:
    nixpkgs.lib.nixosSystem {
      inherit system;
      specialArgs = {
        inherit nixpkgs-unstable;
        enginePath = "${engine}/nix";
      };
      modules = [
        sops-nix.nixosModules.sops
        engine.nixosModules.default
        ../../example-host/configuration.nix
        { fleet.site.source = lib.mkForce (samples + "/site/${v}"); }
      ];
    }
  );

  registryLib = import ../platform/lib/registry-lib.nix { inherit lib; };

  # Every entry of every registry sample, through the mapper.
  registries = lib.genAttrs (versionsOf "apps") (
    v:
    let
      doc = builtins.fromJSON (builtins.readFile (samples + "/apps/${v}/apps.json"));
    in
    if lib.elem doc.schemaVersion registryLib.acceptedSchemaVersions then
      lib.mapAttrs (_: registryLib.mkApp) doc.apps
    else
      throw "site-formats/apps/${v}/apps.json declares schemaVersion ${toString doc.schemaVersion}; registry-lib.nix accepts ${builtins.toJSON registryLib.acceptedSchemaVersions}"
  );

  # The copy inside each site sample must be one of the registry samples,
  # byte for byte, or the two halves of one directory would drift apart.
  copiesAgree = lib.all (
    v:
    let
      copy = builtins.readFile (samples + "/site/${v}/apps.json");
      originals = map (a: builtins.readFile (samples + "/apps/${a}/apps.json")) (versionsOf "apps");
    in
    lib.elem copy originals
    || throw "site-formats/site/${v}/apps.json is not a byte-for-byte copy of any site-formats/apps/v*/apps.json"
  ) (versionsOf "site");

  nodeCopiesAgree = lib.all (
    v:
    let
      copy = builtins.readFile (samples + "/site/${v}/nodes.json");
      originals = map (a: builtins.readFile (samples + "/nodes/${a}/nodes.json")) (versionsOf "nodes");
    in
    lib.elem copy originals
    || throw "site-formats/site/${v}/nodes.json is not a byte-for-byte copy of any site-formats/nodes/v*/nodes.json"
  ) (versionsOf "site");

  forced = builtins.deepSeq registries (
    builtins.seq (copiesAgree && nodeCopiesAgree) (
      lib.mapAttrsToList (_: host: host.config.system.build.toplevel.drvPath) siteHosts
    )
  );
in
pkgs.runCommand "site-formats-evaluate" { } (
  builtins.seq (builtins.deepSeq forced null) ''
    echo "site samples: ${lib.concatStringsSep " " (lib.attrNames siteHosts)}"
    echo "apps samples: ${lib.concatStringsSep " " (lib.attrNames registries)}"
    echo "nodes samples: ${lib.concatStringsSep " " (versionsOf "nodes")}"
    touch $out
  ''
)
