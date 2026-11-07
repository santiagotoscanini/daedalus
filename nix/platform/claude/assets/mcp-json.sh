# shellcheck shell=bash
# Renders the operator's .mcp.json: the decrypted file, with every server in
# SERVERS (name -> { url, bearerFile, bearerVar }) put in as an HTTP server
# carrying its bearer, replacing one of the same name. A missing bearer
# fails the unit and leaves the previous file in place.
# Parameters: SECRET (decrypted .mcp.json), SERVERS (JSON), OUT (rendered
# file, on tmpfs), LINK (the checkout's .mcp.json, made a symlink to OUT).

umask 077
json=$(cat "$SECRET")

while IFS= read -r name; do
  url=$(jq -r --arg n "$name" '.[$n].url' "$SERVERS")
  file=$(jq -r --arg n "$name" '.[$n].bearerFile' "$SERVERS")
  var=$(jq -r --arg n "$name" '.[$n].bearerVar' "$SERVERS")
  bearer=$(grep -m1 "^${var}=" "$file" | cut -d= -f2- || true)
  if [ -z "$bearer" ]; then
    echo "claude-mcp-json: no ${var} in ${file} for ${name}; not rendering" >&2
    exit 1
  fi
  # The bearer travels in the environment, never on a command line.
  json=$(BEARER="$bearer" jq --arg n "$name" --arg url "$url" \
    '.mcpServers[$n] = {type: "http", url: $url, headers: {Authorization: ("Bearer " + env.BEARER)}}' \
    <<<"$json")
done < <(jq -r 'keys[]' "$SERVERS")

tmp=$(mktemp "${OUT}.XXXXXX")
printf '%s\n' "$json" >"$tmp"
chmod 0400 "$tmp"
mv -f "$tmp" "$OUT"
ln -sfn "$OUT" "$LINK"
echo "claude-mcp-json: rendered $(jq '.mcpServers | length' "$OUT") servers"
