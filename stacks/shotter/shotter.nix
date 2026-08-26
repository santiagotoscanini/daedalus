# shotter — the box's standing headless-browser lab, and the standard way any
# agent session verifies a web UI from this GUI-less machine.
#
# WHAT IT IS. A pinned Playwright+Chromium image built locally at rebuild, a
# host CLI (`shot`), and a permanent run archive under
# <stateRoot>/shotter/runs/. There is deliberately NO resident container: a
# Chromium held open for weeks is a memory leak with a process tree, and each
# run wants a cold, reproducible browser anyway. What is permanent is the
# CAPABILITY — image, CLI and archive all declared here — not a daemon.
#
# THE FLOW (also `shot help`):
#   shot quick https://hermes.toscanini.me/     one URL → sliced screenshots
#   shot run ./driver.mjs my-label              scripted flow (login, click…)
#   shot show [id] · shot dir [id] · shot ls    read a run back
#   shot stats · shot prune                     archive upkeep
#
# Each run directory is the agent-shaped contract (see assets/runner.mjs):
# NN-*.png viewport slices + events.json (console errors, page errors, failed
# requests, ≥400 responses) + summary.json + log.txt. EVENTS OUTRANK PIXELS —
# a page can screenshot perfectly over a broken stylesheet 404 (iris's
# `source(none)` trap); the screenshot lies, events.json does not.
#
# WHY --network=host: this box's two networking traps both vanish. Under
# pasta, 192.168.0.2 refers back to the container itself (LAN-IP trap), and
# published preview ports need host-gateway juggling. In the host netns the
# container resolves via pi-hole on 127.0.0.1, reaches traefik at the LAN IP,
# and sees `podman run -p 127.0.0.1:PORT` previews — exactly like a host
# shell. The run is trusted local tooling; isolation buys nothing here.
#
# THE STATS SURFACE: <stateRoot>/shotter/stats.json (totals + last run) and
# history.jsonl (one line per run, append-only). Stable schema — read by the
# Claude page in daedalus (src/lib/dashboard/shotter.ts) through the
# read-only mount this module contributes below.
#
# DEPLOY SCREENSHOTS: per registry app, a path unit on the deploy state file
# (/var/lib/app-deploy/<name> — written ONLY on real deploys; deploy.sh's
# "no change" tick exits before touching it) fires `shot quick` at the app's
# hostname and publishes <stateDir>/deploys/<name>.{png,json} — the newest
# slice plus a pointer record. Daedalus's app Overview renders it as the
# Vercel-style deployment preview. The run itself lands in the normal
# archive/ledger under the label `deploy-<name>`.
#
# UPGRADING PLAYWRIGHT: bump playwrightVersion + playwrightDigest together
# (skopeo inspect docker://mcr.microsoft.com/playwright:v<V>-noble). The npm
# package version inside the image MUST match the image tag — Playwright
# refuses browsers from a different revision.

{
  config,
  lib,
  pkgs,
  mkLocalImage,
  ...
}:

