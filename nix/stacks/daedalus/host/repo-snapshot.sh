# Publish the state of the configuration repository — the flake a rebuild
# reads — and of the SITE DIRECTORY inside it (fleet.site.path), the one
# directory daedalus writes, for the Settings › Site tab.
#
# The container deliberately never mounts either: root inside it is the
# operator uid, and the configuration tree holds machine-generated plaintext
# (app-db passwords, per-app AUTH_SECRETs) under gitignored secrets/ dirs. So
# the facts are read here on the host and published like the image labels and
# the SMART data: a file in /run, read through a read-only mount.
#
# For each managed site file the facts include a DIGEST rather than bytes:
# daedalus renders the same bytes it would write, hashes them, and compares,
# so "current" is a claim about the file without either side reading the
# other's copy.
#
# Runs as root (its timer's unit) and drops to the operator for every git
# call. Both repos are operator-owned, and one root-owned object under .git is
# the "unable to open loose object" push failure CLAUDE.md warns about.
# `--no-optional-locks` on top, so even `status` never rewrites the index.
#
# No fetch. A snapshot must not open a connection or need a credential.
# "vs origin" is measured against whatever ref the last push or pull left
# behind, and the tab says so.

set -euo pipefail

install -d -m 0755 -o "$OPERATOR_USER" -g "$OPERATOR_GROUP" "$OUT_DIR"

git_() {
  local dir="$1"
  shift
  "$SETPRIV" --reuid="$OPERATOR_USER" --regid="$OPERATOR_GROUP" --init-groups --inh-caps=-all \
    "$ENV_BIN" HOME="$OPERATOR_HOME" \
    "$GIT" --no-optional-locks -C "$dir" "$@"
}

# Every git fact about one repository, as a JSON object on stdout.
#
# `path` is deliberately NOT among them: the caller knows which directory it
# asked about, and leaving it out is what lets this object be merged into
# containers that carry the path themselves.
repo_facts() {
  local dir="$1"

  # Each fact independently, each with an empty fallback: a repo with no
  # upstream, or no Apply commit yet, is a state to report, not a failed run.
  local remote branch head_rev head_subject head_at
  remote=$(git_ "$dir" remote get-url origin 2>/dev/null || true)
  branch=$(git_ "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  head_rev=$(git_ "$dir" rev-parse HEAD 2>/dev/null || true)
  head_subject=$(git_ "$dir" log -1 --format=%s 2>/dev/null || true)
  head_at=$(git_ "$dir" log -1 --format=%cI 2>/dev/null || true)

  # Porcelain v1: `??` rows are untracked, everything else is a tracked change.
  # The two mean different things to the flake — an untracked file is INVISIBLE
  # to a rebuild, which is the "file not found" trap — so they are counted apart.
  local status line untracked modified
  status=$(git_ "$dir" status --porcelain=v1 --untracked-files=normal 2>/dev/null || true)
  untracked=0
  modified=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
    '??'*) untracked=$((untracked + 1)) ;;
    *) modified=$((modified + 1)) ;;
    esac
  done <<EOF
$status
EOF

  local upstream counts ahead behind
  upstream=$(git_ "$dir" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)
  ahead=0
  behind=0
  if [ -n "$upstream" ]; then
    # "<behind>\t<ahead>" — left is the upstream side of the range.
    counts=$(git_ "$dir" rev-list --left-right --count '@{upstream}...HEAD' 2>/dev/null || echo "0	0")
    behind=${counts%%	*}
    ahead=${counts##*	}
  fi

  # The most recent commit the apply agent made. apply.sh writes this exact
  # trailer into every commit it authors — in both repositories — so matching
  # it is how "last Apply" is distinguished from a hand commit that happens to
  # touch the same file.
  local apply_rev apply_subject apply_at apply_line rest
  apply_rev=""
  apply_subject=""
  apply_at=""
  apply_line=$(git_ "$dir" log -1 --grep='Applied from daedalus' --format='%H%x1f%s%x1f%cI' 2>/dev/null || true)
  if [ -n "$apply_line" ]; then
    apply_rev=${apply_line%%$'\x1f'*}
    rest=${apply_line#*$'\x1f'}
    apply_subject=${rest%%$'\x1f'*}
    apply_at=${rest##*$'\x1f'}
  fi

  "$JQ" -n \
    --arg remote "$remote" \
    --arg branch "$branch" \
    --arg headRev "$head_rev" \
    --arg headSubject "$head_subject" \
    --arg headAt "$head_at" \
    --argjson modified "$modified" \
    --argjson untracked "$untracked" \
    --arg upstream "$upstream" \
    --argjson ahead "$ahead" \
    --argjson behind "$behind" \
    --arg applyRev "$apply_rev" \
    --arg applySubject "$apply_subject" \
    --arg applyAt "$apply_at" \
    '{
      remote: (if $remote == "" then null else $remote end),
      branch: (if $branch == "" then null else $branch end),
      head: (if $headRev == "" then null else
        { rev: $headRev, subject: $headSubject, committedAt: $headAt } end),
      tree: { modified: $modified, untracked: $untracked },
      upstream: (if $upstream == "" then null else
        { ref: $upstream, ahead: $ahead, behind: $behind } end),
      lastApply: (if $applyRev == "" then null else
        { rev: $applyRev, subject: $applySubject, committedAt: $applyAt } end)
    }'
}

# One managed file in the site directory, as the facts the tab needs: is it
# there, does git know about it, and a digest of its bytes (for "is this what
# the box would write now" — compared app-side, never by content).
#
# The status names what a REBUILD would see. A flake copies the working tree
# of TRACKED files, so `modified` and `staged` are both visible to nix and
# `untracked` is not — that last one is the "file not found" trap, and the
# only status here that is a warning rather than a fact.
site_file() {
  local f="$SITE_DIR/$1" status="absent" sha="null" porcelain hash
  if [ -f "$f" ]; then
    # Hashed as the operator, never through a link: the site directory is
    # theirs, and a digest root computes of whatever a link points at is an
    # oracle for any file on the box ("is /run/secrets/x this value?").
    # Unreadable that way publishes a null digest rather than a wrong one.
    if hash="$(as_operator dd if="$f" iflag=nofollow,nonblock status=none 2>/dev/null | sha256sum)"; then
      sha="\"${hash%% *}\""
    fi
    if [ -n "$site_toplevel" ]; then
      porcelain=$(git_ "$SITE_DIR" status --porcelain=v1 -- "$f" 2>/dev/null | cut -c1-2)
      case "$porcelain" in
      '') status=clean ;;
      '??') status=untracked ;;
      'A '|'M '|'R '|'C ') status=staged ;;
      *) status=modified ;;
      esac
    else
      status=unversioned
    fi
  fi
  "$JQ" -n --arg s "$status" --argjson sha "$sha" '{ status: $s, sha256: $sha }'
}


