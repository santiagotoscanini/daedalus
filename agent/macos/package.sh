#!/bin/sh
# Daedalus Agent.app and its disk image, from the two built binaries, with
# nothing but the tools every Mac has (no Xcode project):
#
#   agent/macos/package.sh VERSION BIN_DIR OUT_DIR
#
# BIN_DIR holds `daedalus-agent` and `daedalus-agent-tray` (universal for a
# release, whatever cargo built for a check). OUT_DIR gets:
#
#   Daedalus Agent.app                               the bundle, for the checks after
#   daedalus-agent-universal-apple-darwin.app.zip    what the updater installs (role `bundle`)
#   daedalus-agent-macos.dmg                         what a person downloads (role `installer`)
#
# Signing: with APPLE_SIGNING_IDENTITY set, Developer ID with the hardened
# runtime and a timestamp — the service with its fixed identifier
# (me.toscanini.daedalus-agent), then the bundle (its Info.plist's,
# me.toscanini.daedalus-agent-tray), which the updater's fence and launchd's
# records both key on; without it, ad hoc (a check's build: it runs, and
# `codesign --verify` holds). With APPLE_API_KEY_PATH, APPLE_API_KEY_ID and
# APPLE_API_ISSUER set too, the app is notarized and stapled before it is
# zipped and put in the disk image, and the disk image is signed, notarized
# and stapled itself: two notarizations, each required to come back
# "Accepted".
#
# The window: dmg-background.png (its source is dmg-background.html) at 660 x
# 400 points, the app at (165, 190) and the Applications link at (495, 190),
# laid out by Finder over AppleScript on a writable image, then compressed.
set -eu

[ $# -eq 3 ] || { echo "usage: $0 VERSION BIN_DIR OUT_DIR" >&2; exit 2; }
version="$1"
bin="$2"
out="$3"
here="$(cd "$(dirname "$0")" && pwd)"
name="Daedalus Agent"
app="$out/$name.app"
zip="$out/daedalus-agent-universal-apple-darwin.app.zip"
dmg="$out/daedalus-agent-macos.dmg"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

notarizing=false
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ] && [ -n "${APPLE_API_KEY_PATH:-}" ]; then
  notarizing=true
fi

# ── the bundle ────────────────────────────────────────────────────────────
rm -rf "$app" "$zip" "$dmg"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
for exe in daedalus-agent daedalus-agent-tray; do
  cp "$bin/$exe" "$app/Contents/MacOS/$exe"
  chmod 755 "$app/Contents/MacOS/$exe"
done
sed "s/@VERSION@/$version/g" "$here/Info.plist.in" > "$app/Contents/Info.plist"
plutil -lint "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"

iconset="$work/AppIcon.iconset"
mkdir "$iconset"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$here/AppIcon-1024.png" --out "$iconset/icon_${s}x${s}.png" > /dev/null
  d=$((s * 2))
  sips -z "$d" "$d" "$here/AppIcon-1024.png" --out "$iconset/icon_${s}x${s}@2x.png" > /dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"

# ── signing ───────────────────────────────────────────────────────────────
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  identity="$APPLE_SIGNING_IDENTITY"
  stamp="--timestamp"
else
  echo "no APPLE_SIGNING_IDENTITY: signing ad hoc"
  identity="-"
  stamp="--timestamp=none"
fi
codesign --force --options runtime "$stamp" --identifier me.toscanini.daedalus-agent \
  --sign "$identity" "$app/Contents/MacOS/daedalus-agent"
codesign --force --options runtime "$stamp" --sign "$identity" "$app"
codesign --verify --deep --strict --verbose=2 "$app"

# notarize FILE: submitted with the App Store Connect key and waited for;
# anything but "Accepted" prints Apple's log and fails.
notarize() {
  result="$(xcrun notarytool submit "$1" --wait --output-format json \
    --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")" || true
  printf '%s\n' "$result"
  status="$(printf '%s' "$result" | plutil -extract status raw -o - - 2>/dev/null || echo none)"
  id="$(printf '%s' "$result" | plutil -extract id raw -o - - 2>/dev/null || echo none)"
  if [ "$status" != Accepted ]; then
    xcrun notarytool log "$id" \
      --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" || true
    echo "notarization of $(basename "$1"): $status" >&2
    exit 1
  fi
  echo "notarization of $(basename "$1"): Accepted ($id)"
}

if $notarizing; then
  ditto -c -k --keepParent "$app" "$work/notarize.zip"
  notarize "$work/notarize.zip"
  xcrun stapler staple "$app"
fi
# The updater's asset: the bundle as it will sit on disk, ticket and all.
ditto -c -k --keepParent "$app" "$zip"

# ── the disk image ────────────────────────────────────────────────────────
src="$work/image"
mkdir -p "$src/.background"
ditto "$app" "$src/$name.app"
ln -s /Applications "$src/Applications"
sips -s dpiWidth 144 -s dpiHeight 144 "$here/dmg-background.png" \
  --out "$src/.background/background.png" > /dev/null

rw="$work/rw.dmg"
size_mb=$(( $(du -sm "$src" | cut -f1) + 20 ))
hdiutil create -volname "$name" -srcfolder "$src" -fs HFS+ -format UDRW \
  -size "${size_mb}m" -ov "$rw" > /dev/null
hdiutil attach -readwrite -noverify -noautoopen "$rw" > /dev/null
[ -d "/Volumes/$name" ] || { echo "the image did not mount at /Volumes/$name" >&2; exit 1; }
osascript <<EOF
with timeout of 120 seconds
  tell application "Finder"
    tell disk "$name"
      open
      set current view of container window to icon view
      set toolbar visible of container window to false
      set statusbar visible of container window to false
      set the bounds of container window to {200, 120, 860, 520}
      set opts to the icon view options of container window
      set arrangement of opts to not arranged
      set icon size of opts to 128
      set text size of opts to 13
      set background picture of opts to file ".background:background.png"
      set position of item "$name.app" of container window to {165, 190}
      set position of item "Applications" of container window to {495, 190}
      close
      open
      update without registering applications
      delay 2
      close
    end tell
  end tell
end timeout
EOF
[ -f "/Volumes/$name/.DS_Store" ] || { echo "Finder wrote no layout (.DS_Store)" >&2; exit 1; }
sync
hdiutil detach "/Volumes/$name" > /dev/null
hdiutil convert "$rw" -format UDZO -imagekey zlib-level=9 -o "$dmg" > /dev/null

if [ "$identity" != "-" ]; then
  codesign --force --timestamp --sign "$identity" "$dmg"
  codesign --verify --strict --verbose=2 "$dmg"
fi
if $notarizing; then
  notarize "$dmg"
  xcrun stapler staple "$dmg"
fi
hdiutil verify "$dmg" > /dev/null
echo "packaged $version: $zip, $dmg"
