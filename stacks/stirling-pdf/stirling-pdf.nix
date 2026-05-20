# stirling-pdf — single-container PDF toolbox.
#
# Image runs as container root by default (no USER set), which maps to
# host santiago in our rootless setup — owning the data dirs cleanly.
# No secrets, no inter-container DNS, no VPN; standalone pasta.

{ mkRootlessContainer, ... }:

{
  myStack.containerNetworks.stirling-pdf = null;
  myStack.webApps.stirling-pdf = {
    hostname = "stirling-pdf.toscanini.me";
    port = 8083;
  };

  myStack.homepageServices."Productivity" = [{
    name = "Stirling-PDF";
    href = "https://stirling-pdf.toscanini.me";
    description = "PDF toolbox (split, merge, OCR)";
    icon = "stirling-pdf.png";
    siteMonitor = "http://host.containers.internal:8083";
  }];

  virtualisation.oci-containers.containers.stirling-pdf = mkRootlessContainer {
    image = "docker.io/frooodle/s-pdf:latest";

    ports = [ "8083:8080" ];

    volumes = [
      # `training-data` holds tesseract `.traineddata` packs for OCR in
      # languages beyond the image's default English. Drop new language
      # files in there and they're picked up on next start.
      "/home/santiago/selfhost/stirling-pdf/training-data:/usr/share/tessdata"
      "/home/santiago/selfhost/stirling-pdf/extra-configs:/configs"
      "/home/santiago/selfhost/stirling-pdf/custom-files:/customFiles/"
      "/home/santiago/selfhost/stirling-pdf/logs:/logs/"
    ];

    environment = {
      DOCKER_ENABLE_SECURITY = "false";
      INSTALL_BOOK_AND_ADVANCED_HTML_OPS = "false";
    };
  };
}
