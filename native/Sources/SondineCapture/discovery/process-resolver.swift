/// What a mapped system daemon means for capture.
public enum DaemonRole: String, Sendable, Equatable {
    /// `avconferenced`: FaceTime call audio (a call daemon, M3 taps it).
    case callAudio
    /// `callservicesd`: iPhone call relay (a call daemon).
    case callRelay
    /// Dictation, Siri, accessibility listening: never a call, never call-follow.
    case speech
    /// System sounds and alerts.
    case systemSound
}

/// How one process incarnation maps to an app, decided once when its process object appears.
public struct ProcessResolution: Sendable, Equatable {
    public var app: AppBundle?
    public var evidence: MappingEvidence?
    public var confidence: MappingConfidence?
    /// A command-line process resolved to its terminal.
    public var viaTerminal = false
    public var responsiblePID: Int32?
    public var daemonRole: DaemonRole?
    public var startWallNs: UInt64?

    public static let unresolved = ProcessResolution()
}

/// Maps a process to its app (architecture §3 Discovery). First success wins:
/// 1. responsibility SPI (the only way to map WebKit GPU processes to their host app),
/// 2. parent ancestry up to the topmost app (Chromium and Electron helpers),
/// 3. the outermost `.app` around the executable,
/// 4. the daemon map (call daemons and known system services),
/// 5. for an app's main executable whose bundle the helper cannot read (App Sandbox opens
///    `/Applications` only: an app in `~/Applications` or a build folder), the bundle id Core
///    Audio reports for it, named after its `.app` folder. Never for anything else.
public struct ProcessResolver: Sendable {
    public struct DaemonEntry: Sendable, Equatable {
        public var bundleId: String
        public var name: String?
        public var role: DaemonRole
    }

    /// Keyed by HAL bundle id or process name.
    public static let daemons: [String: DaemonEntry] = {
        let facetime = DaemonEntry(bundleId: "com.apple.avconferenced", name: "FaceTime call", role: .callAudio)
        let relay = DaemonEntry(bundleId: "com.apple.TelephonyUtilities", name: "iPhone call relay", role: .callRelay)
        let speech = DaemonEntry(bundleId: "com.apple.CoreSpeech", name: nil, role: .speech)
        let heard = DaemonEntry(bundleId: "com.apple.accessibility.heard", name: nil, role: .speech)
        let assistant = DaemonEntry(bundleId: "com.apple.assistantd", name: nil, role: .speech)
        let sounds = DaemonEntry(bundleId: "com.apple.systemsoundserverd", name: nil, role: .systemSound)
        return [
            "com.apple.avconferenced": facetime, "avconferenced": facetime,
            "com.apple.TelephonyUtilities": relay, "callservicesd": relay,
            "com.apple.CoreSpeech": speech, "corespeechd": speech,
            "com.apple.corespeechd_system": DaemonEntry(bundleId: "com.apple.corespeechd_system", name: nil, role: .speech),
            "com.apple.accessibility.heard": heard, "heard": heard,
            "com.apple.assistantd": assistant, "assistantd": assistant,
            "com.apple.systemsoundserverd": sounds, "systemsoundserverd": sounds,
        ]
    }()

    public let introspection: any ProcessIntrospection
    public let maxAncestry = 16

    public init(introspection: any ProcessIntrospection) {
        self.introspection = introspection
    }

    public func resolve(pid: Int32, halBundleID: String?) -> ProcessResolution {
        var resolution = ProcessResolution()
        resolution.startWallNs = introspection.startWallNs(pid)
        let responsible = introspection.responsiblePID(pid)
        resolution.responsiblePID = responsible
        let ownApp = introspection.runningApp(pid)
        let path = introspection.executablePath(pid)
        let daemon = (halBundleID.flatMap { Self.daemons[$0] }) ?? (introspection.processName(pid).flatMap { Self.daemons[$0] })
        resolution.daemonRole = daemon?.role

        func terminalOrigin() -> Bool {
            guard ownApp == nil, halBundleID == nil else { return false }
            guard let path else { return true }
            return ![".app/", ".appex/", ".xpc/", ".framework/"].contains { path.contains($0) }
        }

        if let responsible {
            if let app = introspection.runningApp(responsible) ?? (responsible == pid ? nil : enclosingApp(of: responsible)) {
                let viaTerminal = responsible != pid && terminalOrigin()
                return mapped(resolution, app, .responsibility, viaTerminal ? .medium : .high, viaTerminal: viaTerminal)
            }
        }
        if let app = topmostAncestorApp(of: pid) {
            let viaTerminal = terminalOrigin()
            return mapped(resolution, app, .ancestry, viaTerminal ? .medium : .high, viaTerminal: viaTerminal)
        }
        if let path, let app = introspection.enclosingApp(path: path) {
            return mapped(resolution, app, .path, .medium, viaTerminal: false)
        }
        if let daemon {
            return mapped(resolution, AppBundle(bundleId: daemon.bundleId, name: daemon.name), .daemonMap, .high, viaTerminal: false)
        }
        if let halBundleID, !halBundleID.isEmpty, let path, let name = Self.appOfMainExecutable(path) {
            return mapped(resolution, AppBundle(bundleId: halBundleID, name: name), .halBundleId, .medium, viaTerminal: false)
        }
        return resolution
    }

    /// `…/Name.app/Contents/MacOS/<executable>` → "Name".
    static func appOfMainExecutable(_ path: String) -> String? {
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard components.count >= 4, components[components.count - 2] == "MacOS", components[components.count - 3] == "Contents" else { return nil }
        let folder = components[components.count - 4]
        guard folder.hasSuffix(".app"), folder.count > 4 else { return nil }
        return String(folder.dropLast(4))
    }

    private func mapped(
        _ base: ProcessResolution,
        _ app: AppBundle,
        _ evidence: MappingEvidence,
        _ confidence: MappingConfidence,
        viaTerminal: Bool
    ) -> ProcessResolution {
        var result = base
        result.app = app
        result.evidence = evidence
        result.confidence = confidence
        result.viaTerminal = viaTerminal
        return result
    }

    private func enclosingApp(of pid: Int32) -> AppBundle? {
        introspection.executablePath(pid).flatMap(introspection.enclosingApp(path:))
    }

    /// The app nearest launchd in the parent chain: a helper app's parent is the app itself, and
    /// a shell's ancestors end at the terminal.
    private func topmostAncestorApp(of pid: Int32) -> AppBundle? {
        var current: Int32? = pid
        var visited: Set<Int32> = []
        var found: AppBundle?
        for _ in 0..<maxAncestry {
            guard let candidate = current, candidate > 1, visited.insert(candidate).inserted else { break }
            if let app = introspection.runningApp(candidate) { found = app }
            current = introspection.parentPID(candidate)
        }
        return found
    }
}
