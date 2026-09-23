# Pi-hole 6 — native NixOS service (NOT a container).
#
# Config lives in /etc/pihole/pihole.toml, which we force to a /nix/store
# symlink (see environment.etc override at bottom). That makes the TOML
# truly immutable: even with misc.readOnly = true, pi-hole's teleporter-
# import code path bypasses readOnly and would corrupt the file (hit
# empirically). A /nix/store symlink can't be written to at all.
#
# Pi-hole *data* (gravity.db blocklists/custom domains, pihole-FTL.db
# query history, macvendor.db, tls.pem) lives in /var/lib/pihole and
# is fully mutable — UI changes go there, not into pihole.toml.
#
# Per-stack DNS entries flow in via `fleet.dnsHosts`. The nodes (the other
# machines running the agent) get no record here: the control plane binds
# each node's MAC to its name in a runtime file dnsmasq reads as a
# `dhcp-hostsdir` (stacks/daedalus), so the lease itself carries the name.
#
# The host brings:
#   fleet.modules.pihole.enable              the switch (default off, as every catalog module)
#   fleet.modules.pihole.dhcpHostsSopsFile   the static DHCP reservations, encrypted (optional)
#   fleet.modules.pihole.localDomain         the LAN's own search domain (default `lan`)
# The scope, the upstreams and the interface come from site.json
# (platform/site.nix); the records come from every stack's `fleet.webApps`.

{
  config,
  lib,
  pkgs,
  mkSecretRender,
  ...
}:

let
  cfg = config.fleet.modules.pihole;

  hostEntries = config.fleet.dnsHosts;

  # Hostname half of each entry — used for the per-name `local=` lines below.
  localOnlyHostnames = map (e: lib.elemAt (lib.splitString " " e) 1) hostEntries;

  haveReservations = cfg.dhcpHostsSopsFile != null;
