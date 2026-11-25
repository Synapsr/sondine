import Foundation
import SondineKit

/// Receives every helper event, in order. Implementations must be thread-safe.
public protocol CaptureEventSink: AnyObject, Sendable {
    func emit(_ event: HelperEvent)
}

public struct CaptureOptions: Sendable {
    /// Drain cadence of the utility-QoS worker: 256 ms by default, 100 ms for a live view.
    public var drainIntervalMs = 256
    public var clockIntervalSeconds = 10.0
    /// IO buffer duration. 85 ms is 4096 frames at 48 kHz: about 12 IO wakeups per second per
    /// device instead of 94 with the 512-frame default, and well inside the ring's margin.
    public var ioBufferSeconds = 0.085
    /// Ring capacity in seconds of device audio.
    public var ringSeconds = 10.0
    /// Release the in-person sleep hold this long after the last mic speech (ADR 007 in-person gap).
    public var inPersonGapSeconds = 45.0
    /// Wait after wake before rebuilding devices and taps.
    public var wakeSettleSeconds = 2.0
    /// Debounce of `activity` events.
    public var activityDebounceSeconds = 0.5
    /// Timers drive drains, clocks, health and debounces; tests turn them off and drive by hand.
    public var timers = true
    public var helperVersion = "0.1.0"
    public var helperBuild = "1"
    public var spoolConfiguration = SpoolConfiguration()
    /// Recover the spool (truncate torn commits) before writing.
    public var recoverSpool = true
    /// With app taps on, `system:other` stops this long after nothing in its scope plays.
    public var residualHoldSeconds = 5.0
    /// Tap Sondine's own playback as the `self:playback` reference (ADR 035).
    public var selfPlayback = true
    /// The microphone follows a call's input device this long after the call ends.
    public var callFollowHoldSeconds = 10.0
    /// A call, or an excluded app's call or listen, holds capture this long after it ends (ADR 029).
    public var holdAfterCallSeconds = 10.0
    /// A network hold outlasts a network gone for a moment (a Wi-Fi drop) by this long...
    public var networkLingerSeconds = 10.0
    /// ...and lasts at least this long after a wake, while the network comes back.
    public var networkWakeGraceSeconds = 60.0

    public init() {}

    /// The IO buffer size for a device rate: a power of two near `ioBufferSeconds`, clamped to
    /// what the device allows.
    public func bufferFrames(rate: Double, range: ClosedRange<UInt32>?) -> UInt32 {
        let target = max(64, rate * ioBufferSeconds)
        let frames = UInt32(1) << UInt32(log2(target).rounded())
        guard let range else { return frames }
        return min(max(frames, range.lowerBound), range.upperBound)
    }
}

/// Everything the engine depends on, so tests can swap the HAL, the OS, time, and the VAD.
public struct CaptureEnvironment: @unchecked Sendable {
    public var hal: any AudioHardware
    public var introspection: any ProcessIntrospection
    public var permissions: any PermissionProbe
    public var speechHold: any SpeechHold
    public var powerEvents: any SystemPowerEvents
    /// Which app is in front, to place speech in context (ADR 022).
    public var foreground: any ForegroundAppSource
    /// Whether the screen is away, the networks the Mac is on, and its time zone: what private
    /// zones hold capture on (ADR 029).
    public var screen: any ScreenStateSource
    public var networks: any NetworkSource
    public var wallClock: any WallClockSource
    public var clock: any HostClock
    public var spoolRoot: URL
    /// A new VAD stream with its own state: one for the microphone, one for `system:other`, one
    /// per open app track (the serving helper shares one model between them).
    public var makeDetector: (TrackKind) -> (any VoiceActivityDetector)?
    public var vad: (engine: String, version: String)
    public var makeFileSystem: () -> any SpoolFileSystem
    public var options: CaptureOptions
    /// Our own pid: excluded from every tap (reading HAL properties registers a process object).
    public var ownPID: Int32

    public init(
        hal: any AudioHardware,
        introspection: any ProcessIntrospection,
        permissions: any PermissionProbe,
        speechHold: any SpeechHold,
        powerEvents: any SystemPowerEvents,
        foreground: any ForegroundAppSource = NoForegroundApps(),
        screen: any ScreenStateSource = NoScreenState(),
        networks: any NetworkSource = NoNetworks(),
        wallClock: any WallClockSource = SystemWallClock(),
        clock: any HostClock = MachHostClock(),
        spoolRoot: URL,
        makeDetector: @escaping (TrackKind) -> (any VoiceActivityDetector)? = { _ in nil },
        vad: (engine: String, version: String) = ("energy-gate", "1"),
        makeFileSystem: @escaping () -> any SpoolFileSystem = { PosixSpoolFileSystem() },
        options: CaptureOptions = CaptureOptions(),
        ownPID: Int32 = getpid()
    ) {
        self.hal = hal
        self.introspection = introspection
        self.permissions = permissions
        self.speechHold = speechHold
        self.powerEvents = powerEvents
        self.foreground = foreground
        self.screen = screen
        self.networks = networks
        self.wallClock = wallClock
        self.clock = clock
        self.spoolRoot = spoolRoot
        self.makeDetector = makeDetector
        self.vad = vad
        self.makeFileSystem = makeFileSystem
        self.options = options
        self.ownPID = ownPID
    }
}

/// A point-in-time view of the engine for tests and diagnostics.
public struct CaptureState: Sendable, Equatable {
    public var configured = false
    public var paused = PausedState()
    public var microphoneUid: String?
    public var microphoneSelection: InputSelection?
    public var microphoneRunId: String?
    public var microphoneNominalRate: Double?
    public var microphoneResamplerRebuilds = 0
    public var microphoneMuted = false
    public var systemRunId: String?
    public var systemExcludedObjects: [HALObjectID] = []
    public var systemStream: StreamState?
    public var systemRebuilds = 0
    public var speechHoldActive = false
    public var permissions = PermissionTracker()
    public var processObjects = 0
    public var asleep = false
    /// Changes of the app in front the engine keeps (ADR 022): the last 30 s while nobody speaks.
    public var foregroundChanges = 0
    /// App taps (ADR 026), by bundle id.
    public var appTracks: [AppTrack] = []
    /// The microphone follows this call device.
    public var callFollowUid: String?
    /// Private zones (ADR 029): the holds active now, and what they hold.
    public var holds: [HoldOccurrence] = []
    public var heldMicrophone = false
    public var heldEverything = false
    public var screenAway = false
    /// Keyed hashes of the networks the Mac is on, sorted.
    public var networks: [String] = []

    public struct AppTrack: Sendable, Equatable {
        public var bundleId: String
        public var objects: [HALObjectID]
        public var runId: String?
        /// Its objects are out of `system:other` (its first block arrived).
        public var leftResidual: Bool
    }
}
