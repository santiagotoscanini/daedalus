# Shared helpers for daedalus's host-side agents. Inlined by each script's
# writeShellApplication wrapper BEFORE the agent body; expects OPERATOR_USER,
# OPERATOR_GROUP and SETPRIV in the environment (set by the same wrapper).
#
# ── the trust boundary these helpers exist for ────────────────────────────
#
# The agents run as root and hear from the daedalus container through
# $APPLY_DIR, a directory the container can write — container root IS the
# operator's uid under rootless podman. Anything root does to a file BY NAME
# in such a directory (open, chmod, chown, copy, even read) lands on whatever
# the container put at that name by then. A symlink turns "publish
# status.json" into "write /etc/shadow", and "copy the payload into site/"
# into "commit /run/secrets/<x>". Checking first does not close it: the check
# and the use are two system calls, and the container runs between them.
#
# So the rule, for $APPLY_DIR and for every other directory the operator can
# write: root never touches a file there by name. Writes, reads and removals
# run AS the operator (setpriv), where a planted link reaches nothing the
# operator could not already reach — and every open also refuses to follow a
# link at all (O_NOFOLLOW through dd, O_EXCL through noclobber), because "the
# operator could already reach it" still includes ~/.ssh and the rest of the
# home directory, which the container's mount namespace cannot.
#
# Directories only root can write keep root's direct writes (write_json_atomic
# decides per call): nobody else can plant anything there.

# setpriv, not runuser/sudo: no PAM session per call, and some of these run
# every minute. --inh-caps=-all so nothing root held rides into the child.
# An agent whose unit already runs as the operator (`User=`) has nothing to
# drop — and setpriv's --init-groups would fail without CAP_SETGID — so there
# the command runs as it is.
as_operator() {
  if [ "$EUID" -ne 0 ]; then
    "$@"
    return
  fi
  "$SETPRIV" --reuid="$OPERATOR_USER" --regid="$OPERATOR_GROUP" --init-groups --inh-caps=-all "$@"
}

# Run one of the op_* functions below as the operator. setpriv execs a
# binary, so the function travels as its own source (`declare -f`) into a
# fresh bash — $BASH, the absolute store path this script already runs under,
# because a systemd unit's PATH carries no bash. The child starts WITHOUT
# errexit: every op_* function handles its own failures.
as_operator_fn() {
  local fn="$1"
  shift
  as_operator "$BASH" -c "$(declare -f "$fn"); $fn \"\$@\"" "$fn" "$@"
}

# git in a tree the operator owns — the configuration checkout and its site
# directory, the engine clone, the workspaces — as the operator, never root:
# root-made objects in a working tree are the "unable to open loose object"
# trap. With their HOME (their git config, known_hosts and the SSH identity
# platform/git gives them) and never a prompt: a fetch or push that wants a
# passphrase fails instead of hanging the unit. Absolute binaries, because a
# privilege-dropped child does not inherit writeShellApplication's PATH for the
# command itself; PATH stays, so git finds ssh. Expects ENV_BIN, GIT and
# OPERATOR_HOME (daedalus-lib.nix operatorHomeVars).
#
#   git_op <dir> <git arguments…>
git_op() {
  local dir="$1"
  shift
  as_operator "$ENV_BIN" HOME="$OPERATOR_HOME" GIT_TERMINAL_PROMPT=0 \
    GIT_SSH_COMMAND="ssh -o BatchMode=yes" "$GIT" -C "$dir" "$@"
}

# [operator] Can the operator create files in directory $1?
op_can_write() {
  [ -d "$1" ] && [ -w "$1" ] && [ -x "$1" ]
}

