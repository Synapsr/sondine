/// Hysteresis segmentation of VAD probabilities into padded speech regions.
public struct SegmenterParameters: Sendable, Equatable, Codable {
    /// Probability that starts speech.
    public var onsetThreshold: Float = 0.5
    /// Probability below which a window counts as silence (Silero's onset − 0.15).
    public var offsetThreshold: Float = 0.35
    /// Shortest voiced span that opens a region; shorter bursts are rejected.
    public var minSpeechMs: Int = 250
    /// Silence that ends a speech run.
    public var minSilenceMs: Int = 600
    /// Longest region; longer speech is split at the lowest-probability window.
    public var maxSegmentMs: Int = 60_000
    /// How far back from the limit the split point is searched.
    public var splitSearchMs: Int = 5_000
    /// Audio kept before speech starts (architecture §3).
    public var preRollMs: Int = 1_500
    /// Audio kept after speech ends (architecture §3).
    public var postRollMs: Int = 800

    public init() {}
}

/// One speech region in 16 kHz samples of the track run. Ends are exclusive.
public struct SpeechRegion: Sendable, Equatable, Codable {
    /// Padded bounds (pre-roll and post-roll applied, clamped to the stream and earlier regions).
    public var startSample: Int64
    public var endSample: Int64
    /// Voiced bounds without padding.
    public var speechStartSample: Int64
    public var speechEndSample: Int64
    public var maxProbability: Float
    /// Mean VAD probability over the windows between the speech bounds.
    public var meanProbability: Float
    /// Samples in windows at or above the offset threshold.
    public var voicedSamples: Int64
    /// The region starts where a longer region was split (no pre-roll).
    public var splitBefore: Bool
    /// The region was cut at the maximum length (no post-roll).
    public var splitAfter: Bool
    public var closeReason: RegionCloseReason
    /// Level over the speech bounds; filled by `SpeechActivityPipeline`, nil from the segmenter alone.
    public var level: LevelStats?
}

public enum SegmenterEvent: Sendable, Equatable {
    case opened(startSample: Int64, speechStartSample: Int64)
    case closed(SpeechRegion)
}

public struct SegmenterStatistics: Sendable, Equatable, Codable {
    public var windows = 0
    public var regions = 0
    public var rejectedBursts = 0
    public var splits = 0
}

/// Streams VAD windows into regions. Silence shorter than pre-roll + post-roll merges two
/// speech runs into one region, so a region closes only once that horizon has passed.
public struct SpeechSegmenter: Sendable {
    public let parameters: SegmenterParameters
    public private(set) var statistics = SegmenterStatistics()

    private struct Window: Sendable {
        var start: Int64
        var end: Int64
        var probability: Float
    }

    private struct OpenRegion: Sendable {
        var startSample: Int64
        var speechStartSample: Int64
        var lastVoicedEnd: Int64
        var windows: [Window]
        var splitBefore: Bool
        var trailing: Bool
    }

    private struct Candidate: Sendable {
        var start: Int64
        var lastVoicedEnd: Int64
        var windows: [Window]
    }

    private var region: OpenRegion?
    private var candidate: Candidate?

    /// Earliest sample an open region or pending burst still refers to.
    public var earliestOpenSample: Int64? {
        [region?.speechStartSample, candidate?.start].compactMap { $0 }.min()
    }
    /// Earliest sample a new region may start at (stream start, gap, or the previous region's end).
    private var lowerBound: Int64
    private var lastWindowEnd: Int64

    private let minSpeech: Int64
    private let minSilence: Int64
    private let maxSegment: Int64
    private let splitSearch: Int64
    private let preRoll: Int64
    private let postRoll: Int64

    public init(parameters: SegmenterParameters = SegmenterParameters(), startSample: Int64 = 0) {
        precondition(parameters.offsetThreshold <= parameters.onsetThreshold, "offset must not exceed onset")
        self.parameters = parameters
        let perMs: Int64 = 16
        minSpeech = Int64(parameters.minSpeechMs) * perMs
        minSilence = Int64(max(parameters.minSilenceMs, 1)) * perMs
        maxSegment = Int64(max(parameters.maxSegmentMs, parameters.minSpeechMs + 1)) * perMs
        splitSearch = Int64(parameters.splitSearchMs) * perMs
        preRoll = Int64(parameters.preRollMs) * perMs
        postRoll = Int64(parameters.postRollMs) * perMs
        lowerBound = startSample
        lastWindowEnd = startSample
    }

