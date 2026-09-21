# platform/git — git, outbound GitHub SSH, and the box's GitHub API token.
#
# Declares (all reproducible from nix):
#
#   - System-wide /etc/gitconfig via `programs.git`: user identity,
#     delta as pager + interactive diff filter, zdiff3 conflict style.
#     Per-user ~/.gitconfig still wins if a user sets one.
#
#   - GitHub's ed25519 host key, pinned into /etc/ssh/ssh_known_hosts
#     (`programs.ssh.knownHosts.github`). No first-connect prompt, no
#     MITM window. Verified fingerprint:
#       SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU
#     Matches the key GitHub publishes at
#     https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
#     (verify anytime: `ssh-keyscan -t ed25519 github.com | ssh-keygen -lf -`).
#
#   - A `Host github.com` block in /etc/ssh/ssh_config so
#     `ssh git@github.com` auto-uses the right key. Scoped — every
#     other ssh target still follows OpenSSH defaults (no global
#     IdentityFile, no global User override). IdentitiesOnly=yes so
#     ssh-agent never offers unrelated keys to GitHub.
#
# This module declares NO GitHub API token. The box authenticates to the
# GitHub API as the daedalus GitHub App: its credentials are
# site/vault/github-app.sops, and daedalus-github-token.service mints a
# short-lived installation token on the HOST from the App's private key
# (stacks/daedalus — the key never enters a container; the build agent mints
# its own, narrowed to one repository). The `gh` CLI's own login, stored in
# the operator's home, is the interactive credential and is not managed here.
#
# The private key is sops-managed (the host hands the ciphertext in as
# `fleet.git.sshKeySopsFile` — host/sops/github-key.sops; it decrypts to
# /run/secrets/github-ssh-key at activation, operator-owned 0400); the
# flake-autoupgrade push consumes the same secret. Rotation: generate a
# new keypair, `sops -e` the private half over that file,
# register the public half at https://github.com/settings/ssh/new,
# rebuild, then delete the old key on GitHub. Verify with
# `ssh -T git@github.com`. API tokens are not rotated here at all: the App's
# installation tokens expire in an hour and are re-minted on a timer.

{ config, lib, ... }:

{
  options.fleet.git.sshKeySopsFile = lib.mkOption {
    type = lib.types.path;
    example = lib.literalExpression "./sops/github-key.sops";
    description = ''
      The sops-encrypted (binary format) private half of the SSH key the box
      authenticates to GitHub with. The host's file: an engine carries no
      box's credentials. No default — the weekly upgrade's push and the
      `Host github.com` block both read the decrypted key.
    '';
  };

  config = {
    sops.secrets."github-ssh-key" = {
      sopsFile = config.fleet.git.sshKeySopsFile;
      format = "binary";
      owner = config.fleet.operator.user;
      mode = "0400";
    };

    programs.git = {
      enable = true;
      config = {
        core.pager = "delta";
        user.name = config.fleet.operator.gitName;
        user.email = config.fleet.operator.gitEmail;
        interactive.diffFilter = "delta --color-only";
        delta = {
          navigate = true;
          light = false;
          line-numbers = true;
        };
        merge.conflictstyle = "zdiff3";
        diff.colorMoved = "default";
        # The repo is operator-owned; root-run git (flake-autoupgrade,
        # nixos-rebuild's flake eval) would refuse with "dubious
        # ownership" without this.
        safe.directory = config.fleet.config.repo;
      };
    };

    programs.ssh.knownHosts.github = {
      hostNames = [ "github.com" ];
      publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
    };

    programs.ssh.extraConfig = ''
      Host github.com
        User git
        IdentityFile ${config.sops.secrets."github-ssh-key".path}
        IdentitiesOnly yes
    '';
  };
}
