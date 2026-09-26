# Operator-managed secrets for platform apps: the FILE is the switch.
#
# A tracked `site/vault/apps/<name>-env.sops` is loaded into `app-<name>`.
# There is no flag to turn it on, in the registry or anywhere else — the file
# existing is what "this app has operator secrets" means, and it is the only
# thing that can mean it. Author the file, `git add` it, and the next rebuild
# injects it.
#
# Don't add a registry boolean beside it: two facts that must agree are only
# found to disagree during an Apply. Flag without file fails `nixos-rebuild
# build` (the sops entry points at nothing) and costs a self-reverting Apply;
# file without flag is worse, because it fails silently — the app comes up
# missing every operator-supplied variable and looks healthy doing it.
# Deriving the flag from the file removes both states rather than validating
# them.
#
# WHERE the files live, and why it is an argument and not `./.`:
#
# In the site vault, because `site/` is the ONE directory daedalus writes: an
# editor that sets a single key can reach `site/vault/apps/`, and nothing
# else. So the directory cannot be derived from this file's own location, and
# `site/` is not a constant either: `fleet.site.source` is the module-side view
# of it (a store path; `fleet.site.path` is the host agents' runtime string and
# must never be read at eval). Hence `site` is PASSED IN by both consumers,
# which each hand over `config.fleet.site.source` — the one source of truth for
# where the site directory is. The `vault/apps` tail stays HERE, so the layout
# is written down once.
#
# A by-path library, not a module (never listed in a module import list —
# nix-engine.md §3). Two consumers:
#
#   modules/apps/declarations.nix  builds the sops.secrets entry + environmentFiles
#   stacks/daedalus/daedalus.nix   reports the derived truth in /export/apps.json,
#                                  where it is a fact to display, not a control to flip
#
# Both read this one directory listing, so neither can describe a different set
# of apps than the other.
#
# Only files GIT-TRACKED at eval time count: a flake evaluates from its store
# copy, which is the git tree. `fleet.site.source` is `./site` in the flake, so
# it is a path INSIDE that same store copy. That is the useful reading — an uncommitted
# `<name>-env.sops` is invisible to the build that would need it, so treating it
# as absent is what the rebuild is going to do anyway. It also means turning
# this on can no longer break an Apply: worst case the secrets are not there
# yet, which the app page shows.
#
# The directory itself is optional. A site that has never had an app secret has
# no `vault/apps/` at all, and "no operator secrets anywhere" is a legitimate
# state — it must eval, not throw.

{ lib, site }:

let
  suffix = "-env.sops";

  dir = site + "/vault/apps";

  entries = if builtins.pathExists dir then builtins.readDir dir else { };

  files = lib.filter (f: entries.${f} == "regular" && lib.hasSuffix suffix f) (lib.attrNames entries);
in
# App name → its sops file. Callers intersect with the apps they know about;
# a stray `<name>-env.sops` for an app that does not exist is inert.
lib.listToAttrs (map (f: lib.nameValuePair (lib.removeSuffix suffix f) (dir + "/${f}")) files)
