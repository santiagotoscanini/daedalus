# Resume or end ONE Claude Code session, on request from daedalus.
#
# The most powerful verb on this bridge, and the reason its guards are longer
# than its work. Every other agent here starts a unit whose argv nix already
# fixed against a target nix already enumerated. This one causes root to start
# a process AS THE OPERATOR, in /etc/nixos, with passwordless sudo on PATH,
# the operator's Claude credentials and GitHub SSH identity, and an outbound
# channel that exposes that shell to claude.ai. Nothing about that is
# recoverable by a rollback, so the request is allowed to supply exactly one
# thing — a SELECTOR — and never a path, never a flag and never a directory.
#
# ── the three layers, in the order they run ───────────────────────────────
#
# 1. SYNTACTIC. The selector must be a canonical lowercase UUID (resume, and a
#    stop of a session this box started) or eight lowercase hex digits (a
#    background agent's short id). All 49 transcripts and 44 sidecar dirs on
#    this box match the first with zero exceptions. This alone kills `../`,
#    `;`, `$(…)`, spaces and systemd unit-name escapes, BEFORE the value is
#    interpolated anywhere.
#
# 2. EXISTENTIAL — the real allowlist. A uuid that passes the charset is still
#    just eight bytes of hex until something on disk answers to it. So the
#    agent enumerates ~/.claude/projects itself, AS THE OPERATOR (lib.sh's
#    rule: that tree is theirs, a planted link there must not be followed with
#    root's privilege), and requires `<id>.jsonl` to be a REGULAR FILE — `-f`,
#    and explicitly not a symlink. There is no path in the request to check,
#    because there is no path in the request: what gets composed is the
#    validated uuid under a NIX-RENDERED slug.
#
# 3. TRUSTED CWD ONLY. Nix renders the set of directories a resumed session
#    may run in (today: exactly one, the template unit's WorkingDirectory) and
#    a transcript found anywhere else is refused. This is not theatre. An
#    interactive `claude` in a directory whose trust has never been accepted
#    stops on "Is this a project you created or one you trust?" and starts
#    nothing — measured on this box, 2026-09-19. From a systemd unit that is a
#    hang with nobody able to answer the prompt: the unit would sit there
#    started and useless. Refusing up front with a sentence that says why is
#    strictly better than that.
#
# NO FLAGS FROM THE REQUEST, anywhere. claude-session@.service fixes the whole
# argv in nix. A `--permission-mode` the container could choose would be the
# whole ballgame, and so would `--add-dir`.
#
# ── idempotence ───────────────────────────────────────────────────────────
#
# `--resume` on a session that already has a process behind it does not attach
# to it: the CLI's own help says it "starts a copy and says so". Two processes
# appending to one transcript is not what a row reading "resumable" promises,
# so a double-click, a stale board, or a race with the operator's own console
# is refused here rather than deduplicated later. THIS, not forking, is why a
# live row offers no Resume — `--resume` reuses the id and continues the same
# transcript, measured both plain and with --remote-control.
#
# ── the ways a session ends, which are not interchangeable ────────────────
#
# A session WE started lives in `claude-session@<uuid>.service`, so ending it
# is `systemctl stop` — systemd SIGTERMs the cgroup, and there are no pid
# files and no pid-recycling race. A BACKGROUND agent (`claude --bg`) is the
# CLI's own lifecycle and ends with `claude stop <short id>`, which keeps the
# conversation so `claude attach` can reopen it. A session the Remote Control
# server spawned has no per-session kill at all; the agent says so rather than
# inventing one, and the page points at the server restart instead.
#
# ── what a verb here is allowed to check afterwards ───────────────────────
#
# Each verb is verified against the thing it actually changes, and getting
# that wrong is worse than not checking at all — a post-check that can never
# pass turns every success into a failed unit and a mail to the fleet.
#
#   stop (unit)    the unit is no longer active.
#   stop (agent)   NO PROCESS REMAINS behind the agent. NOT that the record
#                  vanished: `claude stop`'s own help says the conversation is
#                  kept and `claude attach <id>` opens it again, so the record
#                  is still there by design and always will be. The CLI's exit
#                  status is not the verdict either — it has its own internal
#                  "couldn't confirm" path that reports a failure for a stop
#                  that worked (and for one that had nothing to do, which is
#                  the common case here: all three background records on this
#                  box are `blocked` with no pid and no process). What settles
#                  it is `claude agents --json` reporting no pid for the id,
#                  or a pid whose /proc entry is gone.
#   remove         the record IS gone from `claude agents --json`. `claude rm`
#                  is the verb that deletes one — its help is explicit that,
#                  unlike `stop`, it works on an already-exited session — so
#                  here the absence of the record is exactly the right test.
#
# `remove` is offered to the dormant rows and only to them; it takes the
# record AND its worktree, which is why it is a separate verb rather than a
# fallback `stop` quietly reaches for.
#
# Refusals exit 0 (host/claude-rc.sh's split: the agent worked, and the
# refusal is rendered on the page that asked). Only the agent being unable to
# do its job exits 1 and leaves a failed unit for `systemctl --failed`.

