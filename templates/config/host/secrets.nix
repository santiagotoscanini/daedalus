# The operator-managed credentials engine modules read, as sops ciphertext.
#
# An engine cannot carry one box's credentials in its tree, encrypted or not,
# so each owning module declares an option for the FILE and the host hands it
# in here. Every file under host/sops/ is a placeholder in the template — see
# host/sops/README.md for how to create each one for real. The basenames are
# load-bearing: `sopsFile = <path>` becomes a store path named by basename and
# content, so renaming a file changes the manifest sops-nix builds (harmless,
# but not a no-op).
#
# The catalog modules' files are named beside their switches in
# host/modules.nix; these four are the platform's and the control plane's.
_: {
  # platform/git — the SSH identity the box pushes to its forge with.
  fleet.git.sshKeySopsFile = ./sops/git-ssh-key.sops;

  # platform/mail — the relay account's password.
  fleet.mail.passwordSopsFile = ./sops/smtp-password.sops;

  # stacks/daedalus — the per-service read-only API keys the control plane
  # reads other services' numbers with. A dotenv; may start empty.
  fleet.daedalus.serviceKeysSopsFile = ./sops/service-keys.sops;

  # platform/hc-ping — the healthchecks project's ping key. Optional; null
  # means no unit gets a dead-man ping.
  # fleet.hcPing.keySopsFile = ./sops/ping-key.sops;
}
