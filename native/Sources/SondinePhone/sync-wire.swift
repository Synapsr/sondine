import CryptoKit
import Foundation

// What the iPhone app and the Mac say to each other (ADR 008). The schemas
// and their fixtures live in `packages/protocol` (`phone-sync.ts`,
// `fixtures/phone/sync-*.jsonl`); these types decode exactly what zod
// accepts there (unknown keys, upper-case ids and out-of-range numbers are
// refused) and encode what it reads back.

public enum PhoneSync {
    /// The sync protocol's version this build speaks: pairing and `hello` say
    /// it, and the Mac answers in it (ADR 039: version 2 adds tags and « Moi ? »).
    public static let version = 2
    /// The version of what finds and links the Mac: the QR, the Bonjour record
    /// and the relay's first line. Unchanged by version 2.
    public static let linkVersion = 1
    /// The oldest version a Mac answers.
    public static let oldestVersion = 1
    /// The Bonjour service type the relay advertises at home.
    public static let serviceType = "_sondine._tcp"
    /// The relay's TXT record: the protocol version and the first 8 hex digits of the key's pin.
    public static let txtVersionKey = "v"
    public static let txtPinKey = "pin8"
    /// The header carrying the upload's first byte's offset in the file.
    public static let offsetHeader = "sondine-offset"
    public static let maxFileBytes: Int64 = 1 << 30
    public static let maxJsonBytes = 1 << 20
    /// Largest answer of `get`: a recording's result (3 hours of speech is about 1 MiB).
    public static let maxResultBytes = 8 << 20
    /// The phone keeps the results of its recordings made in the last 30 days.
    public static let resultKeptMs: Int64 = 30 * 24 * 3_600_000
    /// The most bytes one playback request asks the Mac for.
    public static let audioChunkBytes: Int64 = 1 << 20
    public static let maxIds = 2_000
    /// How long a pairing waits for the Mac's « Appairer », in ms.
    public static let pairingAnswerMs = 120_000
    public static let pairingUrlPrefix = "sondine://pair?"

    public enum Route {
        public static let pair = "/v1/pair"
        public static let hello = "/v1/hello"
        public static let announce = "/v1/recordings/announce"
        public static let states = "/v1/recordings/states"
        public static let delete = "/v1/recordings/delete"
        public static let get = "/v1/recordings/get"
        public static let rename = "/v1/recordings/rename"
        public static let note = "/v1/recordings/note"
        /// Version 2 (ADR 039).
        public static let tag = "/v1/recordings/tag"
        public static let voice = "/v1/recordings/voice"
        public static let tags = "/v1/tags"
        public static let forget = "/v1/forget"
        public static func audio(_ id: UUID) -> String { "/v1/recordings/\(id.wire)/audio" }
        /// Playback of what the Mac made of it, planned at this generation.
        public static func audio(_ id: UUID, generation: Int) -> String { "\(audio(id))?g=\(generation)" }
    }
}

public enum WireError: Error, Equatable {
    /// Missing or unknown keys.
    case fields
    /// A value of the right type that the schema refuses.
    case value(String)
}

extension UUID {
    /// Lowercase canonical, as the wire requires.
    public var wire: String { uuidString.lowercased() }
}

// Values

enum Wire {
    static func uuid(_ text: String) throws -> UUID {
        guard text.wholeMatch(of: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) != nil,
              let id = UUID(uuidString: text)
        else { throw WireError.value("uuid") }
        return id
    }

    static func hex64(_ text: String) throws -> String {
        guard text.wholeMatch(of: /[0-9a-f]{64}/) != nil else { throw WireError.value("hex") }
        return text
    }

    static func base64Url32(_ text: String) throws -> String {
        guard text.wholeMatch(of: /[A-Za-z0-9_\-]{43}/) != nil else { throw WireError.value("token") }
        return text
    }

    static func credential(_ text: String) throws -> String {
        guard text.wholeMatch(of: /sdp_[A-Za-z0-9_\-]{43}/) != nil else { throw WireError.value("credential") }
        return text
    }

    static func ip(_ text: String) throws -> String {
        guard text.wholeMatch(of: /(?:[0-9]{1,3}(?:\.[0-9]{1,3}){3}|[0-9a-fA-F:.]{2,45}(?:%[A-Za-z0-9]{1,15})?)/) != nil
        else { throw WireError.value("ip") }
        return text
    }

    /// 1 to 64 UTF-16 code units, none a control character (zod counts as JavaScript does).
    static func name(_ text: String) throws -> String {
        guard !text.isEmpty, text.utf16.count <= 64,
              !text.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F })
        else { throw WireError.value("name") }
        return text
    }

    static func port(_ value: Int) throws -> Int {
        guard (1...65_535).contains(value) else { throw WireError.value("port") }
        return value
    }

    static func atLeast<T: BinaryInteger>(_ minimum: T, _ value: T) throws -> T {
        // JavaScript's safe integers: zod's `int()` refuses beyond them.
        guard value >= minimum, Int64(value) <= 9_007_199_254_740_991 else { throw WireError.value("int") }
        return value
    }

    /// `min` to `max` UTF-16 code units (zod counts as JavaScript does).
    static func text(_ text: String, _ min: Int, _ max: Int) throws -> String {
        guard (min...max).contains(text.utf16.count) else { throw WireError.value("text") }
        return text
    }

    /// A recording's name: 1 to 200 UTF-16 units, no control character.
    static func recordingName(_ text: String) throws -> String {
        guard !text.isEmpty, text.utf16.count <= 200,
              !text.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F })
        else { throw WireError.value("name") }
        return text
    }

    /// `YYYY-MM-DD`, a day that exists (zod's `iso.date()`).
    static func isoDate(_ text: String) throws -> String {
        guard let match = text.wholeMatch(of: /(\d{4})-(\d{2})-(\d{2})/),
              let year = Int(match.1), let month = Int(match.2), let day = Int(match.3), (1...12).contains(month)
        else { throw WireError.value("date") }
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
        let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
        guard (1...days).contains(day) else { throw WireError.value("date") }
        return text
    }

    static func atMost<T>(_ count: Int, _ values: [T]) throws -> [T] {
        guard values.count <= count else { throw WireError.value("array") }
        return values
    }
}

