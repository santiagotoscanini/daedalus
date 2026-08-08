# Ensure every declared consumer has a virtual key — concatenated into a
# writeShellApplication wrapper in stacks/litellm/keys.nix.
#
# Required env (exported by the wrapper):
#   FILE       — the virtual-key dotenv (machine-generated, gitignored)
#   STATE_DIR  — its parent, created here on a first boot
#   NAMES      — bash ARRAY of env-var names, one per declared consumer.
#                An array, not a word list: with a single key declared a
#                literal list is one word and shellcheck reads that as a
#                quoting mistake (SC2043), failing the build.
#
# writeShellApplication already prepends `set -euo pipefail`.
#
# Ensure-exists, NOT converge: an existing value is never rewritten, because
# rotating a live key breaks every consumer holding it until they restart.

# state-paths.service pre-creates this, but not in the window between a fresh
# clone and its first boot.
if [ ! -f "$FILE" ]; then
  install -d -m 0700 -o santiago -g users "$STATE_DIR"
  install -m 0600 -o santiago -g users /dev/null "$FILE"
fi

for name in "${NAMES[@]}"; do
  # An EMPTY value counts as missing — a truncated state file would otherwise
  # render a blank Authorization header into a consumer, which the gateway
  # rejects with the same 401 as a wrong key and is considerably harder to
  # recognise.
  if grep -q "^$name=." "$FILE"; then
    continue
  fi

  # `sk-` is not decoration: LiteLLM's own client libraries and a good deal of
  # OpenAI-compatible tooling assume the prefix.
  VALUE=sk-$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')

  # Rename rather than write in place: this file is read by the renders and by
  # the sync, and a reader must never see it half-written even though both are
  # ordered after this unit.
  grep -v "^$name=" "$FILE" >"$FILE.next" || true
  printf '%s=%s\n' "$name" "$VALUE" >>"$FILE.next"
  chmod 0600 "$FILE.next"
  chown santiago:users "$FILE.next"
  mv -f "$FILE.next" "$FILE"
  echo "generated $name"
done

# Values for keys no longer declared are LEFT ALONE. Nothing reads them, and
# keeping one means a consumer removed and re-added under the same name comes
# back with the same credential rather than a silent rotation. The
# gateway-side key outlives them too — drop it in the admin UI if that is not
# what you want.
