# Ensure every declared SSO client has a secret — concatenated into a
# writeShellApplication wrapper in stacks/pocket-id/clients.nix.
#
# Required env (exported by the wrapper):
#   FILE       — the secrets dotenv (machine-generated, gitignored)
#   STATE_DIR  — its parent, created here on a first boot
#   KEYS       — space-separated env-var names, one per declared client
#
# writeShellApplication already prepends `set -euo pipefail`.
#
# Ensure-exists, NOT converge: existing keys are never touched, because
# rewriting a live secret would log every user of that client out at an
# unpredictable moment.

# state-paths.service pre-creates this, but not in the window between a fresh
# clone and its first boot.
if [ ! -f "$FILE" ]; then
  install -d -m 0700 -o santiago -g users "$STATE_DIR"
  install -m 0600 -o santiago -g users /dev/null "$FILE"
fi

for key in $KEYS; do
  # A key with an EMPTY value counts as missing. That was the one hole the old
  # eval-time assertion could not see (sops encrypts dotenv values, so nix
  # could check the key and not the value), and it surfaced as a client the
  # IdP accepted with a blank secret. Here the value is readable, so it is
  # just checked.
  if grep -q "^$key=." "$FILE"; then
    continue
  fi

  VALUE=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')

  # Rename rather than write in place: this file is read by the renders and by
  # the sync, and a reader must never see it half-written even though both are
  # ordered after this unit.
  grep -v "^$key=" "$FILE" >"$FILE.next" || true
  printf '%s=%s\n' "$key" "$VALUE" >>"$FILE.next"
  chmod 0600 "$FILE.next"
  chown santiago:users "$FILE.next"
  mv -f "$FILE.next" "$FILE"
  echo "generated $key"
done

# Keys for clients no longer declared are LEFT ALONE. Nothing reads them, and
# keeping one means an app deleted and re-created under the same name comes
# back with the same credential instead of a silent rotation.
