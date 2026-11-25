import Foundation

// Spool manifest records. They mirror `packages/protocol/src/manifest.ts` (strict objects):
// one JSON object per line, discriminated on `type`, 64-bit clocks as decimal strings.

public struct ManifestError: Error, Equatable, CustomStringConvertible {
    public var message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

public enum SpoolFormat {
    public static let name = "sondine-spool"
    public static let version = 1
    public static let sampleRate = 16_000
    public static let channels = 1
    public static let sampleFormat = "s16le"
    public static let bytesPerSample = 2
    public static let envelopeEncoding = "f32le-base64"
    public static let maxEnvelopeFrames = 6_000
    /// Largest integer a JSON number carries exactly (Count, SampleIndex).
    public static let maxCount: Int64 = 9_007_199_254_740_991
}

/// Unsigned 64-bit clock value written as a decimal string (at most 2^63 − 1).
public struct ClockValue: Sendable, Hashable, Codable, ExpressibleByIntegerLiteral, CustomStringConvertible {
    public var value: UInt64

    public init(_ value: UInt64) {
        precondition(value <= UInt64(Int64.max), "clock values are limited to 2^63 - 1")
        self.value = value
    }

    public init(integerLiteral value: UInt64) { self.init(value) }

    public var description: String { String(value) }

    public init(from decoder: any Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        let digits = text.utf8
        let wellFormed = !digits.isEmpty && digits.count <= 19 && digits.allSatisfy { $0 >= 48 && $0 <= 57 }
            && (digits.count == 1 || digits.first != 48)
        guard wellFormed, let parsed = UInt64(text), parsed <= UInt64(Int64.max) else {
            throw ManifestError("clock value \"\(text)\" is not a decimal integer within 2^63 - 1")
        }
        value = parsed
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(String(value))
    }
}

public struct ManifestTimebase: Sendable, Hashable, Codable {
    public var numer: UInt32
    public var denom: UInt32

    public init(_ timebase: HostTimebase) {
        numer = timebase.numer
        denom = timebase.denom
    }

    enum CodingKeys: String, CodingKey, CaseIterable { case numer, denom }

    public init(from decoder: any Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self, error: ManifestError.unknownKey)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        numer = try container.decode(UInt32.self, forKey: .numer)
        denom = try container.decode(UInt32.self, forKey: .denom)
        guard numer >= 1, denom >= 1 else { throw ManifestError("timebase terms must be at least 1") }
    }

    public var hostTimebase: HostTimebase { HostTimebase(numer: numer, denom: denom) }
}

public struct ManifestClockPoint: Sendable, Hashable, Codable {
    public var hostTicks: ClockValue
    public var continuousNs: ClockValue

    public init(hostTicks: UInt64, continuousNs: UInt64) {
        self.hostTicks = ClockValue(hostTicks)
        self.continuousNs = ClockValue(continuousNs)
    }

    enum CodingKeys: String, CodingKey, CaseIterable { case hostTicks, continuousNs }

    public init(from decoder: any Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self, error: ManifestError.unknownKey)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hostTicks = try container.decode(ClockValue.self, forKey: .hostTicks)
        continuousNs = try container.decode(ClockValue.self, forKey: .continuousNs)
    }
}

public struct ManifestClockAnchor: Sendable, Hashable, Codable {
    public var hostTicks: ClockValue
    public var continuousNs: ClockValue
    public var wallNs: ClockValue

    public init(_ anchor: ClockAnchor) {
        hostTicks = ClockValue(anchor.hostTicks)
        continuousNs = ClockValue(anchor.continuousNs)
        wallNs = ClockValue(anchor.wallNs)
    }

    enum CodingKeys: String, CodingKey, CaseIterable { case hostTicks, continuousNs, wallNs }

    public init(from decoder: any Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self, error: ManifestError.unknownKey)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hostTicks = try container.decode(ClockValue.self, forKey: .hostTicks)
        continuousNs = try container.decode(ClockValue.self, forKey: .continuousNs)
        wallNs = try container.decode(ClockValue.self, forKey: .wallNs)
    }
}

