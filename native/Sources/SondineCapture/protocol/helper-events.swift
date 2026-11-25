import Foundation
import SondineKit

// Helper → core events (`packages/protocol/src/helper-events.ts`). Optional fields (`replyTo`,
// `trackKey` on problems) are omitted when nil; nullable fields use `@Nullable`.

public struct VersionPair: Codable, Sendable, Equatable {
    public var version: String
    public var build: String

    public init(version: String, build: String) {
        self.version = version
        self.build = build
    }
}

public struct PausedState: Codable, Sendable, Equatable {
    public var microphone: Bool
    public var systemAudio: Bool

    public init(microphone: Bool = false, systemAudio: Bool = false) {
        self.microphone = microphone
        self.systemAudio = systemAudio
    }
}

public struct ReadyEvent: Codable, Sendable, Equatable {
    public struct Capabilities: Codable, Sendable, Equatable {
        public struct Vad: Codable, Sendable, Equatable {
            public var engine: String
            public var version: String
        }

        public var appTaps: Bool
        public var maxAppTaps: Int
        public var vad: Vad
    }

    public var replyTo: String
    public var protocolVersion: Int
    public var sessionId: String
    public var helper: VersionPair
    public var os: VersionPair
    public var timebase: WireTimebase
    public var paused: PausedState
    public var capabilities: Capabilities

    enum CodingKeys: String, CodingKey {
        case replyTo, sessionId, helper, os, timebase, paused, capabilities
        case protocolVersion = "protocol"
    }
}

public struct AckEvent: Codable, Sendable, Equatable {
    public var replyTo: String
}

public struct PermissionState: Codable, Sendable, Equatable {
    public var status: PermissionStatus
    public var evidence: PermissionEvidence

    public init(status: PermissionStatus, evidence: PermissionEvidence) {
        self.status = status
        self.evidence = evidence
    }

    public static let notChecked = PermissionState(status: .unknown, evidence: .notChecked)
}

public struct PermissionsEvent: Codable, Sendable, Equatable {
    public var replyTo: String?
    public var microphone: PermissionState
    public var systemAudio: PermissionState
}

public struct AudioDeviceEntry: Codable, Sendable, Equatable {
    public var uid: String
    public var name: String
    public var transport: Transport
    @Nullable public var transportCode: String?
    public var input: Bool
    public var output: Bool
    public var alive: Bool
    @Nullable public var nominalRate: Double?
    @Nullable public var dataSource: String?
    public var loopback: Bool
}

public struct DevicesEvent: Codable, Sendable, Equatable {
    public var replyTo: String?
    @Nullable public var defaultInputUid: String?
    @Nullable public var defaultOutputUid: String?
    public var devices: [AudioDeviceEntry]
}

public struct AppIdentity: Codable, Sendable, Equatable {
    public var bundleId: String
    @Nullable public var name: String?

    public init(bundleId: String, name: String?) {
        self.bundleId = bundleId
        self.name = name
    }
}

public struct ProcessMapping: Codable, Sendable, Equatable {
    public var evidence: MappingEvidence
    public var confidence: MappingConfidence
    public var viaTerminal: Bool
}

public struct AudioProcessEntry: Codable, Sendable, Equatable {
    public var objectId: UInt32
    public var pid: Int32
    @Nullable public var startWallNs: ClockValue?
    @Nullable public var halBundleId: String?
    @Nullable public var app: AppIdentity?
    @Nullable public var mapping: ProcessMapping?
    @Nullable public var trackKey: String?
    @Nullable public var excluded: ProcessExclusion?
}

public struct ProcessesEvent: Codable, Sendable, Equatable {
    public var replyTo: String?
    public var processes: [AudioProcessEntry]
}

public struct WireAudioFormat: Codable, Sendable, Equatable {
    public var rate = 16_000
    public var channels = 1
    public var sampleFormat = "s16le"

    public init() {}
}

