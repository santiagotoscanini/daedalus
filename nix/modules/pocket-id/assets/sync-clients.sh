# Converge the Pocket ID OIDC clients declared in `fleet.ssoClients`.
#
# Sourced by the wrapper in ../clients.nix, which sets: MANIFEST (store
# JSON, non-secret desired state), IDP_ENV (/run/secrets/pocket-id-env,
# holds STATIC_API_KEY), SECRETS (the machine-generated
# client-secrets.env, holds SSO_SECRET_<NAME> per client — written by
# sso-client-secrets.service, which this unit is ordered after).
#
# Every request runs INSIDE the pocket-id container against
# http://localhost:1411 — the IdP publishes no host port, and going in
# through traefik would make client convergence depend on ingress being
# up (and on the wildcard cert). `podman exec` sidesteps both.
#
# ...but it must not depend on what the IMAGE ships. v2.14.0 dropped
# curl and this unit crash-looped on exit 127 for every client in the
# fleet: existing logins kept working (they never touch this path) while
# no client could be created or updated, so the breakage surfaced only
# when the next app was registered and its OAuth client silently did not
# exist. The image has busybox wget, which cannot do PUT/DELETE or
# report a status code, and pocket-id's own CLI has no client verbs.
#
# So we ship our own: CURL_BIN is a statically linked musl curl from
# nixpkgs, copied in once per run. It runs regardless of the image's
# libc or contents, and it keeps every property the paragraph above
# argues for — same localhost:1411, same `-e` passthrough, no ingress
# and no cert in the path.
#
# The API key rides a value-less `-e` passthrough so it never appears in
# podman's argv (/proc/<pid>/cmdline) — same trick as
# pocket-id-cleanup-marker-repair.

set -euo pipefail

PID_API_KEY=$(grep '^STATIC_API_KEY=' "$IDP_ENV" | head -1 | cut -d= -f2-)
[ -n "$PID_API_KEY" ] || { echo "STATIC_API_KEY missing from $IDP_ENV" >&2; exit 1; }
export PID_API_KEY

RESP=$(mktemp)
trap 'rm -f "$RESP"' EXIT

# Ship curl into the container (see the header). Idempotent: a restart
# wipes /tmp, so this re-lands it on every run rather than assuming.
CURL_IN=/tmp/.pid-sync-curl
podman cp "$CURL_BIN" "pocket-id:$CURL_IN" \
  || { echo "could not stage curl into the pocket-id container" >&2; exit 1; }

