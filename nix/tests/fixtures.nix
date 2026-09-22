# The schema fixtures, evaluated through the engine's own readers.
#
# `fixtures/` at the repository root holds one directory per document per
# schema version: `site/v<N>/` is a whole site directory whose site.json is at
# version N, and `apps/v<N>/apps.json` is the app registry at version N. A
# site fixture carries an apps.json of its own — a COPY of the current
# registry fixture, since a link would not survive the store copy a nix path
# literal makes of the directory — and the two are asserted equal below.
# The daedalus app's vitest reads the same files through its readers
# (app/src/host/contract/fixtures.test.ts); this is the nix half, so that a
# reader that drifts from the writer fails in `nix flake check` and in
# `pnpm test`, never on a box.
#
# Two readers, exercised the way a host exercises them:
#
#   site.json     platform/site.nix defines the fleet constants FROM the
#                 document, inside a NixOS evaluation. So each site fixture is
#                 handed to the minimal host as its `fleet.site.source` and the
#                 whole system is instantiated — every option read resolves,
#                 every assertion holds — exactly as `checks.minimal-host` does
#                 for the current version.
#   apps.json     platform/lib/registry-lib.nix is the ONE mapper from an
#                 entry to a `fleet.apps.<name>` value, a pure function on the
#                 JSON. Each registry fixture is asserted to be at a version
#                 the mapper accepts and every entry is mapped and forced.
#
# EVALUATED, never built: forcing a toplevel's drvPath instantiates every
# derivation of a system without realising one. A new schema version is a
# new fixture directory and nothing here changes.
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

  fixtures = ../../fixtures;

  # The `v<N>` directories under one document's fixture root.
  versionsOf =
    doc:
    lib.attrNames (
      lib.filterAttrs (name: kind: kind == "directory" && lib.hasPrefix "v" name) (
        builtins.readDir (fixtures + "/${doc}")
      )
    );

  # One minimal host per site fixture — the same modules as checks.minimal-host
  # (nix/tests/minimal-host), with the site directory swapped for the fixture.
  # mkForce, because host.nix names the current version's fixture itself.
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
        ./minimal-host/host.nix
        { fleet.site.source = lib.mkForce (fixtures + "/site/${v}"); }
      ];
    }
  );

  registryLib = import ../platform/lib/registry-lib.nix { inherit lib; };

  # Every entry of every registry fixture, through the mapper.
  registries = lib.genAttrs (versionsOf "apps") (
    v:
    let
      doc = builtins.fromJSON (builtins.readFile (fixtures + "/apps/${v}/apps.json"));
    in
    if lib.elem doc.schemaVersion registryLib.acceptedSchemaVersions then
      lib.mapAttrs (_: registryLib.mkApp) doc.apps
    else
      throw "fixtures/apps/${v}/apps.json declares schemaVersion ${toString doc.schemaVersion}; registry-lib.nix accepts ${builtins.toJSON registryLib.acceptedSchemaVersions}"
  );

  # The copy inside each site fixture must be one of the registry fixtures,
  # byte for byte, or the two halves of one directory would drift apart.
  copiesAgree = lib.all (
    v:
    let
      copy = builtins.readFile (fixtures + "/site/${v}/apps.json");
      originals = map (a: builtins.readFile (fixtures + "/apps/${a}/apps.json")) (versionsOf "apps");
    in
    lib.elem copy originals
    || throw "fixtures/site/${v}/apps.json is not a byte-for-byte copy of any fixtures/apps/v*/apps.json"
  ) (versionsOf "site");

  forced = builtins.deepSeq registries (
    builtins.seq copiesAgree (
      lib.mapAttrsToList (_: host: host.config.system.build.toplevel.drvPath) siteHosts
    )
  );
in
pkgs.runCommand "schema-fixtures-evaluate" { } (
  builtins.seq (builtins.deepSeq forced null) ''
    echo "site fixtures: ${lib.concatStringsSep " " (lib.attrNames siteHosts)}"
    echo "apps fixtures: ${lib.concatStringsSep " " (lib.attrNames registries)}"
    touch $out
  ''
)
