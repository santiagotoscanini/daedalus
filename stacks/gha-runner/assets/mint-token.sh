# Body of the per-start ExecStartPre of gha-runner-<repo>.service —
# exchange the PAT for a 1-hour registration token so the PAT itself
# never enters the runner container.
#
# Nix injects ENV_FILE (the sops dotenv with ACCESS_TOKEN) above this
# body, and writeShellApplication prepends `set -euo pipefail`. $1 is
# the repo name. Output is a podman --env-file on santiago's tmpfs
# (0400, rewritten each start, gone on reboot). A curl/jq failure
# fails ExecStartPre and rides the unit's restart loop.

repo="$1"
# shellcheck disable=SC1090
. "$ENV_FILE"
umask 077
token=$(curl -fsS -X POST \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/santiagotoscanini/${repo}/actions/runners/registration-token" \
  | jq -re .token)
printf 'RUNNER_TOKEN=%s\n' "$token" > "/run/user/1000/gha-runner-${repo}.env"
