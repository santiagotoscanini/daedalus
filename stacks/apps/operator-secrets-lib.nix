# Operator-managed secrets for platform apps: the FILE is the switch.
#
# A tracked `stacks/apps/<name>-env.sops` is loaded into `app-<name>`. There is
# no flag to turn it on, in the registry or anywhere else — the file existing is
# what "this app has operator secrets" means, and it is the only thing that can
# mean it. Author the file, `git add` it, and the next rebuild injects it.
#
# It used to be a boolean in the registry too, and that pairing was the whole
# problem: two facts that had to agree, whose disagreement was only discovered
# during an Apply. Flag without file failed `nixos-rebuild build` (the sops
# entry pointed at nothing) and cost the operator a self-reverting Apply; file
# without flag was worse, because it failed silently — the app came up missing
# every operator-supplied variable and looked healthy doing it. Deriving the
# flag from the file removes both states rather than validating them.
#
# A by-path library, not a module (see the `*-lib.nix` note in configuration.nix
# — these are excluded from the auto-import). Two consumers:
#
#   declarations.nix    builds the sops.secrets entry + environmentFiles
#   ../daedalus         reports the derived truth into the UI's nix manifest,
#                       where it is a fact to display, not a control to flip
#
# Both read this one directory listing, so neither can describe a different set
# of apps than the other.
#
# Only files GIT-TRACKED at eval time count: a flake evaluates from its store
# copy, which is the git tree. That is the useful reading — an uncommitted
# `<name>-env.sops` is invisible to the build that would need it, so treating it
# as absent is what the rebuild is going to do anyway. It also means turning
# this on can no longer break an Apply: worst case the secrets are not there
# yet, which the app page shows.

{ lib }:

let
  suffix = "-env.sops";

  entries = builtins.readDir ./.;

  files = lib.filter (
    f: entries.${f} == "regular" && lib.hasSuffix suffix f
  ) (lib.attrNames entries);
in
# App name → its sops file. Callers intersect with the apps they know about;
# a stray `<name>-env.sops` for an app that does not exist is inert.
lib.listToAttrs (
  map (f: lib.nameValuePair (lib.removeSuffix suffix f) (./. + "/${f}")) files
)
