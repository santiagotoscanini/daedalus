#!/bin/sh
# Install, then hand the process over to the Vite dev server.
#
# Runs on EVERY container start, against the bind-mounted /app. That is cheap in
# the steady state (warm store, node_modules already present ≈ a few seconds)
# and is what makes a package.json change take effect on a plain
# `systemctl restart podman-app-daedalus` with no image rebuild.
set -eu

cd /app

# The registry is read out of pnpm-workspace.yaml rather than restated here, so
# the app and the container that runs it can never disagree about where
# packages come from. Note the spelling: pnpm silently IGNORES
# npm_config_registry / NPM_CONFIG_REGISTRY, so an env var here would resolve
# from npmjs while looking correct.
REGISTRY="$(sed -n 's|^registry:[[:space:]]*||p' pnpm-workspace.yaml)"
test -n "$REGISTRY"

# --frozen-lockfile: the lockfile is committed, so an install that wants to
# change it means someone edited package.json without re-resolving. Failing
# here is louder — and safer — than silently resolving something new at boot.
#
# The store lives under /app so pnpm's hardlinks stay on one filesystem
# (node_modules and the store must share a mount for hardlinking to work), and
# so it survives container restarts. Both it and node_modules are gitignored.
COREPACK_NPM_REGISTRY="$REGISTRY" pnpm install --frozen-lockfile \
  --config.registry="$REGISTRY" \
  --config.store-dir=/app/.pnpm-store

# exec so Vite is PID 1 and gets podman's SIGTERM directly at stop/restart.
exec pnpm dev
