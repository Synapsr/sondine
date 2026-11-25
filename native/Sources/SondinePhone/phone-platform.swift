import Foundation
import Synchronization

// What the recorder needs from iOS, each behind a protocol with a scripted
// fake, as the Mac's HAL is (ADR 031). The iOS adapters live in
// `ios-platform.swift`; the fakes drive the Swift tests on the Mac and the
// app's UI test.

/// The microphone iOS routes, as the header and the recording screen name it.
public struct AudioRoute: Equatable, Sendable {
    public var kind: PhoneRecordingHeader.InputKind
    /// Shown when it is not the phone's own (« AirPods »); never written to a file.
    public var name: String?

    public init(kind: PhoneRecordingHeader.InputKind, name: String? = nil) {
        self.kind = kind
        self.name = name
    }

    public static let builtIn = AudioRoute(kind: .builtIn)
}

/// Why iOS interrupted the session, as far as the app can tell.
public enum InterruptionCause: String, Sendable, Equatable {
    /// A call is on (CallKit's observer says so).
    case call
    /// Siri, an alarm, another app's microphone: iOS does not say which.
    case other
}

public enum AudioSessionEvent: Sendable, Equatable {
    case interruptionBegan(InterruptionCause)
    /// iOS says whether it recommends resuming.
    case interruptionEnded(shouldResume: Bool)
    /// The input changed: a headset connected or left.
    case routeChanged(AudioRoute)
    /// iOS's media services restarted: everything audio must be set up again.
    case mediaServicesReset
}

public enum AudioSessionError: Error, Equatable {
    /// The user refused the microphone.
    case permissionDenied
    /// iOS refused to activate the session (a call is on, or from the background).
    case activationFailed(String)
}

/// The app's audio session: record only, no voice processing, banner calls
/// do not interrupt unless answered (ADR 032).
public protocol AudioSessionControlling: AnyObject, Sendable {
    /// Configures and activates the session; the input it routes.
    func activate() throws -> AudioRoute
    func deactivate()
    /// Whether the user allowed the microphone; asks once.
    func requestPermission() async -> Bool
    /// What iOS says while the app runs.
    var events: AsyncStream<AudioSessionEvent> { get }
}

/// The microphone, delivering 16 kHz mono samples in order. `failed`: it
/// stopped by itself (a route switch it could not follow) and delivers no more.
public protocol MicrophoneSource: AnyObject, Sendable {
    func start(
        _ deliver: @escaping @Sendable ([Int16]) -> Void, failed: @escaping @Sendable (String) -> Void
    ) throws
    func stop()
}

/// Free space on the volume that holds the recordings.
public protocol DiskSpace: Sendable {
    func availableBytes() -> Int64?
}

/// The wall clock and its UTC offset; the length of a recording is counted in samples.
public protocol PhoneClock: Sendable {
    func nowMs() -> Int64
    func utcOffsetMin() -> Int
}

public struct SystemClock: PhoneClock {
    public init() {}
    public func nowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded(.down)) }
    public func utcOffsetMin() -> Int { TimeZone.current.secondsFromGMT() / 60 }
}

/// Local notifications only: no push service (ADR 032).
public protocol PhoneNotifying: Sendable {
    /// « Enregistrement interrompu à 14:32 », which opens the app on « Reprendre ».
    func recordingInterrupted(atMs: Int64, cause: InterruptionCause)
    /// The recording stopped by itself (no room left, the file could not be written).
    func recordingStopped(atMs: Int64, end: RecordingEnd)
    /// iOS's 8 hours of Live Activity are up: the recording started at `sinceMs` goes on (M5.6).
    func recordingContinues(sinceMs: Int64)
    /// The control or the Live Activity asked to record and the app could not
    /// be opened to do it: why, so the gesture never fails silently (M5.6).
    func recordingCouldNotStart(_ refusal: PhoneRecorder.StartRefusal)
}

// Scripted fakes

/// An audio session the test (or the UI test's launch) drives.
public final class ScriptedAudioSession: AudioSessionControlling, @unchecked Sendable {
    private let state = Mutex(State())
    private struct State {
        var route = AudioRoute.builtIn
        var permission = true
        var failActivation: String?
        var active = false
        var activations = 0
    }

    public let events: AsyncStream<AudioSessionEvent>
    private let continuation: AsyncStream<AudioSessionEvent>.Continuation

    public init(route: AudioRoute = .builtIn, permission: Bool = true) {
        (events, continuation) = AsyncStream.makeStream()
        state.withLock {
            $0.route = route
            $0.permission = permission
        }
    }

    public func activate() throws -> AudioRoute {
        try state.withLock {
            guard $0.permission else { throw AudioSessionError.permissionDenied }
            if let reason = $0.failActivation { throw AudioSessionError.activationFailed(reason) }
            $0.active = true
            $0.activations += 1
            return $0.route
        }
    }

    public func deactivate() { state.withLock { $0.active = false } }
    public func requestPermission() async -> Bool { state.withLock { $0.permission } }