    /// Feeds one window `[start, start + count)`. Windows must arrive in order; windows the VAD
    /// did not evaluate (gate closed) are fed with probability 0.
    public mutating func process(windowStart start: Int64, sampleCount: Int, probability: Float) -> [SegmenterEvent] {
        let window = Window(start: start, end: start + Int64(sampleCount), probability: probability)
        lastWindowEnd = window.end
        statistics.windows += 1
        var events: [SegmenterEvent] = []

        // A trailing region closes once no new speech can merge into it: the silence now exceeds
        // post-roll + pre-roll. A pending burst then becomes a candidate for a new region.
        if let open = region, open.trailing, window.end - open.lastVoicedEnd >= postRoll + preRoll {
            events.append(.closed(close(open, endLimit: open.lastVoicedEnd + postRoll, reason: .silence)))
            region = nil
        }

        if let open = region, !open.trailing {
            events.append(contentsOf: continueSpeech(open, with: window))
            return events
        }
        if var open = region {
            open.windows.append(window)
            region = open
        }

        if var pending = candidate {
            pending.windows.append(window)
            if probability >= parameters.offsetThreshold { pending.lastVoicedEnd = window.end }
            if window.end - pending.lastVoicedEnd >= minSilence {
                statistics.rejectedBursts += 1
                candidate = nil
            } else if pending.lastVoicedEnd - pending.start >= minSpeech {
                candidate = nil
                events.append(contentsOf: confirm(pending))
            } else {
                candidate = pending
            }
        } else if probability >= parameters.onsetThreshold {
            let pending = Candidate(start: window.start, lastVoicedEnd: window.end, windows: [window])
            if window.end - window.start >= minSpeech {
                events.append(contentsOf: confirm(pending))
            } else {
                candidate = pending
            }
        }
        return events
    }

    /// Ends the stream (or a gap) at `endSample`, closing what is open. A new segment of the
    /// stream may follow from `endSample` or later.
    public mutating func finish(at endSample: Int64? = nil, resumeAt resume: Int64? = nil) -> [SegmenterEvent] {
        let end = endSample ?? lastWindowEnd
        var events: [SegmenterEvent] = []
        if let pending = candidate {
            candidate = nil
            if pending.lastVoicedEnd - pending.start >= minSpeech {
                events.append(contentsOf: confirm(pending))
            } else {
                statistics.rejectedBursts += 1
            }
        }
        if let open = region {
            events.append(.closed(close(open, endLimit: min(open.lastVoicedEnd + postRoll, end), reason: .trackClosed)))
            region = nil
        }
        lowerBound = max(lowerBound, resume ?? end)
        lastWindowEnd = max(lastWindowEnd, resume ?? end)
        return events
    }

    // MARK: Private

    private mutating func confirm(_ pending: Candidate) -> [SegmenterEvent] {
        if var open = region {
            // New speech inside the merge horizon extends the trailing region, which already
            // holds the burst's windows.
            open.lastVoicedEnd = pending.lastVoicedEnd
            open.trailing = false
            region = open
            return []
        }
        let start = max(pending.start - preRoll, lowerBound)
        region = OpenRegion(
            startSample: start,
            speechStartSample: pending.start,
            lastVoicedEnd: pending.lastVoicedEnd,
            windows: pending.windows,
            splitBefore: false,
            trailing: false
        )
        return [.opened(startSample: start, speechStartSample: pending.start)]
    }

    private mutating func continueSpeech(_ current: OpenRegion, with window: Window) -> [SegmenterEvent] {
        var open = current
        open.windows.append(window)
        if window.probability >= parameters.offsetThreshold { open.lastVoicedEnd = window.end }
        if window.end - open.lastVoicedEnd >= minSilence {
            open.trailing = true
            region = open
            return []
        }
        guard window.end - open.speechStartSample >= maxSegment else {
            region = open
            return []
        }
        return split(open, at: window.end)
    }

    private mutating func split(_ open: OpenRegion, at limit: Int64) -> [SegmenterEvent] {
        let earliest = max(limit - splitSearch, open.speechStartSample + minSpeech)
        let searchable = open.windows.filter { $0.start >= earliest }
        let cut = searchable.min { $0.probability < $1.probability }?.start ?? limit
        statistics.splits += 1

        var first = open
        first.windows = open.windows.filter { $0.start < cut }
        first.lastVoicedEnd = min(open.lastVoicedEnd, cut)
        var closed = close(first, endLimit: cut, reason: .maxDuration)
        closed.speechEndSample = cut
        closed.splitAfter = true

        let rest = open.windows.filter { $0.start >= cut }
        let voicedEnd = rest.last { $0.probability >= parameters.offsetThreshold }?.end ?? cut
        region = OpenRegion(
            startSample: cut,
            speechStartSample: cut,
            lastVoicedEnd: max(voicedEnd, cut),
            windows: rest,
            splitBefore: true,
            trailing: false
        )
        return [.closed(closed), .opened(startSample: cut, speechStartSample: cut)]
    }

    private mutating func close(_ open: OpenRegion, endLimit: Int64, reason: RegionCloseReason) -> SpeechRegion {
        let speechEnd = max(open.lastVoicedEnd, open.speechStartSample)
        let speechWindows = open.windows.filter { $0.start >= open.speechStartSample && $0.end <= speechEnd }
        let probabilities = speechWindows.map(\.probability)
        let voiced = speechWindows.filter { $0.probability >= parameters.offsetThreshold }
            .reduce(Int64(0)) { $0 + ($1.end - $1.start) }
        let end = max(endLimit, speechEnd)
        lowerBound = max(lowerBound, end)
        statistics.regions += 1
        return SpeechRegion(
            startSample: open.startSample,
            endSample: end,
            speechStartSample: open.speechStartSample,
            speechEndSample: speechEnd,
            maxProbability: probabilities.max() ?? 0,
            meanProbability: probabilities.isEmpty ? 0 : probabilities.reduce(0, +) / Float(probabilities.count),
            voicedSamples: voiced,
            splitBefore: open.splitBefore,
            splitAfter: false,
            closeReason: reason,
            level: nil
        )
    }
}