# [operator] Publish stdin as $1 with mode $2: a fresh temp beside the
# destination, then a rename. $3 = json refuses to publish bytes jq cannot
# parse; anything else copies bytes verbatim.
#
# The temp is created with O_EXCL (noclobber) and written, validated and
# renamed WITHOUT being reopened by name: validation reads the inode back
# through /proc/self/fd, so swapping the name for a link between create and
# rename changes nothing about which file was written. The mode comes from
# the umask at creation, for the same reason — a chmod is one more by-name
# call. A collision retries with a new name rather than following whatever
# is already there.
op_publish() {
  local dest="$1" mode="$2" check="$3" tmp=""
  umask "$(printf '%04o' $((~8#$mode & 8#777)))"
  set -o noclobber
  for _ in 1 2 3 4 5; do
    tmp="$(mktemp -u "${dest%/*}/.${dest##*/}.XXXXXXXXXX")" || return 1
    { exec 3>"$tmp"; } 2>/dev/null && break
    tmp=""
  done
  if [ -z "$tmp" ]; then
    echo "could not create a temp file beside $dest" >&2
    return 1
  fi
  if ! cat >&3; then
    exec 3>&-
    rm -f -- "$tmp"
    echo "could not write $dest" >&2
    return 1
  fi
  if [ "$check" = json ] && ! jq -e . </proc/self/fd/3 >/dev/null; then
    exec 3>&-
    rm -f -- "$tmp"
    echo "refusing to publish invalid JSON to $dest" >&2
    return 1
  fi
  exec 3>&-
  # -T: a directory planted at the destination fails the rename instead of
  # receiving the temp file inside it — and the temp is cleaned up, so a
  # refused publish leaves nothing behind in the directory.
  if ! mv -fT -- "$tmp" "$dest"; then
    rm -f -- "$tmp"
    return 1
  fi
}

# [operator] Append stdin to log file $1, never through a link.
#
# If the log cannot be opened — a link, a directory, a FIFO nobody reads —
# the rest of stdin is DRAINED rather than refused. The writer on the other
# end of this pipe is `nixos-rebuild switch`, and a sink that exits early
# SIGPIPEs it halfway through activation. A lost log is an inconvenience; a
# half-switched system is not. nonblock for the FIFO case: an open that waits
# for a reader would hold the rebuild lock for as long as nobody came.
op_append() {
  dd of="$1" oflag=append,nofollow,nonblock conv=notrunc status=none 2>/dev/null || cat >/dev/null
}

# The bytes of $1, read as the operator and never through a link. nonblock so
# a FIFO planted at the name reads as empty (or fails) instead of hanging the
# agent; it changes nothing for a regular file.
read_as_operator() {
  as_operator dd if="$1" iflag=nofollow,nonblock status=none
}

# A request file the container dropped, as text on stdout — or a journal line
# and a non-zero exit when it is not a file this agent will read.
#
# A symlink is refused outright. The app publishes requests by temp-and-rename
# (src/host/bridge.ts), so a link at a request name is never the app: it is
# something reaching for a file through the bridge. The `-L` test is the
# readable refusal; the O_NOFOLLOW read as the operator is what actually
# holds, because a link that appears after the test still cannot be followed
# and root's privilege is never lent to the open.
read_request() {
  if [ -L "$1" ]; then
    echo "refusing $1: it is a symlink, and the bridge only accepts regular files" >&2
    return 1
  fi
  read_as_operator "$1"
}

# The id in a status file this agent published earlier, or "" — what the
# replay guards compare against. Unreadable, unparseable or a link all answer
# "" (no earlier run), exactly what the direct `jq` read this replaces did
# with a file it could not parse.
published_id() {
  { read_as_operator "$1" 2>/dev/null || true; } | jq -r '.id // ""' 2>/dev/null || true
}

# Atomic publish for JSON the container polls. $2 is the mode (default 0644).
#
# `install /dev/stdin` wrote the destination in place, so every status
# transition had a window where a reader saw a truncated file — and the app's
# reader renders an unparseable status as "idle", which one poll into a
# twenty-minute rebuild reads as the apply having finished. Temp-and-rename
# closes the window; the temp lives beside the target because rename must not
# cross filesystems. jq validates before the rename so a torn heredoc (a
# killed script mid-write) can never be published as truth.
#
# Who writes depends on who else can. Into a directory the operator can write
# ($APPLY_DIR, the operator-owned /run snapshot dirs) the whole publish runs
# as the operator — see the header — and the file is born theirs, which is
# also what lets the rootless container read it. Into a root-only directory
# root writes directly and hands ownership over, as it always did: nothing
# else can reach the name.
write_json_atomic() {
  local dest="$1" mode="${2:-0644}" tmp
  if as_operator_fn op_can_write "$(dirname "$dest")" </dev/null; then
    as_operator_fn op_publish "$dest" "$mode" json
    return
  fi
  tmp="$(mktemp "$(dirname "$dest")/.$(basename "$dest").XXXXXX")"
  cat >"$tmp"
  if ! jq -e . "$tmp" >/dev/null; then
    rm -f "$tmp"
    echo "refusing to publish invalid JSON to $dest" >&2
    return 1
  fi
  chmod "$mode" "$tmp"
  chown "$OPERATOR_USER:$OPERATOR_GROUP" "$tmp"
  mv "$tmp" "$dest"
}

