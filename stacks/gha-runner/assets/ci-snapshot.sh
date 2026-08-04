# Publish per-repo CI state for daedalus to render.
#
# Separate from metrics.sh on purpose. That script is a prometheus exporter:
# a handful of counters, cheap, and its failure mode is a red dashboard tile.
# This one produces the shape a UI needs — the running job, its steps, the
# recent runs — and its failure mode is a stale panel. Same PAT, different
# consumers, different blast radius when GitHub is down.
#
# The PAT never leaves the host. daedalus gets a read-only bind mount of the
# output, exactly like the container env snapshot: an app that can render CI
# state should not also hold a credential with Administration:write on the
# repos. Written to /run (tmpfs) for the same reason — and because this is
# derived state that should not survive a reboot.
#
# Nix injects REPOS, ENV_FILE and OUT_DIR above this body;
# writeShellApplication prepends `set -euo pipefail`.

# shellcheck disable=SC1090
. "$ENV_FILE"

# The directory is created by systemd (RuntimeDirectory=gha-ci) because this
# runs as santiago, who cannot mkdir in /run.
[ -d "$OUT_DIR" ] || {
  echo "$OUT_DIR missing — RuntimeDirectory should have created it" >&2
  exit 1
}

api() {
  curl -fsS --max-time 20 \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/santiagotoscanini/$1"
}

read -ra repos <<<"$REPOS"

for repo in "${repos[@]}"; do
  # `ok:false` is a first-class state, not an absence. A panel that renders
  # "no runners" when the API is unreachable is worse than one that says it
  # could not ask — the first reads as a fact about the box.
  runners='{"total_count":0,"runners":[]}'
  ok=true
  if ! runners=$(api "$repo/actions/runners?per_page=100"); then
    ok=false
    runners='{"total_count":0,"runners":[]}'
  fi

  # Last 10 runs is one call and covers both the history list and "is
  # something running right now" — filtering client-side beats three more
  # round trips per repo per minute.
  runs='{"workflow_runs":[]}'
  api "$repo/actions/runs?per_page=10" >/dev/null 2>&1 && runs=$(api "$repo/actions/runs?per_page=10") || ok=false

  # Steps only for a run that is actually active. This is the one call that
  # gives "step 3 of 5, docker build" — the runners endpoint knows a runner is
  # busy but not what it is busy with.
  active=$(jq -r '[.workflow_runs[] | select(.status=="in_progress" or .status=="queued")][0].id // empty' <<<"$runs")
  jobs='{"jobs":[]}'
  if [ -n "$active" ]; then
    jobs=$(api "$repo/actions/runs/$active/jobs" 2>/dev/null || echo '{"jobs":[]}')
  fi

  # Trimmed through FILES, not --argjson. A GitHub workflow_run object embeds
  # the full repository and actor records, so ten of them as a command-line
  # argument is hundreds of KB and exec() fails outright with
  # "Argument list too long" — a whole-script failure, not a truncation.
  work="$OUT_DIR/.$repo.work"
  rm -rf "$work" && mkdir -p "$work"

  jq '[.runners[] | { name, status, busy, labels: [.labels[].name] }]' \
    <<<"$runners" >"$work/runners.json"

  # A job carries the runner name, which is what lets the UI say WHICH runner
  # is building — the runners endpoint knows a runner is busy, not with what.
  jq '[.jobs[] | select(.status=="in_progress" or .status=="queued") | {
        name, status,
        runnerName: .runner_name,
        startedAt: .started_at,
        htmlUrl: .html_url,
        steps: [.steps[]? | { name, status, conclusion, number }]
      }]' <<<"$jobs" >"$work/jobs.json"

  jq '[.workflow_runs[] | {
        id, name, status, conclusion, event,
        sha: .head_sha,
        title: .display_title,
        branch: .head_branch,
        createdAt: .created_at,
        updatedAt: .updated_at,
        htmlUrl: .html_url
      }]' <<<"$runs" >"$work/runs.json"

  tmp="$OUT_DIR/.$repo.tmp"
  jq -n \
    --argjson ok "$ok" \
    --arg repo "$repo" \
    --slurpfile runners "$work/runners.json" \
    --slurpfile activeJobs "$work/jobs.json" \
    --slurpfile runs "$work/runs.json" \
    '{
      ok: $ok,
      repo: $repo,
      runners: $runners[0],
      activeJobs: $activeJobs[0],
      runs: $runs[0]
    }' >"$tmp"

  rm -rf "$work"
  chmod 0644 "$tmp"
  mv "$tmp" "$OUT_DIR/$repo.json"
done

# Drop snapshots for repos that are no longer apps. $REPOS is
# whitespace-separated and `case` matches literally, so normalise first —
# getting this wrong deletes every file it just wrote.
haystack=" $(printf '%s' "$REPOS" | tr -s '[:space:]' ' ') "
for f in "$OUT_DIR"/*.json; do
  [ -e "$f" ] || continue
  name=$(basename "$f" .json)
  case "$haystack" in
  *" $name "*) ;;
  *) rm -f "$f" ;;
  esac
done
