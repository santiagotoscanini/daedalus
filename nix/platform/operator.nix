# Who runs this box, and where its configuration lives — the facts every
# module used to spell as a login name, `1000`, a home directory, `/etc/nixos`.
#
# DECLARED here, DEFINED by the host (configuration.nix). That split is the
# point: platform/ and stacks/ are on their way to being an importable engine
# (plan, Phase 11), and an engine cannot carry one person's login name in its
# text. Nothing below has a default that names a person or a path outside
# what it derives from `user` and `uid`; a host that forgets to set `user`
# fails evaluation on the missing definition, which is the right failure.
#
# One rootless user owns every container (platform/podman.nix), so this is
# also the identity behind `podman.user`, the owner of decrypted secrets a
# container reads, and the `user@<uid>.service` every container unit waits on.
{ config, lib, ... }:

let
  cfg = config.fleet.operator;
in
{
  options.fleet.operator = {
    user = lib.mkOption {
      type = lib.types.str;
      description = "Login name of the box's one non-root admin: owns the rootless containers, the state tree and the config checkout.";
    };

    uid = lib.mkOption {
      type = lib.types.int;
      description = "That user's uid. Container uid 0 maps to it; its runtime dir and user manager are named after it.";
    };

    email = lib.mkOption {
      type = lib.types.str;
      description = "The operator's e-mail as the identity provider asserts it (the OIDC `email` claim) — what an app that names its admin by e-mail, like the registry, matches on. Not the alert mailbox (`fleet.mail.alertTo`), even when the two coincide.";
    };

    gitName = lib.mkOption {
      type = lib.types.str;
      description = "Author name on the commits this box makes as the operator: the weekly lock bump always, and every commit daedalus makes (Apply, secrets, updates) while site.json `commits.author` is `operator`.";
    };

    gitEmail = lib.mkOption {
      type = lib.types.str;
      description = "Author e-mail on those commits. Its own fact: a forge's commit address is often neither the login e-mail nor the alert mailbox.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "users";
      description = "Primary group of the operator, for files created on their behalf.";
    };

    home = lib.mkOption {
      type = lib.types.str;
      default = "/home/${cfg.user}";
      defaultText = lib.literalExpression ''"/home/''${config.fleet.operator.user}"'';
      description = "The operator's home directory.";
    };

    runtimeDir = lib.mkOption {
      type = lib.types.str;
      default = "/run/user/${toString cfg.uid}";
      defaultText = lib.literalExpression ''"/run/user/''${toString config.fleet.operator.uid}"'';
      description = "XDG_RUNTIME_DIR of the operator — where rootless podman keeps its sockets. Exists at boot only because the user lingers.";
    };

    userService = lib.mkOption {
      type = lib.types.str;
      default = "user@${toString cfg.uid}.service";
      defaultText = lib.literalExpression ''"user@''${toString config.fleet.operator.uid}.service"'';
      description = "The operator's systemd user manager, which every rootless container unit orders after.";
    };
  };

  options.fleet.config.repo = lib.mkOption {
    type = lib.types.str;
    description = ''
      Where the configuration checkout lives on disk — the flake the box
      rebuilds from, the repository the weekly upgrade commits to, and the
      tree daedalus's agents write `site/` under. A RUN-TIME path: evaluation
      never reads through it (a flake sees its own source), only units do.
    '';
  };
}