public enum GapReason: String, Sendable, Hashable, Codable, CaseIterable {
    case ringOverflow = "ring-overflow"
    case diskFull = "disk-full"
    case writeError = "write-error"
    case stall
    case recoveryTruncated = "recovery-truncated"
}

public enum RegionCloseReason: String, Sendable, Hashable, Codable, CaseIterable {
    case silence
    case maxDuration = "max-duration"
    case trackClosed = "track-closed"
}

public struct ManifestHeader: Sendable, Hashable, Codable {
    public var type = "header"
    public var format = SpoolFormat.name
    public var version = SpoolFormat.version
    public var sessionId: String
    public var trackKey: String
    public var runId: String
    public var epoch: UInt32
    public var file: String
    public var sequence: Int64
    public var startSample: Int64
    public var rate = SpoolFormat.sampleRate
    public var channels = SpoolFormat.channels
    public var sampleFormat = SpoolFormat.sampleFormat
    public var timebase: ManifestTimebase
    public var anchor: ManifestClockAnchor
    public var helperVersion: String

    public init(
        sessionId: UUID,
        trackKey: String,
        runId: UUID,
        epoch: UInt32,
        file: String,
        sequence: Int64,
        startSample: Int64,
        timebase: HostTimebase,
        anchor: ClockAnchor,
        helperVersion: String
    ) {
        self.sessionId = sessionId.uuidString.lowercased()
        self.trackKey = trackKey
        self.runId = runId.uuidString.lowercased()
        self.epoch = epoch
        self.file = file
        self.sequence = sequence
        self.startSample = startSample
        self.timebase = ManifestTimebase(timebase)
        self.anchor = ManifestClockAnchor(anchor)
        self.helperVersion = helperVersion
    }

    enum CodingKeys: String, CodingKey, CaseIterable {
        case type, format, version, sessionId, trackKey, runId, epoch, file, sequence, startSample
        case rate, channels, sampleFormat, timebase, anchor, helperVersion
    }

    public init(from decoder: any Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self, error: ManifestError.unknownKey)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try container.expect("header", forKey: .type)
        try container.expect(SpoolFormat.name, forKey: .format)
        try container.expect(SpoolFormat.version, forKey: .version)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        trackKey = try container.decode(String.self, forKey: .trackKey)
        runId = try container.decode(String.self, forKey: .runId)
        epoch = try container.decode(UInt32.self, forKey: .epoch)
        file = try container.decode(String.self, forKey: .file)
        sequence = try container.decodeCount(forKey: .sequence)
        startSample = try container.decodeCount(forKey: .startSample)
        try container.expect(SpoolFormat.sampleRate, forKey: .rate)
        try container.expect(SpoolFormat.channels, forKey: .channels)
        try container.expect(SpoolFormat.sampleFormat, forKey: .sampleFormat)
        timebase = try container.decode(ManifestTimebase.self, forKey: .timebase)
        anchor = try container.decode(ManifestClockAnchor.self, forKey: .anchor)
        helperVersion = try container.decode(String.self, forKey: .helperVersion)
        try ManifestValidation.uuid(sessionId, "sessionId")
        try ManifestValidation.uuid(runId, "runId")
        try ManifestValidation.trackKey(trackKey)
        try ManifestValidation.pcmFileName(file)
        try ManifestValidation.versionText(helperVersion)
    }
}

public struct ManifestCommit: Sendable, Hashable, Codable {
    public var type = "commit"
    /// Commit number within the PCM file, from 0.
    public var seq: Int64
    public var epoch: UInt32
    /// Durable byte length of the PCM file after this commit.
    public var committedOffset: Int64
    public var sampleIndex: Int64
    public var sampleCount: Int64
    public var crc32: UInt32
    /// Clock of the block's first sample.
    public var at: ManifestClockPoint