in
{
  options.fleet.modules.pihole = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Pi-hole 6 — LAN DNS and DHCP (native NixOS service).";
    };

    dhcpHostsSopsFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = lib.literalExpression "./host/sops/pihole/dhcp-hosts.sops";
      description = ''
        The household's static DHCP reservations — dnsmasq `dhcp-hostsfile`
        lines, `MAC,IP,hostname` — as sops ciphertext (binary format). A
        device inventory does not belong in cleartext in any git history,
        private or not, so the module never sees it decrypted: sops-nix
        hands the file to FTL at activation, and a change is a rotation
        (edit, rebuild). Null: no reservations, and no file.
      '';
    };

    localDomain = lib.mkOption {
      type = lib.types.str;
      default = config.fleet.lanDomain;
      defaultText = lib.literalExpression "config.fleet.lanDomain";
      description = ''
        The LAN's own DNS domain: dnsmasq answers `<device>.<localDomain>`
        for every lease and reservation, and marks the zone local. Defaults
        to `fleet.lanDomain`, the name the platform composes node addresses
        under, so the two agree unless a host says otherwise.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # Native NixOS service, not a container — traefik dials it through
    # pasta's host gateway alias instead of via traefik-net.
    fleet.webApps.pihole = {
      serviceUrl = "http://host.containers.internal:8080";
      # The Pocket ID gate is the only browser auth — FTL's own password
      # is blanked (see the webserver comment below). traefik dials FTL
      # at host.containers.internal:8080 (serviceUrl above).
      auth = "oidc";
      healthPath = "/api/info/login";
      # daedalus reads the query counts through traefik on the public
      # hostname, so those read-only calls skip the OIDC gate: GET
      # stats/info/history (aggregate counts — no domains, no clients)
      # plus the POST /api/auth handshake (returns a blank-password
      # session, no state change). Control endpoints (config, gravity,
      # the teleporter, …) stay gated, and so does every method that
      # writes: `/api/dns/blocking` is listed for GET only, which is what
      # separates "is blocking currently paused" from turning it off.
      authBypassRule = "(Method(`GET`) && (PathPrefix(`/api/stats`) || PathPrefix(`/api/info`) || PathPrefix(`/api/history`) || Path(`/api/dns/blocking`))) || (Method(`POST`) && Path(`/api/auth`))";
    };
    # Consent screen and Pocket ID's My Apps page.
    fleet.ssoClients.pihole = {
      displayName = "Pi-hole";
      description = "LAN DNS, DHCP, ad-blocking";
    };

    # The resolver facts daedalus renders (see platform/export.nix), contributed
    # from the stack that owns the settings. Read back from the FTL config
    # rather than fleet.dnsHosts, because this module appends hosts that belong
    # to no stack (the GPU box) and a page showing only the stack half would
    # be quietly missing entries that exist. lanHosts split into address and
    # name: nearly every one points at this box, and the ones that do not are
    # exactly the interesting rows.
    fleet.export.domains.network.data =
      let
        parse = e: {
          ip = lib.elemAt (lib.splitString " " e) 0;
          host = lib.elemAt (lib.splitString " " e) 1;
        };
      in
      {
        lanHosts = lib.sort (a: b: a.host < b.host) (
          map parse config.services.pihole-ftl.settings.dns.hosts
        );
        dnsUpstreams = config.services.pihole-ftl.settings.dns.upstreams;
        dhcp = {
          inherit (config.services.pihole-ftl.settings.dhcp)
            active
            router
            start
            end
            leaseTime
            ;
          # No `hosts` here: the reservations moved to the encrypted
          # dhcp-hostsfile, which nix cannot read at eval (sops decrypts at
          # activation), so the export simply doesn't have them any more.
          # daedalus reads the decrypted file at runtime instead
          # (fleet.dashboard.pihole below).
        };
      };

    # The household device inventory (static DHCP reservations). Owned by
    # pihole so FTL's dnsmasq can read it; rotation (a device joins or
    # leaves) is `sops <the host's file>` + rebuild, and the
    # restart below makes the new lines land (dnsmasq reads hostsfiles at
    # startup). daedalus's network page reads the same source through the
    # render below — one encrypted file, two readers — and a rotation
    # re-renders that copy too; the container reads new bytes on its next
    # request.
    sops.secrets."pihole-dhcp-hosts" = lib.mkIf haveReservations {
      sopsFile = cfg.dhcpHostsSopsFile;
      format = "binary";
      owner = "pihole";
      restartUnits = [
        "pihole-ftl.service"
      ]
      ++ lib.optional config.fleet.modules.daedalus.enable "pihole-daedalus-dhcp.service";
    };

    # What this stack shows the control plane (fleet.dashboard, platform/
    # export.nix):
    #   - PIHOLE_URL: pi-hole NOT through traefik, bound from the same option
    #     that tells traefik where to dial. The reads this backs carry device
    #     identities — hostnames, MAC addresses, what each one looks up — and
    #     reaching them on the public hostname would mean widening the
    #     unauthenticated bypass in front of it to match. Off the bridge there
    #     is nothing to widen: the gate stays exactly where it is.
    #   - PIHOLE_VERSION: the resolver is a NixOS service rather than a pinned
    #     image, so the package IS the running version — and FTL's own
    #     /api/info/version reads /etc/pihole/versions, a file the Docker image
    #     writes and this installation has never had (it answers
    #     `internal_error`).
    #   - the DHCP reservations, copied out of the encrypted hostsfile above.
    #     A render rather than a bind of /run/secrets: the secret is
    #     pihole-owned, and the copy is the operator's so rootless podman can
    #     mount it. The DIRECTORY, not the file: /run/secrets entries are
    #     symlinks that move on rotation, and a single-file bind would pin the
    #     old inode. Not /run/app-daedalus: that is the container unit's
    #     RuntimeDirectory, wiped when the container stops.
    fleet.dashboard.pihole = {
      env = {
        PIHOLE_URL = config.fleet.webApps.pihole.serviceUrl;
        PIHOLE_VERSION = config.services.pihole-ftl.package.version;
      }
      // lib.optionalAttrs haveReservations { DHCP_HOSTS_PATH = "/dhcp/hosts"; };
      volumes = lib.optional haveReservations "/run/pihole-daedalus:/dhcp:ro";
    };
    systemd.services.pihole-daedalus-dhcp =
      lib.mkIf (config.fleet.modules.daedalus.enable && haveReservations)
        (mkSecretRender {
          description = "Render the DHCP reservations for daedalus's network page";
          gates = [ "podman-app-daedalus.service" ];
          dir = "/run/pihole-daedalus";
          file = "/run/pihole-daedalus/hosts";
          content = "$(cat ${config.sops.secrets."pihole-dhcp-hosts".path})";
        });

    services.pihole-ftl = {
      enable = true;
      openFirewallDNS = true; # 53 TCP + UDP
      openFirewallDHCP = true; # 67 UDP
      # 8080 (admin web UI) is NOT opened to the LAN. traefik reaches
      # pihole-FTL's UI via host.containers.internal, which is
      # the LAN address to itself (host-to-self, routed over `lo` and accepted
      # by the firewall's `-i lo` rule). LAN devices (on the LAN interface)
      # hitting :8080 are dropped -> admin is HTTPS-only via the published hostname.
      openFirewallWebserver = false; # 8080 TCP: LAN-blocked (see above)

      settings = {
        dns = {
          interface = config.fleet.lanInterface;
          listeningMode = "ALL";
          upstreams = config.fleet.dnsUpstreams;
          bogusPriv = false;
          hosts = hostEntries;
          domain = {
            name = cfg.localDomain;
            local = true;
          };
          reply.host.force4 = true;

          # FTL's per-client limit defaults to 1 000 queries per 60 s and
          # answers REFUSED above it. Every container on this box resolves
          # through 127.0.0.1, so for FTL the whole fleet is ONE client and
          # the per-client limit is a per-box limit. It tripped twice on
          # 2026-09-10: at 8 000 queries/min from one dead backend being
          # resolved per request, taking image pulls and the OIDC gates
          # down with it, and again for two seconds on a clean boot as 74
          # containers started. A raise rather than off: the LAN's own
          # devices share this setting and a runaway one should still be
          # capped, just not at a figure the fleet's normal boot approaches.
          rateLimit = {
            count = 20000;
            interval = 60;
          };
        };

        dhcp = {
          # The scope comes from site/site.json (platform/site.nix), so it is
          # editable from daedalus and a change is a commit + rebuild.
          inherit (config.fleet.dhcp)
            active
            router
            start
            end
            leaseTime
            ;
          # Static reservations live in dhcp-hosts.sops (same "MAC,IP,hostname"
          # lines, fed to dnsmasq via the dhcp-hostsfile= directive below).
          # Encrypted rather than listed here because this is the one config
          # atom that is a household device inventory — real MACs and family
          # device names — and that does not belong in cleartext in ANY git
          # history, private or not (a leaked clone or a later flip to public
          # would carry every past revision). The box's own line rides along —
          # dnsmasq populates `<hostname>.<localDomain> → <lanIp>` from it, no DHCP transaction.
        };

        webserver = {
          # No admin password — the web UI sits behind traefik's Pocket ID
          # gate (AUTH.md) and :8080 stays LAN-closed. Deliberate
          # trade-off (2026-07-18): the API remains reachable WITHOUT
          # auth from any container on the box via
          # host.containers.internal:8080 (that's also how traefik and
          # daedalus gets in). FTL has no "password on the API,
          # UI stays login-free" mode — the UI is an API client, so ANY
          # configured hash (app passwords included) re-enables the login
          # wall, and a second login behind SSO is explicitly not wanted.
          # Accepted: containers can read the DNS query log / toggle
          # blocking; misc.readOnly still blocks config writes.
          api.pwhash = "";
          api.app_pwhash = "";
          # Relaxed CSP (upstream default is too strict for Chart.js inline scripts).
          headers = [
            "X-DNS-Prefetch-Control: off"
            "Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;"
            "X-Frame-Options: DENY"
            "X-XSS-Protection: 0"
            "X-Content-Type-Options: nosniff"
            "Referrer-Policy: strict-origin-when-cross-origin"
          ];
        };

        misc = {
          # Blocks the API config-write path. Paired with the /nix/store
          # symlink override below, pihole.toml is fully reproducible from
          # this file; UI changes only land in /var/lib/pihole.
          readOnly = true;

          # Per-name `local=` (not zone-wide). For each LAN-resolved name,
          # dnsmasq answers exclusively from local sources: A → the LAN address,
          # AAAA → NODATA. Kills the iOS Happy-Eyeballs trap where an
          # upstream-forwarded AAAA returns CF anycast IPv6 for tunnel-
          # proxied hostnames and outraces the LAN A. Per-name (NOT a
          # zone-wide `local=/<baseDomain>/`, which would NXDOMAIN the
          # apex and every public record): names NOT in dns.hosts fall
          # through to upstreams normally, so the apex and every public
          # record resolve to their real addresses.
          #
          # SRV records under the LAN's own domain (fleet.dnsSrv): how a
          # machine on the network finds a service here by asking the search
          # domain DHCP handed it, without being told an address.
          dnsmasq_lines =
            map (h: "local=/${h}/") localOnlyHostnames
            ++ map (
              s: "srv-host=${s.service}.${cfg.localDomain},${s.target},${toString s.port}"
            ) config.fleet.dnsSrv
            ++ lib.optional haveReservations "dhcp-hostsfile=${config.sops.secrets."pihole-dhcp-hosts".path}"
            # The nodes' MAC-to-name bindings, written at runtime by the control
            # plane and copied under /run/daedalus-nodes (stacks/daedalus): a
            # directory rather than a file so dnsmasq picks a new file up on
            # its own, and a HUP (which the copier sends) re-reads a changed
            # one. A join never needs a rebuild, and no MAC enters nix.
            ++ lib.optional config.fleet.modules.daedalus.enable "dhcp-hostsdir=/run/daedalus-nodes";
        };
      };
    };

    services.pihole-web = {
      enable = true;
      ports = [ 8080 ]; # HTTP only — traefik terminates TLS on 443
      hostName = config.fleet.webApps.pihole.hostname;
    };

    # Force a /nix/store symlink (not a copy). The pihole-ftl module sets
    # mode="400", which makes NixOS copy the file into /etc and then refuse
    # to overwrite it on rebuilds — so a teleporter-corrupted toml survives
    # across nixos-rebuild switch (hit empirically). As a symlink, the file
    # can never be written to and every rebuild re-points it at the latest
    # rendered toml.
    environment.etc."pihole/pihole.toml".mode = lib.mkForce "symlink";

    # Let alloy reach FTL.log — traverse the log directory, do not list it.
    #
    # FTL is the one service on this box that does not log to the journal: it
    # writes its own files here, and the only journal lines about the unit come
    # from systemd itself carrying `_SYSTEMD_UNIT=init.scope`, which is not what
    # alloy labels on. So `{unit="pihole-ftl.service"}` in Loki matched nothing,
    # ever. Shipping the file is the fix, and rootless podman resolves a bind
    # mount as the operator, who cannot traverse the upstream module's 0700.
    #
    # 0751 rather than 0755 on purpose. The `x` bit is all a bind mount of a
    # KNOWN path needs; without `r` nothing can enumerate the directory to
    # discover what else is in it. What that exposes is exactly the two files
    # already world-readable — FTL.log and webserver.log, both 0644 from FTL
    # itself. `pihole.log` is the per-query log, 0640, currently 2 GB, and stays
    # unreadable to everything but pihole: it is the most revealing file on the
    # machine and emphatically not something to put in Loki.
    #
    # A separate tmpfiles file rather than another `rules` line: the upstream
    # module's `d /var/log/pihole 0700` lands in 00-nixos.conf, and systemd
    # applies files in lexical order, so this one has to sort after it to win.
    systemd.tmpfiles.settings."10-pihole-log-dir"."/var/log/pihole".z = {
      mode = "0751";
      user = "pihole";
      group = "pihole";
    };

    # And ship it (fleet.logFiles, rendered by the logging stack). An exact
    # path, NOT a glob: `pihole.log` sits beside it, and a `*.log` match would
    # have swallowed it — and the rotated FTL.log.N, re-ingesting the same
    # lines on every rotation. FTL's own format is
    # `2026-08-06 14:30:46.900 -03 [pid/Tthread] LEVEL: text`, parsed for two
    # reasons: the timestamp, so a line is filed under when FTL wrote it
    # rather than when alloy read it (they differ by the whole backlog on
    # first ingest), and the level, which FTL states in words and which every
    # other source already carries as a label.
    fleet.logFiles.pihole = {
      path = "/var/log/pihole/FTL.log";
      mountDir = "/var/log/pihole";
      # `unit` is what every logs panel selects on; `infra` is the stack the
      # journal rules give ddclient and smartd, where a reader would look.
      labels = {
        unit = "pihole-ftl.service";
        stack = "infra";
        host = config.networking.hostName;
        job = "pihole-ftl";
        service_name = "pihole-ftl";
      };
      stages = ''
        stage.regex {
          expression = "^(?P<ts>\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d+ [+-]\\d{2}) \\[[^\\]]*\\] (?P<lvl>[A-Z]+):"
        }

        stage.timestamp {
          source   = "ts"
          format   = "2006-01-02 15:04:05.000 -07"
        }

        stage.template {
          source   = "lvl"
          template = "{{ $l := ToLower .Value }}{{ if eq $l \"\" }}unknown{{ else if eq $l \"err\" }}error{{ else if eq $l \"warn\" }}warning{{ else if eq $l \"crit\" }}crit{{ else }}{{ $l }}{{ end }}"
        }

        stage.labels {
          values = {
            level = "lvl",
          }
        }
      '';
    };

    # pihole-ftl is Type=simple — it declares "active" the instant the FTL
    # process starts, well before it's loaded gravity.db and bound :53. So
    # `After=pihole-ftl.service` only orders, it doesn't wait for readiness.
    # This oneshot polls FTL itself — a dns.hosts name it answers from
    # local config, no upstream involved — until it responds, providing a
    # readiness gate for anything that does DNS at boot: depend on
    # pihole-ready.service instead of pihole-ftl.service.
    systemd.services.pihole-ready = {
      description = "Gate: pi-hole is actually answering DNS queries";
      after = [
        "pihole-ftl.service"
        "network-online.target"
      ];
      wants = [
        "pihole-ftl.service"
        "network-online.target"
      ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = pkgs.writeShellScript "wait-pihole-dns" ''
          for i in $(seq 1 60); do
            ${pkgs.dnsutils}/bin/dig +time=1 +tries=1 @127.0.0.1 \
              ${config.fleet.webApps.pihole.hostname} >/dev/null 2>&1 && exit 0
            sleep 0.25
          done
          # Don't block boot forever if FTL never answers.
          exit 0
        '';
      };
    };
  };
}