# api <METHOD> <PATH> [<JSON body>]
#   -> response body in $RESP, status in $API_CODE.
# Deliberately NOT `body=$(api ...)`: a command substitution runs in a
# subshell, so the status assignment would be discarded and every call
# would read as HTTP "". curl's stdout carries both halves (body, then a
# final line with the code) because one podman exec is one round trip.
API_CODE=""
api() {
  local method=$1 path=$2 body=${3-} out
  if [ -n "$body" ]; then
    out=$(printf '%s' "$body" | podman exec -i -e PID_API_KEY pocket-id \
      "$CURL_IN" -sS --max-time 10 -w '\n%{http_code}' -X "$method" \
      -H "X-API-KEY: $PID_API_KEY" -H 'Content-Type: application/json' \
      --data-binary @- "http://localhost:1411$path")
  else
    out=$(podman exec -e PID_API_KEY pocket-id \
      "$CURL_IN" -sS --max-time 10 -w '\n%{http_code}' -X "$method" \
      -H "X-API-KEY: $PID_API_KEY" \
      "http://localhost:1411$path")
  fi
  API_CODE=${out##*$'\n'}
  printf '%s' "${out%$'\n'*}" > "$RESP"
}

# Group name -> id, fetched once. Pocket ID restricts by group ID, and
# an unknown name would otherwise silently drop the restriction.
api GET '/api/user-groups?pagination%5Blimit%5D=100'
[ "$API_CODE" = "200" ] || { echo "listing user groups failed (HTTP $API_CODE): $(cat "$RESP")" >&2; exit 1; }
groups_json=$(cat "$RESP")

jq -c '.[]' "$MANIFEST" | while read -r client; do
  key=$(printf '%s' "$client" | jq -r '.key')
  id=$(printf '%s' "$client" | jq -r '.id')
  has_logo=false

  # GET-then-create/update: POST /api/oidc/clients is NOT idempotent —
  # a second call with the same id answers 400 "Client ID already in
  # use". PUT is a FULL replace, so the manifest body always carries
  # every field (an omitted callbackURLs would blank the list).
  api GET "/api/oidc/clients/$id"
  case "$API_CODE" in
    404)
      api POST '/api/oidc/clients' "$(printf '%s' "$client" | jq -c '.body + {id: .id}')"
      [ "$API_CODE" = "201" ] || { echo "$key: create failed (HTTP $API_CODE): $(cat "$RESP")" >&2; exit 1; }
      echo "$key: created OIDC client '$id'"
      ;;
    200)
      has_logo=$(jq -r '.hasLogo' < "$RESP")
      api PUT "/api/oidc/clients/$id" "$(printf '%s' "$client" | jq -c '.body')"
      [ "$API_CODE" = "200" ] || { echo "$key: update failed (HTTP $API_CODE): $(cat "$RESP")" >&2; exit 1; }
      ;;
    *)
      echo "$key: unexpected HTTP $API_CODE looking up client '$id'" >&2
      exit 1
      ;;
  esac

  # ── the client secret ────────────────────────────────────────────────
  #
  # The secret is OURS: sso-client-secrets.service generates it on this
  # box, the renders hand the identical string to every consumer, and
  # this pushes it to the IdP so both halves match.
  #
  # v2.14.0 kept the caller-supplied value — `OidcClientSecretCreateDto`
  # (backend/internal/dto/oidc_dto.go) carries an optional `secret`,
  # `omitempty,min=16,printascii`, which a 64-hex key clears — but moved
  # it and changed its verb. The old set-style `POST .../secret` is gone
  # (404 "API endpoint not found"); the replacement `POST .../secrets`
  # ADDS a secret and leaves the existing ones usable, one client holding
  # up to model.MaxOidcClientSecrets = 20. Posting blind on every boot
  # would grow a secret per run and then hard-fail at 20.
  #
  # So: add ours, then delete every secret that was there before it. In
  # that order, because it means a row carrying the fleet's value exists
  # for the whole sequence — a token exchange landing mid-converge never
  # sees `invalid_client`. A run ends with exactly one secret, ours,
  # whatever the client looked like beforehand, which is the same
  # contract the singular endpoint gave us: re-running is a no-op, a
  # hand-edited or half-restored client is repaired, and a rotation
  # (delete the key from client-secrets.env, rebuild) converges here.
  #
  # NOT "create only when none is active". That reads idempotence as
  # "leave whatever is already there", which strands a rotated secret at
  # the IdP while every consumer has moved on. And the live secret cannot
  # be recognised as ours: the API discloses only a 4-character prefix
  # (model.OidcClientSecretPrefixLength) and never the value or its hash,
  # so a skip-if-it-looks-right check would be a 1-in-65k silent
  # invalid_client on some future rotation.
  secret_key=$(printf '%s' "$client" | jq -r '.secretKey')
  secret=$(grep "^$secret_key=" "$SECRETS" | head -1 | cut -d= -f2-)
  [ -n "$secret" ] || { echo "$key: $secret_key missing from $SECRETS" >&2; exit 1; }

  api GET "/api/oidc/clients/$id/secrets"
  [ "$API_CODE" = "200" ] || { echo "$key: listing secrets failed (HTTP $API_CODE): $(cat "$RESP")" >&2; exit 1; }
  stale=$(jq -r '.[].id' < "$RESP")

  api POST "/api/oidc/clients/$id/secrets" "$(jq -cn --arg s "$secret" '{secret: $s}')"
  [ "$API_CODE" = "201" ] || { echo "$key: setting secret failed (HTTP $API_CODE): $(cat "$RESP")" >&2; exit 1; }

  # Herestring, not a pipe: the loop has to stay in THIS shell so its
  # `exit 1` still aborts the run, and it must not eat the manifest the
  # outer loop is reading from stdin.
  while read -r stale_id; do
    [ -n "$stale_id" ] || continue
    api DELETE "/api/oidc/clients/$id/secrets/$stale_id"
    [ "$API_CODE" = "204" ] || { echo "$key: pruning superseded secret $stale_id failed (HTTP $API_CODE): $(cat "$RESP")" >&2; exit 1; }
  done <<< "$stale"

  # Allowed groups AFTER the client write: PUT /api/oidc/clients/<id>
  # is a full replace and answers with an empty allowedUserGroups, so
  # the membership has to be (re-)applied on the far side of it.
  ids=$(printf '%s' "$client" | jq -c --argjson g "$groups_json" \
    '{userGroupIds: [.groups[] as $n | $g.data[] | select(.name == $n) | .id]}')
  want=$(printf '%s' "$client" | jq -r '.groups | length')
  got=$(printf '%s' "$ids" | jq -r '.userGroupIds | length')
  [ "$want" = "$got" ] || { echo "$key: unknown Pocket ID group in $(printf '%s' "$client" | jq -c '.groups')" >&2; exit 1; }
  if [ "$want" -gt 0 ]; then
    api PUT "/api/oidc/clients/$id/allowed-user-groups" "$ids"
    [ "$API_CODE" = "200" ] || { echo "$key: setting allowed groups failed (HTTP $API_CODE): $(cat "$RESP")" >&2; exit 1; }
  fi

  # Logo, only when the client hasn't got one — it is a multipart upload
  # rather than a field on the client body, so it can't ride the PUT
  # above, and re-sending it on every boot would be pure churn. A new
  # client (id changed, or a rebuilt IdP database) starts blank and
  # picks its logo back up here.
  logo=$(printf '%s' "$client" | jq -r '.logo // empty')
  if [ -n "$logo" ] && [ "$has_logo" != "true" ]; then
    type=$(printf '%s' "$client" | jq -r '.logoType')
    out=$(podman exec -i -e PID_API_KEY pocket-id \
      "$CURL_IN" -sS --max-time 20 -w '\n%{http_code}' -X POST \
      -H "X-API-KEY: $PID_API_KEY" \
      -F "file=@-;filename=logo.${logo##*.};type=$type" \
      "http://localhost:1411/api/oidc/clients/$id/logo" < "$logo")
    code=${out##*$'\n'}
    [ "$code" = "204" ] || { echo "$key: logo upload failed (HTTP $code): ${out%$'\n'*}" >&2; exit 1; }
    echo "$key: uploaded logo"
  fi
done