let
  playwrightVersion = "1.62.1";
  playwrightDigest = "sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e";

  stateDir = "${config.fleet.stateRoot}/shotter";

  # Context = generated Containerfile + the committed runner. The npm install
  # is tiny (browsers already ship in the base image; the skip env stops the
  # postinstall from re-downloading ~500MB of them).
  imageContext = pkgs.runCommand "shotter-image-context" { } ''
    mkdir -p $out
    cp ${./assets/runner.mjs} $out/runner.mjs
    cat > $out/Containerfile <<EOF
    FROM mcr.microsoft.com/playwright:v${playwrightVersion}-noble@${playwrightDigest}
    WORKDIR /opt/lab
    ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
    RUN npm install --no-audit --no-fund playwright@${playwrightVersion}
    COPY runner.mjs /opt/lab/runner.mjs
    EOF
  '';

  labImage = mkLocalImage {
    name = "shotter";
    tagPrefix = "pw${playwrightVersion}";
    contextDir = imageContext;
    # No consumer unit exists (runs are ad-hoc `podman run --rm`), so the
    # build gates boot completion instead. Layer cache makes the no-change
    # case ~instant; only a fresh box pays the base-image pull here.
    gates = [ "multi-user.target" ];
  };

  shot = pkgs.writeShellApplication {
    name = "shot";
    runtimeInputs = with pkgs; [
      podman
      jq
      coreutils
      findutils
    ];
    text = ''
      # shot — headless-browser verification. Doc: stacks/shotter/shotter.nix.
      ROOT="${stateDir}"
      IMAGE="${labImage.image}"

      # Rootless podman state belongs to santiago; re-exec if invoked as
      # anyone else (root timer, sudo shell).
      if [ "$(id -un)" != "santiago" ]; then
        exec /run/wrappers/bin/sudo -u santiago "$0" "$@"
      fi
      XDG_RUNTIME_DIR="/run/user/$(id -u)"
      export XDG_RUNTIME_DIR
      mkdir -p "$ROOT/runs" "$ROOT/profiles"

      usage() {
        cat <<'EOF'
      shot — drive a real Chromium against this box's apps, get back an
      agent-readable run directory (sliced PNGs + events.json + summary.json).

        shot quick <url> [label] [-- --viewport WxH --settle MS]
            Open the URL, settle, screenshot the whole page in slices.
        shot run <driver.mjs> [label] [-- --state NAME --viewport WxH]
            Run a driver: export default async ({ page, context, browser,
            snap, snapFull, log, sleep, args, out }) => { ... }
            Plain Playwright page API; import nothing. --state persists
            cookies/localStorage across runs (login once, reuse).
        shot ls [n]        recent runs, one line each
        shot show [id]     summary.json + files of a run (default: latest)
        shot dir [id]      print a run directory path (for Read on the PNGs)
        shot stats         totals + disk usage
        shot prune [--days N] [--keep N]   default: 30 days, keep 40

      Read events.json before trusting the pictures: a page can render fine
      over a broken deploy (stylesheet 404s, console errors, failed XHRs).
      EOF
      }

      latest_run() { find "$ROOT/runs" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort | tail -1; }

      cmd="''${1:-help}"
      shift || true
      case "$cmd" in
        quick)
          url="''${1:?usage: shot quick <url> [label]}"
          shift
          label="''${1:-}"
          if [ -n "$label" ] && [ "$label" != "--" ]; then shift; else label=""; fi
          [ "''${1:-}" = "--" ] && shift
          if [ -z "$label" ]; then
            label="$(printf '%s' "$url" | sed -E 's#^https?://##; s#[/:?].*$##; s#\.toscanini\.me$##')"
          fi
          label="$(printf '%s' "$label" | tr -c 'a-zA-Z0-9._-' '-' | sed 's/-*$//')"
          run_id="$(date +%Y%m%d-%H%M%S)-$label"
          # On failure the run dir matters MOST (failure shot + events.json),
          # so echo it before propagating the runner's exit code.
          rc=0
          podman run --rm --network=host --shm-size=1g -v "$ROOT:/lab" "$IMAGE" \
            node /opt/lab/runner.mjs --out "/lab/runs/$run_id" --url "$url" --label "$label" "$@" || rc=$?
          echo "→ $ROOT/runs/$run_id"
          exit "$rc"
          ;;
        run)
          script="''${1:?usage: shot run <driver.mjs> [label]}"
          shift
          script="$(realpath "$script")"
          label="''${1:-}"
          if [ -n "$label" ] && [ "$label" != "--" ]; then shift; else label=""; fi
          [ "''${1:-}" = "--" ] && shift
          [ -z "$label" ] && label="$(basename "$script" .mjs)"
          label="$(printf '%s' "$label" | tr -c 'a-zA-Z0-9._-' '-' | sed 's/-*$//')"
          run_id="$(date +%Y%m%d-%H%M%S)-$label"
          rc=0
          podman run --rm --network=host --shm-size=1g -v "$ROOT:/lab" \
            -v "$script:/work/driver.mjs:ro" "$IMAGE" \
            node /opt/lab/runner.mjs --out "/lab/runs/$run_id" --script /work/driver.mjs --label "$label" "$@" || rc=$?
          echo "→ $ROOT/runs/$run_id"
          exit "$rc"
          ;;
        ls)
          n="''${1:-15}"
          tail -n "$n" "$ROOT/history.jsonl" 2>/dev/null \
            | jq -r '[.id, (if .ok then "ok  " else "FAIL" end),
                      "\(.shots) shots",
                      "cerr=\(.counts.consoleError) perr=\(.counts.pageError) req!=\(.counts.requestFailed) 4xx=\(.counts.http4xx) 5xx=\(.counts.http5xx)"
                     ] | join("  ")' \
            || echo "no runs yet"
          ;;
        show)
          id="''${1:-$(latest_run)}"
          [ -n "$id" ] || { echo "no runs yet"; exit 1; }
          jq . "$ROOT/runs/$id/summary.json"
          echo
          ls -1 "$ROOT/runs/$id"
          ;;
        dir)
          id="''${1:-$(latest_run)}"
          [ -n "$id" ] || { echo "no runs yet"; exit 1; }
          echo "$ROOT/runs/$id"
          ;;
        stats)
          jq . "$ROOT/stats.json" 2>/dev/null || echo "no runs yet"
          du -sh "$ROOT/runs" 2>/dev/null || true
          ;;
        prune)
          days=30
          keep=40
          while [ $# -gt 0 ]; do
            case "$1" in
              --days) days="$2"; shift 2 ;;
              --keep) keep="$2"; shift 2 ;;
              *) shift ;;
            esac
          done
          mapfile -t all < <(find "$ROOT/runs" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort)
          total=''${#all[@]}
          cut=$((total - keep))
          [ "$cut" -lt 0 ] && cut=0
          pruned=0
          for d in "''${all[@]:0:$cut}"; do
            if [ -n "$(find "$ROOT/runs/$d" -maxdepth 0 -mtime +"$days" 2>/dev/null)" ]; then
              rm -rf "''${ROOT:?}/runs/''${d:?}"
              pruned=$((pruned + 1))
            fi
          done
          echo "pruned $pruned run(s); $((total - pruned)) kept"
          ;;
        help | *)
          usage
          ;;
      esac
    '';
  };
