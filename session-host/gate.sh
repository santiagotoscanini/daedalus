#!/bin/sh
# The session host's gate, from a Linux box without Rust on it: fmt, clippy
# (-D warnings), the tests, a build on the rustc the box builds it with
# (rust-version, 1.95), and the agent interop test (interop/), in a throwaway
# rust container. Every cargo step is --locked. Prints one marker per part and
# "GATE OK" only when every part passed; exits non-zero otherwise.
# Usage: session-host/gate.sh
#
# The tests fork real shells behind real PTYs and run git, so the container's
# /tmp and PATH are theirs (sh, sleep, git are in the image).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
set +e
mkdir -p /tmp/session-host-cargo /tmp/session-host-target
# The crate, and the agent read-only: interop/ builds it as a path dependency.
# Nothing else of the repository is mounted (a save under app/ is a deploy).
podman run --rm -v "$here":/w/session-host -v "$here/../agent":/w/agent:ro -w /w/session-host \
  -v /tmp/session-host-cargo:/tmp/session-host-cargo \
  -v /tmp/session-host-target:/tmp/session-host-target \
  -e CARGO_HOME=/tmp/session-host-cargo -e CARGO_TARGET_DIR=/tmp/session-host-target \
  docker.io/library/rust:1-bookworm bash -c '
    set -u
    rustup component add clippy rustfmt >/dev/null 2>&1
    rustup toolchain install 1.95.0 --profile minimal >/dev/null 2>&1
    failed=0
    step() {
      name="$1"; shift
      echo "--- $name"
      if "$@" > /tmp/step.log 2>&1; then
        echo "GATE_${name}_OK"
      else
        failed=1
        grep -E "^(warning|error)|test result|FAILED|panicked" -A12 /tmp/step.log | head -120
        echo "GATE_${name}_FAILED"
      fi
    }
    step FMT cargo fmt --check
    step CLIPPY cargo clippy --locked --all-targets -- -D warnings
    step TEST cargo test --locked
    grep -E "test result" /tmp/step.log
    step MSRV cargo +1.95.0 build --locked --release
    cd interop
    step INTEROP_FMT cargo fmt --check
    step INTEROP_CLIPPY cargo clippy --locked --all-targets -- -D warnings
    step INTEROP_TEST cargo test --locked
    grep -E "test result" /tmp/step.log
    if [ "$failed" = 0 ]; then echo "GATE OK"; else echo "GATE FAILED"; exit 1; fi
  '
status=$?
set -e
exit $status
