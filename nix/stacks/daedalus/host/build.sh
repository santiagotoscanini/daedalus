# Build one app's image on daedalus's behalf: fetch the requested commit, work
# out what the app is, run its checks, build and push it with the box's
# rootless BuildKit, and start its deploy.
#
# ONE script in eight files. build-agent.nix concatenates, in order: the
# variables nix hands it, host/lib.sh, host/github-lib.sh, then
#
#   host/build.sh              this file: the trust model and the settings
#   host/build/helpers.sh      the machinery every stage uses
#   host/build/0-request.sh    validate the request, start the log
#   host/build/1-token.sh      a read-only token for this one repository
#   host/build/2-clone.sh      fetch the commit, pick the strategy
#   host/build/3-detect.sh     `railpack prepare` → the build plan
#   host/build/4-checks.sh     the repository's own checks, in BuildKit
#   host/build/5-publish.sh    build the image and push it
#   host/build/6-done.sh       start the deploy, publish the final status
#
# The variables (build-agent.nix's legend says what each is for): APPLY_DIR,
# BUILDABLE, DEPLOYABLE, OWNER, OWNER_ID, CLIENT_ID, PEM, REGISTRY,
# NPM_MIRROR_HOST, LAN_IP, NODE_IMAGE, BUILDKIT_ADDR, RAILPACK_FRONTEND,
# DOCKER_CONFIG_DIR, BUILD_ROOT, WORK_ROOT, MISE_CACHE_DIR, MISE_MOUNT,
# MISE_PATH, MISE_BINARY, LOG_DIR, BUILD_USER, BUILD_GROUP, BUILD_PATH,
# CHECKS_DOCKERFILE, FENCE_CHECK, OPERATOR_USER, OPERATOR_GROUP, SETPRIV.
#
# ── the bridge ────────────────────────────────────────────────────────────
#
#   $APPLY_DIR/build-request.json  written by the engine (app/src/lib/builds.ts
#                                  buildRequestDecoder), plus the host-side
#                                  `buildEnv` field described below
#   $APPLY_DIR/build-status.json   written here (buildStatusDecoder), rewritten
#                                  at least every $HEARTBEAT_SECS while running:
#                                  the engine presumes a status older than 90 s
#                                  dead (BUILD_STATUS_MAX_AGE_MS)
#   $LOG_DIR/<id>.log              root 0644, redacted as it is written, capped
#                                  at 20 MiB; the container reads it at /builds
#
# `buildEnv` — { placeholders: { NAME: value }, railpack: { RAILPACK_X: value } }
# — carries the app's build-time placeholder values and Railpack knobs. Dummy
# values, never real secrets, but handled as if they were: they reach Railpack
# through its process environment and BuildKit through secret files, never an
# argument, a log line or the status. Optional; absent means none.
#
# ── who does what ─────────────────────────────────────────────────────────
#
# Root orchestrates and holds the App's key. Everything that touches repository
# content runs as $BUILD_USER through setpriv, with an environment rebuilt from
# nothing (build_env): its own HOME inside the work dir, no git config at all,
# no credential helper, no trace variables. The repository is hostile input —
# a `package.json` can be a symlink to /etc/shadow — so root never opens a
# file in the work dir by name: it reads them through the build user with
# O_NOFOLLOW, the rule host/lib.sh states for the apply dir.
#
# Root's own scratch lives in $CTL, a directory under the unit's private /tmp
# that only root can write: the stripped Railpack plan, the checks plan, the
# secret files and the clone token (group-readable by the build user, which
# must hand them to git and buildctl), and the status bookkeeping in $P (0700).
#
# ── the registry credential ───────────────────────────────────────────────
#
# The zot push credential can overwrite any app's :latest — live two minutes
# later — and repository code DOES run as the build user: `railpack prepare`
# evaluates the repo's own mise config (spike B12). So builder.nix renders it
# root 0400, and the build user holds a copy for exactly one process, the
# buildctl call that publishes: reap_build_processes first kills anything the
# earlier stages left behind, root copies the file (never through a link)
# into $CTL/docker — dir 0700, file 0400, the build user's — and deletes it
# the moment that buildctl exits, and again in on_exit. Every other build-user
# process (the builder probe, the clone, detection, both checks solves) runs
# with DOCKER_CONFIG at the empty $CTL/docker-none: checks and cache imports
# are anonymous reads from zot, and a ~/.docker/config.json a repository
# planted in the work dir is never consulted. During the publishing call the
# repository's code runs only inside BuildKit steps, as `buildkit`, which the
# credential never reaches (it travels to the daemon over the session). Repo
# code never runs as the build user while the credential exists.
#
# ── limits checked late ───────────────────────────────────────────────────
#
# The 2 GiB clone cap is measured after the fetch completes: until then the
# fetch is bounded only by $CLONE_LIMIT and the builder dataset's quota.
#
# ── exit status ───────────────────────────────────────────────────────────
#
#   0  a status was published: succeeded, superseded, or failed for a reason
#      that is the request's or the repository's (bad field, checks failed,
#      GitHub said no). The build page says why; nothing to mail.
#   1  the agent could not do its job: a request it cannot even answer (a
#      symlink, no id), its key missing, or a line nobody tested. monitoredJobs
#      mails it, and a failed status is published whenever there is an id.