in
lib.mkMerge [
  {
    fleet.statePaths."${stateDir}" = {
      uid = 0;
    };

    environment.systemPackages = [ shot ];

  # The Shotter tab on daedalus's Claude page reads the stats surface and
  # serves run screenshots out of the archive. Same list-merge idiom as
  # litellm's prometheus mount: the stack that OWNS the files contributes the
  # bind, rather than the apps platform learning about shotter. The version
  # env var rides along so the tab's changelog compares against THIS pin
  # instead of restating it in TypeScript.
  virtualisation.oci-containers.containers.app-daedalus = {
    volumes = [ "${stateDir}:/shotter:ro" ];
    environment.SHOTTER_PLAYWRIGHT_VERSION = playwrightVersion;
  };

  systemd.services.shotter-image = labImage.service;

  # The archive grows ~0.5–1 MB per screenshot; a busy verification session
  # is 40 MB. Weekly prune keeps it bounded without losing recent history.
  systemd.services.shotter-prune = {
    description = "Prune old shotter runs";
    serviceConfig = {
      Type = "oneshot";
      User = "santiago";
      Group = "users";
      ExecStart = "${shot}/bin/shot prune";
    };
  };
  systemd.timers.shotter-prune = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "Sun 04:20";
      Persistent = true;
      RandomizedDelaySec = 1800;
    };
  };
    fleet.monitoredJobs.shotter-prune = { };
  }

  # ── deploy screenshots ──────────────────────────────────────────────────
  # One path unit + oneshot per registry app. Local-source apps are excluded
  # (no deploy timer, so the state file never moves), `stage = "off"` apps
  # have no hostname to shoot. A proxy-auth'd app photographs its Pocket ID
  # gate — which IS what an anonymous visitor sees, so it stays honest.
  #
  # The unit publishes even when the page errored (the failure shot is the
  # useful one) but then exits with the runner's code, so a deploy whose
  # page will not render shows up in `systemctl --failed` without email.
  (let
    shotApps = lib.filterAttrs (
      _: a: a.stage != "off" && a.deploy.enable && a.source.mode != "local"
    ) config.fleet.apps;
    hostOf =
      name: a: if a.hostname != null then a.hostname else "${name}.${config.fleet.baseDomain}";
  in
  {
    systemd.services = lib.mapAttrs' (
      name: a:
      lib.nameValuePair "shot-deploy-${name}" {
        description = "Screenshot ${name} after a deploy";
        serviceConfig = {
          Type = "oneshot";
          # As santiago directly (shot re-execs to her anyway, and the sudo
          # hop from a root unit would log a PAM session per deploy).
          User = "santiago";
          Group = "users";
        };
        path = [
          shot
          pkgs.coreutils
          pkgs.findutils
          pkgs.gnused
          pkgs.jq
        ];
        script = ''
          rc=0
          out="$(shot quick "https://${hostOf name a}/" "deploy-${name}")" || rc=$?
          dir="$(printf '%s\n' "$out" | tail -n1 | sed 's/^→ //')"
          [ -d "$dir" ] || { echo "no run dir produced"; exit 1; }
          first="$(find "$dir" -maxdepth 1 -name '*.png' | sort | head -n1)"
          [ -n "$first" ] || { echo "run produced no screenshot"; exit 1; }
          mkdir -p "${stateDir}/deploys"
          # tmp+mv both files: daedalus reads them live off the mount.
          install -m 0644 "$first" "${stateDir}/deploys/${name}.png.tmp"
          mv "${stateDir}/deploys/${name}.png.tmp" "${stateDir}/deploys/${name}.png"
          digest="$(cut -d' ' -f1 /var/lib/app-deploy/${name} 2>/dev/null || true)"
          jq -n --arg run "$(basename "$dir")" --arg digest "$digest" \
            --argjson ok "$([ "$rc" -eq 0 ] && echo true || echo false)" --arg at "$(date -Is)" \
            '{runId:$run, digest:(if $digest == "" then null else $digest end), ok:$ok, at:$at}' \
            > "${stateDir}/deploys/${name}.json.tmp"
          mv "${stateDir}/deploys/${name}.json.tmp" "${stateDir}/deploys/${name}.json"
          exit "$rc"
        '';
      }
    ) shotApps;

    systemd.paths = lib.mapAttrs' (
      name: _:
      lib.nameValuePair "shot-deploy-${name}" {
        description = "Watch ${name}'s deploy state for the screenshot hook";
        wantedBy = [ "multi-user.target" ];
        # PathChanged (not PathModified): fires on close-after-write, which is
        # deploy.sh finishing its state write — one shot per deploy.
        pathConfig.PathChanged = "/var/lib/app-deploy/${name}";
      }
    ) shotApps;
  })
]
