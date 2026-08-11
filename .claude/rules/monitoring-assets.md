---
paths:
  - "stacks/monitoring/assets/**"
---

# Grafana provisioning — traps when editing these assets

## Dashboards: the provisioner never deletes, and neither can you

Grafana refuses API/UI deletion of any dashboard that still has a
provisioning record, and the provisioner never deletes on file removal —
so removing a JSON leaves a ghost. Worse, **moving** a provisioned JSON
to a new path creates a *duplicate* `dashboard_provisioning` row
(they're keyed by file path), after which per-uid GETs 500 with "found
more than one provisioned dashboard".

The way out is to **rename the provider** in
`provisioning/dashboards/home-server.yaml` — Grafana purges rows whose
provider is absent from config at startup.

Never mint a provisioned dashboard with a throwaway uid; it can never be
cleanly deleted.

## Alert rules must be instant queries

A provisioned rule feeding a Prometheus query straight into a
`type: threshold` condition **must** set `instant: true` on the query
model. Without it the query runs as a range query and the threshold
expression intermittently fails with
`DatasourceError … only reduced data can be alerted on`.

The failure is **non-deterministic** — 3 of 26 rules were erroring while
byte-identical ones were fine — so "healthy now" is not evidence a rule
is safe. Every rule's time-windowing already lives inside its PromQL
(`rate[5m]`, `predict_linear[6h]`), which an instant query evaluates
correctly at `now`, so `instant: true` is always right here and changes
no firing thresholds.

To check live rule health without waiting for an email:

```
curl -sk -u "$GF_USER:$GF_PASS" \
  https://grafana.toscanini.me/api/prometheus/grafana/api/v1/rules
# filter .data.groups[].rules[] | select(.health=="error")
```

(`GF_USER`/`GF_PASS` from `/run/secrets/grafana-env`.) A candidate fix
can be tested without touching files via `POST /api/v1/eval` with the
rule's `data` array. Note the `DatasourceError` alert email *borrows the
broken rule's summary*, so the alertname in the mail looks mismatched —
the real error is in the `Err` annotation.
