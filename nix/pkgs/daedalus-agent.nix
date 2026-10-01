# The daedalus agent (agent/), as the box runs it: the controller and the root
# helper (stacks/daedalus/controller.nix). Built from the crate's own files only
# (Cargo.toml, Cargo.lock, build.rs, src/), so a commit that touches anything
# else in the repository does not rebuild it; its version names that source
# (`+src.<hash>`, agent/README.md "Versions"). No tray
# (`--no-default-features`), only `daedalus-agent`. The tests run in the
# crate's own gate (agent/gate.sh) and in CI, not here.
{ lib, rustPlatform }:

let
  crate = ../../agent;
  cargoToml = builtins.fromTOML (builtins.readFile (crate + "/Cargo.toml"));

  src = lib.fileset.toSource {
    root = crate;
    fileset = lib.fileset.unions [
      (crate + "/Cargo.toml")
      (crate + "/Cargo.lock")
      (crate + "/build.rs")
      (crate + "/src")
    ];
  };
  # That source's store path is content-addressed: its hash names the source
  # exactly and moves only when one of those files does.
  srcId = builtins.substring 0 12 (baseNameOf (builtins.unsafeDiscardStringContext (toString src)));
in
rustPlatform.buildRustPackage {
  pname = "daedalus-agent";
  inherit (cargoToml.package) version;
  inherit src;
  cargoLock.lockFile = crate + "/Cargo.lock";
  buildNoDefaultFeatures = true;
  # The build's identity in its version (agent/build.rs): not a release.
  env.DAEDALUS_BUILD_ID = "src.${srcId}";
  cargoBuildFlags = [
    "--bin"
    "daedalus-agent"
  ];
  doCheck = false;
  meta.mainProgram = "daedalus-agent";
}
