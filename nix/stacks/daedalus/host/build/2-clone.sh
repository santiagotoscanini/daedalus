# host/build/2-clone.sh — stage 2 of the build (see host/build.sh).
#
# Fetch the default branch's tip as the build user, check out the requested
# commit (or finish as superseded), decide the strategy — Railpack or the
# repository's Dockerfile — and read the repository's facts for the status.
#
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
