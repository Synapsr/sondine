import Foundation

/// The header written in each recording's comment tag, before the first sample
/// (ADR 032). Its schema and fixtures live in `packages/protocol`
/// (`phone-recording.ts`, `fixtures/phone/`); the Mac's import reads it with
/// `afinfo -i`. No name of a person or a device: random ids only.
public struct PhoneRecordingHeader: Equatable, Sendable {
    public static let format = "phone-recording"
    public static let version = 1
    /// Longest header the Mac accepts, in bytes.
    public static let maxBytes = 4096

    public enum InputKind: String, Sendable, CaseIterable {
        case builtIn = "built-in"
        case wired
        case bluetooth
        case other
    }

    /// Why the session's previous file ended.
    public enum PartEnd: String, Sendable {
        case interruption
        case rotation
    }

    public var recordingId: UUID
    public var sessionId: UUID
    public var part: Int
    public var startedWallMs: Int64
    public var utcOffsetMin: Int
    public var deviceId: UUID
    public var input: InputKind
    public var previous: PartEnd?
    /// `0.1.0 (12)`.
    public var app: String

    public init(
        recordingId: UUID, sessionId: UUID, part: Int, startedWallMs: Int64, utcOffsetMin: Int,
        deviceId: UUID, input: InputKind, previous: PartEnd?, app: String
    ) {
        self.recordingId = recordingId
        self.sessionId = sessionId
        self.part = part
        self.startedWallMs = startedWallMs
        self.utcOffsetMin = utcOffsetMin
        self.deviceId = deviceId
        self.input = input
        self.previous = previous
        self.app = app
    }

    /// One line of JSON, keys sorted, as the comment tag holds it.
    public func json() throws -> String {
        try validate()
        let object: [String: Any] = [
            "sondine": Self.format,
            "v": Self.version,
            "recordingId": recordingId.uuidString.lowercased(),
            "sessionId": sessionId.uuidString.lowercased(),
            "part": part,
            "startedWallMs": startedWallMs,
            "utcOffsetMin": utcOffsetMin,
            "deviceId": deviceId.uuidString.lowercased(),
            "input": input.rawValue,
            "previous": previous.map { $0.rawValue as Any } ?? NSNull(),
            "app": app,
        ]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
        return String(decoding: data, as: UTF8.self)
    }

    /// Reads a header from the comment tag's text; throws on anything the Mac would refuse.
    public static func decode(_ text: String) throws -> PhoneRecordingHeader {
        guard text.utf8.count <= maxBytes,
              let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
        else { throw PhoneHeaderError.notAHeader }
        let keys: Set<String> = [
            "sondine", "v", "recordingId", "sessionId", "part", "startedWallMs", "utcOffsetMin",
            "deviceId", "input", "previous", "app",
        ]
        guard Set(object.keys) == keys else { throw PhoneHeaderError.fields }
        guard object["sondine"] as? String == format else { throw PhoneHeaderError.notAHeader }
        guard let v = integer(object["v"]), v == Int64(version) else { throw PhoneHeaderError.version }
        guard let recordingId = uuid(object["recordingId"]),
              let sessionId = uuid(object["sessionId"]),
              let deviceId = uuid(object["deviceId"]),
              let part = integer(object["part"]),
              let started = integer(object["startedWallMs"]),
              let offset = integer(object["utcOffsetMin"]),
              let inputText = object["input"] as? String, let input = InputKind(rawValue: inputText),
              let app = object["app"] as? String
        else { throw PhoneHeaderError.fields }
        let previous: PartEnd?
        switch object["previous"] {
        case is NSNull: previous = nil
        case let text as String:
            guard let end = PartEnd(rawValue: text) else { throw PhoneHeaderError.fields }
            previous = end
        default: throw PhoneHeaderError.fields
        }
        let header = PhoneRecordingHeader(
            recordingId: recordingId, sessionId: sessionId, part: Int(part), startedWallMs: started,
            utcOffsetMin: Int(offset), deviceId: deviceId, input: input, previous: previous, app: app)
        try header.validate()
        return header
    }

    /// The rules the zod schema checks beyond types.
    public func validate() throws {
        guard (1...10_000).contains(part), startedWallMs >= 0, (-840...840).contains(utcOffsetMin) else {
            throw PhoneHeaderError.range
        }
        guard (part == 1) == (previous == nil) else { throw PhoneHeaderError.previous }
        guard app.wholeMatch(of: /[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4} \([0-9]{1,9}\)/) != nil else {
            throw PhoneHeaderError.app
        }
    }

    /// A JSON integer: a number with no fraction, never a boolean.
    private static func integer(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        guard double.rounded() == double, abs(double) <= 9_007_199_254_740_991 else { return nil }
        return number.int64Value
    }

    /// A lowercase canonical UUID, as the wire requires.
    private static func uuid(_ value: Any?) -> UUID? {
        guard let text = value as? String, text == text.lowercased(), text.count == 36 else { return nil }
        return UUID(uuidString: text)
    }
}

public enum PhoneHeaderError: Error, Equatable {
    case notAHeader, version, fields, range, previous, app
}