# When each app secret was last written, and by whom — the audit trail behind
# the write-only secrets editor (host/secret-set.sh).
#
# The VALUES in site/vault/apps/<app>-env.sops are unreadable to the container
# by design, so "who set this, and when" is the whole of what it can be told
# about them. That fact lives in git and nowhere else, and it is legible
# because a sops dotenv keeps its key NAMES in the clear: the newest commit
# whose diff added a `KEY=` line to an app's file IS the last time that key was
# set.
#
# One `git log --patch` over the directory, parsed once. Only commits touching
# these files are walked and `-n 200` caps it, so this costs a fraction of the
# `status` calls above.
#
# The actor is the PERSON, not the committer. Both agents commit as `daedalus`
# and record who asked in the body ("Applied from daedalus by <actor>."); a
# hand `sops` edit over SSH has no such line, and its author name is the honest
# answer — the same trailer repo_facts matches on for lastApply.
#
# Never fails: every branch ends in a JSON object, because a git call that
# cannot answer is a field the page renders as "no date", not a failed run.
app_secret_history() {
  local out=""
  if [ -n "$site_toplevel" ] && [ -d "$SITE_DIR/vault/apps" ]; then
    out=$(
      {
        git_ "$SITE_DIR" log -n 200 --no-color --no-renames --unified=0 \
          --format='%x01%H%x1f%cI%x1f%an%x1f%b%x02' --patch \
          -- "$SITE_DIR/vault/apps" 2>/dev/null || true
      } | "$AWK" '
        # One record per commit: three header fields, the body, then the patch.
        BEGIN { RS = "\001"; FS = "\037" }
        # Whatever preceded the first commit marker. Always empty; never data.
        NR == 1 { next }
        {
          rev = substr($1, 1, 7); at = $2; actor = $3
          rest = $4
          p = index(rest, "\002")
          body = (p > 0) ? substr(rest, 1, p - 1) : ""
          patch = (p > 0) ? substr(rest, p + 1) : rest
          # To end of line, then the trailing period — an actor is an email
          # address, and stopping at the first dot truncated every one of them.
          if (match(body, /Applied from daedalus by [^\n]+/)) {
            actor = substr(body, RSTART + 25, RLENGTH - 25)
            sub(/\.$/, "", actor)
          }
          app = ""
          n = split(patch, line, "\n")
          for (i = 1; i <= n; i++) {
            l = line[i]
            # A file header names which app the + lines below it belong to. A
            # deletion says +++ /dev/null, which fails the shape and clears the
            # name — an unrecognised header attributes nothing to anybody.
            if (substr(l, 1, 4) == "+++ ") {
              app = l
              if (sub(/^.*\/vault\/apps\//, "", app) && sub(/-env\.sops$/, "", app) && app ~ /^[a-z0-9-]+$/) continue
              app = ""
              continue
            }
            if (app == "") continue
            if (l ~ /^\+[A-Za-z_][A-Za-z0-9_]*=/) {
              key = substr(l, 2); sub(/=.*/, "", key)
              # sops own rows (sops_mac, sops_version) change on every write.
              if (key ~ /^sops_/) continue
              # Newest first, so the first sighting of a key is its last write.
              id = app "\037" key
              if (id in seen) continue
              seen[id] = 1
              printf "%s\037%s\037%s\037%s\037%s\n", app, key, at, actor, rev
            }
          }
        }
      ' | "$JQ" -R -s 'split("\n") | map(select(length > 0) | split("\u001f"))
            | reduce .[] as $r ({};
                .[$r[0]][$r[1]] = { setAt: $r[2], actor: $r[3], rev: $r[4] })' 2>/dev/null || true
    )
  fi
  case "$out" in
  '') echo '{}' ;;
  *) echo "$out" ;;
  esac
}

