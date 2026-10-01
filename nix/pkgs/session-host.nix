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
    # santree's crates, from its public repository at the rev Cargo.lock
    # names; one hash covers every crate of that checkout. A santree move
    # changes the lock and this hash together.
    outputHashes."santree-agent-kind-0.1.17-beta.18" =
      "sha256-ataJgIRDIs4cdDRIfTRKknWonBpeweBm7VW4uRoJVJA=";
  };
  doCheck = false;
  meta.mainProgram = "daedalus-session-host";
}
