# 010 — Build, signing, and hardening

Status: Proposed — 2026-11-02

## Context

TCC grants, the Local Network grant, and login items key on a stable code
signature. Electron ships with RunAsNode, `NODE_OPTIONS`, and inspector
switches enabled: any process running as the user could then run code with
Sondine's microphone and system-audio grants. A manifest field cannot stop an
engine from using the network; macOS 27 no longer supports `sandbox_init`
profiles.

## Decision

- Builds: hardened runtime, Developer ID signing, notarized DMG for releases;
  signed development builds for every permission test.
- Info.plist (main app, through electron-builder `extendInfo`):
  `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription`,
  `NSLocalNetworkUsageDescription` (release 2). Native helpers embed an
  Info.plist with the same strings.
- Entitlements per binary, explicit: `device.audio-input` for main and
  `sondine-audio`; minimal sets for the others.
- Electron fuses: `runAsNode` off, `enableNodeOptionsEnvironmentVariable` off,
  `enableNodeCliInspectArguments` off, `enableEmbeddedAsarIntegrityValidation`
  on, `onlyLoadAppFromAsar` on, `grantFileProtocolExtraPrivileges` off.
  Consequence: core must stay a utility process, and `sondine-mcp` is a Swift
  binary.
- Native children run under App Sandbox without `network.client`, with
  read-only access to the model and spool directories; the exact mechanism
  per child is decided by an M0 spike and tested by a network-deny test.
- Updates: Sondine's own, from GitHub Releases, with the user's yes
  ([ADR 045](045-automatic-updates.md), 2026-11-25). electron-updater, named
  here first, was never used: it sends an identifier kept per install.
- Amended 2026-11-10 by [ADR 008](008-mobile-lan-sync.md) (release 2):
  `sondine-lan`, the relay for paired iPhones, is the one native child with
  a network entitlement, with the application group. `sondine-audio` keeps
  none. Built in M5.2: `network.server` and, since 2026-11-13,
  `network.client`, without which Network.framework's listener could not
  answer an iPhone on the Wi-Fi under App Sandbox (ADR 008, « Who listens on
  the Mac »); `check-package.mjs` asserts its four entitlements and, on
  signed builds, runs its self-test (a file in the home folder refused,
  listening allowed).

## M0 state

- `sondine-audio` is signed with `com.apple.security.app-sandbox`,
  `device.audio-input`, the application group, and one read-only exception
  for the models folder (ADR 013), and no network entitlement. It does not
  use `com.apple.security.inherit`, which only applies to children of a
  sandboxed parent (Electron main is not sandboxed). Its Info.plist is linked
  into the executable: the sandbox refuses to start a binary without a bundle
  identifier. `check-package.mjs` asserts all of this on signed builds.
- `sondine-audio self-test sandbox` is the network-deny test. On 2026-11-03,
  on a Developer ID build, it passed 8 of 8: outbound connect refused
  (EPERM), the helper's own process chain and all 52 Core Audio clients
  resolved (the sandbox empties `proc_listallpids`, which capture does not
  use), data and socket in the group container, models readable and not
  writable.
- First signed run, 2026-11-04: macOS asked for the microphone and system
  audio once, credited to Sondine, and both tracks deliver signal under the
  sandbox (system audio -37.9 dBFS over a health window, permissions
  `granted-verified`), with no sandbox denial in the system log.
- Development builds sign without a secure timestamp: only notarization
  needs one, and it costs a request to Apple per signed file.
  `pnpm release:mac` signs with it, has electron-builder notarize and staple
  the app, then signs, notarizes and staples the DMG, and checks that
  Gatekeeper accepts both. It loads the team's App Store Connect API key
  from Infisical (project `sondine-next`, folder `/desktop`, the same in dev
  and prod: `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and the .p8 in base64 as
  `APPLE_API_KEY_P8`), written to a private temporary file for the run;
  `APPLE_API_KEY` (a .p8 path) still works without Infisical.
  First notarized build: 2026-11-08, both « Notarized Developer ID ».
  A release is the DMG, with the two files updates read (ADR 045), attached to
  a `desktop-v<version>` release of the
  public `teo-goulois/sondine-releases` repository; publishing one is Téo's call. Its page opens with one line
  of requirements. Through 0.6.0: « Requires a Mac with Apple Silicon, 32 GB
  of memory and macOS 27. » From the first release with ADR 040: « Requires a
  Mac with Apple Silicon and macOS 27. Transcribing on the Mac takes 32 GB of
  memory; with less, another machine can transcribe, which has not been tried
  yet on a smaller Mac. » Below macOS 27, the system refuses to open the app.
- At each launch tccd logs that `kTCCServiceAppleEvents` "requires entitlement
  com.apple.security.automation.apple-events but it is missing" for Sondine.
  It is not an Apple Event Sondine sends: it follows the `kAECheckinApp` every
  Cocoa app makes to `appleeventsd`, which asks tccd for the app's identity
  and gets that note; Apple's own helpers (SafariPlatformSupport,
  ThemeWidgetControlViewService) log the same line. No event is sent (2 h of
  logs). Sondine needs no automation, so the entitlement stays out.

## Consequences

- Contributors without a Developer ID build ad-hoc signed apps, which check
  packaging but do not capture (ADR 013); capture work runs in development.
- A CI check reads the packaged fuses and entitlements.
