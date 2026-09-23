{ config, lib, ... }:

# The nodes — the other machines on this network that run the agent, as the
# nix side sees them.
#
# A node joins by approval on the control plane and lives in its database:
# identity, key, address, what its agent last said. What NIX needs of a node
# is much less, and it is data the operator can read in a diff: which
# machines exist, what each is called, what each offers (a model server on a
# port). That subset is `site/nodes.json`, written by an Apply like
# `apps.json`, read by platform/site.nix into `fleet.nodes`, and consumed by
# whichever stacks care — the AI gateway dials a node's model server, the
# uptime monitor probes it, the log bridge scrapes it. None of those owns
# the machine, which is why the option is the platform's.
#
# No MAC address and no IP address in it, on purpose. A device inventory is
# not for a git history, private or not (the household's DHCP reservations
# are sops ciphertext for the same reason), and an address that the DHCP
# pool hands out is not a fact to pin in a rebuild. The name is enough: the
# control plane writes the node's MAC-to-name binding to a runtime file the
# resolver reads (stacks/daedalus: `nodes/dhcp-hosts`, copied under
# /run/daedalus-nodes and picked up by dnsmasq's `dhcp-hostsdir`), so the
# lease gets the node's name whatever address it draws, and every consumer
# dials `<name>.<lanDomain>`.
#
# `fleet.lanDomain` is declared here rather than in the resolver's module
# because a node's LAN name is composed by consumers that may run on a host
# whose resolver is something else; the pihole module defaults its own
# `localDomain` to it.

let
  cfg = config.fleet;

  # A DNS label, as the control plane validates a node's name: lowercase,
  # digits, inner hyphens, at most 32 characters.
  isLabel = s: builtins.match "[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?" s != null;

  names = map (n: n.name) cfg.nodes;
  duplicates = lib.filter (n: lib.count (m: m == n) names > 1) (lib.unique names);
in
{
  options.fleet = {
    lanDomain = lib.mkOption {
      type = lib.types.str;
      default = "lan";
      description = ''
        The LAN's own DNS domain: every DHCP lease and reservation answers
        as `<hostname>.<lanDomain>`, and a node's LAN name is
        `<name>.<lanDomain>`. The resolver module (pihole) serves it; a host
        with another resolver sets this to whatever that one serves.
      '';
    };

    nodes = lib.mkOption {
      type = lib.types.listOf (
        lib.types.submodule {
          options = {
            id = lib.mkOption {
              type = lib.types.str;
              description = "The node's id, as the control plane assigned it at enrolment.";
            };
            name = lib.mkOption {
              type = lib.types.str;
              example = "gpu-box";
              description = "The node's name on the network: a DNS label, unique among the nodes. `<name>.<lanDomain>` is how the box dials it.";
            };
            os = lib.mkOption {
              type = lib.types.enum [
                "windows"
                "macos"
                "linux"
              ];
              description = "What the node runs, as its agent reported.";
            };
            providers = lib.mkOption {
              type = lib.types.attrsOf (
                lib.types.submodule {
                  options.port = lib.mkOption {
                    type = lib.types.port;
                    description = "The port the provider listens on, reachable from this box.";
                  };
                }
              );
              default = { };
              example = {
                lemonade.port = 13305;
              };
              description = ''
                What the node offers the cluster, by kind (`lemonade`, an
                OpenAI-compatible model server), with only what a consumer
                needs to dial it. A provider absent here is one the operator
                chose not to offer, whatever the machine runs.
              '';
            };
          };
        }
      );
      default = [ ];
      description = ''
        The approved nodes, from `site/nodes.json` (platform/site.nix). What
        nix needs of a machine that runs the agent, and nothing more.
      '';
    };

    # Read-only views for the consumers, so each does not re-derive the
    # naming rule.
    nodeHost = lib.mkOption {
      type = lib.types.functionTo lib.types.str;
      readOnly = true;
      default = node: "${node.name}.${cfg.lanDomain}";
      description = "A node's LAN name: `<name>.<lanDomain>`.";
    };
    lemonadeNodes = lib.mkOption {
      type = lib.types.listOf lib.types.attrs;
      readOnly = true;
      default = lib.filter (n: n.providers ? lemonade) cfg.nodes;
      description = "The nodes that offer a Lemonade model server.";
    };
  };

  # The domain the app must not guess. Every synced LiteLLM route, and the
  # name Settings › Machines shows, is `<node>.<lanDomain>` — so a host that
  # sets this to anything but the default would otherwise have daedalus
  # writing routes to a hostname that does not exist. Contributed here, where
  # the option is declared, rather than from the resolver: a box can carry
  # nodes without running pi-hole.
  config.fleet.export.domains.network.data.lanDomain = cfg.lanDomain;
  config.assertions = [
    {
      assertion = duplicates == [ ];
      message = "fleet.nodes: two nodes share the name ${builtins.toJSON duplicates}; a node's name is its address on the network and must be unique.";
    }
    {
      assertion = lib.all isLabel names;
      message = "fleet.nodes: a node's name must be a DNS label (lowercase letters, digits, inner hyphens, at most 32 characters); got ${
        builtins.toJSON (lib.filter (n: !isLabel n) names)
      }.";
    }
  ];
}
