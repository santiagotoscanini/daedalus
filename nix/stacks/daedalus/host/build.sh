# Build one app's image on daedalus's behalf: fetch the requested commit, work
# out what the app is, run its checks, build and push it with the box's
# rootless BuildKit, and start its deploy.
#
# Inlined by build-agent.nix's writeShellApplication wrapper after host/lib.sh
# and host/github-lib.sh. The wrapper sets: APPLY_DIR, BUILDABLE, DEPLOYABLE,
# OWNER, OWNER_ID, CLIENT_ID, PEM, REGISTRY, NPM_MIRROR_HOST, LAN_IP,
# NODE_IMAGE, BUILDKIT_ADDR, RAILPACK_FRONTEND, DOCKER_CONFIG_DIR, BUILD_ROOT,
# WORK_ROOT, MISE_CACHE_DIR, MISE_MOUNT, MISE_PATH, MISE_BINARY, LOG_DIR,
# BUILD_USER, BUILD_GROUP, BUILD_PATH, CHECKS_DOCKERFILE, FENCE_CHECK,
# OPERATOR_USER, OPERATOR_GROUP, SETPRIV.
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

now_iso() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
now_ms() { date +%s%3N; }

# Is word $1 one of the space-separated words in $2?
in_list() {
  tr ' ' '\n' <<<"$2" | grep -Fxq -- "$1"
}

# ── the log ───────────────────────────────────────────────────────────────

