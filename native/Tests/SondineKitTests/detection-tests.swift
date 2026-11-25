import Foundation
import SondineKit
import Testing

@Suite struct LogEnergyEnvelopeTests {
    @Test func fullScaleSineIsMinusThreeDecibels() {
        var envelope = LogEnergyEnvelope()
        let frames = envelope.push(Signal.sine(frequency: 1_000, rate: 16_000, seconds: 1, amplitude: 1))
        #expect(frames.count == 100)
        #expect(frames.map(\.index) == Array(0..<100))
        for frame in frames { #expect(abs(frame.db - -3.0103) < 0.05) }
    }

    @Test func silenceIsTheFloorAndNonFiniteInputIsGuarded() {
        var envelope = LogEnergyEnvelope()
        let frames = envelope.push([Float](repeating: 0, count: 320) + [Float](repeating: .nan, count: 160))
        #expect(frames.map(\.db) == [-120, -120, -120])
    }

    @Test func pushSizesDoNotChangeTheFrames() {
        let signal = Signal.noise(seconds: 0.5, rmsDb: -30)
        var whole = LogEnergyEnvelope()
        let expected = whole.push(signal)
        var pieces = LogEnergyEnvelope()
        var frames: [EnvelopeFrame] = []
        var offset = 0
        for size in [7, 333, 1_000, 1, 159, 160, 161] where offset < signal.count {
            let end = min(signal.count, offset + size)
            frames += pieces.push(Array(signal[offset..<end]))
            offset = end
        }
        frames += pieces.push(Array(signal[offset...]))
        #expect(frames == expected)
    }

    @Test func restartAtAnUnalignedIndexSkipsThePartialFrame() {
        var envelope = LogEnergyEnvelope(startSampleIndex: 100)
        let frames = envelope.push([Float](repeating: 0.1, count: 60 + 320))
        // Samples 100..<160 complete frame 0 partially: it is not emitted.
        #expect(frames.map(\.index) == [1, 2])
    }
}

@Suite struct EnergyGateTests {
    private func frames(_ levels: [(db: Float, seconds: Double)]) -> [EnvelopeFrame] {
        var result: [EnvelopeFrame] = []
        for level in levels {
            for _ in 0..<Int(level.seconds * 100) {
                result.append(EnvelopeFrame(index: Int64(result.count), db: level.db))
            }
        }
        return result
    }

    private func decisions(_ input: [EnvelopeFrame], parameters: EnergyGateParameters = EnergyGateParameters()) -> (gate: EnergyGate, open: [Bool]) {
        var gate = EnergyGate(parameters: parameters)
        let open = input.map { gate.process($0).isOpen }
        return (gate, open)
    }

    @Test func stationaryNoiseNeverOpens() {
        var generator = SplitMix(seed: 3)
        let noisy = (0..<1_000).map { index in
            EnvelopeFrame(index: Int64(index), db: -55 + Float(generator.next() % 600) / 100 - 3)
        }
        let (gate, open) = decisions(noisy)
        #expect(!open.contains(true))
        #expect(abs((gate.floorDb ?? 0) - -56) < 4)
    }

    @Test func burstOpensFastAndClosesAfterTheHangover() throws {
        let input = frames([(-60, 3), (-30, 1), (-60, 2)])
        let (gate, open) = decisions(input)
        let opened = try #require(open.firstIndex(of: true))
        #expect(opened == 301)  // two frames above the threshold
        let closed = try #require(open[opened...].firstIndex(of: false))
        // 400 ms hangover after the burst ends at frame 400.
        #expect(closed >= 438 && closed <= 442)
        #expect(gate.statistics.opens == 1)
    }

    @Test func levelsBetweenThresholdsKeepTheCurrentState() {
        // Floor about -60: open threshold about -51, close threshold about -55.
        let input = frames([(-60, 3), (-53.5, 0.3), (-30, 0.2), (-53.5, 0.5), (-60, 1)])
        let open = decisions(input).open
        #expect(!open[300..<330].contains(true))
        #expect(!open[335..<400].contains(false))
        #expect(!open[450..<500].contains(true))
    }