    /// Sends an event as iOS would.
    public func send(_ event: AudioSessionEvent) {
        if case let .routeChanged(route) = event { state.withLock { $0.route = route } }
        continuation.yield(event)
    }

    /// The next activations fail with `reason` (nil: they succeed again).
    public func failActivation(_ reason: String?) { state.withLock { $0.failActivation = reason } }
    public var isActive: Bool { state.withLock { $0.active } }
    public var activations: Int { state.withLock { $0.activations } }
}

/// A microphone the test feeds: `push` delivers samples as the audio thread would.
public final class ScriptedMicrophone: MicrophoneSource, @unchecked Sendable {
    /// In a struct: a bare closure in a `Mutex` is wrapped in one more thunk at each read.
    private struct Delivery: Sendable {
        let call: @Sendable ([Int16]) -> Void
        let failed: @Sendable (String) -> Void
    }

    private let delivery = Mutex<Delivery?>(nil)
    public init() {}
    public func start(
        _ deliver: @escaping @Sendable ([Int16]) -> Void, failed: @escaping @Sendable (String) -> Void
    ) throws {
        delivery.withLock { $0 = Delivery(call: deliver, failed: failed) }
    }

    /// The microphone stops by itself, as an engine that cannot restart does.
    public func fail(_ reason: String) {
        guard let delivery = delivery.withLock({ value in defer { value = nil }; return value }) else { return }
        delivery.failed(reason)
    }

    public func stop() { delivery.withLock { $0 = nil } }
    public var isRunning: Bool { delivery.withLock { $0 != nil } }

    /// Delivers samples; false when the microphone is stopped (they are lost, as on iOS).
    @discardableResult
    public func push(_ samples: [Int16]) -> Bool {
        guard let delivery = delivery.withLock({ $0 }) else { return false }
        delivery.call(samples)
        return true
    }
}

/// A tone for the UI test and the fixture: no microphone, no permission prompt.
public final class ToneMicrophone: MicrophoneSource, @unchecked Sendable {
    private let timer = Mutex<DispatchSourceTimer?>(nil)
    private let hertz: Double
    public init(hertz: Double = 440) { self.hertz = hertz }

    public func start(
        _ deliver: @escaping @Sendable ([Int16]) -> Void, failed: @escaping @Sendable (String) -> Void
    ) throws {
        let source = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "sondine.tone"))
        let hertz = hertz
        let position = Mutex(0)
        source.schedule(deadline: .now(), repeating: .milliseconds(100))
        source.setEventHandler {
            let start = position.withLock { value in
                defer { value += 1_600 }
                return value
            }
            deliver(tone(hertz: hertz, from: start, count: 1_600))
        }
        timer.withLock { $0 = source }
        source.resume()
    }

    public func stop() { timer.withLock { $0?.cancel(); $0 = nil } }
}

/// `count` samples of a sine at `hertz`, from sample `from`, at a quarter of full scale.
public func tone(hertz: Double, from: Int, count: Int) -> [Int16] {
    (0..<count).map { index in
        Int16(8_000 * sin(2 * Double.pi * hertz * Double(from + index) / Double(phoneSampleRate)))
    }
}

public final class ScriptedDiskSpace: DiskSpace, @unchecked Sendable {
    private let bytes: Mutex<Int64?>
    public init(_ bytes: Int64? = 100_000_000_000) { self.bytes = Mutex(bytes) }
    public func availableBytes() -> Int64? { bytes.withLock { $0 } }
    public func set(_ value: Int64?) { bytes.withLock { $0 = value } }
}

public final class ScriptedClock: PhoneClock, @unchecked Sendable {
    private let now: Mutex<Int64>
    private let offset: Int
    public init(nowMs: Int64, utcOffsetMin: Int = 60) {
        now = Mutex(nowMs)
        offset = utcOffsetMin
    }

    public func nowMs() -> Int64 { now.withLock { $0 } }
    public func utcOffsetMin() -> Int { offset }
    public func advance(ms: Int64) { now.withLock { $0 += ms } }
}

public final class RecordedNotifications: PhoneNotifying, @unchecked Sendable {
    public enum Sent: Equatable, Sendable {
        case interrupted(atMs: Int64, cause: InterruptionCause)
        case stopped(atMs: Int64, end: RecordingEnd)
        case continues(sinceMs: Int64)
        case couldNotStart(PhoneRecorder.StartRefusal)
    }

    private let sent = Mutex<[Sent]>([])
    public init() {}
    public func recordingInterrupted(atMs: Int64, cause: InterruptionCause) {
        sent.withLock { $0.append(.interrupted(atMs: atMs, cause: cause)) }
    }

    public func recordingStopped(atMs: Int64, end: RecordingEnd) {
        sent.withLock { $0.append(.stopped(atMs: atMs, end: end)) }
    }

    public func recordingContinues(sinceMs: Int64) {
        sent.withLock { $0.append(.continues(sinceMs: sinceMs)) }
    }

    public func recordingCouldNotStart(_ refusal: PhoneRecorder.StartRefusal) {
        sent.withLock { $0.append(.couldNotStart(refusal)) }
    }

    public var all: [Sent] { sent.withLock { $0 } }
}
