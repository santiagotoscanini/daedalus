# What only the HOST can say about Claude Code on this box.
#
# The dashboard's Claude page reads Remote Control itself — state, banner,
# live sessions, the login's dates, the model settings — from the controller,
# which runs it as the operator's `daedalus-claude-rc` user unit
# (stacks/daedalus/controller.nix). This snapshot is what the controller does
# not carry:
#
#   - The roster: every transcript on disk, the background agents
#     (`claude agents --json`) and the sessions this box started as
#     `claude-session@` units — what the page's Resume, Stop and Remove act on.
#   - The unit's accounting: memory and CPU of `daedalus-claude-rc` and every
#     session under it, from the operator's user manager.
#   - Per live session, what /proc and the bridge's debug log say: CPU, RSS,
#     the log's size and mtime (a clock the session file does not have).
#   - The login's scopes, which the controller's credential clock leaves out.
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
# refresh tokens for the operator's Claude account. `scopes_json` below names
# the one field it wants and copies only that. Selecting by name rather than
# deleting the secret keys is the direction that stays safe when upstream
# adds another.
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
# The unit is root for systemd: the user manager's accounting and the
# `claude-session@` units. Everything it reads out of
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
# The controller's Remote Control unit, from the operator's user manager
# (`-M <operator>@`, which root may ask). Its state is the controller's to
# report; what is read here is the accounting the controller does not carry:
# the whole unit, every session under it included.
unit_json() {
  local props mem cpu

  props=$("$SYSTEMCTL" --user -M "$OPERATOR_USER@" show "$CLAUDE_UNIT" \
    -p MemoryCurrent -p CPUUsageNSec 2>/dev/null || true)

  field() { printf '%s\n' "$props" | "$SED" -n "s/^$1=//p" | head -1; }

  mem=$(field MemoryCurrent)
  cpu=$(field CPUUsageNSec)

  # systemd reports accounting it does not have as the u64 sentinel, and a
  # unit that is not loaded as "[not set]". Both must become null: rendering
  # 18 exabytes of memory is worse than rendering a dash.
  case "$mem" in "[not set]" | 18446744073709551615) mem="" ;; esac
  case "$cpu" in "[not set]" | 18446744073709551615) cpu="" ;; esac

  "$JQ" -n --arg mem "$mem" --arg cpu "$cpu" '
    def n: if . == "" then null else tonumber end;
    { memoryBytes: ($mem | n), cpuNsec: ($cpu | n) }'
}

