# Every catalog module the template does not switch on, switched on with
# placeholder inputs. Documentation values only; a pin of all zeros evaluates
# and pulls nothing.
{ config, ... }:
{
  fleet = {
    modules = {
      grocy.enable = true;
      intel-gpu-exporter.enable = true;
      metube = {
        enable = true;
        downloadsDir = "${config.fleet.stateRoot}/metube/downloads";
      };
      myspeed.enable = true;
      verdaccio.enable = true;
    };
    images = {
      grocy = "docker.io/linuxserver/grocy:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
      intel-gpu-exporter = "ghcr.io/clambin/intel-gpu-exporter:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
      metube = "ghcr.io/alexta69/metube:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
      myspeed = "docker.io/germannewsmaker/myspeed:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    };
  };
}