# stdin → stdout with credentials cut out, one line at a time and flushed, so
# the build page's live tail sees each line as it happens. The same patterns
# as the engine's second layer (redactBuildLog in app/src/lib/builds.ts),
# applied here first because the log file is the one copy on disk. Terminal
# escapes go first: a colour code inside a token would end the match early.
redact() {
  awk '
    BEGIN {
      R = "[redacted]"
      KEY_BEGIN = "-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----"
      KEY_END = "-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----"
    }
    {
      line = $0
      gsub(/\033\[[0-9;?]*[A-Za-z]/, "", line)
      gsub(/\r/, "", line)
      if (inkey) {
        if (line !~ KEY_END) next
        sub("^.*" KEY_END, R, line)
        inkey = 0
      }
      if (line ~ KEY_BEGIN) {
        if (line ~ (KEY_BEGIN ".*" KEY_END)) gsub(KEY_BEGIN ".*" KEY_END, R, line)
        else { sub(KEY_BEGIN ".*$", R, line); inkey = 1 }
      }
      line = gensub(/github_pat_[A-Za-z0-9_]+/, R, "g", line)
      line = gensub(/gh[opusr]_[A-Za-z0-9_]{20,}/, R, "g", line)
      line = gensub(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/, R, "g", line)
      line = gensub(/x-access-token:[^@[:space:]]+/, "x-access-token:" R, "g", line)
      line = gensub(/("auth"[[:space:]]*:[[:space:]]*")[A-Za-z0-9+\/=]+"/, "\\1" R "\"", "g", line)
      IGNORECASE = 1
      line = gensub(/x-access-token%3A[^@%[:space:]]+/, "x-access-token%3A" R, "g", line)
      line = gensub(/([a-z][a-z0-9+.-]*:\/\/[^[:space:]:@\/]*:)[^[:space:]\/]+@/, "\\1" R "@", "g", line)
      line = gensub(/(authorization\\?["\047]?[[:space:]]*[:=][[:space:]]*(\\?["\047])?(basic|bearer|token)[[:space:]]+)[^[:space:]"\047\\,;]+/, "\\1" R, "g", line)
      line = gensub(/(_authtoken[[:space:]]*=[[:space:]]*["\047]?)[^[:space:]"\047]+/, "\\1" R, "g", line)
      IGNORECASE = 0
      print line
      fflush()
    }'
}

# A compact JSON object on stdin, redacted, compact again — the one path by
# which repository and registry facts reach the status. `redact` is a line
# filter with deliberately greedy patterns, and a whole object on a single
# line lets one URL credential swallow every brace after it; pretty-printing
# first puts every string on a line of its own and bounds each match to it.
# A redaction that broke the JSON anyway leaves the last jq to fail, and the
# caller then publishes nothing rather than half an object.
redact_json() {
  jq . | redact | jq -c .
}

# stdin → log file $1, at most MAX_LOG_BYTES, then DRAINED rather than closed:
# the writer is buildctl, and a sink that stops reading would SIGPIPE the
# build.
cap_log() {
  local dropped
  # stdbuf: GNU head writes through stdio, and on ZFS a fresh file reports
  # st_blksize 128 KiB, so the log stayed EMPTY until the stream closed —
  # a typical build log is ~10 KB, which meant the live log on the build
  # page showed nothing for the whole build. `redact` (awk) already
  # flushes per line; this is the last buffer in the chain.
  stdbuf -o0 head -c "$MAX_LOG_BYTES" >>"$1"
  dropped="$(wc -c)"
  if [ "$dropped" -gt 0 ]; then
    printf '\n[log capped at %s bytes: %s more bytes dropped]\n' "$MAX_LOG_BYTES" "$dropped" >>"$1"
  fi
}

# From here on everything the script and its commands print goes through
# redact into $LOG. fd 7/8 keep the unit's journal for the lines `say` copies
# there. $LOG_DIR is root's alone (0755), so root writes the file by name.
start_log() {
  LOG="$LOG_DIR/$BUILD_ID.log"
  if [ ! -d "$LOG_DIR" ] || [ -L "$LOG_DIR" ]; then
    echo "the build log directory $LOG_DIR is missing" >&2
    exit 1
  fi
  rm -f -- "$LOG"
  (umask 022 && : >"$LOG")
  chmod 0644 "$LOG"
  exec 7>&1 8>&2
  exec > >(redact | cap_log "$LOG") 2>&1
  LOGGER_PID=$!
}

# One line into the log and, once the log exists, the journal too.
say() {
  printf '%s\n' "$*"
  if [ -n "$LOGGER_PID" ]; then
    printf '%s\n' "$*" >&7
  fi
}

# ── running things as the build user ─────────────────────────────────────

# [subshell only] Replace the whole environment with what a build-user process
# may see. Unset first, so nothing root's unit carried (a GIT_TRACE*, a proxy,
# a credential variable) rides along. With $1 = with-env, also the request's
# buildEnv: names and values from $P/build-env, exported by a builtin — the
# values never become an argument of any process.
build_env() {
  local v name
  # NOT `compgen -e`: the non-interactive bash this runs under is built
  # without programmable completion, so compgen did not exist and this wipe
  # silently did nothing (step 6 drill; an interactive shell has compgen,
  # which is why the spikes never saw it). /proc/self/environ is a
  # NUL-separated snapshot of exactly what this process inherited.
  while IFS= read -r -d '' v; do
    case "$v" in
    *=*) unset "${v%%=*}" 2>/dev/null || true ;;
    esac
  done </proc/self/environ
  export PATH="$BUILD_PATH" HOME="${WORK:-/var/empty}/home" LANG=C.UTF-8 TZ=UTC TMPDIR=/tmp
  export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=https
  export GIT_ASKPASS="$CTL/git/askpass" DAEDALUS_TOKEN_FILE="$CTL/git/token"
  # The registry push credential exists for one process only (header): mode
  # push, the publishing buildctl call. Everything else sees an empty config
  # dir, so no credential and no planted ~/.docker/config.json is ever read.
  if [ "${1-}" = push ]; then
    export DOCKER_CONFIG="$CTL/docker"
  else
    export DOCKER_CONFIG="$CTL/docker-none"
  fi
  if [ "${1-}" = with-env ] && [ -f "$P/build-env" ]; then
    while IFS= read -r v; do
      name="${v%%=*}"
      export "$name=${v#*=}"
    done <"$P/build-env"
  fi
}

# Run "$@" as the build user; output wherever the caller points it.
as_build() {
  (
    build_env
    exec "${BUILD_PRIV[@]}" "$@"
  )
}

# Stdin copy of what the log sees, kept small: the lines a failure message is
# built from ($P/scan), the vertex verdicts the build facts are counted from
# ($P/vertices), and a marker the moment BuildKit starts exporting —
# that is the build → publish boundary the heartbeat's watchdog keys on.
scan_output() {
  awk -v scan="$P/scan" -v pushing="$P/pushing" -v vertices="$P/vertices" '
    { print; fflush() }
    /check failed: |check: | ERROR|^error: |fatal: |[Rr]ate[ -]?limit|403/ { print > scan; fflush(scan) }
    # One line per vertex event, for the cache and step facts read out after
    # the publishing solve (build_facts). Only the lines that carry a
    # verdict, so a big export cannot fill /tmp with `writing layer` chatter.
    # Truncated per call by timed_as_build: the checks solve numbers its
    # vertices from #1 too, and its step counts belong to nobody but itself.
    /^#[0-9]+ (DONE|CACHED|ERROR|importing cache manifest|exporting cache)/ { print > vertices; fflush(vertices) }
    !m && /exporting to image|pushing layers/ { printf "" > pushing; close(pushing); m = 1 }
  '
}

# Run "$@" as the build user under `timeout $1`, output into the log through
# scan_output; $2 = plain | with-env (see build_env). Returns the command's
# status. The subshell records its pid before exec'ing timeout, so the
# heartbeat's watchdog can signal the stage; timeout passes SIGTERM on to
# buildctl, which cancels the solve (spike B4).
timed_as_build() {
  local limit="$1" mode="$2"
  shift 2
  local -a argv=("$TIMEOUT_BIN" -k 30s "$limit" "${BUILD_PRIV[@]}" "$@")
  : >"$P/scan"
  : >"$P/vertices"
  if (
    printf '%s\n' "$BASHPID" >"$P/active.pid"
    build_env "$mode"
    exec "${argv[@]}"
  ) 2>&1 | scan_output; then
    rm -f -- "$P/active.pid"
    return 0
  fi
  local rc="${PIPESTATUS[0]}"
  rm -f -- "$P/active.pid"
  return "$rc"
}

# A file from the work dir into root's $2: read as the build user, never
# through a link, never blocking on a FIFO, at most 16 MiB; 0 only for a JSON
# object.
read_work_json() {
  as_build dd if="$1" iflag=nofollow,nonblock bs=1048576 count=16 status=none >"$2" 2>/dev/null &&
    jq -e 'type == "object"' "$2" >/dev/null 2>&1
}

# Kill anything the build user still runs inside this unit. Railpack's mise
# reads the repository's own mise config (spike B12); nothing it starts may
# outlive the stage that started it and sit beside the registry credential.
# Skipped when the agent itself runs as the build user (the test harness).
reap_build_processes() {
  local cg pid uid
  uid="$(id -u "$BUILD_USER" 2>/dev/null)" || return 0
  [ "$uid" != "$(id -u)" ] || return 0
  cg="$(sed -n 's/^0:://p' /proc/self/cgroup)"
  [ -n "$cg" ] && [ -r "/sys/fs/cgroup$cg/cgroup.procs" ] || return 0
  while read -r pid; do
    if [ "$(stat -c %u "/proc/$pid" 2>/dev/null)" = "$uid" ]; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done <"/sys/fs/cgroup$cg/cgroup.procs"
}

# ── Railpack's mise cache, one per app ────────────────────────────────────
#
# `railpack prepare` keeps mise and what it resolves under a hard-coded
# $MISE_MOUNT (/tmp/railpack), and runs the repository's own mise config as the
# build user (spike B12), which can leave files there for a later prepare to
# run. So each app has its own cache, $MISE_CACHE_DIR/<app>, mounted at
# $MISE_MOUNT for that app's prepare alone:
#   - $MISE_CACHE_DIR is root 0700 (builder.nix): the build user reaches an
#     app's cache only through the mount, never by its path.
#   - $MISE_MOUNT is a root-owned directory in the unit's private /tmp, made
#     before any build-user process runs, so nobody swaps it for a link.
#   - The pinned mise goes read-only at $MISE_PATH, inside the app's tree,
#     which earlier builds of the same app could write: root clears any link
#     on that path while no build-user process is alive, checks the path
#     resolves to itself, and only then mounts.
#   - Both come down before the checks: nothing after prepare sees a cache.
# The mounts live in the unit's mount namespace (PrivateTmp) and end with it.
# Within one app the cache carries over, so a commit can still leave files for
# that app's next prepare — same repository, same trust.

MISE_MOUNTED=0

# [before any build-user process runs] The empty, root-owned mount point.
make_mise_mountpoint() {
  if [ -L "$MISE_MOUNT" ] || { [ -e "$MISE_MOUNT" ] && [ ! -d "$MISE_MOUNT" ]; }; then
    agent_fail "$MISE_MOUNT is not a directory; refusing to mount a mise cache there"
  fi
  [ -d "$MISE_MOUNT" ] || install -d -m 0755 "$MISE_MOUNT"
  if [ "$(stat -c %u "$MISE_MOUNT")" != 0 ]; then
    agent_fail "$MISE_MOUNT is not root's; refusing to mount a mise cache there"
  fi
}

mount_mise_cache() {
  local cache="$MISE_CACHE_DIR/$APP" bindir="${MISE_PATH%/*}"
  if [ -L "$MISE_CACHE_DIR" ] || [ ! -d "$MISE_CACHE_DIR" ] || [ "$(stat -c '%u %a' "$MISE_CACHE_DIR")" != "0 700" ]; then
    agent_fail "the mise cache root $MISE_CACHE_DIR must be a root-owned 0700 directory (daedalus-builds-layout): otherwise one app's prepare could reach another app's cache"
  fi
  if [ -L "$cache" ] || { [ -e "$cache" ] && [ ! -d "$cache" ]; }; then
    agent_fail "$cache is not a directory"
  fi
  install -d -m 0700 -o "$BUILD_USER" -g "$BUILD_GROUP" "$cache"
  reap_build_processes
  mount --bind "$cache" "$MISE_MOUNT" || agent_fail "could not mount $APP's mise cache at $MISE_MOUNT"
  MISE_MOUNTED=1
  if [ -L "$bindir" ] || { [ -e "$bindir" ] && [ ! -d "$bindir" ]; }; then
    rm -rf -- "$bindir"
  fi
  [ -d "$bindir" ] || install -d -m 0700 -o "$BUILD_USER" -g "$BUILD_GROUP" "$bindir"
  if [ -L "$MISE_PATH" ] || { [ -e "$MISE_PATH" ] && [ ! -f "$MISE_PATH" ]; }; then
    rm -rf -- "$MISE_PATH"
  fi
  [ -e "$MISE_PATH" ] || : >"$MISE_PATH"
  if [ "$(realpath -e -- "$MISE_PATH" 2>/dev/null)" != "$MISE_PATH" ]; then
    agent_fail "$MISE_PATH does not resolve to itself; refusing to mount mise there"
  fi
  mount --bind -o ro "$MISE_BINARY" "$MISE_PATH" || agent_fail "could not mount the pinned mise at $MISE_PATH"
  say "mise cache: $cache (at $MISE_MOUNT)"
}

# Returns non-zero when the cache could not be taken down.
unmount_mise_cache() {
  [ "$MISE_MOUNTED" = 1 ] || return 0
  reap_build_processes
  umount -R "$MISE_MOUNT" || return 1
  MISE_MOUNTED=0
}

# ── the status ────────────────────────────────────────────────────────────
#
# $P/status.json is the truth; every change rewrites it under $P/lock and
# publishes it whole. The heartbeat is a background subshell, so it cannot see
# this shell's variables — it re-reads the file, which is why the state lives
# there and not in variables. The lock also orders the two writers: a
# heartbeat killed mid-publish still holds the lock through its children, so
# a terminal status published after it is never overwritten by it.

with_lock() {
  {
    flock 9
    "$@"
  } 9>"$P/lock"
}

# How long the EXIT path waits for that lock before writing anyway.
LOCK_WAIT_EXIT=15

# The same lock, bounded, for the one caller that must never block: on_exit.
#
# `flock` is per open-file-description, so a second `9>"$P/lock"` from this
# same shell contends with the first. That makes the plain form re-entrant-
# unsafe, and the exit trap is exactly where re-entry happens: a SIGTERM that
# lands while the script is inside `enter`/`status_set` runs on_exit from
# within the lock, which then waits for itself. Forever. systemd SIGKILLs the
# unit at TimeoutStopSec, reports `timeout` instead of the requested stop, and
# mails the operator about a build that was fine — and the terminal status this
# call was publishing is lost, so the engine has to guess `interrupted` from a
# stale heartbeat. (Seen live: a superseded plutus build, 90 s of stop-sigterm
# and one mail.)
#
# Writing without the lock is safe here in a way it would not be mid-run: the
# heartbeat is already stopped by the time on_exit reaches this, so nothing
# that could still hold the lock is going to publish a competing status. The
# worst case is a dying tick's write landing last, which is the same degraded
# outcome as being killed — and the common case goes from "mail" to "correct".
with_lock_exit() {
  {
    flock -w "$LOCK_WAIT_EXIT" 9 ||
      say "status lock still held after ${LOCK_WAIT_EXIT}s; publishing the final status anyway"
    "$@"
  } 9>"$P/lock"
}

# [locked] Apply jq filter $1 to the status (jq options after it, placed before
# the filter), stamp updatedAt, publish.
_status_apply() {
  local filter="$1"
  shift
  jq "$@" --arg updatedAt "$(now_iso)" "($filter) | .updatedAt = \$updatedAt" "$P/status.json" >"$P/status.next"
  mv -f -- "$P/status.next" "$P/status.json"
  write_json_atomic "$STATUS" <"$P/status.json"
}

# [locked] Close the running state's clock into `timings` (milliseconds per
# state, summed), then move to state $1 with phase $2 and apply filter $3 (jq
# options after it).
_advance() {
  local state="$1" phase="$2" filter="$3" now t0
  shift 3
  now="$(now_ms)"
  t0="$(cat "$P/t0" 2>/dev/null || printf '%s' "$now")"
  _status_apply '
    (.state as $prev
     | if ($prev | IN("cloning", "detecting", "checking", "building", "publishing"))
       then .timings[$prev] = ((.timings[$prev] // 0) + ($now - $t0)) else . end)
    | .state = $state | .phase = $phase | ('"$filter"')' \
    --arg state "$state" --arg phase "$phase" --argjson now "$now" --argjson t0 "$t0" "$@"
  printf '%s' "$now" >"$P/t0"
}

# [locked] The terminal status: _advance, plus `error` ($3, "" for none), plus
# the marker that stops a late heartbeat from touching it again.
_finish() {
  local state="$1" phase="$2" error="$3" filter="$4"
  shift 4
  _advance "$state" "$phase" '(if $error == "" then .error = null else .error = $error end) | ('"$filter"')' \
    --arg error "$error" "$@"
  : >"$P/final"
}

status_set() { with_lock _status_apply "$@"; }
enter() { with_lock _advance "$1" "$2" "${3:-.}" "${@:4}"; }

current_state() { jq -r '.state' "$P/status.json"; }

# One line of text for the status's `error`: redacted, capped.
clean_text() {
  printf '%s' "$1" | redact | tr '\n' ' ' | head -c 1500 | sed -e 's/[[:space:]]*$//'
}

# Publish a terminal status ($1 state, $2 phase, $3 error, $4 jq filter, jq
# options after it) and stop the heartbeat first.
finish() {
  local state="$1" phase="$2" error
  error="$(clean_text "$3")"
  stop_heartbeat
  with_lock _finish "$state" "$phase" "$error" "${4:-.}" "${@:5}"
}

# The build failed for a reason that is the request's or the repository's:
# published as `failed` in the stage it reached, exit 0.
fail() {
  local state
  state="$(current_state)"
  say "failed in $state: $1"
  finish failed "$state" "$1"
  exit 0
}

# The agent itself could not work: published, then exit 1 so it is mailed.
agent_fail() {
  local state
  state="$(current_state)"
  say "agent failure in $state: $1"
  finish failed "$state" "$1"
  exit 1
}

# [locked] One heartbeat: flip building → publishing when the push started,
# fire the watchdog when the stage's deadline passed, restamp and publish.
_tick() {
  [ ! -e "$P/final" ] || return 0
  local deadline stage pid
  if [ -e "$P/pushing" ] && [ "$(current_state)" = building ]; then
    _advance publishing "pushing the image to $REGISTRY" '.'
    printf '%s publishing\n' "$(($(date +%s) + PUBLISH_SECS))" >"$P/deadline"
  fi
  if [ -s "$P/deadline" ] && [ -s "$P/active.pid" ]; then
    read -r deadline stage <"$P/deadline"
    if [ "$(date +%s)" -ge "$deadline" ]; then
      read -r pid <"$P/active.pid"
      printf '%s\n' "$stage" >"$P/timedout"
      : >"$P/deadline"
      echo "watchdog: $stage passed its limit; stopping buildctl" >&2
      kill -TERM "$pid" 2>/dev/null || true
    fi
  fi
  _status_apply '.'
}

heartbeat_loop() {
  while sleep "$HEARTBEAT_SECS"; do
    with_lock _tick || echo "heartbeat: could not refresh $STATUS" >&2
  done
}

start_heartbeat() {
  heartbeat_loop >&7 2>&8 &
  HB_PID=$!
}

stop_heartbeat() {
  if [ -n "$HB_PID" ]; then
    kill "$HB_PID" 2>/dev/null || true
    wait "$HB_PID" 2>/dev/null || true
    HB_PID=""
  fi
}

# [locked] Arm the watchdog: stage $2 must end within $1 seconds.
_set_deadline() {
  printf '%s %s\n' "$(($(date +%s) + $1))" "$2" >"$P/deadline"
}

# [locked] After a successful build call: a push the heartbeat did not see
# start still gets its own `publishing` state and timing.
_after_build() {
  : >"$P/deadline"
  if [ "$(current_state)" = building ]; then
    _advance publishing "pushing the image to $REGISTRY" '.'
  fi
}

# Why stage $1 failed with exit $2 (limit $3), from the scanned output.
stage_error() {
  local what="$1" rc="$2" limit="$3" hint
  if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
    printf '%s timed out after %s' "$what" "$limit"
    return
  fi
  hint="$({ grep -E 'check failed: | ERROR|^error: |fatal: ' "$P/scan" 2>/dev/null || true; } | tail -n 1 | cut -c1-300)"
  printf '%s failed (exit %s)%s' "$what" "$rc" "${hint:+: $hint}"
}

# ── exit ──────────────────────────────────────────────────────────────────

# Replaces the EXIT trap gh_init installed, and runs gh_cleanup itself.
on_exit() {
  local rc=$?
  set +e
  # The push credential never outlives the agent (header).
  if [ -n "$CTL" ]; then
    rm -rf -- "$CTL/docker"
  fi
  # Interrupted is read from the exit status, not only from the TERM trap's
  # flag: when the unit's SIGTERM reaches every process in the cgroup at once
  # (the logger, the stage's pipeline), bash was observed to arrive here with
  # rc 143 and the flag still unset (reproduced with a setsid process group in
  # the stub harness).
  case "$rc" in
  129 | 130 | 143) INTERRUPTED=1 ;;
  esac
  # That same SIGTERM killed the logger; writing into its dead pipe would
  # SIGPIPE this trap before the status is published.
  if [ "$INTERRUPTED" = 1 ] && [ -n "$LOGGER_PID" ]; then
    exec 1>&7 2>&8
  fi
  stop_heartbeat
  if [ "$STATUS_READY" = 1 ] && [ ! -e "$P/final" ]; then
    if [ "$INTERRUPTED" = 1 ]; then
      with_lock_exit _finish failed "$(current_state)" "interrupted" '.'
    else
      with_lock_exit _finish failed "$(current_state)" "the build agent stopped unexpectedly (exit $rc); see journalctl -u daedalus-build" '.'
      [ "$rc" -ne 0 ] || rc=1
    fi
  fi
  if [ "$TOKEN_LIVE" = 1 ]; then
    gh_revoke "$GH_TMP/token.json" || true
  fi
  reap_build_processes
  if [ "$MISE_MOUNTED" = 1 ]; then
    umount -R "$MISE_MOUNT" 2>/dev/null || true
  fi
  if [ -n "$WORK" ]; then
    as_build rm -rf -- "$WORK" || true
  fi
  if [ -n "$CTL" ]; then
    rm -rf -- "$CTL"
  fi
  gh_cleanup
  if [ -n "$LOGGER_PID" ]; then
    exec 1>&7 2>&8
    # A stopped unit's children are being killed too; waiting on the logger
    # could outlast systemd's patience, and the reaper writes the last word.
    if [ "$INTERRUPTED" != 1 ]; then
      wait "$LOGGER_PID" || true
    fi
  fi
  exit "$rc"
}

revoke_token() {
  [ "$TOKEN_LIVE" = 1 ] || return 0
  if gh_revoke "$GH_TMP/token.json"; then
    say "revoked the repository token"
  else
    say "could not revoke the repository token (${GH_ERROR:-HTTP $GH_STATUS}); it expires within the hour"
  fi
  TOKEN_LIVE=0
  rm -f -- "$CTL/git/token" "$GH_TMP/token.json" "$GH_TMP/repo.curlrc" "$GH_TMP/revoke.curlrc"
}

# ── 0. the request ────────────────────────────────────────────────────────

if [ -L "$REQ" ]; then
  echo "refusing $REQ: it is a symlink, and the bridge only accepts regular files" >&2
  exit 1
fi
[ -e "$REQ" ] || exit 0

# Read once, as the operator, never through a link (host/lib.sh).
REQ_JSON="$(read_request "$REQ" | head -c "$((MAX_REQUEST_BYTES + 1))")" || true
if [ -z "$REQ_JSON" ]; then
  echo "could not read $REQ as $OPERATOR_USER" >&2
  exit 1
fi
if [ "${#REQ_JSON}" -gt "$MAX_REQUEST_BYTES" ]; then
  echo "refusing $REQ: over $MAX_REQUEST_BYTES bytes" >&2
  exit 1
fi

# The id names the log file and is what the status answers; without a usable
# one there is nothing to answer, so this is the one refusal that only mails.
BUILD_ID="$(jq -r 'if type == "object" and (.id | type) == "string" then .id else "" end' <<<"$REQ_JSON" 2>/dev/null || true)"
if ! [[ "$BUILD_ID" =~ ^[0-9a-fA-F-]{1,64}$ ]]; then
  echo "refusing $REQ: it carries no usable build id" >&2
  exit 1
fi

# The path unit re-fires on a daemon-reload replay at boot, and the engine may
# rewrite the file it already dispatched: an answered id is never built again.
if [ "$(published_id "$STATUS")" = "$BUILD_ID" ]; then
  echo "build $BUILD_ID was already answered; not building it again"
  exit 0
fi

gh_init
trap on_exit EXIT
trap 'INTERRUPTED=1; exit 143' TERM INT HUP

CTL="$(mktemp -d /tmp/daedalus-build.XXXXXXXXXX)"
chmod 0755 "$CTL"
P="$CTL/private"
install -d -m 0700 "$P"
install -d -m 0755 "$CTL/plan" "$CTL/checks" "$CTL/docker-none"
install -d -m 0750 -g "$BUILD_GROUP" "$CTL/git" "$CTL/secrets"

# A string field of the request, or "" — for the status, before validation.
raw_field() {
  jq -r --arg k "$1" 'if (.[$k] | type) == "string" then .[$k] else "" end' <<<"$REQ_JSON" 2>/dev/null || true
}
APP="$(raw_field app)"
SHA="$(raw_field sha)"
STRATEGY="$(raw_field strategy)"
PUBLISH="$(raw_field publish)"
case "$STRATEGY" in
auto | railpack | dockerfile) STATUS_STRATEGY="$STRATEGY" ;;
*) STATUS_STRATEGY=auto ;;
esac

jq -n --arg id "$BUILD_ID" --arg app "${APP:0:128}" --arg sha "${SHA:0:64}" \
  --arg strategy "$STATUS_STRATEGY" --arg at "$(now_iso)" '{
    version: 1, id: $id, app: $app, sha: $sha,
    state: "cloning", phase: "validating the request", strategy: $strategy,
    tip: null, digest: null, imageRef: null, sizeBytes: null,
    pinned: false, candidate: false, detected: null, checks: null, error: null,
    timings: {}, updatedAt: $at
  }' >"$P/status.json"
now_ms >"$P/t0"
start_log
STATUS_READY=1
write_json_atomic "$STATUS" <"$P/status.json"
start_heartbeat

INVALID="$(jq -r '
  def str($k; $max): (.[$k] | type) == "string" and (.[$k] | length) <= $max;
  if type != "object" then "the request is not a JSON object"
  elif .version != 1 then "unsupported request version"
  elif (str("app"; 63) | not) then "app must be a string of at most 63 characters"
  elif (str("sha"; 40) | not) then "sha must be a string of 40 characters"
  elif (.repoId | type) != "number" then "repoId must be a number"
  elif (str("strategy"; 16) | not) then "strategy must be a string"
  elif (str("publish"; 16) | not) then "publish must be a string"
  elif ((.requestedBy // "") | type) != "string" or ((.requestedBy // "") | length) > 32 then "requestedBy must be a short string"
  elif ((.at // "") | type) != "string" or ((.at // "") | length) > 64 then "at must be a short string"
  else "" end' <<<"$REQ_JSON" 2>/dev/null || echo "the request is not valid JSON")"
[ -z "$INVALID" ] || fail "invalid build request: $INVALID"

REPO_ID="$(jq -r '.repoId | tostring' <<<"$REQ_JSON")"
REQUESTED_BY="$(raw_field requestedBy)"

[[ "$APP" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || fail "invalid build request: app is not an app name"
in_list "$APP" "$BUILDABLE" || fail "$APP is not a registry app this box builds (it is not in site/apps.json, or its source is not the registry)"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail "invalid build request: sha is not a 40-hex commit sha"
[[ "$REPO_ID" =~ ^[1-9][0-9]{0,15}$ ]] || fail "invalid build request: repoId is not a positive integer"
case "$STRATEGY" in
auto | railpack | dockerfile) ;;
*) fail "invalid build request: strategy must be auto, railpack or dockerfile" ;;
esac
case "$PUBLISH" in
live | candidate) ;;
*) fail "invalid build request: publish must be live or candidate" ;;
esac
[[ "$REQUESTED_BY" =~ ^[a-z]{0,16}$ ]] || REQUESTED_BY="?"

# The build env rules (RESERVED_ENV_RE, RAILPACK_KNOBS above). The name
# pattern ends in \z, not $: Oniguruma's $ also matches before a final
# newline, and "NAME\n" would pass as a name the engine refuses.
INVALID="$(jq -r --arg reserved "$RESERVED_ENV_RE" --argjson knobs "$RAILPACK_KNOBS" '
  (.buildEnv // {}) as $b
  | if ($b | type) != "object" then "buildEnv must be an object"
    else ($b.placeholders // {}) as $ph | ($b.railpack // {}) as $rp
    | def bad_value: (type != "string") or length > 512 or (explode | any(. == 0 or . == 10 or . == 13));
      def bad_placeholder: (test("^[A-Z_][A-Z0-9_]{0,63}\\z") | not) or test($reserved);
      def unknown_knob: . as $k | $knobs | has($k) | not;
      def bad_knob_value: .key as $k | .value | test($knobs[$k]) | not;
    if ($ph | type) != "object" or ($rp | type) != "object" then "buildEnv.placeholders and buildEnv.railpack must be objects"
    elif ($ph | length) > 40 or ($rp | length) > 40 then "buildEnv carries more than 40 names in one map"
    elif ([$ph, $rp | to_entries[] | .value | bad_value] | any) then "every buildEnv value must be a single-line string of at most 512 characters"
    elif ([$ph | keys[] | bad_placeholder] | any) then "placeholder names must be upper-case variable names the builder does not reserve: " + ([$ph | keys[] | select(bad_placeholder)] | join(", "))
    elif ([$rp | keys[] | unknown_knob] | any) then "not a Railpack switch this builder passes on: " + ([$rp | keys[] | select(unknown_knob)] | join(", ")) + " (it passes on " + ($knobs | keys_unsorted | join(", ")) + ")"
    elif ([$rp | to_entries[] | bad_knob_value] | any) then "Railpack switch values this builder will not pass on (the app build settings say what each takes): " + ([$rp | to_entries[] | select(bad_knob_value) | .key] | join(", "))
    else "" end
    end' <<<"$REQ_JSON")"
[ -z "$INVALID" ] || fail "invalid build request: ${INVALID:0:400}"

# NAME=value lines for build_env's with-env mode (root 0700 $P).
jq -r '(.buildEnv // {}) | ((.placeholders // {}), (.railpack // {})) | to_entries[] | "\(.key)=\(.value)"' \
  <<<"$REQ_JSON" >"$P/build-env"
mapfile -t PLACEHOLDER_NAMES < <(jq -r '(.buildEnv.placeholders // {}) | keys[]' <<<"$REQ_JSON")
mapfile -t RAILPACK_NAMES < <(jq -r '(.buildEnv.railpack // {}) | keys[]' <<<"$REQ_JSON")

say "build $BUILD_ID: $APP at $SHA (strategy $STRATEGY, publish $PUBLISH, requested by $REQUESTED_BY)"

if [ ! -d "$WORK_ROOT" ]; then
  agent_fail "the work directory $WORK_ROOT is missing: is $BUILD_ROOT mounted?"
fi
# Nothing has run as the build user yet in this unit's fresh /tmp.
make_mise_mountpoint

# Cache-mount ids are global to the BuildKit daemon, and this box namespaces
# them `<app>-…`: Railpack's frontend prefixes every plan cache with the
# cache-key (`<cache-key>-<name>`, railpack buildkit/build_llb/cache_store.go),
# the repo Dockerfile scan below demands it, Dockerfile.checks uses it. A
# hyphen in the app name would let app `foo` with cache `bar-x` meet app
# `foo-bar` with cache `x`.
if [[ "$APP" == *-* ]]; then
  fail "request refused: app names containing '-' are not built on this box (cache mount ids are namespaced as <app>-…)"
fi

# Fail closed on the egress fence, per build. The unit runs the same check
# before starting, but a firewall reload that failed since then removes the
# fence while buildkitd keeps running, and what is about to run is a
# repository's code. $FENCE_CHECK is builder.nix's (fleet.builder.fenceCheck):
# every fenced owner — the daemon's buildkit, the build user — v4 and v6.
if ! "$FENCE_CHECK" >"$P/fence.out" 2>&1; then
  fail "builder unfenced: the egress fence is not in place; refusing to run repository code until the firewall is back (systemctl status firewall): $(head -c 300 "$P/fence.out" | tr '\n' ' ')"
fi

say "checking the builder at $BUILDKIT_ADDR"
if ! as_build "$TIMEOUT_BIN" 20s buildctl --addr "$BUILDKIT_ADDR" debug workers >/dev/null 2>"$P/probe.err"; then
  fail "builder unavailable: buildkitd did not answer ($(head -c 300 "$P/probe.err" | tr '\n' ' '))"
fi

# ── 1. a token for this one repository ────────────────────────────────────

enter cloning "requesting a repository token"
[ -r "$PEM" ] || agent_fail "the App's private key is not on the host ($PEM)"
gh_app_auth || agent_fail "could not sign a JWT with the App's private key ($PEM)"

rc=0
gh_installation || rc=$?
case "$rc" in
0) ;;
2) fail "GitHub: $GH_REASON" ;;
*) fail "GitHub: $GH_ERROR" ;;
esac

# Narrowed below the minter's grant: this one repository, read-only.
jq -n --arg app "$APP" '{repositories: [$app], permissions: {contents: "read", metadata: "read"}}' >"$GH_TMP/mint.json"
gh_mint "$GH_TMP/mint.json" || fail "GitHub: $GH_ERROR"
TOKEN_LIVE=1
if ! jq -j '.token' "$GH_TMP/token.json" | gh_write_config "$GH_TMP/repo.curlrc"; then
  agent_fail "GitHub minted a token this agent cannot use"
fi

# The repository must be the one the app was connected to: a deleted and
# recreated repo under the same name has a new id, and the default branch is
# read from GitHub, never from the request.
gh_api GET "/repos/$OWNER/$APP" "$GH_TMP/repo.curlrc" || fail "GitHub: $GH_ERROR"
[ "$GH_STATUS" = 200 ] || fail "reading $OWNER/$APP: $(gh_message)"
# …and owned by the account this box trusts. OWNER_ID is the nix constant
# fleet.github.expectedOwnerId, never site.json's copy, which the container
# can write through Apply.
GOT_OWNER="$(jq -r '.owner.id // "" | tostring' "$GH_TMP/body")"
[ "$GOT_OWNER" = "$OWNER_ID" ] || fail "$OWNER/$APP is owned by GitHub account ${GOT_OWNER:0:20}, not this box's owner ($OWNER_ID)"
GOT_ID="$(jq -r '.id // "" | tostring' "$GH_TMP/body")"
[ "$GOT_ID" = "$REPO_ID" ] || fail "$OWNER/$APP is repository ${GOT_ID:0:20} on GitHub, not $REPO_ID: it was replaced since the app was connected"
DEF="$(jq -r '.default_branch // "" | strings' "$GH_TMP/body")"
if ! [[ "$DEF" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$ ]] || [[ "$DEF" == *..* || "$DEF" == *//* || "$DEF" == */ || "$DEF" == *.lock ]]; then
  fail "GitHub reports a default branch this builder will not fetch: ${DEF:0:100}"
fi

# ── 2. clone ──────────────────────────────────────────────────────────────

# The token goes to git through GIT_ASKPASS, as a file the build user can read
# and nothing else can write: never in a URL, a config or an argument.
jq -j '.token' "$GH_TMP/token.json" >"$CTL/git/token"
chgrp "$BUILD_GROUP" "$CTL/git/token"
chmod 0440 "$CTL/git/token"
# shellcheck disable=SC2016 # the askpass script's own variables
{
  printf '#!%s\n' "$BASH"
  printf '%s\n' \
    'case "$1" in' \
    'Username*) printf "%s\n" x-access-token ;;' \
    '*) IFS= read -r t <"$DAEDALUS_TOKEN_FILE" || [ -n "$t" ] || exit 1; printf "%s\n" "$t" ;;' \
    'esac'
} >"$CTL/git/askpass"
chgrp "$BUILD_GROUP" "$CTL/git/askpass"
chmod 0550 "$CTL/git/askpass"

WORK="$WORK_ROOT/$BUILD_ID"
SRC="$WORK/src"
enter cloning "fetching $DEF from github.com/$OWNER/$APP"
as_build rm -rf -- "$WORK"
as_build mkdir -p -m 0700 -- "$WORK" "$WORK/home" "$WORK/out" "$WORK/plan"
as_build git init -q -b daedalus-build "$SRC"
as_build git -C "$SRC" remote add origin "https://github.com/$OWNER/$APP.git"

rc=0
timed_as_build "$CLONE_LIMIT" plain git -C "$SRC" -c credential.helper= -c core.hooksPath=/dev/null \
  fetch --no-tags --depth 1 --no-recurse-submodules origin \
  --end-of-options "+refs/heads/$DEF:refs/remotes/origin/$DEF" || rc=$?
if [ "$rc" -ne 0 ]; then
  fail "$(stage_error "fetching $DEF" "$rc" "$CLONE_LIMIT")"
fi

TIP="$(as_build git -C "$SRC" rev-parse --verify --quiet "refs/remotes/origin/$DEF^{commit}")" || TIP=""
[[ "$TIP" =~ ^[0-9a-f]{40}$ ]] || fail "the fetch of $DEF produced no commit"
revoke_token

# Only the tip is ever built: a replayed or out-of-order push names an older
# commit, and the engine enqueues the tip this status reports instead.
if [ "$TIP" != "$SHA" ]; then
  say "superseded: $DEF is at $TIP, not $SHA"
  finish superseded "superseded: $DEF is at ${TIP:0:7}" "" '.tip = $tip' --arg tip "$TIP"
  exit 0
fi

enter cloning "checking out ${SHA:0:7}"
if ! as_build git -C "$SRC" -c core.hooksPath=/dev/null -c advice.detachedHead=false checkout -q --detach "$SHA"; then
  fail "could not check out $SHA"
fi
CLONE_BYTES="$(as_build du -sb -- "$SRC" | cut -f1)" || CLONE_BYTES=""
[[ "$CLONE_BYTES" =~ ^[0-9]+$ ]] || agent_fail "could not measure the clone"
if [ "$CLONE_BYTES" -gt "$MAX_CLONE_BYTES" ]; then
  fail "the clone is $CLONE_BYTES bytes, over the 2 GiB cap"
fi

# Which of the files that steer this build — or that the published `repo`
# facts are read from (start.mjs, pnpm-workspace.yaml) — exist as regular
# files at the root, asked of the build user like every other look at the
# tree.
# shellcheck disable=SC2016 # the probe's own positional parameter
PRESENT="$(as_build "$BASH" -c 'cd -- "$1" || exit 1
  for f in railpack.json Dockerfile package.json start.mjs pnpm-workspace.yaml pnpm-lock.yaml yarn.lock package-lock.json bun.lock bun.lockb; do
    if [ -f "$f" ] && [ ! -L "$f" ]; then printf "%s\n" "$f"; fi
  done' probe "$SRC")"
has() { grep -Fxq -- "$1" <<<"$PRESENT"; }

case "$STRATEGY" in
auto)
  if has railpack.json; then
    RESOLVED=railpack
  elif has Dockerfile; then
    RESOLVED=dockerfile
  else
    RESOLVED=railpack
  fi
  ;;
*) RESOLVED="$STRATEGY" ;;
esac
if [ "$RESOLVED" = dockerfile ] && ! has Dockerfile; then
  fail "strategy dockerfile, but the repository has no Dockerfile at its root"
fi
status_set '.strategy = $s' --arg s "$RESOLVED"
say "strategy: $RESOLVED (requested: $STRATEGY)"

# Every `--mount=` in Dockerfile $1 that could reach another app's cache, one
# per line. Cache-mount ids are global to the daemon, and an id-less cache
# mount defaults to its target path — shared by every app that mounts the same
# path. So a cache mount must carry an explicit id that literally starts with
# `<app>-` (a variable after the prefix cannot leave it), and a mount type the
# scan cannot read as a literal (`type=$T`) is refused rather than guessed.
# Keys are matched case-insensitively and quotes dropped, as BuildKit parses
# them. Line by line on purpose: continuation lines still start their flags
# with `--mount=`, and a match inside a heredoc body refuses, fail-closed.
unsafe_cache_mounts() {
  awk -v app="$APP" '
    {
      s = $0
      while (match(s, /--mount=("[^"]*"|\047[^\047]*\047|[^[:space:]]+)/)) {
        tok = substr(s, RSTART, RLENGTH)
        s = substr(s, RSTART + RLENGTH)
        val = substr(tok, 9)
        gsub(/["\047]/, "", val)
        type = "bind"
        id = ""
        n = split(val, kv, ",")
        for (i = 1; i <= n; i++) {
          eq = index(kv[i], "=")
          key = tolower(eq ? substr(kv[i], 1, eq - 1) : kv[i])
          v = eq ? substr(kv[i], eq + 1) : ""
          if (key == "type") type = tolower(v)
          else if (key == "id") id = v
        }
        if (type !~ /^(bind|cache|tmpfs|secret|ssh)$/) { print tok; continue }
        if (type == "cache" && (index(id, app "-") != 1 || length(id) <= length(app) + 1)) print tok
      }
    }' "$1"
}

if [ "$RESOLVED" = dockerfile ]; then
  if ! as_build dd if="$SRC/Dockerfile" iflag=nofollow,nonblock bs=65536 count=16 status=none >"$P/Dockerfile" 2>/dev/null; then
    fail "could not read the repository's Dockerfile"
  fi
  UNSAFE_MOUNTS="$({ unsafe_cache_mounts "$P/Dockerfile" || true; } | head -n 5 | tr '\n' ' ')"
  if [ -n "$UNSAFE_MOUNTS" ]; then
    fail "request refused: cache mount id must start with $APP- (found: ${UNSAFE_MOUNTS% })"
  fi
fi

if has pnpm-lock.yaml; then
  RUNNER=pnpm
elif has yarn.lock; then
  RUNNER=yarn
elif has bun.lock || has bun.lockb; then
  RUNNER=bun
else
  RUNNER=npm
fi

# ── what the clone says about itself ──────────────────────────────────────
#
# Shapes and names, never contents. The engine's warning engine reads these to
# explain a build the way a person would — "the repository has no start.mjs",
# "the build script wants a runner this image has not got" — instead of
# quoting the log at whoever opens the page. All of it is repository content,
# which the log already carries; but only NAMES leave here, never a value out
# of buildEnv and never a command's output, so this door adds nothing to what
# the status could already say. What does leave goes through `redact` all the
# same: a package.json script is repository text like any other, and the one
# redaction the log gets is the one the status gets.
#
# Read through the build user with O_NOFOLLOW like every other look at the
# tree, and best-effort throughout: a repository with no package.json, an
# unparsable one, or a pnpm-workspace.yaml that cannot be read costs the key
# it would have filled and nothing else. Never the build.

# The package names a pnpm-workspace.yaml allows to run install scripts, one
# per line. A small reader rather than a YAML parser, and deliberately
# literal: the block is pnpm's own `allowBuilds:` mapping at column 0, and
# only an entry whose value is a bare `true` counts. Any other shape it could
# take — a sequence, an anchor, a nested map — yields nothing, which reads as
# "none declared": the safe way to be wrong about a list whose whole point is
# to be short and hand-written.
allow_builds() {
  awk '
    /^[^[:space:]#]/ { inblock = ($0 ~ /^allowBuilds:[[:space:]]*(#.*)?$/); next }
    !inblock { next }
    {
      line = $0
      sub(/#.*$/, "", line)
      if (line ~ /^[[:space:]]+["\047]?[A-Za-z0-9@._\/-]+["\047]?[[:space:]]*:[[:space:]]*true[[:space:]]*$/) {
        sub(/^[[:space:]]+/, "", line)
        sub(/[[:space:]]*:.*$/, "", line)
        gsub(/["\047]/, "", line)
        print line
      }
    }' "$1"
}

# The `repo` object on stdout, or nothing at all. Called in a command
# substitution so that everything here — a jq that trips over a hostile
# package.json included — costs its own subshell and not the build; the
# caller publishes only what came back whole.
repo_facts() {
  local start=false allow='[]'
  if has start.mjs; then start=true; fi
  if has pnpm-workspace.yaml &&
    as_build dd if="$SRC/pnpm-workspace.yaml" iflag=nofollow,nonblock bs=65536 count=8 status=none >"$P/workspace.yaml" 2>/dev/null; then
    allow="$(allow_builds "$P/workspace.yaml" |
      jq -Rcn --argjson max "$MAX_REPO_DEPS" '[inputs | select(length > 0)] | unique | .[0:$max]')" || allow='[]'
  fi
  if has package.json && read_work_json "$SRC/package.json" "$P/repo-package.json"; then
    # `dependencies` is both lists merged, because a warning about a package
    # rarely cares which half it sits in; `productionDependencies` is the half
    # that ships, for the ones that do. Both sorted (jq's `keys`), both cut.
    jq -c --argjson start "$start" --argjson allow "$allow" \
      --argjson maxScripts "$MAX_REPO_SCRIPTS" --argjson maxChars "$MAX_REPO_SCRIPT_CHARS" \
      --argjson maxDeps "$MAX_REPO_DEPS" --argjson maxPm "$MAX_REPO_PM_CHARS" '
      def names($k): if (.[$k] | type) == "object" then (.[$k] | keys) else [] end;
      names("dependencies") as $prod
      | { hasStartMjs: $start,
          scripts: (if (.scripts | type) == "object"
                    then (.scripts | to_entries | map(select((.value | type) == "string"))
                          | .[0:$maxScripts] | map({ key: .key, value: (.value[0:$maxChars]) })
                          | from_entries)
                    else {} end),
          dependencies: (($prod + names("devDependencies")) | unique | .[0:$maxDeps]),
          productionDependencies: ($prod | .[0:$maxDeps]),
          allowBuilds: $allow }
      + (if (.packageManager | type) == "string"
         then { packageManager: (.packageManager[0:$maxPm]) } else {} end)' \
      "$P/repo-package.json" | redact_json
  else
    # Not a Node repository, or a package.json nobody can read: the two facts
    # that do not come from it are still facts.
    jq -cn --argjson start "$start" --argjson allow "$allow" \
      '{ hasStartMjs: $start, allowBuilds: $allow }'
  fi
}

# Published here rather than inside repo_facts, so the status write itself
# runs under errexit like every other one in this script: `jq | mv` is only
# safe while a failing jq stops the script before the mv.
if REPO_FACTS="$(repo_facts)" && [ -n "$REPO_FACTS" ] && jq -e . <<<"$REPO_FACTS" >/dev/null 2>&1; then
  status_set '.repo = $r' --argjson r "$REPO_FACTS"
else
  say "could not read the repository's shape for the status; the build is unaffected"
fi

CACHE_REF="$REGISTRY/cache/$APP:buildkit"
SECRET_NAMES=()
PROVIDER=""

# ── 3. detect (railpack) ──────────────────────────────────────────────────

# `detected` for the status, size-capped: Railpack's info file and the plan,
# trimmed step by step (step commands and assets first — the runtime apt step
# stays, build-detect reads it — then everything but deploy) until it fits.
publish_detected() {
  local plan="$1" trim
  local steps='.plan.steps |= (if type == "array" then map(if .name == "packages:apt:runtime" then . else del(.commands, .assets) end) else . end)'
  jq -cn --slurpfile info "$P/info.json" --slurpfile plan "$plan" '{info: $info[0], plan: $plan[0]}' >"$P/detected.json"
  for trim in '.' "$steps" "$steps | .plan |= (if type == \"object\" then {deploy, secrets, steps} else . end)" \
    '.plan |= (if type == "object" then {deploy} else . end) | .info.logs |= (if type == "array" then .[-20:] else . end)'; do
    jq -c "$trim" "$P/detected.json" >"$P/detected.try.json"
    if [ "$(stat -c %s "$P/detected.try.json")" -le "$MAX_DETECTED_BYTES" ]; then
      status_set '.detected = $d[0]' --slurpfile d "$P/detected.try.json"
      return 0
    fi
  done
  say "Railpack's detection is over $MAX_DETECTED_BYTES bytes even trimmed; the status carries none"
}

if [ "$RESOLVED" = railpack ]; then
  enter detecting "railpack prepare"
  ENV_ARGS=()
  for n in "${PLACEHOLDER_NAMES[@]}" "${RAILPACK_NAMES[@]}"; do
    ENV_ARGS+=(--env "$n")
  done
  # This app's mise cache, for prepare alone ("Railpack's mise cache, one per
  # app" above); unmounted once the loop is done, or by on_exit.
  mount_mise_cache
  attempt=1
  while :; do
    as_build rm -f -- "$WORK/plan/railpack-plan.json" "$WORK/plan/railpack-info.json"
    rc=0
    timed_as_build "$DETECT_LIMIT" with-env railpack prepare "$SRC" \
      --plan-out "$WORK/plan/railpack-plan.json" --info-out "$WORK/plan/railpack-info.json" \
      --error-missing-start "${ENV_ARGS[@]}" || rc=$?
    reap_build_processes
    [ "$rc" -ne 0 ] || break
    # 75 is Railpack's own "transient" (a mise download); a GitHub 403 or rate
    # limit in its output is the same thing wearing exit 1.
    if [ "$attempt" = 1 ] && { [ "$rc" = 75 ] || { [ "$rc" = 1 ] && grep -qiE 'rate[ -]?limit|403' "$P/scan"; }; }; then
      say "railpack prepare exited $rc, which looks transient; retrying once"
      attempt=2
      continue
    fi
    # The info file is written on a failed detection too, and says why.
    why=""
    if read_work_json "$WORK/plan/railpack-info.json" "$P/info.json"; then
      printf 'null' >"$P/no-plan.json"
      publish_detected "$P/no-plan.json"
      why="$(jq -r '[.logs[]? | select(((.Level // .level // "") | ascii_downcase) == "error") | (.Msg // .msg // "")] | last // ""' "$P/info.json")"
    fi
    if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
      fail "detecting timed out after $DETECT_LIMIT"
    fi
    fail "Railpack could not work out how to build this app (exit $rc)${why:+: $why}"
  done
  unmount_mise_cache || agent_fail "could not unmount $APP's mise cache from $MISE_MOUNT; refusing to go on with it in place"

  read_work_json "$WORK/plan/railpack-info.json" "$P/info.json" || fail "railpack prepare wrote no readable info file"
  read_work_json "$WORK/plan/railpack-plan.json" "$P/plan.raw.json" || fail "railpack prepare wrote no readable plan"
  # Every --env name became a required plan secret, the RAILPACK_* knobs
  # included; the frontend would demand those too (spike B11).
  jq 'if (.secrets | type) == "array" then .secrets |= map(select(type == "string" and (startswith("RAILPACK_") | not))) else . end' \
    "$P/plan.raw.json" >"$CTL/plan/railpack-plan.json"
  chmod 0644 "$CTL/plan/railpack-plan.json"
  publish_detected "$CTL/plan/railpack-plan.json"
  PROVIDER="$(jq -r '.detectedProviders[0] // "" | strings' "$P/info.json")"
  say "detected: ${PROVIDER:-no provider}"

  mapfile -t SECRET_NAMES < <(jq -r '(.secrets // [])[]' "$CTL/plan/railpack-plan.json")
  for n in "${SECRET_NAMES[@]}"; do
    [[ "$n" =~ ^[A-Za-z_][A-Za-z0-9_]{0,127}$ ]] || fail "the Railpack plan declares a secret name this builder will not pass: ${n:0:80}"
  done
  # BuildKit fails on a missing secret only when a step runs, and a fully
  # cached step does not (spike B11): this is the guard that holds.
  MISSING=()
  for n in "${SECRET_NAMES[@]}"; do
    in_list "$n" "${PLACEHOLDER_NAMES[*]}" || MISSING+=("$n")
  done
  if [ "${#MISSING[@]}" -gt 0 ]; then
    fail "the Railpack plan needs build secret(s) ${MISSING[*]}, but the app has no build placeholder for them (daedalus: the app's build settings)"
  fi
else
  SECRET_NAMES=("${PLACEHOLDER_NAMES[@]}")
fi

# The secrets, as files BuildKit's client reads (root-owned, build-user
# readable), and the Railpack cache-invalidation hash over the sorted
# NAME=value lines — computed here, since the CLI's own iterates a Go map.
SECRET_ARGS=()
SECRETS_HASH=""
HASH_ARGS=()
: >"$P/secrets-hash-input"
i=0
for n in "${SECRET_NAMES[@]}"; do
  i=$((i + 1))
  jq -j --arg n "$n" '.buildEnv.placeholders[$n]' <<<"$REQ_JSON" >"$CTL/secrets/$i"
  chgrp "$BUILD_GROUP" "$CTL/secrets/$i"
  chmod 0440 "$CTL/secrets/$i"
  SECRET_ARGS+=(--secret "id=$n,src=$CTL/secrets/$i")
  {
    printf '%s=' "$n"
    cat "$CTL/secrets/$i"
    printf '\n'
  } >>"$P/secrets-hash-input"
done
if [ "$RESOLVED" = railpack ] && [ "$i" -gt 0 ]; then
  SECRETS_HASH="$(LC_ALL=C sort "$P/secrets-hash-input" | sha256sum | cut -d' ' -f1)"
  HASH_ARGS=(--opt "build-arg:secrets-hash=$SECRETS_HASH")
fi

# ── 4. checks ─────────────────────────────────────────────────────────────

# The two facts this stage worked out and used to throw away. The runner is
# the one every check command is prefixed with; the hash is a sha256 over
# NAME=value lines, so it is not itself a secret — but the status carries only
# its first 12 characters anyway: enough to see at a glance that a rebuild's
# cache key moved, far too little to confirm a guessed value against.
status_set '.build.runner = $r' --arg r "$RUNNER"
if [ -n "$SECRETS_HASH" ]; then
  status_set '.build.secretsHash = $h' --arg h "${SECRETS_HASH:0:12}"
fi

if [ "$RESOLVED" = railpack ]; then
  [ "$PROVIDER" = node ] && NODE=1 || NODE=0
else
  has package.json && NODE=1 || NODE=0
fi

CHECK_NAMES=()
SCRIPTS_JSON='[]'
if [ "$NODE" = 1 ]; then
  if ! read_work_json "$SRC/package.json" "$P/package.json"; then
    fail "package.json is not a readable JSON object (or is over 16 MiB); refusing to build without checks"
  fi
  # The contract (v1): a `ci` script if the repo has one, else the known
  # scripts that exist, in this order — generate-routes first, because
  # src/routeTree.gen.ts is gitignored and lint is type-aware.
  SCRIPTS_JSON="$(jq -c '
    (if (.scripts | type) == "object" then .scripts else {} end) as $s
    | if ($s.ci | type) == "string" then ["ci"]
      else ["generate-routes", "format:check", "lint", "typecheck", "test"] | map(select(($s[.] | type) == "string"))
      end' "$P/package.json")"
  mapfile -t CHECK_NAMES < <(jq -r '.[]' <<<"$SCRIPTS_JSON")
fi

# Which check failed, from the scanned output: the Dockerfile target echoes
# `check failed: <name>`; a Railpack step is the vertex named `check: <name>`
# whose number carries the first ERROR.
failed_check() {
  local name vid
  name="$({ grep -oE 'check failed: [A-Za-z0-9:_-]+' "$P/scan" || true; } | tail -n 1 | sed 's/^check failed: //')"
  if [ -z "$name" ]; then
    vid="$({ grep -oE '^#[0-9]+ ERROR' "$P/scan" || true; } | head -n 1 | cut -d' ' -f1)"
    if [ -n "$vid" ]; then
      name="$({ grep -E "^$vid( \\[[^]]*\\])? check: " "$P/scan" || true; } | head -n 1 | sed -E 's/^.*check: ([A-Za-z0-9:_-]+).*$/\1/')"
    fi
  fi
  if [ -n "$name" ] && in_list "$name" "${CHECK_NAMES[*]}"; then
    printf '%s' "$name"
  fi
}

enter checking "running checks"
if [ "$NODE" = 0 ]; then
  say "no checks declared: checks run for Node apps only in v1 (provider: ${PROVIDER:-none})"
  status_set '.checks = {ran: [], failed: null}'
elif [ "${#CHECK_NAMES[@]}" -eq 0 ]; then
  say "no checks declared: package.json has no ci, generate-routes, format:check, lint, typecheck or test script"
  status_set '.checks = {ran: [], failed: null}'
elif [ "$RESOLVED" = dockerfile ] && [ "$RUNNER" != pnpm ]; then
  say "no checks declared: the Dockerfile checks target supports pnpm repositories only in v1 (this one uses $RUNNER)"
  status_set '.checks = {ran: [], failed: null}'
else
  say "checks: ${CHECK_NAMES[*]}"
  status_set '.phase = $p' --arg p "running ${CHECK_NAMES[*]}"
  rc=0
  if [ "$RESOLVED" = railpack ]; then
    # A copy of the plan with one more step on top of the build step and
    # `deploy` replaced, so the solve runs exactly the image's toolchain and
    # exports nothing. One argv command per script: plan commands are not
    # shell-interpreted. `secrets: ["*"]`: a partial list makes the frontend
    # pull a floating alpine.
    BASE_STEP="$(jq -r '[.steps[]?.name | strings] | if any(.[]; . == "build") then "build" else (last // "") end' "$CTL/plan/railpack-plan.json")"
    [ -n "$BASE_STEP" ] || fail "the Railpack plan has no step to run checks on"
    jq --argjson scripts "$SCRIPTS_JSON" --arg runner "$RUNNER" --arg base "$BASE_STEP" '
      .steps += [{ name: "checks", inputs: [{ step: $base }],
        commands: ($scripts | map({ cmd: ($runner + " run " + .), customName: ("check: " + .) })),
        secrets: ["*"] }]
      | .deploy = { base: { step: "checks" } }' \
      "$CTL/plan/railpack-plan.json" >"$CTL/checks/railpack-plan.json"
    chmod 0644 "$CTL/checks/railpack-plan.json"
    timed_as_build "$CHECKS_LIMIT" plain buildctl --addr "$BUILDKIT_ADDR" build --progress=plain \
      --frontend gateway.v0 --opt "source=$RAILPACK_FRONTEND" \
      --local "context=$SRC" --local "dockerfile=$CTL/checks" \
      --opt "build-arg:cache-key=$APP" "${HASH_ARGS[@]}" "${SECRET_ARGS[@]}" \
      --import-cache "type=registry,ref=$CACHE_REF" || rc=$?
  else
    cp -- "$CHECKS_DOCKERFILE" "$CTL/checks/Dockerfile"
    chmod 0644 "$CTL/checks/Dockerfile"
    jq -r '(.buildEnv.placeholders // {}) | to_entries[] | @sh "export \(.key)=\(.value)"' \
      <<<"$REQ_JSON" >"$CTL/secrets/check-env"
    chgrp "$BUILD_GROUP" "$CTL/secrets/check-env"
    chmod 0440 "$CTL/secrets/check-env"
    timed_as_build "$CHECKS_LIMIT" plain buildctl --addr "$BUILDKIT_ADDR" build --progress=plain \
      --frontend dockerfile.v0 --local "context=$SRC" --local "dockerfile=$CTL/checks" \
      --opt target=checks --opt "build-arg:NODE_IMAGE=$NODE_IMAGE" --opt "build-arg:APP=$APP" \
      --opt "build-arg:REGISTRY_URL=$NPM_REGISTRY_URL" --opt "build-arg:CHECKS=${CHECK_NAMES[*]}" \
      "${NPM_MIRROR_ARGS[@]}" \
      --secret "id=daedalus-check-env,src=$CTL/secrets/check-env" || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    FAILED_CHECK="$(failed_check)"
    if [ -n "$FAILED_CHECK" ]; then
      status_set '.checks = {ran: ($all[: ($all | index($f)) + 1]), failed: $f}' \
        --argjson all "$SCRIPTS_JSON" --arg f "$FAILED_CHECK"
      fail "check failed: $FAILED_CHECK"
    fi
    status_set '.checks = {ran: [], failed: null}'
    systemctl is-active --quiet buildkitd.service || fail "builder unavailable: buildkitd stopped during the checks"
    fail "$(stage_error checks "$rc" "$CHECKS_LIMIT")"
  fi
  status_set '.checks = {ran: $ran, failed: null}' --argjson ran "$SCRIPTS_JSON"
fi

# ── 5. build and publish ──────────────────────────────────────────────────

SOURCE_URL="https://github.com/$OWNER/$APP"
if [ "$PUBLISH" = live ]; then
  IMAGE_REF="$REGISTRY/$APP:sha-$SHA"
  TAGS="$IMAGE_REF,$REGISTRY/$APP:latest"
else
  IMAGE_REF="$REGISTRY/$APP:candidate-$SHA"
  TAGS="$IMAGE_REF"
fi

if [ "$RESOLVED" = railpack ]; then
  FRONTEND_ARGS=(
    --frontend gateway.v0 --opt "source=$RAILPACK_FRONTEND"
    --local "context=$SRC" --local "dockerfile=$CTL/plan"
    # The build-arg: prefix is required; a bare cache-key is silently ignored.
    --opt "build-arg:cache-key=$APP" "${HASH_ARGS[@]}"
  )
else
  FRONTEND_ARGS=(
    --frontend dockerfile.v0
    --local "context=$SRC" --local "dockerfile=$SRC"
    "${NPM_MIRROR_ARGS[@]}"
    --opt "label:org.opencontainers.image.revision=$SHA"
    --opt "label:org.opencontainers.image.source=$SOURCE_URL"
    --opt "label:org.opencontainers.image.title=$APP"
    --opt "label:org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  )
fi

enter building "building the image"
rm -f -- "$P/pushing" "$P/timedout"

# The push credential, for this one call only (header: the registry
# credential). Nothing of the build user's may still run when it appears; the
# rendered original is root's, and is read here never through a link.
reap_build_processes
rm -rf -- "$CTL/docker"
install -d -m 0700 -o "$BUILD_USER" -g "$BUILD_GROUP" "$CTL/docker"
if ! dd if="$DOCKER_CONFIG_DIR/config.json" iflag=nofollow,nonblock bs=65536 count=1 status=none 2>/dev/null |
  install -m 0400 -o "$BUILD_USER" -g "$BUILD_GROUP" /dev/stdin "$CTL/docker/config.json" ||
  [ ! -s "$CTL/docker/config.json" ]; then
  rm -rf -- "$CTL/docker"
  agent_fail "the registry push credential is not readable at $DOCKER_CONFIG_DIR/config.json (is daedalus-build-dockerconfig healthy?)"
fi

with_lock _set_deadline "$BUILD_SECS" building
BUILD_STARTED="$(date +%s)"
rc=0
timed_as_build "$((BUILD_SECS + PUBLISH_SECS))s" push buildctl --addr "$BUILDKIT_ADDR" build --progress=plain \
  "${FRONTEND_ARGS[@]}" "${SECRET_ARGS[@]}" \
  --output "type=image,\"name=$TAGS\",push=true,oci-mediatypes=true,annotation.org.opencontainers.image.revision=$SHA,annotation.org.opencontainers.image.source=$SOURCE_URL" \
  --export-cache "type=registry,ref=$CACHE_REF,mode=max,image-manifest=true,oci-mediatypes=true,ignore-error=true" \
  --import-cache "type=registry,ref=$CACHE_REF" \
  --metadata-file "$WORK/out/metadata.json" || rc=$?
rm -rf -- "$CTL/docker"

if [ "$rc" -ne 0 ]; then
  with_lock _set_deadline 0 none
  : >"$P/deadline"
  # Frontend and LLB errors land in the daemon's journal, not buildctl's
  # output.
  say "── buildkitd's journal since the build started ──"
  journalctl -u buildkitd.service --since "@$BUILD_STARTED" --no-pager -o short-iso 2>&1 | tail -n 400 || true
  if [ -s "$P/timedout" ]; then
    fail "$(cat "$P/timedout") timed out (building is limited to $((BUILD_SECS / 60))m, publishing to $((PUBLISH_SECS / 60))m)"
  fi
  systemctl is-active --quiet buildkitd.service || fail "builder unavailable: buildkitd stopped during the build"
  fail "$(stage_error "$(current_state)" "$rc" "$(((BUILD_SECS + PUBLISH_SECS) / 60))m")"
fi
with_lock _after_build

# BuildKit's own report of the push, into root's copy: the digest below, and
# the tags and descriptor image_facts reads out of the same file.
as_build dd if="$WORK/out/metadata.json" iflag=nofollow,nonblock bs=65536 count=16 status=none \
  >"$P/metadata.json" 2>/dev/null || : >"$P/metadata.json"
DIGEST="$(jq -r '."containerimage.digest" // "" | strings' "$P/metadata.json" 2>/dev/null)" || DIGEST=""
[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "BuildKit reported no image digest for the push"

# The image's size: config plus layers, from the manifest zot serves
# anonymously. Informational — a failure costs the number, not the build.
image_size() {
  local accept ref="$DIGEST" hop
  accept='application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json'
  for hop in 1 2; do
    curl -fsS --proto '=https' --max-time 20 -H "Accept: $accept" \
      -o "$P/manifest.json" "https://$REGISTRY/v2/$APP/manifests/$ref" || return 1
    if jq -e '(.manifests | type) == "array"' "$P/manifest.json" >/dev/null 2>&1; then
      [ "$hop" = 1 ] || return 1
      ref="$(jq -r '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64")][0].digest // ""' "$P/manifest.json")"
      [[ "$ref" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
      continue
    fi
    jq -e '[(.config.size // 0), (.layers[]?.size // 0)] | add' "$P/manifest.json"
    return
  done
  return 1
}
SIZE="$(image_size 2>/dev/null)" || SIZE=""
if ! [[ "$SIZE" =~ ^[0-9]+$ ]]; then
  say "could not read the image size from $REGISTRY"
  SIZE=null
fi
status_set '.digest = $d | .imageRef = $r | .sizeBytes = $s' --arg d "$DIGEST" --arg r "$IMAGE_REF" --argjson s "$SIZE"
say "pushed $IMAGE_REF ($DIGEST, ${SIZE} bytes)"

# ── what the push and the solve say about themselves ──────────────────────
#
# Both are read from what the stage above already produced — the metadata file
# BuildKit wrote, the manifest image_size fetched, and the vertex verdicts
# scan_output kept — so neither costs the build a second of work, and both are
# best-effort: a key that cannot be worked out is left out, because an absent
# key reads as "unknown" to the engine while a wrong one would lie. Each runs
# in a command substitution and the publish happens out here, so a jq that
# trips costs its own subshell rather than the status (`jq >next | mv` is safe
# only while errexit can stop the script between the two).

# The `image` object on stdout. The tags are the ones BuildKit reports it
# PUSHED (`image.name` in the metadata), not the $TAGS this script asked for;
# they agree today, and a daemon that ever rewrote one is exactly the sort of
# thing worth being able to see. Each is cut down to its tag — the repository
# prefix is the same for all of them and already in `imageRef`.
image_facts() {
  [ -e "$P/manifest.json" ] || : >"$P/manifest.json"
  jq -cn --slurpfile meta "$P/metadata.json" --slurpfile manifest "$P/manifest.json" \
    --arg repo "$REGISTRY/$APP" --arg asked "$TAGS" \
    --argjson maxTags "$MAX_IMAGE_TAGS" --argjson maxLayers "$MAX_IMAGE_LAYERS" '
    (($meta[0] | objects) // {}) as $m
    # An index is the one thing image_size can leave behind unresolved: its
    # sizes belong to no image, so only the descriptor speaks for it.
    | (($manifest[0] | objects | select((.manifests | type) != "array")) // {}) as $f
    | (($f.layers | arrays) // null) as $layers
    | { tags: ((($m["image.name"] | strings) // $asked) | split(",")
               | map(select(length > 0)
                     | if startswith($repo + ":") then .[($repo | length) + 1:] else . end
                     | .[0:200])
               | .[0:$maxTags]),
        layers: (if $layers == null then null else ($layers | length) end),
        layerSizes: (if $layers == null then null
                     else [$layers[] | if (type == "object") and ((.size | type) == "number")
                                       then .size else 0 end][0:$maxLayers] end),
        configSize: (($f.config | objects | .size | numbers) // null),
        mediaType: (((($f.mediaType | strings)
                      // ($m["containerimage.descriptor"] | objects | .mediaType | strings)) // null)
                    | if . == null then null else .[0:200] end) }
    | with_entries(select(.value != null))' | redact_json
}

# The cache and step half of `build` on stdout, counted from the publishing
# solve's own vertex verdicts ($P/vertices, this call's alone). Numbers and
# booleans only, so there is nothing here for redact to do.
#
# We stayed on --progress=plain rather than moving the publishing solve to
# --progress=rawjson. This log is what the build page tails live and what the
# GitHub check run quotes at whoever pushed, and plain is the format a person
# already knows how to read; rawjson would mean rendering our own progress UI
# to keep it that way, and re-deriving four existing readers (failed_check's
# vertex numbers, stage_error's hint, scan_output's push marker, the
# buildkitd journal dump) from a format buildctl documents as unstable. These
# facts are cheap to parse out of plain and change nothing a human sees.
#
#   #12 CACHED                             a step BuildKit did not have to run
#   #12 DONE 4.2s                          a step that ran
#   #6 importing cache manifest from <ref> … then its own DONE or ERROR
#   #34 exporting cache to registry        … then its own DONE or ERROR
#
# A cache import that misses is `ERROR: failed to configure registry cache
# importer: <ref>: not found` and does NOT fail the build — an app's first
# build always misses — and an export failure is swallowed whole by
# ignore-error=true. Both keep ignore-error, because a cache problem must
# never fail a build; publishing the verdict is what turns that silence into
# a fact somebody can act on.
#
# The two cache vertices are facts in their own right, so they are not counted
# as steps; every other vertex that reached a verdict is one. A vertex can
# print its block more than once in plain progress, hence the per-id table.
build_facts() {
  local counts cached total imported exported
  [ -s "$P/vertices" ] || return 1
  counts="$(awk -v cache="$CACHE_REF" '
    /^#[0-9]+ / {
      id = substr($1, 2)
      if ($2 == "importing" && index($0, cache) > 0) { impId = id; next }
      if ($2 == "exporting" && $3 == "cache") { expId = id; next }
      # A verdict is DONE, CACHED, or ERROR with a colon stuck to it.
      verdict = $2
      sub(/:$/, "", verdict)
      if (verdict != "DONE" && verdict != "CACHED" && verdict != "ERROR") next
      if (impId != "" && id == impId) impState = verdict
      else if (expId != "" && id == expId) expState = verdict
      else if (verdict != "ERROR") state[id] = verdict
    }
    END {
      for (k in state) { total++; if (state[k] == "CACHED") cached++ }
      printf "%d %d %s %s\n", cached + 0, total + 0,
        (impState == "" ? "-" : impState), (expState == "" ? "-" : expState)
    }' "$P/vertices")" || return 1
  read -r cached total imported exported <<<"$counts" || return 1
  jq -cn --argjson cached "$cached" --argjson total "$total" \
    --arg imported "$imported" --arg exported "$exported" '
    (if $total > 0 then { stepsCached: $cached, stepsTotal: $total } else {} end)
    + (if $imported == "DONE" then { cacheImported: true }
       elif $imported == "ERROR" then { cacheImported: false } else {} end)
    + (if $exported == "DONE" then { cacheExported: true }
       elif $exported == "ERROR" then { cacheExported: false } else {} end)'
}

if IMAGE_FACTS="$(image_facts)" && [ -n "$IMAGE_FACTS" ] && jq -e . <<<"$IMAGE_FACTS" >/dev/null 2>&1; then
  status_set '.image = $i' --argjson i "$IMAGE_FACTS"
else
  say "could not read the pushed image's manifest facts for the status"
fi

# `.build +=`, because the runner and the secrets hash were published into the
# same object back in stage 3.
if BUILD_FACTS="$(build_facts)" && [ -n "$BUILD_FACTS" ] && [ "$BUILD_FACTS" != "{}" ] &&
  jq -e . <<<"$BUILD_FACTS" >/dev/null 2>&1; then
  status_set '.build += $b' --argjson b "$BUILD_FACTS"
  # The same facts as a sentence, because the log is read by people too.
  FACTS_LINE="$(jq -r '
    ["steps: \(.stepsCached // "?") of \(.stepsTotal // "?") cached",
     "registry cache import \(if has("cacheImported") then (if .cacheImported then "hit" else "missed" end) else "not attempted" end)",
     "export \(if has("cacheExported") then (if .cacheExported then "written" else "FAILED" end) else "not attempted" end)"]
    | join("; ")' <<<"$BUILD_FACTS")" || FACTS_LINE="build facts: $BUILD_FACTS"
  say "$FACTS_LINE"
else
  say "could not read the solve's cache and step facts for the status"
fi

# ── 6. done ───────────────────────────────────────────────────────────────

if [ "$PUBLISH" = candidate ]; then
  finish succeeded "published as candidate-${SHA:0:7}; not deployed" "" '.candidate = true'
elif in_list "$APP" "$DEPLOYABLE"; then
  if systemctl start --no-block "app-$APP-deploy.service"; then
    finish succeeded "published; app-$APP-deploy started" ""
  else
    finish succeeded "published; app-$APP-deploy could not be started (journalctl -u daedalus-build)" ""
  fi
else
  finish succeeded "published; not deployed: $APP is pinned" "" '.pinned = true'
fi
say "build $BUILD_ID done: $IMAGE_REF@$DIGEST"
