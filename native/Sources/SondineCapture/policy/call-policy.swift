/// Where a call comes from: a process with microphone input running that is a call app, a call
/// daemon, or a browser that also plays sound (web calls). Bundle ids are for display and
/// matching only.
public enum CallPolicy {
    /// Browsers whose microphone use is taken for a web call (Meet, Teams, Zoom on the web), while
    /// they also play sound. Helium and Yab are Téo's (2026-11-06).
    public static let browsers: Set<String> = [
        "com.apple.Safari", "com.google.Chrome", "company.thebrowser.Browser", "org.mozilla.firefox",
        "com.microsoft.edgemac", "com.brave.Browser", "com.operasoftware.Opera", "com.vivaldi.Vivaldi",
        "net.imput.helium", "dev.serafim.fast",
    ]

    /// The call a process stands for while its input runs, or nil. Dictation and Siri are never
    /// calls. A browser counts only while one of its processes plays sound (`appsWithOutput`, by
    /// bundle id): a web call goes both ways, dictation in a page only listens.
    public static func source(of process: CatalogProcess, appsWithOutput: Set<String>) -> (bundleId: String, via: CallEvent.Via)? {
        guard process.io.runningInput, let bundleId = process.resolution.app?.bundleId else { return nil }
        switch process.resolution.daemonRole {
        case .callAudio, .callRelay: return (bundleId, .callDaemon)
        case .speech, .systemSound: return nil
        case nil: break
        }
        if AttributionPolicy.callApps.contains(bundleId) { return (bundleId, .callApp) }
        if browsers.contains(bundleId) { return appsWithOutput.contains(bundleId) ? (bundleId, .browser) : nil }
        return nil
    }
}

/// The calls going on, one per app, from the process catalog. Each active span gets its own
/// call id: an app that stops and starts its input again is a new span, and core joins the
/// spans of one app that restart within its rejoin window (ADR 007).
public struct CallTracker: Sendable, Equatable {
    public struct Call: Sendable, Equatable {
        public var callId: String
        public var bundleId: String
        public var via: CallEvent.Via
        public var inputDeviceUid: String?
        public var startedAt: ClockPoint
    }

    /// Active calls by bundle id.
    public private(set) var active: [String: Call] = [:]

    public init() {}

    /// A source seen now: its app, how it is a call, and the input device it uses.
    public struct Source: Sendable, Equatable {
        public var bundleId: String
        public var via: CallEvent.Via
        public var inputDeviceUid: String?

        public init(bundleId: String, via: CallEvent.Via, inputDeviceUid: String?) {
            self.bundleId = bundleId
            self.via = via
            self.inputDeviceUid = inputDeviceUid
        }
    }

    /// Moves to the calls `sources` describe (none while calls are not reported) and returns the
    /// events that say so: the ended calls first, then the new ones, each in bundle id order.
    public mutating func update(sources: [Source], at: ClockPoint, newId: () -> String) -> [CallEvent] {
        var now: [String: Source] = [:]
        for source in sources where now[source.bundleId] == nil { now[source.bundleId] = source }
        var events: [CallEvent] = []
        for bundleId in active.keys.sorted() where now[bundleId] == nil {
            guard let call = active.removeValue(forKey: bundleId) else { continue }
            events.append(CallEvent(callId: call.callId, state: .ended, at: at, bundleId: bundleId, via: call.via, inputDeviceUid: nil))
        }
        for bundleId in now.keys.sorted() where active[bundleId] == nil {
            guard let source = now[bundleId] else { continue }
            let call = Call(callId: newId(), bundleId: bundleId, via: source.via, inputDeviceUid: source.inputDeviceUid, startedAt: at)
            active[bundleId] = call
            events.append(call.activeEvent)
        }
        return events
    }
}

extension CallTracker.Call {
    /// The `active` event of this call, as first sent and as replayed in snapshots.
    var activeEvent: CallEvent {
        CallEvent(callId: callId, state: .active, at: startedAt, bundleId: bundleId, via: via, inputDeviceUid: inputDeviceUid)
    }
}
