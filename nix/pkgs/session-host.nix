# The session host (session-host/; stacks/daedalus/session-host.nix runs it).
# Built from the crate's own files only, so a commit that touches anything
# else in the repository does not rebuild it. Its tests (and the agent interop
# test in interop/, outside this fileset) run in session-host/gate.sh and CI.
{ lib, rustPlatform }:

let
  crate = ../../session-host;
  cargoToml = builtins.fromTOML (builtins.readFile (crate + "/Cargo.toml"));
in
rustPlatform.buildRustPackage {
  pname = "daedalus-session-host";
  inherit (cargoToml.package) version;
  src = lib.fileset.toSource {
    root = crate;
    fileset = lib.fileset.unions [
      (crate + "/Cargo.toml")
      (crate + "/Cargo.lock")
      (crate + "/src")
    ];
  };
  cargoLock = {
    lockFile = crate + "/Cargo.lock";
    # santree's crates come from its public repository at the rev
    # Cargo.lock names: that rev is the pin, so no output hash to bump
    # with each santree move. An evaluation after a bump fetches it.
    allowBuiltinFetchGit = true;
  };
  doCheck = false;
  meta.mainProgram = "daedalus-session-host";
}
