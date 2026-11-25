#!/bin/bash
# pnpm test:ios: builds the iPhone app for the simulator and runs its short UI
# test (ADR 031). Picks an available iPhone on the newest iOS runtime, and
# shuts it down afterwards if it was not running before.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
build="$here/.build"

udid="$(xcrun simctl list devices available -j | /usr/bin/python3 -c '
import json, sys
devices = json.load(sys.stdin)["devices"]
# A runtime made for one device (iOS-27-2-iPhone19-4, a foldable) is left out: its layout is not that of an iPhone.
runtimes = sorted((r for r in devices if ".iOS-" in r and r.split(".iOS-")[1].replace("-", "").isdigit()), key=lambda r: [int(p) for p in r.split(".iOS-")[1].split("-")])
for runtime in reversed(runtimes):
    phones = [d for d in devices[runtime] if d["name"].startswith("iPhone")]
    if phones:
        print(phones[0]["udid"], phones[0]["state"])
        break
')"
if [ -z "$udid" ]; then
  echo "test:ios: no iPhone simulator available (Xcode ▸ Settings ▸ Components)" >&2
  exit 1
fi
state="${udid#* }"
udid="${udid%% *}"

cleanup() {
  if [ "$state" = "Shutdown" ]; then xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

xcodebuild test \
  -project "$here/Sondine.xcodeproj" \
  -scheme Sondine \
  -destination "id=$udid" \
  -derivedDataPath "$build/DerivedData" \
  -clonedSourcePackagesDirPath "$build/SourcePackages" \
  -resultBundlePath "$build/test-$(date +%Y%m%d-%H%M%S).xcresult" \
  CODE_SIGNING_ALLOWED=NO \
  -quiet
echo "test:ios: passed on $(xcrun simctl list devices | grep "$udid" | sed 's/ (.*//;s/^ *//')"
