# sops-nix host configuration. Secrets are age-encrypted *.sops files
# tracked in the host's git (its `.sops.yaml` names the recipients); at
# activation sops-nix decrypts each declared `sops.secrets.<name>` to
# /run/secrets/<name> (tmpfs — never touches disk) with the declared
# owner/mode. Stacks reference them via
# `config.sops.secrets."<name>".path` in environmentFiles / volumes.
#
# Rootless-podman note: secrets read by containers need
# `owner = <the operator>` — podman runs as the operator and reads env files /
# bind-mount sources with their uid before the userns remap.
{
  lib,
  options,
  pkgs,
  ...
}:

{
  # The host's decryption identity, derived from its SSH host key at
  # activation. Rotating the host key means re-encrypting (sops updatekeys)
  # with the new recipient — do that BEFORE the old key is destroyed.
  sops.age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];

  # sops-nix master tracks nixpkgs-unstable, and on 2026-09-20 its
  # `sops-install-secrets` go.mod moved to `go 1.26.0`, while the host's
  # stable nixpkgs (25.11) still builds Go modules with 1.25 — the weekly
  # autoupgrade committed that lock and then could not build it. The default
  # package is the module's own callPackage, so overriding the two Go inputs
  # to the 1.26 toolchain stable already ships keeps sops-nix tracking master
  # rather than freezing it at a rev. Applied only while the base nixpkgs's
  # default Go is older than 1.26: on 26.05 (Go 1.26) it drops out by itself,
  # and the day no supported base is older, this block goes.
  sops.package = lib.mkIf (lib.versionOlder pkgs.go.version "1.26") (
    options.sops.package.default.override {
      buildGoModule = pkgs.buildGo126Module;
      go = pkgs.go_1_26;
    }
  );
}
