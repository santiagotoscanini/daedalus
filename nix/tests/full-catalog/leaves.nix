# Every catalog module the template does not switch on, switched on with
# placeholder inputs. Documentation values only; a pin of all zeros evaluates
# and pulls nothing; the `*.sops` files under sops/ are placeholders too
# (sops-nix takes a path at evaluation and reads it only when it builds).
{ config, ... }:
{
  fleet = {
    modules = {
      factorio = {
        enable = true;
        version = "0.0.0";
        envSopsFile = ./sops/factorio/env.sops;
      };
      grocy.enable = true;
      intel-gpu-exporter.enable = true;
      metube = {
        enable = true;
        downloadsDir = "${config.fleet.stateRoot}/metube/downloads";
      };
      myspeed.enable = true;
      verdaccio.enable = true;
      wg-easy = {
        enable = true;
        envSopsFile = ./sops/wg-easy/env.sops;
      };
    };
    images = {
      factorio = "docker.io/ofsm/ofsm:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
      grocy = "docker.io/linuxserver/grocy:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
      intel-gpu-exporter = "ghcr.io/clambin/intel-gpu-exporter:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
      metube = "ghcr.io/alexta69/metube:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
      myspeed = "docker.io/germannewsmaker/myspeed:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
      wg-easy = "ghcr.io/wg-easy/wg-easy:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    };
  };
}
