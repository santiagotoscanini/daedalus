# Provision or revoke an app's Pocket ID client secret, on request.
#
# The gap this closes: `auth.mode` is a toggle in daedalus, but the secret it
# needs is encrypted state in stacks/pocket-id/clients.sops, and until now the
# only way to write it was a human with a shell. So flipping the toggle failed
# the next Apply at build time with instructions, which is a checklist wearing a
# switch's clothing.
#
# Runs as root on the host, like its sibling agents, because it needs the host
# key to decrypt and it commits to the flake. The container writes a request
# into the bind mount and a systemd.path unit starts this; it holds no
# credential and cannot do any of the below itself.
#
# ── why the host SSH key ───────────────────────────────────────────────────
#
# sops needs an identity to decrypt, and the host key is the one that always
# exists: platform/sops.nix already decrypts every secret on this box with it
# (`sops.age.sshKeyPaths`), and it is what a fresh restore has before anybody
# logs in. ssh-to-age converts it to the age identity sops wants. santiago's
# personal key would work too and is deliberately NOT used — automation should
# not depend on a file in somebody's home directory.
#
# ── why it commits ─────────────────────────────────────────────────────────
#
# The flake only sees git-tracked content, so an uncommitted clients.sops is
# invisible to the rebuild that follows — the assertion in clients.nix would
# read the OLD file and fail on a secret that is sitting right there. apply.sh
# commits only apps.json, on purpose, so this commits its own file, scoped the
# same way. Shares the rebuild lock while doing it: two `git commit`s in this
# repo at once collide on index.lock, and an Apply is the other writer.

set -euo pipefail

REQ="$APPLY_DIR/sso-request.json"
STATUS="$APPLY_DIR/sso-status.json"

ACTION=""
APP=""

write_status() {
  install -m 0644 -o santiago -g users /dev/stdin "$STATUS" <<EOF
{"id":"$REQ_ID","action":$(jq -Rn --arg a "$ACTION" '$a'),"app":$(jq -Rn --arg n "$APP" '$n'),"state":"$1","detail":$(jq -Rn --arg d "${2-}" '$d'),"error":$(jq -Rn --arg e "${3-}" '$e'),"finishedAt":"$(date -Is)"}
EOF
}

# Two exit paths, because they mean different things to whoever is watching.
#
# `reject` is "the request was wrong or cannot be honoured" — a bad name, a
# revoke that would break the fleet. The operator is told, in the UI, by the
# status file; the AGENT did its job. It exits 0, so the unit stays green.
#
# `fail` is "this agent is broken" — it cannot decrypt, cannot commit, the
# round trip lost keys. That deserves a failed unit: `systemctl --failed` and
# the failed-units alert in Grafana are how a broken agent gets noticed when
# nobody is looking at a page.
#
# Getting this wrong is not cosmetic. A refused request that exits 1 leaves a
# permanently failed unit and trips that alert — so the alert learns to mean
# "somebody typed something odd", which is how a real fault goes unnoticed.
reject() {
  write_status failed "" "$1"
  echo "sso-secret request rejected: $1" >&2
  exit 0
}

fail() {
  write_status failed "" "$1"
  echo "sso-secret agent failure: $1" >&2
  exit 1
}

[ -f "$REQ" ] || exit 0
REQ_ID="$(jq -r '.id // ""' "$REQ")"
[ -n "$REQ_ID" ] || exit 0

# Replay guard: the path unit re-fires on a daemon-reload at boot.
if [ -f "$STATUS" ] && [ "$(jq -r '.id // ""' "$STATUS")" = "$REQ_ID" ]; then
  exit 0
fi

ACTION="$(jq -r '.action // ""' "$REQ")"
APP="$(jq -r '.app // ""' "$REQ")"

# The name becomes a shell variable name and a line in an encrypted file. One
# DNS label, which is what fleet.apps keys already are.
case "$APP" in
*[!a-z0-9-]* | "" | -* | *-) reject "refusing app name '$APP'" ;;
esac

# SSO_SECRET_<NAME>: uppercase, hyphens to underscores. Same mapping
# clients.nix uses, and it has to stay in step with it.
KEY="SSO_SECRET_$(printf '%s' "$APP" | tr 'a-z-' 'A-Z_')"

write_status running "preparing" ""

