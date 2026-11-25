import Foundation
import SondineKit
import SondineSilero
import Testing

/// A generated clip: 3 s of -60 dBFS noise, 1 s of a -20 dBFS tone, 3 s of noise, 48 kHz stereo.
/// It tests plumbing only; a tone is not speech, so it says nothing about VAD quality.
enum GeneratedClip {
    static let rate = 48_000.0
    static let channels = 2

    static let samples: [Float] = {
        let mono = Signal.noise(seconds: 3, rate: rate, rmsDb: -60, seed: 1)
            + Signal.sine(frequency: 220, rate: rate, seconds: 1, amplitude: 0.14)
            + Signal.noise(seconds: 3, rate: rate, rmsDb: -60, seed: 2)
        return mono.flatMap { [$0, $0] }
    }()

    static func write(in directory: TemporaryDirectory) throws -> URL {
        let url = directory.url.appending(path: "clip.wav")
        try WaveFile.write(samples, rate: rate, channels: channels, to: url)
        return url
    }
}

@Suite struct SegmentFileTests {
    @Test func segmentsAGeneratedStereoWav() throws {
        let directory = try TemporaryDirectory()
        let url = try GeneratedClip.write(in: directory)
        let detector = EnergyFakeDetector()
        let result = try SegmentFile.run(input: url, detector: detector)

        #expect(result.input.sampleRate == 48_000)
        #expect(result.input.channels == 2)
        #expect(result.input.frames == 336_000)
        #expect(abs(result.output.samples - 112_000) <= 2)
        #expect(!result.stats.resampler.bypassed)
        #expect(result.stats.resampler.clippedSamples == 0)
        #expect(result.stats.envelopeFrames == Int(result.output.samples / 160))

        let region = try #require(result.regions.first)
        #expect(result.regions.count == 1)
        #expect(abs(region.speechStartSample - 48_000) <= 512)
        #expect(abs(region.speechEndSample - 64_000) <= 512)
        #expect(region.startSample == region.speechStartSample - 24_000)
        #expect(region.startMs == Double(region.startSample) / 16)
        #expect(region.closeReason == .silence)
        #expect(abs(region.levelMeanDb - -20) < 1.5)

        #expect(result.vad?.engine == "fake")
        #expect(result.stats.vad.evaluatedWindows == detector.windows.count)
        #expect(result.stats.vad.evaluatedWindows <= 32 + 64)
        #expect(result.stats.gate.opens >= 1)
        #expect(result.stats.regions.count == 1)
        for stage in [result.timing.decode, result.timing.resample, result.timing.envelope, result.timing.gate, result.timing.vad] {
            #expect(stage.calls > 0)
        }
        #expect(result.timing.total.wallNs >= result.timing.vad.wallNs)

        // The JSON written by the CLI decodes back to the same result.
        let decoded = try JSONDecoder().decode(SegmentFileResult.self, from: SegmentFile.encode(result))
        #expect(decoded == result)
    }

    @Test func gateOnlyModeHasNoVadProvenance() throws {
        let directory = try TemporaryDirectory()
        let result = try SegmentFile.run(input: try GeneratedClip.write(in: directory), detector: nil)
        #expect(result.vad == nil)
        #expect(result.regions.count == 1)
        #expect(result.stats.vad.cpuMs == 0)
    }

    @Test func sixteenKilohertzMonoBypassesTheConverter() throws {
        let directory = try TemporaryDirectory()
        let url = directory.url.appending(path: "mono.wav")
        try WaveFile.write(SpeechActivityPipelineTests.signal, rate: 16_000, channels: 1, to: url)
        let result = try SegmentFile.run(input: url, detector: EnergyFakeDetector())
        #expect(result.stats.resampler.bypassed)
        #expect(result.output.samples == Int64(SpeechActivityPipelineTests.signal.count))
        #expect(result.regions.count == 1)
    }

    @Test func unreadableInputIsReported() throws {
        let directory = try TemporaryDirectory()
        let url = directory.url.appending(path: "not-audio.wav")
        try Data("not a wave file".utf8).write(to: url)
        #expect(throws: SegmentFileError.self) { try SegmentFile.run(input: url, detector: nil) }
    }

    @Test(.enabled(if: Paths.hasSileroModel, "run native/scripts/fetch-models.sh"))
    func sileroRunsInFileMode() throws {
        let directory = try TemporaryDirectory()
        let detector = try SileroVoiceActivityDetector(modelURL: Paths.sileroModel)
        let result = try SegmentFile.run(input: try GeneratedClip.write(in: directory), detector: detector)
        #expect(result.vad?.engine == "silero-vad")
        #expect(result.vad?.settings["intraOpThreads"] == "1")
        #expect(result.stats.vad.evaluatedWindows == detector.inferences)
        #expect(result.stats.vad.evaluatedWindows > 0)
        #expect(result.stats.vad.cpuSecondsPerAudioHour > 0)
    }
}

