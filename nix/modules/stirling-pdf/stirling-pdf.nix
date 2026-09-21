# stirling-pdf — single-container PDF toolbox.
#
# The app runs as in-container uid 1000 → a subuid on the host, so its
# writable dirs are declared uid = 1000 below. `training-data` is the one
# exception: uid 0 (→ the operator) on purpose — the operator drops tesseract
# packs in; the container only reads them.
# No secrets, no inter-container DNS, no VPN. Joins the reverse proxy's bridge
# so it is dialled at `http://stirling-pdf:8080` directly — no host port.
#
# The host brings:
#   fleet.images.stirling-pdf                the digest-pinned image (required)
#   fleet.modules.stirling-pdf.authGroups    who may log in (default: admins)

{
  config,
  lib,
  mkRootlessContainer,
  pinnedImage,
  ...
}:

let
  cfg = config.fleet.modules.stirling-pdf;
in
{
  options.fleet.modules.stirling-pdf = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Stirling PDF toolbox.";
    };

    authGroups = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "admins" ];
      description = ''
        Identity-provider groups allowed through the login gate. Policy, so
        the host's: a household that shares the toolbox adds its own group.
      '';
      example = [
        "admins"
        "household"
      ];
    };
  };

  config = lib.mkIf cfg.enable {
    fleet.bridgeMemberships.stirling-pdf = [ "traefik" ];

    fleet.statePaths = {
      "${config.fleet.stateRoot}/stirling-pdf/custom-files".uid = 1000;
      "${config.fleet.stateRoot}/stirling-pdf/extra-configs".uid = 1000;
      "${config.fleet.stateRoot}/stirling-pdf/logs".uid = 1000;
      "${config.fleet.stateRoot}/stirling-pdf/training-data" = { };
    };
    fleet.webApps.stirling-pdf = {
      serviceName = "stirling-pdf";
      port = 8080; # in-container port
      # The app's own login stays disabled (its native OIDC is a paid
      # feature); the forward-auth gate is the only auth.
      auth = "oidc";
      inherit (cfg) authGroups;
      healthPath = "/api/v1/info/status";
    };
    # Consent screen and the identity provider's My Apps page.
    fleet.ssoClients.stirling-pdf = {
      displayName = "Stirling-PDF";
      description = "PDF toolbox (split, merge, OCR)";
      logo = ./assets/stirling-pdf.png;
    };

    virtualisation.oci-containers.containers.stirling-pdf = mkRootlessContainer {
      image = pinnedImage "stirling-pdf" "docker.io/stirlingtools/stirling-pdf";

      volumes = [
        # `training-data` holds tesseract `.traineddata` packs for OCR in
        # languages beyond the image's default English. Drop new language
        # files in there and they're picked up on next start.
        "${config.fleet.stateRoot}/stirling-pdf/training-data:/usr/share/tessdata"
        "${config.fleet.stateRoot}/stirling-pdf/extra-configs:/configs"
        "${config.fleet.stateRoot}/stirling-pdf/custom-files:/customFiles/"
        "${config.fleet.stateRoot}/stirling-pdf/logs:/logs/"
      ];

      environment = {
        # Login stays off — the forward-auth gate is the auth layer.
        SECURITY_ENABLELOGIN = "false";

        # Nothing here consumes the OpenAPI spec or the Swagger console,
        # and the app warns on every start that both are on by default.
        SPRINGDOC_APIDOCS_ENABLED = "false";
        SPRINGDOC_SWAGGERUI_ENABLED = "false";
      };

    };
  };
}
