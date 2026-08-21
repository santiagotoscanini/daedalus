# Declarative LiteLLM virtual keys — `fleet.litellmKeys.<alias>`.
#
# A virtual key is how the gateway tells its callers apart: every request
# carries one, and the ledger, the per-key metrics and the rate limits
# are all keyed on it. Before this, exactly four existed and all four
# were typed into the admin UI by hand — which meant a rebuilt `litellm`
# database lost every one of them, and it meant the services that had
# NOT been given one presented the master key instead.
#
# ── the shape is fleet.ssoClients', for the same reasons ───────────────
#
# Both halves originate on this box. The alias is a nix string (the attr
# name) and the key itself is generated here the first time it is
# declared — `POST /key/generate` accepts a caller-supplied `key`, so
# nothing has to be minted by the gateway and pasted back. That is what
# lets a fresh database re-converge on the next boot instead of needing
# every consumer re-keyed by hand.
#
# The key is machine-generated state, not operator state: born on the
# box, gitignored under `secrets/`, rotated by deleting its line and
# rebuilding. Same class as the app-db cluster password and each app's
# AUTH_SECRET, and for the same reason — nothing about a random 32-byte
# string wants a human in the loop.
#
# ── why the master key is not an acceptable default ────────────────────
#
# It is the ADMIN credential: it mints keys, reads every caller's ledger
# and reconfigures the gateway. Handing it to a chat UI to make chat
# requests is a privilege grant nobody chose, and it is also why the
# dashboard's caller list had one row reaching seven models — every
# consumer configured with it is indistinguishable from every other.
#
# ── two units, and why they are two ────────────────────────────────────
#
#   litellm-key-secrets.service   generates missing key values. No
#                                 network, no gateway — so the renders
#                                 that feed consumer containers gate on
#                                 THIS, and a consumer never waits on
#                                 litellm being up to start.
#   litellm-keys-sync.service     converges those values into the
#                                 gateway. Ordered after podman-litellm.
#
# Splitting them is what keeps a boot-order cycle from existing at all:
# open-webui needs the key, the key needs no gateway, and the gateway
# needs nothing from open-webui.
#
# Rotating a key: delete its line from the state file and rebuild. The
# generator mints a new one, the sync deletes the old key at the gateway
# and installs the new one under the same alias, and the renders hand the
# new value to every consumer — though a consumer holding the old one in
# memory needs a restart.

{
  config,
  lib,
  pkgs,
  mkSecretRender,
  ...
}:

let
  cfg = config.fleet.litellmKeys;

  # `LITELLM_KEY_OPEN_WEBUI` — the same uppercase-and-de-hyphenate
  # mapping the SSO client secrets use.
  envName = n: lib.toUpper (lib.replaceStrings [ "-" ] [ "_" ] n);
  secretKey = n: "LITELLM_KEY_${envName n}";

  # Machine-generated, one line per key, gitignored like every other
  # `secrets/` path on the box. Not in /run: it has to survive a reboot,
  # or every consumer would be re-keyed on every boot.
  stateDir = "${config.fleet.stateRoot}/ai/litellm/secrets";
  secretsFile = "${stateDir}/virtual-keys.env";
  secretsUnit = "litellm-key-secrets.service";

  # NOT /run/<container-name>: systemd wipes a RuntimeDirectory named
  # after a unit when that unit stops, which would silently empty the
  # rendered file underneath a running consumer.
  renderDir = "/run/litellm-keys";

  # One unit for every key, and its ExecStart embeds the name list — so
  # declaring a key changes the unit and systemd re-runs it on the
  # rebuild that declares it. Existing values are never touched: this is
  # ensure-exists, not converge, because rewriting a live key would break
  # its consumer at an unpredictable moment.
  secretsScript = pkgs.writeShellApplication {
    name = "litellm-key-secrets";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.gnugrep
    ];
    # Body at assets/virtual-keys.sh.
    text = ''
      FILE=${lib.escapeShellArg secretsFile}
      STATE_DIR=${lib.escapeShellArg stateDir}
      NAMES=(${lib.concatStringsSep " " (map secretKey (lib.attrNames cfg))})

      ${builtins.readFile ./assets/virtual-keys.sh}
    '';
  };

  # Non-secret desired state. The script does the HTTP; nix does the
  # shape — same split as the SSO client sync and the deploy oneshot.
  manifest = pkgs.writeText "litellm-keys.json" (
    builtins.toJSON (
      lib.mapAttrsToList (n: k: {
        alias = n;
        secretKey = secretKey n;
        inherit (k) models;
        # Always sent, empty lists included: this is the declaration of
        # what the key may do, so it has to be able to take a permission
        # AWAY as well as grant one. An omitted field would make the nix
        # file the source of truth for grants only, which is the half
        # that does not matter.
        objectPermission = {
          mcp_servers = k.mcpServers;
          search_tools = k.searchTools;
        };
      }) cfg
    )
  );

  syncScript = pkgs.writeShellApplication {
    name = "litellm-keys-sync";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.gnugrep
      pkgs.podman
    ];
    text = ''
      LITELLM_MASTER=$(grep '^LITELLM_MASTER_KEY=' ${
        config.sops.secrets."litellm-env".path
      } | head -1 | cut -d= -f2-)
      [ -n "$LITELLM_MASTER" ] || { echo "LITELLM_MASTER_KEY missing" >&2; exit 1; }
      LITELLM_KEYS=$(cat ${secretsFile})
      LITELLM_MANIFEST=$(cat ${manifest})
      export LITELLM_MASTER LITELLM_KEYS LITELLM_MANIFEST

      # Value-less `-e` passthroughs: the secrets come from this shell's
      # environment, so none of them appears in podman's argv. The script
      # itself rides stdin for the same reason it is not an argument —
      # `python3 -` reads it, and nothing lands on a command line.
      podman exec -i -e LITELLM_MASTER -e LITELLM_KEYS -e LITELLM_MANIFEST \
        litellm python3 - < ${./assets/sync-keys.py}
    '';
  };

  # Consumers get the key under whatever names their image reads. One
  # render per key rather than one for all of them, so a key with no
  # consumer renders nothing and a consumer restart cannot be triggered
  # by an unrelated key being declared.
  rendered = lib.filterAttrs (_: k: k.consumers != [ ] && k.consumerEnv != [ ]) cfg;
