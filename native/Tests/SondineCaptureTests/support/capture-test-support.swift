import Foundation
import SondineKit
import Synchronization
@testable import SondineCapture

/// A clock the test moves by hand. Host ticks are nanoseconds (timebase 1/1), so block times
/// and drain times share one scale.
final class ManualClock: HostClock, @unchecked Sendable {
    private let now = Mutex<(ns: UInt64, wallBase: UInt64)>((1_000_000_000, 1_800_000_000_000_000_000))

    var timebase: HostTimebase { HostTimebase(numer: 1, denom: 1) }

    func anchor() -> ClockAnchor {
        let (value, wallBase) = now.withLock { ($0.ns, $0.wallBase) }
        return ClockAnchor(hostTicks: value, continuousNs: value, wallNs: wallBase + value)
    }

    var nanoseconds: UInt64 { now.withLock { $0.ns } }

    func advance(seconds: Double) {
        now.withLock { $0.ns += UInt64(seconds * 1e9) }
    }

    /// Sets the wall clock to `date` now (the clock set, or a test starting at a given hour);
    /// host and continuous time go on.
    func setWall(_ date: Date) {
        now.withLock { $0.wallBase = UInt64(date.timeIntervalSince1970 * 1e9) - $0.ns }
    }

    var wall: Date { Date(timeIntervalSince1970: Double(anchor().wallNs) / 1e9) }
}

/// Records every helper event, in order.
final class EventRecorder: CaptureEventSink, @unchecked Sendable {
    private let events = Mutex<[HelperEvent]>([])

    func emit(_ event: HelperEvent) {
        events.withLock { $0.append(event) }
    }

    var all: [HelperEvent] { events.withLock { $0 } }

    func clear() { events.withLock { $0.removeAll() } }

    var trackOpens: [TrackOpenEvent] { all.compactMap { if case .trackOpen(let event) = $0 { event } else { nil } } }
    var trackCloses: [TrackCloseEvent] { all.compactMap { if case .trackClose(let event) = $0 { event } else { nil } } }
    var trackUpdates: [TrackUpdateEvent] { all.compactMap { if case .trackUpdate(let event) = $0 { event } else { nil } } }
    var warnings: [WarningEvent] { all.compactMap { if case .warning(let event) = $0 { event } else { nil } } }
    var errors: [ErrorEvent] { all.compactMap { if case .error(let event) = $0 { event } else { nil } } }
    var regionOpens: [RegionOpenEvent] { all.compactMap { if case .regionOpen(let event) = $0 { event } else { nil } } }
    var regionCloses: [RegionCloseEvent] { all.compactMap { if case .regionClose(let event) = $0 { event } else { nil } } }
    var holds: [HoldsEvent] { all.compactMap { if case .holds(let event) = $0 { event } else { nil } } }
    var situations: [SituationEvent] { all.compactMap { if case .situation(let event) = $0 { event } else { nil } } }
    var calls: [CallEvent] { all.compactMap { if case .call(let event) = $0 { event } else { nil } } }
    var selfEnvelopes: [SelfEnvelopeEvent] { all.compactMap { if case .selfEnvelope(let event) = $0 { event } else { nil } } }

    func acks(_ id: String) -> Int {
        all.filter { if case .ack(let event) = $0 { event.replyTo == id } else { false } }.count
    }
}

/// Process introspection replayed from rows recorded on a real Mac
/// (`sondine-scratch/capture/probe-output.txt`, M0 probe).
struct FixtureIntrospection: ProcessIntrospection {
    struct Row {
        var responsible: Int32?
        var parent: Int32?
        var path: String?
        var name: String?
        /// The app whose main executable this process runs.
        var app: AppBundle?
    }

    var rows: [Int32: Row]
    /// `false` simulates a system where the responsibility SPI is missing.
    var hasResponsibilitySPI = true
    var startTimes: [Int32: UInt64] = [:]

    func responsiblePID(_ pid: Int32) -> Int32? { hasResponsibilitySPI ? rows[pid]?.responsible : nil }
    func parentPID(_ pid: Int32) -> Int32? { rows[pid]?.parent }
    func startWallNs(_ pid: Int32) -> UInt64? { startTimes[pid] ?? 1_700_000_000_000_000_000 + UInt64(pid) }
    func executablePath(_ pid: Int32) -> String? { rows[pid]?.path }
    func processName(_ pid: Int32) -> String? { rows[pid]?.name }
    func runningApp(_ pid: Int32) -> AppBundle? { rows[pid]?.app }

    func enclosingApp(path: String) -> AppBundle? {
        for row in rows.values {
            guard let app = row.app, let rowPath = row.path, let range = rowPath.range(of: ".app/") else { continue }
            let bundlePath = rowPath[..<range.lowerBound] + ".app"
            if path.hasPrefix(bundlePath + "/") { return app }
        }
        return nil
    }

    static let empty = FixtureIntrospection(rows: [:])
}

