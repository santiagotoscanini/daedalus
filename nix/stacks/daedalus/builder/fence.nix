# builder/fence — the egress fence: the firewall rules that confine what the
# builder users can reach, the teardown, and `fenceCheck`, the test every
# unit that runs as or drives them uses before it starts. A plain function
# imported by ../builder.nix; never a module.
#
# Every packet sent by buildkit, by buildkit's subuid range (a step that got
# out into the host network namespace) or by daedalus-build passes one chain —
# pi-hole at <lanIp>:53 and traefik at <lanIp>:443 (Verdaccio, zot) are
# allowed; loopback, RFC 1918, CGNAT, link-local, multicast and the IPv6 local
# ranges are rejected; the internet returns to the normal path. Owner matching
# works for the daemon because slirp4netns is what opens the host sockets, as
# buildkit. One exception, for daedalus-build alone: 127.0.0.1:53, because
# railpack and buildctl are Go and their resolver asks /etc/resolv.conf's
# 127.0.0.1 directly (glibc tools go through nscd) — a handful of lookups per
# build on the shared budget, never a build step's.
#
# The fence runs inside firewall-start (networking.firewall.extraCommands),
# BEFORE the INPUT rules go in, under `bash -e`: one failing command there
# makes the reload fall back to firewall-stop, which leaves the host with no
# INPUT filtering at all. So the uids are pinned and matched as numbers (no
# name lookup at early boot), no fence command can abort the script (failures
# are logged to firewall.service's journal), and the OUTPUT jumps go in only
# once the chain is complete. The fence fails CLOSED at its consumers instead:
# buildkitd, the build agent and its nightly sweep refuse to start unless the
# jump for every fenced owner (both uids and the subuid range) is loaded in
# iptables and ip6tables — which is exactly what fenceCheck tests.
#
# A change here reloads the firewall.
{
  config,
  lib,
  pkgs,
  # The pinned builder ids from ../builder.nix, which creates the users.
  ids,
}:

rec {
  inherit (config.fleet) lanIp;
  inherit (ids) buildUid;

  fenceChain = "daedalus-build-egress";

  # Every owner the fence matches: the daemon, its subuid range (a step that
  # escaped into the host netns runs as one of those), the client.
  fenceOwners = "${toString ids.buildkitUid} ${toString ids.buildUid} ${toString ids.subIdStart}-${
    toString (ids.subIdStart + ids.subIdCount - 1)
  }";
  iptablesBin = "${config.networking.firewall.package}/bin";

  # Removes every trace of the fence, whatever the users are called now: jumps
  # are found by target in `-S` output (numeric uids), so a uid left behind by a
  # deleted user can never keep a stale match. Every command tolerates absence
  # — the firewall scripts run under `sh -e`, and a failure there stops the
  # whole firewall.
  fenceClear = ''
    for ipt in iptables ip6tables; do
      $ipt -w -S OUTPUT 2>/dev/null | while read -r rule; do
        case "$rule" in
          *" -j ${fenceChain}") $ipt -w -D OUTPUT ''${rule#-A OUTPUT } || true ;;
        esac
      done
      $ipt -w -F ${fenceChain} 2>/dev/null || true
      $ipt -w -X ${fenceChain} 2>/dev/null || true
    done
  '';

  # No command here may abort firewall-start (header): each runs through
  # `builder_fence`, which logs a failure and marks the chain incomplete. An
  # incomplete chain gets no OUTPUT jumps, so fenceCheck refuses to start the
  # daemon and the build agent.
  #
  # The banner below still names stacks/daedalus/builder.nix: it is text in
  # the firewall script, and rewording it would reload the firewall for a
  # comment. The fence is in this file now.
  fenceSetup = ''
    # ── daedalus builder egress fence (stacks/daedalus/builder.nix) ──
    ${fenceClear}
    builder_fence_ok=1
    builder_fence() {
      "$@" || {
        builder_fence_ok=0
        echo "daedalus-build-egress: FAILED: $*" >&2
      }
    }
    builder_fence iptables -w -N ${fenceChain}
    for proto in udp tcp; do
      # Loopback DNS for daedalus-build ONLY: as buildkit it is slirp4netns
      # relaying a step's 10.0.2.3 query onto the shared budget (header).
      builder_fence iptables -w -A ${fenceChain} -m owner --uid-owner ${toString buildUid} \
        -d 127.0.0.1/32 -p "$proto" --dport 53 -j RETURN
      builder_fence iptables -w -A ${fenceChain} -d ${lanIp}/32 -p "$proto" --dport 53 -j RETURN
    done
    builder_fence iptables -w -A ${fenceChain} -d ${lanIp}/32 -p tcp --dport 443 -j RETURN
    for net in 0.0.0.0/8 127.0.0.0/8 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 \
               172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do
      builder_fence iptables -w -A ${fenceChain} -d "$net" -j REJECT
    done
    builder_fence iptables -w -A ${fenceChain} -j RETURN
    ${lib.optionalString config.networking.enableIPv6 ''
      builder_fence ip6tables -w -N ${fenceChain}
      for net in ::/128 ::1/128 fe80::/10 fc00::/7 ff00::/8; do
        builder_fence ip6tables -w -A ${fenceChain} -d "$net" -j REJECT
      done
      builder_fence ip6tables -w -A ${fenceChain} -j RETURN
    ''}
    if [ "$builder_fence_ok" = 1 ]; then
      for uid in ${fenceOwners}; do
        builder_fence iptables -w -A OUTPUT -m owner --uid-owner "$uid" -j ${fenceChain}
        ${lib.optionalString config.networking.enableIPv6 ''
          builder_fence ip6tables -w -A OUTPUT -m owner --uid-owner "$uid" -j ${fenceChain}
        ''}
      done
    else
      echo "daedalus-build-egress: chain incomplete, OUTPUT jumps withheld; buildkitd and daedalus-build will refuse to start" >&2
    fi
  '';

  # ExecStartPre (as root) of buildkitd, and of the build agent and its sweep
  # through `fleet.builder.fenceCheck`: no fence, no start. It checks the
  # OUTPUT jumps only — they go in last, and only once the chain is complete.
  fenceCheck = pkgs.writeShellScript "daedalus-build-fence-check" ''
    set -u
    missing=0
    for uid in ${fenceOwners}; do
      if ! ${iptablesBin}/iptables -w -C OUTPUT -m owner --uid-owner "$uid" -j ${fenceChain} 2>/dev/null; then
        echo "egress fence: no IPv4 OUTPUT jump for uid $uid" >&2
        missing=1
      fi
      ${lib.optionalString config.networking.enableIPv6 ''
        if ! ${iptablesBin}/ip6tables -w -C OUTPUT -m owner --uid-owner "$uid" -j ${fenceChain} 2>/dev/null; then
          echo "egress fence: no IPv6 OUTPUT jump for uid $uid" >&2
          missing=1
        fi
      ''}
    done
    if [ "$missing" = 1 ]; then
      echo "refusing to start without the daedalus builder egress fence; see journalctl -u firewall.service" >&2
      exit 1
    fi
  '';

  # What ../builder.nix merges into the system, while the builder exists.
  settings = {
    networking.firewall.extraCommands = fenceSetup;
  };

  # …and whether it exists or not. Ungated on purpose: if the App's vault file
  # ever leaves the flake, the reload that follows must still tear the fence
  # down, or its numeric-uid jumps would outlive the users and match whoever
  # gets those uids next.
  alwaysSettings = {
    networking.firewall.extraStopCommands = fenceClear;
  };
}
