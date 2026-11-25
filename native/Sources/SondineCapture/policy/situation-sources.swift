import Foundation
import Synchronization

// What the Mac's situation is, for private zones (ADR 029): the screen away, the networks the
// Mac is on, and the wall clock's time zone and changes. Each needs no permission; tests swap
// them for scriptable fakes.

/// Whether the screen is away: locked, the screen saver running, or the displays asleep.
public protocol ScreenStateSource: AnyObject, Sendable {
    /// Starts watching and returns whether the screen is away now; `handler` gets every later
    /// change, as soon as it is seen, on any thread.
    func watchScreen(handler: @escaping @Sendable (Bool) -> Void) -> Bool
    func stopWatchingScreen()
}

/// A network's signature as SystemConfiguration says it (`NetworkSignature`: the router's
/// address and hardware address, or the IPv6 prefix and router hardware address). It stays in
/// memory: it is hashed with the install's key before anything is said about it, and it never
/// prints.
public struct NetworkSignature: Sendable, Equatable, Hashable, CustomStringConvertible, CustomDebugStringConvertible {
    public let raw: String

    public init(_ raw: String) {
        self.raw = raw
    }

    public var description: String { "NetworkSignature(redacted)" }
    public var debugDescription: String { description }
}

/// The physical networks the Mac is on, IPv4 first; a VPN in front has no router hardware
/// address and is not one.
public protocol NetworkSource: AnyObject, Sendable {
    /// Starts watching and returns the networks now; `handler` gets every later change.
    func start(handler: @escaping @Sendable ([NetworkSignature]) -> Void) -> [NetworkSignature]
    func stop()
}

/// The Mac's time zone, and when the clock is set or the time zone changes.
public protocol WallClockSource: AnyObject, Sendable {
    var timeZone: TimeZone { get }
    /// `handler` runs after the clock was set or the time zone changed, on any thread.
    func start(handler: @escaping @Sendable () -> Void)
    func stop()
}

/// The screen is never away: the default, for tools that do not need it.
public final class NoScreenState: ScreenStateSource {
    public init() {}
    public func watchScreen(handler: @escaping @Sendable (Bool) -> Void) -> Bool { false }
    public func stopWatchingScreen() {}
}

/// No network is ever readable.
public final class NoNetworks: NetworkSource {
    public init() {}
    public func start(handler: @escaping @Sendable ([NetworkSignature]) -> Void) -> [NetworkSignature] { [] }
    public func stop() {}
}

/// `NSSystemClockDidChange` and `NSSystemTimeZoneDidChange`, and the system time zone.
public final class SystemWallClock: WallClockSource, @unchecked Sendable {
    private let lock = NSLock()
    private var observers: [any NSObjectProtocol] = []

    public init() {}

    public var timeZone: TimeZone { TimeZone.current }

    public func start(handler: @escaping @Sendable () -> Void) {
        let center = NotificationCenter.default
        let tokens = [Notification.Name.NSSystemClockDidChange, .NSSystemTimeZoneDidChange].map { name in
            center.addObserver(forName: name, object: nil, queue: nil) { _ in
                // TimeZone.current is cached until told the system's changed.
                NSTimeZone.resetSystemTimeZone()
                handler()
            }
        }
        lock.withLock { observers = tokens }
    }

    public func stop() {
        let tokens = lock.withLock { () -> [any NSObjectProtocol] in
            defer { observers = [] }
            return observers
        }
        for token in tokens { NotificationCenter.default.removeObserver(token) }
    }
}

/// A scriptable screen for tests: `set` reports a change as the system would.
public final class FakeScreenState: ScreenStateSource, @unchecked Sendable {
    private let state: Mutex<(away: Bool, handler: (@Sendable (Bool) -> Void)?)>

    public init(away: Bool = false) {
        state = Mutex((away, nil))
    }

    public func watchScreen(handler: @escaping @Sendable (Bool) -> Void) -> Bool {
        state.withLock { state in
            state.handler = handler
            return state.away
        }
    }

    public func stopWatchingScreen() { state.withLock { $0.handler = nil } }

    public func set(away: Bool) {
        let handler = state.withLock { state in
            state.away = away
            return state.handler
        }
        handler?(away)
    }
}

/// Scriptable networks for tests.
public final class FakeNetworks: NetworkSource, @unchecked Sendable {
    private let state: Mutex<(networks: [NetworkSignature], handler: (@Sendable ([NetworkSignature]) -> Void)?)>

    public init(_ networks: [NetworkSignature] = []) {
        state = Mutex((networks, nil))
    }

    public func start(handler: @escaping @Sendable ([NetworkSignature]) -> Void) -> [NetworkSignature] {
        state.withLock { state in
            state.handler = handler
            return state.networks
        }
    }

    public func stop() { state.withLock { $0.handler = nil } }

    public func set(_ networks: [NetworkSignature]) {
        let handler = state.withLock { state in
            state.networks = networks
            return state.handler
        }
        handler?(networks)
    }
}

/// A scriptable time zone for tests; the wall time itself comes from the engine's clock.
public final class FakeWallClock: WallClockSource, @unchecked Sendable {
    private let state: Mutex<(timeZone: TimeZone, handler: (@Sendable () -> Void)?)>

    public init(timeZone: TimeZone) {
        state = Mutex((timeZone, nil))
    }

    public var timeZone: TimeZone { state.withLock { $0.timeZone } }

    public func start(handler: @escaping @Sendable () -> Void) { state.withLock { $0.handler = handler } }

    public func stop() { state.withLock { $0.handler = nil } }

    /// The clock was set (the engine's clock moved) or the time zone changed.
    public func changed(timeZone: TimeZone? = nil) {
        let handler = state.withLock { state in
            if let timeZone { state.timeZone = timeZone }
            return state.handler
        }
        handler?()
    }
}
