# searxng — self-hosted metasearch engine, the fleet's web-search
# backend. It lives in the litellm stack because the gateway owns the
# web-search capability: LiteLLM registers it as the `searxng` search
# tool (assets/config.yaml → POST /v1/search/searxng, plus the
# websearch_interception callback that runs it for any tool-calling
# client that sends a `web_search` tool). Open WebUI is a second,
# independent consumer — its in-chat RAG web search dials the SAME
# instance directly (http://searxng:8080), so both share one engine over
# the private `websearch` bridge.
#
# Internal only — no ingress, no host port. Reached solely by container
# DNS on the websearch bridge (aardvark-dns). settings.yml is bind-
# mounted from assets/; the real secret_key comes from SEARXNG_SECRET.

{
  pkgs,
  mkRootlessContainer,
  ...
}:

let
  secretsDir = "/home/santiago/selfhost/litellm/secrets";
  searxngSecretFile = "${secretsDir}/searxng-env";
in
{
  # Private bridge shared with its two consumers (litellm, open-webui).
  fleet.bridgeMemberships.searxng = [ "websearch" ];

  # Loki stack label — group searxng under the litellm stack (alloy tags
  # journal lines). The litellm container itself falls back to
  # stack=litellm by container name.
  fleet.logStacks.litellm = [ "searxng" ];

  # SEARXNG_SECRET — machine-generated on first boot into secrets/
  # (gitignored). Rotate = delete the file + rebuild; harmless, searxng
  # is stateless here and the key only signs transient URLs/sessions.
  systemd.services."searxng-secret-bootstrap" = {
    description = "Bootstrap searxng: generate SEARXNG_SECRET on first boot";
    before = [ "podman-searxng.service" ];
    wantedBy = [ "podman-searxng.service" ];
    after = [ "local-fs.target" ];
    path = [
      pkgs.openssl
      pkgs.coreutils
    ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      Restart = "on-failure";
      RestartSec = "5s";
    };
    script = ''
      set -eu
      install -d -m 0700 -o santiago -g users "${secretsDir}"
      if [ ! -e "${searxngSecretFile}" ]; then
        install -m 0600 -o santiago -g users /dev/stdin "${searxngSecretFile}" <<EOF
      SEARXNG_SECRET=$(openssl rand -hex 32)
      EOF
      fi
    '';
  };

  virtualisation.oci-containers.containers.searxng = mkRootlessContainer {
    image = "docker.io/searxng/searxng:latest@sha256:99e3445d6af18459da4f255991cdd47551249d66e6bcc84036d15fea89229e8b";

    volumes = [
      "${./assets/searxng/settings.yml}:/etc/searxng/settings.yml:ro"
      # Read even with the limiter off — botdetection initialises first
      # and warns at every start when this is absent. See the file.
      "${./assets/searxng/limiter.toml}:/etc/searxng/limiter.toml:ro"
    ];

    environment = {
      SEARXNG_BASE_URL = "http://searxng:8080/";
    };

    # SEARXNG_SECRET (machine-generated) overrides the placeholder
    # secret_key in settings.yml.
    environmentFiles = [ searxngSecretFile ];
  };
}
