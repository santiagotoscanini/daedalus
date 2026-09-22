# The digest pin of every container an engine module runs on this box.
#
# The engine carries no pin: the control plane's image-update agent rewrites a
# `repo:tag@sha256:digest` literal IN PLACE in a `.nix` file of this checkout
# and cannot write into a flake input, so a module reads
# `fleet.images.<container>` and the host keeps every value here, in ONE file
# (the agent locates a pin by its digest and refuses one found in two files).
# Keyed by CONTAINER name — the key System › Updates already uses. Keep each
# value a full literal on one line, so both of the agent's rewrites match.
#
# The values below are PLACEHOLDERS that evaluate but pull nothing: resolve
# each with `skopeo inspect docker://<repo>:<tag>` (or let System › Updates
# do it once the control plane is up) before the first switch.
_: {
  fleet.images = {
    alloy = "docker.io/grafana/alloy:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    app-db-exporter = "quay.io/prometheuscommunity/postgres-exporter:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    cloudflared = "docker.io/cloudflare/cloudflared:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    gatus = "docker.io/twinproduction/gatus:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    grafana = "docker.io/grafana/grafana:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    healthchecks = "docker.io/healthchecks/healthchecks:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    loki = "docker.io/grafana/loki:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    node-exporter = "docker.io/prom/node-exporter:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    pocket-id = "ghcr.io/pocket-id/pocket-id:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    prometheus = "docker.io/prom/prometheus:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    stirling-pdf = "docker.io/stirlingtools/stirling-pdf:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    traefik = "docker.io/library/traefik:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    zot = "ghcr.io/project-zot/zot:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
  };
}