@Suite struct SpeechActivityParameterTests {
    @Test func partialJsonOverridesOnlyTheGivenFields() throws {
        let parameters = try SpeechActivityParameters.decode(json: Data(#"{"segmenter":{"preRollMs":500},"gate":{"openMarginDb":12}}"#.utf8))
        var expected = SpeechActivityParameters()
        expected.segmenter.preRollMs = 500
        expected.gate.openMarginDb = 12
        #expect(parameters == expected)
        #expect(try SpeechActivityParameters.decode(json: Data("{}".utf8)) == SpeechActivityParameters())
    }

    @Test func documentedDefaults() {
        let defaults = SpeechActivityParameters()
        #expect(defaults.segmenter.preRollMs == 1_500)
        #expect(defaults.segmenter.postRollMs == 800)
        #expect(defaults.segmenter.minSpeechMs == 250)
        #expect(defaults.segmenter.minSilenceMs == 600)
        #expect(defaults.segmenter.maxSegmentMs == 60_000)
        #expect(defaults.segmenter.onsetThreshold == 0.5)
        #expect(defaults.segmenter.offsetThreshold == 0.35)
    }

    @Test func unknownKeysAndInvalidValuesAreRejected() {
        #expect(throws: ParameterError("unknown parameter \"segmenter.preroll\"")) {
            try SpeechActivityParameters.decode(json: Data(#"{"segmenter":{"preroll":1}}"#.utf8))
        }
        #expect(throws: ParameterError("unknown parameter \"vad\"")) {
            try SpeechActivityParameters.decode(json: Data(#"{"vad":{}}"#.utf8))
        }
        #expect(throws: ParameterError.self) {
            try SpeechActivityParameters.decode(json: Data(#"{"segmenter":{"onsetThreshold":0.2}}"#.utf8))
        }
        #expect(throws: ParameterError.self) {
            try SpeechActivityParameters.decode(json: Data("[1]".utf8))
        }
    }
}

/// The built executables (`swift build` or `swift test` builds them next to the test bundle).
@Suite(.enabled(if: Paths.product("sondine-audio") != nil, "build the package first"))
struct CommandLineTests {
    private var audio: URL { Paths.products.appending(path: "sondine-audio") }

    @Test func serveNeedsASocketAndADataDirectory() throws {
        let result = try ProcessResult.run(audio, ["serve"])
        #expect(result.status == 64)
        #expect(result.stderr.contains("--socket is required"))
    }

    @Test func serveRefusesASocketInADirectoryItDoesNotOwn() throws {
        let directory = try TemporaryDirectory()
        let result = try ProcessResult.run(audio, ["serve", "--socket", "/usr/audio.sock", "--data", directory.url.path(percentEncoded: false), "--hal", "fake"])
        #expect(result.status == 1)
        #expect(result.stderr.contains("not owned by this user"))
    }

    /// End of file on stdin (Electron main's lifetime pipe) ends the helper cleanly: after
    /// `quit`, main quit on purpose; without it, main died, and a helper outside an app bundle
    /// (here) relaunches nothing. The fake HAL keeps this free of hardware and permission prompts.
    @Test(arguments: [true, false]) func serveExitsWhenStdinCloses(quit: Bool) throws {
        let root = URL(filePath: "/tmp/sondine-serve-\(UUID().uuidString.prefix(8))", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let socket = root.appending(path: "audio.sock").path(percentEncoded: false)
        let result = try ProcessResult.run(audio, [
            "serve", "--socket", socket, "--data", root.path(percentEncoded: false), "--hal", "fake", "--vad", "none",
        ], input: quit ? "quit\n" : "")
        #expect(result.status == 0, "\(result.stderr)")
        #expect(result.stderr.contains(quit ? "exit (stdin closed)" : "exit (main gone)"))
        #expect(quit || result.stderr.contains("not relaunching"))
        #expect(!FileManager.default.fileExists(atPath: socket))
    }

    @Test func usageErrorsExitWith64() throws {
        #expect(try ProcessResult.run(audio, []).status == 64)
        #expect(try ProcessResult.run(audio, ["segment", "--in", "a.wav"]).status == 64)
        let bad = try ProcessResult.run(audio, ["segment", "--in", "a.wav", "--out", "b.json", "--params", #"{"bogus":1}"#])
        #expect(bad.status == 64)
        #expect(bad.stderr.contains("unknown parameter \"bogus\""))
    }

    @Test func segmentWritesTheResultJson() throws {
        let directory = try TemporaryDirectory()
        let input = try GeneratedClip.write(in: directory)
        let output = directory.url.appending(path: "result.json")
        let run = try ProcessResult.run(audio, [
            "segment", "--in", input.path(percentEncoded: false), "--out", output.path(percentEncoded: false),
            "--vad", "none", "--params", #"{"segmenter":{"preRollMs":500}}"#,
        ])
        #expect(run.status == 0, "\(run.stderr)")
        let result = try JSONDecoder().decode(SegmentFileResult.self, from: Data(contentsOf: output))
        #expect(result.schema == "sondine.segment-result")
        #expect(result.parameters.segmenter.preRollMs == 500)
        let region = try #require(result.regions.first)
        #expect(region.startSample == region.speechStartSample - 8_000)
        #expect(result.vad == nil)
    }

    @Test(.enabled(if: Paths.hasSileroModel, "run native/scripts/fetch-models.sh"))
    func segmentFindsTheSileroModelNextToThePackage() throws {
        let directory = try TemporaryDirectory()
        let input = try GeneratedClip.write(in: directory)
        let output = directory.url.appending(path: "result.json")
        var environment = ProcessInfo.processInfo.environment
        environment["SONDINE_VAD_MODEL"] = nil
        let run = try ProcessResult.run(
            audio,
            ["segment", "--in", input.path(percentEncoded: false), "--out", output.path(percentEncoded: false)],
            environment: environment
        )
        #expect(run.status == 0, "\(run.stderr)")
        let result = try JSONDecoder().decode(SegmentFileResult.self, from: Data(contentsOf: output))
        #expect(result.vad?.engine == "silero-vad")
        #expect(result.vad?.modelSha256 == SileroDetectorTests.pinnedSha256)
    }
}
