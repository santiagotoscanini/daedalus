# What only the HOST can say about Claude Code on this box.
#
# The dashboard's Claude page has three sources — this snapshot, Loki (the
# unit's own event lines) and GitHub (the changelog). This is the one for
# facts that live outside every scrape:
#
#   - Remote Control's own configuration. `claude remote-control` publishes
#     no health endpoint of any kind — platform/claude-rc.nix says so in as
#     many words — and what it knows about itself (the environment id a phone
#     connects to, the spawn mode, the session ceiling) it prints ONCE, into
#     the journal, at start. Nothing else on this box holds those.
#   - The live sessions. `~/.claude/sessions/*.json` is written by each
#     session process and is the only list of them; /proc turns each entry
#     into "still alive, this big, touched this recently". The journal has
#     "Session started" lines and no matching ended one, so a log-only page
#     would count every session this unit has ever served as connected.
#   - The credential clock. A subscription refresh token that expires takes
#     Remote Control down with no other warning, and its runbook (SSH in,
#     `/login`, restart the unit) is one you want to run BEFORE the box stops
#     answering the phone.
#
# ── what is deliberately NOT in here ──────────────────────────────────────
#
# The published file is world-readable and bind-mounted into a container, and
# `.credentials.json` is 0600 for good reason: it holds the OAuth access and
# refresh tokens for the operator's Claude account. The credential block below
# names the four fields it wants and copies only those. Selecting by name
# rather than deleting the secret keys is the direction that stays safe when
# upstream adds a fifth.
#
# Session *content* is likewise absent. The transcript of a remote session is
# not a fact about the machine, and this file is the wrong place for one.
#
# /run rather than a state dir, like its siblings: derived state that should
# not survive a reboot or ride the ZFS snapshots.

set -euo pipefail

install -d -m 0755 -o "$OPERATOR_USER" -g "$OPERATOR_GROUP" "$OUT_DIR"

# USER_HZ, the unit of the times in /proc/<pid>/stat. Fixed at 100 by the
# kernel's userspace ABI whatever CONFIG_HZ is compiled as, so this is a
# constant rather than something to ask getconf about.
readonly TICKS=100

# ── the unit ──────────────────────────────────────────────────────────────
#
# Read through systemctl rather than from prometheus's systemd collector,
# which carries the state but not the start timestamp, the restart count or
# the accounting — and this script is already standing here.
service_json() {
  local props state sub result restarts mem cpu since sinceMs

  props=$("$SYSTEMCTL" show claude-remote-control \
    -p ActiveState -p SubState -p Result -p NRestarts \
    -p MemoryCurrent -p CPUUsageNSec -p ActiveEnterTimestamp 2>/dev/null || true)

  field() { printf '%s\n' "$props" | "$SED" -n "s/^$1=//p" | head -1; }

  state=$(field ActiveState)
  sub=$(field SubState)
  result=$(field Result)
  restarts=$(field NRestarts)
  mem=$(field MemoryCurrent)
  cpu=$(field CPUUsageNSec)
  since=$(field ActiveEnterTimestamp)

  # systemd reports accounting it does not have as the u64 sentinel, and a
  # unit that has never started has an empty timestamp. Both must become
  # null: rendering 18 exabytes of memory is worse than rendering a dash.
  case "$mem" in "[not set]" | 18446744073709551615) mem="" ;; esac
  case "$cpu" in "[not set]" | 18446744073709551615) cpu="" ;; esac

  sinceMs=""
  if [ -n "$since" ]; then
    sinceMs=$(date -d "$since" +%s%3N 2>/dev/null || true)
  fi

  "$JQ" -n \
    --arg state "$state" --arg sub "$sub" --arg result "$result" \
    --arg restarts "${restarts:-0}" --arg mem "$mem" --arg cpu "$cpu" \
    --arg since "$sinceMs" '
    def n: if . == "" then null else tonumber end;
    { activeState: $state, subState: $sub, result: $result,
      restarts: ($restarts | n), memoryBytes: ($mem | n),
      cpuNsec: ($cpu | n), activeSince: ($since | n) }'
}

