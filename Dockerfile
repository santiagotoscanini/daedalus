# The daedalus engine: one image, run two ways (docker-entrypoint.sh).
#
#   podman build -t daedalus .                        # npmjs, what CI does
#   podman build -t daedalus-runtime --target runtime . # the runtime alone (dev mode)
#   podman build -t daedalus \                        # through a registry mirror
#     --add-host=registry.example.internal:host-gateway \
#     --build-arg NPM_REGISTRY=https://registry.example.internal/ .
#
# The context is the repository root; the app is under app/. linux/amd64
# only: the run stage holds the build platform's argon2 binary, and the sops
# stage fetches an amd64 release.
#
# Debian slim, not alpine: lightningcss, rolldown and @node-rs/argon2 ship
# glibc prebuilds. Pinned by index digest, so every platform resolves its own.
ARG NODE_IMAGE=docker.io/library/node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

# --- sops --------------------------------------------------------------------
#
# Every secret the app writes (the Cloudflare token, the GitHub App's key, an
# app's secrets — core/vault.ts) is sealed to the recipients in
# /site/.sops.yaml before it leaves the container, so the plaintext never
# lands on the bridge directory. Encrypt-only by construction:
# the image holds no age identity, so sops here can write a secret it can
# never read back. The upstream release binary is static (no libc to match
# the run stage's), fetched by version and refused on a checksum mismatch.
#
# To bump: pick the release at https://github.com/getsops/sops/releases and
# take the linux.amd64 line of its `sops-v<version>.checksums.txt`.
FROM scratch AS sops
ARG SOPS_VERSION=3.13.3
ARG SOPS_SHA256=e5bec3346a873ae91d871550f3e698c1aad962aff462a080e40f25fde17fef6b
ADD --checksum=sha256:${SOPS_SHA256} \
    https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/sops-v${SOPS_VERSION}.linux.amd64 /sops

# --- build -------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build

# app/pnpm-workspace.yaml names npmjs; a box with a mirror of its own passes
# it here. The lockfile holds integrity hashes and no tarball URLs, so
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

# --- runtime -----------------------------------------------------------------
# Everything but the app: node, corepack's shims, sops, the entrypoint. The
# final stage puts the bundle on top of it. A box that runs the control plane
# in dev mode builds THIS stage on its own (`--target runtime`, from a context
# of just this file and the entrypoint) and mounts its checkout at /app — so
# that image moves only when the runtime does, never when a route is edited.
FROM ${NODE_IMAGE} AS runtime

# Shims only, a few symlinks: the dev branch fetches the pnpm its mounted tree
# names. This, and node itself, is all of the toolchain the image carries —
# dev dependencies come from the mounted tree's own install.
RUN corepack enable

# Not /app: that is where a source tree is mounted, and the mount must not
# hide the bundle the entrypoint falls back to.
WORKDIR /opt/daedalus

COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/daedalus-entrypoint
# Where core/vault.ts execs it (the sops stage above says why it is here).
COPY --from=sops --chmod=0755 /sops /usr/local/bin/sops

# No init here: node as PID 1 reaps nothing, so run it with `--init`.
# server.mjs handles SIGTERM itself either way.
USER node
ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["daedalus-entrypoint"]

# --- run ---------------------------------------------------------------------
FROM runtime

# package.json is read at run time for the engine's version (core/site).
COPY --from=build /src/app/package.json /src/app/server.mjs ./
COPY --from=build /src/app/drizzle ./drizzle
COPY --from=build /src/app/node_modules ./node_modules
COPY --from=build /src/app/dist ./dist
