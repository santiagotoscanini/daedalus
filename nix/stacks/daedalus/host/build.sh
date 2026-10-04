# Build one app's image on daedalus's behalf: fetch the requested commit, work
# out what the app is, run its checks, build and push it with the box's
# rootless BuildKit, and start its deploy.
#
# ONE script in nine files. build-agent.nix concatenates, in order: the
# variables nix hands it, host/lib.sh, host/github-lib.sh, then
#
#   host/build.sh                     this file: the trust model and the settings
#   host/build-stages/states.sh       which states mean "in flight"
#   host/build-stages/helpers.sh      the machinery every stage uses
#   host/build-stages/0-request.sh    validate the request, start the log
#   host/build-stages/1-token.sh      a read-only token for this one repository
#   host/build-stages/2-clone.sh      fetch the commit, pick the strategy
#   host/build-stages/3-detect.sh     `railpack prepare` → the build plan
#   host/build-stages/4-checks.sh     the repository's own checks, in BuildKit
#   host/build-stages/5-publish.sh    build the image and push it
#   host/build-stages/6-done.sh       start the deploy, publish the final status
#
# The variables (build-agent.nix comments each one): VERBS_DIR, SITE_DIR,
# NIX_APPS, DEPLOYABLE, OWNER, OWNER_ID, CLIENT_ID, PEM, REGISTRY,
# NPM_MIRROR_HOST, LAN_IP, NODE_IMAGE, BUILDKIT_ADDR, RAILPACK_FRONTEND,
# DOCKER_CONFIG_DIR, BUILD_ROOT, WORK_ROOT, MISE_CACHE_DIR, MISE_MOUNT,
# MISE_PATH, MISE_BINARY, LOG_DIR, BUILD_USER, BUILD_GROUP, BUILD_PATH,
# CHECKS_DOCKERFILE, FENCE_CHECK, OPERATOR_USER, OPERATOR_GROUP, OPERATOR_HOME,
# SETPRIV, ENV_BIN, GIT.
#
# ── in and out ────────────────────────────────────────────────────────────
#
#   the run file's payload         the engine's request (app/src/lib/builds.ts
#                                  buildRequestDecoder, with the `buildEnv`
#                                  field described below), handed over by the
#                                  root helper (host/lib.sh take_request)
#   $VERBS_DIR/build-status.json   written here (buildStatusDecoder), rewritten
#                                  at least every $HEARTBEAT_SECS while running:
#                                  the engine presumes a status older than 90 s
#                                  dead (BUILD_STATUS_MAX_AGE_MS). Root's
#                                  directory, read-only in the container
#   $LOG_DIR/<id>.log              root 0644, redacted as it is written, capped
#                                  at 20 MiB; the container reads it at /builds
#
# `buildEnv` — { railpack: { RAILPACK_X: value } } — carries the app's Railpack
# switches (RAILPACK_KNOBS below). They reach Railpack through its process
# environment, never an argument. Optional; absent means none. The box passes
# no build secrets at all: a plan that declares one fails detection
# (3-detect.sh), and a repo that needs a build-time value declares a dummy
# one in its own railpack.json.
#
# ── which apps it builds ──────────────────────────────────────────────────
#
# One the committed registry names, read when the run starts (0-request.sh,
# helpers.sh registry_entry): the entry staged for site/apps.json in the
# configuration repository, read through git as the operator. It must be a
# registry-source entry, and not one of $NIX_APPS, the apps the host declares
# by hand: nix would refuse an entry that shadows one, and this read does not
# evaluate anything. No list is baked in, because a new app's entry waits for
# its first image (`awaitingImage`) and no rebuild happens before that build.
#
# Why this gives the container nothing it did not have. The site directory,
# its index and its commits are written only by root verbs (apply, register,
# secret-set) and by the operator, and the container reaches those verbs with
# bytes only. When the list was baked, one Apply (which the container may ask
# for) made any name buildable, and the evaluation that Apply ran checked one
# property that matters to a build: that the name is not a hand-declared app.
# $NIX_APPS checks that now. `register` commits an entry without a rebuild, but
# only an awaiting one, and nix builds nothing for an awaiting entry
# (modules/apps/declarations.nix). So all an entry gets is this build of
# github.com/$OWNER/<name>, the same as before: the owner id is the nix
# constant, the repository id must be the one the app was linked to
# (1-token.sh), and the image goes to <registry>/<name> only. The deploy it may
# start is from the baked $DEPLOYABLE, so its unit exists only after an Apply
# set the app up. An awaiting app is never in that list. Its container is
# started by the activation of the Apply that sets it up, not by this run, so
# the two cannot race.
#
# The name becomes part of paths (the mise cache, the cache repository), and
# part of a unit name only through $DEPLOYABLE. It is held to
# ^[a-z0-9]{1,63}$: the app-name rule, minus the hyphen that cache mount ids
# cannot carry.
#
# ── who does what ─────────────────────────────────────────────────────────
#
# Root orchestrates and holds the App's key. Everything that touches repository
# content runs as $BUILD_USER through setpriv, with an environment rebuilt from
# nothing (build_env): its own HOME inside the work dir, no git config at all,
# no credential helper, no trace variables. The repository is hostile input —
# a `package.json` can be a symlink to /etc/shadow — so root never opens a
# file in the work dir by name: it reads them through the build user with
# O_NOFOLLOW, the rule host/lib.sh states for every operator-writable directory.
#
# Root's own scratch lives in $CTL, a directory under the unit's private /tmp
# that only root can write: the stripped Railpack plan, the checks plan, the
# secret files and the clone token (group-readable by the build user, which
# must hand them to git and buildctl), and the status bookkeeping in $P (0700).
#
# ── the registry credential ───────────────────────────────────────────────
#
# The zot push credential can overwrite any app's :latest — live two minutes
# later — and repository code DOES run as the build user: `railpack prepare`
# evaluates the repo's own mise config (spike B12). So builder.nix renders it
# root 0400, and the build user holds a copy for exactly one process, the
# buildctl call that publishes: reap_build_processes first kills anything the
# earlier stages left behind, root copies the file (never through a link)
# into $CTL/docker — dir 0700, file 0400, the build user's — and deletes it
# the moment that buildctl exits, and again in on_exit. Every other build-user
# process (the builder probe, the clone, detection, both checks solves) runs
# with DOCKER_CONFIG at the empty $CTL/docker-none: checks and cache imports
# are anonymous reads from zot, and a ~/.docker/config.json a repository
# planted in the work dir is never consulted. During the publishing call the
# repository's code runs only inside BuildKit steps, as `buildkit`, which the
# credential never reaches (it travels to the daemon over the session). Repo
# code never runs as the build user while the credential exists.
#
# ── limits checked late ───────────────────────────────────────────────────
#
# The 2 GiB clone cap is measured after the fetch completes: until then the
# fetch is bounded only by $CLONE_LIMIT and the builder dataset's quota.
#
# ── exit status ───────────────────────────────────────────────────────────
#
#   0  a status was published: succeeded, superseded, or failed for a reason
#      that is the request's or the repository's (bad field, checks failed,
#      GitHub said no). The build page says why; nothing to mail.
#   1  the agent could not do its job: a request it cannot even answer (no
#      payload, no id), its key missing, or a line nobody tested. monitoredJobs
#      mails it, and a failed status is published whenever there is an id.

