# platform/git.nix — git + outbound GitHub SSH (single home for both).
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
#     (and what `ssh-keyscan -t ed25519 github.com | ssh-keygen -lf -`
#     prints today).
#
#   - A `Host github.com` block in /etc/ssh/ssh_config so
#     `ssh git@github.com` auto-uses the right key. Scoped — every
#     other ssh target still follows OpenSSH defaults (no global
#     IdentityFile, no global User override). IdentitiesOnly=yes so
#     ssh-agent never offers unrelated keys to GitHub.
#
# Imperative one-time bootstrap (NOT declarable without sops-nix —
# the private key IS secret state by definition):
#
#   mkdir -m 700 -p ~/.ssh
#   ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_github -N '' \
#     -C "santiago@s2-server"
#   cat ~/.ssh/id_ed25519_github.pub        # paste at https://github.com/settings/ssh/new
#   ssh -T git@github.com                   # expect: Hi <user>! You've successfully authenticated...
#
# When sops-nix lands, the private key moves into a sops-encrypted
# tree and gets materialized at /run/secrets/github-ssh-key.

{ ... }:

{
  programs.git = {
    enable = true;
    config = {
      core.pager = "delta";
      user.name = "Santiago Toscanini";
      user.email = "github@account.toscanini.me";
      interactive.diffFilter = "delta --color-only";
      delta = {
        navigate = true;
        light = false;
        line-numbers = true;
      };
      merge.conflictstyle = "zdiff3";
      diff.colorMoved = "default";
      # Root-run units (flake-autoupgrade) operate on this root-owned repo;
      # without this git refuses with "dubious ownership".
      safe.directory = "/etc/nixos";
    };
  };

  programs.ssh.knownHosts.github = {
    hostNames = [ "github.com" ];
    publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
  };

  programs.ssh.extraConfig = ''
    Host github.com
      User git
      IdentityFile ~/.ssh/id_ed25519_github
      IdentitiesOnly yes
  '';
}
