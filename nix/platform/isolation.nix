# platform/isolation.nix — the routed half of `fleet.webApps.<n>.isolated`:
# each isolated app's private bridge (traefik joins it), the iptables guard
# that keeps every other bridge from dialing into it, and the assertions that
# keep isolation honest. The options are platform/publishing-options.nix;
# the rest of the publish layer is platform/publishing.nix.

{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.fleet;

  inherit (import ./lib/fleet-lib.nix { inherit lib; }) bridgeOf;

  # Private ingress bridges for `webApps.<n>.isolated` (bridge short
  # name per app; traefik joins each as an extra membership).
  # serviceName != null guard: a null name would crash the
  # bridgeMemberships materialization below before the friendly
  # "`isolated` needs `serviceName`" assertion could fire.
  isolatedApps = lib.filterAttrs (_: w: w.isolated && w.serviceName != null) cfg.webApps;
  isoBridge = n: "iso-${n}";

  # The routed half of `isolated`. Every bridge lives in ONE rootless network
  # namespace, and that namespace forwards between them: without this, a
  # container on traefik-net (or a WireGuard peer, masqueraded onto it) dials
  # an isolated app's address on its private bridge and the kernel routes the
  # packet there — traefik's gate never sees it. Netavark's own `isolate`
  # option does not close that, `isolate=strict` included: both only drop
  # what LEAVES an isolated bridge (`-i <bridge> ! -o <bridge>`), so a plain
  # bridge still reaches it.
  #
  # So one chain, FLEET_ISO, jumped to from the namespace's FORWARD chain,
  # holds one rule per isolated app: a NEW connection whose destination is the
  # private subnet and whose source is not is dropped. Traefik and the app
  # share the bridge, so their traffic is switched on it and never forwarded;
  # the app's own outbound connections, and the replies to them, are
  # ESTABLISHED and pass.
  #
  # Except a connection that was DNATed there, i.e. addressed to a published
  # port: netavark points traefik's 80/443 at whichever of its addresses it
  # likes, an iso bridge's included, and every container reaching a published
  # hostname (LAN IP → DNAT → traefik) crosses this chain to get there.
  # Dropping those would break hairpin ingress for the whole box. An
  # isolated app publishes no port of its own, so a DNATed connection into
  # its subnet can only be one to traefik — the gate itself.
  #
  # The subnets are PINNED (`fleet.bridgeSubnets.iso-<name>`, asserted), so
  # the rules are the store file below, whole: loaded with `iptables-restore
  # --noflush`, which replaces the chain's contents in one transaction —
  # idempotent, and an app no longer isolated leaves no rule behind. The guard
  # checks each bridge really has its pin first (an existing bridge keeps the
  # subnet it was made with: `podman network create --ignore`) and fails the
  # container's start if not. Every isolated container loads it before it
  # starts (ExecStartPre: no window in which it serves unguarded) and again
  # once it runs (ExecStartPost): the namespace goes when its last container
  # stops, and one created by the start itself only exists after it.
  # (`or`: an unpinned bridge is the assertion's to report, by name.)
  isoPin = n: cfg.bridgeSubnets.${isoBridge n} or "unpinned";
  isoRules = pkgs.writeText "fleet-iso.rules" ''
    *filter
    :FLEET_ISO - [0:0]
    ${
      lib.concatMapStrings (
        n:
        let
          s = isoPin n;
        in
        ''
          -A FLEET_ISO -d ${s} ! -s ${s} -m conntrack --ctstate NEW -m conntrack ! --ctstate DNAT -m comment --comment "fleet isolated: ${isoBridge n}-net" -j DROP
        ''
      ) (lib.attrNames isolatedApps)
    }COMMIT
  '';

  # $1 is the app whose container is starting: a bridge off its pin fails
  # that app's start (its guard would be guarding the wrong addresses) and is
  # only reported for the others, so one renumbered bridge takes down no
  # other app.
  isoGuard = pkgs.writeShellScript "fleet-iso-guard" ''
    set -eu
    podman=${pkgs.podman}/bin/podman
    iptables=${pkgs.iptables}/bin/iptables
    self=$1
    in_ns() { "$podman" unshare --rootless-netns "$@"; }
    # One guard at a time: the isolated apps start together (a switch, a
    # boot), and two of them moving the jump at once would leave two.
    exec 9>"${cfg.operator.runtimeDir}/fleet-iso-guard.lock"
    ${pkgs.util-linux}/bin/flock -w 60 9
    ${lib.concatMapStrings (n: ''
      have=$("$podman" network inspect ${isoBridge n}-net --format '{{range .Subnets}}{{.Subnet}} {{end}}' || true)
      if [ "$have" != "${isoPin n} " ]; then
        echo "iso guard: ${isoBridge n}-net is on '$have', not its pin ${isoPin n}" >&2
        [ "$self" != ${n} ] || exit 1
      fi
    '') (lib.attrNames isolatedApps)}
    in_ns ${pkgs.iptables}/bin/iptables-restore --noflush ${isoRules}
    # The jump must come FIRST: netavark's own jump (NETAVARK_FORWARD)
    # accepts every bridge's traffic, and a guard behind it guards nothing.
    # netavark inserts its jump at the top whenever it finds it missing, so
    # the position is checked, not only the presence.
    if [ "$(in_ns "$iptables" -S FORWARD | ${pkgs.gnused}/bin/sed -n 2p)" != "-A FORWARD -j FLEET_ISO" ]; then
      while in_ns "$iptables" -D FORWARD -j FLEET_ISO 2>/dev/null; do :; done
      in_ns "$iptables" -I FORWARD 1 -j FLEET_ISO
    fi
  '';
in
{
  config = {
    assertions =
      (lib.mapAttrsToList (n: _: {
        assertion = cfg.bridgeSubnets ? ${isoBridge n};
        message = ''
          fleet.webApps.${n}: an `isolated` app's private bridge must be pinned —
          fleet.bridgeSubnets.${isoBridge n} = "<a /24 no other bridge uses>"; — so
          its routed guard is a fixed rule set (isoRules). A bridge that
          already exists keeps its subnet, so pin the one it has
          (`podman network inspect ${isoBridge n}-net`).
        '';
      }) isolatedApps)
      ++ (lib.mapAttrsToList (n: w: {
        assertion =
          (w.isolated && w.serviceName != null)
          -> !(lib.elem "traefik" (map bridgeOf (cfg.bridgeMemberships.${w.serviceName} or [ ])));
        message = ''
          fleet.webApps.${n}: `isolated` is defeated by also listing
          "traefik" in bridgeMemberships.${toString w.serviceName} — the
          shared bridge reopens the direct path isolation exists to close.
        '';
      }) cfg.webApps)
      ++ (lib.mapAttrsToList (
        n: w:
        let
          others = lib.subtractLists [ (isoBridge n) ] (
            map bridgeOf (cfg.bridgeMemberships.${w.serviceName} or [ ])
          );
        in
        {
          assertion = (w.isolated && w.serviceName != null && !w.proxyProof) -> others == [ ];
          message = ''
            fleet.webApps.${n}: `isolated` but ${toString w.serviceName} also
            sits on ${lib.concatStringsSep ", " others} — every peer on a
            shared bridge can dial it and forge the identity header. Join the
            backends it needs to iso-${n}-net instead (e.g.
            `fleet.bridgeMemberships.pg = [ "iso-${n}" ]`), or make the app
            verify `proxyProof`.
          '';
        }
      ) cfg.webApps);

    # Isolated apps: the upstream lives on its private bridge and
    # traefik joins it as an extra membership (lists merge with the
    # traefik stack's own entry).
    fleet.bridgeMemberships =
      (lib.mapAttrs' (n: w: lib.nameValuePair w.serviceName [ (isoBridge n) ]) isolatedApps)
      // lib.optionalAttrs (isolatedApps != { }) {
        traefik = lib.mapAttrsToList (n: _: isoBridge n) isolatedApps;
      };

    # The routed half of isolation (isoGuard above), before every start and
    # once the container runs.
    systemd.services = lib.mapAttrs' (
      n: w:
      lib.nameValuePair "podman-${w.serviceName}" {
        serviceConfig.ExecStartPre = [ "${isoGuard} ${n}" ];
        serviceConfig.ExecStartPost = [ "${isoGuard} ${n}" ];
      }
    ) isolatedApps;
  };
}
