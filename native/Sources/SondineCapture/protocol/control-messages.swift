import Foundation

// Core → helper messages (`packages/protocol/src/control-messages.ts`), decoded strictly:
// unknown keys, wrong types, out-of-range values and duplicates are rejected, as zod does.

public struct ClientInfo: Sendable, Equatable {
    public var name: String
    public var version: String

    public init(name: String, version: String) {
        self.name = name
        self.version = version
    }
}

/// The full capture policy (`config`); it replaces the previous one.
public struct CaptureConfig: Sendable, Equatable {
    public struct Microphone: Sendable, Equatable {
        public var enabled = true
        public var followCalls = true
        public var allowedTransports = Transport.defaultAllowlist
        public init() {}
    }

    public struct AppTaps: Sendable, Equatable {
        public var enabled = false
        public var max = 8
        public var releaseAfterIdleMs = 30_000
        public var releaseAfterSilenceMs = 120_000
        public init() {}
    }

    public struct SystemAudio: Sendable, Equatable {
        public var enabled = true
        public var appTaps = AppTaps()
        public init() {}
    }

    public struct Vad: Sendable, Equatable {
        public var threshold = 0.5
        public var minSpeechMs = 250
        public var minSilenceMs = 800
        public init() {}
    }

    /// Hours when capture is held, on the Mac's clock (ADR 029). An end at or before the start
    /// crosses midnight; the window then belongs to its start day.
    public struct ScheduleWindow: Sendable, Equatable, Hashable {
        /// 0 is Sunday … 6 Saturday.
        public var days: [Int]
        public var startMinute: Int
        public var endMinute: Int

        public init(days: [Int], startMinute: Int, endMinute: Int) {
            self.days = days
            self.startMinute = startMinute
            self.endMinute = endMinute
        }
    }

    /// Private zones at « Rien » the helper enforces itself (ADR 029).
    public struct Holds: Sendable, Equatable {
        public var calls = false
        public var screen = false
        public var schedule: [ScheduleWindow] = []
        /// Keyed hashes of networks.
        public var networks: [String] = []
        /// Base64 of the 32-byte key, or empty: no network is read.
        public var networkKey = ""
        /// Occurrences the user lifted.
        public var lifted: [String] = []
        public init() {}

        /// The key's bytes; nil without one.
        public var networkKeyBytes: Data? { networkKey.isEmpty ? nil : Data(base64Encoded: networkKey) }
    }

    public var microphone = Microphone()
    public var systemAudio = SystemAudio()
    public var excludedBundleIds: [String] = []
    public var holds = Holds()
    public var vad = Vad()
    public var healthIntervalMs = 60_000

    public init() {}
}

public enum ControlMessage: Sendable, Equatable {
    case hello(id: String, client: ClientInfo)
    case config(id: String, CaptureConfig)
    case excludePids(id: String, pids: [Int32])
    case pinInput(id: String, deviceUid: String?, allowBluetooth: Bool)
    case pause(id: String, scope: PauseScope)
    case resume(id: String, scope: PauseScope)
    case snapshot(id: String)
    case shutdown(id: String)
    /// Asks for the microphone prompt (`AVCaptureDevice.requestAccess`) or the system-audio
    /// prompt (a probe tap start).
    case requestPermissions(id: String, scope: PauseScope)

    public static let types = [
        "hello", "config", "exclude.pids", "pin.input", "pause", "resume", "snapshot", "shutdown", "request.permissions",
    ]

    public var id: String {
        switch self {
        case .hello(let id, _), .config(let id, _), .excludePids(let id, _), .pinInput(let id, _, _),
             .pause(let id, _), .resume(let id, _), .snapshot(let id), .shutdown(let id), .requestPermissions(let id, _):
            id
        }
    }

