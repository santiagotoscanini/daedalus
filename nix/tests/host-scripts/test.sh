# shellcheck shell=bash disable=SC2016,SC2034
# (check() evaluates its condition, so the variables in it are single-quoted
# on purpose and read there.)
#
# The root verbs' git and rollback behaviour, run for real against temp
# repositories. Nothing here is root: the agents' privilege drop (setpriv) is
# stubbed to run the command as the caller, and nixos-rebuild, curl and gpg
# are stubs that record or fake what they would have done. Each case is the
# regression test for a bug that cost, or could have cost, the operator's
# work. Expects HOST (the agents' host/ directory) in the environment.
set -euo pipefail

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home"
mkdir -p "$HOME" "$T/bin"
git config --global user.name test
git config --global user.email test@example.org
git config --global init.defaultBranch main

# A stub command on PATH, from stdin: its shebang is this bash, since the
# build sandbox has no /usr/bin/env.
stub() {
  { echo "#!$BASH"; cat; } >"$T/bin/$1"
  chmod +x "$T/bin/$1"
}

# setpriv without the privilege: drop its options, run the command.
stub setpriv <<'EOF'
while [ "$#" -gt 0 ] && [ "${1#--}" != "$1" ]; do shift; done
exec "$@"
EOF
export PATH="$T/bin:$PATH"

OPERATOR_USER="$(id -un)"
OPERATOR_GROUP="$(id -gn)"
ENV_BIN="$(command -v env)"
GIT="$(command -v git)"
export OPERATOR_USER OPERATOR_GROUP ENV_BIN GIT OPERATOR_HOME="$HOME" SETPRIV="$T/bin/setpriv"
export GIT_EMAIL=box@example.org GIT_OPERATOR_NAME=op GIT_OPERATOR_EMAIL=op@example.org
export HOSTNAME=testhost

# An agent as mkAgent assembles it: the given lines, then the host files.
agent() {
  local out="$1" head="$2"
  shift 2
  { printf '%s\n' "$head"; for f in "$@"; do cat "$HOST/$f"; done; } >"$out"
}

fails=0
check() {
  if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; fails=$((fails + 1)); fi
}

# A tree's whole state: HEAD, the index, the work tree, untracked files.
tree_state() {
  git -C "$1" rev-parse HEAD
  git -C "$1" status --porcelain=v1 --untracked-files=all
  git -C "$1" diff --cached --binary
  git -C "$1" diff --binary
  (cd "$1" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 sha256sum)
}

# ── 1. a refused push leaves a dirty engine clone byte-for-byte ────────────
echo "# claude-code-update: refused push"
O="$T/engine.git"
C="$T/engine"
git init -q --bare "$O"
printf '#!%s\necho "push refused by test" >&2\nexit 1\n' "$BASH" >"$O/hooks/pre-receive"
chmod +x "$O/hooks/pre-receive"
git clone -q "$O" "$C" 2>/dev/null
mkdir -p "$C/nix/platform/claude-code"
echo '{"version":"1.0.0","platforms":{"linux-x64":{"binary":"claude.zst"}}}' >"$C/nix/platform/claude-code/manifest.zst.json"
echo committed >"$C/work.txt"
git -C "$C" add -A
git -C "$C" commit -qm init
# Pushed past the hook: the bare repo takes this one push.
mv "$O/hooks/pre-receive" "$O/hooks/off"
git -C "$C" push -q origin main 2>/dev/null
mv "$O/hooks/off" "$O/hooks/pre-receive"
# The operator's work in progress: an unstaged edit, a staged new file, an
# untracked file.
echo "edited, not staged" >>"$C/work.txt"
echo staged >"$C/staged.txt"
git -C "$C" add staged.txt
echo untracked >"$C/untracked.txt"
before="$(tree_state "$C")"

F="$T/config"
mkdir -p "$F"
jq -n --arg u "file://$C" '{root: "root", nodes: {root: {inputs: {daedalus: "daedalus"}}, daedalus: {original: {type: "git", url: $u, ref: "main"}, locked: {rev: "x"}}}}' >"$F/flake.lock"
A="$T/apply"
W="$T/workspaces"
mkdir -p "$A" "$W" "$T/site"
mkdir -p "$A/creds"
jq -n '{id: "aaaa1", verb: "claude-code-update", selectors: {}, payload: ({actor: "test"} | tojson)}' >"$A/creds/request"

stub curl <<'EOF'
out=/dev/stdout
while [ "$#" -gt 0 ]; do
  case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac
  shift