# ── what Remote Control said about itself at start ────────────────────────
#
# Four lines, printed once, within a second of the unit coming up.
#
# The window is bounded at BOTH ends and that is not tidiness. Every remote
# session writes its full stream-json to this same journal, so the range
# behind those four lines runs to tens of megabytes; `grep -m1` covers the
# happy path by stopping at the hit, but a journal old enough to have had the
# banner vacuumed out of it would make each miss a full scan of that range,
# four times a minute, forever. Two minutes of window costs nothing to read
# and cannot degrade.
#
# All-null is a real answer, not a failure. It is what a unit restarted
# moments ago looks like, and what one that is crash-looping looks like too.
remote_json() {
  local since windowEnd version spawn maxSessions envId

  since=$("$SYSTEMCTL" show claude-remote-control -P ActiveEnterTimestamp 2>/dev/null || true)
  if [ -z "$since" ]; then
    "$JQ" -n '{ version: null, spawnMode: null, maxSessions: null, environmentId: null }'
    return
  fi
  windowEnd=$(date -d "$since + 2 minutes" -Is 2>/dev/null || true)
  [ -n "$windowEnd" ] || windowEnd="now"

  # $1 is a literal prefix: matched anchored, then stripped. Every prefix
  # below is regex-safe, which is why one argument does both jobs.
  banner() {
    "$JOURNALCTL" -u claude-remote-control --since "$since" --until "$windowEnd" \
      -o cat 2>/dev/null |
      { "$GREP" -am1 -E "^$1" || true; } | "$SED" -E "s/^$1//"
  }

  version=$(banner 'Remote Control v')
  spawn=$(banner 'Spawn mode: ')
  maxSessions=$(banner 'Max concurrent sessions: ')
  envId=$(banner 'Environment ID: ')

  "$JQ" -n \
    --arg version "$version" --arg spawn "$spawn" \
    --arg max "$maxSessions" --arg env "$envId" '
    def s: if . == "" then null else . end;
    { version: ($version | s), spawnMode: ($spawn | s),
      maxSessions: (if $max == "" then null else ($max | tonumber) end),
      environmentId: ($env | s) }'
}

