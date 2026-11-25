# 031 — iPhone app: SwiftUI, in this repository, through TestFlight

Status: Accepted — 2026-11-10 (Téo: « ok go » for SwiftUI, « j'aimerais
faire le testflight direct », iOS 27 only). Step M5.1 built 2026-11-11
(below, « Built at M5.1 »); step M5.6 built 2026-11-13 (« Built at M5.6 »). Amends ADR 001 (the
« Mobile » row) and replaces the stack lines of the first ADR 008.

## Context

ADR 001 and the first ADR 008 chose Expo, with « a SwiftUI app reusing the
Swift package » to reconsider at M5 « if the native modules dominate the
work ». Téo's handbook says: React Native by default, native code when a
platform API is missing or much simpler natively.

What the app is made of (ADR 008, ADR 032): a recorder that runs for hours
with the screen locked and survives a kill; interruption handling; a file
store; Bonjour; uploads over TLS pinned to a self-signed key; the Keychain;
a QR scan; later a Live Activity and a control for the Lock Screen, Control
Center and the Action button. The screens are few: a record button, a list,
a transcript, a search field, settings.

## Measured (2026-11-10)

Expo, checked on npm and docs.expo.dev that day: stable SDK 58 (`expo`
58.0.23 of 2026-11-03, React Native 0.88, minimum iOS 16.4, Xcode 26.4+).

| Need                                   | In Expo SDK 58                                                                                                                                                                               | In Swift                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Hours of recording, safe against kills | `expo-audio` 58.0.11 wraps `AVAudioRecorder`: an ordinary m4a, unreadable after a kill (measured, ADR 032); no file rotation. A Swift module of ours.                                        | `AVAssetWriter`, fragmented file             |
| Interruptions (a call, another app)    | No interruption event reaches JavaScript for recorders (source read). A Swift module of ours.                                                                                                | `AVAudioSession` notifications               |
| TLS pinned to a self-signed key        | No server-trust hook in React Native's fetch, `expo/fetch` or `expo-file-system`; `react-native-ssl-public-key-pinning` (TrustKit) pins on top of system validation. A Swift module of ours. | `URLSession` delegate                        |
| Bonjour                                | `react-native-zeroconf` 0.17.7 (legacy architecture) or 1.0.0-rc.3; or our own module.                                                                                                       | `NWBrowser`                                  |
| Control and Action button              | A Swift target outside React Native (`@bacons/apple-targets` 5.0.0, whose README calls much of it untested); the recorder must run with no JavaScript loaded.                                | `AppIntents`, `ControlWidget`                |
| Live Activity                          | `expo-widgets` 58.0.27                                                                                                                                                                       | `ActivityKit` (SwiftUI in both cases)        |
| Keychain, QR scan                      | `expo-secure-store` 58.0.2, `expo-camera` 58.0.14                                                                                                                                            | Security framework, VisionKit's data scanner |

What each choice reuses from this repository:

| From the repository            | Expo                                                                     | SwiftUI                                                                         |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `packages/api` (oRPC contract) | Types and client as they are (oRPC documents an Expo adapter)            | Codable types written by hand, tested against fixtures generated from it        |
| `packages/protocol`            | zod schemas as they are                                                  | The existing pattern: JSON Schema and golden fixtures tested by both sides      |
| `packages/ui`                  | No: Base UI and Tailwind components are for the DOM. Tokens only         | No. Tokens only                                                                 |
| Paraglide messages (fr, en)    | Not established: Paraglide ships no Metro support (package read)         | No: a String Catalog, same words                                                |
| `native/` Swift package        | Only inside the Swift modules                                            | `SondineKit` builds for iOS unchanged (3,793 lines, Xcode 27.2, throwaway copy) |
| Toolchain                      | Expo's template pins TypeScript 6.0.3; the repository is on TypeScript 7 | Swift 6.4 and Swift Testing, already here (`pnpm test:native`)                  |

In Expo, everything that can fail in the field would still be Swift written
here, plus the bridge to it, config plugins and a second target. What Expo
would save is the screens, which are the small part.

## Decision

- **A native SwiftUI app, iPhone only, iOS 27 only**, as the Mac targets
  macOS 27 only (vision: few machines, tested). Swift 6.4, strict
  concurrency.