done
case "$url" in
*/latest) echo 1.0.1 >"$out" ;;
*/manifest.zst.json) echo '{"version":"1.0.1","platforms":{"linux-x64":{"binary":"claude.zst"}}}' >"$out" ;;
*) echo fake >"$out" ;;
esac
EOF
stub gpg <<'EOF'
case " $* " in *" --fingerprint "*) echo "fpr:::::::::31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE:" ;; esac
exit 0
EOF

agent "$T/cc.sh" "" lib.sh claude-code-update.sh
rc=0
CREDENTIALS_DIRECTORY="$A/creds" VERBS_DIR="$A" FLAKE="$F" SITE_DIR="$T/site" WORKSPACES_DIR="$W" bash "$T/cc.sh" >"$T/cc.out" 2>&1 || rc=$?
check "the run fails" '[ "$rc" -ne 0 ]'
check "at committing, saying the commit was undone" \
  'jq -e ".state == \"failed\" and .phase == \"committing\" and (.error | test(\"undone\"))" "$A/claude-code-update-status.json" >/dev/null'
check "the clone is byte-for-byte as it was" '[ "$(tree_state "$C")" = "$before" ]'
[ "$fails" -eq 0 ] || cat "$T/cc.out"

# ── 2. site_commit commits only the files it is named ─────────────────────
echo "# site_commit: named files only"
R="$T/repo"
mkdir -p "$R/site/vault"
git init -q "$R"
echo '{"apps":1}' >"$R/site/apps.json"
echo sealed-1 >"$R/site/vault/x.sops"
git -C "$R" add -A
git -C "$R" commit -qm init
echo '{"apps":2}' >"$R/site/apps.json"
echo sealed-2 >"$R/site/vault/x.sops"
git -C "$R" add -A
(
  # shellcheck disable=SC1091
  source "$HOST/lib.sh"
  # shellcheck disable=SC1091
  source "$HOST/site-lib.sh"
  SITE_DIR="$R/site"
  site_commit "secrets: x" test vault/x.sops >/dev/null
)
check "the commit holds the named file" '[ "$(git -C "$R" show --name-only --format= HEAD)" = "site/vault/x.sops" ]'
check "the other staged file is still staged, uncommitted" \
  '[ "$(git -C "$R" diff --cached --name-only)" = "site/apps.json" ]'

# ── 3. an Apply whose build fails never switches ──────────────────────────
echo "# apply: build failure"
R="$T/conf"
mkdir -p "$R/site"
git init -q "$R"
echo '{"apps":"old"}' >"$R/site/apps.json"
echo "{ }" >"$R/other.nix"
git -C "$R" add -A
git -C "$R" commit -qm init
echo "{ edited = true; }" >"$R/other.nix"
head_before="$(git -C "$R" rev-parse HEAD)"
A="$T/apply2"
mkdir -p "$A" "$T/prev"
mkdir -p "$A/creds"
jq -n '{id: "bbbb2", verb: "apply", selectors: {}, payload: ({commit: true, summary: "test", actor: "test", files: {"apps.json": "{\"apps\":\"new\"}\n"}} | tojson)}' \
  >"$A/creds/request"

stub nixos-rebuild <<'EOF'
echo "$1" >>"$CALLS"
[ "$1" != build ] || { echo "error: the build failed (test)"; exit 1; }
EOF
export CALLS="$T/rebuild-calls"
: >"$CALLS"

agent "$T/apply.sh" "VAULT_APP_SECRETS=()" lib.sh site-lib.sh apply.sh
rc=0
CREDENTIALS_DIRECTORY="$A/creds" VERBS_DIR="$A" PREV_DIR="$T/prev" FLAKE="$R" SITE_DIR="$R/site" ENGINE_CLONE="$T/none" \
  LOCKFILE="$T/rebuild.lock" SITE_LOCK="$T/site.lock" bash "$T/apply.sh" >"$T/apply.out" 2>&1 || rc=$?
check "the Apply fails" '[ "$rc" -ne 0 ]'
check "at building" 'jq -e ".state == \"failed\" and .phase == \"building\"" "$A/apply-status.json" >/dev/null'
check "nixos-rebuild only ever built" '[ "$(cat "$CALLS")" = build ]'
check "nothing was committed" '[ "$(git -C "$R" rev-parse HEAD)" = "$head_before" ]'
check "apps.json is back, index and work tree" \
  '[ "$(cat "$R/site/apps.json")" = "{\"apps\":\"old\"}" ] && git -C "$R" diff --quiet HEAD -- site'
check "the unrelated edit is untouched" '[ "$(cat "$R/other.nix")" = "{ edited = true; }" ]'

