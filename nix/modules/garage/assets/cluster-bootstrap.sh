# shellcheck shell=bash
# The object store's own secrets, generated once on the box.
#
# Parameters (set by the wrapper in garage.nix):
#   CLUSTER_ENV                     <machineState>/garage/cluster/env
#   OPERATOR_USER, OPERATOR_GROUP   owner of the file
#
# GARAGE_RPC_SECRET is the cluster's root credential: whoever holds it can
# drive every admin operation over RPC without a token. GARAGE_METRICS_TOKEN
# is the bearer prometheus scrapes /metrics with. Both are read by Garage
# from its environment (an env var is not subject to the 0600 check Garage
# applies to *_FILE secrets). Rotation = stop garage, delete this file,
# rebuild; the RPC secret changes nothing on disk, so the store survives it.

install -d -m 0700 -o "$OPERATOR_USER" -g "$OPERATOR_GROUP" "$(dirname "$CLUSTER_ENV")"

if [ ! -e "$CLUSTER_ENV" ]; then
  RPC_SECRET=$(openssl rand -hex 32)
  METRICS_TOKEN=$(openssl rand -hex 32)
  install -m 0600 -o "$OPERATOR_USER" -g "$OPERATOR_GROUP" /dev/stdin "$CLUSTER_ENV" <<EOF
GARAGE_RPC_SECRET=$RPC_SECRET
GARAGE_METRICS_TOKEN=$METRICS_TOKEN
EOF
fi
