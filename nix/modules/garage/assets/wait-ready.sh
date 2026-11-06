# shellcheck shell=bash
# ExecStartPost of podman-garage: hold the unit — and every tenant ordered
# after it — until the store answers as a cluster, not merely as a process.
#
# `podman run -d` returns as soon as the container exists. Garage then opens
# its database, and on the very first start `--single-node` assigns and
# applies the one-node layout; until that is done S3 requests fail. `garage
# health` (over the in-container RPC loopback) exits 0 only once the cluster
# is available. No parameters.

for _ in $(seq 1 90); do
  if podman exec garage /garage health -q >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done
echo "garage did not report a healthy cluster within 90s" >&2
podman exec garage /garage status >&2 || true
exit 1