set -euo pipefail

REQ="$APPLY_DIR/build-request.json"
STATUS="$APPLY_DIR/build-status.json"

# Where a build installs its packages from. With a mirror the box publishes
# (fleet.builder.npmMirrorHost), its name is pinned to the LAN address inside
# BuildKit — the box's own resolver is not reachable from there — and without
# one, npmjs directly and nothing to pin.
if [ -n "$NPM_MIRROR_HOST" ]; then
  NPM_REGISTRY_URL="https://$NPM_MIRROR_HOST/"
  NPM_MIRROR_ARGS=(--opt "add-hosts=$NPM_MIRROR_HOST=$LAN_IP")
else
  NPM_REGISTRY_URL="https://registry.npmjs.org/"
  NPM_MIRROR_ARGS=()
fi

MAX_REQUEST_BYTES=65536
MAX_CLONE_BYTES=$((2 * 1024 * 1024 * 1024))
MAX_LOG_BYTES=$((20 * 1024 * 1024))
# The status is re-read by the engine every few seconds; Railpack's two files
# are usually ~20 KiB and can grow with a big plan.
MAX_DETECTED_BYTES=$((256 * 1024))
# The facts read out of the clone and out of the pushed manifest (`repo`,
# `image`): small by construction rather than trimmed after the fact like
# `detected`, so these are the caps the extraction applies as it builds each
# list. The engine's warning engine reads shapes and names, never contents —
# a repository with four thousand dependencies has said everything it has to
# say by the 250th.
MAX_REPO_SCRIPTS=40
MAX_REPO_SCRIPT_CHARS=200
MAX_REPO_DEPS=250
MAX_REPO_PM_CHARS=120
MAX_IMAGE_TAGS=20
MAX_IMAGE_LAYERS=60
HEARTBEAT_SECS=20

# Per stage. Build and publish are ONE buildctl call (the push is its export),
# so `timeout` bounds the sum and the heartbeat's watchdog enforces the split:
# it sees the push start in the progress output.
CLONE_LIMIT=5m
DETECT_LIMIT=3m
CHECKS_LIMIT=30m
BUILD_SECS=1800
PUBLISH_SECS=900

