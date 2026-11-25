#!/bin/sh
# Runs `sondine-audio self-test taps` from "Sondine Tap Probe.app" (ad-hoc signed,
# app.sondine.tap-probe): process taps receive audio only once macOS has granted
# system-audio capture to the responsible app, and macOS can only ask an app.
# The first run shows the prompt; the probe waits for the grant (--wait).
#
#   native/scripts/tap-probe-app.sh <results.jsonl> [self-test taps options]
set -eu
native=$(cd "$(dirname "$0")/.." && pwd)
binary="$native/.build/release/sondine-audio"
out="${1:?usage: tap-probe-app.sh <results.jsonl> [self-test taps options]}"
shift
[ -x "$binary" ] || { echo "build first: swift build -c release --package-path native" >&2; exit 1; }
app="${TMPDIR:-/tmp}/Sondine Tap Probe.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$binary" "$app/Contents/MacOS/sondine-tap-probe"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>app.sondine.tap-probe</string>
  <key>CFBundleName</key><string>Sondine Tap Probe</string>
  <key>CFBundleExecutable</key><string>sondine-tap-probe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAudioCaptureUsageDescription</key><string>Measures what Sondine's app taps cost. Nothing is recorded or kept.</string>
</dict>
</plist>
PLIST
codesign --force --sign - --identifier app.sondine.tap-probe "$app"
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
open -W -n "$app" --args self-test taps --out "$out" "$@"
cat "$out"
