# n8n — workflow automation + postgres on n8n-net.
#
# docker.io path NOT `docker.n8n.io` — the latter is blocked by
# pi-hole (resolves to us, returns traefik's default cert).

{ config, mkRootlessContainer, ... }:

{
  myStack.containerNetworks = {
    n8n-postgres = "n8n";
    n8n          = "n8n";
  };

  myStack.traefikRoutes.n8n = {
    host = "n8n.s2.toscanini.me";
    port = 5678;
  };


  myStack.dnsHosts = [ "192.168.0.2 n8n.s2.toscanini.me" ];

  myStack.homepageServices."Productivity" = [{
    name = "n8n";
    href = "https://n8n.s2.toscanini.me";
    description = "Workflow automation";
    icon = "n8n.png";
    siteMonitor = "http://host.containers.internal:5678";
  }];

  virtualisation.oci-containers.containers.n8n-postgres = mkRootlessContainer {
    image = "docker.io/library/postgres:15-alpine";

    volumes = [
      "/home/santiago/selfhost/n8n/db:/var/lib/postgresql/data"
    ];

    environment = {
      POSTGRES_DB = "n8n";
      POSTGRES_USER = "n8n";
    };

    # PG_PASS in this env file is re-exported as POSTGRES_PASSWORD by
    # the entrypoint below (compose used POSTGRES_PASSWORD=${PG_PASS}).
    environmentFiles = [ "/etc/nixos/containers/n8n/env" ];

    entrypoint = "/bin/sh";
    cmd = [
      "-c"
      "export POSTGRES_PASSWORD=\"$PG_PASS\" && exec docker-entrypoint.sh postgres"
    ];

    extraOptions = [
      "--network=n8n-net"
    ];
  };

  virtualisation.oci-containers.containers.n8n = mkRootlessContainer {
    image = "docker.io/n8nio/n8n:latest";
    dependsOn = [ "n8n-postgres" ];

    ports = [ "5678:5678" ];

    volumes = [
      "/home/santiago/selfhost/n8n/data:/home/node/.n8n"
      "/home/santiago/selfhost/n8n/local-files:/files"
    ];

    environment = {
      DB_TYPE = "postgresdb";
      DB_POSTGRESDB_HOST = "n8n-postgres";
      DB_POSTGRESDB_PORT = "5432";
      DB_POSTGRESDB_DATABASE = "n8n";
      DB_POSTGRESDB_USER = "n8n";
      N8N_BASIC_AUTH_ACTIVE = "true";
      N8N_HOST = "n8n.s2.toscanini.me";
      N8N_PORT = "5678";
      N8N_PROTOCOL = "https";
      NODE_ENV = "production";
      WEBHOOK_URL = "https://n8n.s2.toscanini.me";
      GENERIC_TIMEZONE = config.time.timeZone;
    };

    # PG_PASS + N8N_USER + N8N_PASS + N8N_ENCRYPTION_KEY.
    environmentFiles = [ "/etc/nixos/containers/n8n/env" ];

    # The image expects DB_POSTGRESDB_PASSWORD / N8N_BASIC_AUTH_USER /
    # N8N_BASIC_AUTH_PASSWORD; compose mapped from PG_PASS / N8N_USER /
    # N8N_PASS. Re-export in the entrypoint so we don't duplicate the
    # secrets in the env file.
    entrypoint = "/bin/sh";
    cmd = [
      "-c"
      ''
        export DB_POSTGRESDB_PASSWORD="$PG_PASS" \
               N8N_BASIC_AUTH_USER="$N8N_USER" \
               N8N_BASIC_AUTH_PASSWORD="$N8N_PASS" && \
        exec /docker-entrypoint.sh
      ''
    ];

    extraOptions = [
      "--network=n8n-net"
    ];
  };
}
