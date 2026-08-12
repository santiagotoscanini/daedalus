# The two things a repo needs from this box before it can become an app, done
# on request instead of by hand.
#
#   set-secret  Put the registry's `ci` password in the repo's Actions secrets
#               as REGISTRY_PASSWORD, so its workflow can push. The password is
#               read HERE, from /run/secrets — it never enters the daedalus
#               container, the browser, or a page payload. The container asks
#               "authorise this repo"; it does not get to know what with.
#
#   run-ci      Dispatch the repo's publishing workflow, first making sure
#               something can serve the job: a repo that is already an app has
#               its own runner, and one that is not gets a one-shot
#               `gha-runner-bootstrap@<repo>` (stacks/gha-runner). This is what
#               breaks the first-image deadlock — the workflow is
#               `runs-on: self-hosted` and pushes to zot over registry-net, so
#               only this box can build it, and until it exists the app cannot
#               be declared.
#
# Same bridge as apply and deploy-trigger: the container writes a request into
# a bind mount, a systemd.path unit starts this as root. The trust boundary is
# "can write into $APPLY_DIR", and the Pocket ID gate in front of daedalus is
# what guards it.
#
# The repo name arrives from a browser and ends up in a systemd unit name, a
# URL and a `gh` argument, so it is validated against a strict pattern and then
# checked to actually exist under $OWNER. Both, not either: the pattern stops
# injection, the existence check stops a typo from starting a runner that would
# spend its life failing to register.

set -euo pipefail

REQ="$APPLY_DIR/ci-request.json"
STATUS="$APPLY_DIR/ci-status.json"

ACTION=""
REPO=""

write_status() {
  write_json_atomic "$STATUS" <<EOF
{"id":"$REQ_ID","action":$(jq -Rn --arg a "$ACTION" '$a'),"repo":$(jq -Rn --arg r "$REPO" '$r'),"state":"$1","detail":$(jq -Rn --arg d "${2-}" '$d'),"error":$(jq -Rn --arg e "${3-}" '$e'),"startedAt":"$STARTED_AT","finishedAt":"$(date -Is)"}
EOF
}

# Rejection vs malfunction, and they exit differently on purpose. A request
# this agent correctly refuses — a bad name, a repo that does not exist, a
# workflow with no dispatch trigger, GitHub throttling a burst — is reported in
# the UI and exits 0, because the agent worked. Only the agent being unable to
# do its job at all (no usable token, a runner that will not start) exits 1 and
# leaves a failed unit for `systemctl --failed` and the Grafana alert.
#
# Otherwise every fat-fingered repo name leaves a permanently failed unit, and
# the failed-units alert quietly becomes something you scroll past.
reject() {
  write_status failed "" "$1"
  echo "ci request rejected: $1" >&2
  exit 0
}

fail() {
  write_status failed "" "$1"
  echo "ci agent failure: $1" >&2
  exit 1
}

[ -f "$REQ" ] || exit 0

REQ_ID="$(jq -r '.id // ""' "$REQ")"
[ -n "$REQ_ID" ] || exit 0
STARTED_AT="$(date -Is)"

# The path unit re-fires on a daemon-reload replay at boot; without this guard
# a completed request would re-dispatch a workflow on every reboot.
if [ -f "$STATUS" ] && [ "$(jq -r '.id // ""' "$STATUS")" = "$REQ_ID" ]; then
  exit 0
fi

ACTION="$(jq -r '.action // ""' "$REQ")"
REPO="$(jq -r '.repo // ""' "$REQ")"
WORKFLOW="$(jq -r '.workflow // ""' "$REQ")"

case "$REPO" in
*[!A-Za-z0-9._-]* | "" | -* | .*) reject "refusing repo name '$REPO'" ;;
esac

write_status running "validating" ""

# The GitHub credential is the classic PAT that already authenticates image
# pulls (stacks/apps' authfile). It carries `repo`, which is what both verbs
# need: writing an Actions secret and dispatching a workflow. The gha-runner
# PAT is a different credential with a different job (minting registration
# tokens) and stays where it is.
GH_TOKEN="$(grep -o '"auth"[[:space:]]*:[[:space:]]*"[^"]*"' "$GHCR_AUTH" |
  head -1 | cut -d'"' -f4 | base64 -d | cut -d: -f2-)"
[ -n "$GH_TOKEN" ] || fail "no usable token in $GHCR_AUTH"
export GH_TOKEN

api() {
  curl -fsS \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}

# Status code and body, separately, because the difference between them is the
# whole message. `curl -f` alone collapses every non-2xx into one exit code, and
# the operator-facing sentence that came out of that said the repository does not
# exist — which is what a 404 means and is a lie for the 403 that a burst of
# requests actually earns. A wrong diagnosis on a red row is worse than none:
# it sends you to look at the repo instead of waiting a minute.
GH_BODY=""
GH_STATUS=0
api_probe() {
  local out
  out="$(curl -sS -w '\n%{http_code}' \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$1" 2>/dev/null)" || { GH_STATUS=0; GH_BODY=""; return 1; }
  GH_STATUS="${out##*$'\n'}"
  GH_BODY="${out%$'\n'*}"
  [ "$GH_STATUS" = "200" ]
}

