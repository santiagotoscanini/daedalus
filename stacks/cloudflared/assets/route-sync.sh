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

# Every call — GETs included — is validated for `success: true` here at
# the source, so an API error (expired token, 429, CF outage) aborts
# with the CF error body instead of being misread downstream (a null
# `result` parses as "record missing" and triggers a spurious POST).
# --retry absorbs transient 5xx/connection blips.
api() {
  local method="$1" path="$2" body
  shift 2
  body=$(curl -sS --retry 3 --retry-connrefused -X "$method" \
    -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
    -H "Content-Type: application/json" \
    "$@" \
    "https://api.cloudflare.com/client/v4${path}")
  if ! jq -e '.success == true' >/dev/null <<<"$body"; then
    echo "ERROR: Cloudflare API $method $path failed:" >&2
    jq '.errors' <<<"$body" >&2 || echo "$body" >&2
    exit 1
  fi
  printf '%s' "$body"
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
      >/dev/null
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
        >/dev/null
    fi
  fi
done <<<"$HOSTS"

# 2. Sweep orphan managed records (default page size 100 is fine for
# a personal zone; add pagination if it ever exceeds that).
ALL=$(api GET "/zones/$ZONE_ID/dns_records?type=CNAME&per_page=100")

# Ownership signal = the record points at OUR tunnel; the comment is
# cosmetic (a comment-string rename must not strand orphans).
while IFS=$'\t' read -r RID NAME; do
  [ -z "${RID:-}" ] && continue
  if ! grep -qxF "$NAME" <<<"$HOSTS"; then
    echo "[delete] $NAME (points at the tunnel but not in cloudflareRoutes)"
    api DELETE "/zones/$ZONE_ID/dns_records/$RID" >/dev/null
  fi
done < <(echo "$ALL" | jq -r --arg t "$TARGET" \
  '.result | map(select(.content == $t)) | .[] | .id + "\t" + .name')