    public init(seq: Int64, epoch: UInt32, committedOffset: Int64, sampleIndex: Int64, sampleCount: Int64, crc32: UInt32, at: ManifestClockPoint) {
        self.seq = seq
        self.epoch = epoch
        self.committedOffset = committedOffset
        self.sampleIndex = sampleIndex
        self.sampleCount = sampleCount
        self.crc32 = crc32
        self.at = at
    }

    /// First byte of the block in the PCM file.
    public var blockOffset: Int64 { committedOffset - sampleCount * Int64(SpoolFormat.bytesPerSample) }
    public var endSample: Int64 { sampleIndex + sampleCount }

    enum CodingKeys: String, CodingKey, CaseIterable {
        case type, seq, epoch, committedOffset, sampleIndex, sampleCount, crc32, at
    }

    public init(from decoder: any Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self, error: ManifestError.unknownKey)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try container.expect("commit", forKey: .type)
        seq = try container.decodeCount(forKey: .seq)
        epoch = try container.decode(UInt32.self, forKey: .epoch)
        committedOffset = try container.decodeCount(forKey: .committedOffset)
        sampleIndex = try container.decodeCount(forKey: .sampleIndex)
        sampleCount = try container.decodeCount(forKey: .sampleCount)
        crc32 = try container.decode(UInt32.self, forKey: .crc32)
        at = try container.decode(ManifestClockPoint.self, forKey: .at)
        guard sampleCount >= 1 else { throw ManifestError("commit sampleCount must be at least 1") }
        guard committedOffset >= sampleCount * 2 else { throw ManifestError("committedOffset must be >= sampleCount × 2") }
        guard committedOffset % 2 == 0 else { throw ManifestError("committedOffset must be a whole number of samples") }
    }
}

public struct ManifestGap: Sendable, Hashable, Codable {
    public var type = "gap"
    public var reason: GapReason
    public var fromSample: Int64
    public var toSample: Int64

    public init(reason: GapReason, fromSample: Int64, toSample: Int64) {
        precondition(toSample > fromSample, "a gap covers at least one sample")
        self.reason = reason
        self.fromSample = fromSample
        self.toSample = toSample
    }

    public var sampleCount: Int64 { toSample - fromSample }

    enum CodingKeys: String, CodingKey, CaseIterable { case type, reason, fromSample, toSample }

    public init(from decoder: any Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self, error: ManifestError.unknownKey)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try container.expect("gap", forKey: .type)
        let reasonText = try container.decode(String.self, forKey: .reason)
        guard let reason = GapReason(rawValue: reasonText) else { throw ManifestError("unknown gap reason \"\(reasonText)\"") }
        self.reason = reason
        fromSample = try container.decodeCount(forKey: .fromSample)
        toSample = try container.decodeCount(forKey: .toSample)
        guard toSample > fromSample else { throw ManifestError("toSample must be > fromSample") }
    }
}

public struct ManifestEnvelope: Sendable, Hashable, Codable {
    public var type = "envelope"
    /// Run sample index of the first frame's first sample.
    public var sampleIndex: Int64
    public var frameSamples = LogEnergyEnvelope.frameSamples
    public var count: Int
    public var encoding = SpoolFormat.envelopeEncoding
    public var data: String

    public init(sampleIndex: Int64, values: [Float]) {
        precondition(!values.isEmpty && values.count <= SpoolFormat.maxEnvelopeFrames, "1 to 6000 envelope frames")
        self.sampleIndex = sampleIndex
        count = values.count
        data = Self.encode(values)
    }

    public var values: [Float] { Self.decode(data) ?? [] }

    public static func encode(_ values: [Float]) -> String {
        var bytes = [UInt8]()
        bytes.reserveCapacity(values.count * 4)
        for value in values {
            withUnsafeBytes(of: value.bitPattern.littleEndian) { bytes.append(contentsOf: $0) }
        }
        return Data(bytes).base64EncodedString()
    }

