# yazio-mcp — fliptheweb/yazio-mcp (unofficial MCP server over Yazio's
# reverse-engineered API: diary, water, weight, goals, product search)
# behind supergateway, riding the LiteLLM MCP gateway like grocy-mcp:
# litellm dials http://mcp-yazio:8080/mcp over the private yazio-mcp
# bridge (only litellm + this container are on it).
#
# ── why there is a gateway inside the container ────────────────────────
#
# yazio-mcp speaks stdio only, and LiteLLM's registry (fleet.mcpServers)
# dials streamable HTTP. supergateway (supercorp-ai) is the adapter: it
# listens on :8080/mcp and spawns `yazio-mcp` as a child, piping JSON-RPC
# between the two. Neither project publishes an image that contains the
# other, so the image is built here (mkLocalImage) from a pinned
# node:24-slim plus the two npm packages at the versions below. Bumping
# either version changes the build context, hence the tag, hence the
# container restarts on the next rebuild — the local-build equivalent of
# moving a digest pin. Alpine would do too; slim is picked because the
# box already holds that base for daedalus, so a fresh build pulls nothing.
#
# ── stateless, and what that costs ─────────────────────────────────────
#
# supergateway runs in its default STATELESS mode: one child process per
# HTTP request, killed when the response closes. yazio-mcp logs into
# Yazio in its constructor and exits on failure, so every tools/list and
# every tool call is a fresh login (two round trips to Yazio before the
# actual work). Low volume, so accepted — the alternative, `--stateful`,
# still spawns a child per MCP session, and LiteLLM opens one per
# operation, so it would buy nothing and leave a child alive per
# unterminated session until `--sessionTimeout`.
#
# The upside of per-request spawning: the container is up as long as
# supergateway is, independent of Yazio. Wrong credentials do NOT kill
# the container (container_up stays 1, no alert) — they show up as
# `Child stderr: ❌ Failed to authenticate with Yazio` on every request
# in this container's log, and the caller sees its tools/list fail.
#
# ── credentials ────────────────────────────────────────────────────────
#
# YAZIO_USERNAME / YAZIO_PASSWORD (the Yazio account login — there is no
# API token) in env.sops, read by supergateway's environment and
# inherited by the child it spawns. After editing env.sops:
#   sudo nixos-rebuild switch && sudo systemctl restart podman-mcp-yazio
# — the rebuild re-decrypts /run/secrets, but the env was read at
# container start, and nothing in the unit text changed to restart it.
#
# ── logs ───────────────────────────────────────────────────────────────
#
# `--logLevel info` is deliberate, though chatty: supergateway prints
# every JSON-RPC message in both directions on stdout, and forwards the
# child's stderr — which is where yazio-mcp says whether it logged in —
# on its own stderr, so those lines carry err priority in journald.
# `none` would silence the auth failure too, which is the one line worth
# having. Loki label stack="yazio-mcp"; daedalus shows the stream on the
# AI › LiteLLM tab beside the other gateway neighbours, with the release
# gap of BOTH packages (the tag carries both versions; daedalus.nix
# parses them).
#
# Stateless — no bind mounts, no fleet.statePaths.

{
  config,
  pkgs,
  mkDotenvSecret,
  mkLocalImage,
  mkRootlessContainer,
  ...
}:

let
  # The two things this image is. Release notes: github.com/fliptheweb/yazio-mcp
  # and github.com/supercorp-ai/supergateway (daedalus reads both gaps).
  yazioMcpVersion = "0.0.14";
  supergatewayVersion = "3.4.3";

  # node:24-slim as already present on the box (the daedalus runtime's
  # base). Pinned by digest so the build is the same build tomorrow;
  # bump with `skopeo inspect docker://docker.io/library/node:24-slim`.
  nodeImage = "docker.io/library/node:24-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df";

  # `USER node` (uid 1000 → host 100999): nothing here owns files, so the
  # least-privileged user the base image ships is free. The global npm
  # install happens as root first, which is what makes it world-readable.
  imageContext = pkgs.runCommand "mcp-yazio-image-context" { } ''
    mkdir -p $out
    cat > $out/Containerfile <<EOF
    FROM ${nodeImage}
    RUN npm install -g --no-audit --no-fund --omit=dev \
          supergateway@${supergatewayVersion} yazio-mcp@${yazioMcpVersion}
    USER node
    EXPOSE 8080
    ENTRYPOINT ["supergateway", \
      "--stdio", "yazio-mcp", \
      "--outputTransport", "streamableHttp", \
      "--port", "8080", \
      "--streamableHttpPath", "/mcp", \
      "--healthEndpoint", "/healthz", \
      "--logLevel", "info"]
    EOF
  '';

  # Tag shape `<yazio-mcp>-sg<supergateway>-<ctxhash>` is a contract:
  # daedalus.nix parses both versions back out of it for the AI tab.
  gatewayImage = mkLocalImage {
    name = "mcp-yazio";
    tagPrefix = "${yazioMcpVersion}-sg${supergatewayVersion}";
    contextDir = imageContext;
    gates = [ "podman-mcp-yazio.service" ];
  };
in
{
  # Private bridge: only litellm + this server. litellm's list merges
  # with its own [ "app-db" "traefik" ] contribution.
  fleet.bridgeMemberships = {
    "mcp-yazio" = [ "yazio-mcp" ];
    litellm = [ "yazio-mcp" ];
  };

  fleet.logStacks."yazio-mcp" = [ "mcp-yazio" ];

  # Registration on the LiteLLM MCP gateway lives with the server that
  # backs it. `exposeRemotely` publishes /Yazio/mcp through the CF tunnel
  # for off-box MCP clients (the `claude` key tracks the published set);
  # see stacks/litellm/mcp.nix. The logo is the Play Store listing's icon
  # (dashboard-icons has no Yazio).
  fleet.mcpServers.Yazio = {
    url = "http://mcp-yazio:8080/mcp";
    description = "Yazio nutrition diary: meals, water, weight, goals, food search";
    logoUrl = "https://play-lh.googleusercontent.com/QqbWLtHPocHrgg03WyNqfmxVMBEEnvdavkz5xkdjwrr1MEpkez6f76_hsqxiTbg18M20oqN_k_DVlbG7C7s7kw=w240-h480-rw";
    exposeRemotely = true;
  };

  # YAZIO_USERNAME + YAZIO_PASSWORD — operator-managed, see the header.
  sops.secrets."yazio-mcp-env" = mkDotenvSecret ./env.sops;

  systemd.services.mcp-yazio-image-build = gatewayImage.service;

  virtualisation.oci-containers.containers.mcp-yazio = mkRootlessContainer {
    inherit (gatewayImage) image;
    environmentFiles = [ config.sops.secrets."yazio-mcp-env".path ];
  };
}
