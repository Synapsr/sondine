import Darwin
import Testing
@testable import SondineCapture

/// Resolver cases recorded on a MacBook Air (M0 probe, `sondine-scratch/capture/probe-output.txt`).
struct ProcessResolverTests {
    private static func app(_ id: String, _ name: String) -> AppBundle { AppBundle(bundleId: id, name: name) }

    static let safari = app("com.apple.Safari", "Safari")
    static let raycast = app("com.raycast.macos", "Raycast")
    static let helium = app("net.imput.helium", "Helium")
    static let discord = app("com.hnc.Discord", "Discord")
    static let t3 = app("com.t3tools.t3code", "T3 Code (Nightly)")

    static let rows: [Int32: FixtureIntrospection.Row] = [
        // WebKit GPU processes: parent is launchd, only responsibility names the host app.
        23706: .init(responsible: 68245, parent: 1, path: "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU", name: "com.apple.WebKit.GPU"),
        68245: .init(responsible: 68245, parent: 1, path: "/Applications/Safari.app/Contents/MacOS/Safari", name: "Safari", app: safari),
        10920: .init(responsible: 10783, parent: 1, path: "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU", name: "com.apple.WebKit.GPU"),
        10783: .init(responsible: 10783, parent: 1, path: "/Applications/Raycast.app/Contents/MacOS/Raycast", name: "Raycast", app: raycast),
        // Chromium helpers: the parent is the browser.
        23682: .init(responsible: 69015, parent: 69015, path: "/Applications/Helium.app/Contents/Frameworks/Helium Framework.framework/Versions/1/Helpers/Helium Helper.app/Contents/MacOS/Helium Helper", name: "Helium Helper", app: app("net.imput.helium.helper", "Helium Helper")),
        69015: .init(responsible: 69015, parent: 1, path: "/Applications/Helium.app/Contents/MacOS/Helium", name: "Helium", app: helium),
        21997: .init(responsible: 21919, parent: 21919, path: "/Applications/Discord.app/Contents/Frameworks/Discord Helper (Renderer).app/Contents/MacOS/Discord Helper (Renderer)", name: "Discord Helper (Renderer)", app: app("com.hnc.Discord.helper.Renderer", "Discord Helper (Renderer)")),
        21919: .init(responsible: 21919, parent: 1, path: "/Applications/Discord.app/Contents/MacOS/Discord", name: "Discord", app: discord),
        // Call daemons: no app anywhere, mapped by name.
        901: .init(responsible: 901, parent: 1, path: "/usr/libexec/avconferenced", name: "avconferenced"),
        60541: .init(responsible: 60541, parent: 1, path: "/System/Library/PrivateFrameworks/TelephonyUtilities.framework/callservicesd", name: "callservicesd"),
        852: .init(responsible: 852, parent: 1, path: "/System/Library/PrivateFrameworks/CoreSpeech.framework/corespeechd", name: "corespeechd"),
        // A command-line tool started from a terminal app.
        77930: .init(responsible: 66840, parent: 76465, path: "/Users/someone/bin/probe", name: "probe"),
        76465: .init(responsible: 66840, parent: 66840, path: "/bin/zsh", name: "zsh"),
        66840: .init(responsible: 66840, parent: 1, path: "/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly)", name: "T3 Code (Nightly)", app: t3),
        // A process nobody can map.
        2435: .init(responsible: nil, parent: nil, path: nil, name: nil),
    ]

    private let resolver = ProcessResolver(introspection: FixtureIntrospection(rows: rows))
    private let noSPI = ProcessResolver(introspection: FixtureIntrospection(rows: rows, hasResponsibilitySPI: false))

    @Test(arguments: [(Int32(23706), "com.apple.Safari"), (Int32(10920), "com.raycast.macos")])
    func webKitGPUProcessesMapToTheirHostAppThroughResponsibility(pid: Int32, bundleId: String) {
        let resolution = resolver.resolve(pid: pid, halBundleID: "com.apple.WebKit.GPU")
        #expect(resolution.app?.bundleId == bundleId)
        #expect(resolution.evidence == .responsibility)
        #expect(resolution.confidence == .high)
        #expect(!resolution.viaTerminal)
    }

