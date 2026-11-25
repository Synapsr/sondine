import Foundation
import SondineKit
import SondineSilero
import Testing

@Suite struct OnnxOptionsTests {
    @Test func alwaysOnPolicyIsOneThreadWithoutSpinningInSequence() {
        let policy = OnnxThreadingPolicy.alwaysOn
        #expect(policy.intraOpThreads == 1)
        #expect(policy.interOpThreads == 1)
        #expect(!policy.allowSpinning)
        #expect(policy.sequentialExecution)
    }

    @Test func onnxRuntimeAcceptsAndReportsTheAlwaysOnOptions() throws {
        let options = try OnnxSessionOptions()
        #expect(options.applied == .alwaysOn)
        // Read back from ONNX Runtime's own session options, not from our copy.
        #expect(options.configEntry("session.intra_op.allow_spinning") == "0")
        #expect(options.configEntry("session.inter_op.allow_spinning") == "0")
        #expect(options.configEntry("session.not_a_key") == nil)
        #expect(OnnxSessionOptions.runtimeVersion == "1.24.2")
    }

    @Test func spinningCanOnlyBeEnabledExplicitly() throws {
        let policy = OnnxThreadingPolicy(intraOpThreads: 2, interOpThreads: 1, allowSpinning: true, sequentialExecution: false)
        let options = try OnnxSessionOptions(policy: policy)
        #expect(options.applied == policy)
        #expect(options.configEntry("session.intra_op.allow_spinning") == "1")
    }

    @Test func missingModelIsReported() {
        let url = URL(filePath: "/nonexistent/silero_vad.onnx")
        #expect(throws: OnnxRuntimeError.modelNotFound(url.path(percentEncoded: false))) {
            _ = try SileroVoiceActivityDetector(modelURL: url)
        }
    }
}

/// Needs `native/scripts/fetch-models.sh` (skipped without the model).
@Suite(.enabled(if: Paths.hasSileroModel, "run native/scripts/fetch-models.sh"))
struct SileroDetectorTests {
    static let pinnedSha256 = "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3"

    @Test func detectorRunsWithTheAlwaysOnOptions() throws {
        let detector = try SileroVoiceActivityDetector(modelURL: Paths.sileroModel)
        #expect(detector.options.applied == .alwaysOn)
        #expect(detector.options.configEntry("session.intra_op.allow_spinning") == "0")
        #expect(detector.info.engine == "silero-vad")
        #expect(detector.info.version == "6.2")
        #expect(detector.info.modelSha256 == Self.pinnedSha256)
        #expect(detector.info.settings == [
            "intraOpThreads": "1", "interOpThreads": "1", "allowSpinning": "false", "executionMode": "sequential",
        ])
    }

    @Test func silenceScoresLowAndPartialWindowsWait() throws {
        let detector = try SileroVoiceActivityDetector(modelURL: Paths.sileroModel)
        let probabilities = try detector.push([Float](repeating: 0, count: 16_000))
        #expect(probabilities.count == 31)
        #expect(detector.pendingSamples == 16_000 - 31 * 512)
        #expect(probabilities.allSatisfy { $0 >= 0 && $0 < 0.1 })
    }

    @Test func streamsSharingOneModelKeepTheirOwnState() throws {
        let first = Signal.noise(seconds: 1, rmsDb: -25, seed: 3)
        let second = Signal.noise(seconds: 1, rmsDb: -30, seed: 11)
        let expectedFirst = try SileroVoiceActivityDetector(modelURL: Paths.sileroModel).push(first)
        let expectedSecond = try SileroVoiceActivityDetector(modelURL: Paths.sileroModel).push(second)
        // Two tracks on one session, interleaved window by window, as the helper's drain does.
        let model = try SileroModel(modelURL: Paths.sileroModel)
        let a = SileroVoiceActivityDetector(model: model)
        let b = SileroVoiceActivityDetector(model: model)
        var actualFirst: [Float] = []
        var actualSecond: [Float] = []
        for start in stride(from: 0, to: first.count, by: 512) {
            actualFirst += try a.push(Array(first[start..<min(first.count, start + 512)]))
            actualSecond += try b.push(Array(second[start..<min(second.count, start + 512)]))
        }
        #expect(actualFirst == expectedFirst)
        #expect(actualSecond == expectedSecond)
    }

    @Test func pushSizesDoNotChangeProbabilities() throws {
        let signal = Signal.noise(seconds: 1, rmsDb: -25, seed: 9)
        let whole = try SileroVoiceActivityDetector(modelURL: Paths.sileroModel)
        let expected = try whole.push(signal)
        let pieces = try SileroVoiceActivityDetector(modelURL: Paths.sileroModel)
        var actual: [Float] = []
        var offset = 0
        var size = 1
        while offset < signal.count {
            let end = min(signal.count, offset + size)
            actual += try pieces.push(Array(signal[offset..<end]))
            offset = end
            size = size * 3 % 997 + 1
        }
        #expect(actual == expected)
    }

    @Test func resetReturnsToTheInitialState() throws {
        let signal = Signal.noise(seconds: 0.5, rmsDb: -20, seed: 4)
        let detector = try SileroVoiceActivityDetector(modelURL: Paths.sileroModel)
        let first = try detector.push(signal)
        _ = try detector.push(Signal.sine(frequency: 300, rate: 16_000, seconds: 0.3))
        detector.reset()
        #expect(detector.pendingSamples == 0)
        #expect(try detector.push(signal) == first)
    }

    @Test func pipelineRunsSileroOnGatedWindows() throws {
        let detector = try SileroVoiceActivityDetector(modelURL: Paths.sileroModel)
        let pipeline = SpeechActivityPipeline(detector: detector)
        _ = try pipeline.push(SpeechActivityPipelineTests.signal)
        _ = try pipeline.finish()
        #expect(pipeline.statistics.evaluatedWindows == detector.inferences)
        #expect(pipeline.statistics.evaluatedWindows > 0)
        // Startup window plus the burst; see SpeechActivityPipelineTests.
        #expect(pipeline.statistics.evaluatedWindows <= 32 + 64)
        #expect(pipeline.statistics.vadCost.cpuNs > 0)
    }
}