    public var type: String {
        switch self {
        case .hello: "hello"
        case .config: "config"
        case .excludePids: "exclude.pids"
        case .pinInput: "pin.input"
        case .pause: "pause"
        case .resume: "resume"
        case .snapshot: "snapshot"
        case .shutdown: "shutdown"
        case .requestPermissions: "request.permissions"
        }
    }
}

/// Why a line was rejected, with whatever request id could be read to address the reply.
public struct ControlDecodeFailure: Error, Sendable, Equatable {
    public var id: String?
    public var type: String?
    public var code: ErrorCode
    public var message: String
}

extension ControlMessage {
    /// Decodes one line (newline excluded).
    public static func decode(line: Data) -> Result<ControlMessage, ControlDecodeFailure> {
        guard line.count <= HelperProtocol.maxLineBytes else {
            return .failure(ControlDecodeFailure(id: nil, type: nil, code: .requestInvalid, message: "line exceeds 1 MiB"))
        }
        let parsed: Any
        do {
            parsed = try JSONSerialization.jsonObject(with: line, options: [])
        } catch {
            return .failure(ControlDecodeFailure(id: nil, type: nil, code: .requestInvalid, message: "invalid JSON"))
        }
        guard let dictionary = parsed as? [String: Any] else {
            return .failure(ControlDecodeFailure(id: nil, type: nil, code: .requestInvalid, message: "a message is a JSON object"))
        }
        let rawId = (dictionary["id"] as? String).flatMap { WireText.isRequestId($0) ? $0 : nil }
        let rawType = dictionary["type"] as? String
        do {
            let object = WireObject(dictionary, path: "")
            return .success(try decode(object, type: rawType))
        } catch let failure as WireFailure {
            return .failure(ControlDecodeFailure(id: rawId, type: rawType, code: failure.code, message: failure.message))
        } catch {
            return .failure(ControlDecodeFailure(id: rawId, type: rawType, code: .requestInvalid, message: String(describing: error)))
        }
    }

    private static func decode(_ object: WireObject, type: String?) throws -> ControlMessage {
        guard let type else { throw WireFailure("type is required") }
        switch type {
        case "hello":
            // Version first: a newer core must learn the protocol is unsupported, not that a field is wrong.
            let declared = try object.value("protocol")
            guard let number = declared as? NSNumber, !WireObject.isBool(number), number.doubleValue == Double(HelperProtocol.version) else {
                throw WireFailure("this helper speaks protocol \(HelperProtocol.version) only", code: .protocolUnsupported)
            }
            try object.only(["type", "id", "protocol", "client"])
            let client = try object.object("client")
            try client.only(["name", "version"])
            let name = try client.string("name")
            guard WireText.isPlainText(name, maxUnits: 256) else { throw WireFailure("client.name is not short text") }
            let version = try client.string("version")
            guard WireText.isVersion(version) else { throw WireFailure("client.version is not a version") }
            return .hello(id: try object.requestId(), client: ClientInfo(name: name, version: version))
        case "config":
            try object.only(["type", "id", "microphone", "systemAudio", "excludedBundleIds", "holds", "vad", "healthIntervalMs"])
            return .config(id: try object.requestId(), try decodeConfig(object))
        case "exclude.pids":
            try object.only(["type", "id", "pids"])
            let pids = try object.array("pids", max: 1_024).enumerated().map { index, value in
                Int32(try WireObject.int(value, path: "pids.\(index)", range: 1...0x7fff_ffff))
            }
            guard Set(pids).count == pids.count else { throw WireFailure("pids has duplicate entries") }
            return .excludePids(id: try object.requestId(), pids: pids)
        case "pin.input":
            try object.only(["type", "id", "deviceUid", "allowBluetooth"])
            let uid = try object.nullableString("deviceUid")
            if let uid, !WireText.isPlainText(uid, maxUnits: 512) { throw WireFailure("deviceUid is not a device UID") }
            return .pinInput(id: try object.requestId(), deviceUid: uid, allowBluetooth: try object.bool("allowBluetooth"))
        case "pause", "resume", "request.permissions":
            try object.only(["type", "id", "scope"])
            let text = try object.string("scope")
            guard let scope = PauseScope(rawValue: text) else { throw WireFailure("scope must be all, microphone, or system-audio") }
            let id = try object.requestId()
            return type == "pause" ? .pause(id: id, scope: scope)
                : type == "resume" ? .resume(id: id, scope: scope)
                : .requestPermissions(id: id, scope: scope)
        case "snapshot":
            try object.only(["type", "id"])
            return .snapshot(id: try object.requestId())
        case "shutdown":
            try object.only(["type", "id"])
            return .shutdown(id: try object.requestId())
        default:
            throw WireFailure("unknown message type \"\(WireText.sanitized(type, maxUnits: 64) ?? "?")\"")
        }
    }

