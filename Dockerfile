# The daedalus engine: one image, run two ways (docker-entrypoint.sh).
#
#   podman build -t daedalus .                        # npmjs, what CI does
#   podman build -t daedalus \                        # on the box, via Verdaccio
#     --add-host=verdaccio.toscanini.me:host-gateway \
#     --build-arg NPM_REGISTRY=https://verdaccio.toscanini.me/ .
#
# The context is the repository root; the app is under app/.
#
# Debian slim, not alpine: lightningcss, rolldown and @node-rs/argon2 ship
# glibc prebuilds. Pinned by index digest, so every platform resolves its own.
ARG NODE_IMAGE=docker.io/library/node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

# --- build -------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build

# app/pnpm-workspace.yaml names the box's Verdaccio, which nothing outside the
# house can reach. The lockfile holds integrity hashes and no tarball URLs, so
# any registry that serves the same bytes will do; minimumReleaseAge and
# allowBuilds come from the same file and apply whichever registry answers.
ARG NPM_REGISTRY=https://registry.npmjs.org/

# corepack fetches the pnpm that package.json's packageManager names, and
# would go to npmjs for it regardless of the registry above.
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY} \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable

WORKDIR /src/app

# The install is its own layer: a source edit does not repeat it.
COPY app/package.json app/pnpm-lock.yaml app/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --config.registry="${NPM_REGISTRY}"

COPY app/ ./

# scripts/build.mjs: vite build under the identity canaries, then check-build.
RUN pnpm build

# The build bundled every dependency it could, so package.json's
# `dependencies` is exactly what the server still resolves at run time
# (check-build holds it to that). A fresh install from the store the first one
# filled, so nothing is fetched twice — and fresh because `--prod` over an
# existing node_modules unlinks the dev packages but leaves all 200 MB of them
# in the virtual store.
RUN rm -rf node_modules \
 && pnpm install --prod --frozen-lockfile --offline --config.registry="${NPM_REGISTRY}"

# --- run ---------------------------------------------------------------------
FROM ${NODE_IMAGE}

# Shims only, a few symlinks: the dev branch fetches the pnpm its mounted tree
# names. This, and node itself, is all of the toolchain the image carries —
# dev dependencies come from the mounted tree's own install.
RUN corepack enable

# Not /app: that is where a source tree is mounted, and the mount must not
# hide the bundle the entrypoint falls back to.
WORKDIR /opt/daedalus

# package.json is read at run time for the engine's version (core/site).
COPY --from=build /src/app/package.json /src/app/server.mjs ./
COPY --from=build /src/app/drizzle ./drizzle
COPY --from=build /src/app/node_modules ./node_modules
COPY --from=build /src/app/dist ./dist
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/daedalus-entrypoint

# No init here: node as PID 1 reaps nothing, so run it with `--init`.
# server.mjs handles SIGTERM itself either way.
USER node
ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["daedalus-entrypoint"]