# ── the verbs' logs ───────────────────────────────────────────────────────
#
# A log in a directory only root can write (a root verb's, in the verbs
# directory) root writes by name, as write_json_atomic does there; nothing
# else can plant anything at the name. A log in a directory the operator can
# write (the bridge's) is created, truncated and appended as the operator
# through op_append, so root never opens it by name and never needs to chown
# one afterwards.

# Is $1's directory root's alone: root's, and writable by nobody else?
log_root_only() {
  local d m
  d="$(dirname -- "$1")"
  [ -d "$d" ] && [ ! -L "$d" ] && [ "$EUID" -eq 0 ] || return 1
  m="$(stat -c '%u %a' -- "$d")" || return 1
  [ "${m%% *}" = 0 ] && [ $((8#${m#* } & 8#022)) -eq 0 ]
}

# stdin appended to log $1, never failing and never stopping early: the
# writer may be `nixos-rebuild switch` (see op_append).
log_sink() {
  if log_root_only "$1"; then
    cat >>"$1" 2>/dev/null || cat >/dev/null
  else
    as_operator_fn op_append "$1"
  fi
}

# Empty log $1 (creating it). Best-effort: a log that cannot be reset is a
# worse log, never a failed rebuild.
log_reset() {
  if log_root_only "$1"; then
    : >"$1" 2>/dev/null || true
  else
    as_operator dd if=/dev/null of="$1" oflag=nofollow,nonblock status=none 2>/dev/null || true
  fi
}

# Append one line ($2) to log $1.
log_line() {
  printf '%s\n' "$2" | log_sink "$1"
}

# Run a command with stdout and stderr appended to log $1; returns the
# COMMAND's status, never the sink's. The pipeline waits for the sink to
# exit, so the log is complete by the time a caller reads it back (errtail).
# Call it in a condition (`if`, `||`): under errexit a failing pipeline
# elsewhere would end the script before the status could be returned.
log_run() {
  local log="$1"
  shift
  if "$@" 2>&1 | log_sink "$log"; then
    return 0
  fi
  return "${PIPESTATUS[0]}"
}

# The readable end of a failed run's log $1, for a status the UI shows.
#
# Nix states the cause on one `error: <what>` line, usually above or inside a
# stack trace. The old `tail -c 1200` started mid-line somewhere in that trace
# ("wOption loc}':" …) and could leave the cause out entirely. So the cause
# leads, then the last WHOLE lines that fit the budget — never a cut line.
# The rootless `--sdnotify=conmon` eval warnings are dropped: one per container,
# cosmetic, and left in they fill the window on their own.
#
# Read as the operator and never through a link (the log sits in the
# container's directory, and this is published in a status it reads). Never
# fails: callers run it in an assignment right before rollback, where an
# errexit would skip the rollback.
log_errtail() {
  { read_as_operator "$1" 2>/dev/null || true; } |
    grep -vE '^(evaluation warning: Podman container|[[:space:]]+with `--sdnotify=conmon)' |
    awk -v budget=1200 '
      { line[NR] = $0 }
      /^[[:space:]]*error: [^[:space:]]/ { cause = $0; sub(/^[[:space:]]+/, "", cause) }
      END {
        head = (cause != "") ? cause "\n\n" : ""
        used = length(head); n = 0
        for (i = NR; i >= 1; i--) {
          if (n == 0 && line[i] ~ /^[[:space:]]*$/) continue
          if (used + length(line[i]) + 1 > budget) break
          keep[++n] = line[i]; used += length(line[i]) + 1
        }
        tail = ""
        for (j = n; j >= 1; j--) tail = tail keep[j] "\n"
        if (cause != "" && index(tail, cause) > 0) head = ""
        printf "%s%s", head, tail
      }' || true
}

# ── the live-switch guard ─────────────────────────────────────────────────
#
# A generation whose kernel, initrd, module tree, ZFS, systemd major or D-Bus
# implementation differs from the running system's is never activated live
# (platform/upgrade-guard). Every generation refuses it in its own pre-switch
# check, which alone would make the verb's switch FAIL and roll back; asking
# first, right after the build, lets a verb report it as what it is — a change
# that is waiting for a reboot. Expects `fleet-switch-guard` on PATH.

# The toplevel the last `nixos-rebuild build` logged to $1 produced. Both
# implementations end a build with "Done. The new configuration is <path>",
# the path on stdout.
built_toplevel() {
  { read_as_operator "$1" 2>/dev/null || true; } |
    grep -oE "/nix/store/[a-z0-9]{32}-nixos-system-[^[:space:]'\"]+" | grep -v '\.drv$' | tail -n 1 || true
}

# Prints the guard's reasons and returns 0 when the generation built into log
# $1 needs a reboot; returns 1 when it may be activated. A log that names no
# generation, or a guard that cannot answer, returns 1 too: the activation
# then meets the generation's own check, which fails closed.
reboot_required() {
  local top out rc=0
  top="$(built_toplevel "$1")"
  [ -n "$top" ] || return 1
  out="$(fleet-switch-guard "$top" 2>&1)" || rc=$?
  [ "$rc" -eq 3 ] || return 1
  printf '%s\n' "$out"
}

# The status text for that outcome: the reasons, then how to take the change.
# $1 reasons, $2 what happened to the change, in a sentence.
reboot_note() {
  printf '%s\n\n%s Install it for the next boot and reboot:\n  sudo nixos-rebuild boot --flake %s#%s && sudo systemctl reboot' \
    "$1" "$2" "$FLAKE" "$HOSTNAME"
}

# ── the engine override ───────────────────────────────────────────────────
#
# site.json's `developer.engineOverride`: `true` to build from the engine
# clone on this box, anything else for the pinned engine. Nix never reads the
# key; the agents that rebuild or move a pin do, at run time — apply.sh builds
# from the clone (`--override-input`, lock untouched) and activates with
# `test` rather than `switch`; image-update.sh, engine-update.sh,
# version-update.sh and claude-code-update.sh refuse, because a pin moved
# under an override would name a rev nothing is running. Read here, once, so
# they cannot disagree about where the key lives.
#
# A switch, never a path. The document is written by the app, and whatever
# the app names, root evaluates as nix: a path in it once let an admin session
# (or anything that could forge one) point root's build at a tree it wrote.
# Which clone is the engine clone is nix's fact (apply.sh's ENGINE_CLONE), not
# the document's.
#
# Prints `on`, or nothing: no site.json, an unreadable one, a missing key, or
# any value but the boolean `true` all mean "no override". Read as the
# operator and never through a link. Expects SITE_DIR (fleet.site.path) in
# the environment; never fails.
site_engine_override() {
  [ -f "$SITE_DIR/site.json" ] || return 0
  { read_as_operator "$SITE_DIR/site.json" 2>/dev/null || true; } |
    jq -r 'if .developer.engineOverride == true then "on" else empty end' 2>/dev/null || true
}

# ── the workspace lock, from root ─────────────────────────────────────────
#
# The engine clone is also a workspace, and the 30-minute sync and the clone
# verb run git in every workspace under `$WORKSPACES_DIR/.lock`
# (workspace-lib.sh lock_workspaces). A root agent that fetches, merges or
# commits in the clone takes the same lock, on fd 8, so two git processes
# never work one tree at once. Released by `exec 8<&-`, or at exit.
#
# The directory is the operator's (mounted read-only into the container). The
# file is created as the operator — the workspace units open it for writing,
# as the operator — and root opens it READ-ONLY, which is all flock needs:
# a link or anything but a regular file is refused, and a read-only open
# changes nothing about whatever might sit at the name. Expects
# WORKSPACES_DIR; waits up to ten minutes, like the workspace units.
lock_workspaces_root() {
  local f="$WORKSPACES_DIR/.lock"
  as_operator dd if=/dev/null of="$f" oflag=append,nofollow,nonblock conv=notrunc status=none 2>/dev/null || true
  if [ -L "$f" ] || [ ! -f "$f" ]; then
    echo "refusing the workspace lock $f: it is not a regular file" >&2
    return 1
  fi
  exec 8<"$f"
  flock -w 600 8
}

# ── who the box's commits are made as ─────────────────────────────────────
#
# site.json's `commits.author` picks one of the git identities nix baked into
# this script: `operator` is GIT_OPERATOR_NAME / GIT_OPERATOR_EMAIL
# (fleet.operator.gitName / gitEmail); anything else — no site.json, an
# unreadable one, the default `box`, or a value this script does not know —
# is the box's own: the caller's name (daedalus by default) with GIT_EMAIL.
# The document names a choice, never a name or an address, so a planted value
# can only pick one of the two. Read as the operator and never through a link,
# like the override above. Both print; neither fails.
#
#   git -c "user.name=$(commit_name)" -c "user.email=$(commit_email)" commit …
commit_as_operator() {
  if [ -z "${GIT_OPERATOR_NAME:-}" ] || [ -z "${GIT_OPERATOR_EMAIL:-}" ]; then return 1; fi
  [ -f "$SITE_DIR/site.json" ] || return 1
  [ "$({ read_as_operator "$SITE_DIR/site.json" 2>/dev/null || true; } |
    jq -r '.commits.author // empty' 2>/dev/null || true)" = operator ]
}
commit_name() {
  if commit_as_operator; then printf '%s' "$GIT_OPERATOR_NAME"; else printf '%s' "${1:-daedalus}"; fi
}
commit_email() {
  if commit_as_operator; then printf '%s' "$GIT_OPERATOR_EMAIL"; else printf '%s' "$GIT_EMAIL"; fi
}

# ── the root helper's run file ────────────────────────────────────────────
#
# A root verb whose values no list can hold (a slug, a key name) or that
# carries a payload (a sealed secret) is a template unit, started by the
# helper as `<unit>@<run id>` after it wrote the request to
# `<rootRunDir>/<run id>.json` (stacks/daedalus controller.nix, the header's
# `run file`) — root's, 0600, in a directory only root can open. The unit runs
# as the operator and never opens it: systemd reads it as root and hands it
# over as the credential `request` (`LoadCredential=request:…/%i.json`), a
# private read-only copy in $CREDENTIALS_DIRECTORY that goes when the unit
# stops. This prints it; it fails, with a journal line, when the unit was
# started without one.
take_request() {
  local f="${CREDENTIALS_DIRECTORY:-}/request"
  if [ -z "${CREDENTIALS_DIRECTORY:-}" ] || [ ! -f "$f" ]; then
    echo "no request credential: this unit is started by the root helper" >&2
    return 1
  fi
  cat -- "$f"
}

# The run's id: the helper's, which a verb's status carries and the page that
# started it waits on.
run_id() {
  take_request | jq -r '.id'
}

# The run's payload — the request the app built — as a JSON object: `{}` when
# it is not one, so the verb's own validation names what is missing.
run_payload() {
  take_request |
    jq -c '(.payload | if type == "string" then (try fromjson catch {}) else {} end) | if type == "object" then . else {} end'
}

# ── how a root verb's run ended ───────────────────────────────────────────
#
# A root verb's unit tells the helper how its run ended in ONE journal entry
# (agent src/root/mod.rs, "Running a verb"): DAEDALUS_OUTCOME (`done` or
# `refused`), DAEDALUS_DETAIL (the words, on one line) and DAEDALUS_INVOCATION
# ($INVOCATION_ID, which systemd sets for every unit). The helper finds it by
# that invocation, never by what a line says, so nothing a unit prints — a
# git error, a log line from a repository — can pass for a refusal. The words
# are printed too, for the unit's own journal and the page's progress.
#
# `verb_done` and `refuse` are how a script says it. A refusal is not a
# failure: the unit declined, exits 0, and leaves no failed unit and no mail.
# A unit that exits 0 without an outcome entry is `done` with its last line;
# a non-zero exit is `failed`, whatever it said. Needs `logger` (util-linux)
# on PATH. Never fails: an entry that could not be written leaves the helper
# to read the run by its last line.
outcome() {
  local kind="$1" words="${2-}"
  printf '%s\n' "$words"
  printf 'MESSAGE=outcome: %s\nDAEDALUS_OUTCOME=%s\nDAEDALUS_DETAIL=%s\nDAEDALUS_INVOCATION=%s\n' \
    "$kind" "$kind" "$(printf '%s' "$words" | tr '\n\r' '  ' | head -c 2000)" "${INVOCATION_ID:-}" |
    logger --journald 2>/dev/null || true
}

# The run did what it was asked; $1 says what. The script goes on.
verb_done() {
  outcome 'done' "$1"
}

# Decline the run with reason $1 and end it: exit 0, `refused`.
refuse() {
  outcome refused "$1"
  exit 0
}
