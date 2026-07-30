# Body of gha-runner-metrics.service — poll the GitHub API and write
# gha_* gauges for node-exporter's textfile collector.
#
# Nix injects REPOS (space-separated fleet.apps keys), ENV_FILE (sops
# dotenv with ACCESS_TOKEN) and TEXTFILE_DIR above this body;
# writeShellApplication prepends `set -euo pipefail`.
#
# Per-repo API failures emit gha_exporter_ok=0 and keep going — only a
# missing secret or unwritable dir fails the unit (deliberately not in
# monitoredJobs: a GitHub outage should turn a dashboard tile red, not
# mail every minute).

# shellcheck disable=SC1090
. "$ENV_FILE"

api() {
  curl -fsS --max-time 20 \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/santiagotoscanini/$1"
}

read -ra repos <<< "$REPOS"
declare -A ok registered online busy queued inprog
for repo in "${repos[@]}"; do
  ok[$repo]=0
  if runners=$(api "$repo/actions/runners?per_page=100"); then
    ok[$repo]=1
    registered[$repo]=$(jq -r '.total_count' <<<"$runners")
    online[$repo]=$(jq -r '[.runners[] | select(.status == "online")] | length' <<<"$runners")
    busy[$repo]=$(jq -r '[.runners[] | select(.busy)] | length' <<<"$runners")
  fi
  # total_count is enough — per_page=1 keeps the payload tiny. These
  # two need "Actions: read" on the PAT (403 without it).
  if runs=$(api "$repo/actions/runs?status=queued&per_page=1" 2>/dev/null); then
    queued[$repo]=$(jq -r '.total_count' <<<"$runs")
  fi
  if runs=$(api "$repo/actions/runs?status=in_progress&per_page=1" 2>/dev/null); then
    inprog[$repo]=$(jq -r '.total_count' <<<"$runs")
  fi
done

tmp="$TEXTFILE_DIR/gha-runner.prom.$$"
{
  echo '# HELP gha_exporter_ok GitHub runners API reachable this sweep (1) or not (0).'
  echo '# TYPE gha_exporter_ok gauge'
  for repo in "${repos[@]}"; do
    echo "gha_exporter_ok{repo=\"$repo\"} ${ok[$repo]}"
  done
  echo '# HELP gha_runners_registered Self-hosted runners registered on the repo.'
  echo '# TYPE gha_runners_registered gauge'
  echo '# HELP gha_runners_online Self-hosted runners GitHub reports online.'
  echo '# TYPE gha_runners_online gauge'
  echo '# HELP gha_runners_busy Self-hosted runners currently running a job.'
  echo '# TYPE gha_runners_busy gauge'
  for repo in "${repos[@]}"; do
    [ -n "${registered[$repo]:-}" ] || continue
    echo "gha_runners_registered{repo=\"$repo\"} ${registered[$repo]}"
    echo "gha_runners_online{repo=\"$repo\"} ${online[$repo]}"
    echo "gha_runners_busy{repo=\"$repo\"} ${busy[$repo]}"
  done
  echo '# HELP gha_runs_queued Workflow runs waiting for a runner.'
  echo '# TYPE gha_runs_queued gauge'
  echo '# HELP gha_runs_in_progress Workflow runs currently executing.'
  echo '# TYPE gha_runs_in_progress gauge'
  for repo in "${repos[@]}"; do
    [ -n "${queued[$repo]:-}" ] \
      && echo "gha_runs_queued{repo=\"$repo\"} ${queued[$repo]}"
    [ -n "${inprog[$repo]:-}" ] \
      && echo "gha_runs_in_progress{repo=\"$repo\"} ${inprog[$repo]}"
  done
  true
} > "$tmp"
mv -f "$tmp" "$TEXTFILE_DIR/gha-runner.prom"