# ── the build env rules ───────────────────────────────────────────────────
#
# The same two rules as the engine's (app/src/lib/builds.ts), refused here on
# their own because the container can write a request without the engine: a
# request this host accepts is exactly one the engine's decoder accepts.
# builds.test.ts reads both assignments out of this file when it can see it
# (DAEDALUS_HOST_BUILD_SH) and fails on any difference, so each stays one
# `NAME='…'` assignment and changes together with the engine.
#
# RESERVED_ENV_RE — names a placeholder may not take: they steer the tools
# that see placeholders (Railpack, its mise, git, buildctl, the shell, the C
# library, and in the build steps the toolchains and package managers) rather
# than the app. Exact names, then prefixes; builds.ts says why each is there.
# A denylist, not an allowlist, and knowingly so: placeholder names are the
# app's own env names (DATABASE_URL, MAPBOX_ACCESS_TOKEN, GOOGLE_MAPS_API_KEY
# …), and no allow pattern admits those while shutting out tool knobs — which
# is also why Go's variables are listed by name, not as a GO prefix.
RESERVED_ENV_RE='^(PATH|HOME|SHELL|USER|LOGNAME|PWD|OLDPWD|IFS|ENV|BASH|BASH_ENV|BASHOPTS|SHELLOPTS|CDPATH|GLOBIGNORE|PS4|PROMPT_COMMAND|UID|EUID|PPID|SHLVL|TMPDIR|TZ|LANG|LANGUAGE|TERM|HOSTNAME|GCONV_PATH|GLIBC_TUNABLES|LOCPATH|GITHUB_TOKEN|DAEDALUS_TOKEN_FILE|NO_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|FTP_PROXY|GODEBUG|GOFLAGS|GOTRACEBACK|GOENV|GOROOT|GOPATH|GOBIN|GOCACHE|GOCACHEPROG|GOMODCACHE|GOTMPDIR|GOWORK|GOPROXY|GONOPROXY|GOPRIVATE|GOSUMDB|GONOSUMDB|GONOSUMCHECK|GOINSECURE|GOVCS|GOAUTH|GOTOOLCHAIN|GOEXPERIMENT|GO111MODULE|RUSTDOC|RUSTFLAGS|RUSTDOCFLAGS|RUBYOPT|RUBYLIB|GEM_PATH|GEM_HOME|PERLLIB|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS)$|^(LD_|BASH_FUNC_|GIT_|BUILDKIT_|BUILDCTL_|DOCKER_|MISE_|RAILPACK_|XDG_|LC_|SSL_|NIX_SSL_|CURL_|SYSTEMD_|NPM_CONFIG_|PNPM_|COREPACK_|YARN_|BUN_|NODE_|CGO_|PIP_|UV_|PYTHON|CARGO_|RUSTUP_|RUSTC|BUNDLE_|PERL5)'
#
# RAILPACK_KNOBS — the Railpack switches passed on, and the pattern each value
# must match. Nothing else under RAILPACK_ reaches Railpack: every *_CMD, the
# config file and the package list change what runs, and belong in the repo's
# railpack.json. The patterns run in jq's Oniguruma here and as JavaScript
# RegExps in the engine, so they keep to what both read alike (ASCII classes,
# lookahead only, no flags) and only ever see single-line values.
RAILPACK_KNOBS='{
  "RAILPACK_PRUNE_DEPS": "^(?:true|false|1|0)$",
  "RAILPACK_NODE_PLAYWRIGHT_INSTALL": "^(?:true|false|1|0)$",
  "RAILPACK_NO_SPA": "^(?:true|false|1|0)$",
  "RAILPACK_DISABLE_CACHES": "^(?:\\*|[A-Za-z0-9_.:-]+(?: [A-Za-z0-9_.:-]+)*)$",
  "RAILPACK_SPA_OUTPUT_DIR": "^(?!/)(?!(?:.*/)?\\.\\.(?:/|$))[A-Za-z0-9._/-]{1,200}$",
  "RAILPACK_NODE_VERSION": "^[0-9]{1,3}(?:\\.[0-9]{1,4}){0,2}$",
  "RAILPACK_BUILD_APT_PACKAGES": "^[a-z0-9][a-z0-9+.-]*(?:=[A-Za-z0-9.+~:-]+)?(?: [a-z0-9][a-z0-9+.-]*(?:=[A-Za-z0-9.+~:-]+)?)*$",
  "RAILPACK_DEPLOY_APT_PACKAGES": "^[a-z0-9][a-z0-9+.-]*(?:=[A-Za-z0-9.+~:-]+)?(?: [a-z0-9][a-z0-9+.-]*(?:=[A-Za-z0-9.+~:-]+)?)*$"
}'

LOGGER_PID=""
HB_PID=""
CTL=""
P=""
WORK=""
SRC=""
TOKEN_LIVE=0
STATUS_READY=0
INTERRUPTED=0

BUILD_PRIV=("$SETPRIV" --reuid="$BUILD_USER" --regid="$BUILD_GROUP" --init-groups --inh-caps=-all)
TIMEOUT_BIN="$(command -v timeout)"
