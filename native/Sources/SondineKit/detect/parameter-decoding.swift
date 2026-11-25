import Foundation

public struct ParameterError: Error, Equatable, CustomStringConvertible {
    public var message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

struct AnyCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int?
    init(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }
}

extension Decoder {
    /// Rejects keys the type does not know: a typo in a bench config, or a manifest line that
    /// does not match the strict protocol schema, fails loudly.
    func rejectUnknownKeys<Key: CodingKey & CaseIterable>(
        _: Key.Type,
        error: (String) -> any Error = { ParameterError("unknown parameter \"\($0)\"") }
    ) throws {
        let container = try container(keyedBy: AnyCodingKey.self)
        let known = Set(Key.allCases.map(\.stringValue))
        if let unknown = container.allKeys.map(\.stringValue).filter({ !known.contains($0) }).sorted().first {
            throw error((codingPath.map(\.stringValue) + [unknown]).joined(separator: "."))
        }
    }
}

// Each parameter struct decodes partial objects: missing keys keep their documented defaults.

extension EnergyGateParameters {
    enum CodingKeys: String, CodingKey, CaseIterable {
        case openMarginDb, closeMarginDb, minimumOpenDb, openFrames, hangoverMs
        case floorFallSeconds, floorRiseSeconds, openFloorRiseDbPerSecond, digitalSilenceDb
    }

    public init(from decoder: any Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init()
        openMarginDb = try container.decodeIfPresent(Float.self, forKey: .openMarginDb) ?? openMarginDb
        closeMarginDb = try container.decodeIfPresent(Float.self, forKey: .closeMarginDb) ?? closeMarginDb
        minimumOpenDb = try container.decodeIfPresent(Float.self, forKey: .minimumOpenDb) ?? minimumOpenDb
        openFrames = try container.decodeIfPresent(Int.self, forKey: .openFrames) ?? openFrames
        hangoverMs = try container.decodeIfPresent(Int.self, forKey: .hangoverMs) ?? hangoverMs
        floorFallSeconds = try container.decodeIfPresent(Float.self, forKey: .floorFallSeconds) ?? floorFallSeconds
        floorRiseSeconds = try container.decodeIfPresent(Float.self, forKey: .floorRiseSeconds) ?? floorRiseSeconds
        openFloorRiseDbPerSecond =
            try container.decodeIfPresent(Float.self, forKey: .openFloorRiseDbPerSecond) ?? openFloorRiseDbPerSecond
        digitalSilenceDb = try container.decodeIfPresent(Float.self, forKey: .digitalSilenceDb) ?? digitalSilenceDb
    }

    public func validate() throws {
        guard closeMarginDb <= openMarginDb else { throw ParameterError("gate.closeMarginDb must not exceed gate.openMarginDb") }
        guard openFrames >= 1 else { throw ParameterError("gate.openFrames must be at least 1") }
        guard hangoverMs >= 0 else { throw ParameterError("gate.hangoverMs must not be negative") }
        guard floorFallSeconds > 0, floorRiseSeconds > 0 else { throw ParameterError("gate floor time constants must be positive") }
        guard openFloorRiseDbPerSecond >= 0 else { throw ParameterError("gate.openFloorRiseDbPerSecond must not be negative") }
    }
}

extension SegmenterParameters {
    enum CodingKeys: String, CodingKey, CaseIterable {
        case onsetThreshold, offsetThreshold, minSpeechMs, minSilenceMs, maxSegmentMs, splitSearchMs
        case preRollMs, postRollMs
    }

    public init(from decoder: any Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init()
        onsetThreshold = try container.decodeIfPresent(Float.self, forKey: .onsetThreshold) ?? onsetThreshold
        offsetThreshold = try container.decodeIfPresent(Float.self, forKey: .offsetThreshold) ?? offsetThreshold
        minSpeechMs = try container.decodeIfPresent(Int.self, forKey: .minSpeechMs) ?? minSpeechMs
        minSilenceMs = try container.decodeIfPresent(Int.self, forKey: .minSilenceMs) ?? minSilenceMs
        maxSegmentMs = try container.decodeIfPresent(Int.self, forKey: .maxSegmentMs) ?? maxSegmentMs
        splitSearchMs = try container.decodeIfPresent(Int.self, forKey: .splitSearchMs) ?? splitSearchMs
        preRollMs = try container.decodeIfPresent(Int.self, forKey: .preRollMs) ?? preRollMs
        postRollMs = try container.decodeIfPresent(Int.self, forKey: .postRollMs) ?? postRollMs
    }

    public func validate() throws {
        guard (0...1).contains(onsetThreshold), (0...1).contains(offsetThreshold) else {
            throw ParameterError("segmenter thresholds must be within [0, 1]")
        }
        guard offsetThreshold <= onsetThreshold else {
            throw ParameterError("segmenter.offsetThreshold must not exceed segmenter.onsetThreshold")
        }
        guard minSpeechMs >= 0, minSilenceMs >= 1, splitSearchMs >= 0, preRollMs >= 0, postRollMs >= 0 else {
            throw ParameterError("segmenter durations must not be negative (minSilenceMs at least 1)")
        }
        guard maxSegmentMs > minSpeechMs else { throw ParameterError("segmenter.maxSegmentMs must exceed minSpeechMs") }
    }
}

extension SpeechActivityParameters {
    enum CodingKeys: String, CodingKey, CaseIterable {
        case gate, segmenter, vadLookbackMs, vadResetAfterMs, vadStartupMs
    }

    public init(from decoder: any Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init()
        gate = try container.decodeIfPresent(EnergyGateParameters.self, forKey: .gate) ?? gate
        segmenter = try container.decodeIfPresent(SegmenterParameters.self, forKey: .segmenter) ?? segmenter
        vadLookbackMs = try container.decodeIfPresent(Int.self, forKey: .vadLookbackMs) ?? vadLookbackMs
        vadResetAfterMs = try container.decodeIfPresent(Int.self, forKey: .vadResetAfterMs) ?? vadResetAfterMs
        vadStartupMs = try container.decodeIfPresent(Int.self, forKey: .vadStartupMs) ?? vadStartupMs
    }

    public func validate() throws {
        try gate.validate()
        try segmenter.validate()
        guard vadLookbackMs >= 0, vadResetAfterMs >= 0, vadStartupMs >= 0 else { throw ParameterError("VAD durations must not be negative") }
    }

    /// Decodes a partial JSON object over the defaults and validates it.
    public static func decode(json: Data) throws -> SpeechActivityParameters {
        let parameters: SpeechActivityParameters
        do {
            parameters = try JSONDecoder().decode(SpeechActivityParameters.self, from: json)
        } catch let error as ParameterError {
            throw error
        } catch {
            throw ParameterError("invalid parameters JSON: \(error)")
        }
        try parameters.validate()
        return parameters
    }
}