set -euo pipefail

STATUS="$VERBS_DIR/build-status.json"

# Where a build installs its packages from. With a mirror the box publishes
# (fleet.builder.npmMirrorHost), its name is pinned to the LAN address inside
# BuildKit — the box's own resolver is not reachable from there — and without
# one, npmjs directly and nothing to pin.
if [ -n "$NPM_MIRROR_HOST" ]; then
  NPM_REGISTRY_URL="https://$NPM_MIRROR_HOST/"
  NPM_MIRROR_ARGS=(--opt "add-hosts=$NPM_MIRROR_HOST=$LAN_IP")
else
  NPM_REGISTRY_URL="https://registry.npmjs.org/"
  NPM_MIRROR_ARGS=()
fi

MAX_REQUEST_BYTES=65536
# The registry it authorizes the app against (helpers.sh registry_entry).
MAX_REGISTRY_BYTES=$((4 * 1024 * 1024))
MAX_CLONE_BYTES=$((2 * 1024 * 1024 * 1024))
MAX_LOG_BYTES=$((20 * 1024 * 1024))
# The status is re-read by the engine every few seconds; Railpack's two files
# are usually ~20 KiB and can grow with a big plan.
MAX_DETECTED_BYTES=$((256 * 1024))
# The facts read out of the clone and out of the pushed manifest (`repo`,
# `image`): small by construction rather than trimmed after the fact like
# `detected`, so these are the caps the extraction applies as it builds each
# list. The engine's warning engine reads shapes and names, never contents —
# a repository with four thousand dependencies has said everything it has to
# say by the 250th.
MAX_REPO_SCRIPTS=40
MAX_REPO_SCRIPT_CHARS=200
MAX_REPO_DEPS=250
MAX_REPO_PM_CHARS=120
MAX_IMAGE_TAGS=20
MAX_IMAGE_LAYERS=60
HEARTBEAT_SECS=20

