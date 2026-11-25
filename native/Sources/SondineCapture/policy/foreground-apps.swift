import Synchronization

/// The app in front on the Mac: NSWorkspace's frontmost application, by bundle id. Never a
/// window title or anything on screen, which would need a permission (ADR 022).
public struct ForegroundApp: Sendable, Equatable {
    public var bundleId: String
    public var name: String

    public init(bundleId: String, name: String) {
        self.bundleId = bundleId
        self.name = name
    }
}

/// Tells the engine which app is in front, and when that changes. No permission is needed.
public protocol ForegroundAppSource: AnyObject, Sendable {
    /// Starts watching and returns the app in front now (nil when none, or the screen is
    /// locked). `handler` gets every later change, as soon as it is seen, on any thread.
    func start(handler: @escaping @Sendable (ForegroundApp?) -> Void) -> ForegroundApp?
    func stop()
}

/// No app is ever in front: the default, for tools that do not need it.
public final class NoForegroundApps: ForegroundAppSource {
    public init() {}
    public func start(handler: @escaping @Sendable (ForegroundApp?) -> Void) -> ForegroundApp? { nil }
    public func stop() {}
}

/// A scriptable source for tests: `bringToFront` reports a change as the system would.
public final class FakeForegroundApps: ForegroundAppSource, @unchecked Sendable {
    private let state: Mutex<(app: ForegroundApp?, handler: (@Sendable (ForegroundApp?) -> Void)?)>

    public init(_ app: ForegroundApp? = nil) {
        state = Mutex((app, nil))
    }

    public func start(handler: @escaping @Sendable (ForegroundApp?) -> Void) -> ForegroundApp? {
        state.withLock { state in
            state.handler = handler
            return state.app
        }
    }

    public func stop() { state.withLock { $0.handler = nil } }

    public func bringToFront(_ app: ForegroundApp?) {
        let handler = state.withLock { state in
            state.app = app
            return state.handler
        }
        handler?(app)
    }
}

/// The app in front over the recent past: the one in front at the oldest instant kept, and
/// every change since. The engine keeps it only as far back as an open speech region needs:
/// while nobody speaks it holds the app in front now and the last seconds, never the day.
struct ForegroundTimeline: Sendable, Equatable {
    struct Change: Sendable, Equatable {
        var atNs: UInt64
        var app: ForegroundApp?
    }

    struct Span: Sendable, Equatable {
        var fromNs: UInt64
        var toNs: UInt64
        var app: ForegroundApp
    }

    /// Changes kept at most: a region with more switches than this loses its oldest ones.
    static let maxChanges = 512

    private(set) var changes: [Change] = []

    /// `app` is in front from `atNs` on. Times never go back: a late report counts from the
    /// last change.
    mutating func record(_ app: ForegroundApp?, atNs: UInt64) {
        if let last = changes.last {
            guard last.app != app else { return }
            changes.append(Change(atNs: max(atNs, last.atNs), app: app))
        } else {
            changes.append(Change(atNs: atNs, app: app))
        }
        if changes.count > Self.maxChanges { changes.removeFirst(changes.count - Self.maxChanges) }
    }

    /// Forgets the changes before `ns`, keeping the app that was in front then.
    mutating func forget(before ns: UInt64) {
        guard let keep = changes.lastIndex(where: { $0.atNs <= ns }), keep > 0 else { return }
        changes.removeFirst(keep)
    }

    /// The apps in front over `[fromNs, toNs)`, in time order; stretches without an app (or
    /// before the first change kept) are left out.
    func spans(fromNs: UInt64, toNs: UInt64) -> [Span] {
        guard toNs > fromNs else { return [] }
        var out: [Span] = []
        for (index, change) in changes.enumerated() {
            let next = index + 1 < changes.count ? changes[index + 1].atNs : UInt64.max
            let start = max(change.atNs, fromNs)
            let end = min(next, toNs)
            guard end > start, let app = change.app else { continue }
            out.append(Span(fromNs: start, toNs: end, app: app))
        }
        return out
    }
}