    private static func decodeConfig(_ object: WireObject) throws -> CaptureConfig {
        var config = CaptureConfig()
        let microphone = try object.object("microphone")
        try microphone.only(["enabled", "followCalls", "allowedTransports"])
        config.microphone.enabled = try microphone.bool("enabled")
        config.microphone.followCalls = try microphone.bool("followCalls")
        config.microphone.allowedTransports = try microphone.array("allowedTransports", max: 16).enumerated().map { index, value in
            guard let text = value as? String, let transport = Transport(rawValue: text) else {
                throw WireFailure("microphone.allowedTransports.\(index) is not a transport")
            }
            return transport
        }
        guard Set(config.microphone.allowedTransports).count == config.microphone.allowedTransports.count else {
            throw WireFailure("microphone.allowedTransports has duplicate entries")
        }

        let system = try object.object("systemAudio")
        try system.only(["enabled", "appTaps"])
        config.systemAudio.enabled = try system.bool("enabled")
        let taps = try system.object("appTaps")
        try taps.only(["enabled", "max", "releaseAfterIdleMs", "releaseAfterSilenceMs"])
        config.systemAudio.appTaps.enabled = try taps.bool("enabled")
        config.systemAudio.appTaps.max = try taps.int("max", range: 0...8)
        config.systemAudio.appTaps.releaseAfterIdleMs = try taps.int("releaseAfterIdleMs", range: 0...3_600_000)
        config.systemAudio.appTaps.releaseAfterSilenceMs = try taps.int("releaseAfterSilenceMs", range: 0...3_600_000)

        config.excludedBundleIds = try object.array("excludedBundleIds", max: 1_024).enumerated().map { index, value in
            guard let text = value as? String, WireText.isBundleId(text) else { throw WireFailure("excludedBundleIds.\(index) is not a bundle id") }
            return text
        }
        guard Set(config.excludedBundleIds).count == config.excludedBundleIds.count else {
            throw WireFailure("excludedBundleIds has duplicate entries")
        }

        config.holds = try decodeHolds(try object.object("holds"))

        let vad = try object.object("vad")
        try vad.only(["threshold", "minSpeechMs", "minSilenceMs"])
        config.vad.threshold = try vad.double("threshold", range: 0...1)
        config.vad.minSpeechMs = try vad.int("minSpeechMs", range: 0...3_600_000)
        config.vad.minSilenceMs = try vad.int("minSilenceMs", range: 0...3_600_000)
        config.healthIntervalMs = try object.int("healthIntervalMs", range: 1_000...3_600_000)
        return config
    }