# Per stage. Build and publish are ONE buildctl call (the push is its export),
# so `timeout` bounds the sum and the heartbeat's watchdog enforces the split:
# it sees the push start in the progress output.
CLONE_LIMIT=5m
DETECT_LIMIT=3m
CHECKS_LIMIT=30m
BUILD_SECS=1800
PUBLISH_SECS=900

# ── the Railpack switches ─────────────────────────────────────────────────
#
# The engine's rule too (app/src/lib/builds.ts), refused here on its own
# because the container can write a request without the engine: a request
# this host accepts is exactly one the engine's decoder accepts.
# builds.test.ts reads the assignment out of this file (it sits in the same
# repository) and fails on any difference, so it stays one `NAME='…'`
# assignment and changes together with the engine.
#
# RAILPACK_KNOBS — the Railpack switches passed on, and the pattern each value
# must match. Nothing else under RAILPACK_ reaches Railpack: every *_CMD, the
# config file and the package list change what runs, and belong in the repo's
# railpack.json. The patterns run in jq's Oniguruma here and as JavaScript
# RegExps in the engine, so they keep to what both read alike (ASCII classes,
# lookahead only, no flags) and only ever see single-line values.
RAILPACK_KNOBS='{
  "RAILPACK_PRUNE_DEPS": "^(?:true|false|1|0)$",
  "RAILPACK_NODE_PLAYWRIGHT_INSTALL": "^(?:true|false|1|0)$",
  "RAILPACK_NO_SPA": "^(?:true|false|1|0)$",
  "RAILPACK_DISABLE_CACHES": "^(?:\\*|[A-Za-z0-9_.:-]+(?: [A-Za-z0-9_.:-]+)*)$",
  "RAILPACK_SPA_OUTPUT_DIR": "^(?!/)(?!(?:.*/)?\\.\\.(?:/|$))[A-Za-z0-9._/-]{1,200}$",
  "RAILPACK_NODE_VERSION": "^[0-9]{1,3}(?:\\.[0-9]{1,4}){0,2}$",
  "RAILPACK_BUILD_APT_PACKAGES": "^[a-z0-9][a-z0-9+.-]*(?:=[A-Za-z0-9.+~:-]+)?(?: [a-z0-9][a-z0-9+.-]*(?:=[A-Za-z0-9.+~:-]+)?)*$",
  "RAILPACK_DEPLOY_APT_PACKAGES": "^[a-z0-9][a-z0-9+.-]*(?:=[A-Za-z0-9.+~:-]+)?(?: [a-z0-9][a-z0-9+.-]*(?:=[A-Za-z0-9.+~:-]+)?)*$"
}'

LOGGER_PID=""
HB_PID=""
CTL=""
P=""
WORK=""
SRC=""
TOKEN_LIVE=0
STATUS_READY=0
INTERRUPTED=0

BUILD_PRIV=("$SETPRIV" --reuid="$BUILD_USER" --regid="$BUILD_GROUP" --init-groups --inh-caps=-all)
TIMEOUT_BIN="$(command -v timeout)"
