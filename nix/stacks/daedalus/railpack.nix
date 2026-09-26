# Railpack — the builder's detector and plan frontend, pinned as a pair, plus
# the mise it runs on the host.
#
# Two artifacts of ONE release, and they move together or not at all: the CLI
# (`railpack prepare`, run by the build agent as daedalus-build to write
# railpack-plan.json) and the BuildKit gateway frontend image that turns that
# plan into LLB (`buildctl --frontend gateway.v0 --opt source=<frontend>`).
# Railpack is 0.x with breaking minor releases and a plan format that is "not
# yet finalized", so a CLI from one version feeding the frontend of another is
# an unsupported combination. A bump edits `version`, `hash` and the frontend
# digest in the same commit, and goes through candidate builds of every app
# before any app builds `live` again.
#
# mise is the third artifact of that release. `prepare` resolves versions by
# running mise ON THE HOST, and railpack gets it by downloading
# github.com/jdx/mise's release tarball with no checksum into a writable cache
# (v0.39.0 core/mise/install.go). Its `ensureInstalled` only stats
# `<InstallDir>/mise-<Version>` — InstallDir is /tmp/railpack/mise
# (core/mise/mise.go), Version is core/mise/version.txt — and downloads when
# the file is absent. So the build agent binds `miseBinary` read-only at
# `misePath`: the stat succeeds, nothing is downloaded, and nothing a build
# writes into the cache can replace the binary that runs next time.
#
# All three are upstream release binaries (neither railpack nor that mise is
# in nixpkgs), static, installed byte-for-byte (no strip, no patchelf). The
# frontend is pinned by digest as well as tag — the tag is for humans, the
# digest is what BuildKit resolves. Each hash below equals the digest GitHub
# publishes for the asset.
#
# To move it:
#   V=<new railpack version>
#   nix store prefetch-file --json \
#     https://github.com/railwayapp/railpack/releases/download/v$V/railpack-v$V-x86_64-unknown-linux-musl.tar.gz
#   skopeo inspect --format '{{.Digest}}' docker://ghcr.io/railwayapp/railpack-frontend:v$V
#   M=$(gh api "repos/railwayapp/railpack/contents/core/mise/version.txt?ref=v$V" --jq .content | base64 -d)
#   nix store prefetch-file --json \
#     https://github.com/jdx/mise/releases/download/v$M/mise-v$M-linux-x64-musl.tar.gz
# and re-read install.go/mise.go at the new tag: if the install path or the
# asset layout moved, `misePath` and the install phase move with it.
#
# A module rather than a callPackage file: it fills the railpack and mise
# fields of `fleet.builder` (declared in ./builder.nix), and is listed in
# flake.nix's `daedalusModules` like its siblings.

{
  config,
  lib,
  pkgs,
  ...
}:

let
  version = "0.39.0";
  # railpack v0.39.0's core/mise/version.txt — moves with `version`.
  miseVersion = "2026.8.16";

  railpack = pkgs.stdenvNoCC.mkDerivation {
    pname = "railpack";
    inherit version;

    src = pkgs.fetchurl {
      url = "https://github.com/railwayapp/railpack/releases/download/v${version}/railpack-v${version}-x86_64-unknown-linux-musl.tar.gz";
      # = GitHub's asset digest sha256:728407f5cdb9e9bc1cdd07f568419344a20e71b0a5a9fd90a9cfbaca0a6c94f7
      hash = "sha256-coQH9c256bwc3Qf1aEGTRKIOcbClqf2Qqc+6ygpslPc=";
    };

    # The tarball has no top-level directory: LICENSE, README.md, railpack.
    sourceRoot = ".";
    dontConfigure = true;
    dontBuild = true;
    dontStrip = true;
    dontPatchELF = true;

    installPhase = ''
      runHook preInstall
      install -Dm0755 railpack $out/bin/railpack
      runHook postInstall
    '';

    doInstallCheck = true;
    installCheckPhase = ''
      $out/bin/railpack --version | grep -F ${lib.escapeShellArg version}
    '';

    meta = {
      description = "Zero-config application builder (Railway), pinned release binary";
      homepage = "https://github.com/railwayapp/railpack";
      license = lib.licenses.mit;
      mainProgram = "railpack";
      platforms = [ "x86_64-linux" ];
      sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    };
  };

  mise = pkgs.stdenvNoCC.mkDerivation {
    pname = "mise";
    version = miseVersion;

    src = pkgs.fetchurl {
      url = "https://github.com/jdx/mise/releases/download/v${miseVersion}/mise-v${miseVersion}-linux-x64-musl.tar.gz";
      # = GitHub's asset digest sha256:1445289f35e1a5a7216e1ffee5b34c5b9bd46793224e7e6c335503de9d9df0b2
      hash = "sha256-FEUonzXhpachbh/+5bNMW5vUZ5MiTn5sM1UD3p2d8LI=";
    };

    # Unpacks to mise/ — the same `mise/bin/mise` member railpack extracts.
    dontConfigure = true;
    dontBuild = true;
    dontStrip = true;
    dontPatchELF = true;

    # No `--version` install check: mise looks for updates over the network
    # when asked, and the sandbox has none. Checked by hand at pin time
    # ("2026.8.16 linux-x64 (2026-08-31)"); railpack never re-checks a present
    # binary.
    installPhase = ''
      runHook preInstall
      install -Dm0755 bin/mise $out/bin/mise
      runHook postInstall
    '';

    meta = {
      description = "mise, pinned to the release railpack ${version} expects";
      homepage = "https://github.com/jdx/mise";
      license = lib.licenses.mit;
      mainProgram = "mise";
      platforms = [ "x86_64-linux" ];
      sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    };
  };
in
{
  config = lib.mkIf config.fleet.modules.daedalus.enable {
    fleet.builder = {
      inherit railpack;
      # Same release as `version` above — bumped together, never apart.
      railpackFrontend = "ghcr.io/railwayapp/railpack-frontend:v${version}@sha256:db24dc37640b6887c3d455b40876ea30f75182964479670cba6e4cde7ffef103";
      miseBinary = "${mise}/bin/mise";
      misePath = "/tmp/railpack/mise/mise-${miseVersion}";
    };
  };
}