public struct InputSource: Codable, Sendable, Equatable {
    public var deviceUid: String
    public var name: String
    public var transport: Transport
    public var selection: InputSelection
}

public struct AppSource: Codable, Sendable, Equatable {
    public var bundleId: String
    @Nullable public var name: String?
    public var objectIds: [UInt32]
}

public struct SystemSource: Codable, Sendable, Equatable {
    public var excludedObjectIds: [UInt32]
}

/// What a track captures, discriminated on `kind`.
public enum TrackSource: Codable, Sendable, Equatable {
    case input(InputSource)
    case app(AppSource)
    case system(SystemSource)

    private enum KindKey: String, CodingKey { case kind }

    public var trackKey: String {
        switch self {
        case .input(let source): TrackKeys.input(source.deviceUid)
        case .app(let source): TrackKeys.app(source.bundleId)
        case .system: TrackKeys.system
        }
    }

    public init(from decoder: any Decoder) throws {
        let kind = try decoder.container(keyedBy: KindKey.self).decode(String.self, forKey: .kind)
        switch kind {
        case "input": self = .input(try InputSource(from: decoder))
        case "app": self = .app(try AppSource(from: decoder))
        case "system": self = .system(try SystemSource(from: decoder))
        default: throw ProtocolError("unknown track source kind \"\(kind)\"")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        let kind: String
        switch self {
        case .input(let source):
            try source.encode(to: encoder)
            kind = "input"
        case .app(let source):
            try source.encode(to: encoder)
            kind = "app"
        case .system(let source):
            try source.encode(to: encoder)
            kind = "system"
        }
        var container = encoder.container(keyedBy: KindKey.self)
        try container.encode(kind, forKey: .kind)
    }
}

public struct TrackOpenEvent: Codable, Sendable, Equatable {
    public var replyTo: String?
    public var trackKey: String
    public var runId: String
    public var epoch: UInt32
    public var start: ClockPoint
    public var anchor: WireClockAnchor
    public var format = WireAudioFormat()
    public var nominalRate: Double
    @Nullable public var measuredRate: Double?
    public var stream: StreamState
    public var source: TrackSource
}

public struct TrackUpdateEvent: Codable, Sendable, Equatable {
    public var replyTo: String?
    public var trackKey: String
    public var runId: String
    public var epoch: UInt32
    public var reason: TrackUpdateReason
    public var sampleIndex: Int64
    public var at: ClockPoint
    public var nominalRate: Double
    @Nullable public var measuredRate: Double?
    public var stream: StreamState
    public var source: TrackSource
}

public struct TrackCloseEvent: Codable, Sendable, Equatable {
    public var replyTo: String?
    public var trackKey: String
    public var runId: String
    public var epoch: UInt32
    public var endSample: Int64
    public var at: ClockPoint
    public var reason: TrackEndReason
}

public struct RegionOpenEvent: Codable, Sendable, Equatable {
    public var replyTo: String?
    public var regionId: String
    public var trackKey: String
    public var runId: String
    public var epoch: UInt32
    public var startSample: Int64
    public var at: ClockPoint
}

public struct RegionCloseEvent: Codable, Sendable, Equatable {
    public var replyTo: String?
    public var trackKey: String
    public var runId: String
    public var regionId: String
    public var startSample: Int64
    public var endSample: Int64
    /// Samples the VAD heard as speech between the bounds (pauses excluded).
    public var voicedSamples: Int64?
    public var closeReason: RegionCloseReason
    public var speechProbability: SpeechProbabilityStats
    public var level: LevelStats
    public var at: ClockPoint
    /// The apps in front on the Mac while it lasted, in time order (ADR 022).
    public var foreground: [ForegroundSpan]
}

/// The app in front on the Mac over part of a speech region, in the run's samples: the region
/// is cut at each change, and a stretch without an app is left out (ADR 022).
public struct ForegroundSpan: Codable, Sendable, Equatable {
    public var bundleId: String
    public var name: String
    public var startSample: Int64
    public var endSample: Int64