    @Test func singleFrameClicksStayClosed() {
        var input = frames([(-60, 3)])
        for index in stride(from: 50, to: 300, by: 25) { input[index].db = -20 }
        #expect(!decisions(input).open.contains(true))
    }

    @Test func digitalSilenceNeitherOpensNorMovesTheFloor() {
        let input = frames([(-60, 2), (-120, 5)])
        let (gate, open) = decisions(input)
        #expect(!open.contains(true))
        #expect(abs((gate.floorDb ?? 0) - -60) < 0.5)
        #expect(gate.statistics.digitalSilenceFrames == 500)
    }

    @Test func quietRoomsStayBelowTheAbsoluteMinimum() {
        let input = frames([(-100, 2), (-78, 1)])
        #expect(!decisions(input).open.contains(true))
    }

    @Test func steadyNoiseStepEventuallyClosesTheGate() throws {
        // A fan starts: 20 dB louder, then stays.
        let input = frames([(-60, 3), (-40, 60)])
        let open = decisions(input).open
        let opened = try #require(open.firstIndex(of: true))
        let closed = try #require(open[opened...].firstIndex(of: false))
        #expect(Double(closed - opened) / 100 < 40)
        #expect(!open[(closed + 100)...].contains(true))
    }
}

@Suite struct SpeechSegmenterTests {
    static let window = 512

    /// Probability per window from (probability, windows) runs, fed in order.
    private func run(
        _ runs: [(p: Float, windows: Int)],
        parameters: SegmenterParameters = SegmenterParameters()
    ) -> (regions: [SpeechRegion], events: [SegmenterEvent], segmenter: SpeechSegmenter) {
        var segmenter = SpeechSegmenter(parameters: parameters)
        var events: [SegmenterEvent] = []
        var start: Int64 = 0
        for run in runs {
            for _ in 0..<run.windows {
                events += segmenter.process(windowStart: start, sampleCount: Self.window, probability: run.p)
                start += Int64(Self.window)
            }
        }
        events += segmenter.finish()
        let regions = events.compactMap { event -> SpeechRegion? in
            if case .closed(let region) = event { region } else { nil }
        }
        return (regions, events, segmenter)
    }

    private func samples(windows: Int) -> Int64 { Int64(windows * Self.window) }

    @Test func burstBecomesAPaddedRegion() throws {
        let (regions, events, _) = run([(0, 100), (0.9, 50), (0, 160)])
        let region = try #require(regions.first)
        #expect(regions.count == 1)
        #expect(region.speechStartSample == samples(windows: 100))
        #expect(region.speechEndSample == samples(windows: 150))
        #expect(region.startSample == samples(windows: 100) - 24_000)
        #expect(region.endSample == samples(windows: 150) + 12_800)
        #expect(region.closeReason == .silence)
        #expect(abs(region.meanProbability - 0.9) < 0.001)
        #expect(region.voicedSamples == samples(windows: 50))
        // Opened once the burst lasted minSpeech (250 ms = 8 windows).
        #expect(events.first == .opened(startSample: region.startSample, speechStartSample: region.speechStartSample))
    }

    @Test func shortBlipsAreRejected() {
        let (regions, _, segmenter) = run([(0, 50), (0.95, 5), (0, 100)])
        #expect(regions.isEmpty)
        #expect(segmenter.statistics.rejectedBursts == 1)
    }

    @Test func pausesShorterThanTheMergeHorizonStayInOneRegion() {
        // 1.5 s pause < pre-roll + post-roll (2.3 s).
        let (regions, _, _) = run([(0, 100), (0.9, 40), (0, 47), (0.9, 40), (0, 200)])
        #expect(regions.count == 1)
        #expect(regions.first?.speechEndSample == samples(windows: 227))
    }

    @Test func longerPausesSplitIntoRegionsThatNeverOverlap() {
        let (regions, _, _) = run([(0, 100), (0.9, 40), (0, 80), (0.9, 40), (0, 200)])
        #expect(regions.count == 2)
        if regions.count == 2 {
            #expect(regions[1].startSample >= regions[0].endSample)
            #expect(regions[1].speechStartSample == samples(windows: 220))
        }
    }

