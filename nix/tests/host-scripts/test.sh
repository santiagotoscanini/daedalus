# shellcheck shell=bash disable=SC2016,SC2034
# (check() evaluates its condition, so the variables in it are single-quoted
# on purpose and read there.)
#
# The bridge agents' git and rollback behaviour, run for real against temp
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
echo '{"id":"aaaa-1","actor":"test"}' >"$A/claude-code-request.json"

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
APPLY_DIR="$A" FLAKE="$F" SITE_DIR="$T/site" WORKSPACES_DIR="$W" bash "$T/cc.sh" >"$T/cc.out" 2>&1 || rc=$?
check "the run fails" '[ "$rc" -ne 0 ]'
check "at committing, saying the commit was undone" \
  'jq -e ".state == \"failed\" and .phase == \"committing\" and (.error | test(\"undone\"))" "$A/claude-code-status.json" >/dev/null'
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
printf '%s\n' '{"files":{"apps.json":"{\"apps\":\"new\"}\n"}}' >"$A/payload-bbbb-2.json"
echo '{"id":"bbbb-2","commit":true,"summary":"test","actor":"test"}' >"$A/apply-request.json"

stub nixos-rebuild <<'EOF'
echo "$1" >>"$CALLS"
[ "$1" != build ] || { echo "error: the build failed (test)"; exit 1; }
EOF
export CALLS="$T/rebuild-calls"
: >"$CALLS"

agent "$T/apply.sh" "VAULT_APP_SECRETS=()" lib.sh site-lib.sh apply.sh
rc=0
APPLY_DIR="$A" PREV_DIR="$T/prev" FLAKE="$R" SITE_DIR="$R/site" ENGINE_CLONE="$T/none" \
  LOCKFILE="$T/rebuild.lock" SITE_LOCK="$T/site.lock" bash "$T/apply.sh" >"$T/apply.out" 2>&1 || rc=$?
check "the Apply fails" '[ "$rc" -ne 0 ]'
check "at building" 'jq -e ".state == \"failed\" and .phase == \"building\"" "$A/apply-status.json" >/dev/null'
check "nixos-rebuild only ever built" '[ "$(cat "$CALLS")" = build ]'
check "nothing was committed" '[ "$(git -C "$R" rev-parse HEAD)" = "$head_before" ]'
check "apps.json is back, index and work tree" \
  '[ "$(cat "$R/site/apps.json")" = "{\"apps\":\"old\"}" ] && git -C "$R" diff --quiet HEAD -- site'
check "the unrelated edit is untouched" '[ "$(cat "$R/other.nix")" = "{ edited = true; }" ]'

if [ "$fails" -ne 0 ]; then
  cat "$T/apply.out"
  echo "$fails check(s) failed"
  exit 1
fi
echo "all checks passed"
