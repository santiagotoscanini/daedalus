# minecraft — Paper server, near-vanilla, published straight to the internet.
#
# Two containers: the server itself, and mc-monitor beside it turning the
# server-list-ping protocol into Prometheus metrics.
#
# ── why the game port is forwarded, and traefik is not involved ────────────
#
# Every other HTTP service here reaches the world through the Cloudflare
# tunnel. Minecraft cannot, and the reason is layer 7 rather than transport,
# which is worth writing down because "it is TCP, so traefik can do it" is the
# intuitive and wrong answer:
#
#   - Traefik's TCP routers match on SNI. Minecraft is a custom binary
#     protocol with no TLS, so there is no SNI to match — nothing for a router
#     to key on. (The pg 5432 TCP route works precisely because that one IS
#     TLS.)
#   - cloudflared does carry raw TCP, but only to a client running
#     `cloudflared access tcp`. A Minecraft launcher does not.
#   - Cloudflare Spectrum does proxy Minecraft Java at the edge, but it
#     "supports Cloudflare Tunnel integration only for HTTP/HTTPS
#     applications" — a TCP Spectrum app cannot originate from the tunnel, so
#     it would need this address reachable anyway.
#
# So the forward is structural, exactly like Factorio's. See
# fleet.directIngress below. What actually keeps strangers out is online-mode
# plus an ENFORCED whitelist, both evaluated during login, before a player is
# admitted — not the obscurity of the port, which crawlers index continuously.
#
# ── pasta, deliberately, unlike factorio ──────────────────────────────────
#
# bridgeMemberships is `[ ]`, so podman gives this container its own pasta
# instance and forwards 25565 into it directly. Factorio instead sits on
# traefik-net (it needs the bridge for its admin UI), which routes its
# published port through rootlessport — and rootlessport rewrites every
# client's source address to a 10.89.x.x bridge address.
#
# For a server anyone on the internet can reach, the real address is worth
# keeping: it is what makes a ban stick to more than a name, and what makes an
# abuse report legible. Nothing here needs to dial this container by name, so
# there is no bridge to give up. If pasta ever misbehaves the fallback is a
# private mc-net bridge and Factorio's rewritten addresses.
#
# ── the version is pinned twice, on purpose ───────────────────────────────
#
# The image ships no server jar; it downloads Paper for $VERSION at build
# $PAPER_BUILD on every start. So the two strings below ARE the running
# server, the same way FACTORIO_VERSION is — which is why daedalus reads them
# from here rather than keeping its own copy. Bump them together and restart.
#
# Minecraft moved to calendar versioning: 26.2 is the release that follows
# 1.21.11, and it requires Java 25, which is why the image tag is
# stable-java25 rather than the more commonly seen java21.
#
# ── state: running, and admitting nobody ──────────────────────────────────
#
# The server is up, the port is forwarded and everything around it — metrics,
# alerting, snapshots, replication, nightly archive — is live and verified.
# The whitelist is deliberately EMPTY because nobody has bought the game yet,
# so every login is refused. See the `whitelist` binding below: adding names
# there is the entire remaining step.

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  mkDotenvSecret,
  ...
}:

let
  # What the container downloads on start. See the header: this is not a
  # record of the version, it is the version.
  mcVersion = "26.2";
  paperBuild = "111";

  port = 25565;
  dataDir = "/home/santiago/selfhost/minecraft";
  backupDir = "/s2/minecraft/backups";

  # Who may join at all, and who may run commands. Not secrets — the point of
  # keeping them in nix rather than in whitelist.json is that they are
  # reviewable in a diff, and that EXISTING_WHITELIST_FILE=SYNCHRONIZE below
  # makes this list win over anything typed into the console.
  #
  # ⚠ EMPTY ON PURPOSE, AND THE ONE THING LEFT TO DO HERE.
  #
  # Nobody owns the game yet. Empty means the server runs and refuses every
  # login, which is the correct resting state for a port the router forwards:
  # it fails CLOSED, so the gap between "deployed" and "invited" is not a gap
  # anyone can walk through.
  #
  # To open it: add the Java usernames and rebuild. Nothing else changes.
  #
  # Do NOT put a guessed name here. These are resolved to UUIDs against
  # Mojang during startup, so a name that does not exist is fatal —
  #   ERROR: Could not resolve user from Playerdb: <name>
  # — and the container dies seconds in while its unit still reports
  # `active (exited)` with status 0, because podman run -d already returned.
  # That is how this stack spent its first hour looking healthy and serving
  # nothing.
  whitelist = [ ];
  ops = [ ];