    private static func decodeHolds(_ object: WireObject) throws -> CaptureConfig.Holds {
        try object.only(["calls", "screen", "schedule", "networks", "networkKey", "lifted"])
        var holds = CaptureConfig.Holds()
        holds.calls = try object.bool("calls")
        holds.screen = try object.bool("screen")
        holds.schedule = try object.array("schedule", max: 32).enumerated().map { index, value in
            guard let dictionary = value as? [String: Any] else { throw WireFailure("holds.schedule.\(index) must be an object") }
            let window = WireObject(dictionary, path: "holds.schedule.\(index)")
            try window.only(["days", "startMinute", "endMinute"])
            let days = try window.array("days", max: 7).enumerated().map { day, value in
                try WireObject.int(value, path: "holds.schedule.\(index).days.\(day)", range: 0...6)
            }
            guard !days.isEmpty else { throw WireFailure("holds.schedule.\(index).days is empty") }
            guard Set(days).count == days.count else { throw WireFailure("holds.schedule.\(index).days has duplicate entries") }
            let start = try window.int("startMinute", range: 0...1_439)
            let end = try window.int("endMinute", range: 0...1_440)
            guard start != end else { throw WireFailure("holds.schedule.\(index) ends where it starts") }
            return CaptureConfig.ScheduleWindow(days: days, startMinute: start, endMinute: end)
        }
        holds.networks = try object.array("networks", max: 64).enumerated().map { index, value in
            guard let text = value as? String, WireText.isNetworkHash(text) else { throw WireFailure("holds.networks.\(index) is not a network hash") }
            return text
        }
        guard Set(holds.networks).count == holds.networks.count else { throw WireFailure("holds.networks has duplicate entries") }
        let key = try object.string("networkKey")
        if !key.isEmpty {
            // Canonical base64 of exactly 32 bytes, as the schema's pattern says.
            guard key.utf8.count == 44, let bytes = Data(base64Encoded: key), bytes.count == 32, bytes.base64EncodedString() == key else {
                throw WireFailure("holds.networkKey is not base64 of 32 bytes")
            }
        } else if !holds.networks.isEmpty {
            throw WireFailure("holds.networks need the key they were made with")
        }
        holds.networkKey = key
        holds.lifted = try object.array("lifted", max: 64).enumerated().map { index, value in
            guard let text = value as? String, WireText.isUuid(text) else { throw WireFailure("holds.lifted.\(index) is not a uuid") }
            return text
        }
        guard Set(holds.lifted).count == holds.lifted.count else { throw WireFailure("holds.lifted has duplicate entries") }
        return holds
    }

    /// The message as a JSON object (for tests and fake clients).
    public var jsonObject: [String: Any] {
        var object: [String: Any] = ["type": type, "id": id]
        switch self {
        case .hello(_, let client):
            object["protocol"] = HelperProtocol.version
            object["client"] = ["name": client.name, "version": client.version]
        case .config(_, let config):
            object["microphone"] = [
                "enabled": config.microphone.enabled,
                "followCalls": config.microphone.followCalls,
                "allowedTransports": config.microphone.allowedTransports.map(\.rawValue),
            ]
            object["systemAudio"] = [
                "enabled": config.systemAudio.enabled,
                "appTaps": [
                    "enabled": config.systemAudio.appTaps.enabled,
                    "max": config.systemAudio.appTaps.max,
                    "releaseAfterIdleMs": config.systemAudio.appTaps.releaseAfterIdleMs,
                    "releaseAfterSilenceMs": config.systemAudio.appTaps.releaseAfterSilenceMs,
                ],
            ]
            object["excludedBundleIds"] = config.excludedBundleIds
            object["holds"] = [
                "calls": config.holds.calls,
                "screen": config.holds.screen,
                "schedule": config.holds.schedule.map { ["days": $0.days, "startMinute": $0.startMinute, "endMinute": $0.endMinute] },
                "networks": config.holds.networks,
                "networkKey": config.holds.networkKey,
                "lifted": config.holds.lifted,
            ] as [String: Any]
            object["vad"] = ["threshold": config.vad.threshold, "minSpeechMs": config.vad.minSpeechMs, "minSilenceMs": config.vad.minSilenceMs]
            object["healthIntervalMs"] = config.healthIntervalMs
        case .excludePids(_, let pids):
            object["pids"] = pids.map(Int.init)
        case .pinInput(_, let uid, let allowBluetooth):
            object["deviceUid"] = uid.map { $0 as Any } ?? NSNull()
            object["allowBluetooth"] = allowBluetooth
        case .pause(_, let scope), .resume(_, let scope), .requestPermissions(_, let scope):
            object["scope"] = scope.rawValue
        case .snapshot, .shutdown:
            break
        }
        return object
    }

