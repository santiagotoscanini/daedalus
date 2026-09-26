# builder/registry-credential — the password the box pushes images to zot
# with: generated once, read one careful way, and rendered as the docker
# config.json the build's publishing call uses. A plain function imported by
# ../builder.nix; never a module.
#
# The credential is machine-generated state, not a sops secret:
# daedalus-build-registry-password.service writes a random password once to
# <machineState>/builder/registry-builder.env (fleet.machineState; the file
# root 0600 via a temp file and a rename, its directory operator 0755). Every
# reader goes through `fleet.builder.registryPasswordRead`, which parses the
# file rather than sourcing it and refuses anything that is not root-owned
# 0600 with exactly 64 hex characters: an empty password in htpasswd would be
# an unauthenticated push to every app's :latest, live two minutes later.
# modules/registry renders it into zot's htpasswd as `builder` (read + create
# + update on every repository, never delete; left OUT of htpasswd when the
# reader refuses), and the render below writes the docker config.json (root
# 0400; host/build.sh copies it for the build user around the one publishing
# buildctl call only). Rotation:
#   rm <machineState>/builder/registry-builder.env
#   systemctl restart daedalus-build-registry-password.service
# Both renders are PartOf that unit and zot is PartOf its render, so the one
# restart regenerates the password, re-renders htpasswd and config.json and
# restarts zot — no false-success window. The unit is restartIfChanged =
# false: a rebuild that edits it must not bounce zot through that chain.
{
  config,
  lib,
  pkgs,
  mkSecretRender,
}:

rec {
  cfg = config.fleet.builder;

  secretsDir = "${config.fleet.machineState}/builder";
  passwordUnit = "daedalus-build-registry-password.service";

  # The one way anything reads the builder password (header). Prints it on
  # stdout: capture it into a variable, never pass it as an argument.
  registryPasswordRead = pkgs.writeShellScript "daedalus-build-registry-password-read" ''
    set -eu
    f=${cfg.registryPasswordFile}
    if [ ! -f "$f" ] || [ -L "$f" ]; then
      echo "$f: missing" >&2
      exit 1
    fi
    meta=$(${pkgs.coreutils}/bin/stat -c '%u %a' "$f")
    if [ "$meta" != "0 600" ]; then
      echo "$f: expected uid 0 mode 600, found '$meta'; refusing it" >&2
      exit 1
    fi
    pw=$(${pkgs.gnused}/bin/sed -n 's/^REGISTRY_BUILDER_PASSWORD=//p' "$f")
    case "$pw" in
      *[!0-9a-f]*)
        echo "$f: malformed password; delete the file and restart ${passwordUnit}" >&2
        exit 1
        ;;
    esac
    if [ "''${#pw}" -ne 64 ]; then
      echo "$f: password is ''${#pw} characters, not 64; delete the file and restart ${passwordUnit}" >&2
      exit 1
    fi
    printf '%s' "$pw"
  '';

  # What ../builder.nix merges into the system, while the builder exists.
  settings = {
    systemd.services.daedalus-build-registry-password = {
      description = "Generate the zot `builder` push password on first boot";
      wantedBy = [ "multi-user.target" ];
      before = [
        "registry-config-render.service"
        "daedalus-build-dockerconfig.service"
      ];
      after = [ "local-fs.target" ];
      path = [
        pkgs.openssl
        pkgs.coreutils
      ];
      # Both renders and (through its render) zot are PartOf this unit: a
      # rebuild that edits it must not restart that chain.
      restartIfChanged = false;
      # A refused file fails the same way on every retry: three tries, then
      # failed and mailed (monitoredJobs below), not a silent 5 s loop.
      unitConfig = {
        StartLimitIntervalSec = 600;
        StartLimitBurst = 3;
      };
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        Restart = "on-failure";
        RestartSec = "5s";
      };
      script = ''
        set -eu
        umask 077
        f=${cfg.registryPasswordFile}
        # The stacks' convention for secrets/ (operator 0755, as stacks/app-db);
        # only the file itself is restricted.
        [ -d ${secretsDir} ] || install -d -m 0755 -o ${config.fleet.operator.user} -g ${config.fleet.operator.group} ${secretsDir}
        if [ -e "$f" ] || [ -L "$f" ]; then
          # Present: it must still pass the reader, or nothing may use it.
          ${registryPasswordRead} >/dev/null
          exit 0
        fi
        pw=$(openssl rand -hex 32)
        case "$pw" in
          *[!0-9a-f]*)
            echo "openssl rand returned a malformed password" >&2
            exit 1
            ;;
        esac
        if [ "''${#pw}" -ne 64 ]; then
          echo "openssl rand returned ''${#pw} characters, not 64" >&2
          exit 1
        fi
        tmp=$(mktemp ${secretsDir}/.registry-builder.env.XXXXXX)
        trap 'rm -f "$tmp"' EXIT
        printf 'REGISTRY_BUILDER_PASSWORD=%s\n' "$pw" > "$tmp"
        chown root:root "$tmp"
        chmod 0600 "$tmp"
        mv -f "$tmp" "$f"
        trap - EXIT
        # The file as written is exactly what every reader will accept.
        ${registryPasswordRead} >/dev/null
      '';
    };

    # The docker config the publishing buildctl call reads. Root-only — dir
    # 0700, file 0400 — because `railpack prepare` runs repository-controlled
    # mise code as daedalus-build, which must never be able to read the push
    # credential in place: host/build.sh copies it into a per-build dir for
    # the one buildctl call that pushes and deletes it right after.
    # mkSecretRender makes the dir operator 0755; prep takes it back to root
    # 0700 before the file is written.
    systemd.services.daedalus-build-dockerconfig = lib.mkMerge [
      (mkSecretRender {
        description = "Render the builder's registry credential as a docker config.json";
        gates = [ "daedalus-build.service" ];
        after = [ passwordUnit ];
        wants = [ passwordUnit ];
        dir = cfg.dockerConfigDir;
        file = "${cfg.dockerConfigDir}/config.json";
        owner = "root";
        group = "root";
        prep = ''
          chown root:root ${cfg.dockerConfigDir}
          chmod 0700 ${cfg.dockerConfigDir}
          # Aborts the render on a missing, foreign-owned, empty or short
          # password (header): a failed unit, never a config with no secret.
          REGISTRY_BUILDER_PASSWORD=$(${registryPasswordRead})
          AUTH=$(printf '%s:%s' ${cfg.registryUser} "$REGISTRY_BUILDER_PASSWORD" | base64 -w0)
        '';
        content = ''{"auths":{"${cfg.registryHost}":{"auth":"$AUTH"}}}'';
      })
      {
        # Rendered at boot, not only when a build first starts.
        wantedBy = [ "multi-user.target" ];
        partOf = [ passwordUnit ];
        # mkSecretRender retries every 5 s; a refused password never heals by
        # retrying, so cap it and let the failure mail.
        unitConfig = {
          StartLimitIntervalSec = 600;
          StartLimitBurst = 3;
        };
      }
    ];

    # Without these, a bad password is a render retrying out of sight: every
    # build then fails at publishing, far from the cause.
    fleet.monitoredJobs.daedalus-build-registry-password = { };
    fleet.monitoredJobs.daedalus-build-dockerconfig = { };
  };
}
