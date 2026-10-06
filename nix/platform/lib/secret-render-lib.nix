# mkSecretRender — the activation-render idiom (podman.nix hands it to every
# module as `_module.args.mkSecretRender`).
#
# Activation-render idiom: a oneshot that materializes a small file
# on tmpfs before its consumers start — a bare token, an --env-file,
# a DSN — sourced from an already-decrypted secret. `prep` computes
# shell vars with standalone assignments; `content` is the heredoc body
# written to `file`, and only REFERENCES them.
# The dir is operator-owned 0755 so rootless podman can traverse it at
# --env-file mount time (pre-userns-remap); the file itself stays
# `mode` (default 0400).
#
# Two guarantees, the helper's rather than each caller's:
#   - never an empty credential. A `$(…)` inside the heredoc runs where
#     errexit does not reach (a failed read renders `A=` and the unit
#     exits 0), so `content` may not hold one (an evaluation error); and
#     every variable `content` names must be non-empty when the file is
#     written, or the unit fails and the previous file stays. `optional`
#     lists the names a caller means to render empty.
#   - re-rendered with its consumer. PartOf the gates, so a restart of a
#     consumer re-runs the render first (before= orders it) and the
#     consumer reads the secret as it is NOW. A rebuild alone still leaves
#     an unchanged render alone: after rotating a secret, restart the
#     consumer.
#   systemd.services."foo-render" = mkSecretRender { ... };
{
  lib,
  pkgs,
  operator,
}:

{
  description,
  gates, # consumer units; the render runs before= / wantedBy= / partOf= them
  dir,
  file,
  content,
  mode ? "0400",
  # Owner of the rendered FILE (the dir stays operator 0755). Set
  # to a subuid (hostUid N) when the consumer container reads the
  # file as a non-root user after its entrypoint privilege-drop.
  owner ? operator.user,
  group ? operator.group,
  prep ? "",
  # Variables `content` names that may legitimately render empty.
  optional ? [ ],
  after ? [ ],
  wants ? [ ],
}:
let
  # Every $NAME / ${NAME} the heredoc expands.
  referenced = lib.unique (
    map lib.head (
      builtins.filter builtins.isList (builtins.split "\\$\\{?([A-Za-z_][A-Za-z0-9_]*)" content)
    )
  );
  required = lib.subtractLists optional referenced;
in
assert lib.assertMsg (!(lib.hasInfix "$(" content || lib.hasInfix "`" content)) ''
  mkSecretRender "${description}": `content` runs a command. A command
  substitution inside the heredoc fails without failing the unit and
  renders an empty value; read it into a variable in `prep` instead.
'';
{
  inherit description wants;
  before = gates;
  wantedBy = gates;
  partOf = gates;
  # /run/secrets/* are materialized during activation, ahead of
  # every multi-user unit — no explicit sops ordering needed.
  after = [ "local-fs.target" ] ++ after;
  path = [
    pkgs.coreutils
    pkgs.gnugrep
  ];
  serviceConfig = (import ./hardening-lib.nix).hardening // {
    Type = "oneshot";
    RemainAfterExit = true;
    Restart = "on-failure";
    RestartSec = "5s";
    # The render reads what it must (a decrypted secret, a machine-made file
    # under the state tree) and writes its own directory, nothing else. The
    # privileged pre-start makes that directory — but systemd builds the
    # mount sandbox for EVERY command, the `+` one included, and a
    # ReadWritePaths entry whose path does not exist fails that setup
    # (226/NAMESPACE) before the pre-start that would create it can run: on
    # tmpfs, every first start after a boot. The `-` prefix lets the bind be
    # skipped while the directory is absent; the pre-start creates it, and
    # the main command's sandbox, built afresh, binds it writable. No
    # network, no devices; root only to read other owners' files and to hand
    # the result to its owner.
    ExecStartPre = "+${pkgs.coreutils}/bin/install -d -m 0755 -o ${operator.user} -g ${operator.group} ${dir}";
    ProtectSystem = "strict";
    ProtectHome = "read-only";
    ReadWritePaths = [ "-${dir}" ];
    PrivateNetwork = true;
    PrivateDevices = true;
    RestrictAddressFamilies = "AF_UNIX";
    RestrictNamespaces = true;
    MemoryDenyWriteExecute = true;
    SystemCallArchitectures = "native";
    CapabilityBoundingSet = [
      "CAP_CHOWN"
      "CAP_FOWNER"
      "CAP_DAC_OVERRIDE"
      "CAP_DAC_READ_SEARCH"
    ];
  };
  script = ''
    set -eu
    umask 077
    ${prep}
    for v in ${lib.concatStringsSep " " required}; do
      if [ -z "''${!v-}" ]; then
        echo "${file}: $v is empty or unset; not rendering (the previous file, if any, stays)" >&2
        exit 1
      fi
    done
    install -m ${mode} -o ${toString owner} -g ${toString group} /dev/stdin ${file} <<RENDER_EOF
    ${content}
    RENDER_EOF
  '';
}