# ── 4. as_operator under a unit that already runs as the operator ─────────
# Not root, so nothing to drop: the command runs as it is, setpriv never
# (the real one's --init-groups fails without CAP_SETGID).
echo "# as_operator: not root"
stub setpriv-refuses <<'EOF'
echo "setpriv called" >&2
exit 1
EOF
agent "$T/as-op.sh" 'set -euo pipefail' lib.sh
echo 'as_operator "$BASH" -c "echo ran"; as_operator false || echo "status kept"' >>"$T/as-op.sh"
out="$(SETPRIV="$T/bin/setpriv-refuses" bash "$T/as-op.sh" 2>&1)" || true
check "the command runs, setpriv does not" '[ "$out" = "$(printf "ran\nstatus kept")" ]'

# ── 5. a refusal is one structured journal entry, and exit 0 ──────────────
# The root helper reads a run's outcome from DAEDALUS_OUTCOME, matched by
# the unit's invocation (agent src/root/mod.rs): never from a line's text.
echo "# outcome: refuse"
stub logger <<'EOF'
cat >>"$LOGGED"
EOF
export LOGGED="$T/logged"
: >"$LOGGED"
agent "$T/refuse.sh" 'set -euo pipefail' lib.sh
printf '%s\n' 'refuse "an apply is running' 'twice over"' 'echo "not reached"' >>"$T/refuse.sh"
rc=0
out="$(bash "$T/refuse.sh" 2>&1)" || rc=$?
check "a refusal exits 0" '[ "$rc" -eq 0 ]'
check "and stops the run" '! grep -q "not reached" <<<"$out"'
check "the entry says refused, on one line" \
  'grep -qx "DAEDALUS_OUTCOME=refused" "$LOGGED" && grep -qx "DAEDALUS_DETAIL=an apply is running twice over" "$LOGGED"'
: >"$LOGGED"
agent "$T/done.sh" 'set -euo pipefail' lib.sh
echo 'verb_done "rebooting"; echo after' >>"$T/done.sh"
out="$(INVOCATION_ID=inv2 bash "$T/done.sh" 2>&1)"
check "done goes on, and says done" \
  '[ "$out" = "$(printf "rebooting\nafter")" ] && grep -qx "DAEDALUS_OUTCOME=done" "$LOGGED"'

# ── 6. the build reads its request from the run file, and only there ───────
# The root helper hands it over as the `request` credential; an id that could
# name a path is refused before anything is made of it.
echo "# build: the request is the run file's payload"
B="$T/build"
mkdir -p "$B/creds" "$B/verbs"
agent "$T/build.sh" "VERBS_DIR=$B/verbs NPM_MIRROR_HOST= SETPRIV=setpriv BUILD_USER=nobody BUILD_GROUP=nogroup" \
  lib.sh build.sh build-stages/states.sh build-stages/helpers.sh build-stages/0-request.sh
rc=0
out="$(bash "$T/build.sh" 2>&1)" || rc=$?
check "no credential: the run fails, saying why" '[ "$rc" -eq 1 ] && grep -q "no request credential" <<<"$out"'
jq -n '{id: "r1", verb: "build", selectors: {}, payload: ({version: 1, id: "../etc"} | tojson)}' >"$B/creds/request"
rc=0
out="$(CREDENTIALS_DIRECTORY="$B/creds" bash "$T/build.sh" 2>&1)" || rc=$?
check "a path-shaped build id is refused" '[ "$rc" -eq 1 ] && grep -q "no usable build id" <<<"$out"'
check "and nothing is published" '[ -z "$(ls -A "$B/verbs")" ]'

# ── 6b. a run that ended before the build published answers for its build ──
# The fence check (ExecStartPre) refusing the start runs no build.sh at all:
# the reaper publishes the failure under the request's build id, so the build
# is not left queued with no words.
echo "# build-reaper: a run that never started"
mkdir -p "$B/reaper"
agent "$T/reaper.sh" "STATUS=$B/reaper/build-status.json LOG_DIR=$B/reaper WORK_ROOT=$B/reaper SETPRIV=setpriv BUILD_USER=nobody BUILD_GROUP=nogroup" \
  lib.sh build-stages/states.sh build-reaper.sh
