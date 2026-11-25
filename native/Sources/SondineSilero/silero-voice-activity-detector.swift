import CSondineOnnx
import CryptoKit
import Foundation
import SondineKit

/// ONNX Runtime threading for always-on inference: the drain worker's own thread, no spinning.
public struct OnnxThreadingPolicy: Sendable, Equatable {
    public var intraOpThreads: Int32
    public var interOpThreads: Int32
    public var allowSpinning: Bool
    public var sequentialExecution: Bool

    public init(intraOpThreads: Int32, interOpThreads: Int32, allowSpinning: Bool, sequentialExecution: Bool) {
        self.intraOpThreads = intraOpThreads
        self.interOpThreads = interOpThreads
        self.allowSpinning = allowSpinning
        self.sequentialExecution = sequentialExecution
    }

    /// Architecture §3: one intra-op thread, no spinning, sequential execution.
    public static let alwaysOn = OnnxThreadingPolicy(
        intraOpThreads: 1, interOpThreads: 1, allowSpinning: false, sequentialExecution: true
    )

    var raw: SondineOrtThreading {
        SondineOrtThreading(
            intra_op_threads: intraOpThreads,
            inter_op_threads: interOpThreads,
            allow_spinning: allowSpinning ? 1 : 0,
            sequential: sequentialExecution ? 1 : 0
        )
    }
}

public enum OnnxRuntimeError: Error, Equatable, CustomStringConvertible {
    case options(String)
    case modelNotFound(String)
    case load(String)
    case inference(String)

    public var description: String {
        switch self {
        case .options(let message): "ONNX Runtime options: \(message)"
        case .modelNotFound(let path): "Silero model not found at \(path); run native/scripts/fetch-models.sh"
        case .load(let message): "cannot load Silero model: \(message)"
        case .inference(let message): "Silero inference failed: \(message)"
        }
    }
}

/// ONNX Runtime session options, with read-back of what ONNX Runtime accepted.
public final class OnnxSessionOptions {
    let handle: OpaquePointer

    public init(policy: OnnxThreadingPolicy = .alwaysOn) throws {
        var error = [CChar](repeating: 0, count: 512)
        let capacity = error.count
        guard let handle = sondine_ort_options_create(policy.raw, &error, capacity) else {
            throw OnnxRuntimeError.options(cMessage(error))
        }
        self.handle = handle
    }

    deinit { sondine_ort_options_destroy(handle) }

    /// Settings recorded only after the corresponding ONNX Runtime setter succeeded.
    public var applied: OnnxThreadingPolicy {
        let raw = sondine_ort_options_applied(handle)
        return OnnxThreadingPolicy(
            intraOpThreads: raw.intra_op_threads,
            interOpThreads: raw.inter_op_threads,
            allowSpinning: raw.allow_spinning == 1,
            sequentialExecution: raw.sequential == 1
        )
    }

    /// A session config entry read back from ONNX Runtime, or nil when unset.
    public func configEntry(_ key: String) -> String? {
        var value = [CChar](repeating: 0, count: 256)
        let capacity = value.count
        guard sondine_ort_options_config_entry(handle, key, &value, capacity) == 1 else { return nil }
        return cMessage(value)
    }

    public static var runtimeVersion: String { String(cString: sondine_ort_version()) }
}

/// Silero VAD v6.2 (`silero_vad.onnx`, MIT) loaded once on ONNX Runtime CPU. The model itself
/// keeps no state: every detector made from it carries its own recurrent state and context, so
/// several tracks share one session (and its memory) without hearing each other. Use it from
/// one thread at a time.
public final class SileroModel: @unchecked Sendable {
    public let info: VoiceActivityDetectorInfo
    public let options: OnnxSessionOptions
    let session: OpaquePointer