    public init(bundleId: String, name: String, startSample: Int64, endSample: Int64) {
        self.bundleId = bundleId
        self.name = name
        self.startSample = startSample
        self.endSample = endSample
    }
}

public struct CommitEvent: Codable, Sendable, Equatable {
    public var replyTo: String?
    public var trackKey: String
    public var runId: String
    public var file: String
    public var seq: Int64
    public var epoch: UInt32
    public var committedOffset: Int64
    public var sampleIndex: Int64
    public var sampleCount: Int64
    public var crc32: UInt32
    public var at: ClockPoint
    public var gaps: [GapSpan]
}

public struct RunningProcess: Codable, Sendable, Equatable {
    public var objectId: UInt32
    public var output: Bool
    public var input: Bool
    public var inputDeviceUids: [String]
}

public struct TrackAttribution: Codable, Sendable, Equatable {
    public var trackKey: String
    public var runId: String
    public var confidence: AttributionConfidence
    @Nullable public var bundleId: String?
    public var candidateObjectIds: [UInt32]
}

public struct ActivityEvent: Codable, Sendable, Equatable {
    public var replyTo: String?
    public var at: ClockPoint
    public var running: [RunningProcess]
    public var attribution: [TrackAttribution]
}

/// A call app, a call daemon, or a browser started or stopped using a microphone (`CallTracker`).
public struct CallEvent: Codable, Sendable, Equatable {
    public enum State: String, Codable, Sendable, Equatable { case active, ended }
    public enum Via: String, Codable, Sendable, Equatable {
        case callApp = "call-app"
        case callDaemon = "call-daemon"
        case browser
    }

    public var replyTo: String?
    public var callId: String
    public var state: State
    public var at: ClockPoint
    public var bundleId: String
    public var via: Via
    @Nullable public var inputDeviceUid: String?
}

/// An app other than a call started or stopped listening to a microphone (`ListenTracker`).
public struct ListenEvent: Codable, Sendable, Equatable {
    public enum State: String, Codable, Sendable, Equatable { case active, ended }
    public enum Via: String, Codable, Sendable, Equatable {
        case app
        /// The system's speech recognition, Siri, or accessibility listening.
        case speech
    }

    public var replyTo: String?
    public var listenId: String
    public var state: State
    public var at: ClockPoint
    public var bundleId: String
    public var via: Via
}

/// A call the helper sees whether Sondine listens or not (ADR 036, `seenCalls`): core offers
/// listening to it during a pause, and pauses again when it ends. Never a call span.
public struct CallSeenEvent: Codable, Sendable, Equatable {
    public var replyTo: String?
    public var callId: String
    public var state: CallEvent.State
    public var at: ClockPoint
    public var bundleId: String
    @Nullable public var name: String?
    public var via: CallEvent.Via
}

/// The Mac's situation for core's zones (ADR 029): the screen away, and the keyed hashes of the
/// networks it is on (sorted).
public struct SituationEvent: Codable, Sendable, Equatable {
    public var replyTo: String?
    public var screenAway: Bool
    public var networks: [String]

    public init(replyTo: String? = nil, screenAway: Bool, networks: [String]) {
        self.replyTo = replyTo
        self.screenAway = screenAway
        self.networks = networks
    }
}

public enum HoldReason: String, Codable, Sendable, Equatable, CaseIterable {
    case app, calls, screen, schedule, network
}

public enum HoldScope: String, Codable, Sendable, Equatable, CaseIterable {
    case all, microphone
}

/// One occurrence of a hold, from its trigger's start to its end.
public struct HoldOccurrence: Codable, Sendable, Equatable {
    public var occurrenceId: String
    public var reason: HoldReason
    public var scope: HoldScope
    public var bundleId: String?
    public var network: String?
    public var window: Int?
    public var since: ClockPoint
    public var sinceWallMs: Int64
    public var lifted: Bool
}

/// Every hold active now, lifted ones included.
public struct HoldsEvent: Codable, Sendable, Equatable {
    public var replyTo: String?
    public var holds: [HoldOccurrence]

