#!/bin/bash
# pnpm release:ios: archives the iPhone app, exports it for App Store Connect
# and uploads it to TestFlight, for internal testers only (ADR 031).
#
# The team's App Store Connect API key comes from Infisical (project
# sondine-next, folder /desktop, as for the Mac's notarization, ADR 010):
# `pnpm release:ios` runs this script under `infisical run`. The .p8 is written
# to a private temporary file for the run and removed after.
#
#   --no-upload   archive and export an .ipa into apps/ios/.build/export, send nothing
#
# The build number is the build's date and time (yyDDDHHMM: 9 digits, always
# increasing); the app counts its 90 days from SONDINE_BUILD_TIME.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
build="$here/.build"
upload=1
for argument in "$@"; do
  case "$argument" in
    --no-upload) upload=0 ;;
    *) echo "release:ios: unknown option $argument" >&2; exit 2 ;;
  esac
done

for name in APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_API_KEY_P8; do
  if [ -z "${!name:-}" ]; then
    echo "release:ios: $name is missing. Run it as \`pnpm release:ios\`, which loads the key from Infisical." >&2
    exit 1
  fi
done

# A distribution identity in this Mac's keychain: without one, Xcode signs in
# Apple's cloud, which writes the « é » of « Téo » decomposed into the
# designated requirement, and App Store Connect refuses the upload
# (« Invalid Signature », 2026-11-12).
if ! security find-identity -v -p codesigning | grep -Eq '"(Apple|iPhone) Distribution: .*\(P5G8WAJ2G2\)"'; then
  echo "release:ios: no Apple (or iPhone) Distribution identity of team P5G8WAJ2G2 in this Mac's keychain. Run it on a Mac that has one." >&2
  exit 1
fi

if [ -n "$(git -C "$here" status --porcelain)" ]; then
  echo "release:ios: the working tree has changes; a TestFlight build is made from committed code." >&2
  exit 1
fi

secrets="$(mktemp -d)"
chmod 700 "$secrets"
trap 'rm -rf "$secrets"' EXIT
key="$secrets/AuthKey_${APPLE_API_KEY_ID}.p8"
printf '%s' "$APPLE_API_KEY_P8" | base64 --decode > "$key"
chmod 600 "$key"
auth=(
  -allowProvisioningUpdates
  -authenticationKeyPath "$key"
  -authenticationKeyID "$APPLE_API_KEY_ID"
  -authenticationKeyIssuerID "$APPLE_API_ISSUER"
)

number="$(date -u +%y%j%H%M)"
built_at="$(date -u +%s)"
archive="$build/Sondine-$number.xcarchive"
export_dir="$build/export-$number"
mkdir -p "$build"

echo "release:ios: archiving build $number"
xcodebuild archive \
  -project "$here/Sondine.xcodeproj" \
  -scheme Sondine \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$archive" \
  -derivedDataPath "$build/DerivedData-release" \
  -clonedSourcePackagesDirPath "$build/SourcePackages" \
  CURRENT_PROJECT_VERSION="$number" \
  SONDINE_BUILD_TIME="$built_at" \
  "${auth[@]}" \
  -quiet

write_options() {
  cat > "$secrets/ExportOptions-$1.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$1</string>
  <key>teamID</key><string>P5G8WAJ2G2</string>
  <key>signingStyle</key><string>automatic</string>
  <key>testFlightInternalTestingOnly</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
PLIST
}

export_as() {
  write_options "$1"
  xcodebuild -exportArchive \
    -archivePath "$archive" \
    -exportOptionsPlist "$secrets/ExportOptions-$1.plist" \
    -exportPath "$export_dir" \
    "${auth[@]}" \
    -quiet
}

echo "release:ios: exporting"
export_as export
# The signature App Store Connect checks: the app must satisfy its own designated requirement.
unpacked="$secrets/unpacked"
ditto -x -k "$export_dir/Sondine.ipa" "$unpacked"
# `codesign --verify` exits 0 even when it is not, so its words decide.
verdict="$(codesign --verify --deep --strict --verbose=4 "$unpacked/Payload/Sondine.app" 2>&1)"
if ! grep -q "satisfies its Designated Requirement" <<<"$verdict" || grep -q "does not satisfy" <<<"$verdict"; then
  echo "release:ios: the exported app does not satisfy its designated requirement; nothing sent." >&2
  echo "$verdict" >&2
  exit 1
fi
if [ "$upload" = 1 ]; then
  echo "release:ios: uploading to TestFlight"
  export_as upload
fi

version="$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleShortVersionString' "$archive/Info.plist")"
if [ "$upload" = 1 ]; then
  echo "release:ios: Sondine $version ($number) sent to App Store Connect; it reaches TestFlight once Apple has processed it."
else
  echo "release:ios: Sondine $version ($number) exported to $export_dir, nothing sent."
fi
