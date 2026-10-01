# platform/podman-prune — weekly reclaim of the rootless image store.
#
# The fleet pins images and pulls out-of-band (oci-containers' `--pull
# missing` never re-pulls a tag), so every update, every mkLocalImage
# rebuild, and every apps-platform redeploy leaves the previous image behind
# as an unreferenced orphan. Left alone the operator's rootless store grows
# unbounded. This prunes it on a schedule.
#
# Scope is deliberately narrow: images only — never `system prune`, which
# would also drop the podman networks (the traefik/app-db/… bridges)
# whenever their containers happen to be momentarily down. Containers,
# networks and volumes are left untouched.
#
# Not `podman image prune --all`: it spares only what a container uses at
# that moment, and its `until` reads the image's creation time, which for a
# pulled image is its release date. So it took every declared image whose
# container happened to be down, every base a local build starts FROM, and a
# local image that runs no long-lived container (built for ad-hoc runs) —
# each then a cold pull or a cold build through the mirror at the next start.
# Kept here, whatever their age: every image a declared container runs
# (oci-containers), every pinned base (fleet.images, fleet.manualPins) and
# every mkLocalImage tag (its build unit's LOCAL_IMAGE). Anything else older
# than 7 days goes, unless a container uses it (`podman rmi` refuses those)
# or another image is built on it.

{
  config,
  lib,
  pkgs,
  ...
}:

let
  inherit (config.fleet) operator;
  kept = lib.unique (
    lib.mapAttrsToList (_: c: c.image) config.virtualisation.oci-containers.containers
    ++ lib.attrValues config.fleet.images
    ++ lib.mapAttrsToList (_: p: p.image) config.fleet.manualPins
    ++ lib.concatMap (s: lib.optional (s.environment ? LOCAL_IMAGE) s.environment.LOCAL_IMAGE) (
      lib.attrValues config.systemd.services
    )
  );

  prune = pkgs.writeShellScript "podman-image-prune" ''
    set -u
    PATH=${
      lib.makeBinPath [
        pkgs.podman
        pkgs.coreutils
        pkgs.gnugrep
      ]
    }:/run/wrappers/bin
    # The ids the kept references resolve to; one not in the store is skipped.
    keep=$(for ref in ${lib.escapeShellArgs kept}; do
      podman image inspect --format '{{.Id}}' -- "$ref" 2>/dev/null
    done)
    # Newest first, so a child goes before the image it is built on. A row
    # per name: an untagged image is removed by id, a tagged one name by name
    # (the last name removes it). A refusal (in use, a parent) leaves it.
    podman images --all --noheading --no-trunc --filter until=168h \
      --format '{{.ID}} {{.Repository}}:{{.Tag}}' |
      while read -r id name; do
        id=''${id#sha256:}
        printf '%s\n' "$keep" | grep -qxF "$id" && continue
        case "$name" in
          *'<none>'*) podman rmi -- "$id" ;;
          *) podman rmi -- "$name" ;;
        esac >/dev/null 2>&1 || true
      done
  '';
in
{
  # OnFailure mail (platform/mail). No dead-man ping: a skipped prune only
  # means disk creeps until the next run — not worth paging over.
  fleet.monitoredJobs.podman-image-prune = { };

  systemd.services.podman-image-prune = {
    description = "Prune unreferenced images from ${operator.user}'s rootless podman store";
    serviceConfig.Type = "oneshot";
    # Runs as root and drops to the operator via setpriv (no PAM session,
    # matching modules/apps + autoupgrade) — the image store lives in
    # the operator's rootless graphroot, reachable only through their runtime
    # session (lingering is on, so the runtime dir exists at boot).
    script = ''
      ${pkgs.util-linux}/bin/setpriv --reuid ${operator.user} --regid ${operator.group} --init-groups --inh-caps=-all \
        ${pkgs.coreutils}/bin/env -i HOME=${operator.home} XDG_RUNTIME_DIR=${operator.runtimeDir} ${prune}
    '';
  };

  systemd.timers.podman-image-prune = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "weekly";
      Persistent = true; # replay a window missed while the box was off
      RandomizedDelaySec = "30min";
    };
  };
}
