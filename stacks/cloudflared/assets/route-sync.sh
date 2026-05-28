# Idempotent Cloudflare DNS reconciler — concatenated into a
# writeShellApplication wrapper in stacks/cloudflared/cloudflared.nix.
# Required env (exported by the wrapper):
#   CF_DNS_API_TOKEN  — from secrets/env (EnvironmentFile=)
#   ZONE_ID           — Cloudflare zone (toscanini.me)
#   TUNNEL_ID         — the locally-managed tunnel
#   MANAGED_COMMENT   — marker stamped on every CNAME we own
#   HOSTS             — newline-separated declared hostnames
#
# writeShellApplication already prepends `set -euo pipefail`.

TARGET="${TUNNEL_ID}.cfargotunnel.com"

if [[ -z "${CF_DNS_API_TOKEN:-}" ]]; then
  echo "ERROR: CF_DNS_API_TOKEN not set in EnvironmentFile" >&2
  exit 1
fi

api() {
  local method="$1" path="$2"
  shift 2
  curl -sS -X "$method" \
    -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
    -H "Content-Type: application/json" \
    "$@" \
    "https://api.cloudflare.com/client/v4${path}"
}

# 1. Upsert declared hostnames
while IFS= read -r HOST; do
  [ -z "$HOST" ] && continue
  EXISTING=$(api GET "/zones/$ZONE_ID/dns_records?type=CNAME&name=$HOST")
  COUNT=$(echo "$EXISTING" | jq '.result | length')

  if [ "$COUNT" -eq 0 ]; then
    echo "[create] $HOST -> $TARGET"
    api POST "/zones/$ZONE_ID/dns_records" \
      -d "$(jq -n --arg n "$HOST" --arg c "$TARGET" --arg m "$MANAGED_COMMENT" \
        '{type:"CNAME",name:$n,content:$c,proxied:true,ttl:1,comment:$m}')" \
      | jq -e '.success' >/dev/null
  else
    RID=$(echo "$EXISTING" | jq -r '.result[0].id')
    CONTENT=$(echo "$EXISTING" | jq -r '.result[0].content')
    PROXIED=$(echo "$EXISTING" | jq -r '.result[0].proxied')
    COMMENT=$(echo "$EXISTING" | jq -r '.result[0].comment // ""')

    if [ "$CONTENT" = "$TARGET" ] && [ "$PROXIED" = "true" ] \
       && [ "$COMMENT" = "$MANAGED_COMMENT" ]; then
      echo "[ok]     $HOST -> $TARGET"
    else
      echo "[patch]  $HOST  $CONTENT (proxied=$PROXIED, comment=\"$COMMENT\") -> $TARGET (proxied=true, marked)"
      api PATCH "/zones/$ZONE_ID/dns_records/$RID" \
        -d "$(jq -n --arg c "$TARGET" --arg m "$MANAGED_COMMENT" \
          '{content:$c,proxied:true,comment:$m}')" \
        | jq -e '.success' >/dev/null
    fi
  fi
done <<<"$HOSTS"

# 2. Sweep orphan managed records (default page size 100 is fine for
# a personal zone; add pagination if it ever exceeds that).
ALL=$(api GET "/zones/$ZONE_ID/dns_records?type=CNAME&per_page=100")

while IFS=$'\t' read -r RID NAME; do
  [ -z "${RID:-}" ] && continue
  if ! grep -qxF "$NAME" <<<"$HOSTS"; then
    echo "[delete] $NAME (orphan; was managed, no longer in cloudflareRoutes)"
    api DELETE "/zones/$ZONE_ID/dns_records/$RID" \
      | jq -e '.success' >/dev/null
  fi
done < <(echo "$ALL" | jq -r --arg m "$MANAGED_COMMENT" \
  '.result | map(select(.comment == $m)) | .[] | .id + "\t" + .name')