- **No third-party dependency to start**: AVFoundation, Network.framework,
  `URLSession`, CryptoKit, Security, ActivityKit, AppIntents, VisionKit. A
  dependency needs the same scrutiny as on the Mac (ADR 002: nothing that
  phones home).
- **Where it lives.**
  - `apps/ios/`: the Xcode project, kept thin: the app target (entry point,
    SwiftUI views, the String Catalog) and, at step M5.6, the widget
    extension. Synchronized folders, so adding a file does not edit the
    project.
  - `native/`: the logic, as library targets of the existing package, which
    gains `.iOS(.v27)`: `SondinePhone` (recorder, recording store, sync
    client, pairing) on top of `SondineKit`. What touches iOS-only API
    (`AVAudioSession`, ActivityKit) sits behind a protocol with a scripted
    fake, as the HAL does. The macOS-only targets stay out of the app's
    dependency graph. If one package for both platforms fights Xcode,
    `SondineKit` and `SondinePhone` move to a package of their own; the
    sources do not change.
  - `packages/protocol` and `packages/api`: the wire formats and
    procedures, with fixtures both sides test (ADR 008).
- **Bundle identifier** `app.sondine.ios`, team P5G8WAJ2G2; an app group
  only between the app and its widget extension (a keychain group since
  M5.6, « Built at M5.6 »).
- **Interface.** GUI.md applies. SF Symbols for icons, the system's
  own: ADR 009's rule and the committed Nucleo subset concern the web
  interface (`packages/ui`), which the phone does not use. French and English from the first screen, in a String
  Catalog, with the Mac's words for the same things (« Aujourd'hui »,
  « Qui est-ce ? », « Supprimer… »).
- **Logs** carry no name, no path, no word of a transcript, as core's.
- **Distribution: TestFlight from the first step**, internal testers only
  (App Store Connect users of the team: Apple's review applies to builds
  for external testers).
  - `pnpm release:ios` archives, exports and uploads with the App Store
    Connect API key already in Infisical for notarization (ADR 010).
  - A TestFlight build stops opening 90 days after its upload. The app
    counts from its build date, which `pnpm release:ios` uploads within
    minutes, so it is never late: it says in Settings when it expires and
    shows a line on the home screen in the last 14 days. An update keeps
    the recordings that wait.
  - App Transport Security keeps its defaults but for local networking
    (`NSAllowsLocalNetworking`); what the Tailscale path needs is found
    and written down at M5.5, never a blanket exception.
  - `ITSAppUsesNonExemptEncryption` is false: only the system's TLS.
  - Development builds from Xcode stay, for device measurements.
- **Tests.**
  - Swift Testing in `native/`, run on the Mac by `pnpm test:native`: the
    recorder on a scripted audio session (interruptions, kills, a full
    disk), the store, the header and every wire fixture.
  - On the Mac, with no phone: the Swift sync client against a real core
    and `sondine-lan` over loopback (development builds accept it):
    pairing, resume, duplicates, revocation, deletion both ways.
  - `pnpm test:ios` builds the app for the simulator and runs a short UI
    test. Neither it nor `pnpm test:native` is part of `pnpm check`; each
    step of M5 is done when all three pass and its note is in `changes/`.
  - On Téo's iPhone, recorded in `bench/results/`: battery, interruptions,
    packet captures (plan, M5).

## Consequences

- TestFlight is Apple's channel. App Store Connect shows the developer
  « the number of sessions and crashes » of a beta build: iOS reports them,
  not Sondine, and they hold no audio and no text as long as logs hold
  none. Téo is the developer and the tester. Sondine itself still sends
  nothing (ADR 002), which the packet captures of M5 check.
- A build must be uploaded at least every 90 days, or the app stops
  opening until the next one is installed.
- Screens and translations exist twice, for the Mac and for the phone. They
  would mostly have with Expo too.
- Android would be another app. It is a non-goal (vision).
- The App Store is outside M5. It needs a review under guideline 2.5.14
  (consent and a clear indication when recording), privacy labels, and a
  decision on the licence: App Store terms and the AGPL do not sit together
  unless the copyright holders grant it, which Téo can do alone only while
  he is the sole author.

