#!/bin/bash
# Makes the iPhone app's icon from the Mac's (apps/desktop/build/icon.icns,
# Sondine's logo from its first app): the macOS tile cropped to itself and
# brought to 1024 px on its own colour, opaque, as iOS wants; iOS rounds the
# corners. Nothing of the logo is redrawn.
# Usage: apps/ios/scripts/make-icon.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
iconutil -c iconset "$here/../desktop/build/icon.icns" -o "$work/icon.iconset"
swift "$here/scripts/make-icon.swift" "$work/icon.iconset/icon_512x512@2x.png" \
  "$here/Sondine/Assets.xcassets/AppIcon.appiconset/icon-1024.png"
