#!/bin/sh
# The menu bar app's menu icons: Lucide glyphs (ISC, assets/LICENSE-lucide),
# the SVGs beside this script, rendered to black-on-transparent PNGs at the
# 18 points muda sizes every menu image to — 18 px and 36 px (@2x). Their
# names end in "Template", so AppKit draws them as template images that
# follow light and dark mode (tray.rs `ICONS`). package.sh copies the PNGs
# into Contents/Resources; this regenerates them, in a throwaway container
# with rsvg-convert, after an SVG is added or changed:
#
#   agent/macos/icons/render.sh
#
# The SVGs come from lucide-static on npm (the version is in each file's
# first line); a new one is fetched the same way.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
podman run --rm -v "$here":/icons -w /icons docker.io/library/debian:bookworm-slim sh -c '
  set -eu
  apt-get update -qq >/dev/null && apt-get install -y -qq librsvg2-bin >/dev/null
  for svg in *.svg; do
    name="${svg%.svg}"
    rsvg-convert -w 18 -h 18 "$svg" -o "${name}Template.png"
    rsvg-convert -w 36 -h 36 "$svg" -o "${name}Template@2x.png"
  done
  ls *.png
'
