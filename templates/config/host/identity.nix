# Who operates this box, and where. The engine declares these options without
# defaults (nix/README.md, "What the host must define"): a host that forgets
# one fails evaluation with its name rather than inheriting someone else's.
_: {
  fleet = {
    operator = {
      # The one non-root admin: owns the rootless containers, the state tree
      # under their home and the configuration checkout.
      user = "alice";
      uid = 1000;
      # The OIDC `email` claim apps match their admin on.
      email = "alice@example.org";
      # Author of the commits the box makes for itself (the weekly lock bump,
      # an Apply from the control plane).
      gitName = "Alice Example";
      gitEmail = "alice@example.org";
    };

    # Where this checkout lives on the box (a run-time path: the agents that
    # commit and rebuild work here; evaluation never reads through it).
    config.repo = "/etc/nixos";

    # The GitHub account the app repositories live under, and its numeric id —
    # the one copy of "which account this box trusts" the control plane cannot
    # rewrite, since it writes site.json.
    github.owner = "alice";
    github.expectedOwnerId = 1;

    # The mail relay the box sends through (the password: host/secrets.nix).
    mail.smtpHost = "smtp.example.org";
  };
}