    public func encodedLine() throws -> Data {
        var data = try JSONSerialization.data(withJSONObject: jsonObject, options: [.sortedKeys, .withoutEscapingSlashes])
        data.append(0x0A)
        return data
    }
}

struct WireFailure: Error {
    var message: String
    var code: ErrorCode

    init(_ message: String, code: ErrorCode = .requestInvalid) {
        self.message = message
        self.code = code
    }
}

/// A decoded JSON object with strict accessors.
struct WireObject {
    let values: [String: Any]
    let path: String

    init(_ values: [String: Any], path: String) {
        self.values = values
        self.path = path
    }

    private func name(_ key: String) -> String { path.isEmpty ? key : "\(path).\(key)" }

    func only(_ keys: Set<String>) throws {
        if let unknown = values.keys.filter({ !keys.contains($0) }).sorted().first {
            throw WireFailure("unknown key \"\(WireText.sanitized(name(unknown), maxUnits: 128) ?? "?")\"")
        }
    }

    func value(_ key: String) throws -> Any {
        guard let value = values[key] else { throw WireFailure("\(name(key)) is required") }
        return value
    }

    func requestId() throws -> String {
        guard let id = try value("id") as? String, WireText.isRequestId(id) else { throw WireFailure("id is not a request id") }
        return id
    }

    func string(_ key: String) throws -> String {
        guard let text = try value(key) as? String else { throw WireFailure("\(name(key)) must be a string") }
        return text
    }

    func nullableString(_ key: String) throws -> String? {
        let raw = try value(key)
        if raw is NSNull { return nil }
        guard let text = raw as? String else { throw WireFailure("\(name(key)) must be a string or null") }
        return text
    }

    func bool(_ key: String) throws -> Bool {
        guard let number = try value(key) as? NSNumber, Self.isBool(number) else { throw WireFailure("\(name(key)) must be a boolean") }
        return number.boolValue
    }

    func int(_ key: String, range: ClosedRange<Int>) throws -> Int {
        try Self.int(try value(key), path: name(key), range: range)
    }

    func double(_ key: String, range: ClosedRange<Double>) throws -> Double {
        guard let number = try value(key) as? NSNumber, !Self.isBool(number), number.doubleValue.isFinite,
              range.contains(number.doubleValue)
        else { throw WireFailure("\(name(key)) must be a number within \(range.lowerBound)...\(range.upperBound)") }
        return number.doubleValue
    }

    func object(_ key: String) throws -> WireObject {
        guard let dictionary = try value(key) as? [String: Any] else { throw WireFailure("\(name(key)) must be an object") }
        return WireObject(dictionary, path: name(key))
    }

    func array(_ key: String, max: Int) throws -> [Any] {
        guard let array = try value(key) as? [Any] else { throw WireFailure("\(name(key)) must be an array") }
        guard array.count <= max else { throw WireFailure("\(name(key)) has more than \(max) entries") }
        return array
    }

    static func int(_ value: Any, path: String, range: ClosedRange<Int>) throws -> Int {
        guard let number = value as? NSNumber, !isBool(number) else { throw WireFailure("\(path) must be an integer") }
        let double = number.doubleValue
        guard double.isFinite, double == double.rounded(), abs(double) <= 9_007_199_254_740_991, range.contains(Int(double)) else {
            throw WireFailure("\(path) must be an integer within \(range.lowerBound)...\(range.upperBound)")
        }
        return Int(double)
    }

    static func isBool(_ number: NSNumber) -> Bool {
        CFGetTypeID(number as CFTypeRef) == CFBooleanGetTypeID()
    }
}
