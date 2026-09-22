#!/bin/sh
# The agent's gate, from a Linux box without Rust on it: fmt, clippy for
# Linux, Windows and macOS, and the tests, in a throwaway rust container.
# Usage: agent/gate.sh [fmt|check|test|all]   (default all)
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
what="${1:-all}"
exec podman run --rm -v "$here":/w -w /w \
  -v /tmp/agent-cargo:/tmp/agent-cargo -v /tmp/agent-target:/tmp/agent-target \
  -e CARGO_HOME=/tmp/agent-cargo -e CARGO_TARGET_DIR=/tmp/agent-target \
  docker.io/library/rust:1-bookworm bash -c '
    set -eu
    rustup target add x86_64-pc-windows-gnu aarch64-apple-darwin >/dev/null 2>&1
    rustup component add clippy rustfmt >/dev/null 2>&1
    what="'"$what"'"
    if [ "$what" = fmt ] || [ "$what" = all ]; then cargo fmt; fi
    if [ "$what" = check ] || [ "$what" = all ]; then
      for t in "" "--target x86_64-pc-windows-gnu" "--target aarch64-apple-darwin"; do
        echo "--- clippy $t"
        cargo clippy $t --all-targets -- -D warnings 2>&1 | grep -E "^(warning|error)" -A12 | grep -v "resource not embedded" || true
      done
    fi
    if [ "$what" = test ] || [ "$what" = all ]; then cargo test 2>&1 | grep -E "test result|FAILED|panicked"; fi
    cargo fmt --check && echo "GATE OK (fmt clean)"
  '