    public static func decode(_ base64: String) -> [Float]? {
        guard let data = Data(base64Encoded: base64), data.count % 4 == 0 else { return nil }
        return stride(from: 0, to: data.count, by: 4).map { offset in
            let bits = data[data.startIndex + offset..<data.startIndex + offset + 4]
                .enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << (8 * UInt32($1.offset)) }
            return Float(bitPattern: bits)
        }
    }

    enum CodingKeys: String, CodingKey, CaseIterable { case type, sampleIndex, frameSamples, count, encoding, data }

    public init(from decoder: any Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self, error: ManifestError.unknownKey)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try container.expect("envelope", forKey: .type)
        sampleIndex = try container.decodeCount(forKey: .sampleIndex)
        try container.expect(LogEnergyEnvelope.frameSamples, forKey: .frameSamples)
        count = try container.decode(Int.self, forKey: .count)
        try container.expect(SpoolFormat.envelopeEncoding, forKey: .encoding)
        data = try container.decode(String.self, forKey: .data)
        guard (1...SpoolFormat.maxEnvelopeFrames).contains(count) else { throw ManifestError("envelope count must be 1...6000") }
        guard let values = Self.decode(data), values.count == count else {
            throw ManifestError("envelope data must decode to \(count * 4) bytes")
        }
        if let invalid = values.firstIndex(where: { !($0 >= LogEnergyEnvelope.floorDb && $0 <= 0) }) {
            throw ManifestError("envelope value \(invalid) is not a finite dBFS level within [-120, 0]")
        }
    }
}

public struct SpeechProbabilityStats: Sendable, Hashable, Codable {
    public var mean: Float
    public var max: Float

    public init(mean: Float, max: Float) {
        self.mean = mean
        self.max = max
    }

    enum CodingKeys: String, CodingKey, CaseIterable { case mean, max }

    public init(from decoder: any Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self, error: ManifestError.unknownKey)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        mean = try container.decode(Float.self, forKey: .mean)
        max = try container.decode(Float.self, forKey: .max)
        guard (0...1).contains(mean), (0...1).contains(max) else { throw ManifestError("probabilities must be within [0, 1]") }
        guard max >= mean else { throw ManifestError("max must be >= mean") }
    }
}

public struct LevelStats: Sendable, Hashable, Codable {
    public var mean: Float
    public var peak: Float

    public init(mean: Float, peak: Float) {
        self.mean = mean
        self.peak = peak
    }

    enum CodingKeys: String, CodingKey, CaseIterable { case mean, peak }

    public init(from decoder: any Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self, error: ManifestError.unknownKey)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        mean = try container.decode(Float.self, forKey: .mean)
        peak = try container.decode(Float.self, forKey: .peak)
        let range = LogEnergyEnvelope.floorDb...0
        guard range.contains(mean), range.contains(peak) else { throw ManifestError("levels must be within [-120, 0] dBFS") }
        guard peak >= mean else { throw ManifestError("peak must be >= mean") }
    }
}

public struct ManifestRegion: Sendable, Hashable, Codable {
    public var type = "region"
    public var regionId: String
    /// Speech bounds without pre-roll or post-roll.
    public var startSample: Int64
    public var endSample: Int64
    /// Samples the VAD heard as speech between the bounds, which also hold
    /// pauses shorter than the minimum silence. Nil in manifests written
    /// before it existed.
    public var voicedSamples: Int64?
    public var closeReason: RegionCloseReason
    public var speechProbability: SpeechProbabilityStats
    public var level: LevelStats

    public init(
        regionId: UUID,
        startSample: Int64,
        endSample: Int64,
        voicedSamples: Int64? = nil,
        closeReason: RegionCloseReason,
        speechProbability: SpeechProbabilityStats,
        level: LevelStats
    ) {
        precondition(endSample > startSample, "a region covers at least one sample")
        precondition(voicedSamples.map { $0 >= 0 && $0 <= endSample - startSample } ?? true, "voiced samples fit the region")
        self.regionId = regionId.uuidString.lowercased()
        self.startSample = startSample
        self.endSample = endSample
        self.voicedSamples = voicedSamples
        self.closeReason = closeReason
        self.speechProbability = speechProbability
        self.level = level
    }

