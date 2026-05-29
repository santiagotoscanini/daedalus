# Per-app declarations. Add entries here; the apps module
# (stacks/apps/apps.nix) composes container + traefik + observability
# + homepage + (optionally) postgres for each.
#
# Defaults inferred from the entry's key:
#   - image    = ghcr.io/santiagotoscanini/<name>:latest
#   - hostname = <name>.toscanini.me
#   - container = app-<name>
#   - homepage section = capitalized <name>
#
# Optional opt-ins:
#   - postgres.enable = true   → per-app postgres via stacks/app-db/
#   - stage = "live"           → public CNAME via Cloudflare tunnel
#
# Workflow:
#   1. Push the code to github.com/santiagotoscanini/<name>; CI publishes
#      `ghcr.io/santiagotoscanini/<name>:latest`.
#   2. Add an entry below; `sudo nixos-rebuild switch`.
#   3. To bump :latest in place:
#      `sudo -u santiago podman pull --authfile /etc/nixos/stacks/apps/secrets/ghcr-auth.json ghcr.io/santiagotoscanini/<name>:latest`
#      then `sudo systemctl restart podman-app-<name>.service`.

{ ... }:

{
  myStack.apps.anansi = {
    postgres.enable = true;
    stage          = "live";

    homepage = {
      description = "Anansi — task-tracking experiment";
      icon        = "mdi-spider-#f59e0b";
    };
  };
}