    public init(replyTo: String? = nil, holds: [HoldOccurrence]) {
        self.replyTo = replyTo
        self.holds = holds
    }
}

public struct ClockEvent: Codable, Sendable, Equatable {
    public var replyTo: String?
    public var reason: ClockReason
    public var anchor: WireClockAnchor
}

/// The private `self:playback` reference (ADR 035): the 10 ms energy of what Sondine plays, in
/// tenths of a dBFS (-1200 to 0), contiguous from `start`. Never replayed in a snapshot.
public struct SelfEnvelopeEvent: Codable, Sendable, Equatable {
    public static let maxFrames = 600

    public var replyTo: String?
    public var start: ClockPoint
    public var levels: [Int]

    public init(replyTo: String? = nil, start: ClockPoint, levels: [Int]) {
        self.replyTo = replyTo
        self.start = start
        self.levels = levels
    }
}

public struct ProcessCost: Codable, Sendable, Equatable {
    public var footprintBytes: UInt64
    public var cpuNs: UInt64
    public var wakeups: UInt64
}

public struct TrackHealth: Codable, Sendable, Equatable {
    public var trackKey: String
    public var runId: String
    public var stream: StreamState
    @Nullable public var measuredRate: Double?
    @Nullable public var level: Double?
    public var zeroRunMs: Int64
    public var ringHighWaterMs: Int64
    public var ringOverflows: UInt64
    public var droppedSamples: UInt64
    public var overloads: UInt64
}

public struct StageHistogram: Codable, Sendable, Equatable {
    public var stage: HealthStage
    @Nullable public var trackKey: String?
    public var count: UInt64
    public var sum: UInt64
    public var p50: UInt64
    public var p95: UInt64
    public var max: UInt64
}

public struct HealthEvent: Codable, Sendable, Equatable {
    public var replyTo: String?
    public var at: ClockPoint
    public var windowMs: Int64
    public var process: ProcessCost
    public var tracks: [TrackHealth]
    public var stages: [StageHistogram]
}

public struct WarningEvent: Codable, Sendable, Equatable {
    public var replyTo: String?
    public var code: String
    public var message: String
    public var trackKey: String?
}

public struct ErrorEvent: Codable, Sendable, Equatable {
    public var replyTo: String?
    public var code: ErrorCode
    public var message: String
    public var fatal: Bool
    public var trackKey: String?
}

/// Every helper → core event, discriminated on `type`.
public enum HelperEvent: Codable, Sendable, Equatable {
    case ready(ReadyEvent)
    case ack(AckEvent)
    case permissions(PermissionsEvent)
    case devices(DevicesEvent)
    case processes(ProcessesEvent)
    case trackOpen(TrackOpenEvent)
    case trackUpdate(TrackUpdateEvent)
    case trackClose(TrackCloseEvent)
    case regionOpen(RegionOpenEvent)
    case regionClose(RegionCloseEvent)
    case commit(CommitEvent)
    case activity(ActivityEvent)
    case call(CallEvent)
    case listen(ListenEvent)
    case callSeen(CallSeenEvent)
    case situation(SituationEvent)
    case holds(HoldsEvent)
    case clock(ClockEvent)
    case selfEnvelope(SelfEnvelopeEvent)
    case health(HealthEvent)
    case warning(WarningEvent)
    case error(ErrorEvent)

    private enum TypeKey: String, CodingKey { case type }

    public var type: String {
        switch self {
        case .ready: "ready"
        case .ack: "ack"
        case .permissions: "permissions"
        case .devices: "devices"
        case .processes: "processes"
        case .trackOpen: "track.open"
        case .trackUpdate: "track.update"
        case .trackClose: "track.close"
        case .regionOpen: "region.open"
        case .regionClose: "region.close"
        case .commit: "commit"
        case .activity: "activity"
        case .call: "call"
        case .listen: "listen"
        case .callSeen: "call.seen"
        case .situation: "situation"
        case .holds: "holds"
        case .clock: "clock"
        case .selfEnvelope: "self.envelope"
        case .health: "health"
        case .warning: "warning"
        case .error: "error"
        }
    }