    enum CodingKeys: String, CodingKey, CaseIterable {
        case type, regionId, startSample, endSample, voicedSamples, closeReason, speechProbability, level
    }

    public init(from decoder: any Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self, error: ManifestError.unknownKey)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try container.expect("region", forKey: .type)
        regionId = try container.decode(String.self, forKey: .regionId)
        startSample = try container.decodeCount(forKey: .startSample)
        endSample = try container.decodeCount(forKey: .endSample)
        voicedSamples = try container.contains(.voicedSamples) ? container.decodeCount(forKey: .voicedSamples) : nil
        let reasonText = try container.decode(String.self, forKey: .closeReason)
        guard let reason = RegionCloseReason(rawValue: reasonText) else { throw ManifestError("unknown close reason \"\(reasonText)\"") }
        closeReason = reason
        speechProbability = try container.decode(SpeechProbabilityStats.self, forKey: .speechProbability)
        level = try container.decode(LevelStats.self, forKey: .level)
        try ManifestValidation.uuid(regionId, "regionId")
        guard endSample > startSample else { throw ManifestError("endSample must be > startSample") }
        if let voicedSamples, voicedSamples > endSample - startSample {
            throw ManifestError("voicedSamples must be <= endSample - startSample")
        }
    }
}

public enum ManifestRecord: Sendable, Hashable {
    case header(ManifestHeader)
    case commit(ManifestCommit)
    case gap(ManifestGap)
    case envelope(ManifestEnvelope)
    case region(ManifestRegion)

    private struct TypeOnly: Decodable { var type: String }

    /// Decodes one line (without its newline) strictly.
    public static func decode(line: some DataProtocol) throws -> ManifestRecord {
        let data = Data(line)
        let decoder = JSONDecoder()
        do {
            let type = try decoder.decode(TypeOnly.self, from: data).type
            switch type {
            case "header": return .header(try decoder.decode(ManifestHeader.self, from: data))
            case "commit": return .commit(try decoder.decode(ManifestCommit.self, from: data))
            case "gap": return .gap(try decoder.decode(ManifestGap.self, from: data))
            case "envelope": return .envelope(try decoder.decode(ManifestEnvelope.self, from: data))
            case "region": return .region(try decoder.decode(ManifestRegion.self, from: data))
            default: throw ManifestError("unknown record type \"\(type)\"")
            }
        } catch let error as ManifestError {
            throw error
        } catch {
            throw ManifestError("invalid manifest line: \(error)")
        }
    }

    /// Encodes the record as one line, newline included.
    public func encodedLine() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var data: Data
        switch self {
        case .header(let record): data = try encoder.encode(record)
        case .commit(let record): data = try encoder.encode(record)
        case .gap(let record): data = try encoder.encode(record)
        case .envelope(let record): data = try encoder.encode(record)
        case .region(let record): data = try encoder.encode(record)
        }
        data.append(0x0A)
        return data
    }
}

extension ManifestError {
    static func unknownKey(_ path: String) -> any Error { ManifestError("unknown key \"\(path)\"") }
}

extension KeyedDecodingContainer {
    fileprivate func expect<Value: Decodable & Equatable>(_ expected: Value, forKey key: Key) throws {
        let value = try decode(Value.self, forKey: key)
        guard value == expected else { throw ManifestError("\(key.stringValue) must be \(expected)") }
    }

    fileprivate func decodeCount(forKey key: Key) throws -> Int64 {
        let value = try decode(Int64.self, forKey: key)
        guard value >= 0, value <= SpoolFormat.maxCount else {
            throw ManifestError("\(key.stringValue) must be a non-negative integer within 2^53 - 1")
        }
        return value
    }
}

