# Supabase project declarations.
#
# Each entry in `myStack.supabaseProjects.<id>` materializes the full
# Supabase stack for that project (14 containers, bridge, Traefik
# routes with a per-project wildcard cert, pi-hole DNS, firewall
# ports, Prometheus scrape, Grafana dashboard, homepage tiles). See
# modules/supabase.nix for the wrapper.
#
# Adding a project:
#   1. Append an entry below.
#   2. `sudo nixos-rebuild switch`.
# The bootstrap oneshot (supabase-<id>-bootstrap.service) auto-
# generates the env file at /etc/nixos/containers/supabase/<id>/env
# with fresh secrets, and seeds static configs (kong.yml, pooler.exs,
# vector.yml, db-init/*.sql, functions/main/index.ts) from
# /etc/nixos/modules/supabase-static/ into
# /home/santiago/selfhost/supabase/<id>/. Both are idempotent —
# re-running the rebuild after changes is safe.
#
# Suggested port allocation (per the Nth project, N=0,1,2,…):
#   kong          = 8400 + N
#   studio        = 3003 + N
#   poolerSession = 5432 + N
#   poolerTx      = 6543 + N

{ ... }:

{
  myStack.supabaseProjects.anansi = {
    id = "anansi";
    ports = {
      kong          = 8400;
      studio        = 3003;
      poolerSession = 5432;
      poolerTx      = 6543;
    };
  };
}
