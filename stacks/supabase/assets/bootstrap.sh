#!/bin/bash
# Bootstraps a Supabase project's on-disk state on FIRST BOOT.
#
# Idempotent: skips any path that already exists. To force a
# regeneration (e.g. roll secrets, refresh static configs), delete
# the target file/dir and rebuild.
#
# Inputs (set as systemd env vars by mkProject in supabase.nix):
#   PROJECT_ID    — short id (e.g. "anansi")
#   HOST_ROOT     — /home/santiago/selfhost/supabase/<id>
#   STATIC_DIR    — /nix/store/...supabase-static
#   STUDIO_HOST   — studio.<id>.supabase.toscanini.me
#   KONG_HOST     — kong.<id>.supabase.toscanini.me
#   ENV_FILE      — /etc/nixos/containers/supabase/<id>/env

set -eu

# ── 1. Generate env file with fresh secrets, if missing ────────
if [ ! -e "$ENV_FILE" ]; then
  install -d -m 0700 -o santiago -g users "$(dirname "$ENV_FILE")"

  POSTGRES_PASSWORD=$(openssl rand -hex 32)
  JWT_SECRET=$(openssl rand -hex 40)
  DASHBOARD_PASSWORD=$(openssl rand -hex 16)
  # SECRET_KEY_BASE: Phoenix-style 64-char base. Use base64url to avoid
  # / + = chars that some shells choke on.
  SECRET_KEY_BASE=$(openssl rand -base64 48 | tr -d '\n=' | tr '+/' '-_')
  VAULT_ENC_KEY=$(openssl rand -hex 16)
  PG_META_CRYPTO_KEY=$(openssl rand -hex 16)
  LOGFLARE_PUBLIC_ACCESS_TOKEN=$(openssl rand -hex 32)
  LOGFLARE_PRIVATE_ACCESS_TOKEN=$(openssl rand -hex 32)
  S3_PROTOCOL_ACCESS_KEY_ID=$(openssl rand -hex 16)
  S3_PROTOCOL_ACCESS_KEY_SECRET=$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')

  # HS256 JWT signing in pure bash + openssl. base64url-encode header,
  # payload; HMAC-SHA256 the "header.payload" string with JWT_SECRET.
  b64() { printf '%s' "$1" | openssl base64 -A | tr '+/' '-_' | tr -d '='; }
  hmac() {
    printf '%s' "$1" \
      | openssl dgst -sha256 -mac HMAC -macopt "key:$2" -binary \
      | openssl base64 -A | tr '+/' '-_' | tr -d '='
  }
  sign_jwt() {
    local role="$1"
    local now exp
    now=$(date +%s)
    exp=$((now + 60 * 60 * 24 * 365 * 10))   # 10-year expiry
    local header='{"alg":"HS256","typ":"JWT"}'
    local payload="{\"role\":\"$role\",\"iss\":\"supabase\",\"iat\":$now,\"exp\":$exp}"
    local h p s
    h=$(b64 "$header")
    p=$(b64 "$payload")
    s=$(hmac "$h.$p" "$JWT_SECRET")
    printf '%s.%s.%s' "$h" "$p" "$s"
  }
  ANON_KEY=$(sign_jwt anon)
  SERVICE_ROLE_KEY=$(sign_jwt service_role)

  # Render the template via sed. `|` as the delimiter so the
  # postgres:// URLs (which contain @) don't break it. Secrets are
  # hex/base64url so they don't contain `|` either.
  tmp=$(mktemp)
  sed \
    -e "s|@@PROJECT_ID@@|$PROJECT_ID|g" \
    -e "s|@@STUDIO_HOST@@|$STUDIO_HOST|g" \
    -e "s|@@KONG_HOST@@|$KONG_HOST|g" \
    -e "s|@@POSTGRES_PASSWORD@@|$POSTGRES_PASSWORD|g" \
    -e "s|@@JWT_SECRET@@|$JWT_SECRET|g" \
    -e "s|@@ANON_KEY@@|$ANON_KEY|g" \
    -e "s|@@SERVICE_ROLE_KEY@@|$SERVICE_ROLE_KEY|g" \
    -e "s|@@DASHBOARD_PASSWORD@@|$DASHBOARD_PASSWORD|g" \
    -e "s|@@SECRET_KEY_BASE@@|$SECRET_KEY_BASE|g" \
    -e "s|@@VAULT_ENC_KEY@@|$VAULT_ENC_KEY|g" \
    -e "s|@@PG_META_CRYPTO_KEY@@|$PG_META_CRYPTO_KEY|g" \
    -e "s|@@LOGFLARE_PUBLIC_ACCESS_TOKEN@@|$LOGFLARE_PUBLIC_ACCESS_TOKEN|g" \
    -e "s|@@LOGFLARE_PRIVATE_ACCESS_TOKEN@@|$LOGFLARE_PRIVATE_ACCESS_TOKEN|g" \
    -e "s|@@S3_PROTOCOL_ACCESS_KEY_ID@@|$S3_PROTOCOL_ACCESS_KEY_ID|g" \
    -e "s|@@S3_PROTOCOL_ACCESS_KEY_SECRET@@|$S3_PROTOCOL_ACCESS_KEY_SECRET|g" \
    "$STATIC_DIR/env.template" > "$tmp"

  install -m 0600 -o santiago -g users "$tmp" "$ENV_FILE"
  rm -f "$tmp"
  echo "Generated env file at $ENV_FILE."
else
  echo "$ENV_FILE already exists — skipping env generation."
fi

# ── 2. Seed host-side configs (idempotent per-file) ────────────
# Make sure the per-project ROOT_BASE parent is santiago-owned. Otherwise
# install -d creates it as root, which trips systemd-tmpfiles unsafe-path-
# transition checks for the per-project subpaths declared in mkProject.
install -d -m 0755 -o santiago -g users "$(dirname "$HOST_ROOT")"
install -d -m 0755 -o santiago -g users "$HOST_ROOT"
for d in kong pooler vector db-init functions/main; do
  install -d -m 0755 -o santiago -g users "$HOST_ROOT/$d"
done

copy_if_missing() {
  local src="$1" dst="$2"
  if [ ! -e "$dst" ]; then
    install -m 0644 -o santiago -g users "$src" "$dst"
    # kong-entrypoint.sh needs the exec bit.
    case "$dst" in *.sh) chmod 755 "$dst" ;; esac
    echo "Seeded $dst"
  fi
}

copy_if_missing "$STATIC_DIR/kong/kong.yml"            "$HOST_ROOT/kong/kong.yml"
copy_if_missing "$STATIC_DIR/kong/kong-entrypoint.sh"  "$HOST_ROOT/kong/kong-entrypoint.sh"
copy_if_missing "$STATIC_DIR/pooler/pooler.exs"        "$HOST_ROOT/pooler/pooler.exs"
copy_if_missing "$STATIC_DIR/vector/vector.yml"        "$HOST_ROOT/vector/vector.yml"
copy_if_missing "$STATIC_DIR/functions/main/index.ts"  "$HOST_ROOT/functions/main/index.ts"

for sql in jwt logs pooler realtime roles webhooks _supabase; do
  copy_if_missing "$STATIC_DIR/db-init/$sql.sql" "$HOST_ROOT/db-init/$sql.sql"
done
