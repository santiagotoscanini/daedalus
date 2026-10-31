# shellcheck shell=bash
# Apply fleet.sso.metadataClients to every Client ID Metadata Document client
# Pocket ID holds. The body of pocket-id-metadata-clients, wrapped in
# ../clients.nix after api.sh; parameters: POLICY (store JSON: reauth,
# groups, refreshMinutes or null).
#
# Why: a CIMD client's id is an https URL every user of that app shares (all
# of Claude, say), and Pocket ID remembers consent per user and client. Once
# you have approved such a client, a sign-in link for it that someone else
# started finishes silently while your session lasts, and the token lands in
# THEIR account. Requiring reauthentication puts your passkey in front of
# every authorization, and the group restriction keeps other users out.
#
# A CIMD client only exists after its first sign-in, so this runs on a short
# timer, not just at rebuild. Pocket ID keeps these settings across metadata
# refreshes (the refresh owns only the fields the document sets). A client is
# addressed as `~<base64url of its id>`, the form Pocket ID's own UI uses.

api GET '/api/user-groups?pagination%5Blimit%5D=100'
[ "$API_CODE" = "200" ] || { echo "listing user groups failed (HTTP $API_CODE): $(cat "$RESP")" >&2; exit 1; }
group_ids=$(jq -c --argjson want "$(jq -c '.groups' "$POLICY")" \
  '{userGroupIds: [.data[] | select(.name as $n | $want | index($n)) | .id]}' < "$RESP")
[ "$(printf '%s' "$group_ids" | jq '.userGroupIds | length')" = "$(jq '.groups | length' "$POLICY")" ] \
  || { echo "unknown Pocket ID group in $(jq -c '.groups' "$POLICY")" >&2; exit 1; }

api GET '/api/oidc/clients?pagination%5Blimit%5D=200'
[ "$API_CODE" = "200" ] || { echo "listing clients failed (HTTP $API_CODE): $(cat "$RESP")" >&2; exit 1; }
ids=$(jq -r '.data[] | select(.clientType == "cimd") | .id' < "$RESP")

while read -r id; do
  [ -n "$id" ] || continue
  param="~$(printf '%s' "$id" | base64 -w0 | tr '+/' '-_' | tr -d '=')"

  api GET "/api/oidc/clients/$param"
  [ "$API_CODE" = "200" ] || { echo "$id: lookup failed (HTTP $API_CODE): $(cat "$RESP")" >&2; exit 1; }

  # Already as the policy says: nothing to write (this runs every few minutes).
  if jq -e --slurpfile p "$POLICY" '
      .requiresReauthentication == $p[0].reauth and .isGroupRestricted and (.skipConsent | not)
      and ($p[0].refreshMinutes == null or .refreshTokenDurationMinutes == $p[0].refreshMinutes)
      and ([.allowedUserGroups[]?.name] | sort) == ($p[0].groups | sort)' < "$RESP" >/dev/null; then
    continue
  fi

  # A full update body: Pocket ID writes only its admin-owned columns for a
  # metadata client, but validates the whole body.
  body=$(jq -c --slurpfile p "$POLICY" '{
      name, description, callbackURLs, logoutCallbackURLs,
      backchannelLogoutURL: (.backchannelLogoutURL // ""),
      isPublic, pkceEnabled, requiresPushedAuthorizationRequests,
      credentials: (.credentials // {}), launchURL, hasLogo, hasDarkLogo,
      accessTokenDurationMinutes,
      refreshTokenDurationMinutes: ($p[0].refreshMinutes // .refreshTokenDurationMinutes),
      requiresReauthentication: $p[0].reauth,
      skipConsent: false,
      isGroupRestricted: true
    }' < "$RESP")
  api PUT "/api/oidc/clients/$param" "$body"
  [ "$API_CODE" = "200" ] || { echo "$id: update failed (HTTP $API_CODE): $(cat "$RESP")" >&2; exit 1; }

  api PUT "/api/oidc/clients/$param/allowed-user-groups" "$group_ids"
  [ "$API_CODE" = "200" ] || { echo "$id: setting allowed groups failed (HTTP $API_CODE): $(cat "$RESP")" >&2; exit 1; }
  echo "$id: hardened (reauthentication $(jq -r .reauth "$POLICY"), groups $(jq -c .groups "$POLICY"))"
done <<< "$ids"
