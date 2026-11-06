# shellcheck shell=bash
# The web console's admin-API token: scoped, never full, minted on the box.
#
# Parameters (set by the wrapper in garage.nix):
#   ENV_FILE        <machineState>/garage/console/env, the file we emit
#   TOKEN_NAME      the token's name in Garage
#   SCOPE           JSON array of the admin endpoints the console calls
#   OPERATOR_USER, OPERATOR_GROUP   owner of the env file
#
# Garage shows a token's secret once, at creation, and cannot import one —
# so unlike an access key, Garage is where the token is born and the env file
# only remembers it. Every run: keep the remembered token when Garage still
# knows its id (converging its scope to the declared one), otherwise mint a
# new one; then delete any other token under the same name, which is what a
# rotation (delete the env file, rebuild) leaves behind. Runs as the operator;
# every call is `garage json-api` over the RPC loopback, bodies on stdin.

api() { podman exec -i garage /garage json-api "$1" -; }

install -d -m 0700 "$(dirname "$ENV_FILE")"

token=
if [ -e "$ENV_FILE" ]; then
  token=$(grep -m1 '^GARAGE_UI_GARAGE_ADMIN_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)
fi
# A token is "<id>.<secret>"; the id alone is what the API looks up.
tid=${token%%.*}

if [ -n "$token" ] && info=$(jq -nc --arg id "$tid" '{id: $id}' | api GetAdminTokenInfo 2>/dev/null); then
  if [ "$(jq -c '.scope | sort' <<<"$info")" != "$(jq -c 'sort' <<<"$SCOPE")" ]; then
    jq -nc --arg id "$tid" --argjson s "$SCOPE" '{id: $id, body: {scope: $s}}' | api UpdateAdminToken >/dev/null
    echo "converged the scope of $TOKEN_NAME"
  fi
else
  created=$(jq -nc --arg n "$TOKEN_NAME" --argjson s "$SCOPE" '{name: $n, neverExpires: true, scope: $s}' | api CreateAdminToken)
  token=$(jq -er '.secretToken' <<<"$created")
  tid=$(jq -er '.id' <<<"$created")
  install -m 0600 -o "$OPERATOR_USER" -g "$OPERATOR_GROUP" /dev/stdin "$ENV_FILE" <<EOF
GARAGE_UI_GARAGE_ADMIN_TOKEN=$token
EOF
  echo "minted $TOKEN_NAME ($tid)"
fi

# ListAdminTokens takes no payload: called bare, not through `api`.
podman exec garage /garage json-api ListAdminTokens |
  jq -r --arg n "$TOKEN_NAME" --arg id "$tid" '.[] | select(.name == $n and .id != $id) | .id' |
  while read -r old; do
    jq -nc --arg id "$old" '{id: $id}' | api DeleteAdminToken >/dev/null
    echo "deleted superseded token $old"
  done