enum ManifestValidation {
    static func uuid(_ text: String, _ field: String) throws {
        let bytes = Array(text.utf8)
        let hyphens = [8, 13, 18, 23]
        let valid = bytes.count == 36 && bytes.indices.allSatisfy { index in
            hyphens.contains(index) ? bytes[index] == 45 : isLowerHex(bytes[index])
        }
        guard valid else { throw ManifestError("\(field) must be a lowercase UUID") }
    }

    static func trackKey(_ key: String) throws {
        if key == "system:other" { return }
        if key.hasPrefix("input:") {
            let uid = key.dropFirst("input:".count).unicodeScalars
            guard (1...512).contains(uid.count), uid.allSatisfy({ $0.value > 0x1f && $0.value != 0x7f }) else {
                throw ManifestError("invalid input track key")
            }
            return
        }
        if key.hasPrefix("app:") {
            let bundle = Array(key.dropFirst("app:".count).utf8)
            guard (1...255).contains(bundle.count), isAlphanumeric(bundle[0]),
                  bundle.allSatisfy({ isAlphanumeric($0) || $0 == 95 || $0 == 46 || $0 == 45 })
            else { throw ManifestError("invalid app track key") }
            return
        }
        throw ManifestError("trackKey must be input:<uid>, app:<bundleId>, or system:other")
    }

    static func pcmFileName(_ name: String) throws {
        let bytes = Array(name.utf8)
        guard bytes.count >= 5, bytes.count <= 128, name.hasSuffix(".pcm") else { throw ManifestError("file must be a .pcm name") }
        let stem = bytes.dropLast(4)
        guard let first = stem.first, isAlphanumeric(first) || first == 95 || first == 45,
              stem.allSatisfy({ isAlphanumeric($0) || $0 == 95 || $0 == 46 || $0 == 45 })
        else { throw ManifestError("file must be a plain sibling .pcm name") }
    }

    /// Protocol `SpoolPath`: relative, `/`-separated, no segment starting with a dot, at most 512 bytes.
    static func spoolPath(_ path: String) throws {
        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        let valid = path.utf8.count <= 512 && segments.allSatisfy { segment in
            guard let first = segment.utf8.first, isAlphanumeric(first) || first == 95 || first == 45 else { return false }
            return segment.utf8.allSatisfy { isAlphanumeric($0) || $0 == 95 || $0 == 46 || $0 == 45 }
        }
        guard valid else { throw ManifestError("\"\(path)\" is not a relative spool path") }
    }

    static func versionText(_ text: String) throws {
        let bytes = Array(text.utf8)
        guard (1...64).contains(bytes.count), isAlphanumeric(bytes[0]),
              bytes.allSatisfy({ isAlphanumeric($0) || $0 == 46 || $0 == 95 || $0 == 43 || $0 == 45 })
        else { throw ManifestError("helperVersion is not a version string") }
    }

    private static func isLowerHex(_ byte: UInt8) -> Bool { (48...57).contains(byte) || (97...102).contains(byte) }
    private static func isAlphanumeric(_ byte: UInt8) -> Bool {
        (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte)
    }
}

extension ManifestRegion {
    /// The manifest record of a closed region: speech bounds without padding.
    public init(region: SpeechRegion, regionId: UUID) {
        let maximum = min(1, max(0, region.maxProbability))
        let endSample = max(region.speechEndSample, region.speechStartSample + 1)
        self.init(
            regionId: regionId,
            startSample: region.speechStartSample,
            endSample: endSample,
            voicedSamples: min(max(0, region.voicedSamples), endSample - region.speechStartSample),
            closeReason: region.closeReason,
            speechProbability: SpeechProbabilityStats(mean: min(maximum, max(0, region.meanProbability)), max: maximum),
            level: region.level ?? LevelStats(mean: LogEnergyEnvelope.floorDb, peak: LogEnergyEnvelope.floorDb)
        )
    }
}
