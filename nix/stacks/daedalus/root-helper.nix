# The root helper — how root actions reach the box without the controller,
# which runs as the operator, holding any privilege (agent src/controller/root/).
# ARCHITECTURE.md "The root helper" is the design: the socket, the one request
# a connection carries, run files for patterns and payloads, how the outcome
# is read, and the table of verbs. Here: the verb table nix renders from
# `fleet.daedalus.rootVerbs` (contributed by the module that owns each unit),
# the socket, the per-connection `daedalus-root@` instance, and the assertions
# only the evaluation can make. Part of the daedalus stack (daedalus.nix holds
# the switch); never imports its siblings.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; })
    rootRunDir
    rootSocket
    ;

  agent = pkgs.callPackage ../../pkgs/daedalus-agent.nix { };
  inherit (import ../../platform/lib/hardening-lib.nix) hardening;

  inherit (config.fleet.daedalus) rootVerbs;
  runFileVerb = v: v.patterns != { } || v.payloadMax != null;
  rootTable = pkgs.writeText "daedalus-root-verbs.json" (
    builtins.toJSON {
      allow_uid = config.fleet.operator.uid;
      systemctl = "${config.systemd.package}/bin/systemctl";
      journalctl = "${config.systemd.package}/bin/journalctl";
      run_dir = rootRunDir;
      verbs = lib.mapAttrs (
        _: v:
        {
          inherit (v) unit description selectors;
          timeout_secs = v.timeoutSec;
          patterns = lib.mapAttrs (_: p: {
            inherit (p) regex;
            max_len = p.maxLength;
          }) v.patterns;
        }
        // lib.optionalAttrs (v.payloadMax != null) { payload_max = v.payloadMax; }
      ) rootVerbs;
    }
  );
  # An instance outlives its longest verb's wait by a minute, no more.
  rootRuntimeMax = 60 + lib.foldl' lib.max 60 (lib.mapAttrsToList (_: v: v.timeoutSec) rootVerbs);

  # The table, held at build time to the rules the helper applies at every
  # start (agent src/controller/root/mod.rs `Table::check`: names, selector values,
  # patterns, caps) by the helper itself, so the rules have one home. A table
  # it would refuse fails the build naming the reason.
  rootTableChecked = pkgs.runCommand "daedalus-root-verbs-checked.json" { } ''
    ${lib.getExe agent} root-helper --check-table ${rootTable}
    cp ${rootTable} $out
  '';

  # Every unit a verb can name: its template with each selector's values
  # spliced in (the helper's `expand`); a run-file verb's is its template.
  expansions =
    v:
    if runFileVerb v then
      [ v.unit ]
    else
      map (
        combo:
        lib.foldl' (u: k: lib.replaceStrings [ "{${k}}" ] [ combo.${k} ] u) v.unit (lib.attrNames combo)
      ) (lib.cartesianProduct v.selectors);
  # What only the evaluation can see, and the helper cannot: each unit a verb
  # can start exists on this system, is enabled, is a oneshot that does not
  # RemainAfterExit, and has no path unit — a second door to the same unit,
  # which the helper's one-run-at-a-time could not see.
  rootVerbAssertions = lib.concatLists (
    lib.mapAttrsToList (
      verb: v:
      let
        # `name@instance.service` is its template's, `name@`.
        svc =
          u:
          let
            stem = lib.removeSuffix ".service" u;
            at = builtins.match "([^@]*@).*" stem;
          in
          if at == null then stem else lib.head at;
        cfgOf = u: config.systemd.services.${svc u} or null;
      in
      map (u: {
        assertion =
          lib.hasSuffix ".service" u
          && cfgOf u != null
          && (cfgOf u).enable
          && (cfgOf u).serviceConfig.Type or null == "oneshot"
          # A start on an active RemainAfterExit oneshot is a no-op that
          # exits 0: the helper would answer `done` for a run that never was.
          && !(lib.elem ((cfgOf u).serviceConfig.RemainAfterExit or false) [
            true
            "yes"
            "true"
            "on"
            "1"
          ])
          && !(config.systemd.paths ? ${svc u});
        message = "fleet.daedalus.rootVerbs.${verb}: ${u} must be an enabled oneshot service of this system, not RemainAfterExit, with no path unit";
      }) (expansions v)
    ) rootVerbs
  );
