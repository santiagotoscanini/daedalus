#!/bin/sh
# The agent's gate, from a Linux box without Rust on it: fmt, clippy for
# Linux (with the GTK tray, and without it as the static service is built),
# Windows and macOS, the tests, and the static musl service, in a throwaway
# rust container. `fmt` and `all` run `cargo fmt`, which rewrites the tree;
# every mode ends with `cargo fmt --check`. Prints "GATE OK" only when every
# part passed; exits non-zero otherwise.
# Usage: agent/gate.sh [fmt|check|test|musl|all]   (default all)
#
# The Linux tray links GTK, so the container gets GTK's and AppIndicator's
# development packages (cached in /tmp/agent-apt between runs), and
# musl-tools for the static build.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
what="${1:-all}"
mkdir -p /tmp/agent-apt
exec podman run --rm -v "$here":/w -w /w \
  -v /tmp/agent-cargo:/tmp/agent-cargo -v /tmp/agent-target:/tmp/agent-target \
  -v /tmp/agent-apt:/var/cache/apt/archives \
  -e CARGO_HOME=/tmp/agent-cargo -e CARGO_TARGET_DIR=/tmp/agent-target \
  docker.io/library/rust:1-bookworm bash -c '
    set -u
    rm -f /etc/apt/apt.conf.d/docker-clean
    apt-get update -qq >/dev/null 2>&1
    apt-get install -y -qq --no-install-recommends \
      libgtk-3-dev libayatana-appindicator3-dev musl-tools file >/dev/null 2>&1 \
      || { echo "apt-get install failed"; exit 1; }
    rustup target add x86_64-pc-windows-gnu aarch64-apple-darwin x86_64-unknown-linux-musl >/dev/null 2>&1
    rustup component add clippy rustfmt >/dev/null 2>&1
    what="'"$what"'"
    failed=0
    if [ "$what" = fmt ] || [ "$what" = all ]; then cargo fmt; fi
    if [ "$what" = check ] || [ "$what" = all ]; then
      for t in "" "--no-default-features" "--target x86_64-pc-windows-gnu" "--target aarch64-apple-darwin"; do
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
    if [ "$what" = musl ] || [ "$what" = all ]; then
      echo "--- static service (x86_64-unknown-linux-musl)"
      if cargo build --release --locked --target x86_64-unknown-linux-musl \
          --no-default-features --bin daedalus-agent > /tmp/musl.log 2>&1; then
        bin=/tmp/agent-target/x86_64-unknown-linux-musl/release/daedalus-agent
        file "$bin"
        ldd "$bin" 2>&1 | head -2
        "$bin" version
      else
        failed=1
        grep -E "^(warning|error)" -A12 /tmp/musl.log | head -60
      fi
    fi
    if ! cargo fmt --check; then failed=1; fi
    if [ "$failed" = 0 ]; then echo "GATE OK"; else echo "GATE FAILED"; exit 1; fi
  '