in
{
  options.fleet.litellmKeys = lib.mkOption {
    default = { };
    description = ''
      LiteLLM virtual keys, converged by `litellm-keys-sync.service`.
      The attr name IS the key alias — what the gateway's ledger, its
      metrics and the dashboard's caller list all show. The key itself
      is generated on first declaration and needs no operator step.
    '';
    type = lib.types.attrsOf (
      lib.types.submodule (
        { name, ... }:
        {
          options = {
            models = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = ''
                Published model names this key may reach. Empty means
                unrestricted, which is right for a consumer that
                legitimately uses the whole gateway (chat, embeddings,
                speech, images) and wrong for one that does not — a
                narrow list here is what stops a compromised app from
                spending the GPU on something it never needed.
              '';
              example = [ "gemma-4-12b" ];
            };
            mcpServers = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = ''
                MCP servers this key may call, by the alias they carry in
                `assets/config.yaml`. Empty is not "all" — a virtual key
                reaches NO tool server by default, and `tools/list`
                answers it with an empty array rather than an error, so
                the failure mode of forgetting this is a caller whose
                tools silently vanish. (The master key bypasses it
                entirely, which is why nothing noticed before.)
              '';
              example = [ "Grocy" ];
            };
            searchTools = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = ''
                Search tools this key may call — `searxng` is the only
                one registered here. Same default-deny as `mcpServers`.
              '';
              example = [ "searxng" ];
            };
            # There is deliberately no `passthroughRoutes` here. LiteLLM
            # does model per-key pass-through permission — the field is
            # `allowed_passthrough_routes` — but setting it answers
            # "only available for LiteLLM Enterprise users", so on this
            # deployment a pass-through route is master-key-or-nothing.
            # An option that always fails at convergence is worse than
            # its absence; the one pass-through here (`/reranking`) is
            # unauthenticated instead, argued in assets/config.yaml.
            consumers = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = ''
                Container names that present this key. Each gets
                `/run/litellm-keys/<name>-env` appended to its
                environmentFiles and is ordered after the render.
              '';
              example = [ "open-webui" ];
            };
            consumerEnv = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = ''
                Variable names the key is written under in that file. A
                list because one image routinely wants the same
                credential several times over — Open WebUI reads a
                separate one for chat, speech, transcription, embeddings
                and images.
              '';
              example = [ "OPENAI_API_KEY" ];
            };
            secretsFile = lib.mkOption {
              type = lib.types.str;
              readOnly = true;
              default = secretsFile;
              description = ''
                Read-only: the machine-generated state file holding
                every declared key. Reference this (with `envVar`) only
                from something that needs the key in a shape
                `consumerEnv` cannot express — a JSON blob with the key
                embedded, say — and order that unit after
                `litellm-key-secrets.service`.
              '';
            };
            envVar = lib.mkOption {
              type = lib.types.str;
              readOnly = true;
              default = secretKey name;
              description = "Read-only: this key's variable name inside `secretsFile`.";
            };
            envFile = lib.mkOption {
              type = lib.types.str;
              readOnly = true;
              default = "${renderDir}/${name}-env";
              description = ''
                Read-only: path of the rendered env file. It is appended
                to every `consumers` container automatically — reference
                this only when something other than a container reads it.
              '';
            };
          };
        }
      )
    );
  };

  config = lib.mkMerge [
    {
      # Keys for registry apps live here rather than in a stack module,
      # because a registry app has no module of its own — its container
      # (`app-<name>`) is declared by stacks/apps from apps.json. The
      # `litellm` flag on the app only injects LITELLM_BASE_URL; the key
      # is this declaration.
      #
      # hermes — RSS TL;DRs via the chat model only. The app defaults
      # LITELLM_MODEL to gemma-4-12b; widen `models` if that env var is
      # ever pointed elsewhere.
      fleet.litellmKeys.hermes = {
        models = [ "gemma-4-12b" ];
        consumers = [ "app-hermes" ];
        consumerEnv = [ "LITELLM_API_KEY" ];
      };
    }

    (lib.mkIf (cfg != { }) {
      fleet.statePaths = {
        ${stateDir}.mode = "0700";
        ${secretsFile} = {
          type = "f";
          mode = "0600";
        };
      };

      systemd.services = {
        litellm-key-secrets = {
          description = "Generate the virtual key for every fleet.litellmKeys entry";
          # /home is ZFS, and the renders that read this file are ordered
          # after it rather than the other way round.
          after = [ "local-fs.target" ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            Restart = "on-failure";
            RestartSec = "5s";
            ExecStart = lib.getExe secretsScript;
          };
        };

        litellm-keys-sync = {
          description = "Converge fleet.litellmKeys into the LiteLLM gateway";
          after = [
            secretsUnit
            "podman-litellm.service"
          ];
          wants = [ secretsUnit ];
          requires = [ "podman-litellm.service" ];
          wantedBy = [ "multi-user.target" ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            # The gateway answers on its own port some seconds after the
            # unit that starts it goes active — `podman run -d` returning
            # is not the API being up. Retry rather than order behind a
            # readiness probe: convergence is not on anyone's critical
            # path, so a few late attempts cost nothing and one fewer gate
            # is one fewer thing to get wrong.
            Restart = "on-failure";
            RestartSec = "20s";
            User = "santiago";
            Group = "users";
            Environment = [
              "HOME=/home/santiago"
              "XDG_RUNTIME_DIR=/run/user/1000"
            ];
            ExecStart = lib.getExe syncScript;
          };
          unitConfig = {
            StartLimitBurst = 10;
            StartLimitIntervalSec = 600;
          };
        };
      }
      // lib.mapAttrs' (
        n: k:
        lib.nameValuePair "litellm-key-${n}-render" (mkSecretRender {
          description = "Render the LiteLLM virtual key for ${n}";
          gates = map (c: "podman-${c}.service") k.consumers;
          dir = renderDir;
          file = k.envFile;
          after = [ secretsUnit ];
          wants = [ secretsUnit ];
          prep = ''
            KEY=$(grep '^${secretKey n}=' ${secretsFile} | head -1 | cut -d= -f2-)
            [ -n "$KEY" ] || { echo "${secretKey n} missing from ${secretsFile}" >&2; exit 1; }
          '';
          content = lib.concatMapStringsSep "\n" (v: "${v}=$KEY") k.consumerEnv;
        })
      ) rendered;

      # The env file reaches its consumers from here rather than from each
      # stack, so declaring a key is one edit — and so a stack never reads
      # the path back out of `config`.
      virtualisation.oci-containers.containers = lib.mkMerge (
        lib.concatLists (
          lib.mapAttrsToList (
            _: k: map (c: { ${c}.environmentFiles = [ k.envFile ]; }) k.consumers
          ) rendered
        )
      );

      # A failed convergence is silent otherwise: the consumers keep
      # working with the key they already hold, and the gateway quietly
      # does not know about the ones it should.
      fleet.monitoredJobs."litellm-keys-sync" = { };
    })
  ];
}