## Built at M5.1 (2026-11-11)

Decided while building, without Téo; each can be overturned.

- `SondinePhone` depends on no other target: M5.1 needs nothing from
  `SondineKit`. It joins when the sync client needs it.
- `apps/ios/Sondine.xcodeproj` uses synchronized folders and the local
  package `../../native`; `Config/Info.plist` holds what build settings
  cannot (`UIBackgroundModes` audio, `ITSAppUsesNonExemptEncryption`,
  `NSAllowsLocalNetworking`, `SondineBuildTime`).
- The interface uses the Mac's tokens (colours, spacing, corners, type
  steps) in `theme.swift`, with the system font: the Mac's font file is
  WOFF2 for the web window.
- Strings: `Localizable.xcstrings` and `InfoPlist.xcstrings`, English as the
  source and French, with the Mac's words where they exist.
- The first run asks for notifications with the microphone, on its last
  page: « Enregistrement interrompu » needs them.
- The app icon is Sondine's logo, the Mac app's (`apps/desktop/build/icon.icns`),
  at Téo's request on 2026-11-12 (« reprend mon logo »):
  `apps/ios/scripts/make-icon.sh` crops the macOS tile to itself and brings
  it to 1024 px, opaque, on the tile's own colour; iOS rounds the corners.
  One image for every appearance: the logo already sits on a dark tile, and
  a separate dark or tinted variant would mean cutting the mark out of it,
  which redraws it. iOS tints that image itself.
- `pnpm release:ios` runs under `infisical run --path /desktop` (the same
  key as notarization), refuses a working tree with changes, numbers the
  build `yyDDDHHMM` (UTC, 9 digits, always increasing, within the header's
  limit), stamps `SondineBuildTime`, exports with `testFlightInternalTestingOnly`
  and uploads. `--no-upload` stops at the `.ipa`.
- 2026-11-12, with Téo's yes: `app.sondine.ios` is registered for the team
  (named « Sondine », through the API), and `pnpm release:ios --no-upload`
  archives and exports an `.ipa` signed « Apple Distribution: Téo Goulois
  (P5G8WAJ2G2) ». The App Store Connect API cannot create an app (`apps`
  allows no `CREATE`): Téo made the app record by hand (« Sondine »,
  French, SKU `sondine-ios`, Apple ID 6833828045).
- The first upload from a second Mac was refused (« Invalid Signature »):
  with no distribution identity in its keychain, Xcode signs in Apple's
  cloud, and that signature writes the « é » of « Téo » decomposed (NFD) in
  the designated requirement, which the certificate's precomposed name then
  fails. The same archive, exported on the main Mac with its local « iPhone
  Distribution » identity, satisfies its requirement and was uploaded:
  0.1.0 (263160751), 2026-11-12. `pnpm release:ios` now refuses a Mac
  without a local distribution identity of the team, and checks the
  exported app's designated requirement before sending anything.
- Internal testing: one internal group, « Téo », with access to every
  build, made through the API; no external group, nothing submitted for
  review.
- `pnpm test:ios` picks an available iPhone simulator on the newest iOS
  runtime, runs both UI tests (English, and French with screenshots kept in
  the `.xcresult`), and shuts the simulator down if it started it. The UI
  test runs the app on the scripted audio session and a tone
  (`-SondineUITest`).
- iOS 27 deprecates `AVAssetWriterInput`'s `append` and
  `isReadyForMoreMediaData` for an input receiver API, and the engine's
  `installTap`. They still work; the recorder keeps them until the device
  measurements of M5.1 exist, then moves.

## Built at M5.6 (2026-11-13)

Decided while building, without Téo; each can be overturned.

- **The widget extension** `SondineWidgets` (`app.sondine.ios.widgets`) is a
  synchronized folder like the app's. It draws the Live Activity and the
  control and records nothing. `apps/ios/Shared` is compiled into both
  targets: the intent, the activity's attributes, the shared state and the
  theme. The extension links `SondinePhone` for the types they share.
