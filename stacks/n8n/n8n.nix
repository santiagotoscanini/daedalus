# n8n — workflow automation + postgres on n8n-net. The n8n container
# also joins traefik-net so traefik dials it as `http://n8n:5678` —
# no host port published.
#
# docker.io path NOT `docker.n8n.io` — the latter is blocked by
# pi-hole (resolves to us, returns traefik's default cert).

{ config, mkRootlessContainer, ... }:

{
  # PG_PASS + N8N_* creds + encryption key: sops-encrypted env.sops, decrypted to
  # /run/secrets/n8n-env at activation. Edit with `sops env.sops`.
  sops.secrets."n8n-env" = {
    sopsFile = ./env.sops;
    format = "dotenv";
    key = "";
    owner = "santiago";
  };

  myStack.containerNetworks = {
    n8n-postgres = "n8n";
    n8n = "n8n";
  };

  myStack.webApps.n8n = {
    hostname = "n8n.toscanini.me";
    serviceName = "n8n";
    port = 5678;
  };

  myStack.homepageServices."Productivity" = [
    {
      name = "n8n";
      href = "https://n8n.toscanini.me";
      description = "Workflow automation";
      icon = "n8n.png";
      siteMonitor = "http://n8n:5678";
      widget = {
        type = "customapi";
        # /api/v1/executions?limit=10 → {data: [{id, workflowId, status, startedAt, ...}], nextCursor}
        # Dynamic-list rendering: left column is the raw status
        # (success / error / running), right column is a human name
        # for the workflow. n8n's API does not return the workflow
        # name on the execution row, and customapi cannot join two
        # endpoints — so we hardcode a workflowId → name remap.
        # `name`/`label` are reversed from the natural reading order
        # because formatValue (and therefore `remap`) only runs on the
        # label field, not the name. Add new workflows here as they
        # appear; the `any` rule is a catch-all so unknown hashes
        # never leak into the UI.
        url = "http://n8n:5678/api/v1/executions?limit=10";
        refreshInterval = 60000;
        headers = {
          "X-N8N-API-KEY" = "{{HOMEPAGE_VAR_N8N_API_KEY}}";
        };
        display = "dynamic-list";
        mappings = {
          items = "data";
          limit = 5;
          name = "status";
          label = "workflowId";
          remap = [
            {
              value = "AaEwerVyMkmEEYJH";
              to = "Crypto monitor";
            }
            {
              value = "PE_s7WPIw-c6U3D7JuoQ7";
              to = "Supabase wakeup command";
            }
            {
              value = "71zc3JjYq5cKBfU3Sv5MI";
              to = "Instagram followers";
            }
            {
              value = "G2cUo1VdVDf7vi3t";
              to = "RSS Feeds";
            }
            {
              any = true;
              to = "Unknown workflow";
            }
          ];
        };
      };
    }
  ];

  virtualisation.oci-containers.containers.n8n-postgres = mkRootlessContainer {
    image = "docker.io/library/postgres:15-alpine@sha256:3d0f7584ed7d04e27fa050d6683a74746608faf21f202be78460d679cc56461f";

    volumes = [
      "/home/santiago/selfhost/n8n/db:/var/lib/postgresql/data"
    ];

    environment = {
      POSTGRES_DB = "n8n";
      POSTGRES_USER = "n8n";
    };

    # PG_PASS in this env file is re-exported as POSTGRES_PASSWORD by
    # the entrypoint below (compose used POSTGRES_PASSWORD=${PG_PASS}).
    environmentFiles = [ config.sops.secrets."n8n-env".path ];

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
    image = "docker.io/n8nio/n8n:2.29.10@sha256:9cb60554716a0ab11a966e79ed65171e1bbf00b6d262ba12aa119bba22eb6000";
    dependsOn = [ "n8n-postgres" ];

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
      N8N_HOST = "n8n.toscanini.me";
      N8N_PORT = "5678";
      N8N_PROTOCOL = "https";
      NODE_ENV = "production";
      WEBHOOK_URL = "https://n8n.toscanini.me";
      GENERIC_TIMEZONE = config.time.timeZone;
    };

    # PG_PASS + N8N_USER + N8N_PASS + N8N_ENCRYPTION_KEY.
    environmentFiles = [ config.sops.secrets."n8n-env".path ];

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
      # Also join traefik-net so the file-provider rule can dial
      # `http://n8n:5678` by container DNS — no host port needed.
      "--network=traefik-net"
    ];
  };
}
