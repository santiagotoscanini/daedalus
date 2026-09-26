# daedalus-github — the GitHub App's host half: the public webhook route
# (whenever the app runs) and, once site/vault/github-app.sops is in the
# flake, its credentials, the webhook-secret copy and the installation-token
# minter. The minter's script is verbs-lib.nix. Part of the daedalus stack
# (daedalus.nix holds the switch, and asserts the App's two halves agree);
# never imports its siblings.
{
  config,
  lib,
  pkgs,
  mkSecretRender,
  ...
}:

let
  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; })
    appsOn
    applyDir
    bridgeAgent
    hooksHost
    githubAppVault
    haveGithubApp
    githubRenderDir
    githubTokenDir
    ;
  inherit (import ./verbs-lib.nix { inherit config lib pkgs; }) githubTokenScript;
in

{
  config = lib.mkIf config.fleet.modules.daedalus.enable {
    # ── the GitHub App: the public webhook path (whenever the app runs) ─────
    #
    # GitHub delivers to https://hooks.<baseDomain>/api/github/webhook through
    # the Cloudflare tunnel, and that is the ONLY thing the name answers:
    #
    #   - cfweb only. No websecure router, no pi-hole record: on the LAN the
    #     name falls through to traefik's 404 like any unknown host. The tunnel
    #     is the one way in, which is also what makes Cf-Connecting-Ip the
    #     client address (cfweb trusts X-Forwarded-* only from traefik-net).
    #   - POST to the exact path. A GET, any other path, `/` — no router
    #     matches, traefik 404s, and nothing of the app is reachable from
    #     the internet through this name.
    #   - No forward-auth: GitHub cannot hold a passkey. The route authenticates
    #     itself (HMAC over the raw body, against the webhook secret below), and
    #     answers 503 while no secret exists.
    #   - The strip middleware, exactly as the app's own router and the deploy
    #     hook (modules/registry) carry it: a request that skips the gate must
    #     not arrive holding a forged X-Forwarded-Email.
    #   - A rate limit per client, because this is the one daedalus path on the
    #     open internet. 10/s with a burst of 50 is far above GitHub's delivery
    #     rate and still caps a flood before it reaches the dev server.
    #   - Per client is weak on its own (an IPv6 client has addresses to spare),
    #     and daedalus has no memory cap and reads a body whole before it can
    #     check the HMAC. So traefik bounds what reaches it: `buffering` reads
    #     the body in traefik and answers 413 past 5 MiB (the engine's own
    #     limit), so an oversized or trickled body never reaches Vite; and
    #     `inFlightReq` lets at most 10 requests for this host through at once,
    #     whoever sends them.
    #   - Order: strip; the rate limit, which reads no body, so a refused
    #     request costs traefik nothing; buffering; the in-flight cap last, so
    #     a slow uploader holds a traefik buffer rather than one of the ten
    #     slots GitHub's deliveries need.
    #
    # Gated on the apps switch, like the container itself: the route names the
    # app's own service and reads its own webApp entry, neither of which exists
    # on a host that has the control plane's agents but not (yet) its container.
    fleet.traefikRawRules."hooks-github.yml" = lib.mkIf appsOn (
      let
        inherit (config.fleet.webApps) daedalus;
      in
      builtins.toJSON {
        http = {
          middlewares = {
            hooks-github-ratelimit.rateLimit = {
              average = 10;
              period = "1s";
              burst = 50;
              sourceCriterion.requestHeaderName = "Cf-Connecting-Ip";
            };
            hooks-github-buffering.buffering.maxRequestBodyBytes = 5242880;
            hooks-github-inflight.inFlightReq = {
              amount = 10;
              sourceCriterion.requestHost = true;
            };
          };
          routers.hooks-github-rtr = {
            entryPoints = [ "cfweb" ];
            rule = "Host(`${hooksHost}`) && Path(`/api/github/webhook`) && Method(`POST`)";
            middlewares = lib.optional (daedalus.authHeaders != { }) "oidc-daedalus-strip@file" ++ [
              "hooks-github-ratelimit@file"
              "hooks-github-buffering@file"
              "hooks-github-inflight@file"
            ];
            # The app's own service (webApps.daedalus → traefikRoutes.daedalus).
            service = "daedalus-svc";
          };
        };
      }
    );

    # The tunnel ingress + the proxied CNAME route-sync keeps for it. The label
    # is reserved by the reservedLabels assertion in daedalus.nix.
    fleet.cloudflareRoutes = lib.mkIf appsOn { daedalus-hooks.hostname = hooksHost; };

    # ── the GitHub App: credentials (once site/vault/github-app.sops exists) ─
    #
    # One sops JSON file, three values: `pem`, `webhookSecret`, `clientSecret`.
    # Two are declared here, both root 0400 — sops-nix needs every secret read
    # from one file to share a format, hence json for both. `clientSecret` is
    # not declared at all: nothing on the box uses the App's OAuth half yet.
    #
    # The key is consumed where it is decrypted, by the root minter below, and
    # rotating it re-mints at once.
    sops.secrets."github-app-pem" = lib.mkIf haveGithubApp {
      sopsFile = githubAppVault;
      format = "json";
      key = "pem";
      owner = "root";
      mode = "0400";
      restartUnits = [ "daedalus-github-token.service" ];
    };
    # The webhook secret reaches the container through a copy (the render
    # below): the root-only original stays unreadable to it.
    sops.secrets."github-app-webhook-secret" = lib.mkIf haveGithubApp {
      sopsFile = githubAppVault;
      format = "json";
      key = "webhookSecret";
      owner = "root";
      mode = "0400";
      restartUnits = [
        "daedalus-github-render.service"
        "podman-app-daedalus.service"
      ];
    };

    # Copy the webhook secret into /run/daedalus-github, the container's /github.
    # `install` of the decrypted file, NOT the render heredoc: the heredoc ends
    # the file with a newline, and an HMAC keyed on "secret\n" rejects every
    # delivery GitHub signs with "secret". The heredoc only writes a marker
    # naming where the copy came from.
    systemd.services.daedalus-github-render = lib.mkIf haveGithubApp (mkSecretRender {
      description = "Copy the GitHub App webhook secret for daedalus to verify deliveries";
      gates = [ "podman-app-daedalus.service" ];
      dir = githubRenderDir;
      file = "${githubRenderDir}/source";
      mode = "0444";
      prep = ''
        install -m 0400 -o ${config.fleet.operator.user} -g ${config.fleet.operator.group} ${
          config.sops.secrets."github-app-webhook-secret".path
        } ${githubRenderDir}/webhook-secret
      '';
      content = "webhook-secret: copied from the sops secret github-app-webhook-secret (site/vault/github-app.sops, key webhookSecret)";
    });

    # The minter's output dir: root-owned and root-only-writable, so its
    # write_json_atomic publishes directly as root and nothing the container
    # controls can be planted at the name. tmpfiles (not statePaths) because
    # it is /run, and `d` with no age so a rebuild never empties it.
    systemd.tmpfiles.settings."10-daedalus-github-token" = lib.mkIf haveGithubApp {
      ${githubTokenDir}.d = {
        mode = "0755";
        user = "root";
        group = "root";
      };
    };

    # The token minter. Root, because the key is root's; network-ordered and
    # deliberately NOT ordered before the container — a GitHub outage must never
    # gate the app's start (the image-freshness rule).
    systemd.services.daedalus-github-token = lib.mkIf haveGithubApp (
      bridgeAgent
      // {
        description = "Mint the daedalus GitHub App's installation token";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        serviceConfig = {
          Type = "oneshot";
          ExecStart = "${githubTokenScript}/bin/daedalus-github-token";
          # Two GitHub calls at 15 s each, plus a revoke at most.
          TimeoutStartSec = "2min";
          # The JWT, the token answer and the curl configs live in a mktemp dir;
          # a private /tmp keeps even their names off the shared one.
          PrivateTmp = true;
          UMask = "0077";
        };
      }
    );

    # A token lives 60 minutes; every 30 means a reader always holds one with
    # 25+ left (the engine wants 5). Monotonic, so never on the hour.
    systemd.timers.daedalus-github-token = lib.mkIf haveGithubApp {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "1min";
        OnUnitActiveSec = "30min";
      };
    };

    # The bridge verb: the app asks for a fresh token now (a 401, an install
    # that just landed) instead of waiting for the tick. Throttled in the
    # script to one mint a minute.
    systemd.paths.daedalus-github-token = lib.mkIf haveGithubApp {
      description = "Watch for a daedalus GitHub token refresh request";
      wantedBy = [ "multi-user.target" ];
      pathConfig.PathChanged = "${applyDir}/github-token-request.json";
    };

    # Silent from the reader's side like every snapshot: a stopped minter leaves
    # a token that simply expires, and every GitHub call after that fails in a
    # place far from here. GitHub being down exits 0 (the file says so); what
    # mails is the minter itself breaking.
    fleet.monitoredJobs.daedalus-github-token = lib.mkIf haveGithubApp { };
  };
}
