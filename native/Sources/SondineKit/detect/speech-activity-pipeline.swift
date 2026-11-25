import Foundation

/// Settings of the capture gate as a unit: energy gate, VAD scheduling, and segmentation.
public struct SpeechActivityParameters: Sendable, Equatable, Codable {
    public var gate = EnergyGateParameters()
    public var segmenter = SegmenterParameters()
    /// Audio before a gate opening that the VAD also evaluates, so onsets are not cut.
    public var vadLookbackMs: Int = 512
    /// Time without evaluated windows after which the VAD state is reset.
    public var vadResetAfterMs: Int = 1_000
    /// Start of a track's audio (from its first frame above digital silence) that the VAD
    /// evaluates whatever the gate says: the gate's floor starts from that frame, so audio that
    /// begins mid-speech, at the start of a run or after digital silence, may stay gated until the
    /// floor adapts.
    public var vadStartupMs: Int = 1_000

    public init() {}
}

public struct SpeechActivityStatistics: Sendable, Equatable, Codable {
    public var samples: Int64 = 0
    public var envelopeFrames = 0
    public var windows = 0
    /// Windows the VAD evaluated (gate open or within the lookback).
    public var evaluatedWindows = 0
    /// Evaluated windows at or above the onset threshold.
    public var speechWindows = 0
    public var vadResets = 0
    public var gaps = 0
    public var envelopeCost = StageCost()
    public var gateCost = StageCost()
    public var vadCost = StageCost()
    public var segmenterCost = StageCost()

    public var evaluatedRatio: Double { windows == 0 ? 0 : Double(evaluatedWindows) / Double(windows) }
}

public struct SpeechActivityOutput: Sendable, Equatable {
    public var envelope: [EnvelopeFrame] = []
    public var events: [SegmenterEvent] = []
}

/// Per-track capture gate: 10 ms envelopes → energy gate → VAD on gated 32 ms windows →
/// hysteresis segmenter. Used by the live drain worker and by `sondine-audio segment`.
///
/// A window is decided once the gate is known `vadLookbackMs` past its end, so regions lag the
/// audio by about half a second. Without a detector the gate alone decides (probability 1 for
/// windows that overlap an open frame), which measures the gate's own misses.
public final class SpeechActivityPipeline {
    public private(set) var parameters: SpeechActivityParameters
    public private(set) var statistics = SpeechActivityStatistics()
    public private(set) var gate: EnergyGate
    public private(set) var segmenter: SpeechSegmenter
    public let windowSamples: Int
    /// Index of the next sample `push` expects.
    public private(set) var nextSampleIndex: Int64

    private let detector: (any VoiceActivityDetector)?
    private var envelope: LogEnergyEnvelope
    private var samples: [Float] = []
    private var samplesStart = 0
    /// Sample index of `samples[samplesStart]`.
    private var bufferedFrom: Int64
    private var nextWindowStart: Int64
    /// Gate frames are known for indices below this.
    private var gateKnownUntil: Int64
    private var openFrames: [ClosedRange<Int64>] = []
    /// Recent envelope levels, kept while a region may still need them.
    private var levels: [EnvelopeFrame] = []
    private var lastEvaluatedEnd: Int64?
    private let lookbackFrames: Int64
    private let resetAfterSamples: Int64
    private let startupSamples: Int64
    /// First sample of the frame that set the gate's floor.
    private var startupStart: Int64?
    private var onset: Float

    public init(
        parameters: SpeechActivityParameters = SpeechActivityParameters(),
        detector: (any VoiceActivityDetector)?,
        startSample: Int64 = 0
    ) {
        self.parameters = parameters
        self.detector = detector
        windowSamples = detector?.windowSamples ?? 512
        gate = EnergyGate(parameters: parameters.gate)
        segmenter = SpeechSegmenter(parameters: parameters.segmenter, startSample: startSample)
        envelope = LogEnergyEnvelope(startSampleIndex: startSample)
        nextSampleIndex = startSample
        bufferedFrom = startSample
        nextWindowStart = startSample
        gateKnownUntil = envelope.frameIndex
        let frame = Int64(LogEnergyEnvelope.frameSamples)
        lookbackFrames = (Int64(max(parameters.vadLookbackMs, 0)) * 16 + frame - 1) / frame
        resetAfterSamples = Int64(max(parameters.vadResetAfterMs, 0)) * 16
        startupSamples = Int64(max(parameters.vadStartupMs, 0)) * 16
        onset = parameters.segmenter.onsetThreshold
    }

