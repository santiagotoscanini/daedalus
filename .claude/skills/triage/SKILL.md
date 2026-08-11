---
name: triage
description: Debug a broken or misbehaving service on s2-server the way this box demands — container-level truth, Loki history, and the known cascade failures (pg→pocket-id, FTL rate limit, wedged gluetun, myspeed blackout). Use when something is down, 502ing, or "was working yesterday".
argument-hint: [symptom, e.g. "jellyfin 502" or "every gated app redirects forever"]
---

# /triage — incident debugging on s2-server

This box returns confident wrong answers, not errors. Work the evidence in
this order and do not trust a single green indicator.

## 0. Wide sweep first (30 seconds)

```bash
systemctl --failed
sudo -u santiago env XDG_RUNTIME_DIR=/run/user/1000 \
  podman ps --format '{{.Names}}\t{{.Status}}' | sort
```

`podman ps`, not unit state: `Type=oneshot` + `RemainAfterExit` + `--rm`
means a container that died seconds after start leaves a **green unit and
no corpse**. A container missing from `podman ps` with a green unit IS the
finding.

## 1. Pattern-match the known cascades before deep-diving

| Symptom | Likely cause | Confirm | Fix |
|---|---|---|---|
| EVERY gated app 302-loops / "Failed to exchange auth code"; pocket-id can't send mail | FTL rate limit — all ~75 containers share `127.0.0.1`'s 1000 q/60s budget | `sudo grep -i 'Rate-limiting 127.0.0.1' /var/log/pihole/FTL.log` (NOT journald) | Raise `misc.rateLimit` (restarts pihole-ftl = brief LAN DNS outage — **ask first**) |
| id.toscanini.me 502; SSO apps down; wealthfolio dead | pg bounced; pocket-id died silently (green unit) | `podman ps --filter name=pocket-id` — missing | `sudo systemctl restart podman-pocket-id`, then anything else down, then verify discovery: `curl -sk --resolve id.toscanini.me:443:192.168.0.2 https://id.toscanini.me/.well-known/openid-configuration` → 200 |
| Whole TV/*arr netns 502s; qbit unreachable | Wedged gluetun — `podman ps` says `Up N days` WITH port mappings, but the tunnel restart-loops internally | gluetun's OWN logs: `podman logs --since 30m gluetun \| grep -i 'restarting VPN'`; `ss -lntp` shows no listener | `sudo systemctl restart podman-gluetun` (or `podman-gluetun-argus`) — bounces every tenant; restart them after |
| House-wide DNS dead for 1–2 min around :00 | myspeed's hourly speedtest saturating the uplink | timing correlation; myspeed logs | Known; don't schedule anything network-heavy on the hour |
| Box has no DNS at all; SSH by name fails | pi-hole down (box resolves through 127.0.0.1) | SSH by IP `192.168.0.2` | `sudo systemctl restart pihole-ftl` (**ask first** — LAN outage) |
| A service "was updated" but behaves old | moving tag never re-pulled (`--pull missing` matches tag, not digest) | `podman inspect <name> --format '{{.ImageDigest}}'` vs registry | explicit `podman pull` + `systemctl restart podman-<name>` |
| App deploy "succeeded" but app broken | deploy-and-report: failed health check keeps old process running, unit stays failed | `systemctl --failed`; `/var/lib/app-deploy/<name>` | read `journalctl -u app-<name>-deploy` |

## 2. Logs — from the container, not the unit journal

`journalctl -u podman-<name>` holds ~5 systemd lines and NONE of the
container's output. Use:

```bash
podman logs --since 15m <container> | tail -50
```

For history beyond the container's lifetime ("is this error new?"), query
Loki through Grafana's datasource proxy (prefer the grafana MCP tools if
connected; otherwise):

```bash
GF_USER=$(sudo grep '^GF_SECURITY_ADMIN_USER=' /run/secrets/grafana-env | cut -d= -f2-)
GF_PASS=$(sudo grep '^GF_SECURITY_ADMIN_PASSWORD=' /run/secrets/grafana-env | cut -d= -f2-)
curl -sk -u "$GF_USER:$GF_PASS" --resolve grafana.toscanini.me:443:192.168.0.2 \
  -G "https://grafana.toscanini.me/api/datasources/proxy/uid/loki-default/loki/api/v1/query_range" \
  --data-urlencode '{stack="<stack>"} |= "<needle>"' --data-urlencode 'limit=5'
```

Stack labels from `fleet.logStacks`; ad-hoc runs collapse to
`stack=adhoc`. Loki gets ONE patient attempt — never retry a busy Loki.

## 3. Reachability — test the path the user actually takes

```bash
curl -sk --resolve <host>:443:192.168.0.2 -o /dev/null -w '%{http_code}' https://<host>/
```

Remember: a gatus probe passing means "answered < 500" — a 404 passes. A
container→host connection stalling ~10s then working is the known
first-SYN pasta stall, not the service. Netns tenants reach the host ONLY
at `host.containers.internal`, never 192.168.0.2.

## 4. Metrics for "since when" / "how bad"

Prometheus (prefer the grafana MCP if connected): `container_up{name=…}`
staleness, `container_oom_kills_total` (a capped container dying at night),
`rate(container_cpu_usage_seconds_total[5m])`. 60s resolution — don't read
short windows.

## 5. Fixing

Diagnosis first, then the fix follows the rules: transient state →
`systemctl restart podman-<x>` (fine); config cause → declarative edit +
`/rebuild`; app-internal state → the app's own API/UI, NEVER sqlite3/psql
writes (rule 2). If the fix is destructive or takes shared infra down
(pi-hole, pg, gluetun), say what and why and confirm first.

## Report

Symptom → evidence chain → root cause → what was done → verification, with
the actual command outputs that prove each link. If the cause is a known
gotcha, name the CLAUDE.md/rule section so the pattern reinforces. If you
found a NEW lie/gotcha, propose the doc addition.
