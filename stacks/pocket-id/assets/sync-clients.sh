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
# The API key rides a value-less `-e` passthrough so it never appears in
# podman's argv (/proc/<pid>/cmdline) — same trick as
# pocket-id-cleanup-marker-repair.

set -euo pipefail

PID_API_KEY=$(grep '^STATIC_API_KEY=' "$IDP_ENV" | head -1 | cut -d= -f2-)
[ -n "$PID_API_KEY" ] || { echo "STATIC_API_KEY missing from $IDP_ENV" >&2; exit 1; }
export PID_API_KEY

RESP=$(mktemp)
trap 'rm -f "$RESP"' EXIT

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
      curl -sS --max-time 10 -w '\n%{http_code}' -X "$method" \
      -H "X-API-KEY: $PID_API_KEY" -H 'Content-Type: application/json' \
      --data-binary @- "http://localhost:1411$path")
  else
    out=$(podman exec -e PID_API_KEY pocket-id \
      curl -sS --max-time 10 -w '\n%{http_code}' -X "$method" \
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

  # The secret is OURS (Pocket ID >= 2.12.0 accepts a caller-supplied
  # value), so re-setting the same string every boot is a no-op that
  # also repairs a hand-edited or half-restored client. Consumers read
  # the identical value out of the same file, via the renders.
  secret_key=$(printf '%s' "$client" | jq -r '.secretKey')
  secret=$(grep "^$secret_key=" "$SECRETS" | head -1 | cut -d= -f2-)
  [ -n "$secret" ] || { echo "$key: $secret_key missing from $SECRETS" >&2; exit 1; }
  api POST "/api/oidc/clients/$id/secret" "$(jq -cn --arg s "$secret" '{secret: $s}')"
  [ "$API_CODE" = "200" ] || { echo "$key: setting secret failed (HTTP $API_CODE): $(cat "$RESP")" >&2; exit 1; }

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
      curl -sS --max-time 20 -w '\n%{http_code}' -X POST \
      -H "X-API-KEY: $PID_API_KEY" \
      -F "file=@-;filename=logo.${logo##*.};type=$type" \
      "http://localhost:1411/api/oidc/clients/$id/logo" < "$logo")
    code=${out##*$'\n'}
    [ "$code" = "204" ] || { echo "$key: logo upload failed (HTTP $code): ${out%$'\n'*}" >&2; exit 1; }
    echo "$key: uploaded logo"
  fi
done
