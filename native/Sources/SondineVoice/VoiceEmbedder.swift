import CoreML
import CryptoKit
import Foundation

// Speaker embeddings for naming voices (architecture §8): WeSpeaker v2 as a
// Core ML model (CC-BY-4.0, from FluidInference/speaker-diarization-coreml),
// on the CPU and Neural Engine, nothing else loaded. The model takes three
// 10 s slots of 16 kHz audio and a 589-frame mask per slot; Sondine fills the
// first slot only, repeating a shorter window until the slot is full (as
// FluidAudio's extractor does) with a full mask, and reads the first row.
//
// A voice is embedded from its exclusive speech, cut by core into pieces of
// one contiguous stretch each. A window never spans two pieces: each piece is
// split into equal windows of at most 10 s, each window is embedded and
// L2-normalised, and the windows are pooled by length, then normalised.

public struct VoiceError: Error, Equatable, CustomStringConvertible {
    public let description: String
    public init(_ description: String) { self.description = description }
}

public enum VoiceLimits {
    public static let sampleRate = 16_000
    /// One model slot: 10 s.
    public static let windowSamples = 160_000
    /// Pieces shorter than this are left out (too little voice to be reliable).
    public static let minimumPieceSamples = 16_000
    /// A voice needs at least 3 s of exclusive speech, and at most 30 s are read.
    public static let minimumSpeechSamples = 48_000
    public static let maximumSpeechSamples = 480_000
    public static let dimensions = 256
    /// Bumped whenever windowing or pooling changes: embeddings of two versions are never compared.
    public static let pipelineVersion = "sondine-windows-v1"
}

public final class VoiceEmbedder {
    private let model: MLModel
    private let maskFrames: Int
    /// `wespeaker-v2:<sha256 of the model files>:<pipeline version>`.
    public let modelVersion: String

    public init(modelDirectory: URL) throws {
        modelVersion = "wespeaker-v2:\(try Self.fingerprint(modelDirectory)):\(VoiceLimits.pipelineVersion)"
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .cpuAndNeuralEngine
        model = try MLModel(contentsOf: modelDirectory, configuration: configuration)
        let inputs = model.modelDescription.inputDescriptionsByName
        guard inputs["waveform"]?.multiArrayConstraint?.shape == [3, 160_000].map(NSNumber.init),
            let mask = inputs["mask"]?.multiArrayConstraint?.shape, mask.count == 2, mask[0] == 3,
            model.modelDescription.outputDescriptionsByName["embedding"]?.multiArrayConstraint?.shape
                == [3, 256].map(NSNumber.init)
        else { throw VoiceError("unexpected WeSpeaker model signature") }
        maskFrames = mask[1].intValue
    }

    /// The model's files, in a fixed order, hashed with their relative paths.
    static func fingerprint(_ directory: URL) throws -> String {
        let root = directory.resolvingSymlinksInPath().standardizedFileURL
        let files = ["analytics/coremldata.bin", "coremldata.bin", "metadata.json", "model.mil", "weights/weight.bin"]
        var hasher = SHA256()
        for relative in files {
            let file = root.appendingPathComponent(relative).resolvingSymlinksInPath()
            guard file.path.hasPrefix(root.path + "/") else { throw VoiceError("model file escapes its directory") }
            hasher.update(data: Data((relative + "\0").utf8))
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// One window (at most 10 s), as a unit vector.
    func window(_ samples: ArraySlice<Float>) throws -> [Float] {
        guard !samples.isEmpty, samples.count <= VoiceLimits.windowSamples else {
            throw VoiceError("a window holds 1 to 160000 samples")
        }
        let waveform = try MLMultiArray(shape: [3, 160_000], dataType: .float32)
        let mask = try MLMultiArray(shape: [3, NSNumber(value: maskFrames)], dataType: .float32)
        waveform.withUnsafeMutableBytes { raw, _ in
            let out = raw.bindMemory(to: Float.self)
            out.initialize(repeating: 0)
            var filled = 0
            while filled < VoiceLimits.windowSamples {
                for sample in samples where filled < VoiceLimits.windowSamples {
                    out[filled] = sample
                    filled += 1
                }
            }
        }
        mask.withUnsafeMutableBytes { raw, _ in
            let out = raw.bindMemory(to: Float.self)
            out.initialize(repeating: 0)
            for index in 0..<maskFrames { out[index] = 1 }
        }
        let input = try MLDictionaryFeatureProvider(dictionary: [
            "waveform": MLFeatureValue(multiArray: waveform),
            "mask": MLFeatureValue(multiArray: mask),
        ])
        guard let embedding = try model.prediction(from: input).featureValue(for: "embedding")?.multiArrayValue
        else { throw VoiceError("the model returned no embedding") }
        let row = (0..<VoiceLimits.dimensions).map { embedding[[0, NSNumber(value: $0)]].floatValue }
        return try normalized(row)
    }

    /// The voice's embedding from its pieces of exclusive speech, and how much speech it read.
    public func voice(pieces: [[Float]]) throws -> (embedding: [Float], speechSamples: Int) {
        var budget = VoiceLimits.maximumSpeechSamples
        var used: [ArraySlice<Float>] = []
        // The longest pieces first, up to 30 s.
        for piece in pieces.filter({ $0.count >= VoiceLimits.minimumPieceSamples }).sorted(by: { $0.count > $1.count }) {
            guard budget > 0 else { break }
            let taken = piece[..<min(piece.count, budget)]
            if taken.count < VoiceLimits.minimumPieceSamples { break }
            guard taken.allSatisfy(\.isFinite) else { throw VoiceError("audio holds non-finite samples") }
            used.append(taken)
            budget -= taken.count
        }
        let speech = used.reduce(0) { $0 + $1.count }
        guard speech >= VoiceLimits.minimumSpeechSamples else {
            throw VoiceError("a voice needs at least 3 s of exclusive speech")
        }
        var pooled = [Float](repeating: 0, count: VoiceLimits.dimensions)
        for piece in used {
            let count = (piece.count + VoiceLimits.windowSamples - 1) / VoiceLimits.windowSamples
            for index in 0..<count {
                let start = piece.startIndex + piece.count * index / count
                let end = piece.startIndex + piece.count * (index + 1) / count
                let unit = try window(piece[start..<end])
                let weight = Float(end - start) / Float(speech)
                for dimension in pooled.indices { pooled[dimension] += unit[dimension] * weight }
            }
        }
        return (try normalized(pooled), speech)
    }
}

func normalized(_ vector: [Float]) throws -> [Float] {
    guard vector.count == VoiceLimits.dimensions, vector.allSatisfy(\.isFinite) else {
        throw VoiceError("expected a finite 256-dimensional embedding")
    }
    let norm = sqrt(vector.reduce(0.0) { $0 + Double($1) * Double($1) })
    guard norm.isFinite, norm > 1e-8 else { throw VoiceError("the embedding has zero norm") }
    return vector.map { Float(Double($0) / norm) }
}

/// Cosine similarity of two unit vectors.
public func similarity(_ a: [Float], _ b: [Float]) -> Float {
    zip(a, b).reduce(0) { $0 + $1.0 * $1.1 }
}

/// PCM16 little-endian mono to floats in [-1, 1].
public func floats(pcm16 data: Data) -> [Float] {
    data.withUnsafeBytes { raw in
        raw.bindMemory(to: Int16.self).map { Float(Int16(littleEndian: $0)) / 32768 }
    }
}
