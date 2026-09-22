{ config, lib, ... }:

# The GPU box — the one machine a fleet may talk to that it does not run.
#
# A model server (Lemonade) on another host, dialled by the AI gateway,
# probed by the uptime monitor, given a local DNS record and shown on the
# control plane's dashboard. Declared in the platform rather than by any of
# those consumers because none of them owns the machine: the log bridge,
# the gateway and the probe are each optional, and the two facts below have
# to be readable by whichever of them a host switches on.
#
# Optional on purpose. A host with no GPU box leaves `gpuHost` null and
# every consumer omits its Lemonade half — there is no default that would
# be right for a box the engine has never seen.
#
# Two flat options rather than a submodule: there is one GPU box and two
# facts about it. `platform/gpu.nix` beside this file is unrelated — that is
# the box's OWN accelerator.
{
  options.fleet.gpuHost = lib.mkOption {
    type = lib.types.nullOr lib.types.str;
    default = null;
    example = "gpu.local.example.org";
    description = ''
      DNS name of the machine running the Lemonade model server, as every
      consumer on this box dials it. Null when there is no such machine:
      the gateway's model list, the uptime probe and the dashboard's
      Lemonade tile are all conditional on it.
    '';
  };

  options.fleet.gpuHostIp = lib.mkOption {
    type = lib.types.nullOr lib.types.str;
    default = null;
    example = "10.0.0.50";
    description = ''
      LAN address the local resolver answers `fleet.gpuHost` with. Null
      when that name already resolves without a local record.
    '';
  };

  config.assertions = [
    {
      assertion = config.fleet.gpuHostIp == null || config.fleet.gpuHost != null;
      message = "fleet.gpuHostIp is set but fleet.gpuHost is null: an address needs a name to answer for.";
    }
  ];
}
