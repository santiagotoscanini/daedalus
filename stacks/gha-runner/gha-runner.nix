# stacks/gha-runner — self-hosted GitHub Actions runners (ephemeral).
#
# One EPHEMERAL runner container per fleet.apps entry (the app key
# names the repo), registered repo-level under
# github.com/santiagotoscanini (a personal account — org-level runners
# don't exist there). Each runner takes exactly ONE
# job, then de-registers and exits; systemd `Restart=always` starts a
# fresh container that re-registers via the myoung34 entrypoint
# (ACCESS_TOKEN -> POST .../actions/runners/registration-token). Fresh
# container per job = GitHub-hosted-runner hygiene: no state, no
# cross-job contamination from a compromised marketplace action.
#
# NOT oci-containers/mkRootlessContainer, deliberately: the fleet's
# Type=oneshot+RemainAfterExit override can't drive the
# exit-after-each-job -> restart loop these units ARE. They're plain
# long-running services in the mkRootlessOneshot idiom (santiago,
# XDG_RUNTIME_DIR, /run/wrappers for newuidmap), podman run --rm in the
# foreground. Consequently they must NOT appear in
# fleet.bridgeMemberships (that registry is 1:1 with oci-containers).
#
# Security model:
#   - NO podman socket in the container. Santiago's rootless socket is
#     root-equivalent for every stack on this box; a supply-chain-
#     compromised action must not get it. Jobs that build/push images
#     stay on GitHub-hosted runners (the repos' release/image
#     workflows); only CI jobs (lint/typecheck/e2e) run here.
#     Corollary: workflow `container:`/`services:` jobs are unsupported
#     (they need a Docker API) — keep workflows as plain `run:` steps.
#   - The PAT in env.sops is fine-grained, no-expiration,
#     "Administration: read+write" on ONLY the repos below (the
#     registration-token endpoint's whole requirement) — and it NEVER
#     enters the container. An ExecStartPre mints a registration token
#     host-side (1-hour, single-purpose) and that is all the container
#     sees; a compromised job reading /proc/1/environ gets a token
#     that can only register runners on that one repo for <1 h, not
#     the eternal PAT. If the PAT is ever rotated: regenerate at
#     github.com/settings/personal-access-tokens, then
#     `sops stacks/gha-runner/env.sops` + rebuild.
#   - Trade-off of keeping the PAT out: the entrypoint's stop-time
#     de-register trap has no usable credential, so stopping an IDLE
#     runner may leave a stale entry in the repo's runner list — GitHub
#     auto-removes ephemeral runners after 1 day offline, and post-job
#     removal (the normal path) is done by GitHub itself. Cosmetic.
#   - Jobs run as container root (= santiago's userns, subuid-confined)
#     with passwordless sudo inside — same ergonomics as ubuntu-latest.
#     --memory caps a runaway job before it squeezes jellyfin/factorio.
#
# Image: localhost/gha-runner via mkLocalImage — myoung34's
# ubuntu-noble image (digest-pinned below, `update-images` audits it)
# plus Playwright's chromium system libs so ipcrawl's e2e job doesn't
# apt-install a browser dep tree every run. DISABLE_AUTO_UPDATE: the
# runner binary must not self-update (the update dies with the
# ephemeral container); GitHub blocks REGISTRATION of runners older
# than ~5 months, so bump the digest at least that often — a stale
# runner fails loudly at register time (restart loop -> start-limit ->
# monitoredJobs email), it doesn't rot silently.
#
# Workflows opt in with `runs-on: self-hosted` (or the extra `s2`
# label). Registered runners are visible per repo under Settings ->
# Actions -> Runners, or: gh api repos/santiagotoscanini/<repo>/actions/runners
#
# Monitoring: the gha-runner-metrics timer polls the GitHub API once a
# minute and writes gha_* gauges to node-exporter's textfile dir
# (runner online/busy from the runners endpoint; queued/in-progress
# run counts need "Actions: read" on the PAT and stay absent without
# it). Dashboard: Grafana sidebar folder "CI". The exporter exits 0 on
# API failure and flags it via gha_exporter_ok{repo}=0 — dashboard-red,
# not a mail storm.

{
  config,
  lib,
  pkgs,
  mkDotenvSecret,
  mkLocalImage,
  ...
}:

let
  # The runner set IS the apps platform: one runner per fleet.apps
  # entry (whose key names the repo, github.com/santiagotoscanini/<name>
  # — the same convention the image default rides). Derive-don't-
  # duplicate, like webApps -> traefik/dns. Declaring an app provisions
  # its CI capacity; the repo-side half (workflows + REGISTRY_PASSWORD
  # secret) is documented in stacks/apps/declarations.nix.
  repos = lib.attrNames config.fleet.apps;

  # Digest of docker.io/myoung34/github-runner:ubuntu-noble (rebuilt
  # nightly upstream; the pin is what makes our build reproducible).
  runnerBaseDigest = "sha256:881a6b81df476e9b9ce7f9451b0efbacba7496ac4483613e24849a2c9b1ffd60";

  # Tracks ipcrawl's @playwright/test — only the system-dep set matters
  # (stable across minor versions), not an exact match with the repo.
  playwrightVersion = "1.61.1";

  # The base ships node 18 but no npm/npx; install npm just to run
  # playwright's own dep resolver instead of hand-maintaining ~30 libs.
  #
  # podman + fuse-overlayfs enable NESTED image builds (release/image
  # workflows): jobs call `podman build/push` against a podman that
  # lives entirely inside the runner container — the host's runtime is
  # never exposed. BUILDAH_ISOLATION=chroot makes Dockerfile RUN steps
  # share the build's netns (no bridge/caps needed nested); the
  # storage.conf pins fuse-overlayfs, which needs the /dev/fuse the
  # unit passes. Inside the outer userns podman detects itself as
  # ROOTLESS even as container-root, so root needs in-image
  # subuid/subgid ranges or layer extraction dies on lchown. All of it
  # is ephemeral — no layer cache between jobs.
  runnerImageBuildDir = pkgs.writeTextDir "Containerfile" ''
    FROM docker.io/myoung34/github-runner:ubuntu-noble@${runnerBaseDigest}
    RUN apt-get update \
     && apt-get install -y --no-install-recommends npm podman fuse-overlayfs \
     && npx --yes playwright@${playwrightVersion} install-deps chromium \
     && apt-get clean \
     && rm -rf /var/lib/apt/lists/* /root/.npm \
     && printf '[storage]\ndriver = "overlay"\nrunroot = "/run/containers/storage"\ngraphroot = "/var/lib/containers/storage"\n[storage.options.overlay]\nmount_program = "/usr/bin/fuse-overlayfs"\n' \
          > /etc/containers/storage.conf \
     && printf 'root:1:65535\n' >> /etc/subuid \
     && printf 'root:1:65535\n' >> /etc/subgid \
     && printf '[[registry]]\nlocation = "zot:5000"\ninsecure = true\n' \
          >> /etc/containers/registries.conf
    ENV BUILDAH_ISOLATION=chroot
  '';

  runnerImage = mkLocalImage {
    name = "gha-runner";
    tagPrefix = "noble";
    contextDir = runnerImageBuildDir;
    gates = map (repo: "gha-runner-${repo}.service") repos;
  };

  # PAT -> 1-hour registration token, minted host-side per container
  # start so the PAT itself never enters the container. Output is a
  # podman --env-file on santiago's tmpfs (0400, rewritten each start,
  # gone on reboot). A curl/jq failure fails ExecStartPre and rides the
  # unit's restart loop.
  mintToken = pkgs.writeShellApplication {
    name = "gha-runner-mint-token";
    runtimeInputs = [
      pkgs.curl
      pkgs.jq
    ];
    text = ''
      repo="$1"
      # shellcheck disable=SC1091
      . ${config.sops.secrets."gha-runner-env".path}
      umask 077
      token=$(curl -fsS -X POST \
        -H "Authorization: Bearer ''${ACCESS_TOKEN}" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "https://api.github.com/repos/santiagotoscanini/''${repo}/actions/runners/registration-token" \
        | jq -re .token)
      printf 'RUNNER_TOKEN=%s\n' "$token" > "/run/user/1000/gha-runner-''${repo}.env"
    '';
  };

  # gha_* gauges for prometheus, via node-exporter's textfile collector
  # (dir owned by stacks/monitoring — designed there as the extension
  # point for exactly this kind of host-side sweep). Per-repo API
  # failures emit gha_exporter_ok=0 and keep going; only a missing
  # secret / unwritable dir fails the unit.
  textfileDir = "/var/lib/node-exporter/textfile";
  metricsScript = pkgs.writeShellApplication {
    name = "gha-runner-metrics";
    runtimeInputs = [
      pkgs.curl
      pkgs.jq
    ];
    text = ''
      # shellcheck disable=SC1091
      . ${config.sops.secrets."gha-runner-env".path}

      api() {
        curl -fsS --max-time 20 \
          -H "Authorization: Bearer ''${ACCESS_TOKEN}" \
          -H "Accept: application/vnd.github+json" \
          -H "X-GitHub-Api-Version: 2022-11-28" \
          "https://api.github.com/repos/santiagotoscanini/$1"
      }

      declare -A ok registered online busy queued inprog
      for repo in ${lib.concatStringsSep " " repos}; do
        ok[$repo]=0
        if runners=$(api "$repo/actions/runners?per_page=100"); then
          ok[$repo]=1
          registered[$repo]=$(jq -r '.total_count' <<<"$runners")
          online[$repo]=$(jq -r '[.runners[] | select(.status == "online")] | length' <<<"$runners")
          busy[$repo]=$(jq -r '[.runners[] | select(.busy)] | length' <<<"$runners")
        fi
        # total_count is enough — per_page=1 keeps the payload tiny.
        # These two need "Actions: read" on the PAT (403 without it).
        if runs=$(api "$repo/actions/runs?status=queued&per_page=1" 2>/dev/null); then
          queued[$repo]=$(jq -r '.total_count' <<<"$runs")
        fi
        if runs=$(api "$repo/actions/runs?status=in_progress&per_page=1" 2>/dev/null); then
          inprog[$repo]=$(jq -r '.total_count' <<<"$runs")
        fi
      done

      tmp="${textfileDir}/gha-runner.prom.$$"
      {
        echo '# HELP gha_exporter_ok GitHub runners API reachable this sweep (1) or not (0).'
        echo '# TYPE gha_exporter_ok gauge'
        for repo in ${lib.concatStringsSep " " repos}; do
          echo "gha_exporter_ok{repo=\"$repo\"} ''${ok[$repo]}"
        done
        echo '# HELP gha_runners_registered Self-hosted runners registered on the repo.'
        echo '# TYPE gha_runners_registered gauge'
        echo '# HELP gha_runners_online Self-hosted runners GitHub reports online.'
        echo '# TYPE gha_runners_online gauge'
        echo '# HELP gha_runners_busy Self-hosted runners currently running a job.'
        echo '# TYPE gha_runners_busy gauge'
        for repo in ${lib.concatStringsSep " " repos}; do
          [ -n "''${registered[$repo]:-}" ] || continue
          echo "gha_runners_registered{repo=\"$repo\"} ''${registered[$repo]}"
          echo "gha_runners_online{repo=\"$repo\"} ''${online[$repo]}"
          echo "gha_runners_busy{repo=\"$repo\"} ''${busy[$repo]}"
        done
        echo '# HELP gha_runs_queued Workflow runs waiting for a runner.'
        echo '# TYPE gha_runs_queued gauge'
        echo '# HELP gha_runs_in_progress Workflow runs currently executing.'
        echo '# TYPE gha_runs_in_progress gauge'
        for repo in ${lib.concatStringsSep " " repos}; do
          [ -n "''${queued[$repo]:-}" ] \
            && echo "gha_runs_queued{repo=\"$repo\"} ''${queued[$repo]}"
          [ -n "''${inprog[$repo]:-}" ] \
            && echo "gha_runs_in_progress{repo=\"$repo\"} ''${inprog[$repo]}"
        done
        true
      } > "$tmp"
      mv -f "$tmp" "${textfileDir}/gha-runner.prom"
    '';
  };

  mkRunnerService = repo: {
    description = "GitHub Actions ephemeral runner for ${repo}";
    wantedBy = [ "multi-user.target" ];
    # Registration resolves api.github.com through pi-hole, so gate on
    # pihole-ready (network-online alone means link-up, not DNS).
    # user@1000.service ordering keeps /run/user/1000 alive through our
    # stop, so the entrypoint's SIGTERM trap can de-register cleanly.
    # registry-net (created by the zot stack's membership) is where
    # image-build jobs push — the runner rides it instead of pasta.
    after = [
      "linger-users.service"
      "network-online.target"
      "pihole-ready.service"
      "user@1000.service"
      "podman-network-registry-net.service"
    ];
    wants = [
      "linger-users.service"
      "network-online.target"
      "pihole-ready.service"
      "user@1000.service"
      "podman-network-registry-net.service"
    ];
    path = [ "/run/wrappers" ];
    unitConfig = {
      # Ephemeral loop = a restart per job; never let a busy day trip
      # the default 5-in-10s limit. 20x5s also rides out GitHub API
      # blips (token.sh has zero retry logic — the loop IS the retry).
      StartLimitBurst = 20;
      StartLimitIntervalSec = 600;
    };
    serviceConfig = {
      User = "santiago";
      Group = "users";
      Environment = [
        "XDG_RUNTIME_DIR=/run/user/1000"
        "HOME=/home/santiago"
      ];
      Restart = "always";
      RestartSec = "5s";
      # A stopped/restarted runner dies by SIGTERM and podman reports
      # 143 — that's a clean stop, not a failure; without this every
      # rebuild-triggered restart fires the monitoredJobs OnFailure
      # email. Real registration failures (exit 1/2) still count.
      SuccessExitStatus = [ 143 ];
      ExecStartPre = [
        # A stale container from an unclean stop would collide on --name.
        "-${pkgs.podman}/bin/podman rm --force --ignore gha-runner-${repo}"
        "${mintToken}/bin/gha-runner-mint-token ${repo}"
      ];
      ExecStart = lib.concatStringsSep " " [
        "${pkgs.podman}/bin/podman run"
        "--rm"
        "--name=gha-runner-${repo}"
        "--log-driver=journald"
        "--memory=16g"
        # fuse-overlayfs for the nested podman (image-build jobs).
        "--device=/dev/fuse"
        # Jobs push built images to zot by bridge DNS (http, on-bridge
        # only — the runner image's registries.conf marks it insecure).
        "--network=registry-net"
        "--env-file=/run/user/1000/gha-runner-${repo}.env"
        "--env=RUNNER_SCOPE=repo"
        "--env=REPO_URL=https://github.com/santiagotoscanini/${repo}"
        "--env=RUNNER_NAME_PREFIX=s2-${repo}"
        "--env=LABELS=s2"
        "--env=EPHEMERAL=1"
        "--env=DISABLE_AUTO_UPDATE=true"
        "--env=UNSET_CONFIG_VARS=true"
        # The entrypoint's stop-time deregister trap can never succeed
        # here — the only in-container credential is the registration
        # token, which GitHub rejects for removal (the PAT stays
        # host-side on purpose). Skip the doomed attempt: no
        # "Cannot read keys" / "Failed: Removing runner" noise on
        # restart, and SIGTERM reaches the listener directly. Stale
        # idle-stop entries age out as documented above.
        "--env=DISABLE_AUTOMATIC_DEREGISTRATION=true"
        runnerImage.image
      ];
    };
  };
in
{
  # ACCESS_TOKEN=<fine-grained PAT>. Edit: sops stacks/gha-runner/env.sops
  sops.secrets."gha-runner-env" = mkDotenvSecret ./env.sops;

  systemd.services =
    lib.listToAttrs (map (repo: lib.nameValuePair "gha-runner-${repo}" (mkRunnerService repo)) repos)
    // {
      gha-runner-image-build = runnerImage.service;
      gha-runner-metrics = {
        description = "Export gha_* runner gauges to node-exporter textfile";
        # The textfile dir is a tmpfiles rule in stacks/monitoring.
        after = [
          "systemd-tmpfiles-setup.service"
          "network-online.target"
          "pihole-ready.service"
        ];
        wants = [
          "network-online.target"
          "pihole-ready.service"
        ];
        serviceConfig = {
          Type = "oneshot";
          User = "santiago";
          Group = "users";
          ExecStart = "${metricsScript}/bin/gha-runner-metrics";
        };
      };
    };

  systemd.timers.gha-runner-metrics = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "2min";
      OnUnitActiveSec = "1min";
    };
  };

  # Start-limit exhaustion (expired PAT, stale runner version, GitHub
  # outage) mails root; ephemeral churn within the limit does not.
  fleet.monitoredJobs = lib.listToAttrs (
    map (repo: lib.nameValuePair "gha-runner-${repo}" { }) repos
  );

  fleet.logStacks.gha-runner = map (repo: "gha-runner-${repo}") repos;

  fleet.grafanaDashboardsByFolder.CI.gha-runners = builtins.readFile ./assets/gha-runners.json;
}