    @Test func hysteresisHoldsSpeechBetweenThresholds() {
        // 0.4 is below onset (0.5) but above offset (0.35).
        let held = run([(0, 50), (0.9, 10), (0.4, 60), (0, 200)]).regions
        #expect(held.first?.speechEndSample == samples(windows: 120))
        let idle = run([(0, 50), (0.4, 60), (0, 100)]).regions
        #expect(idle.isEmpty)
    }

    @Test func preRollIsClampedToTheStreamStart() {
        let (regions, _, _) = run([(0, 10), (0.9, 40), (0, 200)])
        #expect(regions.first?.startSample == 0)
    }

    @Test func longSpeechSplitsAtTheQuietestWindow() throws {
        // 70 s of speech with a dip at about 57 s.
        let (regions, _, segmenter) = run([(0.9, 1_780), (0.2, 1), (0.9, 406), (0, 200)])
        #expect(regions.count == 2)
        let first = try #require(regions.first)
        let second = try #require(regions.last)
        #expect(first.closeReason == .maxDuration)
        #expect(first.splitAfter)
        #expect(first.endSample == samples(windows: 1_780))
        #expect(second.splitBefore)
        #expect(second.startSample == first.endSample)
        #expect(second.speechStartSample == first.endSample)
        #expect(segmenter.statistics.splits == 1)
    }

    @Test func finishClosesTheOpenRegionAtTheStreamEnd() throws {
        let (regions, _, _) = run([(0, 100), (0.9, 40)])
        let region = try #require(regions.first)
        #expect(region.closeReason == .trackClosed)
        #expect(region.endSample == samples(windows: 140))
    }
}

/// Deterministic stand-in for a VAD: probability from the window's RMS.
final class EnergyFakeDetector: VoiceActivityDetector {
    let info = VoiceActivityDetectorInfo(engine: "fake", version: "1", runtime: "test", windowSamples: 512)
    let windowSamples = 512
    var pendingSamples: Int { pending.count }
    private(set) var windows: [Float] = []
    private(set) var resets = 0
    private var pending: [Float] = []

    func push(_ samples: UnsafeBufferPointer<Float>) throws -> [Float] {
        pending += samples
        var probabilities: [Float] = []
        while pending.count >= windowSamples {
            let level = LogEnergyEnvelope.level(Array(pending.prefix(windowSamples)))
            pending.removeFirst(windowSamples)
            windows.append(level)
            probabilities.append(level > -35 ? 0.95 : 0.05)
        }
        return probabilities
    }

    func reset() {
        pending.removeAll()
        resets += 1
    }
}

@Suite struct SpeechActivityPipelineTests {
    /// 3 s of -60 dBFS noise, 1 s of a -20 dBFS tone, 3 s of noise, at 16 kHz.
    static let signal: [Float] = {
        let tone = Signal.sine(frequency: 220, rate: 16_000, seconds: 1, amplitude: 0.14)
        return Signal.noise(seconds: 3, rmsDb: -60, seed: 1) + tone + Signal.noise(seconds: 3, rmsDb: -60, seed: 2)
    }()

    private func run(detector: (any VoiceActivityDetector)?, chunk: Int = 1_600) throws -> (SpeechActivityPipeline, [SpeechRegion], Int) {
        let pipeline = SpeechActivityPipeline(detector: detector)
        var regions: [SpeechRegion] = []
        var envelopeFrames = 0
        var offset = 0
        while offset < Self.signal.count {
            let end = min(Self.signal.count, offset + chunk)
            let output = try pipeline.push(Array(Self.signal[offset..<end]))
            envelopeFrames += output.envelope.count
            regions += output.events.closedRegions
            offset = end
        }
        regions += try pipeline.finish().closedRegions
        return (pipeline, regions, envelopeFrames)
    }

