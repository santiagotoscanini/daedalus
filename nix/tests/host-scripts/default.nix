# The host agents (nix/stacks/daedalus/host/*.sh) run for real, in the build
# sandbox, against temp git repositories. test.sh has the cases.
{ pkgs }:
pkgs.runCommand "host-scripts"
  {
    nativeBuildInputs = [
      pkgs.bash
      pkgs.coreutils
      pkgs.findutils
      pkgs.gawk
      pkgs.git
      pkgs.gnugrep
      pkgs.jq
      pkgs.util-linux
    ];
    HOST = ../../stacks/daedalus/host;
  }
  ''
    bash ${./test.sh}
    touch $out
  ''
