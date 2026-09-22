#!/bin/sh
# One image, two ways to run it; which one is decided here, at start.
#
#   default                         node server.mjs, from the bundle the image
#                                   was built with. Needs DATABASE_URL.
#   DAEDALUS_DEV=1 + a tree at /app `pnpm install --frozen-lockfile`, then
#                                   `vite dev` against the mounted source.
#
# A shell script rather than a node one because both branches end in `exec`:
# the server (or pnpm) must BE the container's process to receive the stop
# signal, and node cannot replace itself.
#
# Installed as `daedalus-entrypoint`: the node base image already owns
# /usr/local/bin/docker-entrypoint.sh.
set -eu

if [ "${DAEDALUS_DEV:-}" = "1" ]; then
  if [ -f /app/package.json ]; then
    cd /app

    # Rootless podman maps the host user to uid 0, so a tree the host user
    # owns is read-only to the image's `node` user. Saying so beats pnpm's
    # EACCES forty lines into an install.
    if [ ! -w /app ]; then
      echo "[daedalus] DAEDALUS_DEV=1 but /app is not writable by uid $(id -u)." >&2
      echo "[daedalus] Under rootless podman add --user 0:0 (container root IS the host user)." >&2
      exit 1
    fi

    # The registry is the mounted tree's own declaration unless the caller
    # overrides it (a checkout that cannot reach that registry). pnpm silently
    # IGNORES npm_config_registry / NPM_CONFIG_REGISTRY, hence the flag.
    REGISTRY="${NPM_REGISTRY:-$(sed -n 's|^registry:[[:space:]]*||p' pnpm-workspace.yaml)}"
    test -n "$REGISTRY"

    # The image carries corepack's shims and no pnpm: the version is the
    # mounted package.json's to name, and it is fetched once into the mount.
    # The store sits beside node_modules by default so pnpm can hardlink.
    export COREPACK_HOME="${COREPACK_HOME:-/app/.corepack}"
    export COREPACK_NPM_REGISTRY="$REGISTRY"
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

    pnpm install --frozen-lockfile \
      --config.registry="$REGISTRY" \
      --config.store-dir="${PNPM_STORE_DIR:-/app/.pnpm-store}"

    exec pnpm dev
  fi

  # A missing clone used to mean no control plane at all. The bundle is right
  # here, so serve it and say which one is running.
  echo "[daedalus] DAEDALUS_DEV=1 but there is no source tree at /app — serving the built bundle." >&2
fi

cd /opt/daedalus

# The runtime stage alone (`--target runtime`, what a dev-mode box builds)
# carries no bundle. Saying so beats node's "Cannot find module".
if [ ! -f server.mjs ]; then
  echo "[daedalus] this image is the runtime stage only — no bundle at /opt/daedalus. Run it with DAEDALUS_DEV=1 and a source tree at /app." >&2
  exit 1
fi

# Set here and not with ENV: pnpm skips devDependencies under
# NODE_ENV=production, which would leave the dev branch without Vite.
export NODE_ENV=production
exec node server.mjs