/// Any key, so a decoder can see every key an object has.
struct WireKey: CodingKey {
    let stringValue: String
    init(_ string: String) { stringValue = string }
    init?(stringValue: String) { self.stringValue = stringValue }
    var intValue: Int? { nil }
    init?(intValue: Int) { nil }
}

extension Decoder {
    /// An object with these keys and no other; `optional` ones may be absent.
    func strictObject(_ keys: Set<String>, optional: Set<String> = []) throws -> KeyedDecodingContainer<WireKey> {
        let container = try container(keyedBy: WireKey.self)
        let present = Set(container.allKeys.map(\.stringValue))
        guard present.isSubset(of: keys.union(optional)), keys.isSubset(of: present) else { throw WireError.fields }
        return container
    }
}

extension KeyedDecodingContainer where Key == WireKey {
    func string(_ key: String) throws -> String { try decode(String.self, forKey: WireKey(key)) }
    func int(_ key: String) throws -> Int { try decode(Int.self, forKey: WireKey(key)) }
    func int64(_ key: String) throws -> Int64 { try decode(Int64.self, forKey: WireKey(key)) }
    func strings(_ key: String) throws -> [String] { try decode([String].self, forKey: WireKey(key)) }
    func uuid(_ key: String) throws -> UUID { try Wire.uuid(string(key)) }
    func uuids(_ key: String) throws -> [UUID] { try strings(key).map(Wire.uuid) }
    func bool(_ key: String) throws -> Bool { try decode(Bool.self, forKey: WireKey(key)) }
    func literal(_ key: String, _ value: Int) throws {
        guard try int(key) == value else { throw WireError.value(key) }
    }
    /// A key that must be there, its value possibly `null`.
    func nullable<T>(_ key: String, _ read: (String) throws -> T) throws -> T? {
        try decodeNil(forKey: WireKey(key)) ? nil : read(key)
    }
}

extension Encoder {
    func object() -> KeyedEncodingContainer<WireKey> { container(keyedBy: WireKey.self) }
}

extension KeyedEncodingContainer where Key == WireKey {
    mutating func put(_ value: some Encodable, _ key: String) throws { try encode(value, forKey: WireKey(key)) }
    mutating func put(_ value: UUID, _ key: String) throws { try encode(value.wire, forKey: WireKey(key)) }
    mutating func put(_ value: [UUID], _ key: String) throws { try encode(value.map(\.wire), forKey: WireKey(key)) }
    /// Writes `null` for nil: zod's `nullable()` wants the key.
    mutating func putNullable(_ value: (some Encodable)?, _ key: String) throws {
        if let value { try encode(value, forKey: WireKey(key)) } else { try encodeNil(forKey: WireKey(key)) }
    }
}

// The QR

/// What the Mac's pairing QR carries: `sondine://pair?v=1&pin=…&token=…&name=…&port=…&addr=…,…`.
public struct PairingInvite: Codable, Equatable, Sendable {
    public var pin: String
    public var token: String
    public var name: String
    public var port: Int
    public var addrs: [String]