    public var replyTo: String? {
        switch self {
        case .ready(let event): event.replyTo
        case .ack(let event): event.replyTo
        case .permissions(let event): event.replyTo
        case .devices(let event): event.replyTo
        case .processes(let event): event.replyTo
        case .trackOpen(let event): event.replyTo
        case .trackUpdate(let event): event.replyTo
        case .trackClose(let event): event.replyTo
        case .regionOpen(let event): event.replyTo
        case .regionClose(let event): event.replyTo
        case .commit(let event): event.replyTo
        case .activity(let event): event.replyTo
        case .call(let event): event.replyTo
        case .listen(let event): event.replyTo
        case .callSeen(let event): event.replyTo
        case .situation(let event): event.replyTo
        case .holds(let event): event.replyTo
        case .clock(let event): event.replyTo
        case .selfEnvelope(let event): event.replyTo
        case .health(let event): event.replyTo
        case .warning(let event): event.replyTo
        case .error(let event): event.replyTo
        }
    }

    /// The same event answering `id` (snapshot replays, and the server's request routing).
    public func replying(to id: String) -> HelperEvent {
        func with<T>(_ value: T, _ apply: (inout T) -> Void) -> T {
            var copy = value
            apply(&copy)
            return copy
        }
        switch self {
        case .ready(let event): return .ready(with(event) { $0.replyTo = id })
        case .ack(let event): return .ack(with(event) { $0.replyTo = id })
        case .permissions(let event): return .permissions(with(event) { $0.replyTo = id })
        case .devices(let event): return .devices(with(event) { $0.replyTo = id })
        case .processes(let event): return .processes(with(event) { $0.replyTo = id })
        case .trackOpen(let event): return .trackOpen(with(event) { $0.replyTo = id })
        case .trackUpdate(let event): return .trackUpdate(with(event) { $0.replyTo = id })
        case .trackClose(let event): return .trackClose(with(event) { $0.replyTo = id })
        case .regionOpen(let event): return .regionOpen(with(event) { $0.replyTo = id })
        case .regionClose(let event): return .regionClose(with(event) { $0.replyTo = id })
        case .commit(let event): return .commit(with(event) { $0.replyTo = id })
        case .activity(let event): return .activity(with(event) { $0.replyTo = id })
        case .call(let event): return .call(with(event) { $0.replyTo = id })
        case .listen(let event): return .listen(with(event) { $0.replyTo = id })
        case .callSeen(let event): return .callSeen(with(event) { $0.replyTo = id })
        case .situation(let event): return .situation(with(event) { $0.replyTo = id })
        case .holds(let event): return .holds(with(event) { $0.replyTo = id })
        case .clock(let event): return .clock(with(event) { $0.replyTo = id })
        case .selfEnvelope(let event): return .selfEnvelope(with(event) { $0.replyTo = id })
        case .health(let event): return .health(with(event) { $0.replyTo = id })
        case .warning(let event): return .warning(with(event) { $0.replyTo = id })
        case .error(let event): return .error(with(event) { $0.replyTo = id })
        }
    }

