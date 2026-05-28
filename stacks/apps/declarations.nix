# Per-app declarations. Add entries here; the apps module
# (stacks/apps/apps.nix) composes supabase + container + traefik +
# observability + homepage for each.
#
# Defaults inferred from the entry's key:
#   - image    = ghcr.io/santiagotoscanini/<name>:latest
#   - hostname = <name>.toscanini.me
#   - container = app-<name>
#   - homepage section = capitalized <name>
#
# Required: `supabase.slot` (if supabase is enabled, which is the
# default). Scan existing entries below and pick the next free integer.
#
# Workflow:
#   1. Push the code to github.com/santiagotoscanini/<name>; CI publishes
#      `ghcr.io/santiagotoscanini/<name>:latest`.
#   2. Add an entry below; `sudo nixos-rebuild switch`.
#   3. Promote: flip `stage = "live"` → public CNAME materializes on
#      the next rebuild.

{ ... }:

{
  myStack.apps.anansi = {
    supabase.slot = 0;

    homepage = {
      description = "Anansi — task-tracking experiment";
      icon        = "mdi-spider-#f59e0b";
    };
  };
}