    public init(pin: String, token: String, name: String, port: Int, addrs: [String]) throws {
        self.pin = try Wire.hex64(pin)
        self.token = try Wire.base64Url32(token)
        self.name = try Wire.name(name)
        self.port = try Wire.port(port)
        self.addrs = try Wire.atMost(8, addrs.map(Wire.ip))
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["v", "pin", "token", "name", "port", "addrs"])
        try c.literal("v", PhoneSync.linkVersion)
        try self.init(pin: c.string("pin"), token: c.string("token"), name: c.string("name"), port: c.int("port"),
                      addrs: c.strings("addrs"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(PhoneSync.linkVersion, "v")
        try c.put(pin, "pin")
        try c.put(token, "token")
        try c.put(name, "name")
        try c.put(port, "port")
        try c.put(addrs, "addrs")
    }

    /// What a scanned text holds.
    public enum Scan: Equatable, Sendable {
        case invite(PairingInvite)
        /// A Sondine pairing code of another protocol version.
        case version(Int)
        /// Not a Sondine pairing code, or a damaged one.
        case notAnInvite
    }

    /// Reads a scanned text as `parsePairingUrl` does (query decoded as `URLSearchParams` does).
    public static func scan(_ text: String) -> Scan {
        guard text.hasPrefix(PhoneSync.pairingUrlPrefix) else { return .notAnInvite }
        let query = searchParams(String(text.dropFirst(PhoneSync.pairingUrlPrefix.count)))
        guard let v = query["v"].flatMap(Int.init) else { return .notAnInvite }
        guard v == PhoneSync.linkVersion else { return .version(v) }
        let addr = query["addr"] ?? ""
        guard let pin = query["pin"], let token = query["token"], let name = query["name"],
              let port = query["port"].flatMap(Int.init),
              let invite = try? PairingInvite(
                  pin: pin, token: token, name: name, port: port,
                  addrs: addr.isEmpty ? [] : addr.split(separator: ",", omittingEmptySubsequences: false).map(String.init))
        else { return .notAnInvite }
        return .invite(invite)
    }

    /// The QR's text, as `formatPairingUrl` writes it.
    public var url: String {
        func encode(_ value: String) -> String {
            // `URLSearchParams`: spaces as `+`, and every byte outside `*-._` and alphanumerics escaped.
            var allowed = CharacterSet(charactersIn: "*-._ ")
            allowed.formUnion(CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"))
            return (value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value).replacingOccurrences(of: " ", with: "+")
        }
        let pairs = [("v", String(PhoneSync.linkVersion)), ("pin", pin), ("token", token), ("name", name),
                     ("port", String(port)), ("addr", addrs.joined(separator: ","))]
        return PhoneSync.pairingUrlPrefix + pairs.map { "\($0)=\(encode($1))" }.joined(separator: "&")
    }

    /// `application/x-www-form-urlencoded`, first value of each key.
    private static func searchParams(_ query: String) -> [String: String] {
        var values: [String: String] = [:]
        for pair in query.split(separator: "&", omittingEmptySubsequences: true) {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            func decode(_ part: Substring) -> String {
                let spaced = part.replacingOccurrences(of: "+", with: " ")
                return spaced.removingPercentEncoding ?? spaced
            }
            let key = decode(parts[0])
            if values[key] == nil { values[key] = parts.count > 1 ? decode(parts[1]) : "" }
        }
        return values
    }
}

/// The six digits both screens show: SHA-256 of `token \n deviceId \n pin`
/// (UTF-8), its first four bytes big-endian, modulo a million, zero-padded.
public func pairingDigits(token: String, deviceId: UUID, pin: String) -> String {
    let digest = SHA256.hash(data: Data("\(token)\n\(deviceId.wire)\n\(pin)".utf8))
    let value = digest.prefix(4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
    let number = String(value % 1_000_000)
    return String(repeating: "0", count: 6 - number.count) + number
}

// The relay

/// The relay's first line to core on `phone.sock`. The phone never sends it; decoded here for the shared fixtures.
public struct PhoneRelayHello: Codable, Equatable, Sendable {
    public enum Via: String, Codable, Sendable { case lan, tailnet, loopback }
    public var via: Via
    public var peer: String

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["v", "via", "peer"])
        try c.literal("v", PhoneSync.linkVersion)
        guard let via = Via(rawValue: try c.string("via")) else { throw WireError.value("via") }
        self.via = via
        peer = try Wire.ip(c.string("peer"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(PhoneSync.linkVersion, "v")
        try c.put(via.rawValue, "via")
        try c.put(peer, "peer")
    }
}

// Refusals

public enum PhoneErrorCode: String, Codable, Sendable, CaseIterable {
    case unauthorized, revoked, version
    case notYours = "not-yours"
    case badRequest = "bad-request"
    case busy
    case gone, stale, range
    case pairingClosed = "pairing-closed"
    case pairingRefused = "pairing-refused"
    case pairingUsed = "pairing-used"
    case pairingTailnet = "pairing-tailnet"
}

/// A refusal's body. `macVersion` comes with `version`.
public struct PhoneError: Codable, Equatable, Sendable, Error {
    public var error: PhoneErrorCode
    public var macVersion: Int?

    public init(error: PhoneErrorCode, macVersion: Int? = nil) {
        self.error = error
        self.macVersion = macVersion
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["error"], optional: ["macVersion"])
        guard let error = PhoneErrorCode(rawValue: try c.string("error")) else { throw WireError.value("error") }
        self.error = error
        macVersion = try c.decodeIfPresent(Int.self, forKey: WireKey("macVersion")).map { try Wire.atLeast(1, $0) }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(error.rawValue, "error")
        if let macVersion { try c.put(macVersion, "macVersion") }
    }
}

// Pairing: POST /v1/pair, no credential.

public struct PairRequest: Codable, Equatable, Sendable {
    public var v: Int
    public var token: String
    public var deviceId: UUID
    public var deviceName: String

    public init(token: String, deviceId: UUID, deviceName: String, v: Int = PhoneSync.version) throws {
        self.v = try Wire.atLeast(1, v)
        self.token = try Wire.base64Url32(token)
        self.deviceId = deviceId
        self.deviceName = try Wire.name(deviceName)
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["v", "token", "deviceId", "deviceName"])
        try self.init(token: c.string("token"), deviceId: c.uuid("deviceId"), deviceName: c.string("deviceName"),
                      v: c.int("v"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(v, "v")
        try c.put(token, "token")
        try c.put(deviceId, "deviceId")
        try c.put(deviceName, "deviceName")
    }
}

public struct PairAnswer: Codable, Equatable, Sendable {
    public var credential: String
    public var macId: UUID

    public init(credential: String, macId: UUID) throws {
        self.credential = try Wire.credential(credential)
        self.macId = macId
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["credential", "macId"])
        try self.init(credential: c.string("credential"), macId: c.uuid("macId"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(credential, "credential")
        try c.put(macId, "macId")
    }
}

// POST /v1/hello

public struct HelloRequest: Codable, Equatable, Sendable {
    public var v: Int
    public var clockMs: Int64
    public var recordingIds: [UUID]

    public init(clockMs: Int64, recordingIds: [UUID], v: Int = PhoneSync.version) throws {
        self.v = try Wire.atLeast(1, v)
        self.clockMs = try Wire.atLeast(0, clockMs)
        self.recordingIds = try Wire.atMost(PhoneSync.maxIds, recordingIds)
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["v", "clockMs", "recordingIds"])
        try self.init(clockMs: c.int64("clockMs"), recordingIds: c.uuids("recordingIds"), v: c.int("v"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(v, "v")
        try c.put(clockMs, "clockMs")
        try c.put(recordingIds, "recordingIds")
    }
}

/// How the phone reached the Mac, as the Mac's relay saw it (M5.5): at
/// home, or through Tailscale. On the wire, `hello`'s `via` is `tailnet` or absent.
public enum MacPath: String, Sendable, Equatable {
    case home, tailnet
}

public struct HelloAnswer: Codable, Equatable, Sendable {
    /// The version the Mac speaks to this phone: the phone's own (ADR 039).
    public var v: Int
    public var clockMs: Int64
    public var macId: UUID
    public var addrs: [String]
    public var port: Int
    public var maxFileBytes: Int64
    public var via: MacPath

    public init(
        clockMs: Int64, macId: UUID, addrs: [String], port: Int, maxFileBytes: Int64, via: MacPath = .home,
        v: Int = PhoneSync.version
    ) throws {
        guard (PhoneSync.oldestVersion...PhoneSync.version).contains(v) else { throw WireError.value("v") }
        self.v = v
        self.clockMs = try Wire.atLeast(0, clockMs)
        self.macId = macId
        self.addrs = try Wire.atMost(16, addrs.map(Wire.ip))
        self.port = try Wire.port(port)
        self.maxFileBytes = try Wire.atLeast(1, maxFileBytes)
        self.via = via
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["v", "clockMs", "macId", "addrs", "port", "maxFileBytes"], optional: ["via"])
        var via = MacPath.home
        if c.contains(WireKey("via")) {
            guard try c.string("via") == "tailnet" else { throw WireError.value("via") }
            via = .tailnet
        }
        try self.init(clockMs: c.int64("clockMs"), macId: c.uuid("macId"), addrs: c.strings("addrs"),
                      port: c.int("port"), maxFileBytes: c.int64("maxFileBytes"), via: via, v: c.int("v"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(v, "v")
        try c.put(clockMs, "clockMs")
        try c.put(macId, "macId")
        try c.put(addrs, "addrs")
        try c.put(port, "port")
        try c.put(maxFileBytes, "maxFileBytes")
        if via == .tailnet { try c.put("tailnet", "via") }
    }
}

// Sending a recording

public enum RecordingRefusal: String, Codable, Sendable, CaseIterable {
    case tooLarge = "too-large"
    case noRoom = "no-room"
    case unreadable, header, hash, offset, busy

    /// The Mac will never take this file: the phone stops offering it.
    public var isFinal: Bool { self == .tooLarge || self == .header || self == .unreadable }
}

/// Where a file stands on the Mac after an announcement or an upload.
public enum UploadStatus: Codable, Equatable, Sendable {
    case send(offset: Int64)
    case stored
    case conflict
    case deleted
    case refused(RecordingRefusal)

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: WireKey.self)
        let status = try c.string("status")
        switch status {
        case "send":
            let c = try decoder.strictObject(["status", "offset"])
            self = .send(offset: try Wire.atLeast(0, c.int64("offset")))
        case "refused":
            let c = try decoder.strictObject(["status", "reason"])
            guard let reason = RecordingRefusal(rawValue: try c.string("reason")) else { throw WireError.value("reason") }
            self = .refused(reason)
        case "stored", "conflict", "deleted":
            _ = try decoder.strictObject(["status"])
            self = status == "stored" ? .stored : status == "conflict" ? .conflict : .deleted
        default: throw WireError.value("status")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        switch self {
        case let .send(offset):
            try c.put("send", "status")
            try c.put(offset, "offset")
        case .stored: try c.put("stored", "status")
        case .conflict: try c.put("conflict", "status")
        case .deleted: try c.put("deleted", "status")
        case let .refused(reason):
            try c.put("refused", "status")
            try c.put(reason.rawValue, "reason")
        }
    }
}

public struct AnnounceRequest: Codable, Equatable, Sendable {
    public var recordingId: UUID
    public var bytes: Int64
    public var sha256: String

    public init(recordingId: UUID, bytes: Int64, sha256: String) throws {
        self.recordingId = recordingId
        self.bytes = try Wire.atLeast(1, bytes)
        self.sha256 = try Wire.hex64(sha256)
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["recordingId", "bytes", "sha256"])
        try self.init(recordingId: c.uuid("recordingId"), bytes: c.int64("bytes"), sha256: c.string("sha256"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(recordingId, "recordingId")
        try c.put(bytes, "bytes")
        try c.put(sha256, "sha256")
    }
}

// POST /v1/recordings/states

/// A recording's state on the Mac.
public enum MacRecordingState: String, Codable, Sendable, CaseIterable {
    case unknown, receiving, waiting, transcribing, ready, deleted
}

public struct StatesRequest: Codable, Equatable, Sendable {
    public var recordingIds: [UUID]

    public init(recordingIds: [UUID]) throws {
        self.recordingIds = try Wire.atMost(PhoneSync.maxIds, recordingIds)
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["recordingIds"])
        try self.init(recordingIds: c.uuids("recordingIds"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(recordingIds, "recordingIds")
    }
}

public struct StatesAnswer: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public var recordingId: UUID
        public var state: MacRecordingState

        public init(recordingId: UUID, state: MacRecordingState) {
            self.recordingId = recordingId
            self.state = state
        }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.strictObject(["recordingId", "state"])
            recordingId = try c.uuid("recordingId")
            guard let state = MacRecordingState(rawValue: try c.string("state")) else { throw WireError.value("state") }
            self.state = state
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.object()
            try c.put(recordingId, "recordingId")
            try c.put(state.rawValue, "state")
        }
    }

    public var states: [Entry]

    public init(states: [Entry]) { self.states = states }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["states"])
        states = try c.decode([Entry].self, forKey: WireKey("states"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(states, "states")
    }
}

// POST /v1/recordings/delete

public struct DeleteRequest: Codable, Equatable, Sendable {
    public var operationId: UUID
    public var recordingId: UUID

    public init(operationId: UUID, recordingId: UUID) {
        self.operationId = operationId
        self.recordingId = recordingId
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["operationId", "recordingId"])
        self.init(operationId: try c.uuid("operationId"), recordingId: try c.uuid("recordingId"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(operationId, "operationId")
        try c.put(recordingId, "recordingId")
    }
}

/// `{"status":"deleted"}` or `{"status":"forgotten"}`: an acknowledgement with one fixed status.
public struct StatusAnswer: Equatable, Sendable {
    public let status: String

    public init(_ status: String) { self.status = status }

    static func decode(_ data: Data, expecting status: String) throws -> StatusAnswer {
        let answer = try JSONDecoder().decode(Raw.self, from: data)
        guard answer.status == status else { throw WireError.value("status") }
        return StatusAnswer(status)
    }

    func json() throws -> Data { try JSONEncoder().encode(Raw(status: status)) }

    private struct Raw: Codable {
        var status: String
        init(status: String) { self.status = status }
        init(from decoder: any Decoder) throws {
            status = try decoder.strictObject(["status"]).string("status")
        }
    }
}

// POST /v1/recordings/get (M5.3)

/// A voice of the transcript: its number, the user's name for it, whom Sondine takes it for (a guess), the user.
public struct PhoneSpeaker: Codable, Equatable, Sendable {
    public var ordinal: Int
    public var name: String?
    public var guess: String?
    public var isSelf: Bool
    /// Version 2: the guess is the user (« Moi ? »), which the phone may confirm; nil from a version 1 Mac.
    public var guessSelf: Bool?

    public init(ordinal: Int, name: String?, guess: String?, isSelf: Bool, guessSelf: Bool? = nil) throws {
        self.ordinal = try Wire.atLeast(1, ordinal)
        self.name = try name.map { try Wire.text($0, 1, 200) }
        self.guess = try guess.map { try Wire.text($0, 1, 200) }
        self.isSelf = isSelf
        self.guessSelf = guessSelf
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["ordinal", "name", "guess", "self"], optional: ["guessSelf"])
        try self.init(ordinal: c.int("ordinal"), name: c.nullable("name", c.string), guess: c.nullable("guess", c.string),
                      isSelf: c.bool("self"),
                      guessSelf: c.contains(WireKey("guessSelf")) ? c.bool("guessSelf") : nil)
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(ordinal, "ordinal")
        try c.putNullable(name, "name")
        try c.putNullable(guess, "guess")
        try c.put(isSelf, "self")
        if let guessSelf { try c.put(guessSelf, "guessSelf") }
    }
}

/// A sentence of the transcript: its id on the Mac, its times, its voice's number, its text.
public struct PhoneSentence: Codable, Equatable, Sendable, Identifiable {
    public var id: Int
    public var startMs: Int64
    public var endMs: Int64
    public var speaker: Int?
    public var text: String

    public init(id: Int, startMs: Int64, endMs: Int64, speaker: Int?, text: String) throws {
        self.id = try Wire.atLeast(1, id)
        self.startMs = try Wire.atLeast(0, startMs)
        self.endMs = try Wire.atLeast(0, endMs)
        self.speaker = try speaker.map { try Wire.atLeast(1, $0) }
        self.text = try Wire.text(text, 0, 20_000)
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["id", "startMs", "endMs", "speaker", "text"])
        try self.init(id: c.int("id"), startMs: c.int64("startMs"), endMs: c.int64("endMs"),
                      speaker: c.nullable("speaker", c.int), text: c.string("text"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(id, "id")
        try c.put(startMs, "startMs")
        try c.put(endMs, "endMs")
        try c.putNullable(speaker, "speaker")
        try c.put(text, "text")
    }
}

/// A voice a journal line names as `{P2}`.
public struct PhoneLineVoice: Codable, Equatable, Sendable {
    public var ref: String
    public var ordinal: Int?
    public var name: String?
    public var guess: String?
    public var isSelf: Bool

    public init(ref: String, ordinal: Int?, name: String?, guess: String?, isSelf: Bool) throws {
        guard ref.wholeMatch(of: /[A-Za-z0-9]{1,8}/) != nil else { throw WireError.value("ref") }
        self.ref = ref
        self.ordinal = try ordinal.map { try Wire.atLeast(0, $0) }
        self.name = try name.map { try Wire.text($0, 1, 200) }
        self.guess = try guess.map { try Wire.text($0, 1, 200) }
        self.isSelf = isSelf
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["ref", "ordinal", "name", "guess", "self"])
        try self.init(ref: c.string("ref"), ordinal: c.nullable("ordinal", c.int), name: c.nullable("name", c.string),
                      guess: c.nullable("guess", c.string), isSelf: c.bool("self"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(ref, "ref")
        try c.putNullable(ordinal, "ordinal")
        try c.putNullable(name, "name")
        try c.putNullable(guess, "guess")
        try c.put(isSelf, "self")
    }
}

/// A line of the Mac's journal, or a commitment, that cites the recording.
public struct PhoneJournalLine: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case line, commitment }

    public var kind: Kind
    /// Voices as `{P2}`, named in `voices`.
    public var text: String
    public var voices: [PhoneLineVoice]
    /// The recording's sentences it cites, in order.
    public var sentenceIds: [Int]
    public var startMs: Int64
    /// A commitment the user marked done.
    public var done: Bool
    /// `YYYY-MM-DD`, in the Mac's time zone.
    public var due: String?

    public init(kind: Kind, text: String, voices: [PhoneLineVoice], sentenceIds: [Int], startMs: Int64, done: Bool,
                due: String?) throws {
        self.kind = kind
        self.text = try Wire.text(text, 1, 2_000)
        self.voices = try Wire.atMost(32, voices)
        self.sentenceIds = try Wire.atMost(64, sentenceIds.map { try Wire.atLeast(1, $0) })
        self.startMs = try Wire.atLeast(0, startMs)
        self.done = done
        self.due = try due.map(Wire.isoDate)
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["kind", "text", "voices", "sentenceIds", "startMs", "done", "due"])
        guard let kind = Kind(rawValue: try c.string("kind")) else { throw WireError.value("kind") }
        try self.init(
            kind: kind, text: c.string("text"), voices: c.decode([PhoneLineVoice].self, forKey: WireKey("voices")),
            sentenceIds: c.decode([Int].self, forKey: WireKey("sentenceIds")), startMs: c.int64("startMs"),
            done: c.bool("done"), due: c.nullable("due", c.string))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(kind.rawValue, "kind")
        try c.put(text, "text")
        try c.put(voices, "voices")
        try c.put(sentenceIds, "sentenceIds")
        try c.put(startMs, "startMs")
        try c.put(done, "done")
        try c.putNullable(due, "due")
    }
}

/// A note (or a link) on the recording's conversation.
public struct PhoneNote: Codable, Equatable, Sendable, Identifiable {
    public var id: Int
    public var text: String
    public var addedAtMs: Int64

    public init(id: Int, text: String, addedAtMs: Int64) throws {
        self.id = try Wire.atLeast(1, id)
        self.text = try Wire.text(text, 1, 20_000)
        self.addedAtMs = try Wire.atLeast(0, addedAtMs)
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["id", "text", "addedAtMs"])
        try self.init(id: c.int("id"), text: c.string("text"), addedAtMs: c.int64("addedAtMs"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(id, "id")
        try c.put(text, "text")
        try c.put(addedAtMs, "addedAtMs")
    }
}

/// What playback of a result needs: the generation for `GET …/audio?g=`, where its first sample is, its length.
public struct PhoneResultAudio: Codable, Equatable, Sendable {
    public var generation: Int
    public var startedAtMs: Int64
    public var durationMs: Int64

    public init(generation: Int, startedAtMs: Int64, durationMs: Int64) throws {
        self.generation = try Wire.atLeast(1, generation)
        self.startedAtMs = try Wire.atLeast(0, startedAtMs)
        self.durationMs = try Wire.atLeast(0, durationMs)
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["generation", "startedAtMs", "durationMs"])
        try self.init(generation: c.int("generation"), startedAtMs: c.int64("startedAtMs"), durationMs: c.int64("durationMs"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(generation, "generation")
        try c.put(startedAtMs, "startedAtMs")
        try c.put(durationMs, "durationMs")
    }
}

/// What the Mac made of one of the phone's recordings.
public struct PhoneResult: Codable, Equatable, Sendable {
    public var recordingId: UUID
    public var name: String?
    public var startedAtMs: Int64
    public var endedAtMs: Int64
    public var timeUncertain: Bool
    public var speakers: [PhoneSpeaker]
    public var sentences: [PhoneSentence]
    public var journal: [PhoneJournalLine]
    public var notes: [PhoneNote]
    /// Version 2: the recording's tags (ADR 039); nil from a version 1 Mac.
    public var tags: [String]?
    public var audio: PhoneResultAudio?

    public init(
        recordingId: UUID, name: String?, startedAtMs: Int64, endedAtMs: Int64, timeUncertain: Bool,
        speakers: [PhoneSpeaker], sentences: [PhoneSentence], journal: [PhoneJournalLine], notes: [PhoneNote],
        tags: [String]? = nil, audio: PhoneResultAudio?
    ) throws {
        self.recordingId = recordingId
        self.name = try name.map(Wire.recordingName)
        self.startedAtMs = try Wire.atLeast(0, startedAtMs)
        self.endedAtMs = try Wire.atLeast(0, endedAtMs)
        self.timeUncertain = timeUncertain
        self.speakers = try Wire.atMost(64, speakers)
        self.sentences = sentences
        self.journal = try Wire.atMost(500, journal)
        self.notes = try Wire.atMost(500, notes)
        self.tags = try tags.map { try Wire.atMost(400, $0.map { try Wire.text($0, 1, 400) }) }
        self.audio = audio
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject([
            "recordingId", "name", "startedAtMs", "endedAtMs", "timeUncertain", "speakers", "sentences", "journal",
            "notes", "audio",
        ], optional: ["tags"])
        try self.init(
            recordingId: c.uuid("recordingId"), name: c.nullable("name", c.string), startedAtMs: c.int64("startedAtMs"),
            endedAtMs: c.int64("endedAtMs"), timeUncertain: c.bool("timeUncertain"),
            speakers: c.decode([PhoneSpeaker].self, forKey: WireKey("speakers")),
            sentences: c.decode([PhoneSentence].self, forKey: WireKey("sentences")),
            journal: c.decode([PhoneJournalLine].self, forKey: WireKey("journal")),
            notes: c.decode([PhoneNote].self, forKey: WireKey("notes")),
            tags: c.contains(WireKey("tags")) ? c.strings("tags") : nil,
            audio: c.nullable("audio") { try c.decode(PhoneResultAudio.self, forKey: WireKey($0)) })
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(recordingId, "recordingId")
        try c.putNullable(name, "name")
        try c.put(startedAtMs, "startedAtMs")
        try c.put(endedAtMs, "endedAtMs")
        try c.put(timeUncertain, "timeUncertain")
        try c.put(speakers, "speakers")
        try c.put(sentences, "sentences")
        try c.put(journal, "journal")
        try c.put(notes, "notes")
        if let tags { try c.put(tags, "tags") }
        try c.putNullable(audio, "audio")
    }
}

/// A recording's result, with the revision the phone holds (nil when it has none).
public struct GetRequest: Codable, Equatable, Sendable {
    public var recordingId: UUID
    public var revision: String?

    public init(recordingId: UUID, revision: String?) throws {
        self.recordingId = recordingId
        self.revision = try revision.map(Wire.hex64)
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["recordingId", "revision"])
        try self.init(recordingId: c.uuid("recordingId"), revision: c.nullable("revision", c.string))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(recordingId, "recordingId")
        try c.putNullable(revision, "revision")
    }
}

/// The Mac's answer to `get`.
public enum GetAnswer: Codable, Equatable, Sendable {
    /// The result and its revision (the SHA-256 of the result's JSON as the Mac sent it).
    case result(revision: String, PhoneResult)
    /// The revision the phone holds is current.
    case unchanged
    /// No result now: the recording's state (never `ready`).
    case unavailable(MacRecordingState)
    /// Something was deleted while it was read: ask again.
    case withheld

    public init(from decoder: any Decoder) throws {
        let status = try decoder.container(keyedBy: WireKey.self).string("status")
        switch status {
        case "result":
            let c = try decoder.strictObject(["status", "revision", "result"])
            self = .result(revision: try Wire.hex64(c.string("revision")),
                           try c.decode(PhoneResult.self, forKey: WireKey("result")))
        case "unavailable":
            let c = try decoder.strictObject(["status", "state"])
            guard let state = MacRecordingState(rawValue: try c.string("state")), state != .ready else {
                throw WireError.value("state")
            }
            self = .unavailable(state)
        case "unchanged", "withheld":
            _ = try decoder.strictObject(["status"])
            self = status == "unchanged" ? .unchanged : .withheld
        default: throw WireError.value("status")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        switch self {
        case let .result(revision, result):
            try c.put("result", "status")
            try c.put(revision, "revision")
            try c.put(result, "result")
        case .unchanged: try c.put("unchanged", "status")
        case let .unavailable(state):
            try c.put("unavailable", "status")
            try c.put(state.rawValue, "state")
        case .withheld: try c.put("withheld", "status")
        }
    }
}

// POST /v1/recordings/rename and /note (M5.3): operations of the outbox

/// A name typed on the phone (nil: back to the hour), and when: of two names, the later one typed wins.
public struct RenameRequest: Codable, Equatable, Sendable {
    public var operationId: UUID
    public var recordingId: UUID
    public var name: String?
    public var typedAtMs: Int64

    public init(operationId: UUID, recordingId: UUID, name: String?, typedAtMs: Int64) throws {
        self.operationId = operationId
        self.recordingId = recordingId
        self.name = try name.map(Wire.recordingName)
        self.typedAtMs = try Wire.atLeast(0, typedAtMs)
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["operationId", "recordingId", "name", "typedAtMs"])
        try self.init(operationId: c.uuid("operationId"), recordingId: c.uuid("recordingId"),
                      name: c.nullable("name", c.string), typedAtMs: c.int64("typedAtMs"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(operationId, "operationId")
        try c.put(recordingId, "recordingId")
        try c.putNullable(name, "name")
        try c.put(typedAtMs, "typedAtMs")
    }
}

/// A note added on the phone; sent twice, it is one note.
public struct NoteRequest: Codable, Equatable, Sendable {
    public var operationId: UUID
    public var recordingId: UUID
    public var text: String

    public init(operationId: UUID, recordingId: UUID, text: String) throws {
        self.operationId = operationId
        self.recordingId = recordingId
        self.text = try Wire.text(text, 1, 20_000)
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["operationId", "recordingId", "text"])
        try self.init(operationId: c.uuid("operationId"), recordingId: c.uuid("recordingId"), text: c.string("text"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(operationId, "operationId")
        try c.put(recordingId, "recordingId")
        try c.put(text, "text")
    }
}

/// A tag put on (`on`) or taken off the phone's recording (ADR 039), by its name as typed.
public struct TagRequest: Codable, Equatable, Sendable {
    public var operationId: UUID
    public var recordingId: UUID
    public var name: String
    public var on: Bool

    public init(operationId: UUID, recordingId: UUID, name: String, on: Bool) throws {
        self.operationId = operationId
        self.recordingId = recordingId
        self.name = try Wire.text(name, 1, 200)
        self.on = on
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["operationId", "recordingId", "name", "on"])
        try self.init(operationId: c.uuid("operationId"), recordingId: c.uuid("recordingId"), name: c.string("name"),
                      on: c.bool("on"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(operationId, "operationId")
        try c.put(recordingId, "recordingId")
        try c.put(name, "name")
        try c.put(on, "on")
    }
}

/// « C'est moi »: voice `ordinal` of the recording's transcript is the user (ADR 039).
public struct VoiceRequest: Codable, Equatable, Sendable {
    public var operationId: UUID
    public var recordingId: UUID
    public var ordinal: Int
    /// One of the voice's sentences as the phone read them: a transcript made again since changes nothing.
    public var sentenceId: Int

    public init(operationId: UUID, recordingId: UUID, ordinal: Int, sentenceId: Int) throws {
        self.operationId = operationId
        self.recordingId = recordingId
        self.ordinal = try Wire.atLeast(1, ordinal)
        self.sentenceId = try Wire.atLeast(1, sentenceId)
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["operationId", "recordingId", "ordinal", "sentenceId"])
        try self.init(operationId: c.uuid("operationId"), recordingId: c.uuid("recordingId"), ordinal: c.int("ordinal"),
                      sentenceId: c.int("sentenceId"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(operationId, "operationId")
        try c.put(recordingId, "recordingId")
        try c.put(ordinal, "ordinal")
        try c.put(sentenceId, "sentenceId")
    }
}

/// `{}`: the Mac's tags (version 2).
public struct TagsRequest: Codable, Equatable, Sendable {
    public init() {}
    public init(from decoder: any Decoder) throws { _ = try decoder.strictObject([]) }
    public func encode(to encoder: any Encoder) throws { _ = encoder.object() }
}

/// The Mac's tags, the latest used first, 50 at most.
public struct TagsAnswer: Codable, Equatable, Sendable {
    public var tags: [String]

    public init(tags: [String]) throws {
        self.tags = try Wire.atMost(50, tags.map { try Wire.text($0, 1, 400) })
    }

    public init(from decoder: any Decoder) throws {
        try self.init(tags: decoder.strictObject(["tags"]).strings("tags"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(tags, "tags")
    }
}

/// `done` (applied, already, or a later name won), `later` (the Mac does not hold the recording yet), `deleted`.
public enum OperationAnswer: String, Codable, Equatable, Sendable {
    case done, later, deleted

    public init(from decoder: any Decoder) throws {
        guard let value = OperationAnswer(rawValue: try decoder.strictObject(["status"]).string("status")) else {
            throw WireError.value("status")
        }
        self = value
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(rawValue, "status")
    }
}

/// `{}`: « Oublier ce Mac » has no fields.
public struct ForgetRequest: Codable, Equatable, Sendable {
    public init() {}
    public init(from decoder: any Decoder) throws { _ = try decoder.strictObject([]) }
    public func encode(to encoder: any Encoder) throws { _ = encoder.object() }
}

// Fixtures

/// Every message by its schema's name, as the fixtures' `schema` field names it.
public enum PhoneSyncSchema: String, CaseIterable, Sendable {
    case pairingInvite = "PairingInvite"
    case phoneRelayHello = "PhoneRelayHello"
    case phoneError = "PhoneError"
    case pairRequest = "PairRequest"
    case pairAnswer = "PairAnswer"
    case helloRequest = "HelloRequest"
    case helloAnswer = "HelloAnswer"
    case announceRequest = "AnnounceRequest"
    case uploadStatus = "UploadStatus"
    case statesRequest = "StatesRequest"
    case statesAnswer = "StatesAnswer"
    case deleteRequest = "DeleteRequest"
    case deleteAnswer = "DeleteAnswer"
    case getRequest = "GetRequest"
    case getAnswer = "GetAnswer"
    case renameRequest = "RenameRequest"
    case noteRequest = "NoteRequest"
    case tagRequest = "TagRequest"
    case voiceRequest = "VoiceRequest"
    case tagsRequest = "TagsRequest"
    case tagsAnswer = "TagsAnswer"
    case operationAnswer = "OperationAnswer"
    case forgetRequest = "ForgetRequest"
    case forgetAnswer = "ForgetAnswer"

    /// Decodes `json` as this schema and encodes it again; throws on anything the schema refuses.
    public func roundTrip(_ json: Data) throws -> Data {
        func again<T: Codable>(_ type: T.Type) throws -> Data { try JSONEncoder().encode(try JSONDecoder().decode(type, from: json)) }
        return switch self {
        case .pairingInvite: try again(PairingInvite.self)
        case .phoneRelayHello: try again(PhoneRelayHello.self)
        case .phoneError: try again(PhoneError.self)
        case .pairRequest: try again(PairRequest.self)
        case .pairAnswer: try again(PairAnswer.self)
        case .helloRequest: try again(HelloRequest.self)
        case .helloAnswer: try again(HelloAnswer.self)
        case .announceRequest: try again(AnnounceRequest.self)
        case .uploadStatus: try again(UploadStatus.self)
        case .statesRequest: try again(StatesRequest.self)
        case .statesAnswer: try again(StatesAnswer.self)
        case .deleteRequest: try again(DeleteRequest.self)
        case .deleteAnswer: try StatusAnswer.decode(json, expecting: "deleted").json()
        case .getRequest: try again(GetRequest.self)
        case .getAnswer: try again(GetAnswer.self)
        case .renameRequest: try again(RenameRequest.self)
        case .noteRequest: try again(NoteRequest.self)
        case .tagRequest: try again(TagRequest.self)
        case .voiceRequest: try again(VoiceRequest.self)
        case .tagsRequest: try again(TagsRequest.self)
        case .tagsAnswer: try again(TagsAnswer.self)
        case .operationAnswer: try again(OperationAnswer.self)
        case .forgetRequest: try again(ForgetRequest.self)
        case .forgetAnswer: try StatusAnswer.decode(json, expecting: "forgotten").json()
        }
    }
}