- **One intent**, `SetRecordingIntent`, behind every gesture made outside
  the app: the control and the Live Activity's « Arrêter » and
  « Reprendre ». It is a `SetValueIntent`, an `AudioRecordingIntent` and a
  `LiveActivityIntent`. Through `allowedExecutionTargets = [.main]` (new in
  iOS 27) it always runs in the app's process, which records. It takes
  `supportedModes = [.background, .foreground(.dynamic)]` and
  `authenticationPolicy = .alwaysAllowed`, so the locked phone needs no
  unlock. Its logic (`RecordingControl` in `SondinePhone`, tested) goes
  through the recorder's own start, resume and stop. On a refusal only the
  app can get past (iOS's background block, a microphone not allowed yet),
  it calls `continueInForeground` and starts in the app. When the app
  cannot come to the front, a notification gives the reason and the
  intent throws it, so the gesture never fails silently. What iOS 27 does on
  the iPhone (in place, or the app opened) is an exit item to record.
- **The control's state lives in a keychain group, not an app group.**
  With the App Store Connect key, Xcode's provisioning answers
  « Authentication failed » as soon as an entitlement names an app group,
  and the API has no app group resource (`/v1/appGroups` answers 404). So
  an app group would have needed Téo in the developer portal before any
  build could archive. Every profile of the team allows the keychain
  groups `P5G8WAJ2G2.*` with no registration. The app lists its own group
  (`app.sondine.ios`) first, so its other items, the Mac's credentials
  among them, stay out of the shared group (`app.sondine.ios.shared`). The
  extension holds only the shared group. The item is readable after the
  first unlock, on this device only.
- `app.sondine.ios.widgets` was registered by Xcode itself at the first
  archive, with its store profile (named « XC app sondine ios widgets »).
  `pnpm release:ios --no-upload` exports both bundles signed « iPhone
  Distribution », and the release script needed no change.
- **The control is a toggle** whose state the app writes when recording
  starts or stops, then every 2 minutes while it records. The extension
  believes a « recording » state for 5 minutes only, so a killed app does
  not leave the control on. An interrupted session counts as off: turning
  it on resumes it.
- **The Live Activity** counts with `Text(timerInterval:)` from « now less
  what was recorded », so iOS draws every second and the counter agrees
  with the app after an interruption. The app updates the activity at each
  change, when the counter drifts by more than 2 s, and every 2 minutes,
  each time moving its stale date 5 minutes on. If the app is killed, the
  Lock Screen then says Sondine no longer answers. An interrupted activity
  has no stale date, since nothing is expected from the app then: a long
  interruption keeps showing « Interrompu à 14:32 », not a false warning.
  The activity, the plan of its updates and the 8 hour rule sit behind
  protocols in `SondinePhone` (`RecordingPresence`, `LiveActivityPlan`),
  tested with an injected clock.
- Starting an activity requests the new one first, then ends any other: the
  one it replaces at 8 hours, or one a killed run left. At launch the app
  also ends an activity a killed run left, unless a gesture has already
  started a recording.
- **The device id has its own file**, `device-id`, readable from the first
  unlock after a restart (`completeUntilFirstUserAuthentication`), beside
  `device.json`, which stays « complete ». Before this, a cold launch from
  the Lock Screen could not read `device.json`, and `DeviceStore` made up an
  id and kept it, so the recording's header named no paired phone and the
  app looked unpaired until relaunched (Codex Astra's review, 2026-11-13).
  Now `DeviceStore` tells a locked file from a missing one (an injectable
  reader). It never keeps what it could not read, and refuses `update`
  while `device.json` is locked. The id moves to `device-id` the first time
  `device.json` is read. The recorder reads the id at each start. With no
  id yet (before the first unlock, or on the first locked launch of an
  older install), it refuses with « Déverrouillez l'iPhone une fois… », and
  the gesture opens the app, which asks to unlock. Once the phone is
  unlocked (`protectedDataDidBecomeAvailable`), the sync client reads the
  pairing and the credential again.
- Battery: there is no per-second update. While recording, there is one
  Live Activity update and one keychain write every 2 minutes. Not
  measured on the iPhone yet.
- The UI test shows nothing outside the app (`-SondineUITest`).

## Rejected

- Expo: the table above.
- Development builds only: Téo chose TestFlight, simpler to install and to
  update away from the Mac.
- Sharing `packages/ui` through a web view: a recorder's screens inside a
  web view add a process and a bridge for five screens.
