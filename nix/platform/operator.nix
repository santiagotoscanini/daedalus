# Who runs this box, and where its configuration lives — a login name, a uid,
# a home directory, the checkout's path — so no module spells them.
#
# DECLARED here, DEFINED by the host (the template does it in
# host/identity.nix). That split is the point: an importable engine cannot
# carry one person's login name in its text. Nothing below has a default
# that names a person or a path outside
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

  # The GitHub side of who runs the box: the account its repositories live
  # under, the id that account must have, and the App as site.json records
  # it (platform/site.nix defines that one from the document).
  options.fleet.github = {
    owner = lib.mkOption {
      type = lib.types.str;
      description = "GitHub account the app repos and CI live under. The host defines it.";
    };

    # The daedalus GitHub App — who it is, never its secrets (those are
    # site/vault/github-app.sops). Written by the App's manifest callback
    # together with the vault file, and read by stacks/daedalus: the token
    # minter signs as `clientId` and finds the installation on `ownerId`.
    app = lib.mkOption {
      type = lib.types.nullOr (
        lib.types.submodule {
          options = {
            id = lib.mkOption {
              type = lib.types.ints.positive;
              description = "The App's numeric id.";
            };
            # slug and owner are held to GitHub's own charset for slugs and
            # logins: they reach shell variables and journal lines (the
            # minter's "not installed on <owner>"), where a newline could
            # forge a log line.
            slug = lib.mkOption {
              type = lib.types.strMatching "[A-Za-z0-9-]+";
              description = "The App's URL name (`github.com/apps/<slug>`).";
            };
            clientId = lib.mkOption {
              type = lib.types.strMatching "[A-Za-z0-9._-]+";
              description = "The App's client id — the JWT issuer the token minter signs as.";
            };
            htmlUrl = lib.mkOption {
              type = lib.types.strMatching "https://github\\.com/.+";
              description = "The App's settings page on GitHub.";
            };
            owner = lib.mkOption {
              type = lib.types.strMatching "[A-Za-z0-9-]+";
              description = "Login of the account that owns the App.";
            };
            ownerId = lib.mkOption {
              type = lib.types.ints.positive;
              description = "Numeric id of that account — what the minter matches the installation on, because a login can be renamed.";
            };
          };
        }
      );
      default = null;
      description = ''
        The GitHub App as site.json records it (`github.app`), or null when
        none has been created. Present if and only if
        site/vault/github-app.sops is (asserted in stacks/daedalus).
      '';
    };

    # The account the box trusts to own the App and every repository it
    # builds. A constant of this box, NOT sourced from site.json: the daedalus
    # container writes site.json through Apply, and a planted `ownerId` there
    # must not steer the token minter or the build agent to another account's
    # installation. platform/site.nix holds site.json's copy to it.
    expectedOwnerId = lib.mkOption {
      type = lib.types.ints.positive;
      description = "Numeric GitHub account id that must own the daedalus GitHub App and the repositories it builds. The HOST defines it, in nix: the one copy the control plane cannot rewrite.";
    };
  };
}
