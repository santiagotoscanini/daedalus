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
# Image: localhost/gha-runner via mkLocalImage from
# assets/image/Containerfile (base pin + nested-podman wiring + their
# why-notes live there). DISABLE_AUTO_UPDATE: the runner binary must
# not self-update (the update dies with the ephemeral container); a
# stale pin fails loudly at register time (restart loop -> start-limit
# -> monitoredJobs email), it doesn't rot silently.
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

  # Base pin, playwright deps, nested-podman wiring and their why-notes
  # all live in the Containerfile. Its own subdir on purpose: the tag
  # embeds the context hash, so sibling assets must not invalidate it.
  runnerImage = mkLocalImage {
    name = "gha-runner";
    tagPrefix = "noble";
    contextDir = ./assets/image;
    gates = map (repo: "gha-runner-${repo}.service") repos;
  };

  # PAT -> 1-hour registration token per container start; see the
  # script header for the contract.
  mintToken = pkgs.writeShellApplication {
    name = "gha-runner-mint-token";
    runtimeInputs = [
      pkgs.curl
      pkgs.jq
    ];
    text = ''
      ENV_FILE=${config.sops.secrets."gha-runner-env".path}
      ${builtins.readFile ./assets/mint-token.sh}
    '';
  };

  # gha_* gauges into node-exporter's textfile dir (owned by
  # stacks/monitoring — designed there as the extension point for
  # host-side sweeps like this); see the script header for semantics.
  textfileDir = "/var/lib/node-exporter/textfile";
  metricsScript = pkgs.writeShellApplication {
    name = "gha-runner-metrics";
    runtimeInputs = [
      pkgs.curl
      pkgs.jq
    ];
    text = ''
      REPOS=${lib.escapeShellArg (toString repos)}
      ENV_FILE=${config.sops.secrets."gha-runner-env".path}
      TEXTFILE_DIR=${textfileDir}
      ${builtins.readFile ./assets/metrics.sh}
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