    public func push(_ input: UnsafeBufferPointer<Float>) throws -> SpeechActivityOutput {
        var output = SpeechActivityOutput()
        guard !input.isEmpty else { return output }
        statistics.samples += Int64(input.count)
        samples.append(contentsOf: input)
        nextSampleIndex += Int64(input.count)

        statistics.envelopeCost.measure { envelope.push(input, into: &output.envelope) }
        statistics.envelopeFrames += output.envelope.count
        levels += output.envelope
        statistics.gateCost.measure {
            for frame in output.envelope {
                let hadFloor = gate.floorDb != nil
                let decision = gate.process(frame)
                if decision.isOpen { markOpen(frame.index) }
                if !hadFloor, gate.floorDb != nil { startupStart = frame.index * Int64(LogEnergyEnvelope.frameSamples) }
            }
        }
        gateKnownUntil = envelope.frameIndex
        output.events = withLevels(try decideWindows(finishing: false))
        discardDecided()
        return output
    }

    public func push(_ input: [Float]) throws -> SpeechActivityOutput {
        try input.withUnsafeBufferPointer { try push($0) }
    }

    /// Ends the stream: decides the remaining whole windows and closes any open region.
    public func finish() throws -> [SegmenterEvent] {
        var events = try decideWindows(finishing: true)
        events += statistics.segmenterCost.measure { segmenter.finish(at: nextSampleIndex) }
        events = withLevels(events)
        discardDecided()
        return events
    }

    /// Marks lost samples (a spool gap or ring overflow): closes the open region at the gap and
    /// restarts envelopes, gate state and the VAD at the resume index.
    public func gap(lostSamples: Int64) throws -> [SegmenterEvent] {
        precondition(lostSamples >= 0, "lost samples cannot be negative")
        var events = try decideWindows(finishing: true)
        let resume = nextSampleIndex + lostSamples
        events += segmenter.finish(at: nextSampleIndex, resumeAt: resume)
        events = withLevels(events)
        levels.removeAll()
        statistics.gaps += 1
        nextSampleIndex = resume
        envelope.restart(at: resume)
        gate.interrupt()
        detector?.reset()
        lastEvaluatedEnd = nil
        samples.removeAll(keepingCapacity: true)
        samplesStart = 0
        bufferedFrom = resume
        nextWindowStart = resume
        gateKnownUntil = envelope.frameIndex
        openFrames.removeAll()
        return events
    }

    /// Switches to new segmenter settings mid-stream. The current segmenter decides what it can
    /// and closes at the last decided window (an open region ends there, `track-closed`); a new
    /// one starts at that window, so every region is decided under one set of settings. The
    /// envelope, the gate and the VAD state carry on.
    public func reconfigure(segmenter newParameters: SegmenterParameters) throws -> [SegmenterEvent] {
        guard newParameters != parameters.segmenter else { return [] }
        var events = try decideWindows(finishing: false)
        events += statistics.segmenterCost.measure { segmenter.finish(at: nextWindowStart) }
        events = withLevels(events)
        parameters.segmenter = newParameters
        onset = newParameters.onsetThreshold
        segmenter = SpeechSegmenter(parameters: newParameters, startSample: nextWindowStart)
        discardDecided()
        return events
    }

    // MARK: Private

    private func markOpen(_ frame: Int64) {
        if let last = openFrames.last, last.upperBound + 1 == frame {
            openFrames[openFrames.count - 1] = last.lowerBound...frame
        } else {
            openFrames.append(frame...frame)
        }
    }