echo '{"version":1,"id":"0ld1","state":"succeeded","phase":"done"}' >"$B/reaper/build-status.json"
jq -n '{id: "r2", verb: "build", selectors: {}, payload: ({version: 1, id: "abc123", app: "chismed", sha: "deadbeef"} | tojson)}' >"$B/creds/request"
SERVICE_RESULT=success CREDENTIALS_DIRECTORY="$B/creds" bash "$T/reaper.sh"
check "a clean run leaves the status alone" 'jq -e ".id == \"0ld1\"" "$B/reaper/build-status.json" >/dev/null'
SERVICE_RESULT=exit-code CREDENTIALS_DIRECTORY="$B/creds" bash "$T/reaper.sh"
check "a failed start fails its own build, saying the builder may be unfenced" \
  'jq -e ".id == \"abc123\" and .app == \"chismed\" and .state == \"failed\" and (.error | test(\"unfenced\"))" "$B/reaper/build-status.json" >/dev/null'

# ── 7. a cancel stops only the named app's build ──────────────────────────
echo "# build-cancel"
stub systemctl <<'EOF'
echo "$*" >>"$CALLS"
EOF
: >"$CALLS"
: >"$LOGGED"
agent "$T/cancel.sh" "STATUS=$B/verbs/build-status.json BUILDABLE='blog shop'" \
  lib.sh build-stages/states.sh build-cancel.sh
echo '{"id":"0b6f3c1e-8a2d","app":"blog","state":"building"}' >"$B/verbs/build-status.json"
rc=0
bash "$T/cancel.sh" shop >/dev/null 2>&1 || rc=$?
check "another app's build is refused, exit 0, nothing stopped" \
  '[ "$rc" -eq 0 ] && grep -qx "DAEDALUS_OUTCOME=refused" "$LOGGED" && [ ! -s "$CALLS" ]'
bash "$T/cancel.sh" blog >/dev/null 2>&1
check "its own is stopped, whatever run it is" '[ "$(cat "$CALLS")" = "stop daedalus-build@*.service" ]'

# ── 8. an image update reads its request from the run file ────────────────
# The run's id is the status's id (the page waits for it); a request naming
# nothing is refused in `validating`, before anything is pulled or edited.
echo "# image-update: the request is the run file's payload"
I="$T/image"
mkdir -p "$I/creds" "$I/verbs"
echo '{}' >"$I/pins.json"
agent "$T/image.sh" "VERBS_DIR=$I/verbs FLAKE=$T/none SITE_DIR=$T/none PINS=$I/pins.json" \
  lib.sh image-update.sh
jq -n '{id: "a1b2c3d4e5f60718", verb: "image-update", selectors: {}, payload: ({targets: [], actor: "t"} | tojson)}' \
  >"$I/creds/request"
rc=0
CREDENTIALS_DIRECTORY="$I/creds" bash "$T/image.sh" >/dev/null 2>&1 || rc=$?
check "an empty request fails in validating, under the run's id" \
  '[ "$rc" -eq 1 ] && jq -e ".id == \"a1b2c3d4e5f60718\" and .state == \"failed\" and .phase == \"validating\" and (.error | test(\"no container\"))" "$I/verbs/image-update-status.json" >/dev/null'

# ── 9. a version update reads its request from the run file ───────────────
echo "# version-update: the request is the run file's payload"
V="$T/version"
mkdir -p "$V/creds" "$V/verbs"
agent "$T/version.sh" "VERBS_DIR=$V/verbs FLAKE=$T/none SITE_DIR=$T/none PINS=$I/pins.json" \
  lib.sh version-update.sh
jq -n '{id: "b2c3d4e5f6071829", verb: "version-update", selectors: {}, payload: "not json"}' \
  >"$V/creds/request"
rc=0
CREDENTIALS_DIRECTORY="$V/creds" bash "$T/version.sh" >/dev/null 2>&1 || rc=$?
check "a payload that is not a request fails in validating, under the run's id" \
  '[ "$rc" -eq 1 ] && jq -e ".id == \"b2c3d4e5f6071829\" and .state == \"failed\" and .phase == \"validating\" and (.error | test(\"no well-formed target\"))" "$V/verbs/version-update-status.json" >/dev/null'

# ── 10. a Claude Code pin run is the pin, then the rebuild, in one run ─────
# The `claude-code-update` verb names the engine update's unit: its script
# runs the pin first and goes on, under the same run id, only when the pin
# moved something. (The pin's own variables are its script's, as mkAgent
# embeds them; the engine's here name a configuration without the input, so
# its half ends in validating.)
echo "# claude-code-update: the pin, then the engine update"
rm -f "$O/hooks/pre-receive"
E="$T/engine-run"
mkdir -p "$E/verbs"
stub cc-pin <<EOF2
VERBS_DIR="$E/verbs" FLAKE="$T/config" SITE_DIR="$T/site" WORKSPACES_DIR="$T/workspaces" exec bash "$T/cc.sh"
EOF2
agent "$T/engine.sh" "VERBS_DIR=$E/verbs FLAKE=$T/none SITE_DIR=$T/none CLAUDE_CODE_PIN=$T/bin/cc-pin" \
  lib.sh engine-update.sh
