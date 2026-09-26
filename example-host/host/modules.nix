# Which of the engine's catalog modules this box runs, and this household's
# policy for each.
#
# Every catalog module is OFF until a host switches it on here; importing the
# engine starts nothing. What rides with a switch is POLICY — who may log in,
# under which name, reachable off-LAN or not — and the engine defaults each to
# the narrowest answer (`admins`, LAN-only). Mechanism (which image, ports,
# mounts, what makes the app work behind the gate) is the module's.
#
# The set below is the spine a box needs to log in to its control plane:
# the reverse proxy, the identity provider, the shared database, the registry
# the builds push to, the resolver, the tunnel, logs, metrics, the two
# monitors — and the apps platform, which turns the control plane's own entry
# into its container. Add a leaf (`stirling-pdf` is one) the same way.
#
# The image pin of every container these run is in host/images.nix; their
# operator secrets are host/sops/<id>/…, named here.
_: {
  fleet.modules = {
    # The apps platform: every self-built app in site/apps.json, the control
    # plane's own container included.
    apps.enable = true;

    # The shared Postgres cluster every app and most modules ride.
    app-db.enable = true;

    # The Cloudflare tunnel: the only way public HTTP reaches the box. Its
    # credentials are the secret Cloudflare shows once, at tunnel creation.
    cloudflared = {
      enable = true;
      credentialsSopsFile = ./sops/cloudflared/credentials.json.sops;
    };

    # Outside-in uptime probing of every published hostname. The dashboard
    # admits the operator's account only: their `sub` at the identity
    # provider, shown on the account's page there.
    gatus = {
      enable = true;
      allowedSubjects = [ "00000000-0000-0000-0000-000000000000" ];
    };

    # Dead-man's-switch monitoring of the scheduled jobs.
    healthchecks = {
      enable = true;
      envSopsFile = ./sops/healthchecks/env.sops;
    };

    # Centralized logs: Loki and the alloy shipper.
    logging.enable = true;

    # Prometheus, Grafana and node-exporter.
    monitoring = {
      enable = true;
      envSopsFile = ./sops/monitoring/env.sops;
    };

    # LAN DNS and DHCP. The static reservations (the household's device
    # inventory) are optional and encrypted: `dhcpHostsSopsFile`.
    pihole.enable = true;

    # The identity provider. `exposeRemotely = true` the day a gated app is
    # published off-LAN — its login redirects here (asserted).
    pocket-id = {
      enable = true;
      envSopsFile = ./sops/pocket-id/env.sops;
    };

    # The box's own OCI registry: every app image is built into it and pulled
    # from it.
    registry = {
      enable = true;
      envSopsFile = ./sops/registry/env.sops;
    };

    # A leaf of the catalog, as an example of one: switch, policy, and a pin
    # in host/images.nix.
    stirling-pdf.enable = true;

    # The reverse proxy every published hostname goes through.
    traefik = {
      enable = true;
      envSopsFile = ./sops/traefik/env.sops;
    };
  };
}