    @Test func gatedVadFindsTheBurstAndSkipsTheNoise() throws {
        let detector = EnergyFakeDetector()
        let (pipeline, regions, envelopeFrames) = try run(detector: detector)
        #expect(envelopeFrames == 700)
        let region = try #require(regions.first)
        #expect(regions.count == 1)
        #expect(abs(region.speechStartSample - 48_000) <= 512)
        #expect(abs(region.speechEndSample - 64_000) <= 512)
        #expect(region.startSample == region.speechStartSample - 24_000)
        let level = try #require(region.level)
        #expect(abs(level.mean - -20) < 1.5)
        #expect(level.peak >= level.mean)
        // The VAD only ran in the 1 s startup window (32 windows) and around the burst (lookback
        // and hangover included, about 2 s): 93 of 218 windows.
        let statistics = pipeline.statistics
        #expect(statistics.evaluatedWindows == detector.windows.count)
        #expect(statistics.evaluatedWindows <= 32 + 64)
        #expect(statistics.evaluatedWindows > 31)
        #expect(statistics.windows == 218)
    }

    @Test func gateOnlyModeStillProducesRegions() throws {
        let (_, regions, _) = try run(detector: nil)
        #expect(regions.count == 1)
        #expect(abs((regions.first?.speechStartSample ?? 0) - 48_000) <= 512)
    }

    @Test func pushSizesDoNotChangeTheRegions() throws {
        let small = try run(detector: EnergyFakeDetector(), chunk: 160).1
        let large = try run(detector: EnergyFakeDetector(), chunk: 48_000).1
        #expect(small == large)
    }

    @Test func newSegmenterSettingsSplitAtTheLastDecidedWindow() throws {
        let pipeline = SpeechActivityPipeline(detector: EnergyFakeDetector())
        // Noise, then 0.875 s into the burst: a region is open (regions lag about 0.5 s).
        var events = try pipeline.push(Array(Self.signal[..<62_000])).events
        #expect(events.contains { if case .opened = $0 { true } else { false } })
        var segmenter = SegmenterParameters()
        segmenter.minSilenceMs = 300
        let split = try pipeline.reconfigure(segmenter: segmenter)
        let closed = try #require(split.closedRegions.first)
        #expect(closed.closeReason == .trackClosed)
        #expect(closed.endSample <= pipeline.nextSampleIndex)
        #expect(pipeline.parameters.segmenter.minSilenceMs == 300)
        #expect(pipeline.segmenter.parameters.minSilenceMs == 300)
        // The rest of the burst opens a new region under the new settings; nothing is lost.
        events = try pipeline.push(Array(Self.signal[62_000...])).events + pipeline.finish()
        let next = try #require(events.closedRegions.first)
        #expect(next.startSample >= closed.endSample)
        #expect(abs(next.speechEndSample - 64_000) <= 512)
        // The same settings change nothing.
        #expect(try pipeline.reconfigure(segmenter: segmenter).isEmpty)
    }

    @Test func runStartingMidSpeechIsStillEvaluated() throws {
        // A loud tone with shallow dips from the first sample: the floor starts at the tone's level,
        // so the gate alone never opens; the startup window lets the VAD see the onset.
        var start: [Float] = []
        for _ in 0..<10 {
            start += Signal.sine(frequency: 220, rate: 16_000, seconds: 0.2, amplitude: 0.14)
            start += Signal.sine(frequency: 220, rate: 16_000, seconds: 0.1, amplitude: 0.06)
        }
        let signal = start + Signal.noise(seconds: 3, rmsDb: -60, seed: 5)
        func regions(startupMs: Int) throws -> [SpeechRegion] {
            var parameters = SpeechActivityParameters()
            parameters.vadStartupMs = startupMs
            let pipeline = SpeechActivityPipeline(parameters: parameters, detector: EnergyFakeDetector())
            return try pipeline.push(signal).events.closedRegions + pipeline.finish().closedRegions
        }
        #expect(try regions(startupMs: 0).isEmpty)
        let region = try #require(try regions(startupMs: 1_000).first)
        #expect(region.startSample == 0)
        #expect(region.speechStartSample == 0)
    }

