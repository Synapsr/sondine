/// Who else listens to a microphone without being a call: a dictation app such as Hex or
/// VoiceInk, a browser page, the system's speech recognition. Core decides which of these are
/// dictations (the user's rule per app); the helper only says who listens, and when.
public enum ListenPolicy {
    /// The app a process listens for while its input runs, or nil. Call daemons and system
    /// sounds never listen; the caller leaves out apps that are a call at that moment.
    public static func source(of process: CatalogProcess) -> (bundleId: String, via: ListenEvent.Via)? {
        guard process.io.runningInput, let bundleId = process.resolution.app?.bundleId else { return nil }
        switch process.resolution.daemonRole {
        case .speech: return (bundleId, .speech)
        case .callAudio, .callRelay, .systemSound: return nil
        case nil: return (bundleId, .app)
        }
    }
}

/// The apps listening now, one span per app however many of its processes listen. Each span
/// gets its own listen id: an app that releases the microphone and takes it again starts a new
/// span, which core never joins to the last one (two dictations are two).
public struct ListenTracker: Sendable, Equatable {
    public struct Listen: Sendable, Equatable {
        public var listenId: String
        public var bundleId: String
        public var via: ListenEvent.Via
        public var startedAt: ClockPoint
    }

    /// Listening apps by bundle id.
    public private(set) var active: [String: Listen] = [:]

    public init() {}

    public struct Source: Sendable, Equatable {
        public var bundleId: String
        public var via: ListenEvent.Via

        public init(bundleId: String, via: ListenEvent.Via) {
            self.bundleId = bundleId
            self.via = via
        }
    }

    /// Moves to the listeners `sources` describe (none while they are not reported) and returns
    /// the events that say so: the ended spans first, then the new ones, each in bundle id order.
    public mutating func update(sources: [Source], at: ClockPoint, newId: () -> String) -> [ListenEvent] {
        var now: [String: Source] = [:]
        for source in sources where now[source.bundleId] == nil { now[source.bundleId] = source }
        var events: [ListenEvent] = []
        for bundleId in active.keys.sorted() where now[bundleId] == nil {
            guard let listen = active.removeValue(forKey: bundleId) else { continue }
            events.append(ListenEvent(listenId: listen.listenId, state: .ended, at: at, bundleId: bundleId, via: listen.via))
        }
        for bundleId in now.keys.sorted() where active[bundleId] == nil {
            guard let source = now[bundleId] else { continue }
            let listen = Listen(listenId: newId(), bundleId: bundleId, via: source.via, startedAt: at)
            active[bundleId] = listen
            events.append(listen.activeEvent)
        }
        return events
    }
}

extension ListenTracker.Listen {
    /// The `active` event of this span, as first sent and as replayed in snapshots.
    var activeEvent: ListenEvent {
        ListenEvent(listenId: listenId, state: .active, at: startedAt, bundleId: bundleId, via: via)
    }
}