    public init(from decoder: any Decoder) throws {
        let type = try decoder.container(keyedBy: TypeKey.self).decode(String.self, forKey: .type)
        switch type {
        case "ready": self = .ready(try ReadyEvent(from: decoder))
        case "ack": self = .ack(try AckEvent(from: decoder))
        case "permissions": self = .permissions(try PermissionsEvent(from: decoder))
        case "devices": self = .devices(try DevicesEvent(from: decoder))
        case "processes": self = .processes(try ProcessesEvent(from: decoder))
        case "track.open": self = .trackOpen(try TrackOpenEvent(from: decoder))
        case "track.update": self = .trackUpdate(try TrackUpdateEvent(from: decoder))
        case "track.close": self = .trackClose(try TrackCloseEvent(from: decoder))
        case "region.open": self = .regionOpen(try RegionOpenEvent(from: decoder))
        case "region.close": self = .regionClose(try RegionCloseEvent(from: decoder))
        case "commit": self = .commit(try CommitEvent(from: decoder))
        case "activity": self = .activity(try ActivityEvent(from: decoder))
        case "call": self = .call(try CallEvent(from: decoder))
        case "listen": self = .listen(try ListenEvent(from: decoder))
        case "call.seen": self = .callSeen(try CallSeenEvent(from: decoder))
        case "situation": self = .situation(try SituationEvent(from: decoder))
        case "holds": self = .holds(try HoldsEvent(from: decoder))
        case "clock": self = .clock(try ClockEvent(from: decoder))
        case "self.envelope": self = .selfEnvelope(try SelfEnvelopeEvent(from: decoder))
        case "health": self = .health(try HealthEvent(from: decoder))
        case "warning": self = .warning(try WarningEvent(from: decoder))
        case "error": self = .error(try ErrorEvent(from: decoder))
        default: throw ProtocolError("unknown event type \"\(type)\"")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .ready(let event): try event.encode(to: encoder)
        case .ack(let event): try event.encode(to: encoder)
        case .permissions(let event): try event.encode(to: encoder)
        case .devices(let event): try event.encode(to: encoder)
        case .processes(let event): try event.encode(to: encoder)
        case .trackOpen(let event): try event.encode(to: encoder)
        case .trackUpdate(let event): try event.encode(to: encoder)
        case .trackClose(let event): try event.encode(to: encoder)
        case .regionOpen(let event): try event.encode(to: encoder)
        case .regionClose(let event): try event.encode(to: encoder)
        case .commit(let event): try event.encode(to: encoder)
        case .activity(let event): try event.encode(to: encoder)
        case .call(let event): try event.encode(to: encoder)
        case .listen(let event): try event.encode(to: encoder)
        case .callSeen(let event): try event.encode(to: encoder)
        case .situation(let event): try event.encode(to: encoder)
        case .holds(let event): try event.encode(to: encoder)
        case .clock(let event): try event.encode(to: encoder)
        case .selfEnvelope(let event): try event.encode(to: encoder)
        case .health(let event): try event.encode(to: encoder)
        case .warning(let event): try event.encode(to: encoder)
        case .error(let event): try event.encode(to: encoder)
        }
        var container = encoder.container(keyedBy: TypeKey.self)
        try container.encode(type, forKey: .type)
    }

    /// One JSON line, newline included.
    public func encodedLine() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(self)
        guard data.count <= HelperProtocol.maxLineBytes else { throw ProtocolError("\(type) event exceeds the line limit") }
        data.append(0x0A)
        return data
    }

    // Constructors for the events the helper sends most.

    public static func warning(_ code: String, _ message: String, trackKey: String? = nil, replyTo: String? = nil) -> HelperEvent {
        .warning(WarningEvent(replyTo: replyTo, code: code, message: WireText.sanitized(message, maxUnits: 1_024) ?? code, trackKey: trackKey))
    }

    public static func error(
        _ code: ErrorCode,
        _ message: String,
        fatal: Bool = false,
        trackKey: String? = nil,
        replyTo: String? = nil
    ) -> HelperEvent {
        .error(ErrorEvent(replyTo: replyTo, code: code, message: WireText.sanitized(message, maxUnits: 1_024) ?? code.rawValue, fatal: fatal, trackKey: trackKey))
    }

    public static func ack(_ id: String) -> HelperEvent { .ack(AckEvent(replyTo: id)) }
}

public struct ProtocolError: Error, Equatable, CustomStringConvertible {
    public var message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}
