/// Provenance of a VAD engine, reported with every result (architecture §13).
public struct VoiceActivityDetectorInfo: Sendable, Equatable, Codable {
    public var engine: String
    public var version: String
    public var runtime: String
    public var modelSha256: String?
    public var sampleRate: Int
    public var windowSamples: Int
    /// Engine settings that affect cost or results (threads, spinning, compute units).
    public var settings: [String: String]

    public init(
        engine: String,
        version: String,
        runtime: String,
        modelSha256: String? = nil,
        sampleRate: Int = 16_000,
        windowSamples: Int,
        settings: [String: String] = [:]
    ) {
        self.engine = engine
        self.version = version
        self.runtime = runtime
        self.modelSha256 = modelSha256
        self.sampleRate = sampleRate
        self.windowSamples = windowSamples
        self.settings = settings
    }
}

/// A stateful VAD session for one track: push 16 kHz mono samples, get one speech
/// probability per completed window (32 ms for Silero), in order.
///
/// Shared by the live helper and `sondine-audio segment` (ADR 005). Not thread-safe: one
/// drain worker owns each session.
public protocol VoiceActivityDetector: AnyObject {
    var info: VoiceActivityDetectorInfo { get }
    var windowSamples: Int { get }
    /// Samples waiting for the next window to complete.
    var pendingSamples: Int { get }

    /// Appends samples and returns the probabilities of the windows they complete.
    func push(_ samples: UnsafeBufferPointer<Float>) throws -> [Float]
    /// Clears the recurrent state and any partial window (new track run or a long gap).
    func reset()
}

extension VoiceActivityDetector {
    public func push(_ samples: [Float]) throws -> [Float] {
        try samples.withUnsafeBufferPointer { try push($0) }
    }
}