rc=0
CREDENTIALS_DIRECTORY="$T/apply/creds" bash "$T/engine.sh" >"$T/cc2.out" 2>&1 || rc=$?
check "the pin is done" \
  'jq -e ".id == \"aaaa1\" and .state == \"done\" and .phase == \"complete\"" "$E/verbs/claude-code-update-status.json" >/dev/null'
check "and the engine update ran next, under the same run" \
  '[ "$rc" -eq 1 ] && jq -e ".id == \"aaaa1\" and .state == \"failed\" and .phase == \"validating\"" "$E/verbs/engine-update-status.json" >/dev/null'
[ "$fails" -eq 0 ] || cat "$T/cc2.out"
rm -f "$E/verbs/engine-update-status.json"
rc=0
CREDENTIALS_DIRECTORY="$T/apply/creds" bash "$T/engine.sh" >"$T/cc3.out" 2>&1 || rc=$?
check "a pin with nothing to move ends the run, and no rebuild starts" \
  '[ "$rc" -eq 0 ] && jq -e ".phase == \"no-change\"" "$E/verbs/claude-code-update-status.json" >/dev/null && [ ! -e "$E/verbs/engine-update-status.json" ]'

# ── 11. the engine update reads its request from the run file ─────────────
echo "# engine-update: the request is the run file's payload"
mkdir -p "$E/creds"
jq -n '{id: "c3d4e5f607182930", verb: "engine-update", selectors: {}, payload: ({actor: "t"} | tojson)}' \
  >"$E/creds/request"
rc=0
CREDENTIALS_DIRECTORY="$E/creds" bash "$T/engine.sh" >/dev/null 2>&1 || rc=$?
check "a configuration without the input fails in validating, under the run's id" \
  '[ "$rc" -eq 1 ] && jq -e ".id == \"c3d4e5f607182930\" and .state == \"failed\" and .phase == \"validating\"" "$E/verbs/engine-update-status.json" >/dev/null'

# ── 12. the nodes' DHCP lines: kept, copied, and nothing else let through ──
echo "# nodes-dhcp"
N="$T/nodes"
mkdir -p "$N/creds" "$N/verbs" "$N/run"
agent "$T/nodes.sh" "STORE=$N/verbs/nodes-dhcp-hosts DST=$N/run/dhcp-hosts PIHOLE=0" \
  lib.sh nodes-dhcp.sh
nodes_run() {
  jq -n --arg b "$1" '{id: "n1", verb: "nodes-dhcp", selectors: {}, payload: $b}' >"$N/creds/request"
  CREDENTIALS_DIRECTORY="$N/creds" bash "$T/nodes.sh" >/dev/null 2>&1
}
: >"$LOGGED"
stub install <<'EOF'
# Without the root to chown: drop -o/-g, keep the rest.
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in -o | -g) shift 2 ;; *) args+=("$1"); shift ;; esac
done
exec "$(dirname "$(command -v cat)")/install" "${args[@]}"
EOF
nodes_run "aa:bb:cc:dd:ee:01,gaming-pc"$'\n'"aa:bb:cc:dd:ee:02,192.168.0.9,mac" || true
check "the lines are kept and handed to the resolver" \
  '[ "$(cat "$N/run/dhcp-hosts")" = "$(printf "aa:bb:cc:dd:ee:01,gaming-pc\naa:bb:cc:dd:ee:02,192.168.0.9,mac")" ] && cmp -s "$N/run/dhcp-hosts" "$N/verbs/nodes-dhcp-hosts"'
: >"$LOGGED"
rc=0
nodes_run "aa:bb:cc:dd:ee:01,gaming-pc"$'\n'"dhcp-option=3,10.0.0.1" || rc=$?
check "a dnsmasq option is refused, and the last good copy stays" \
  '[ "$rc" -eq 0 ] && grep -qx "DAEDALUS_OUTCOME=refused" "$LOGGED" && grep -q "192.168.0.9" "$N/run/dhcp-hosts"'
rm -f "$N/run/dhcp-hosts"
bash "$T/nodes.sh" >/dev/null 2>&1
check "at boot the kept copy goes back to the resolver" 'cmp -s "$N/run/dhcp-hosts" "$N/verbs/nodes-dhcp-hosts"'
rm -f "$T/bin/install"

if [ "$fails" -ne 0 ]; then
  cat "$T/apply.out"
  echo "$fails check(s) failed"
  exit 1
fi
echo "all checks passed"
