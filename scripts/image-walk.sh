#!/usr/bin/env bash
# The proof of the image: build it, run it both ways against a throwaway
# Postgres, walk it in a real browser, and refuse on anything the browser
# recorded. Run from the repository root before a tag, and after any change to
# the Dockerfile, the entrypoint, server.mjs or the build scripts.
#
#   scripts/image-walk.sh
#
#   # through a registry mirror the build container reaches by the host gateway
#   NPM_REGISTRY=https://registry.example.internal/ \
#   PODMAN_ARGS='--add-host=registry.example.internal:host-gateway' \
#     scripts/image-walk.sh
#
# In order:
#   1. the build (the sops stage's checksum included), and the sops it carries
#   2. production: migrations at start, /api/healthz, then scripts/image-walk.mjs
#      over /, /apps, /settings, /c/system, /apps/new and one authenticated
#      write, with the identity given at `podman run` — and no console error,
#      page error, failed same-origin request or 5xx in the run's events.json.
#      A 4xx is reported, not refused: a page may legitimately ask for
#      something a bare image does not have.
#   3. dev: the same image with DAEDALUS_DEV=1 over a COPY of app/, until Vite
#      serves /api/healthz. A copy, never the checkout: the entrypoint installs
#      into the tree it is given, and on the author's box that tree is what the
#      live control plane is running from.
#
# The browser is `shot`, the author's headless-Chromium CLI (a one-line podman
# wrapper over Playwright); it runs the driver with --network=host, which is
# why the app is published on 127.0.0.1 and the driver is handed that URL. Its
# run directory — viewport PNGs, events.json, summary.json — is the evidence,
# and its path is the last line this script prints.
#
#   IMAGE        the tag to build           (localhost/daedalus:walk)
#   PORT         the loopback port          (3300)
#   NPM_REGISTRY the build's registry and the dev install's; unset is npmjs
#   PODMAN_ARGS  extra words for `podman build` and the dev run — the two
#                that reach a registry — such as --add-host or --dns
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-localhost/daedalus:walk}"
PORT="${PORT:-3300}"
# shellcheck disable=SC2206 # word-split on purpose: it is a list of flags
PODMAN_ARGS=(${PODMAN_ARGS:-})
BUILD_REGISTRY=()
DEV_REGISTRY=()
if [ -n "${NPM_REGISTRY:-}" ]; then
  BUILD_REGISTRY=(--build-arg "NPM_REGISTRY=$NPM_REGISTRY")
  DEV_REGISTRY=(-e "NPM_REGISTRY=$NPM_REGISTRY")
fi

# One run's names, so two walks never share a container or a network.
RUN="walk-$$"
NET="$RUN-net"
PG="$RUN-pg"
APP="$RUN-app"
DEV="$RUN-dev"
DATABASE_URL="postgres://daedalus:walk@$PG:5432/daedalus"
WORK="$(mktemp -d)"

say() { printf '\n== %s\n' "$*"; }
fail() { printf 'image-walk: %s\n' "$*" >&2; exit 1; }

cleanup() {
  podman rm -f -t 2 "$APP" "$DEV" "$PG" >/dev/null 2>&1 || true
  podman network rm -f "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# Polls a URL until it answers 200, printing the container's log if it never does.
wait_for() {
  local url="$1" container="$2" tries="$3"
  for ((i = 0; i < tries; i++)); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "$url")" = "200" ]; then return 0; fi
    if [ -z "$(podman ps -q -f "name=^$container$")" ]; then
      podman logs "$container" 2>&1 | tail -40
      fail "$container exited"
    fi
    sleep 1
  done
  podman logs "$container" 2>&1 | tail -40
  fail "$url never answered 200"
}

# --- 1. build ----------------------------------------------------------------
say "building $IMAGE"
podman build "${PODMAN_ARGS[@]}" "${BUILD_REGISTRY[@]}" -t "$IMAGE" .

say "the image's sops"
podman run --rm --name "$RUN-sops" --entrypoint sops "$IMAGE" --version --disable-version-check \
  | grep '^sops ' || fail "/usr/local/bin/sops does not run"