# ── the live sessions' cost ───────────────────────────────────────────────
#
# One file per session process, written by the process itself; the
# controller reports the files. What is added here is per LIVE process: its
# CPU and RSS, and the bridge's per-session debug log (size, and its mtime as
# a clock the session file does not keep). The page joins them by pid.
#
# Liveness compares /proc's start time against the one recorded in the file.
# Testing that the pid merely EXISTS is the bug this avoids — pids recycle,
# and a stale session file whose number now belongs to a podman helper would
# be drawn as a live remote session for as long as that helper ran.
session_stats_json() {
  local first=1 f
  printf '['
  for f in "$CLAUDE_HOME"/sessions/*.json; do
    [ -e "$f" ] || continue

    local pid procStart statLine startTicks utime stime pages
    local cpuMs rssBytes remoteId bridgeAt logBytes bridgeLog

    pid=$(as_operator "$JQ" -r '.pid // empty' "$f" 2>/dev/null || true)
    procStart=$(as_operator "$JQ" -r '.procStart // empty' "$f" 2>/dev/null || true)
    # Digits only. The pid is spliced into /proc paths below and what those
    # paths yield lands in shell arithmetic, which EVALUATES its operand: a
    # pid of `../../<somewhere>` pointing at a crafted file would be code run
    # as root. A real pid is a number, so nothing is lost.
    case "$pid" in
    "" | *[!0-9]*) continue ;;
    esac
    [ -r "/proc/$pid/stat" ] || continue

    # comm is parenthesised and may itself contain spaces and parens, so
    # everything through the LAST `)` goes first. What remains starts at
    # field 3, which puts starttime at 20 and utime/stime at 12 and 13.
    statLine=$("$SED" -E 's/^[0-9]+ \(.*\) //' "/proc/$pid/stat" 2>/dev/null || true)
    startTicks=$("$AWK" '{print $20}' <<<"$statLine")
    utime=$("$AWK" '{print $12}' <<<"$statLine")
    stime=$("$AWK" '{print $13}' <<<"$statLine")
    if [ -z "$startTicks" ] || { [ -n "$procStart" ] && [ "$startTicks" != "$procStart" ]; }; then
      continue
    fi

    cpuMs=$(((utime + stime) * 1000 / TICKS))
    pages=$(cut -d' ' -f2 "/proc/$pid/statm")
    rssBytes=$((pages * 4096))
    # The id claude.ai shows, which is NOT the transcript uuid inside the
    # session file: the bridge is launched with `--session-id cse_…` and the
    # command line is the only place the two are tied together.
    remoteId=$(tr '\0' '\n' <"/proc/$pid/cmdline" 2>/dev/null |
      { "$GREP" -m1 '^cse_' || true; })

    bridgeAt=""
    logBytes=""
    bridgeLog="$BRIDGE_LOG_DIR/bridge-session-$remoteId.log"
    if [ -n "$remoteId" ] && [ -r "$bridgeLog" ]; then
      bridgeAt=$(($(stat -c %Y "$bridgeLog") * 1000))
      logBytes=$(stat -c %s "$bridgeLog")
    fi

    [ "$first" = 1 ] || printf ','
    first=0

    "$JQ" -nc --arg pid "$pid" --arg cpuMs "$cpuMs" --arg rss "$rssBytes" \
      --arg bridgeAt "$bridgeAt" --arg logBytes "$logBytes" '
      def n: if . == "" then null else tonumber end;
      { pid: ($pid | tonumber), cpuMs: ($cpuMs | n), rssBytes: ($rss | n),
        logBytes: ($logBytes | n), bridgeAt: ($bridgeAt | n) }'
  done
  printf ']'
}

# ── the login's scopes ────────────────────────────────────────────────────
#
# One field, named. See the header: the same file holds the tokens.
scopes_json() {
  local f="$CLAUDE_HOME/.credentials.json"
  if [ ! -r "$f" ]; then
    printf '[]'
    return
  fi
  as_operator "$JQ" -c '(.claudeAiOauth.scopes // [])' "$f" 2>/dev/null || printf '[]'
}

# ── the roster: every session this box could still be asked about ─────────
#
# The controller reports the Remote Control roster and nothing else — one
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
# `scopes_json` does, rather than taking a record and deleting what is
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
  --argjson unit "$(unit_json)" \
  --argjson sessionStats "$(session_stats_json)" \
  --argjson roster "$(roster_json)" \
  --argjson scopes "$(scopes_json)" \
  --arg g "$(date -Is)" '{
    daedalusExport: 1,
    domain: "claude",
    schemaVersion: 1,
    source: "host",
    revision: null,
    generatedAt: $g,
    data: {
      unit: $unit,
      sessionStats: $sessionStats,
      # Everything the box could still be asked about, as against the live
      # sessions the controller reports.
      roster: $roster,
      scopes: $scopes
    }
  }' >"$doc"
write_json_atomic "$OUT_DIR/claude.json" 0600 <"$doc"

# Same argument as the system snapshot: a successful oneshot has no lines of
# its own — systemd files "Starting"/"Finished" under init.scope — so without
# this the unit is invisible in Loki and could stop with nothing to see.
echo "published claude snapshot:" \
  "$("$JQ" '.data.sessionStats | length' "$doc") live sessions," \
  "$("$JQ" '.data.roster.agents | length' "$doc") agents," \
  "$("$JQ" '.data.roster.transcriptTotal' "$doc") transcripts"