    private func anyOpen(_ range: ClosedRange<Int64>) -> Bool {
        openFrames.contains { $0.overlaps(range) }
    }

    private func decideWindows(finishing: Bool) throws -> [SegmenterEvent] {
        var events: [SegmenterEvent] = []
        let frame = Int64(LogEnergyEnvelope.frameSamples)
        let window = Int64(windowSamples)
        while nextWindowStart + window <= nextSampleIndex {
            let start = nextWindowStart
            let end = start + window
            let firstFrame = start / frame
            let lastFrame = (end - 1) / frame
            let horizon = lastFrame + lookbackFrames
            if !finishing, horizon >= gateKnownUntil { break }

            var probability: Float = 0
            let inStartup = startupStart.map { end > $0 && start < $0 + startupSamples } ?? false
            if inStartup || anyOpen(firstFrame...horizon) {
                statistics.evaluatedWindows += 1
                if let detector {
                    if let last = lastEvaluatedEnd, start - last >= resetAfterSamples {
                        detector.reset()
                        statistics.vadResets += 1
                    }
                    let offset = samplesStart + Int(start - bufferedFrom)
                    let result = try statistics.vadCost.measure {
                        try samples.withUnsafeBufferPointer { buffer in
                            try detector.push(UnsafeBufferPointer(rebasing: buffer[offset..<offset + windowSamples]))
                        }
                    }
                    probability = result.last ?? 0
                    lastEvaluatedEnd = end
                } else {
                    probability = anyOpen(firstFrame...lastFrame) ? 1 : 0
                }
                if probability >= onset { statistics.speechWindows += 1 }
            }
            statistics.windows += 1
            events += statistics.segmenterCost.measure {
                segmenter.process(windowStart: start, sampleCount: windowSamples, probability: probability)
            }
            nextWindowStart = end
        }
        return events
    }

    /// Drops samples, gate frames and levels that decided windows and closed regions no longer
    /// need. Runs after `withLevels`, which reads the levels of regions closed in this step.
    private func discardDecided() {
        let consumed = Int(nextWindowStart - bufferedFrom)
        guard consumed > 0 else { return }
        samplesStart += consumed
        bufferedFrom = nextWindowStart
        if samplesStart >= 16_384 || samplesStart == samples.count {
            samples.removeFirst(samplesStart)
            samplesStart = 0
        }
        let firstNeeded = nextWindowStart / Int64(LogEnergyEnvelope.frameSamples)
        openFrames.removeAll { $0.upperBound < firstNeeded }
        let firstLevel = min(segmenter.earliestOpenSample ?? nextWindowStart, nextWindowStart) / Int64(LogEnergyEnvelope.frameSamples)
        if let keep = levels.firstIndex(where: { $0.index >= firstLevel }), keep > 4_096 {
            levels.removeFirst(keep)
        }
    }

    /// Fills the level of closed regions: power mean and peak of the 10 ms frames between the
    /// speech bounds.
    private func withLevels(_ events: [SegmenterEvent]) -> [SegmenterEvent] {
        events.map { event in
            guard case .closed(var region) = event else { return event }
            let frame = Int64(LogEnergyEnvelope.frameSamples)
            let first = region.speechStartSample / frame
            let end = (region.speechEndSample + frame - 1) / frame
            let values = levels.filter { $0.index >= first && $0.index < end }.map(\.db)
            region.level = Self.levelStats(values)
            return .closed(region)
        }
    }

    static func levelStats(_ values: [Float]) -> LevelStats {
        guard let peak = values.max() else {
            return LevelStats(mean: LogEnergyEnvelope.floorDb, peak: LogEnergyEnvelope.floorDb)
        }
        let power = values.reduce(Double(0)) { $0 + pow(10, Double($1) / 10) } / Double(values.count)
        let mean = Float(max(Double(LogEnergyEnvelope.floorDb), 10 * log10(power)))
        return LevelStats(mean: min(mean, peak), peak: peak)
    }
}