set -euo pipefail

REQ="$APPLY_DIR/claude-session-request.json"
STATUS="$APPLY_DIR/claude-session-status.json"

PROJECTS="$CLAUDE_HOME/projects"

ACTION=""
SESSION=""
REQ_ID=""
STARTED_AT=""

write_status() {
  write_json_atomic "$STATUS" <<EOF
{"id":"$REQ_ID","action":$(jq -Rn --arg a "$ACTION" '$a'),"session":$(jq -Rn --arg s "$SESSION" '$s'),"state":"$1","detail":$(jq -Rn --arg d "${2-}" '$d'),"error":$(jq -Rn --arg e "${3-}" '$e'),"startedAt":"$STARTED_AT","finishedAt":"$(date -Is)"}
EOF
}

reject() {
  write_status failed "" "$1"
  echo "claude-session request rejected: $1" >&2
  exit 0
}

fail() {
  write_status failed "" "$1"
  echo "claude-session agent failure: $1" >&2
  exit 1
}

# ── the operator-side readers ─────────────────────────────────────────────
#
# Each of these runs under as_operator_fn, which carries the function's own
# source into a fresh bash and nothing else — so every binary below is a bare
# name that runtimeInputs put on PATH, and none of them may call a helper from
# this file. The child starts WITHOUT errexit; each handles its own failures.

