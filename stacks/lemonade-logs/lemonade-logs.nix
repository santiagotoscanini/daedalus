# lemonade-logs — ships the Lemonade model server's logs into Loki.
#
# Lemonade runs on the Windows gaming PC (see /etc/nixos/lemonade.md), so
# its logs are the one part of this system's AI stack that journald never
# sees. It offers exactly one log egress — a WebSocket at /logs/stream.
# Its OpenTelemetry support exports TRACES ONLY (the docs say so in those
# words), there is no syslog or OTLP-logs exporter, and its log file lives
# on the Windows box. So a WebSocket client is not a shortcut here; it is
# the only door.
#
# Alloy has no WebSocket source, hence this small bridge container. It
# pushes straight to Loki rather than printing to stdout for alloy to
# collect, for two reasons:
#
#   - Timestamps. The 5000-entry backfill spans days. Via journald every
#     replayed line would be stamped with its INGEST time; pushing
#     directly preserves the time each event actually happened.
#   - Layering. Lemonade's severity/tag vocabulary stays inside this
#     stack instead of becoming a Lemonade-shaped parse block in the
#     platform-level stacks/logging module.
#
# Labels match what stacks/logging produces for everything else —
# {stack, service_name, host, level} — plus `tag` (Lemonade's own log
# source: Server, Process, Telemetry, WebSocket). Level vocabulary is
# folded onto the shared one in the bridge, so `level="error"` means the
# same thing here as anywhere else. `job` is deliberately absent: nothing
# queries it, and `host="gaming-pc"` already marks these as the one
# stream that did not come from this box's journal. Cardinality ceiling
# is ~30 streams.
#
# The bridge's OWN stdout still goes to journald like every container,
# and is deliberately NOT registered in fleet.logStacks: the documented
# fallback gives it stack=lemonade-logs, which keeps the bridge's
# diagnostics (reconnects, gap warnings) separate from the remote
# server's logs it publishes under stack=lemonade.
#
# Liveness: no metrics endpoint of its own — it is covered by
# container_up like every other container, and its unit inherits the
# platform's Restart=on-failure. The bridge additionally retries
# internally with capped backoff, because a rootless podman unit is
# Type=oneshot: a crashed container leaves the unit active(exited), so
# recovery has to come from inside the process.
#
# Reconnect cost is bounded on purpose. Every connection makes Lemonade
# log "New connection from: 192.168.0.2", so a crash-looping bridge would
# feed its own input; the backoff caps that at one line per 5 minutes.

{ pkgs, mkRootlessContainer, ... }:

{
  # Loki publishes no host port (unauthenticated by design), so the only
  # way to reach it is the bridge it lives on.
  fleet.bridgeMemberships.lemonade-logs = [ "monitoring" ];

  # Resume cursor. Without it a restart re-subscribes with after_seq=null
  # and replays Lemonade's entire 5000-entry ring into Loki.
  fleet.statePaths."/home/santiago/selfhost/lemonade-logs/state" = { };

  virtualisation.oci-containers.containers.lemonade-logs = mkRootlessContainer {
    # Stock python purely as a runtime — the bridge is stdlib-only, so
    # there is nothing to install and no image to build.
    image = "docker.io/library/python:3.13-alpine@sha256:399babc8b49529dabfd9c922f2b5eea81d611e4512e3ed250d75bd2e7683f4b0";

    dependsOn = [ "loki" ];

    cmd = [
      "python3"
      "-u" # unbuffered: journald gets each line as it happens
      "/bridge.py"
    ];

    volumes = [
      "${./assets/bridge.py}:/bridge.py:ro"
      # Lemonade stamps local wall-clock with no UTC offset, so the
      # bridge resolves it against the container TZ (injected by
      # mkRootlessContainer). Alpine ships no zoneinfo — without this
      # mount Python silently falls back to UTC and every line lands
      # three hours off.
      "${pkgs.tzdata}/share/zoneinfo:/usr/share/zoneinfo:ro"
      "/home/santiago/selfhost/lemonade-logs/state:/var/lib/lemonade-logs"
    ];

    environment = {
      LEMONADE_HOST = "gaming-pc.local.toscanini.me";
      LEMONADE_PORT = "13305";
      LOKI_URL = "http://loki:3100/loki/api/v1/push";
      CURSOR_FILE = "/var/lib/lemonade-logs/cursor";
      LABEL_STACK = "lemonade";
      LABEL_SERVICE = "lemonade";
      LABEL_HOST = "gaming-pc";
    };
  };
}