# --- 2. production -----------------------------------------------------------
say "postgres"
podman network create "$NET" >/dev/null
podman run -d --name "$PG" --network "$NET" \
  -e POSTGRES_USER=daedalus -e POSTGRES_PASSWORD=walk -e POSTGRES_DB=daedalus \
  docker.io/library/postgres:16-alpine >/dev/null
for ((i = 0; i < 30; i++)); do
  podman exec "$PG" pg_isready -U daedalus -q && break
  sleep 1
done

# /apps is the one page with a hard requirement on the host: its loader wants
# the nix manifest and the app registry. Two empty ones give it its empty state.
mkdir -p "$WORK/host"
echo '{"schemaVersion":1,"nixManaged":{},"operatorSecretApps":[]}' >"$WORK/host/manifest.json"
echo '{"schemaVersion":2,"apps":{}}' >"$WORK/host/registry.json"

say "the built server"
podman run -d --init --name "$APP" --network "$NET" -p "127.0.0.1:$PORT:3000" \
  -e DATABASE_URL="$DATABASE_URL" \
  -e BASE_DOMAIN=example.test -e GITHUB_OWNER=example-owner \
  -e REGISTRY_HOST=registry.example.test -e GRAFANA_URL=https://grafana.example.test \
  -e NIX_MANIFEST_PATH=/host/manifest.json -e NIX_REGISTRY_PATH=/host/registry.json \
  -v "$WORK/host:/host:ro" \
  "$IMAGE" >/dev/null
wait_for "http://127.0.0.1:$PORT/api/healthz" "$APP" 30
podman logs "$APP" 2>&1 | grep '^\[daedalus\] serving'

say "the browser walk"
# shot prints the run directory last; the driver's exit code is its own verdict.
walk=0
shot run scripts/image-walk.mjs image-walk -- "http://127.0.0.1:$PORT" | tee "$WORK/shot.log" || walk=$?
run_dir="$(sed -n 's/^→ //p' "$WORK/shot.log" | tail -1)"
[ -d "$run_dir" ] || fail "shot left no run directory"
[ "$walk" = 0 ] || fail "the driver failed — see $run_dir"

# The recording outranks the pictures: a page can render over a broken deploy.
# The wire is judged same-origin only: the page embeds the GRAFANA_URL it was
# given, and a host that does not resolve is this walk's doing, not the image's.
echo "events: $(jq -c .counts "$run_dir/summary.json")"
errors="$(jq --arg origin "http://127.0.0.1:$PORT/" '[.[] | select(
  (.kind == "console" and .type == "error") or .kind == "pageerror"
  or ((.kind == "requestfailed" or (.kind == "http" and .status >= 500)) and (.url | startswith($origin)))
)]' "$run_dir/events.json")"
if [ "$(jq length <<<"$errors")" != 0 ]; then
  jq . <<<"$errors"
  fail "the browser recorded errors — $run_dir/events.json"
fi
podman rm -f -t 2 "$APP" >/dev/null

# --- 3. dev ------------------------------------------------------------------
say "the dev branch, over a copy of app/"
# The same tree the build got: the working tree minus what .dockerignore drops.
mkdir -p "$WORK/app"
tar -C app --exclude-from=<(sed -n 's|^app/||p' .dockerignore) -cf - . | tar -C "$WORK/app" -xf -
# --user 0:0: under rootless podman container root IS this user, the owner of
# the copy; the image's `node` (uid 1000) owns nothing in it.
podman run -d --init --name "$DEV" --user 0:0 --network "$NET" -p "127.0.0.1:$PORT:3000" \
  "${PODMAN_ARGS[@]}" "${DEV_REGISTRY[@]}" \
  -e DAEDALUS_DEV=1 -e DATABASE_URL="$DATABASE_URL" \
  -v "$WORK/app:/app" \
  "$IMAGE" >/dev/null
# A cold install through the registry, then Vite's first compile.
wait_for "http://127.0.0.1:$PORT/api/healthz" "$DEV" 600
# Vite's own client module is what the built server would 404.
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/@vite/client")" = 200 ] \
  || fail "DAEDALUS_DEV=1 did not serve through Vite"
echo "vite serves /api/healthz and /@vite/client"

say "ok — $run_dir"