# [operator] The NAME of the project directory holding <id>.jsonl, or nothing.
#
# A name, never a path: the caller matches it against the nix-rendered slugs
# and composes the path from those, so a directory the operator created is
# never a path this agent walks into. `-f` and `! -L` together are the
# existential allowlist — a regular file, and a link at that name refused
# outright rather than followed.
op_find_transcript() {
  local projects="$1" id="$2" d f
  shopt -s nullglob
  for d in "$projects"/*/; do
    f="$d$id.jsonl"
    if [ -f "$f" ] && [ ! -L "$f" ]; then
      printf '%s\n' "$(basename "$d")"
      return 0
    fi
  done
  return 0
}

# [operator] `claude agents --json`, or `[]`.
#
# The CLI's own view, and the only source at all for background agents. HOME
# is set explicitly because setpriv changes the uid and nothing else: without
# it the CLI reads root's home and answers an empty list, which reads exactly
# like "nothing is running" — and here that would turn a refusal into a start.
# `timeout` because a hung CLI must not wedge the agent.
op_agents() {
  local home="$1" cli="$2" out
  out=$(HOME="$home" timeout 10 "$cli/bin/claude" agents --json 2>/dev/null) || true
  if printf '%s' "$out" | jq -e 'type == "array"' >/dev/null 2>&1; then
    printf '%s' "$out"
  else
    printf '[]'
  fi
}

# [operator] "yes" when a LIVE process is already on session $2.
#
# ~/.claude/sessions/*.json is written by each session process and is the only
# list of them. Liveness compares /proc's start time against the one recorded
# in the file, exactly as host/claude-snapshot.sh does: testing that the pid
# merely EXISTS would read a recycled pid as a live session — and here the
# error that matters runs the other way, so a stale file must not permanently
# refuse a resume either.
op_session_live() {
  local home="$1" id="$2" f pid procStart startTicks
  shopt -s nullglob
  for f in "$home"/sessions/*.json; do
    [ "$(jq -r '.sessionId // ""' "$f" 2>/dev/null)" = "$id" ] || continue
    pid=$(jq -r '.pid // empty' "$f" 2>/dev/null)
    procStart=$(jq -r '.procStart // empty' "$f" 2>/dev/null)
    # Digits only: the value is spliced into /proc paths below.
    case "$pid" in
    "" | *[!0-9]*) continue ;;
    esac
    [ -r "/proc/$pid/stat" ] || continue
    # comm is parenthesised and may contain spaces and parens, so everything
    # through the LAST `)` goes first; starttime is then field 20.
    startTicks=$(sed -E 's/^[0-9]+ \(.*\) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $20}')
    if [ -n "$startTicks" ] && { [ -z "$procStart" ] || [ "$startTicks" = "$procStart" ]; }; then
      printf 'yes\n'
      return 0
    fi
  done
  return 0
}

# [operator] End a background agent. The CLI's own verb, run as its owner.
#
# Its exit status is deliberately NOT propagated as the outcome: the CLI has
# an internal confirmation of its own that reports a failure for a stop that
# worked, and it has nothing to do at all for an agent whose process is
# already gone. The caller checks the world instead — see the header.
op_stop_agent() {
  local home="$1" cli="$2" short="$3"
  HOME="$home" timeout 30 "$cli/bin/claude" stop "$short"
}

# [operator] Delete a background agent's record. `claude rm`, its own verb for
# a session that has already exited — and it takes the worktree too.
#
# No `--discard-unpushed`, ever: that flag throws away commits, the request
# carries no such value, and nothing here would know which worktree to name.
# If `rm` wants it, the operator can decide at a terminal.
op_rm_agent() {
  local home="$1" cli="$2" short="$3"
  HOME="$home" timeout 30 "$cli/bin/claude" rm "$short"
}

# ── the CLI's view of one background agent ────────────────────────────────
#
# Both readers take the agents array the caller already fetched AS THE
# OPERATOR and run in this shell: jq over a string root already has is not
# work that needs the operator's uid, and re-entering setpriv for it would
# only widen the window in which the answer could change.

# The record for $SESSION, or empty. `kind` is part of the identity: an
# interactive session's row carries no short id at all, so a match here is
# always a background agent.
agent_record() {
  printf '%s' "$1" | jq -c --arg s "$SESSION" '
    if type == "array"
    then (map(select((.id // "") == $s and (.kind // "") == "background"))[0] // empty)
    else empty end' 2>/dev/null || true
}

# The pid the CLI reports for it, or empty — and EMPTY IS THE ANSWER THAT
# MATTERS. A background record with no pid has no process behind it: that is
# what all three of this box's `blocked` records are, and what a stop leaves
# behind when it works. Digits only, because the value is spliced into /proc.
agent_pid() {
  local pid
  pid="$(printf '%s' "$1" | jq -r --arg s "$SESSION" '
    if type == "array"
    then (map(select((.id // "") == $s))[0] // {} | .pid // empty)
    else empty end' 2>/dev/null || true)"
  case "$pid" in
  "" | *[!0-9]*) return 0 ;;
  esac
  printf '%s\n' "$pid"
}

# The agents array, fetched fresh as the operator, or `[]`.
read_agents() {
  local out
  out="$(as_operator_fn op_agents "$OPERATOR_HOME" "$CLI_STORE" </dev/null || true)"
  printf '%s' "$out" | jq -e 'type == "array"' >/dev/null 2>&1 || out='[]'
  printf '%s' "$out"
}

# ── the request ───────────────────────────────────────────────────────────

[ -f "$REQ" ] || exit 0

# Read once, as the operator, never through a link (host/lib.sh); a symlinked
# request is refused with a failed unit — the app never writes one.
REQ_JSON="$(read_request "$REQ")" || exit 1

REQ_ID="$(jq -r '.id // ""' <<<"$REQ_JSON")"
[ -n "$REQ_ID" ] || exit 0
STARTED_AT="$(date -Is)"

# Replay guard, same as every bridge: the path unit re-fires on a
# daemon-reload replay at boot, and without this a reboot would re-run the
# last resume anybody pressed — starting a session nobody asked for.
if [ -f "$STATUS" ] && [ "$(published_id "$STATUS")" = "$REQ_ID" ]; then
  exit 0
fi

ACTION="$(jq -r '.action // ""' <<<"$REQ_JSON")"
SESSION="$(jq -r '.session // ""' <<<"$REQ_JSON")"

case "$ACTION" in
resume | stop | remove) ;;
*) reject "unknown action '$ACTION'" ;;
esac

# Layer 1. Nothing below this point sees a byte outside [0-9a-f-].
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
SHORT_RE='^[0-9a-f]{8}$'

IS_UUID=0
IS_SHORT=0
if [[ "$SESSION" =~ $UUID_RE ]]; then
  IS_UUID=1
elif [[ "$SESSION" =~ $SHORT_RE ]]; then
  IS_SHORT=1
fi

UNIT="claude-session@$SESSION.service"

if [ "$ACTION" = resume ]; then
  # A short id names a background agent, which is already running: there is
  # nothing to resume and `claude attach` is the verb for it.
  [ "$IS_UUID" = 1 ] || reject "not a session id: '$SESSION' is not a canonical lowercase uuid"

  # Layer 2. The allowlist is the tree itself.
  FOUND="$(as_operator_fn op_find_transcript "$PROJECTS" "$SESSION" </dev/null || true)"
  [ -n "$FOUND" ] ||
    reject "no transcript for $SESSION under ~/.claude/projects — there is nothing to resume"

  # Layer 3. Nix rendered both lists from one source, index for index.
  read -r -a SLUGS <<<"$TRUSTED_SLUGS"
  read -r -a CWDS <<<"$TRUSTED_CWDS"
  SLUG=""
  CWD=""
  for i in "${!SLUGS[@]}"; do
    if [ "${SLUGS[$i]}" = "$FOUND" ]; then
      SLUG="${SLUGS[$i]}"
      CWD="${CWDS[$i]}"
      break
    fi
  done
  if [ -z "$SLUG" ]; then
    reject "that session ran outside $TRUSTED_CWDS, and a session cannot be started in a directory whose workspace trust has never been accepted — it would stop on the trust prompt with nobody able to answer it"
  fi

  # Composed from the validated uuid and the NIX-RENDERED slug, never from
  # $FOUND. Re-tested because the two are the same string only when layer 2
  # and layer 3 agree, and this is the assertion that they did.
  TRANSCRIPT="$PROJECTS/$SLUG/$SESSION.jsonl"

  # Idempotence, from two sources, because they know different populations:
  # our own units, the CLI's agents, and the session files each live process
  # writes.
  AGENTS="$(as_operator_fn op_agents "$OPERATOR_HOME" "$CLI_STORE" </dev/null || true)"
  printf '%s' "$AGENTS" | jq -e 'type == "array"' >/dev/null 2>&1 || AGENTS='[]'

  UNIT_STATE="$(systemctl is-active "$UNIT" 2>/dev/null || true)"
  case "$UNIT_STATE" in
  active | activating | reloading)
    reject "$SESSION is already running as $UNIT — resuming it again would start a second process on the same transcript"
    ;;
  esac

  if printf '%s' "$AGENTS" | jq -e --arg id "$SESSION" \
    'any(.[]; (.sessionId // "") == $id)' >/dev/null 2>&1; then
    reject "$SESSION is already running (claude agents reports it) — a resume would start a copy, not attach"
  fi

  if [ "$(as_operator_fn op_session_live "$CLAUDE_HOME" "$SESSION" </dev/null || true)" = yes ]; then
    reject "$SESSION already has a live process behind it — a resume would start a copy, not attach"
  fi

  write_status running "resuming $SESSION in $CWD" ""

  # A previous instance that failed leaves the unit in `failed`, which nothing
  # clears on its own and which would otherwise stay in `systemctl --failed`
  # long after the page reported the real outcome.
  systemctl reset-failed "$UNIT" 2>/dev/null || true

  systemctl start "$UNIT" || fail "systemctl start $UNIT was refused — see journalctl -u $UNIT"

  # Type=simple: "started" only means exec'd. The failure this is here to
  # catch is the CLI exiting immediately — a transcript it will not open, a
  # credential that has expired, a trust prompt this agent did not predict —
  # which would otherwise leave a green request and a dead session.
  sleep 5
  STATE="$(systemctl is-active "$UNIT" 2>/dev/null || true)"
  [ "$STATE" = active ] ||
    fail "$UNIT is '$STATE' five seconds after starting — the session did not come up; see journalctl -u $UNIT"

  write_status "done" "resumed $SESSION in $CWD; it appears on claude.ai within a few seconds" ""
  # Named so the journal records which transcript this run reopened.
  echo "claude-session resumed $SESSION ($TRANSCRIPT)"
  exit 0
fi

# ── remove ────────────────────────────────────────────────────────────────
#
# A background agent's record, and nothing else. There is no `claude rm` for a
# session uuid and no reason to invent one: a transcript with nothing behind
# it is already the resumable pile, and deleting one is not something this
# bridge does.

if [ "$ACTION" = remove ]; then
  [ "$IS_SHORT" = 1 ] ||
    reject "not an agent id: remove takes an eight-digit background-agent id, and '$SESSION' is not one"

  AGENTS="$(read_agents)"
  [ -n "$(agent_record "$AGENTS")" ] ||
    reject "no background agent '$SESSION' — claude agents does not report one, so there is no record left to remove"

  write_status running "removing background agent $SESSION" ""

  # Its own exit status is worth reporting here, unlike `stop`'s: `rm` has no
  # liveness to confirm, so a non-zero exit is the CLI saying it did not
  # delete. The post-check below is still what decides.
  if ! RM_OUT="$(as_operator_fn op_rm_agent "$OPERATOR_HOME" "$CLI_STORE" "$SESSION" </dev/null 2>&1)"; then
    echo "claude rm $SESSION exited non-zero: $RM_OUT" >&2
  fi

  # THE check: a remove succeeded when the record is gone. (A stop's does not
  # look like this, and that difference is the whole of the bug above.)
  if [ -n "$(agent_record "$(read_agents)")" ]; then
    fail "claude agents still reports background agent $SESSION after claude rm — the record was not deleted; see the journal for this unit"
  fi

  write_status "done" "removed background agent $SESSION; its record and worktree are gone" ""
  echo "claude-session removed background agent $SESSION"
  exit 0
fi

# ── stop ──────────────────────────────────────────────────────────────────

if [ "$IS_UUID" = 1 ]; then
  # A session this box started. Its unit is the whole handle: systemd SIGTERMs
  # the cgroup and there is nothing else to find or match on.
  UNIT_STATE="$(systemctl is-active "$UNIT" 2>/dev/null || true)"
  case "$UNIT_STATE" in
  active | activating | reloading) ;;
  *)
    reject "$SESSION is not running as $UNIT (it is '$UNIT_STATE'), and a session this box did not start has no per-session kill — a Remote Control session ends with its server"
    ;;
  esac

  write_status running "stopping $UNIT" ""
  systemctl stop "$UNIT" || fail "systemctl stop $UNIT was refused — see journalctl -u $UNIT"

  STATE="$(systemctl is-active "$UNIT" 2>/dev/null || true)"
  case "$STATE" in
  active | activating | reloading)
    fail "$UNIT is still '$STATE' after the stop — see journalctl -u $UNIT"
    ;;
  esac

  write_status "done" "stopped $SESSION; its transcript is intact and it can be resumed again" ""
  exit 0
fi

[ "$IS_SHORT" = 1 ] ||
  reject "not a session id: '$SESSION' is neither a canonical lowercase uuid nor an eight-digit background-agent id"

# A background agent. The allowlist here is the CLI's own list: the id must be
# one it reports, and it must be a background one — an interactive session's
# row carries no id at all, and `claude stop` is not its verb.
AGENTS="$(read_agents)"

[ -n "$(agent_record "$AGENTS")" ] ||
  reject "no background agent '$SESSION' — claude agents does not report one, so there is nothing for claude stop to end"

write_status running "stopping background agent $SESSION" ""

# The CLI's own output goes to the JOURNAL and never into the status file.
# The status file is world-readable and bind-mounted into the container; what
# a background agent prints is session content, and content does not go in it.
if ! STOP_OUT="$(as_operator_fn op_stop_agent "$OPERATOR_HOME" "$CLI_STORE" "$SESSION" </dev/null 2>&1)"; then
  echo "claude stop $SESSION exited non-zero: $STOP_OUT" >&2
fi

# THE check, and it is about the PROCESS, not the record. The record survives
# a stop on purpose — `claude attach` reopens it — so "is it still listed?"
# can never pass and used to mail the fleet about a stop that had worked.
#
# Two ways for no process to remain, and both are a success: the CLI reports
# no pid for the id (the ordinary outcome, and already the resting state of
# every dormant record here), or it reports one whose /proc entry is gone —
# a stale pid in its own state, which is a process that is not running.
STOP_PID="$(agent_pid "$(read_agents)")"
if [ -n "$STOP_PID" ] && [ -d "/proc/$STOP_PID" ]; then
  fail "background agent $SESSION still has a live process (pid $STOP_PID) after claude stop — see the journal for this unit"
fi

if [ -n "$STOP_PID" ]; then
  echo "claude-session stopped background agent $SESSION (pid $STOP_PID is gone)"
else
  echo "claude-session stopped background agent $SESSION (no process behind it)"
fi

write_status "done" "stopped background agent $SESSION; nothing is running behind it. Its conversation is kept — claude attach reopens it, and Remove is what deletes the record" ""
