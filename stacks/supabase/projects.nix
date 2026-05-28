# Supabase project declarations — vestigial after the apps wrapper.
#
# Apps now flow in through `myStack.apps.<name>` (see
# stacks/apps/declarations.nix). The apps wrapper sets
# `myStack.supabaseProjects.<name>` for each entry, which the supabase
# wrapper picks up and materializes the same way it always did.
#
# This file is the place to declare a Supabase project that is NOT
# backed by a `myStack.apps.*` entry (e.g. a backend used only from
# the LAN by external tooling, no companion container). Such cases
# should be rare — prefer the apps wrapper.
#
# Slot allocation: see stacks/apps/declarations.nix for the canonical
# list. Picking the same slot used there will fail the build (pooler
# port collision).

{ ... }:

{
  # Intentionally empty. Add a standalone Supabase project here only
  # when the apps wrapper doesn't fit.
  #
  # Example:
  # myStack.supabaseProjects.standalone = {
  #   id   = "standalone";
  #   slot = 99;
  # };
}
