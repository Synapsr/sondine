import Foundation
import Testing
@testable import SondineVoice

// The model is not in the repository: these tests run once
// scripts/fetch-models.sh put it in native/.models (or SONDINE_WESPEAKER
// names it), and are skipped elsewhere.

let modelDirectory: URL? = {
    let native = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent()
    let path = ProcessInfo.processInfo.environment["SONDINE_WESPEAKER"]
        ?? native.appendingPathComponent(".models/wespeaker/wespeaker_v2.mlmodelc").path
    return FileManager.default.fileExists(atPath: path + "/model.mil") ? URL(fileURLWithPath: path) : nil
}()

/// A voice-like signal: a pitch with harmonics, its own formant shape per "speaker".
func voiceLike(seconds: Double, pitch: Float, formant: Float, seed: UInt64) -> [Float] {
    var state = seed
    let count = Int(seconds * 16_000)
    return (0..<count).map { index in
        state = state &* 6364136223846793005 &+ 1442695040888963407
        let noise = Float(Int64(bitPattern: state >> 1) % 1000) / 100_000
        let t = Float(index) / 16_000
        let vibrato = pitch * (1 + 0.03 * sin(2 * .pi * 5 * t))
        var sample: Float = 0
        for harmonic in 1...8 {
            let f = vibrato * Float(harmonic)
            let gain = exp(-pow((f - formant) / 600, 2)) + 0.1
            sample += gain * sin(2 * .pi * f * t) / Float(harmonic)
        }
        return 0.2 * sample + noise
    }
}

@Suite("voice embedder")
struct VoiceEmbedderTests {
    @Test("refuses less than 3 s of speech and keeps pieces apart", .enabled(if: modelDirectory != nil))
    func limits() throws {
        let embedder = try VoiceEmbedder(modelDirectory: try #require(modelDirectory))
        #expect(embedder.modelVersion.hasPrefix("wespeaker-v2:"))
        #expect(embedder.modelVersion.hasSuffix(":sondine-windows-v1"))
        #expect(throws: VoiceError.self) {
            try embedder.voice(pieces: [voiceLike(seconds: 2, pitch: 120, formant: 700, seed: 1)])
        }
        // Pieces under 1 s are left out, so 4 × 0.8 s is not enough either.
        #expect(throws: VoiceError.self) {
            try embedder.voice(pieces: (0..<4).map { voiceLike(seconds: 0.8, pitch: 120, formant: 700, seed: UInt64($0)) })
        }
        let long = try embedder.voice(pieces: [voiceLike(seconds: 40, pitch: 120, formant: 700, seed: 2)])
        #expect(long.speechSamples == VoiceLimits.maximumSpeechSamples)
        #expect(abs(similarity(long.embedding, long.embedding) - 1) < 1e-4)
    }

    @Test("embeds the same voice closer than another one", .enabled(if: modelDirectory != nil))
    func separates() throws {
        let embedder = try VoiceEmbedder(modelDirectory: try #require(modelDirectory))
        let a1 = try embedder.voice(pieces: [voiceLike(seconds: 6, pitch: 110, formant: 600, seed: 3)]).embedding
        let a2 = try embedder.voice(pieces: [
            voiceLike(seconds: 3, pitch: 112, formant: 600, seed: 4),
            voiceLike(seconds: 4, pitch: 108, formant: 600, seed: 5),
        ]).embedding
        let b = try embedder.voice(pieces: [voiceLike(seconds: 6, pitch: 220, formant: 1800, seed: 6)]).embedding
        #expect(similarity(a1, a2) > similarity(a1, b))
    }
}

@Test("decodes PCM16 little-endian")
func pcm() {
    let data = Data([0x00, 0x80, 0xFF, 0x7F, 0x00, 0x00])
    #expect(floats(pcm16: data) == [-1, Float(32767) / 32768, 0])
}
