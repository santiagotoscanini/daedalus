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
# ── who can read the published file ───────────────────────────────────────
#
# `0700` on the directory and `0600` on the file: the OPERATOR and root, and
# nobody else on this box. It was `0755`/`0644` — a world-readable file in a
# world-traversable directory — and the reason that had to change is not
# theoretical. `daedalus-build.service` runs untrusted repository code as its
# own user on this machine (stacks/daedalus/builder.nix), and every `podman
# exec` into any container here lands somewhere that can read a 0644 file in
# /run. What this file already carried before one byte of content went into
# it was the list of every session on the box with its name and its working
# directory, which is a map of what the operator works on and where.
#
# It costs nothing. The container that consumes it runs as container uid 0,
# which rootless podman maps to the operator on the host (CLAUDE.md's UID
# table), so the bind mount reads a 0600 operator-owned file exactly as it
# read a 0644 one. `write_json_atomic` is handed the mode explicitly, the way
# env-snapshot.sh and github-token.sh already hand it theirs.
#
# ── what is deliberately NOT in here ──────────────────────────────────────
#
# `.credentials.json` is 0600 for good reason: it holds the OAuth access and
# refresh tokens for the operator's Claude account. The credential block below
# names the four fields it wants and copies only those. Selecting by name
# rather than deleting the secret keys is the direction that stays safe when
# upstream adds a fifth.
#
# Session *content* is almost entirely absent, and the one exception is named
# and bounded — see "the last prompt" below. The transcript of a session is
# not a fact about the machine; a label derived from one is.
#
# /run rather than a state dir, like its siblings: derived state that should
# not survive a reboot or ride the ZFS snapshots.
#
# ── whose privilege reads what ────────────────────────────────────────────
#
# The unit is root for the system journal. Everything it reads out of
# ~/.claude it reads AS the operator: that tree is theirs and writable by
# them, and a link in it followed by root would publish fields out of any
# JSON file on the box (host/lib.sh has the rule). The operator owns the
# credentials file, so dropping privilege costs nothing there either. The
# published file lives in an operator-owned /run dir, so write_json_atomic
# publishes it as the operator too.

set -euo pipefail

