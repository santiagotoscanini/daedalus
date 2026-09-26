# The host: what this machine IS. The engine (the `daedalus` flake input, in
# flake.nix) brings every module; this tree brings the definitions the engine
# leaves to a host — its hardware, its identity, which catalog modules it runs,
# their image pins, its secrets — and the site directory the control plane
# writes.
#
# Layout:
#   hardware-configuration.nix   nixos-generate-config's output (replace ours)
#   host/identity.nix            who operates the box and where its config lives
#   host/modules.nix             which catalog modules are on, and their policy
#   host/images.nix              the digest pin of every container those run
#   host/secrets.nix             the encrypted files engine modules read
#   host/storage.nix             bulk-data roots, and the ZFS table if any
#   site/                        site.json, apps.json, nodes.json, vault/ — the
#                                control plane's own directory; edited from its UI
{ config, ... }:
{
  imports = [
    ./hardware-configuration.nix
    ./host/identity.nix
    ./host/images.nix
    ./host/modules.nix
    ./host/secrets.nix
    ./host/storage.nix
  ];

  # The site directory, read at evaluation: the constants every module shares
  # (domain, addresses, mail, Cloudflare ids) come from site/site.json, the
  # app registry from site/apps.json, the approved nodes from site/nodes.json.
  fleet.site.source = ./site;

  # The operator's account. The engine declares who that is (host/identity.nix)
  # and hands the containers, the state tree and the checkout to them; the
  # account itself is the host's to create.
  users.users.${config.fleet.operator.user} = {
    inherit (config.fleet.operator) uid;
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    # Rootless containers outlive the login session.
    linger = true;
  };

  # `identity.hostname` in site/site.json must match (asserted).
  networking.hostName = "box";

  # NixOS's compatibility anchor: the release this host was first installed
  # with. Never bump it on an existing box.
  system.stateVersion = "25.11";
}