in
{
  options.fleet.daedalus.rootVerbs = lib.mkOption {
    internal = true;
    default = { };
    description = ''
      The root helper's verbs (ARCHITECTURE.md "The root helper"): each a
      name the controller may ask for, the existing oneshot unit it starts,
      and the selectors it takes — each a fixed list of values, spliced into
      the unit name where it says `{name}`. Contributed by the module that
      owns the unit; held to the helper's own rules at build time and at
      every start, and its units asserted at evaluation.
    '';
    type = lib.types.attrsOf (
      lib.types.submodule {
        options = {
          unit = lib.mkOption {
            type = lib.types.str;
            description = "The `.service` it starts; `{selector}` marks a template instance.";
          };
          description = lib.mkOption {
            type = lib.types.str;
            description = "What it does, for `status`.";
          };
          timeoutSec = lib.mkOption {
            type = lib.types.ints.positive;
            description = "How long the helper waits for the unit's start job before it reports `failed`; the unit's own TimeoutStartSec is what stops the unit.";
          };
          selectors = lib.mkOption {
            type = lib.types.attrsOf (lib.types.listOf lib.types.str);
            default = { };
            description = "Selector name → the values it may take.";
          };
          patterns = lib.mkOption {
            type = lib.types.attrsOf (
              lib.types.submodule {
                options = {
                  regex = lib.mkOption {
                    type = lib.types.str;
                    description = "Anchored `^…$`, written with letters, digits and `^$[]{}(),|*+?._@ /:-` only (no backslash). Only the helper evaluates it (at build time through `--check-table`, and per request), against the whole value: an alternation cannot leave one branch unanchored.";
                  };
                  maxLength = lib.mkOption {
                    type = lib.types.ints.positive;
                    description = "The longest value, 1 to 256.";
                  };
                };
              }
            );
            default = { };
            description = "Pattern selector name → the shape its value must have. A verb with one names a template, `x@.service`, and gets its values in a run file, never in its unit name.";
          };
          payloadMax = lib.mkOption {
            type = lib.types.nullOr lib.types.ints.positive;
            default = null;
            description = "The largest payload the verb takes, in bytes (at most 262144), delivered in its run file; null for none.";
          };
        };
      }
    );
  };

  config = lib.mkIf config.fleet.modules.daedalus.enable {
    assertions = rootVerbAssertions;

    systemd.tmpfiles.rules = [
      # The run files: root's alone. A file a unit never came for (its start
      # failed before the helper could remove it) goes within a day. The
      # helper's locks (one per unit or template) stay: one aged out under a
      # holder would let a second helper lock a new file beside it.
      "d ${rootRunDir} 0700 root root 1d"
      "x ${rootRunDir}/*.lock"
    ];

    # The root helper's door: the operator's, 0600, so
    # the kernel lets nobody else connect, and the helper checks the peer
    # again. Accept=yes: a fresh process per connection, no resident root.
    systemd.sockets.daedalus-root = {
      description = "Daedalus root helper: the controller's one door to root";
      wantedBy = [ "sockets.target" ];
      socketConfig = {
        ListenStream = rootSocket;
        Accept = true;
        SocketUser = config.fleet.operator.user;
        SocketGroup = "root";
        SocketMode = "0600";
        DirectoryMode = "0755";
        # The controller asks one verb at a time in practice; this bounds a
        # flood from its uid without queueing a real request behind it.
        MaxConnections = 8;
      };
    };

    # One connection's root process. It reads the table, the unit states and
    # the journal and asks systemd to start a unit — nothing else — so it
    # keeps root's uid and none of its capabilities: PID 1's private socket
    # and the journal's files are root-owned, which is all it needs.
    # The work runs in the
    # verb's own unit, which a stop of this instance does not touch.
    systemd.services."daedalus-root@" = {
      description = "Daedalus root helper: one request from the controller";
      restartIfChanged = false;
      # A refusal exits 0; an instance that crashed is not kept for
      # `systemctl --failed` — its journal says what happened. A [Unit] key, not a [Service] one.
      unitConfig.CollectMode = "inactive-or-failed";
      serviceConfig = hardening // {
        ExecStart = "${lib.getExe agent} root-helper --table ${rootTableChecked}";
        StandardInput = "socket";
        StandardOutput = "journal";
        StandardError = "journal";
        RuntimeMaxSec = rootRuntimeMax;
        CapabilityBoundingSet = "";
        AmbientCapabilities = "";
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateDevices = true;
        PrivateNetwork = true;
        IPAddressDeny = "any";
        RestrictAddressFamilies = "AF_UNIX";
        ProtectProc = "invisible";
        ProcSubset = "pid";
        RestrictNamespaces = true;
        MemoryDenyWriteExecute = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = "@system-service";
        UMask = "0077";
        # The run files, and nothing else.
        ReadWritePaths = [ rootRunDir ];
      };
    };
  };
}