in
{
  # Published so daedalus renders what the server actually runs instead of
  # carrying a second copy of two strings that must agree. Same argument as
  # fleet.factorio.version next door.
  options.fleet.minecraft = {
    version = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      description = "Minecraft version this box pins and the container downloads on start.";
    };
    paperBuild = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      description = "Paper build number for that version.";
    };
    port = lib.mkOption {
      type = lib.types.port;
      readOnly = true;
      description = "The forwarded game port players connect to.";
    };
  };

  config = {
    fleet.minecraft = {
      version = mcVersion;
      inherit paperBuild port;
    };

    # RCON_PASSWORD, and nothing else — the whitelist and ops lists are above,
    # in the open, where they can be read in a review.
    sops.secrets."minecraft-env" = mkDotenvSecret ./env.sops;

    # `[ ]` = pasta. See the header for why this one is not on traefik-net.
    fleet.bridgeMemberships.minecraft = [ ];
    # The exporter, however, is dialled BY prometheus, so it does need the
    # bridge. It reaches the game the same way traefik reaches the *arrs.
    fleet.bridgeMemberships.minecraft-monitor = [ "traefik" ];

    networking.firewall.allowedTCPPorts = [ port ];

    # The router forwards this port — see fleet.directIngress.
    fleet.directIngress.minecraft = {
      inherit port;
      proto = "tcp";
      note = "Minecraft is a bare binary protocol with no TLS, so it offers traefik no SNI to route on and the tunnel no HTTP to carry; online-mode plus an enforced whitelist are what actually gate it.";
    };

    # One name, everywhere. pi-hole answers s2.toscanini.me with the LAN
    # address (declared in platform/ddclient, which owns that hostname), so
    # the same `s2.toscanini.me:25565` a player types at home is the one that
    # works from a hotel — no second hostname, and no hairpin through the
    # router to reach a box on the same switch.

    fleet.statePaths = {
      # The dataset mountpoint itself. Declaring it also puts it in
      # state-paths.service's RequiresMountsFor, so nothing writes into the
      # empty underlay before ZFS mounts over it.
      "${dataDir}" = { };
      # /data is written by the server after the entrypoint drops to uid 1000,
      # which is host 100999 — hence the container uid here rather than 0.
      "${dataDir}/data" = {
        uid = 1000;
      };
      "/s2/minecraft" = { };
      "${backupDir}" = { };
    };

    fleet.logStacks.minecraft = [
      "minecraft"
      "minecraft-monitor"
    ];

    fleet.prometheusScrapes = [
      {
        job_name = "minecraft";
        static_configs = [ { targets = [ "minecraft-monitor:8080" ]; } ];
      }
    ];

    fleet.grafanaDashboardsByFolder."Gaming".minecraft = builtins.readFile ./assets/dashboard.json;

    virtualisation.oci-containers.containers.minecraft = mkRootlessContainer {
      image = "docker.io/itzg/minecraft-server:stable-java25@sha256:e3335993929a1565f73c30b2041bcbc1473fc9c406fdd5a0d0ea24c08ef73320";

      environment = {
        EULA = "TRUE";

        TYPE = "PAPER";
        VERSION = mcVersion;
        PAPER_BUILD = paperBuild;

        # Aikar's G1 flags with Xms=Xmx. Six gigabytes is generous for a
        # household server and deliberately not more: a bigger heap buys
        # nothing here and lengthens the mixed collections that cause the
        # tick stutter the flags exist to avoid.
        MEMORY = "6G";
        USE_AIKAR_FLAGS = "TRUE";

        # ── who gets in ──────────────────────────────────────────────────
        # Mojang session auth. The single most important line in this file:
        # with it off, anyone may claim any username.
        ONLINE_MODE = "TRUE";
        ENABLE_WHITELIST = "TRUE";
        # Without this the whitelist is only consulted at login, so a player
        # removed from the list stays connected until they choose to leave.
        ENFORCE_WHITELIST = "TRUE";
        WHITELIST = lib.concatStringsSep "," whitelist;
        OPS = lib.concatStringsSep "," ops;
        # Make the nix lists authoritative on every start, so a `/whitelist
        # add` typed into the console is a temporary act rather than a silent
        # second source of truth.
        EXISTING_WHITELIST_FILE = "SYNCHRONIZE";
        EXISTING_OPS_FILE = "SYNCHRONIZE";
        PREVENT_PROXY_CONNECTIONS = "TRUE";
        # Off by default; stated because the query listener is the extra UDP
        # surface server-list crawlers scrape, and it buys us nothing —
        # mc-monitor uses the status ping, which is a different thing.
        ENABLE_QUERY = "FALSE";

        # ── gameplay ─────────────────────────────────────────────────────
        MODE = "survival";
        DIFFICULTY = "normal";
        MOTD = "s2-server · survival";
        MAX_PLAYERS = "20";
        SPAWN_PROTECTION = "0";

        # ── tick and I/O budget ──────────────────────────────────────────
        VIEW_DISTANCE = "10";
        # Below view-distance on purpose: players see ten chunks out but only
        # eight tick, which is where most of the per-player main-thread cost
        # actually goes.
        SIMULATION_DISTANCE = "8";
        # The world lives on NVMe behind ZFS, which already orders writes.
        # Leaving this on makes the server fsync each chunk inline on the
        # main thread, which shows up directly as tick time.
        SYNC_CHUNK_WRITES = "false";

        # RCON listens on 25575 inside the netns and is NOT published — the
        # only way to it is `podman exec`, which is how the backup job below
        # quiesces the world.
        ENABLE_RCON = "TRUE";

        # Give Paper time to flush every region file before podman's timeout
        # takes the process out. Paired with --stop-timeout below.
        STOP_DURATION = "90";
        # Stated rather than left to default: autopause SIGSTOPs the JVM when
        # nobody is on, and every metrics scrape would then wake it — the
        # exporter beside this container would fight it once a minute.
        ENABLE_AUTOPAUSE = "FALSE";
      };

      environmentFiles = [ config.sops.secrets."minecraft-env".path ];

      ports = [ "${toString port}:${toString port}/tcp" ];

      volumes = [ "${dataDir}/data:/data" ];

      extraOptions = [
        # Must exceed STOP_DURATION. Factorio needs 30s for the same reason;
        # a Paper save of a grown world is slower, and being SIGKILLed
        # mid-save costs whatever happened since the last autosave.
        "--stop-timeout=120"
        # 6G heap plus JVM overhead. BOTH flags, always: podman writes
        # --memory-swap into memory.swap.max verbatim rather than subtracting
        # --memory the way the docker docs describe, and defaults it to twice
        # --memory — so --memory=8g alone would not kill until 24g.
        "--memory=8g"
        "--memory-swap=8g"
        "--pids-limit=512"
        # The JVM itself needs no capabilities — but the entrypoint starts as
        # root and drops to uid 1000, and that switch needs SETUID/SETGID.
        # `--cap-drop=ALL` alone kills the container in under a second with
        # "failed switching to 'minecraft:minecraft': operation not permitted",
        # and --rm plus Type=oneshot means the unit still reports success.
        #
        # These two and no more: the usual advice adds CHOWN as well, for the
        # entrypoint's chown of /data. It is not needed here because
        # fleet.statePaths above already hands over /data owned by 100999 —
        # verified by running with SETUID+SETGID only against the real bind
        # mount. Once dropped, the server is a plain unprivileged process and
        # holds none of this.
        "--cap-drop=ALL"
        "--cap-add=SETUID"
        "--cap-add=SETGID"
        # No --cpuset-cpus pinning the main thread onto the 12600K's P-cores,
        # tempting as it is: user@1000.service is delegated `cpu io memory
        # pids` and NOT cpuset, so podman would accept the flag and the
        # kernel would quietly ignore it.
      ];
    };

    # Protocol-level metrics rather than a plugin. Every Prometheus exporter
    # plugin for Paper is a version behind 26.2 and would have to be re-vetted
    # on each bump; the server-list ping is part of the protocol and cannot
    # go stale. It costs TPS, which a plugin would have given — read tick
    # health from spark when a question actually needs it.
    virtualisation.oci-containers.containers.minecraft-monitor = mkRootlessContainer {
      image = "docker.io/itzg/mc-monitor:0.17.0@sha256:0d6b89c29d93cfcfcfee7bfd8e3758ddf00e20eb157e3e9a6560a93fe7fe84d1";
      cmd = [ "export-for-prometheus" ];
      environment = {
        # The game is in its own pasta netns, so it is reached the way traefik
        # reaches the *arrs: back out through the host's published port.
        EXPORT_SERVERS = "host.containers.internal:${toString port}";
      };
    };

    # ── backups ───────────────────────────────────────────────────────────
    #
    # A oneshot rather than the usual itzg/mc-backup sidecar. The sidecar
    # sleeps in a container where nothing watches it; a systemd unit joins
    # fleet.monitoredJobs and so gets failure mail AND a healthchecks
    # dead-man ping, which is what catches the backup that quietly stops
    # happening — the failure mode that actually loses a world.
    #
    # This is the third tier of three, and the only one that is a clean
    # snapshot: ZFS holds 15-minute crash-consistent copies of the world
    # alone, syncoid mirrors those to the HDD pool, and this writes a
    # quiesced archive to a different pool.
    systemd.services.minecraft-backup = {
      description = "Quiesce the Minecraft world and archive it to /s2";
      after = [ "podman-minecraft.service" ];
      unitConfig.RequiresMountsFor = [
        dataDir
        "/s2/minecraft"
      ];
      path = [
        pkgs.podman
        pkgs.gnutar
        pkgs.zstd
        pkgs.coreutils
        pkgs.findutils
        pkgs.util-linux
      ];
      serviceConfig = {
        Type = "oneshot";
      };
      # Runs as ROOT, and has to. The server writes level.dat as 0600 owned by
      # its own uid (container 1000 = host 100999), so a job running as
      # santiago cannot read the single most important file in the world — and
      # tar says "Permission denied" for it while happily archiving everything
      # else. That is the worst possible failure for a backup: an archive that
      # looks complete and restores to nothing.
      #
      # setpriv for the podman calls, not runuser/sudo: those open a PAM
      # session per call and log a pair of lines each time. Same reason
      # stacks/apps and platform/podman-prune do it this way.
      script = ''
        set -euo pipefail
        stamp=$(date +%Y%m%d-%H%M%S)
        archive="${backupDir}/minecraft-$stamp.tar.zst"

        mc() {
          setpriv --reuid=santiago --regid=users --init-groups --inh-caps=-all \
            env HOME=/home/santiago XDG_RUNTIME_DIR=/run/user/1000 podman "$@"
        }

        # A stopped server needs no quiescing — its files are already at rest.
        # And "the server is down" is not a reason to skip the backup; it is a
        # reason this copy might be the one that matters.
        if [ "$(mc inspect -f '{{.State.Running}}' minecraft 2>/dev/null || echo false)" = "true" ]; then
          # save-on MUST run again whatever happens below. A tar that fails
          # with saving still disabled leaves the server writing nothing to
          # disk until somebody notices, which is worse than no backup at all.
          trap 'mc exec minecraft rcon-cli save-on || true' EXIT
          mc exec minecraft rcon-cli save-off
          mc exec minecraft rcon-cli save-all flush
        fi

        # Jars, libraries and caches are re-downloadable and dominate the
        # archive; the world plus the handful of files describing the server
        # are the part that cannot be rebuilt.
        #
        # spark's tmp is excluded because Paper now bundles spark, and its
        # profiler scratch files appear and vanish while tar is walking the
        # tree — which tar reports as an error and would fail this job nightly
        # for a file nobody wants backed up.
        tar --use-compress-program='zstd -3 -T4' \
            --exclude=./logs \
            --exclude=./cache \
            --exclude=./libraries \
            --exclude=./versions \
            --exclude=./plugins/spark/tmp \
            --exclude='*.jar' \
            -cf "$archive" \
            -C "${dataDir}/data" .

        # The archive is written by root into a santiago-owned directory; hand
        # it over so the whole backup tree has one owner.
        chown santiago:users "$archive"

        # A world that cannot be restored is not a backup. Cheap proof that
        # the archive is readable AND that the one file everything else hangs
        # off actually made it in.
        tar --use-compress-program=zstd -tf "$archive" ./world/level.dat > /dev/null

        find "${backupDir}" -maxdepth 1 -name 'minecraft-*.tar.zst' -mtime +14 -delete
      '';
    };

    systemd.timers.minecraft-backup = {
      description = "Nightly Minecraft world archive";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        # Not on the hour: the speedtest job at :00 saturates the WAN and
        # takes DNS with it for a couple of minutes.
        OnCalendar = "*-*-* 05:17:00";
        Persistent = true; # catch up if the box was off
        RandomizedDelaySec = "5m";
      };
    };

    # Mail on failure, and a dead-man ping so a backup that stops running is
    # noticed. Set the check's period to 1 day and grace to 2 hours in the
    # healthchecks UI — a self-provisioned check gets defaults that are wrong.
    fleet.monitoredJobs.minecraft-backup = {
      slug = "minecraft-backup";
    };
  };
}
