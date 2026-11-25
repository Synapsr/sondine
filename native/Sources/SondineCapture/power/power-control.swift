import Dispatch
import Foundation
import IOKit
import IOKit.pwr_mgt
import Synchronization

/// The in-person speech hold: a `PreventUserIdleSystemSleep` assertion named after Sondine,
/// so `pmset -g assertions` shows who keeps the Mac awake.
public protocol SpeechHold: Sendable {
    func begin() -> Bool
    func end()
}

public final class IOPMSpeechHold: SpeechHold, @unchecked Sendable {
    private let assertion = Mutex<IOPMAssertionID?>(nil)

    public init() {}

    public func begin() -> Bool {
        assertion.withLock { current in
            if current != nil { return true }
            var id = IOPMAssertionID(0)
            let status = IOPMAssertionCreateWithName(
                kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                IOPMAssertionLevel(kIOPMAssertionLevelOn),
                "Sondine: conversation in progress" as CFString,
                &id
            )
            guard status == kIOReturnSuccess else { return false }
            current = id
            return true
        }
    }

    public func end() {
        assertion.withLock { current in
            if let id = current { IOPMAssertionRelease(id) }
            current = nil
        }
    }
}

public final class FakeSpeechHold: SpeechHold, @unchecked Sendable {
    private let state = Mutex((held: false, begins: 0, ends: 0))

    public init() {}

    public var isHeld: Bool { state.withLock { $0.held } }
    public var begins: Int { state.withLock { $0.begins } }
    public var ends: Int { state.withLock { $0.ends } }

    public func begin() -> Bool {
        state.withLock { state in
            if !state.held { state.begins += 1 }
            state.held = true
        }
        return true
    }

    public func end() {
        state.withLock { state in
            if state.held { state.ends += 1 }
            state.held = false
        }
    }
}

public enum SystemPowerEvent: Sendable, Equatable {
    /// The system is about to sleep; the handler returns once runs are closed.
    case willSleep
    case didWake
}

/// System sleep and wake notifications.
public protocol SystemPowerEvents: AnyObject, Sendable {
    /// `handler` runs on `queue`. For `.willSleep`, sleep proceeds after it returns.
    func start(queue: DispatchQueue, handler: @escaping @Sendable (SystemPowerEvent) -> Void)
    func stop()
}

/// `IORegisterForSystemPower`, delivered on the engine queue. Works for a helper without an
/// NSApplication (NSWorkspace notifications may not reach a non-bundled process).
public final class IOKitSystemPowerEvents: SystemPowerEvents, @unchecked Sendable {
    // iokit_common_msg values (function-like macros that Swift does not import).
    static let canSystemSleep: UInt32 = 0xE000_0270
    static let systemWillSleep: UInt32 = 0xE000_0280
    static let systemHasPoweredOn: UInt32 = 0xE000_0300

    private var rootPort: io_connect_t = 0
    private var notifyPort: IONotificationPortRef?
    private var notifier: io_object_t = 0
    private var handler: (@Sendable (SystemPowerEvent) -> Void)?

    public init() {}

    public func start(queue: DispatchQueue, handler: @escaping @Sendable (SystemPowerEvent) -> Void) {
        guard rootPort == 0 else { return }
        self.handler = handler
        let context = Unmanaged.passUnretained(self).toOpaque()
        rootPort = IORegisterForSystemPower(context, &notifyPort, { refcon, _, messageType, argument in
            guard let refcon else { return }
            let events = Unmanaged<IOKitSystemPowerEvents>.fromOpaque(refcon).takeUnretainedValue()
            events.receive(messageType, argument)
        }, &notifier)
        guard rootPort != 0, let notifyPort else { return }
        IONotificationPortSetDispatchQueue(notifyPort, queue)
    }

    public func stop() {
        guard rootPort != 0 else { return }
        IODeregisterForSystemPower(&notifier)
        if let notifyPort { IONotificationPortDestroy(notifyPort) }
        IOServiceClose(rootPort)
        rootPort = 0
        notifyPort = nil
        handler = nil
    }

    private func receive(_ message: UInt32, _ argument: UnsafeMutableRawPointer?) {
        let token = Int(bitPattern: argument)
        switch message {
        case Self.canSystemSleep:
            IOAllowPowerChange(rootPort, token)
        case Self.systemWillSleep:
            handler?(.willSleep)
            IOAllowPowerChange(rootPort, token)
        case Self.systemHasPoweredOn:
            handler?(.didWake)
        default:
            break
        }
    }
}

public final class FakeSystemPowerEvents: SystemPowerEvents, @unchecked Sendable {
    private let state = Mutex<(queue: DispatchQueue, handler: @Sendable (SystemPowerEvent) -> Void)?>(nil)

    public init() {}

    public func start(queue: DispatchQueue, handler: @escaping @Sendable (SystemPowerEvent) -> Void) {
        state.withLock { $0 = (queue, handler) }
    }

    public func stop() { state.withLock { $0 = nil } }

    /// Delivers an event as IOKit would; `.willSleep` waits until the handler has run.
    public func send(_ event: SystemPowerEvent) {
        guard let (queue, handler) = state.withLock({ $0 }) else { return }
        if event == .willSleep { queue.sync { handler(event) } } else { queue.async { handler(event) } }
    }
}