install -d -m 0700 -o "$OPERATOR_USER" -g "$OPERATOR_GROUP" "$OUT_DIR"

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

    pid=$(as_operator "$JQ" -r '.pid // empty' "$f" 2>/dev/null || true)
    procStart=$(as_operator "$JQ" -r '.procStart // empty' "$f" 2>/dev/null || true)
    # Digits only. The pid is spliced into /proc paths below and what those
    # paths yield lands in shell arithmetic, which EVALUATES its operand: a
    # pid of `../../<somewhere>` pointing at a crafted file would be code run
    # as root. A real pid is a number, so nothing is lost.
    case "$pid" in
    "" | *[!0-9]*) continue ;;
    esac

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

    # Last activity. TWO clocks now, and the later of them wins.
    #
    # The session file used to be written once, at start — which is why the
    # bridge's per-session debug log was the only clock a session had, and
    # why a session with no `cse_…` (anything started at the console, which
    # includes every session resumed in a tmux) reported no activity at all.
    # CLI 2.1.260 writes that file again as the session runs: `updatedAt`
    # always, plus `status` and `statusUpdatedAt` once it has one. So the
    # roster clock now covers the sessions the bridge clock never could, and
    # the bridge log stays for the remote ones, where it moves on traffic the
    # session file does not record.
    lastAt=""
    logBytes=""
    bridgeLog="$BRIDGE_LOG_DIR/bridge-session-$remoteId.log"
    if [ -n "$remoteId" ] && [ -r "$bridgeLog" ]; then
      lastAt=$(($(stat -c %Y "$bridgeLog") * 1000))
      logBytes=$(stat -c %s "$bridgeLog")
    fi

    [ "$first" = 1 ] || printf ','
    first=0

    as_operator "$JQ" -c \
      --argjson alive "$alive" --arg remoteId "$remoteId" \
      --arg cpuMs "$cpuMs" --arg rss "$rssBytes" \
      --arg lastAt "$lastAt" --arg logBytes "$logBytes" '
      def s: if . == "" then null else . end;
      def n: if . == "" then null else tonumber end;
      # The later of the two clocks, skipping whichever is absent. `max` over
      # the present ones rather than a chain of `//`: neither source is
      # reliably ahead of the other, and picking the wrong one draws a busy
      # session as idle.
      ([ ($lastAt | n), (.statusUpdatedAt // null), (.updatedAt // null) ]
       | map(select(type == "number"))) as $clocks |
      { pid: .pid, transcriptId: (.sessionId // null), remoteId: ($remoteId | s),
        cwd: (.cwd // null), name: (.name // null), kind: (.kind // null),
        entrypoint: (.entrypoint // null), version: (.version // null),
        startedAt: (.startedAt // null), alive: $alive,
        status: (.status // null),
        cpuMs: ($cpuMs | n), rssBytes: ($rss | n),
        lastActivityAt: (if ($clocks | length) == 0 then null else ($clocks | max) end),
        logBytes: ($logBytes | n) }' "$f"
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
  as_operator "$JQ" '{ present: true,
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
  as_operator "$JQ" '{ model: (.model // null), effortLevel: (.effortLevel // null) }' "$f" 2>/dev/null ||
    "$JQ" -n '{ model: null, effortLevel: null }'
}

# ── the roster: every session this box could still be asked about ─────────
#
# `sessions_json` above is the Remote Control roster and nothing else — one
# file per LIVE process. This is the other two populations, and they are
# published as two separate lists on purpose, because the two sources
# disagree and which one said a thing is part of the answer:
#
#   agents       `claude agents --json`, the CLI's own view. AUTHORITATIVE
#                FOR WHAT IS ALIVE, and the only source at all for background
#                agents (`claude --bg`): it reports them with a human name
#                and a cwd, including ones whose project directory no longer
#                exists, which no directory walk could find.
#   transcripts  The `.jsonl` files under ~/.claude/projects/<slug>/.
#                AUTHORITATIVE FOR WHAT IS RESUMABLE, and for nothing else —
#                a transcript says a conversation happened, never that
#                anything is still running behind it.
#
# The board joins them on the session uuid. Where only one side has a row,
# that IS the reading: a transcript with no agent is a dead conversation on
# disk, an agent with no transcript is a session whose project dir is gone.
#
# ── what is NOT in here, and why the shape is what it is ──────────────────
#
# The tree these files live in is secret-bearing — private-key headers,
# `github_pat_` prefixes, the captured output of `sops -d`. What is copied
# out of it is derived LABELS — an `ai-title`, a `customTitle`, the `name`
# the CLI derives — plus the counts below, and ONE line of conversation,
# which has its own section. In particular the `queue-operation` records
# that open most transcripts carry the operator's prompt verbatim in
# `content`, and that field is never reached for.
#
# Both blocks below therefore name their fields one at a time, the same way
# `credentials_json` does, rather than taking a record and deleting what is
# unwanted: naming is the direction that stays safe when upstream adds a
# field nobody here has seen.
#
# ── the last prompt, and its residual risk ────────────────────────────────
#
# The one exception to "no conversation". The operator asked for it and
# accepted the trade on the condition the 0600 tightening at the top of this
# file landed first, which it did.
#
# Source: the `"type":"last-prompt"` record. It is NOT unique — the CLI
# writes one per submitted turn (152 of them in the largest transcript here)
# — so it is the LAST such record in the file, which is the last thing the
# operator typed into that session. 44 of 49 transcripts have one.
#
# Three things happen to it before it reaches the disk, in this order and
# not another:
#
#   1. whitespace collapses to single spaces, so it is one line;
#   2. `redact_prompt` below runs the credential patterns — the same shapes
#      as the app's `lib/redact.ts`, plus the API-key prefixes that file has
#      no reason to carry (`sk-…`, `AKIA…`, `xox?-…`, Google `AIza…`);
#   3. it is cut to 160 characters.
#
# Redaction precedes truncation deliberately: cutting first can leave the
# first half of a token standing where the pattern would have taken all of
# it.
#
# ⚠ RESIDUAL RISK, stated plainly because the alternative is implying a
# guarantee this cannot give. Redaction of arbitrary prose is BEST EFFORT
# and nothing more. These patterns recognise credentials by shape; a secret
# with no shape — a password, a passphrase, a bare hex string, an internal
# hostname, a sentence about something private — is not recognisable and
# lands in this file in full, up to those 160 characters. That is the trade
# the operator took. What makes it acceptable is the 0600 above and nothing
# else: the file is readable by the operator and root, and by no build, no
# container and no other user on this box. If that mode is ever widened,
# this field has to go with it.
#
# The background agents' `detail` (what the agent last printed) and `needs`
# (the question it is parked on) stay out. They are the same class of
# content, they live in `~/.claude/jobs/<id>/state.json`, and the operator
# asked for the prompt and not for those.
#
# ── cost: what a scan costs, cold and warm ────────────────────────────────
#
# The tree is ~458 MB across 49 transcripts. `stat`, the 8 KB head read and
# `claude agents --json` (150-180 ms; a compiled binary answering out of
# state on disk, not a node start-up) are unchanged and run every tick.
#
# What is new is `scan_transcript`, ONE awk pass over a whole file, and it
# is the only thing here that could get expensive — so it is cached:
#
#   warm  ~0.4 s for the whole block, the same as before the counts existed.
#         Nothing is reread. The PREVIOUS published snapshot is the cache —
#         a transcript row already carries `modifiedAt` and `sizeBytes`, so
#         a row whose (mtime, size) still match is reused wholesale, meta
#         and all. That is why there is no second cache file to go stale or
#         to be cleaned up: the cache is the output, beside itself in /run,
#         at the same 0600, and a reboot correctly throws it away.
#   cold  ~3.7 s for all 458 MB, on a boot or after any change to
#         SCAN_VERSION. Only the files whose (mtime, size) moved are read,
#         so the steady state is one file — the session being typed into —
#         at ~45 ms per 23 MB.
#
# SCAN_VERSION is the guard that makes reusing the output safe: bump it
# whenever the fields `scan_transcript` emits change, or every row keeps
# whatever the previous script's idea of those fields was, forever.
#
# [operator] Everything here reads the operator's own home, so the whole
# block runs as them in ONE setpriv rather than 49: a link planted in that
# tree then reaches nothing they could not already reach, which is lib.sh's
# rule. Self-contained by necessity — `as_operator_fn` carries this
# function's source and nothing else, so the binaries are the bare names
# runtimeInputs put on PATH.
op_roster() {
  local home="$1" cli="$2" cache="$3" projects="$1/projects"
  local agents stats rows cached stale scanned heads

  # Bump whenever the fields `scan` emits below change shape or meaning.
  # Every cached row carries the version it was produced under and a row
  # that does not match is rescanned, so this is the whole migration story:
  # without it a field added here would stay null on 48 of 49 rows forever,
  # because those files never change again.
  local SCAN_VERSION=1

  # ONE awk pass per transcript, and the only thing in this script that ever
  # reads a whole file. Everything is gated on `index()` — a plain substring
  # search — before any regex touches the line, because the lines here run to
  # megabytes and a `match()` per pattern per line is the difference between
  # 45 ms and several seconds on a 23 MB file.
  #
  # Counting, and what each count is actually counting:
  #
  #   exchanges  `"type":"user"` records that do NOT carry a `tool_result`.
  #              The raw record count is not this number and must not be
  #              printed as it: 545 of them in the largest transcript here,
  #              of which 494 are tool results the CLI files as user turns.
  #              36 is what the operator typed. That is the one worth saying.
  #   replies    `"type":"assistant"` records.
  #   thinking   `{"type":"thinking"` content blocks. The text of one is not
  #              in the transcript (the field is empty beside a signature),
  #              so this is a count and could never be anything else.
  #   images     `{"type":"image","source"` — the CONTENT block. Every image
  #              also appears a second time under `toolUseResult` with a
  #              different following key, and counting `"type":"image"` raw
  #              therefore doubles it.
  #   attached   `"attachment":{"type":"file"` — a file the operator
  #              attached. NOT `"type":"attachment"`, which is 1126 records
  #              in that same transcript and is ~97% hook errors, token
  #              reminders and environment snapshots the CLI injects itself.
  #   subagents  `"isSidechain":true`. Published only when the KEY appears at
  #              all, so a CLI that never wrote it reads as "unknown" rather
  #              than as a confident zero. It is false on every record of
  #              every transcript on this box today.
  #
  # The last-prompt and cost-state records are emitted as their raw JSON
  # lines for jq to decode — they are small, and reimplementing JSON string
  # unescaping in awk to save one `fromjson` would be the wrong trade. Tabs
  # are squeezed out of both because the transport is TSV; a literal tab
  # inside a JSON string is already malformed JSON, so nothing valid is
  # lost. A pathological line (>128 KB, an entire pasted file as a prompt)
  # is dropped rather than carried: silence is the right answer there.
  local scan='
    { L = $0
      if (index(L, "\"type\":\"user\"")) {
        if (!index(L, "\"type\":\"tool_result\"")) p++
      }
      if (index(L, "\"type\":\"assistant\"")) a++
      if (index(L, "{\"type\":\"thinking\"")) { s = L; t += gsub(/\{"type":"thinking"/, "", s) }
      if (index(L, "{\"type\":\"image\",\"source\"")) { s = L; im += gsub(/\{"type":"image","source"/, "", s) }
      if (index(L, "\"attachment\":{\"type\":\"file\"")) { s = L; at += gsub(/"attachment":\{"type":"file"/, "", s) }
      if (index(L, "\"isSidechain\"")) {
        sk = 1
        if (index(L, "\"isSidechain\":true")) { s = L; sc += gsub(/"isSidechain":true/, "", s) }
      }
      if (match(L, /"timestamp":"[^"]+"/)) {
        ts = substr(L, RSTART + 13, RLENGTH - 14)
        if (ft == "") ft = ts
        lt = ts
      }
      if (br == "" && match(L, /"gitBranch":"[^"]*"/)) br = substr(L, RSTART + 13, RLENGTH - 14)
      if (vr == "" && match(L, /"version":"[^"]*"/)) vr = substr(L, RSTART + 11, RLENGTH - 12)
      if (index(L, "\"type\":\"last-prompt\"") && length(L) <= 131072) lp = L
      if (index(L, "\"type\":\"cost-state\"") && length(L) <= 131072) cs = L
    }
    END {
      gsub(/\t/, " ", lp)
      gsub(/\t/, " ", cs)
      printf "%s\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%s\t%s\t%s\t%s\t%s\t%s\n",
        id, p, a, t, im, at, sc, sk, ft, lt, br, vr, lp, cs
    }'

  # ── the passes ──────────────────────────────────────────────────────────
  #
  # In the order they run, each named for what it sets: the locals above,
  # through bash's dynamic scope, rather than by printing, so every
  # statement keeps the exact exit and capture behaviour it had inline.
  # Defined INSIDE op_roster because `as_operator_fn` ships exactly one
  # function's source to the operator's shell; nested, they travel with it.

  # agents — the CLI's own list of live sessions, or "" when it refused.
  roster_agents() {
    # A refusal is a row that says so, never a failed snapshot: the CLI is a
    # moving target and `agents` is the newest verb here. `timeout` because a
    # hung one would wedge a unit that runs every minute.
    #
    # HOME is set explicitly because setpriv changes the uid and nothing else:
    # without it the CLI would look for its state under root's home and answer
    # an empty list, which reads exactly like "nothing is running". The
    # operator's home IS the parent of the claude dir this unit was handed —
    # snapshots-lib.nix composes that path from the same two pieces.
    agents=$(HOME="${home%/*}" timeout 10 "$cli/bin/claude" agents --json 2>/dev/null)
    if ! printf '%s' "$agents" | jq -e 'type == "array"' >/dev/null 2>&1; then
      agents=""
    fi
  }

  # stats — one { id, project, sizeBytes, modifiedAt } per transcript on
  # disk; rows — the newest 200 non-empty ones, as `<project>\t<id>`.
  roster_stats() {
    local d f
    local -a files=()

    shopt -s nullglob
    for d in "$projects"/*/; do
      for f in "$d"*.jsonl; do
        files+=("$f")
      done
    done

    # One `stat` for all of them. %F rather than a `-f` test per file: a
    # symlink reports "symbolic link" and is dropped in jq below, which is the
    # same refusal one loop-and-test would reach, in one process instead of 49.
    # Both spellings of a regular file are kept — GNU stat calls a 0-byte one
    # a "regular empty file", and those are counted below rather than listed.
    stats='[]'
    if [ ${#files[@]} -gt 0 ]; then
      stats=$(stat -c '%F|%s|%Y|%n' -- "${files[@]}" 2>/dev/null | jq -Rn '
        [ inputs | select(length > 0) | split("|")
          | select(.[0] == "regular file" or .[0] == "regular empty file")
          | (.[3] | split("/")) as $p
          | { id: ($p[-1] | sub("\\.jsonl$"; "")),
              project: $p[-2],
              sizeBytes: (.[1] | tonumber),
              modifiedAt: ((.[2] | tonumber) * 1000) }
          # The canonical-uuid gate, which is also what makes the two
          # separator characters above safe to parse on: anything whose name
          # could have carried one is already gone.
          | select(.id | test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) ]')
    fi

    # Newest first, and capped: the board reads the recent end and an
    # unbounded roster would grow this published file without limit.
    rows=$(printf '%s' "$stats" | jq -r '
      [ .[] | select(.sizeBytes > 0) ] | sort_by(-.modifiedAt) | .[0:200][]
      | "\(.project)\t\(.id)"')
  }

  # cached — the previous snapshot's scan results, by transcript id.
  roster_cache() {
    # ── the scan cache: the previous snapshot, read back ────────────────────
    #
    # No cache file of its own. A published transcript row already carries the
    # `modifiedAt` and `sizeBytes` it was scanned at, so the file this script
    # wrote a minute ago IS the cache — same directory, same 0600, thrown away
    # by the same reboot, and impossible to leave behind out of step with the
    # output it describes.
    #
    # Unreadable, absent or last written by a different SCAN_VERSION all mean
    # the same thing and are handled by meaning it: an empty map, so every
    # file is read. That is the cold path, and it is ~3 s once.
    cached='{}'
    if [ -r "$cache" ]; then
      cached=$(jq --argjson v "$SCAN_VERSION" '
        [ (.data.roster.transcripts // [])[]
          | select((.meta.scanVersion // 0) == $v)
          | { key: .id, value: { modifiedAt: .modifiedAt, sizeBytes: .sizeBytes, meta: .meta } } ]
        | from_entries' "$cache" 2>/dev/null) || cached='{}'
      [ -n "$cached" ] || cached='{}'
    fi
  }

  # stale — the rows whose (mtime, size) moved; scanned — their fresh scan
  # results, by transcript id.
  roster_scan() {
    # Only the files whose (mtime, size) moved. In the steady state that is
    # the one session being typed into; after a boot it is all of them.
    stale=$(printf '%s' "$stats" | jq -r --argjson c "$cached" '
      [ .[] | select(.sizeBytes > 0) ] | sort_by(-.modifiedAt) | .[0:200][]
      | . as $s | ($c[$s.id] // null) as $hit
      | select($hit == null or $hit.modifiedAt != $s.modifiedAt or $hit.sizeBytes != $s.sizeBytes)
      | "\(.project)\t\(.id)"')

    scanned=$(
      while IFS=$'\t' read -r d f; do
        [ -n "$f" ] || continue
        awk -v id="$f" "$scan" "$projects/$d/$f.jsonl" 2>/dev/null || true
      done <<<"$stale" | jq -Rn --argjson v "$SCAN_VERSION" '
        # ── the one line of conversation that leaves the tree ───────────────
        #
        # Same shapes as the app'"'"'s lib/redact.ts, plus the API-key prefixes
        # that file has no reason to carry. Best effort and nothing more: see
        # the residual-risk note in the header. Whitespace collapses FIRST so
        # a prompt is one line; truncation happens LAST so a pattern is never
        # handed half a token to miss.
        def redact:
          gsub("-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\\s\\S]*?(?:-----END [A-Z0-9 ]*-----|$)"; "[redacted]")
          | gsub("github_pat_[A-Za-z0-9_]+"; "[redacted]")
          | gsub("gh[opusr]_[A-Za-z0-9_]{20,}"; "[redacted]")
          | gsub("(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]*"; "[redacted]")
          | gsub("sk-(?:ant-)?[A-Za-z0-9_-]{16,}"; "[redacted]")
          | gsub("AKIA[0-9A-Z]{16}"; "[redacted]")
          | gsub("xox[baprs]-[A-Za-z0-9-]{10,}"; "[redacted]")
          | gsub("AIza[0-9A-Za-z_-]{35}"; "[redacted]")
          | gsub("x-access-token:[^@\\s]+"; "x-access-token:[redacted]")
          | gsub("(?<pre>(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]*://[^\\s:@/]*:)[^\\s/]+@"; "\(.pre)[redacted]@"; "i")
          | gsub("(?<pre>(?:authorization|_authToken)[\"'"'"']?\\s*[:=]\\s*(?:[\"'"'"'])?(?:basic |bearer |token )?)[^\\s\"'"'"',;]+"; "\(.pre)[redacted]"; "i");
        def oneline: gsub("\\s+"; " ") | sub("^ "; "") | sub(" $"; "");
        def cut: if (. | length) > 160 then (.[0:159] + "…") else . end;
        def s: if . == "" then null else . end;
        def epoch: sub("\\.[0-9]+Z$"; "Z") | (try fromdateiso8601 catch null)
                   | if . == null then null else . * 1000 end;

        [ inputs | select(length > 0) | split("\t")
          | select(length >= 14)
          | { key: .[0],
              value: {
                scanVersion: $v,
                exchanges: (.[1] | tonumber),
                replies: (.[2] | tonumber),
                thinking: (.[3] | tonumber),
                images: (.[4] | tonumber),
                attached: (.[5] | tonumber),
                # Unknown, not zero, when the CLI never wrote the marker.
                subagents: (if .[7] == "1" then (.[6] | tonumber) else null end),
                # Last timestamp minus first: the SPAN the session was open
                # across, not time at a keyboard — hence the name. Null when
                # the file carries no timestamp, which a transcript of nothing
                # but title records genuinely does.
                spanMs: (((.[9] | s | if . == null then null else epoch end) // null) as $b
                           | ((.[8] | s | if . == null then null else epoch end) // null) as $a
                           | if $a == null or $b == null or $b < $a then null else $b - $a end),
                branch: (.[10] | s),
                cliVersion: (.[11] | s),
                lastPrompt: (.[12] | s | if . == null then null
                             else ((fromjson? | .lastPrompt?) // null)
                               | if type == "string" and . != "" then (oneline | redact | cut)
                                 else null end
                             end),
                # Present in 3 of 49 transcripts. Published as a block or not
                # at all — a card must never print a cost the CLI never wrote.
                cost: (.[13] | s | if . == null then null
                       else (fromjson? // null)
                         | if type == "object" then
                             { usd: (.totalCostUSD // null),
                               linesAdded: (.totalLinesAdded // null),
                               linesRemoved: (.totalLinesRemoved // null),
                               durationMs: (.totalDuration // null) }
                           else null end
                       end) } } ]
        | from_entries')
    [ -n "$scanned" ] || scanned='{}'
  }

  # heads — titles, start time and cwd, from each row's first 8 KB and its
  # sidecar title file.
  roster_heads() {
    # The head of each transcript, and the sidecar title beside it, fed to ONE
    # jq as `<id>\tab<line>`. `head -c` cuts mid-line, so the last line of each
    # is usually not JSON; `fromjson?` drops it, which is why this can read a
    # fixed prefix of a 22 MB file and ask nothing about record boundaries.
    heads=$(
      while IFS=$'\t' read -r d f; do
        [ -n "$f" ] || continue
        head -c 8192 "$projects/$d/$f.jsonl" 2>/dev/null | sed -e "s|^|$f\t|"
        printf '\n'
        if [ -r "$projects/$d/$f/custom-title.json" ]; then
          printf '%s\t' "$f"
          head -c 4096 "$projects/$d/$f/custom-title.json" 2>/dev/null
          printf '\n'
        fi
      done <<<"$rows" | jq -Rn '
        reduce (inputs
                | (index("\t")) as $i
                | select($i != null)
                | { id: .[0:$i], r: (.[$i+1:] | fromjson?) }
                | select((.r | type) == "object")) as $e ({};
          $e.id as $k
          | .[$k] //= { ai: null, custom: null, sidecar: null, startedAt: null, cwd: null }
          # Three title slots rather than one, because their precedence is not
          # the order they arrive in: a title the operator typed outranks one
          # the model wrote, wherever each was found.
          | (if $e.r.type == "ai-title" and ($e.r.aiTitle | type) == "string"
             then .[$k].ai //= $e.r.aiTitle else . end)
          | (if $e.r.type == "custom-title" and ($e.r.customTitle | type) == "string"
             then .[$k].custom //= $e.r.customTitle else . end)
          | (if ($e.r.type | type) == "null" and ($e.r.customTitle | type) == "string"
             then .[$k].sidecar //= $e.r.customTitle else . end)
          # The FIRST timestamp anywhere in the prefix, not the first line s.
          # `custom-title`, `ai-title` and `mode` records carry none at all,
          # and a transcript can open with any of them.
          | (if ($e.r.timestamp | type) == "string"
             then .[$k].startedAt //= $e.r.timestamp else . end)
          | (if ($e.r.cwd | type) == "string" then .[$k].cwd //= $e.r.cwd else . end))'
    )
  }

  roster_agents
  roster_stats
  roster_cache
  roster_scan
  roster_heads

  [ -n "$heads" ] || heads='{}'
  [ -n "$stats" ] || stats='[]'

  printf '%s' "$stats" | jq \
    --argjson heads "$heads" \
    --argjson cached "$cached" \
    --argjson scanned "$scanned" \
    --arg agents "$agents" '
    def slug: if startswith("-") then (.[1:] | "/" + gsub("-"; "/")) else . end;
    def clamp: if (. | length) > 160 then .[0:159] + "…" else . end;
    # Nothing was counted for this row, and every field says so. `exchanges:
    # 0` here would be a lie with the shape of a measurement.
    def NOMETA: { scanVersion: 0, exchanges: null, replies: null,
                  thinking: null, images: null, attached: null,
                  subagents: null, spanMs: null, branch: null,
                  cliVersion: null, lastPrompt: null, cost: null };
    def epoch: sub("\\.[0-9]+Z$"; "Z") | (try fromdateiso8601 catch null)
               | if . == null then null else . * 1000 end;

    . as $stats
    | { agentsAvailable: ($agents != ""),
        # Named one at a time. `state` belongs to a background agent
        # (blocked, running…) and `status` to an interactive one (busy) —
        # the CLI gives each population its own word, and collapsing them
        # into one would invent a lifecycle neither of them has.
        agents: (if $agents == "" then []
                 else ($agents | fromjson | map({
                        id: (.id // null),
                        sessionId: (.sessionId // null),
                        pid: (.pid // null),
                        kind: (.kind // null),
                        state: (.state // null),
                        status: (.status // null),
                        name: (.name // null),
                        cwd: (.cwd // null),
                        startedAt: (.startedAt // null) }))
                 end),
        transcripts: ([ $stats[] | select(.sizeBytes > 0) ]
          | sort_by(-.modifiedAt) | .[0:200]
          | map(. as $s | ($heads[$s.id] // {}) as $h
            | { id: $s.id,
                project: $s.project,
                # The recorded cwd when the prefix carried one; the project
                # slug only as a fallback, because un-slugging is lossy —
                # a directory with a dash in its own name comes back wrong.
                cwd: ($h.cwd // ($s.project | slug)),
                cwdExact: (($h.cwd | type) == "string"),
                title: ((($h.custom // $h.sidecar // $h.ai) // null)
                        | if . == null then null else clamp end),
                titleSource: (if $h.custom != null then "custom-title"
                              elif $h.sidecar != null then "sidecar"
                              elif $h.ai != null then "ai-title"
                              else null end),
                startedAt: (if ($h.startedAt | type) == "string"
                            then ($h.startedAt | epoch) else null end),
                modifiedAt: $s.modifiedAt,
                sizeBytes: $s.sizeBytes,
                # Fresh where this run read the file, the previous
                # snapshot'"'"'s where it did not, and an all-null block where
                # neither has one — a scan that failed must publish "not
                # known", never a row of zeroes that reads like a fact.
                meta: (($scanned[$s.id] // $cached[$s.id].meta) // NOMETA) })),
        # Both totals, so a capped board can say it is capped and an empty
        # transcript can be counted without being drawn. A zero-byte file is
        # a session that was opened and never spoken to; `--resume` on one
        # has nothing to resume.
        transcriptTotal: ([ $stats[] | select(.sizeBytes > 0) ] | length),
        emptyCount: ([ $stats[] | select(.sizeBytes == 0) ] | length) }'
}

# The sessions THIS box started, and can therefore end.
#
# The third population on the board, and the only one the two sources above
# cannot name: a session resumed through daedalus runs as
# `claude-session@<uuid>.service` (stacks/daedalus/daedalus-verbs.nix), and the unit
# is its whole handle — `systemctl stop` SIGTERMs the cgroup. A session spawned
# by the Remote Control server looks identical in `claude agents` and has no
# per-session kill at all, so without this list the board would have to offer
# every live row the same button and be wrong about half of them.
#
# Root, not the operator: this is systemd's own state, not anything under
# ~/.claude.
managed_json() {
  "$SYSTEMCTL" list-units --type=service --all --no-legend --plain \
    'claude-session@*.service' 2>/dev/null |
    "$AWK" '$3 == "active" || $3 == "activating" { print $1 }' |
    "$SED" -n 's/^claude-session@\(.*\)\.service$/\1/p' |
    "$JQ" -Rn '[ inputs
                 | select(test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) ]'
}

roster_json() {
  local out
  # The third argument is the scan cache, which is the snapshot this unit
  # published on its last tick — see op_roster. It is read, never written,
  # and being absent is a cold scan rather than an error.
  out=$(as_operator_fn op_roster "$CLAUDE_HOME" "$CLI_STORE" "$OUT_DIR/claude.json" </dev/null || true)
  if printf '%s' "$out" | "$JQ" -e 'type == "object"' >/dev/null 2>&1; then
    printf '%s' "$out" | "$JQ" --argjson m "$(managed_json)" '. + { managedIds: $m }'
  else
    "$JQ" -n --argjson m "$(managed_json)" \
      '{ agentsAvailable: false, agents: [], transcripts: [],
         transcriptTotal: 0, emptyCount: 0, managedIds: $m }'
  fi
}

# Rendered into root's own /tmp first, so the counts below come from the
# private copy rather than a root read back out of the operator's directory.
doc=$(mktemp)
trap 'rm -f "$doc"' EXIT

"$JQ" -n \
  --argjson service "$(service_json)" \
  --argjson remote "$(remote_json)" \
  --argjson sessions "$(sessions_json)" \
  --argjson roster "$(roster_json)" \
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
      # Everything the box could still be asked about, as against the
      # `sessions` above, which is only what is connected right now.
      roster: $roster,
      credentials: $credentials,
      settings: $settings,
      # What the flake built, as against what the running server reported at
      # its own start. The two disagreeing IS the finding: a flake update
      # landed and nothing has restarted the unit onto it.
      cli: { version: $cliVersion, storePath: $cliStore }
    }
  }' >"$doc"
write_json_atomic "$OUT_DIR/claude.json" 0600 <"$doc"

# Same argument as the system snapshot: a successful oneshot has no lines of
# its own — systemd files "Starting"/"Finished" under init.scope — so without
# this the unit is invisible in Loki and could stop with nothing to see. The
# counts are the content: live sessions going to zero and staying there while
# the unit reports active is the interesting failure.
echo "published claude snapshot:" \
  "$("$JQ" -r '.data.service.activeState' "$doc") unit," \
  "$("$JQ" '[.data.sessions[] | select(.alive)] | length' "$doc") live sessions," \
  "$("$JQ" '.data.sessions | length' "$doc") session files," \
  "$("$JQ" '.data.roster.agents | length' "$doc") agents," \
  "$("$JQ" '.data.roster.transcriptTotal' "$doc") transcripts"
