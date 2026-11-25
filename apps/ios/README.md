# Sondine for iPhone

The iPhone companion (release 2, ADR 031): records by hand, keeps one folder
per file, and hands recordings to the Mac. The logic is `SondinePhone` in
`native/`; this folder holds the Xcode project, the SwiftUI screens, the
widget extension (the Live Activity and the control, M5.6) and their String
Catalogs. Screens: `docs/iphone-screens.md`.

```bash
pnpm test:ios                    # simulator build, UI tests (English, French), screenshots in .build/*.xcresult
pnpm release:ios                 # archive, export and upload to TestFlight (internal testers); needs a local distribution identity
pnpm release:ios --no-upload     # archive and export an .ipa into .build, send nothing
```

| Path                                                        | Content                                                                          |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `Sondine/`                                                  | The app (synchronized folder): model, screens, String Catalogs, assets           |
| `SondineWidgets/`                                           | The widget extension: the Live Activity and the control, its String Catalog      |
| `Shared/`                                                   | In both targets: the recording intent, the activity's state, the theme, the font |
| `SondineUITests/`                                           | The short UI test, on a scripted audio session and a tone (`-SondineUITest`)     |
| `Config/Info.plist`                                         | Background audio, no non-exempt encryption, local networking, the build's time   |
| `Config/*.entitlements`, `Config/SondineWidgets-Info.plist` | The keychain group the app and the extension share; the extension's point        |
| `scripts/test.sh`                                           | `pnpm test:ios`                                                                  |
| `scripts/release.sh`                                        | `pnpm release:ios`, run under `infisical run` for the App Store Connect API key  |

A debug build launched with `-SondineDemo` (and `-SondineFirstRun` for the
first run) shows invented recordings and an invented paired Mac
(`Sondine/demo-data.swift`): use it for captures, never real data. The
Mac's face, Allo, is in `Shared/Fonts` with its licence (SIL OFL).

Development builds from Xcode (`Sondine.xcodeproj`, team P5G8WAJ2G2) stay
for device measurements. A build counts its 90 TestFlight days from
`SondineBuildTime`, which the release script stamps; a development build
counts from its executable's date.
