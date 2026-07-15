# sops-nix host configuration. Secrets are age-encrypted *.sops files
# tracked in git (see /.sops.yaml for recipients + conventions); at
# activation sops-nix decrypts each declared `sops.secrets.<name>` to
# /run/secrets/<name> (tmpfs — never touches disk) with the declared
# owner/mode. Stacks reference them via
# `config.sops.secrets."<name>".path` in environmentFiles / volumes.
#
# Rootless-podman note: secrets read by containers need
# `owner = "santiago"` — podman runs as santiago and reads env files /
# bind-mount sources with her uid before the userns remap.
{ ... }:

{
  # The host's decryption identity, derived from its SSH host key at
  # activation. Rotating the host key means re-encrypting (sops updatekeys)
  # with the new recipient — do that BEFORE the old key is destroyed.
  sops.age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];
}
