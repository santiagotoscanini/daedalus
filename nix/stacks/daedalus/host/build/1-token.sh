# host/build/1-token.sh — stage 1 of the build (see host/build.sh).
#
# Mint a read-only token for this one repository, and confirm the repository
# is still the one the app was connected to, owned by the trusted account.
#
# ── 1. a token for this one repository ────────────────────────────────────

enter cloning "requesting a repository token"
[ -r "$PEM" ] || agent_fail "the App's private key is not on the host ($PEM)"
gh_app_auth || agent_fail "could not sign a JWT with the App's private key ($PEM)"

rc=0
gh_installation || rc=$?
case "$rc" in
0) ;;
2) fail "GitHub: $GH_REASON" ;;
*) fail "GitHub: $GH_ERROR" ;;
esac

# Narrowed below the minter's grant: this one repository, read-only.
jq -n --arg app "$APP" '{repositories: [$app], permissions: {contents: "read", metadata: "read"}}' >"$GH_TMP/mint.json"
gh_mint "$GH_TMP/mint.json" || fail "GitHub: $GH_ERROR"
TOKEN_LIVE=1
if ! jq -j '.token' "$GH_TMP/token.json" | gh_write_config "$GH_TMP/repo.curlrc"; then
  agent_fail "GitHub minted a token this agent cannot use"
fi

# The repository must be the one the app was connected to: a deleted and
# recreated repo under the same name has a new id, and the default branch is
# read from GitHub, never from the request.
gh_api GET "/repos/$OWNER/$APP" "$GH_TMP/repo.curlrc" || fail "GitHub: $GH_ERROR"
[ "$GH_STATUS" = 200 ] || fail "reading $OWNER/$APP: $(gh_message)"
# …and owned by the account this box trusts. OWNER_ID is the nix constant
# fleet.github.expectedOwnerId, never site.json's copy, which the container
# can write through Apply.
GOT_OWNER="$(jq -r '.owner.id // "" | tostring' "$GH_TMP/body")"
[ "$GOT_OWNER" = "$OWNER_ID" ] || fail "$OWNER/$APP is owned by GitHub account ${GOT_OWNER:0:20}, not this box's owner ($OWNER_ID)"
GOT_ID="$(jq -r '.id // "" | tostring' "$GH_TMP/body")"
[ "$GOT_ID" = "$REPO_ID" ] || fail "$OWNER/$APP is repository ${GOT_ID:0:20} on GitHub, not $REPO_ID: it was replaced since the app was connected"
DEF="$(jq -r '.default_branch // "" | strings' "$GH_TMP/body")"
if ! [[ "$DEF" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$ ]] || [[ "$DEF" == *..* || "$DEF" == *//* || "$DEF" == */ || "$DEF" == *.lock ]]; then
  fail "GitHub reports a default branch this builder will not fetch: ${DEF:0:100}"
fi