    @Test(arguments: [(Int32(23682), "net.imput.helium"), (Int32(21997), "com.hnc.Discord")])
    func chromiumHelpersMapToTheBrowserThroughAncestry(pid: Int32, bundleId: String) {
        let resolution = noSPI.resolve(pid: pid, halBundleID: nil)
        #expect(resolution.app?.bundleId == bundleId)
        #expect(resolution.evidence == .ancestry)
        #expect(resolution.confidence == .high)
        // With the SPI, responsibility already names the browser.
        #expect(resolver.resolve(pid: pid, halBundleID: nil).app?.bundleId == bundleId)
    }

    @Test func withoutTheSPIAWebKitGPUProcessFallsBackToItsPath() {
        // The XPC service lives in WebKit.framework, not in an app: unresolved, never guessed.
        let resolution = noSPI.resolve(pid: 23706, halBundleID: "com.apple.WebKit.GPU")
        #expect(resolution.app == nil)
        #expect(resolution.evidence == nil)
    }

    @Test func callDaemonsMapThroughTheDaemonMap() {
        let facetime = resolver.resolve(pid: 901, halBundleID: "com.apple.avconferenced")
        #expect(facetime.app == AppBundle(bundleId: "com.apple.avconferenced", name: "FaceTime call"))
        #expect(facetime.evidence == .daemonMap)
        #expect(facetime.daemonRole == .callAudio)

        let relay = resolver.resolve(pid: 60541, halBundleID: "com.apple.TelephonyUtilities")
        #expect(relay.app?.name == "iPhone call relay")
        #expect(relay.daemonRole == .callRelay)

        // By process name when the HAL gives no bundle id.
        #expect(resolver.resolve(pid: 60541, halBundleID: nil).daemonRole == .callRelay)
        #expect(resolver.resolve(pid: 852, halBundleID: "com.apple.CoreSpeech").daemonRole == .speech)
    }

    @Test func aTerminalToolMapsToTheTerminalWithMediumConfidence() {
        let resolution = resolver.resolve(pid: 77930, halBundleID: nil)
        #expect(resolution.app?.bundleId == "com.t3tools.t3code")
        #expect(resolution.evidence == .responsibility)
        #expect(resolution.confidence == .medium)
        #expect(resolution.viaTerminal)

        let ancestry = noSPI.resolve(pid: 77930, halBundleID: nil)
        #expect(ancestry.evidence == .ancestry)
        #expect(ancestry.viaTerminal)
    }

    @Test func anAppWhoseBundleCannotBeReadIsNamedByItsCoreAudioBundleId() {
        // Under App Sandbox the helper reads app bundles in /Applications only.
        let elsewhere = FixtureIntrospection(rows: [4_242: .init(responsible: 4_242, parent: 1, path: "/Users/me/Applications/Foo Bar.app/Contents/MacOS/foo")])
        let resolution = ProcessResolver(introspection: elsewhere).resolve(pid: 4_242, halBundleID: "com.example.foo")
        #expect(resolution.app == AppBundle(bundleId: "com.example.foo", name: "Foo Bar"))
        #expect(resolution.evidence == .halBundleId)
        // Without a bundle id from Core Audio, or outside an app's main executable: unresolved.
        #expect(ProcessResolver(introspection: elsewhere).resolve(pid: 4_242, halBundleID: nil).app == nil)
        let tool = FixtureIntrospection(rows: [4_243: .init(responsible: 4_243, parent: 1, path: "/usr/local/bin/player")])
        #expect(ProcessResolver(introspection: tool).resolve(pid: 4_243, halBundleID: "com.example.tool").app == nil)
    }

    @Test func unknownProcessesStayUnresolved() {
        let resolution = resolver.resolve(pid: 2435, halBundleID: nil)
        #expect(resolution.app == nil)
        #expect(resolution.evidence == nil)
        #expect(resolution.startWallNs != nil)
    }

    @Test func darwinIntrospectionReadsThisProcess() {
        let darwin = DarwinProcessIntrospection()
        let pid = getpid()
        #expect(darwin.startWallNs(pid) != nil)
        #expect(darwin.parentPID(pid) != nil)
        #expect(darwin.executablePath(pid) != nil)
        #expect(darwin.hasResponsibilitySPI)
        #expect(darwin.responsiblePID(pid) != nil)
    }
}
