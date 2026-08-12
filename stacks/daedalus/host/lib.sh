# Shared helpers for daedalus's host-side agents. Inlined by each script's
# writeShellApplication wrapper BEFORE the agent body; expects OPERATOR_USER
# and OPERATOR_GROUP in the environment (set by the same wrapper).

# Atomic publish for JSON the container polls.
#
# `install /dev/stdin` wrote the destination in place, so every status
# transition had a window where a reader saw a truncated file — and the app's
# reader renders an unparseable status as "idle", which one poll into a
# twenty-minute rebuild reads as the apply having finished. Temp-and-rename
# closes the window; the temp lives beside the target because rename must not
# cross filesystems. jq validates before the rename so a torn heredoc (a
# killed script mid-write) can never be published as truth, and ownership
# drops to the operator so the rootless container can read the result.
write_json_atomic() {
  local dest tmp
  dest="$1"
  tmp="$(mktemp "$(dirname "$dest")/.$(basename "$dest").XXXXXX")"
  cat >"$tmp"
  if ! jq -e . "$tmp" >/dev/null; then
    rm -f "$tmp"
    echo "refusing to publish invalid JSON to $dest" >&2
    return 1
  fi
  chmod 0644 "$tmp"
  chown "$OPERATOR_USER:$OPERATOR_GROUP" "$tmp"
  mv "$tmp" "$dest"
}
