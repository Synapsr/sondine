// swift-tools-version: 6.4
import PackageDescription

// App Sandbox reads the helper's bundle identifier from an Info.plist bound to
// its signature (ADR 010); the linker embeds it, with an absolute path so the
// build works from any directory.
let sources = String(#filePath.dropLast("Package.swift".count)) + "Sources/"
let helperInfoPlist = sources + "sondine-audio/Info.plist"
let relayInfoPlist = sources + "sondine-mcp/Info.plist"
let browserInfoPlist = sources + "sondine-browser/Info.plist"
let lanInfoPlist = sources + "sondine-lan/Info.plist"

// Release 1 targets macOS 27 on Apple silicon only (ADR 004). The iPhone app
// (ADR 031) uses `SondinePhone` on iOS 27; the macOS-only targets stay out of
// its dependency graph.
let package = Package(
    name: "SondineNative",
    platforms: [.macOS(.v27), .iOS(.v27)],
    products: [
        .library(name: "SondineKit", targets: ["SondineKit"]),
        .library(name: "SondinePhone", targets: ["SondinePhone"]),
        .library(name: "SondineCapture", targets: ["SondineCapture"]),
        .executable(name: "sondine-audio", targets: ["sondine-audio"]),
        .executable(name: "sondine-meter", targets: ["sondine-meter"]),
        .executable(name: "sondine-voice", targets: ["sondine-voice"]),
        .executable(name: "sondine-mcp", targets: ["sondine-mcp"]),
        .executable(name: "sondine-browser", targets: ["sondine-browser"]),
        .executable(name: "sondine-lan", targets: ["sondine-lan"]),
        .executable(name: "sondine-notch", targets: ["sondine-notch"]),
    ],
    dependencies: [],
    targets: [
        // Signal processing, spool, gate, segmenter, VAD protocol, file mode. No ONNX Runtime.
        .target(
            name: "SondineKit",
            linkerSettings: [.linkedFramework("AVFAudio"), .linkedFramework("Accelerate")]
        ),
        // HAL abstraction (Core Audio and a scriptable fake), discovery, policy, capture engine,
        // permissions, power, and the helper socket protocol. No ONNX Runtime.
        .target(
            name: "SondineCapture",
            dependencies: ["SondineKit"],
            linkerSettings: [
                .linkedFramework("CoreAudio"),
                .linkedFramework("AudioToolbox"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("IOKit"),
            ]
        ),
        // ONNX Runtime 1.24.2 (MIT), its C API only: Microsoft's pod archive, pinned by the
        // checksum Microsoft's Swift package gave it. That package and download.onnxruntime.ai
        // went offline in November 2026; the same bytes are kept on sondine-releases.
        .binaryTarget(
            name: "onnxruntime",
            url: "https://github.com/teo-goulois/sondine-releases/releases/download/onnxruntime-1.24.2/pod-archive-onnxruntime-c-1.24.2.zip",
            checksum: "f7100a992d2a8135168c8afd831e6a58b465349101982aa58b3e11d36e600b54"
        ),
        // Thin C shim over the ONNX Runtime C API, kept apart so only the helper links ORT.
        // ORT is a static C++ library: the C++ runtime is linked here.
        .target(name: "CSondineOnnx", dependencies: ["onnxruntime"], linkerSettings: [.linkedLibrary("c++")]),
        // Silero VAD v6.2 on ONNX Runtime CPU.
        .target(name: "SondineSilero", dependencies: ["SondineKit", "CSondineOnnx"]),
        .executableTarget(
            name: "sondine-audio",
            dependencies: ["SondineKit", "SondineCapture", "SondineSilero"],
            exclude: ["Info.plist"],
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", helperInfoPlist]),
            ]
        ),
        .executableTarget(name: "sondine-meter"),
        // Speaker embeddings (WeSpeaker v2 on Core ML) for naming voices. No ONNX Runtime.
        .target(name: "SondineVoice", linkerSettings: [.linkedFramework("CoreML")]),
        .executableTarget(name: "sondine-voice", dependencies: ["SondineVoice"]),
        // Agents' stdio to core's MCP socket (ADR 011): a byte relay, no logic.
        .executableTarget(
            name: "sondine-mcp",
            exclude: ["Info.plist"],
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", relayInfoPlist]),
            ]
        ),
        // A browser's native messaging to core's browser socket (ADR 023): a frame-to-line relay, no logic.
        .executableTarget(
            name: "sondine-browser",
            exclude: ["Info.plist"],
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", browserInfoPlist]),
            ]
        ),
        // Paired iPhones to core's phone socket (ADR 008): the Mac's only network
        // listener. TLS 1.3, Bonjour, a peer check before TLS, a byte copy; no logic.
        .target(name: "SondineLan", linkerSettings: [.linkedFramework("Network"), .linkedFramework("Security")]),
        .executableTarget(
            name: "sondine-lan",
            dependencies: ["SondineLan"],
            exclude: ["Info.plist"],
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", lanInfoPlist]),
            ]
        ),
        // Call context beside the notch (ADR 025): its wire and geometry, then the
        // AppKit window main starts during a call. No audio, no model.
        .target(name: "SondineNotch"),
        .executableTarget(
            name: "sondine-notch",
            dependencies: ["SondineNotch"],
            linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("SwiftUI")]
        ),
        // The iPhone app's logic (ADR 031, ADR 032): the recorder behind protocols
        // (audio session, microphone, writer, disk), with scripted fakes, the
        // recording store and the header. iOS-only adapters sit under `#if os(iOS)`.
        .target(
            name: "SondinePhone",
            linkerSettings: [.linkedFramework("AVFoundation"), .linkedFramework("CoreMedia")]
        ),
        // Writes a phone recording as the app does, optionally killed mid-write:
        // the cross-language test's file (`pnpm test:native`).
        .executableTarget(name: "sondine-phone-fixture", dependencies: ["SondinePhone"]),
        // The iPhone in the end-to-end sync test (`pnpm test:native`): the real sync
        // client and transport, driven by JSON lines, against the real relay and core.
        .executableTarget(name: "sondine-phone-e2e", dependencies: ["SondinePhone"]),
        .testTarget(name: "SondineKitTests", dependencies: ["SondineKit", "SondineSilero"]),
        .testTarget(name: "SondinePhoneTests", dependencies: ["SondinePhone", "sondine-phone-fixture", "sondine-phone-e2e"]),
        .testTarget(name: "SondineCaptureTests", dependencies: ["SondineKit", "SondineCapture"]),
        .testTarget(name: "SondineMeterTests", dependencies: ["sondine-meter"]),
        .testTarget(name: "SondineVoiceTests", dependencies: ["SondineVoice"]),
        .testTarget(name: "SondineNotchTests", dependencies: ["SondineNotch"]),
        .testTarget(name: "SondineLanTests", dependencies: ["SondineLan", "sondine-lan"]),
    ]
)
