#!/bin/sh
# The agent's gate, from a Linux box without Rust on it: fmt, clippy for
# Linux, Windows and macOS, and the tests, in a throwaway rust container.
# Prints "GATE OK" only when every part passed; exits non-zero otherwise.
# Usage: agent/gate.sh [fmt|check|test|all]   (default all)
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
what="${1:-all}"
exec podman run --rm -v "$here":/w -w /w \
  -v /tmp/agent-cargo:/tmp/agent-cargo -v /tmp/agent-target:/tmp/agent-target \
  -e CARGO_HOME=/tmp/agent-cargo -e CARGO_TARGET_DIR=/tmp/agent-target \
  docker.io/library/rust:1-bookworm bash -c '
    set -u
    rustup target add x86_64-pc-windows-gnu aarch64-apple-darwin >/dev/null 2>&1
    rustup component add clippy rustfmt >/dev/null 2>&1
    what="'"$what"'"
    failed=0
    if [ "$what" = fmt ] || [ "$what" = all ]; then cargo fmt; fi
    if [ "$what" = check ] || [ "$what" = all ]; then
      for t in "" "--target x86_64-pc-windows-gnu" "--target aarch64-apple-darwin"; do
        echo "--- clippy $t"
        if ! cargo clippy $t --all-targets -- -D warnings > /tmp/clippy.log 2>&1; then
          failed=1
          grep -E "^(warning|error)" -A12 /tmp/clippy.log | grep -v "resource not embedded" | head -80
        fi
      done
    fi
    if [ "$what" = test ] || [ "$what" = all ]; then
      if ! cargo test > /tmp/test.log 2>&1; then failed=1; fi
      grep -E "test result|FAILED|panicked" /tmp/test.log
    fi
    if ! cargo fmt --check; then failed=1; fi
    if [ "$failed" = 0 ]; then echo "GATE OK"; else echo "GATE FAILED"; exit 1; fi
  '
