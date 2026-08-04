# stirling-pdf — single-container PDF toolbox.
#
# The app runs as in-container uid 1000 (stirlingpdfuser) → host 100999,
# so its writable dirs are declared uid = 1000 below. `training-data` is
# the one exception: uid 0 (→ santiago) on purpose — the operator drops
# tesseract packs in; the container only reads them.
# No secrets, no inter-container DNS, no VPN. Joins traefik-net so
# traefik dials `http://stirling-pdf:8080` directly — no host port.

{ mkRootlessContainer, ... }:

{
  fleet.bridgeMemberships.stirling-pdf = [ "traefik" ];

  fleet.statePaths = {
    "/home/santiago/selfhost/stirling-pdf/custom-files".uid = 1000;
    "/home/santiago/selfhost/stirling-pdf/extra-configs".uid = 1000;
    "/home/santiago/selfhost/stirling-pdf/logs".uid = 1000;
    "/home/santiago/selfhost/stirling-pdf/training-data" = { };
  };
  fleet.webApps.stirling-pdf = {
    serviceName = "stirling-pdf";
    port = 8080; # in-container port
    # Login stays disabled (native OIDC is paywalled — AUTH.md); the
    # Pocket ID gate is the only auth. Widget dials container-direct.
    auth = "oidc";
    # Household app: santi + sofi, not admins-only.
    authGroups = [
      "admins"
      "family"
    ];
    healthPath = "/api/v1/info/status";
  };
  # Consent screen and Pocket ID's My Apps page.
  fleet.ssoClients.stirling-pdf = {
    displayName = "Stirling-PDF";
    description = "PDF toolbox (split, merge, OCR)";
  };

  virtualisation.oci-containers.containers.stirling-pdf = mkRootlessContainer {
    image = "docker.io/stirlingtools/stirling-pdf:2.14.2@sha256:926adc3a7de84019484b6e2e77060349e193da64b827e927c7b0502ed0334fff";

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
      # Login stays off — the Pocket ID forward-auth gate is the auth
      # layer, matching the rest of the fleet.
      SECURITY_ENABLELOGIN = "false";

      # Nothing here consumes the OpenAPI spec or the Swagger console,
      # and the app warns on every start that both are on by default.
      SPRINGDOC_APIDOCS_ENABLED = "false";
      SPRINGDOC_SWAGGERUI_ENABLED = "false";
    };

  };
}
