---
paths:
  - "stacks/monitoring/**"
  - "stacks/logging/**"
---

# Monitoring — prometheus, grafana, loki, resource limits

`stacks/monitoring/monitoring.nix`. Both prometheus.yml and the
dashboards dir are **nix-generated**:

- `prometheus.yml` is built from `baseScrapes` (prometheus self +
  node-exporter) + every stack's `fleet.prometheusScrapes`
  contribution.
- Dashboards dir is a `runCommand` derivation combining
  `stacks/monitoring/assets/dashboards/*.json` (OS-generic: cpu,
  memory, network, storage, home-server) + each stack's
  `fleet.grafanaDashboards` (root-level) + `grafanaDashboardsByFolder`
  (organized into sidebar folders, e.g. the "Apps" folder).

Both bind-mount /nix/store paths into the container; container
restarts automatically on any rebuild that changes the derivation.

Prometheus publishes no host port and runs without
`--web.enable-lifecycle`; reach it via `https://prometheus.toscanini.me`
or by container DNS on its bridge. Per-app scraping on the apps
platform is opt-in (`prometheus.enable`, default false).

## Provisioning vs UI

Provisioned via `disableDeletion: true` + `allowUiUpdates: false` — UI
changes are temporary; the JSON files are source of truth. Grafana's
own state (UI-added dashboards, users, service accounts, alert-rule
history) lives in the `grafana` database on the shared app-db cluster
— covered by the cluster's backup story, but NOT in the rebuild trail.
Alert rules + contact points are file-provisioned from
`assets/provisioning/alerting/`. Coverage: failed systemd units (via
a `systemd_failed_units` textfile gauge), `up == 0`, zpool state,
gluetun VPN down / port-forward lost, traefik cert expiry, and
`container_up` staleness. Gatus additionally probes each webApp's
`healthPath` — the real upstream, not the IdP.

Editing anything under `stacks/monitoring/assets/` has its own traps
(provisioning ghosts, mandatory `instant: true` on alert rules) —
`.claude/rules/monitoring-assets.md` carries them.

## Per-container metrics

Rootless podman puts container cgroups under
`user.slice/user@1000.service/...`, which no *packaged* cgroup exporter
can see — cadvisor walks the system cgroup tree and never descends into
`user@1000.service`. `host-liveness-exporter` reads those cgroup files
directly instead (one `podman ps` for the id→name map, the numbers from
`/sys/fs/cgroup/.../libpod-<id>.scope`), so per-container metrics DO
exist here, for all ~75 containers:

| Series | Notes |
|---|---|
| `container_cpu_usage_seconds_total{name}` | counter — use `rate()`; podman stats' percentage is a lifetime average |
| `container_memory_usage_bytes{name}` | `memory.current`, **page cache included** |
| `container_memory_limit_bytes{name}` | omitted entirely when uncapped |
| `container_cpu_limit_cores{name}` | omitted entirely when uncapped |
| `container_pids{name}` / `container_pids_limit{name}` | podman's own default cap is 2048 |
| `container_oom_kills_total{name}` | the signal a memory cap is too tight |

Resolution is 60s (the timer), so short rate windows are quantisation
noise. Memory sitting **at** its limit is normal — page cache is charged
there and reclaimed under pressure; read the OOM counter, not usage.
Liveness still comes from `container_up`; per-app application metrics
still live in each service's own `/metrics` endpoint.

## Container resource limits

`fleet.apps.<name>.resources` (`cpus` / `memoryMb` / `pids`) caps an app
container; other stacks pass the same flags via `extraOptions` (`pg`,
`app-db-exporter`, `janitorr`, the gha-runners). Editable in daedalus →
app → Settings. All null by default — a silently-capped app is one that
dies at 3am for a reason nobody wrote down.

These work rootless **only** because systemd delegates `cpu io memory
pids` to `user@1000.service`; verify with `cat /sys/fs/cgroup/user.slice/
user-1000.slice/user@1000.service/cgroup.controllers`. Without
delegation podman accepts the flags and the kernel ignores them.

**The `--memory-swap` trap**: podman 5.7 + crun 1.24 write it into
`memory.swap.max` **verbatim** — they do NOT subtract `--memory` the way
the docker docs describe, and they default it to `2*memory` when unset.
So `--memory=N` alone means an OOM kill at `3N`. The module always emits
`--memory-swap` equal to `--memory`, making the resident cap `N` with
`N` of zram overflow and the kill at `2N`. `--memory-swap` below
`--memory` is rejected outright, so `2N` is the floor.

## Logging (stacks/logging)

Loki + alloy state lives at `${fleet.stateRoot}/logging/{loki,alloy}/data`
(a root-level stack dir, not in a group). Alloy tags journal lines with
`stack=<name>` from `fleet.logStacks`; unregistered containers fall
back to `stack=<container-name>`. Loki runs few concurrent queries —
give it ONE patient attempt, never retries (a retry just queues behind
the first). Loki retention is 30 days.
