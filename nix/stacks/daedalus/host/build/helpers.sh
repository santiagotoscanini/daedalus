# host/build/helpers.sh — the machinery every stage of the build uses.
#
# Part of daedalus-build's script: build-agent.nix concatenates host/lib.sh,
# host/github-lib.sh, host/build.sh (the settings), this file, then the stages
# host/build/0-request.sh … 6-done.sh, in that order.
#
# In here: the log (redact, say), running things as the build user
# (build_env, as_build, timed_as_build, reap_build_processes), Railpack's
# per-app mise cache, the status (status_set, enter, finish, fail vs
# agent_fail, the heartbeat and its watchdog) and the EXIT trap (on_exit).
#
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
