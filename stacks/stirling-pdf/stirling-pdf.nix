# stirling-pdf — single-container PDF toolbox.
#
# Image runs as container root by default (no USER set), which maps to
# host santiago in our rootless setup — owning the data dirs cleanly.
# No secrets, no inter-container DNS, no VPN. Joins traefik-net so
# traefik dials `http://stirling-pdf:8080` directly — no host port.

{ mkRootlessContainer, ... }:

{
  myStack.containerNetworks.stirling-pdf = "traefik";
  myStack.webApps.stirling-pdf = {
    serviceName = "stirling-pdf";
    port = 8080; # in-container port
    homepage = {
      group = "Productivity";
      name = "Stirling-PDF";
      description = "PDF toolbox (split, merge, OCR)";
      icon = "stirling-pdf.png";
      widget = {
        type = "customapi";
        # /api/v1/info/status → {"version":"2.10.1","status":"UP"}
        # Tiny but accurate: tells us the running image version and
        # that the Spring Boot app's liveness probe is green.
        url = "http://stirling-pdf:8080/api/v1/info/status";
        refreshInterval = 300000;
        mappings = [
          {
            field = "status";
            label = "Status";
            format = "text";
          }
          {
            field = "version";
            label = "Version";
            format = "text";
          }
        ];
      };
    };
  };

  virtualisation.oci-containers.containers.stirling-pdf = mkRootlessContainer {
    image = "docker.io/frooodle/s-pdf:2.14.2@sha256:7ed4d9681d18e4fbc3aa6a63647c4b5c2bcc4b75841df7c05d7e3d2320f5c9a1";

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

    extraOptions = [
      "--network=traefik-net"
    ];
  };
}