# The engine as the lock pins it: flake.lock's node for the `daedalus` input,
# which is what the box was built from. The Updates page's engine card joins
# this with the workspace snapshot's view of the engine CLONE (its head, how
# far behind origin) to say whether an update would move anything; the
# update agent (host/engine-update.sh) reads the same node itself.
#
# `type`, `url` and `ref` are the input as flake.nix WROTE it — `git` with a
# `file://` url is a local clone, `github` a published rev — so a reader can
# say where "latest" comes from without parsing flake.nix. `lastModified` is
# the locked commit's date, ISO 8601 from the lock's epoch seconds.
#
# Read as the operator, never through a link: the lock is in their tree.
# Null when there is no lock, no such input, or nothing parses — "unknown",
# never a guess. Never fails.
engine_lock() {
  local lock
  lock=$(read_as_operator "$REPO_DIR/flake.lock" 2>/dev/null || true)
  if [ -z "$lock" ]; then
    echo null
    return
  fi
  "$JQ" -c '
    .nodes[.nodes.root.inputs.daedalus // ""] // null
    | if . == null or (.locked.rev // "") == "" then null else {
        rev: .locked.rev,
        lastModified: (.locked.lastModified | if . == null then null else todate end),
        type: (.original.type // ""),
        url: (.original.url // null),
        ref: (.original.ref // null)
      } end' <<<"$lock" 2>/dev/null || echo null
}

config_facts=$(repo_facts "$REPO_DIR")
engine=$(engine_lock)

# The site directory: where it is, whether it is inside a work tree (and
# whether that work tree is the configuration repo above — the intended
# arrangement), and the state of each file daedalus manages there.
site_toplevel=""
if [ -d "$SITE_DIR" ]; then
  site_toplevel=$(git_ "$SITE_DIR" rev-parse --show-toplevel 2>/dev/null || true)
fi

# Every file daedalus writes there, not only the two nix reads: README.md and
# daedalus.json are rendered by the app like the rest, so the tab can report
# whether the directory holds what this box would write. Only the reproducible
# ones are actually compared app-side — daedalus.json carries a timestamp.
site=$("$JQ" -n \
  --arg path "$SITE_DIR" \
  --argjson exists "$([ -d "$SITE_DIR" ] && echo true || echo false)" \
  --arg toplevel "$site_toplevel" \
  --arg repo "$REPO_DIR" \
  --argjson siteFile "$(site_file site.json)" \
  --argjson appsFile "$(site_file apps.json)" \
  --argjson readmeFile "$(site_file README.md)" \
  --argjson stampFile "$(site_file daedalus.json)" \
  --argjson appSecrets "$(app_secret_history)" \
  '{
    path: $path,
    exists: $exists,
    toplevel: (if $toplevel == "" then null else $toplevel end),
    inThisRepo: ($toplevel != "" and $toplevel == $repo),
    files: {
      "site.json": $siteFile,
      "apps.json": $appsFile,
      "README.md": $readmeFile,
      "daedalus.json": $stampFile
    },
    appSecrets: $appSecrets
  }')

"$JQ" -n \
  --arg g "$("$DATE" -Is)" \
  --arg path "$REPO_DIR" \
  --argjson config "$config_facts" \
  --argjson site "$site" \
  --argjson engine "$engine" \
  '{
    daedalusExport: 1,
    domain: "repo",
    # 6: engine — the lock node of the daedalus flake input, for the Updates
    # page. Null when the lock has no such input.
    # 5: site gained appSecrets — per-key git facts for the operator-secrets
    # files, which is what the app page reads "set <when> by <who>" from.
    # 4: site.files gained README.md and daedalus.json. The reader accepts the
    # older numbers too — for the minutes between a switch and the next run of
    # this timer, the file on disk is still the old shape.
    schemaVersion: 6,
    source: "host",
    revision: null,
    generatedAt: $g,
    data: ({ path: $path } + $config + { site: $site, engine: $engine })
  }' | write_json_atomic "$OUT_DIR/repo.json"

config_line=$("$JQ" -r '"\(.branch // "?")@\(.head.rev // "-------" | .[0:7]) +\(.tree.modified)/\(.tree.untracked) dirty, \(.upstream.ahead // 0)/\(.upstream.behind // 0) vs \(.upstream.ref // "no upstream")"' <<<"$config_facts")
echo "published repo facts: config $config_line; site $("$JQ" -r '"exists=\(.exists) in-repo=\(.inThisRepo) site.json=\(.files["site.json"].status)"' <<<"$site"); engine $("$JQ" -r 'if . == null then "unknown" else "\(.type)@\(.rev[0:7])" end' <<<"$engine")"