    public init(modelURL: URL, policy: OnnxThreadingPolicy = .alwaysOn) throws {
        let path = modelURL.path(percentEncoded: false)
        guard FileManager.default.fileExists(atPath: path) else { throw OnnxRuntimeError.modelNotFound(path) }
        let digest = SHA256.hash(data: try Data(contentsOf: modelURL, options: .mappedIfSafe))
        options = try OnnxSessionOptions(policy: policy)
        var message = [CChar](repeating: 0, count: 512)
        let capacity = message.count
        guard let session = sondine_silero_create(path, options.handle, &message, capacity) else {
            throw OnnxRuntimeError.load(cMessage(message))
        }
        self.session = session
        let applied = options.applied
        info = VoiceActivityDetectorInfo(
            engine: "silero-vad",
            version: SileroVoiceActivityDetector.modelVersion,
            runtime: "onnxruntime \(OnnxSessionOptions.runtimeVersion) cpu",
            modelSha256: digest.map { String(format: "%02x", $0) }.joined(),
            windowSamples: SileroVoiceActivityDetector.window,
            settings: [
                "intraOpThreads": String(applied.intraOpThreads),
                "interOpThreads": String(applied.interOpThreads),
                "allowSpinning": String(applied.allowSpinning),
                "executionMode": applied.sequentialExecution ? "sequential" : "parallel",
            ]
        )
    }

    deinit { sondine_silero_destroy(session) }
}

/// Silero VAD on one stream: 512-sample windows at 16 kHz with 64 samples of context, matching
/// the upstream `OnnxWrapper`.
public final class SileroVoiceActivityDetector: VoiceActivityDetector {
    public static let window = Int(SONDINE_SILERO_WINDOW)
    public static let context = Int(SONDINE_SILERO_CONTEXT)
    public static let modelVersion = "6.2"

    public var info: VoiceActivityDetectorInfo { model.info }
    public var options: OnnxSessionOptions { model.options }
    public var windowSamples: Int { Self.window }
    public var pendingSamples: Int { pendingCount }
    /// Windows run through the model since creation.
    public private(set) var inferences = 0

    private let model: SileroModel
    private var input = [Float](repeating: 0, count: SileroVoiceActivityDetector.context + SileroVoiceActivityDetector.window)
    private var state = [Float](repeating: 0, count: Int(SONDINE_SILERO_STATE))
    private var pending = [Float](repeating: 0, count: SileroVoiceActivityDetector.window)
    private var pendingCount = 0
    private var error = [CChar](repeating: 0, count: 512)

    /// A stream on a model of its own.
    public convenience init(modelURL: URL, policy: OnnxThreadingPolicy = .alwaysOn) throws {
        self.init(model: try SileroModel(modelURL: modelURL, policy: policy))
    }

    /// A stream on a shared model.
    public init(model: SileroModel) {
        self.model = model
    }

    public func push(_ samples: UnsafeBufferPointer<Float>) throws -> [Float] {
        guard let base = samples.baseAddress else { return [] }
        var probabilities: [Float] = []
        probabilities.reserveCapacity((pendingCount + samples.count) / Self.window)
        var offset = 0
        while offset < samples.count {
            let take = min(Self.window - pendingCount, samples.count - offset)
            let start = pendingCount
            pending.withUnsafeMutableBufferPointer { buffer in
                guard let destination = buffer.baseAddress else { return }
                (destination + start).update(from: base + offset, count: take)
            }
            pendingCount += take
            offset += take
            if pendingCount == Self.window {
                probabilities.append(try runWindow())
                pendingCount = 0
            }
        }
        return probabilities
    }

    public func reset() {
        for index in input.indices { input[index] = 0 }
        for index in state.indices { state[index] = 0 }
        pendingCount = 0
    }

    private func runWindow() throws -> Float {
        // input = previous context (64) + window (512); the next context is the window's tail.
        input.withUnsafeMutableBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return }
            pending.withUnsafeBufferPointer { window in
                guard let source = window.baseAddress else { return }
                (base + Self.context).update(from: source, count: Self.window)
            }
        }
        var probability: Float = 0
        let capacity = error.count
        let status = sondine_silero_run(model.session, input, &state, &probability, &error, capacity)
        guard status == 0 else {
            throw OnnxRuntimeError.inference(cMessage(error))
        }
        input.withUnsafeMutableBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return }
            base.update(from: base + Self.window, count: Self.context)
        }
        inferences += 1
        return probability
    }
}

/// Decodes a NUL-terminated C message buffer.
private func cMessage(_ buffer: [CChar]) -> String {
    String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
}
