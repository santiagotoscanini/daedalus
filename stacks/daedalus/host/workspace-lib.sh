# Shared helpers for the two workspace agents (workspace-clone.sh,
# workspace-sync.sh). Inlined by their writeShellApplication wrappers after
# lib.sh; expects WORKSPACE_ROOT, OUT_DIR, OPERATOR_USER, OPERATOR_GROUP,
# OPERATOR_HOME, SETPRIV, ENV_BIN and GIT in the environment.
#
# A "workspace" is a working clone of a project repo under $WORKSPACE_ROOT,
# owned by the operator — the checkout a Claude Code session on this box works
# in. Every git command here runs AS the operator: the clones are theirs, the
# GitHub SSH identity (platform/git) is theirs, and root-made objects in a
# working tree are exactly the "unable to open loose object" trap CLAUDE.md
# warns about for /etc/nixos.

# setpriv, not runuser/sudo, for the same reason as deploy.sh: no PAM session
# lines in the journal for something that runs every half hour. Absolute
# paths because the child does not inherit this script's PATH for $GIT itself;
# PATH stays inherited so git finds ssh (runtimeInputs provides it).
git_op() {
  "$SETPRIV" --reuid="$OPERATOR_USER" --regid="$OPERATOR_GROUP" --init-groups --inh-caps=-all \
    "$ENV_BIN" HOME="$OPERATOR_HOME" \
    "$GIT" "$@"
}

# origin URL → owner/name, or "" for a remote that is not GitHub. The three
# spellings are the ones git actually writes; anything else publishes as null
# and the UI shows the workspace without a repo link rather than a wrong one.
slug_of() {
  local u="${1%.git}"
  case "$u" in
  git@github.com:*) printf '%s' "${u#git@github.com:}" ;;
  ssh://git@github.com/*) printf '%s' "${u#ssh://git@github.com/}" ;;
  https://github.com/*) printf '%s' "${u#https://github.com/}" ;;
  *) printf '' ;;
  esac
}

ensure_dirs() {
  install -d -m 0755 "$OUT_DIR" "$OUT_DIR/.state"
  install -d -m 0755 -o "$OPERATOR_USER" -g "$OPERATOR_GROUP" "$WORKSPACE_ROOT"
}

# One lock for every workspace mutation, clone and sync alike: the 30-minute
# timer, the deploy-triggered sync and a clone button can all fire inside the
# same minute, and two git processes in one half-cloned directory is how a
# workspace becomes neither the old state nor the new one.
lock_workspaces() {
  exec 9>"$OUT_DIR/.lock"
  flock -w 600 9
}

# Fetch always, move the branch only when that cannot lose anything. The
# clones are LIVE working trees — a session may have uncommitted edits or
# unpushed commits at any moment — so this never checks out, resets or
# merges anything but a fast-forward:
#
#   dirty tree        → fetch only; the tree is left exactly as found
#   diverged branch   → fetch only; reconciling is a person's (or session's) call
#   clean + behind    → fast-forward
#
# The outcome lands in $OUT_DIR/.state/<name> for publish_workspaces to fold
# into the snapshot, so the UI can say "left alone: uncommitted changes"
# instead of silently showing a workspace that stopped following its repo.
sync_workspace() {
  local dir="$1" name result detail err
  name="$(basename "$dir")"
  err="$(mktemp)"
  result=ok
  detail=""
  if ! git_op -C "$dir" fetch --quiet --prune 2>"$err"; then
    result=failed
    detail="fetch failed: $(tail -c 200 "$err" | tr '\n' ' ')"
  elif [ -n "$(git_op -C "$dir" status --porcelain 2>/dev/null)" ]; then
    result=dirty
    detail="uncommitted changes — left alone"
  elif ! git_op -C "$dir" merge --ff-only --quiet '@{upstream}' 2>"$err"; then
    result=blocked
    detail="not fast-forwardable: $(tail -c 200 "$err" | tr '\n' ' ')"
  fi
  rm -f "$err"
  jq -n --arg r "$result" --arg d "$detail" --arg at "$(date -Is)" \
    '{result: $r, detail: $d, at: $at}' >"$OUT_DIR/.state/$name"
  [ "$result" = ok ] || echo "workspace $name: $result — $detail"
}

# The published snapshot: one enveloped JSON with every clone's live git
# facts plus its last sync outcome. All facts are re-read from the trees at
# publish time — this is the one file the app trusts, so it must never carry
# a number the tree has moved past.
publish_workspaces() {
  local rows d name remote slug branch head head_at dirty counts ahead behind sync
  rows="$(mktemp)"
  for d in "$WORKSPACE_ROOT"/*/; do
    [ -d "${d}.git" ] || continue
    name="$(basename "$d")"
    remote="$(git_op -C "$d" remote get-url origin 2>/dev/null || true)"
    slug="$(slug_of "$remote")"
    branch="$(git_op -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    head="$(git_op -C "$d" rev-parse --short=12 HEAD 2>/dev/null || true)"
    head_at="$(git_op -C "$d" log -1 --format=%cI 2>/dev/null || true)"
    dirty=false
    [ -n "$(git_op -C "$d" status --porcelain 2>/dev/null)" ] && dirty=true
    # "<ahead>\t<behind>" against the upstream; empty (→ nulls) when the
    # branch tracks nothing, which the UI reports rather than inventing 0/0.
    counts="$(git_op -C "$d" rev-list --left-right --count 'HEAD...@{upstream}' 2>/dev/null || true)"
    ahead="${counts%%[[:space:]]*}"
    behind="${counts##*[[:space:]]}"
    sync="$(jq -c . "$OUT_DIR/.state/$name" 2>/dev/null || echo null)"
    jq -n \
      --arg name "$name" --arg slug "$slug" --arg branch "$branch" \
      --arg head "$head" --arg headAt "$head_at" --argjson dirty "$dirty" \
      --arg ahead "$ahead" --arg behind "$behind" --argjson sync "$sync" \
      '{
        name: $name,
        remote: (if $slug == "" then null else $slug end),
        branch: (if $branch == "" then null else $branch end),
        head: (if $head == "" then null else $head end),
        headAt: (if $headAt == "" then null else $headAt end),
        dirty: $dirty,
        ahead: (if $ahead == "" then null else ($ahead | tonumber) end),
        behind: (if $behind == "" then null else ($behind | tonumber) end),
        sync: $sync
      }' >>"$rows"
  done
  jq -s --arg root "$WORKSPACE_ROOT" --arg now "$(date -Is)" '{
    daedalusExport: 1,
    domain: "workspaces",
    schemaVersion: 1,
    source: "host",
    revision: null,
    generatedAt: $now,
    data: { root: $root, workspaces: . }
  }' "$rows" | write_json_atomic "$OUT_DIR/workspaces.json"
  rm -f "$rows"
}