    @Test func speechAfterDigitalSilenceIsStillEvaluated() throws {
        // A fresh track (an app tap) delivers 5 s of zeros, then the same loud tone with shallow
        // dips: its first frame becomes the floor, so the startup window must start there.
        var speech: [Float] = []
        for _ in 0..<10 {
            speech += Signal.sine(frequency: 220, rate: 16_000, seconds: 0.2, amplitude: 0.14)
            speech += Signal.sine(frequency: 220, rate: 16_000, seconds: 0.1, amplitude: 0.06)
        }
        let signal = [Float](repeating: 0, count: 80_000) + speech + Signal.noise(seconds: 3, rmsDb: -60, seed: 5)
        let pipeline = SpeechActivityPipeline(detector: EnergyFakeDetector())
        let regions = try pipeline.push(signal).events.closedRegions + pipeline.finish().closedRegions
        let region = try #require(regions.first)
        #expect(abs(region.speechStartSample - 80_000) <= 512)
    }

    @Test func steadyNoiseAfterDigitalSilenceNeverOpensTheGate() throws {
        let signal = [Float](repeating: 0, count: 80_000) + Signal.noise(seconds: 10, rmsDb: -45, seed: 8)
        for detector in [EnergyFakeDetector(), nil] {
            let pipeline = SpeechActivityPipeline(detector: detector)
            let regions = try pipeline.push(signal).events.closedRegions + pipeline.finish().closedRegions
            #expect(regions.isEmpty)
            #expect(pipeline.gate.statistics.opens == 0)
            // Only the startup second after the silence reaches the VAD.
            #expect(pipeline.statistics.evaluatedWindows <= 33)
        }
    }

    @Test func regionsSplitAfterALongStretchKeepTheirLevels() throws {
        // 65 s of a -20 dBFS tone: the 60 s limit splits it after more than 4096 level frames.
        let signal = Signal.noise(seconds: 2, rmsDb: -60, seed: 6)
            + Signal.sine(frequency: 220, rate: 16_000, seconds: 65, amplitude: 0.14)
            + Signal.noise(seconds: 3, rmsDb: -60, seed: 7)
        let pipeline = SpeechActivityPipeline(detector: EnergyFakeDetector())
        var regions: [SpeechRegion] = []
        var offset = 0
        while offset < signal.count {
            let end = min(signal.count, offset + 4_096)
            regions += try pipeline.push(Array(signal[offset..<end])).events.closedRegions
            offset = end
        }
        regions += try pipeline.finish().closedRegions
        #expect(regions.count == 2)
        #expect(regions.first?.closeReason == .maxDuration)
        for region in regions {
            let level = try #require(region.level)
            #expect(abs(level.mean - -20) < 1, "region \(region.speechStartSample)..<\(region.speechEndSample) level \(level)")
        }
    }

    @Test func gapClosesTheRegionAndShiftsLaterIndices() throws {
        let detector = EnergyFakeDetector()
        let pipeline = SpeechActivityPipeline(detector: detector)
        let tone = Signal.sine(frequency: 220, rate: 16_000, seconds: 1, amplitude: 0.14)
        var regions = try pipeline.push(Signal.noise(seconds: 2, rmsDb: -60) + tone).events.closedRegions
        regions += try pipeline.gap(lostSamples: 16_000).closedRegions
        #expect(pipeline.nextSampleIndex == 64_000)
        regions += try pipeline.push(tone + Signal.noise(seconds: 3, rmsDb: -60)).events.closedRegions
        regions += try pipeline.finish().closedRegions
        #expect(regions.count == 2)
        #expect(regions.first?.closeReason == .trackClosed)
        #expect((regions.first?.endSample ?? .max) <= 48_000)
        #expect((regions.last?.speechStartSample ?? 0) >= 64_000)
        #expect(detector.resets >= 1)
    }
}

extension [SegmenterEvent] {
    var closedRegions: [SpeechRegion] {
        compactMap { event in
            if case .closed(let region) = event { region } else { nil }
        }
    }
}