WORK="$(mktemp -d)"
chmod 700 "$WORK"
cleanup() {
  find "$WORK" -type f -exec shred -u {} + 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# Host key -> age identity, in the work dir and shredded with it.
ssh-to-age -private-key -i /etc/ssh/ssh_host_ed25519_key > "$WORK/age.key" 2>/dev/null ||
  fail "could not derive an age identity from the host SSH key"
export SOPS_AGE_KEY_FILE="$WORK/age.key"

sops -d --input-type dotenv --output-type dotenv "$CLIENTS" > "$WORK/plain" ||
  fail "could not decrypt $CLIENTS with the host key — is the host key still a recipient? (sops updatekeys)"

HAS_KEY=no
grep -q "^$KEY=" "$WORK/plain" && HAS_KEY=yes

case "$ACTION" in
provision)
  if [ "$HAS_KEY" = yes ]; then
    write_status "done" "$KEY was already provisioned" ""
    exit 0
  fi
  SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  # Belt and braces: an empty value passes the eval assertion (the value is
  # encrypted, so Nix cannot see it) and then fails the render at activation,
  # which is the one failure mode the assertion cannot catch. Refuse to write
  # one rather than hand that to the operator later.
  [ "${#SECRET}" -eq 64 ] || fail "refusing to write a short secret (${#SECRET} chars) — /dev/urandom or od misbehaved"
  cp "$WORK/plain" "$WORK/next"
  printf '%s=%s\n' "$KEY" "$SECRET" >> "$WORK/next"
  MSG="$KEY provisioned"
  ;;

revoke)
  if [ "$HAS_KEY" = no ]; then
    write_status "done" "$KEY was not provisioned" ""
    exit 0
  fi
  # Refuse while the APPLIED registry still gates this app. The running system
  # is built from the committed apps.json, and its creds render is one unit for
  # every client — pulling a secret the applied config still requires means the
  # next boot takes the login path out for all of them, not just this app.
  APPLIED_MODE="$(jq -r --arg n "$APP" '.apps[$n].auth.mode // "absent"' "$REGISTRY")"
  case "$APPLIED_MODE" in
  none | absent) ;;
  *) reject "the applied registry still has $APP on auth.mode=\"$APPLIED_MODE\" — Apply that change first, then revoke. Removing the secret now would fail the shared creds render on the next boot, for every client." ;;
  esac
  grep -v "^$KEY=" "$WORK/plain" > "$WORK/next"
  MSG="$KEY revoked"
  ;;

*) reject "unknown action '$ACTION'" ;;
esac

write_status running "encrypting" ""
sops -e --input-type dotenv --output-type dotenv "$WORK/next" > "$WORK/enc" ||
  fail "sops could not re-encrypt clients.sops"

# Sanity-check the round trip before replacing the real file: a truncated or
# mis-encrypted clients.sops is every SSO client at once.
sops -d --input-type dotenv --output-type dotenv "$WORK/enc" > "$WORK/verify" ||
  fail "the re-encrypted file does not decrypt — leaving clients.sops untouched"
EXPECTED="$(grep -c '^SSO_SECRET_' "$WORK/next")"
ACTUAL="$(grep -c '^SSO_SECRET_' "$WORK/verify")"
[ "$EXPECTED" = "$ACTUAL" ] ||
  fail "round trip lost keys ($EXPECTED in, $ACTUAL out) — leaving clients.sops untouched"

write_status running "committing" ""
exec 9>"$LOCKFILE"
flock -w 300 9 || fail "another rebuild or apply held the lock for 5 minutes; nothing was changed"

install -m 0644 -o santiago -g users "$WORK/enc" "$CLIENTS"

as_santiago() {
  setpriv --reuid=santiago --regid=users --init-groups "$@"
}
as_santiago git -C "$FLAKE" add "$CLIENTS" || fail "git add failed"
if as_santiago git -C "$FLAKE" diff --cached --quiet -- "$CLIENTS"; then
  write_status "done" "$MSG (no change on disk)" ""
  exit 0
fi
as_santiago git -C "$FLAKE" -c "user.name=daedalus" -c "user.email=$GIT_EMAIL" \
  commit -q -m "pocket-id: $MSG" -m "Requested from daedalus by $(jq -r '.actor // "unknown"' "$REQ")." -- "$CLIENTS" ||
  fail "git commit failed"

# Best-effort, exactly as apply.sh treats it: the commit is what the next
# rebuild reads, and a network blip must not report a failure that did not
# happen.
as_santiago git -C "$FLAKE" push -q || true

write_status "done" "$MSG — commit it is in, Apply to push it to the IdP" ""