/// A private temporary directory (mode 0700), removed on deinit. Short enough for a socket path.
final class ScratchDirectory {
    let url: URL

    init() throws {
        let base = URL(filePath: "/tmp", directoryHint: .isDirectory)
        url = base.appending(path: "sondine-test-\(UUID().uuidString.prefix(8))", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }

    var path: String { url.path(percentEncoded: false) }

    deinit { try? FileManager.default.removeItem(at: url) }
}

/// An engine on the fake HAL with timers off: tests drive drains, clocks and health by hand.
struct EngineHarness {
    let hal: FakeAudioHardware
    let clock = ManualClock()
    let recorder = EventRecorder()
    let permissions = FakePermissionProbe()
    let speechHold = FakeSpeechHold()
    let power = FakeSystemPowerEvents()
    let foreground: FakeForegroundApps
    let screen: FakeScreenState
    let networks: FakeNetworks
    let wallClock: FakeWallClock
    let directory: ScratchDirectory
    let engine: CaptureEngine

    init(
        hal: FakeAudioHardware = .macBook(),
        introspection: any ProcessIntrospection = FixtureIntrospection.empty,
        foreground: FakeForegroundApps = FakeForegroundApps(),
        screen: FakeScreenState = FakeScreenState(),
        networks: FakeNetworks = FakeNetworks(),
        timeZone: TimeZone = TimeZone(identifier: "Europe/Paris")!,
        configure: (inout CaptureOptions) -> Void = { _ in }
    ) throws {
        self.hal = hal
        self.foreground = foreground
        self.screen = screen
        self.networks = networks
        wallClock = FakeWallClock(timeZone: timeZone)
        directory = try ScratchDirectory()
        var options = CaptureOptions()
        options.timers = false
        options.activityDebounceSeconds = 0
        options.wakeSettleSeconds = 0
        options.ringSeconds = 30
        configure(&options)
        let environment = CaptureEnvironment(
            hal: hal,
            introspection: introspection,
            permissions: permissions,
            speechHold: speechHold,
            powerEvents: power,
            foreground: foreground,
            screen: screen,
            networks: networks,
            wallClock: wallClock,
            clock: clock,
            spoolRoot: directory.url.appending(path: "spool", directoryHint: .isDirectory),
            options: options
        )
        engine = CaptureEngine(environment: environment)
        engine.sink = recorder
    }

    /// Starts the engine and sends a config (capture starts with the first config).
    func start(_ config: CaptureConfig = CaptureConfig()) {
        engine.start()
        send(.config(id: "config", config))
    }

    func send(_ message: ControlMessage) {
        engine.handle(message)
        settle()
    }

    /// Waits for listener callbacks, which may queue more work behind them.
    func settle() {
        for _ in 0..<4 { engine.sync() }
    }

    /// One microphone block of `seconds` at `rate`, starting at the clock's current time, then
    /// the clock moves on and the engine drains.
    func feedMicrophone(uid: String = "BuiltInMicrophoneDevice", seconds: Double, rate: Double = 48_000, amplitude: Float = 0.01) {
        let frames = Int(seconds * rate)
        let samples = Self.noise(frames: frames, amplitude: amplitude)
        hal.deliver(toDevice: uid, interleaved: samples, channels: 1, hostTicks: clock.nanoseconds)
        clock.advance(seconds: seconds)
        engine.drainNow()
    }

    func feedSystem(seconds: Double, rate: Double = 48_000, amplitude: Float = 0) {
        let frames = Int(seconds * rate)
        let samples = amplitude == 0 ? [Float](repeating: 0, count: frames) : Self.noise(frames: frames, amplitude: amplitude)
        hal.deliverToTap(named: "Sondine system:other", samples: samples, hostTicks: clock.nanoseconds)
        clock.advance(seconds: seconds)
        engine.drainNow()
    }

    static func noise(frames: Int, amplitude: Float) -> [Float] {
        var generator = SplitMix(seed: 42)
        return (0..<frames).map { _ in (Float(generator.next() % 2_001) / 1_000 - 1) * amplitude }
    }
}

struct SplitMix {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var value = state
        value = (value ^ (value >> 30)) &* 0xBF58_476D_1CE4_E5B9
        value = (value ^ (value >> 27)) &* 0x94D0_49BB_1331_11EB
        return value ^ (value >> 31)
    }
}

enum CapturePaths {
    /// native/
    static let native = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
    static let protocolFixtures = native.deletingLastPathComponent().appending(path: "packages/protocol/fixtures")
    static var hasProtocolFixtures: Bool {
        FileManager.default.fileExists(atPath: protocolFixtures.appending(path: "helper-events.jsonl").path(percentEncoded: false))
    }

    static func lines(_ name: String) throws -> [String] {
        try String(contentsOf: protocolFixtures.appending(path: name), encoding: .utf8)
            .split(separator: "\n", omittingEmptySubsequences: true)
            .map(String.init)
    }
}