if ! api_probe "https://api.github.com/repos/$OWNER/$REPO"; then
  case "$GH_STATUS" in
  404) reject "no repository $OWNER/$REPO" ;;
  401) fail "GitHub rejected the token (401) — the GHCR credential may have expired" ;;
  403 | 429)
    # Secondary rate limits are not the hourly quota and do not show up in it;
    # they are earned by bursts and clear on their own in about a minute.
    reject "GitHub refused with $GH_STATUS: $(printf '%s' "$GH_BODY" | jq -r '.message // "no message"' 2>/dev/null | head -c 200). If this was a burst of requests it clears on its own — try again shortly."
    ;;
  0) reject "could not reach api.github.com (DNS or network)" ;;
  *) reject "GitHub answered $GH_STATUS for $OWNER/$REPO: $(printf '%s' "$GH_BODY" | jq -r '.message // ""' 2>/dev/null | head -c 200)" ;;
  esac
fi

DEFAULT_BRANCH="$(printf '%s' "$GH_BODY" | jq -r '.default_branch // ""')"
[ -n "$DEFAULT_BRANCH" ] || fail "$OWNER/$REPO reports no default branch"

case "$ACTION" in
set-secret)
  PW="$(grep -m1 '^REGISTRY_CI_PASSWORD=' "$REGISTRY_ENV" | cut -d= -f2-)"
  [ -n "$PW" ] || fail "REGISTRY_CI_PASSWORD is empty in $REGISTRY_ENV"

  # gh, not the API directly: setting a secret means fetching the repo's public
  # key and sealing the value with libsodium's crypto_box_seal, and gh is the
  # implementation of that we already trust. Piped on stdin rather than passed
  # as --body, so the password is never a process argument.
  write_status running "sealing" ""
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  if printf '%s' "$PW" |
    HOME="$WORK" GH_CONFIG_DIR="$WORK" gh secret set REGISTRY_PASSWORD \
      --repo "$OWNER/$REPO" --app actions >/dev/null 2>"$WORK/err"; then
    write_status "done" "REGISTRY_PASSWORD set on $OWNER/$REPO" ""
  else
    fail "gh secret set failed: $(tail -c 400 "$WORK/err")"
  fi
  ;;

run-ci)
  case "$WORKFLOW" in
  *[!A-Za-z0-9._-]* | "") reject "refusing workflow name '$WORKFLOW'" ;;
  *.yml | *.yaml) ;;
  *) reject "workflow must be a .yml/.yaml filename, got '$WORKFLOW'" ;;
  esac

  # An app's own runner is already waiting for work, and starting a second
  # runner for the same repo would just be a spare that idles until its
  # RuntimeMaxSec. The bootstrap unit exists for repos that have no runner at
  # all, which is exactly the pre-declaration case.
  if systemctl is-active --quiet "gha-runner-$REPO.service"; then
    RUNNER="its own runner is already serving this repo"
  else
    write_status running "starting a bootstrap runner" ""
    systemctl start "gha-runner-bootstrap@$REPO.service" ||
      fail "could not start gha-runner-bootstrap@$REPO"
    RUNNER="a one-shot bootstrap runner was started"
  fi

  # Runs already waiting. Reported because a runner takes the OLDEST queued run
  # first and an ephemeral one takes exactly one job: with a backlog, the runner
  # started above serves somebody else's run and this dispatch stays queued —
  # which looks like the button did nothing. Counting is not fixing it, but a
  # number on screen is the difference between "broken" and "queued behind 4".
  QUEUED=0
  if api_probe "https://api.github.com/repos/$OWNER/$REPO/actions/runs?status=queued&per_page=100"; then
    QUEUED="$(printf '%s' "$GH_BODY" | jq -r '.workflow_runs | length' 2>/dev/null || echo 0)"
  fi

  # Dispatched AFTER the runner is up: a queued job with nothing to take it
  # just sits there, and the point of the ordering is that the run starts
  # while somebody is watching the page.
  write_status running "dispatching $WORKFLOW" ""
  DISPATCH="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/$OWNER/$REPO/actions/workflows/$WORKFLOW/dispatches" \
    -d "{\"ref\":\"$DEFAULT_BRANCH\"}" 2>/dev/null)" || DISPATCH=0

  case "$DISPATCH" in
  204) ;;
  404) reject "$OWNER/$REPO has no workflow file named $WORKFLOW on $DEFAULT_BRANCH" ;;
  422) reject "$WORKFLOW exists but has no workflow_dispatch trigger on $DEFAULT_BRANCH" ;;
  0) reject "could not reach api.github.com to dispatch $WORKFLOW" ;;
  *) reject "GitHub answered $DISPATCH dispatching $WORKFLOW on $DEFAULT_BRANCH" ;;
  esac

  BACKLOG=""
  [ "$QUEUED" -gt 0 ] 2>/dev/null &&
    BACKLOG=" — note: $QUEUED run(s) were already queued, and a runner takes the oldest first"

  write_status "done" "$WORKFLOW dispatched on $DEFAULT_BRANCH — $RUNNER$BACKLOG" ""
  ;;

*)
  reject "unknown action '$ACTION'"
  ;;
esac