# ── the sessions actually connected ───────────────────────────────────────
#
# One file per session process, written by the process itself. A file whose
# process is gone is reported with `alive: false` rather than dropped: the
# roster and reality disagreeing is a fact worth seeing, not a row to hide.
#
# Liveness compares /proc's start time against the one recorded in the file.
# Testing that the pid merely EXISTS is the bug this avoids — pids recycle,
# and a stale session file whose number now belongs to a podman helper would
# be drawn as a live remote session for as long as that helper ran.
sessions_json() {
  local first=1 f
  printf '['
  for f in "$CLAUDE_HOME"/sessions/*.json; do
    [ -e "$f" ] || continue

    local pid procStart alive statLine startTicks utime stime pages
    local cpuMs rssBytes remoteId lastAt logBytes bridgeLog

    pid=$("$JQ" -r '.pid // empty' "$f" 2>/dev/null || true)
    procStart=$("$JQ" -r '.procStart // empty' "$f" 2>/dev/null || true)
    [ -n "$pid" ] || continue

    alive=false
    cpuMs=""
    rssBytes=""
    remoteId=""
    if [ -r "/proc/$pid/stat" ]; then
      # comm is parenthesised and may itself contain spaces and parens, so
      # everything through the LAST `)` goes first. What remains starts at
      # field 3, which puts starttime at 20 and utime/stime at 12 and 13.
      statLine=$("$SED" -E 's/^[0-9]+ \(.*\) //' "/proc/$pid/stat" 2>/dev/null || true)
      startTicks=$("$AWK" '{print $20}' <<<"$statLine")
      utime=$("$AWK" '{print $12}' <<<"$statLine")
      stime=$("$AWK" '{print $13}' <<<"$statLine")

      if [ -n "$startTicks" ] && { [ -z "$procStart" ] || [ "$startTicks" = "$procStart" ]; }; then
        alive=true
        cpuMs=$(((utime + stime) * 1000 / TICKS))
        pages=$(cut -d' ' -f2 "/proc/$pid/statm")
        rssBytes=$((pages * 4096))
        # The id claude.ai shows, which is NOT the transcript uuid inside the
        # session file: the bridge is launched with `--session-id cse_…` and
        # the command line is the only place the two are tied together.
        remoteId=$(tr '\0' '\n' <"/proc/$pid/cmdline" 2>/dev/null |
          { "$GREP" -m1 '^cse_' || true; })
      fi
    fi

    # Last activity, from the bridge's own debug log. There is no other clock
    # on a session: the session file is written once, at start, so its
    # timestamp says when the session began and nothing at all about whether
    # anyone is still typing into it.
    lastAt=""
    logBytes=""
    bridgeLog="$BRIDGE_LOG_DIR/bridge-session-$remoteId.log"
    if [ -n "$remoteId" ] && [ -r "$bridgeLog" ]; then
      lastAt=$(($(stat -c %Y "$bridgeLog") * 1000))
      logBytes=$(stat -c %s "$bridgeLog")
    fi

    [ "$first" = 1 ] || printf ','
    first=0

    "$JQ" -c \
      --argjson alive "$alive" --arg remoteId "$remoteId" \
      --arg cpuMs "$cpuMs" --arg rss "$rssBytes" \
      --arg lastAt "$lastAt" --arg logBytes "$logBytes" '
      def s: if . == "" then null else . end;
      def n: if . == "" then null else tonumber end;
      { pid: .pid, transcriptId: (.sessionId // null), remoteId: ($remoteId | s),
        cwd: (.cwd // null), name: (.name // null), kind: (.kind // null),
        entrypoint: (.entrypoint // null), version: (.version // null),
        startedAt: (.startedAt // null), alive: $alive,
        cpuMs: ($cpuMs | n), rssBytes: ($rss | n),
        lastActivityAt: ($lastAt | n), logBytes: ($logBytes | n) }' "$f"
  done
  printf ']'
}

# ── the credential clock ──────────────────────────────────────────────────
#
# Four fields, named one at a time. See the header: the same file holds the
# tokens, and this one is published world-readable.
#
# Both clocks are carried because they answer different questions. `expiresAt`
# is the access token's and moves hourly, which is nothing to watch; the
# refresh token's is the one that ends in a re-login, and it is the only
# advance warning Remote Control gives before it simply stops.
credentials_json() {
  local f="$CLAUDE_HOME/.credentials.json"
  local blank='{ subscriptionType: null, rateLimitTier: null, expiresAt: null,
                 refreshExpiresAt: null, scopes: [] }'

  # `present` distinguishes the two ways this can say nothing: no file at all
  # (nobody has ever logged in on this box) versus a file that would not
  # decode (the login is there and something is wrong with it).
  if [ ! -r "$f" ]; then
    "$JQ" -n "$blank + { present: false }"
    return
  fi
  "$JQ" '{ present: true,
           subscriptionType: (.claudeAiOauth.subscriptionType // null),
           rateLimitTier: (.claudeAiOauth.rateLimitTier // null),
           expiresAt: (.claudeAiOauth.expiresAt // null),
           refreshExpiresAt: (.claudeAiOauth.refreshTokenExpiresAt // null),
           scopes: (.claudeAiOauth.scopes // []) }' "$f" 2>/dev/null ||
    "$JQ" -n "$blank + { present: true }"
}

# What a session spawned from a phone runs before anyone types a word. The
# unit does not restate it and the model is not a flag on ExecStart, so the
# operator's settings file is the only place it is written down.
settings_json() {
  local f="$CLAUDE_HOME/settings.json"
  if [ ! -r "$f" ]; then
    "$JQ" -n '{ model: null, effortLevel: null }'
    return
  fi
  "$JQ" '{ model: (.model // null), effortLevel: (.effortLevel // null) }' "$f" 2>/dev/null ||
    "$JQ" -n '{ model: null, effortLevel: null }'
}

"$JQ" -n \
  --argjson service "$(service_json)" \
  --argjson remote "$(remote_json)" \
  --argjson sessions "$(sessions_json)" \
  --argjson credentials "$(credentials_json)" \
  --argjson settings "$(settings_json)" \
  --arg cliVersion "$CLI_VERSION" \
  --arg cliStore "$CLI_STORE" \
  --arg g "$(date -Is)" '{
    daedalusExport: 1,
    domain: "claude",
    schemaVersion: 1,
    source: "host",
    revision: null,
    generatedAt: $g,
    data: {
      service: $service,
      remote: $remote,
      sessions: $sessions,
      credentials: $credentials,
      settings: $settings,
      # What the flake built, as against what the running server reported at
      # its own start. The two disagreeing IS the finding: a flake update
      # landed and nothing has restarted the unit onto it.
      cli: { version: $cliVersion, storePath: $cliStore }
    }
  }' | write_json_atomic "$OUT_DIR/claude.json"

# Same argument as the system snapshot: a successful oneshot has no lines of
# its own — systemd files "Starting"/"Finished" under init.scope — so without
# this the unit is invisible in Loki and could stop with nothing to see. The
# counts are the content: live sessions going to zero and staying there while
# the unit reports active is the interesting failure.
echo "published claude snapshot:" \
  "$("$JQ" -r '.data.service.activeState' "$OUT_DIR/claude.json") unit," \
  "$("$JQ" '[.data.sessions[] | select(.alive)] | length' "$OUT_DIR/claude.json") live sessions," \
  "$("$JQ" '.data.sessions | length' "$OUT_DIR/claude.json") session files"
