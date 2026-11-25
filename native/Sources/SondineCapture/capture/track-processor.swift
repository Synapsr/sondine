import Accelerate
import Foundation
import SondineKit

public enum TrackKind: String, Sendable, Equatable {
    case microphone, system, app
}

/// Services a track processor uses; the engine owns them.
struct TrackServices {
    var clock: any HostClock
    var spoolRoot: URL
    var sessionId: UUID
    var helperVersion: String
    var parameters: SpeechActivityParameters
    var spoolConfiguration: SpoolConfiguration
    var detector: (any VoiceActivityDetector)?
    var makeFileSystem: () -> any SpoolFileSystem
    var allocateEpoch: () -> UInt32
    var emit: (HelperEvent) -> Void
    /// A run opened or closed (the engine republishes attribution).
    var runChanged: () -> Void = {}
    /// The apps in front over a stretch of continuous time (ADR 022).
    var foreground: (_ fromNs: UInt64, _ toNs: UInt64) -> [ForegroundTimeline.Span] = { _, _ in [] }
}

/// What one drain of a track found, for the engine to act on.
struct DrainOutcome {
    var blocks = 0
    var action: CaptureWatchdog.Action = .none
    /// The first non-zero sample of this processor arrived (permission verification).
    var firstSignal = false
    /// A block of this drain held a non-zero sample.
    var signal = false
    /// Host time of the first block of this drain.
    var firstHostTicks: UInt64?
}

/// Everything after the IO callback for one track (the drain worker, utility QoS):
/// measured rate → resampler (16 kHz mono) → spool (PCM16, 2 s commits) → envelopes → energy
/// gate → VAD → segmenter → protocol events. A run opens on the first drained block, so
/// `track.open.start` is the clock of the first captured sample.
///
/// Confined to the engine queue.
final class TrackProcessor: @unchecked Sendable {
    let trackKey: String
    let kind: TrackKind
    let context: IOCaptureContext
    private(set) var source: TrackSource
    /// The rate the device or aggregate reports now.
    private(set) var nominalRate: Double
    /// The nominal rate of the blocks being drained: blocks queued before a rate change keep
    /// their rate (`RingBlock.generation`).
    private(set) var streamRate: Double
    private var streamGeneration: UInt32
    /// Rates announced to the IO context and not drained yet, oldest first.
    private var pendingRates: [(generation: UInt32, rate: Double)] = []
    private var services: TrackServices

    private(set) var runId: UUID?
    private(set) var epoch: UInt32 = 0
    private var spool: SpoolWriter?
    private var fileSystem: TimedSpoolFileSystem?
    private var pipeline: SpeechActivityPipeline?
    private var resampler: StreamResampler?
    private var estimator: MeasuredRateEstimator
    private var effectiveRate: Double?
    /// The run's `track.open` as emitted; `openEvent` describes the run as it is now.
    private var openedEvent: TrackOpenEvent?
    private(set) var openRegion: RegionOpenEvent?
    private(set) var stream = StreamState.starting
    private var timeline: [(index: Int64, hostTicks: UInt64)] = []
    private var lastBlockEndHostTicks: UInt64?
    private var lastBlockSeconds = 0.0
    private var spoolRetryAtNs: UInt64?
    /// A run could not open its spool; reported once until one opens.
    private var spoolOpenFailed = false
    private var epochChange: TrackUpdateEvent?

    var watchdog: CaptureWatchdog
    /// When each process in this track's scope started its running output (zero-stall watchdog).
    private var outputStarts: [HALObjectID: Double] = [:]
    var outputActiveInScope: Bool { !outputStarts.isEmpty }
    /// Paused through process input mute: blocks are drained and dropped.
    var discardInput = false
    private(set) var sawSignal = false
    private(set) var lastBlockNs: UInt64?
    private(set) var startedNs: UInt64
    var overloads: UInt64 = 0
    /// What holds dropped (ADR 029): device frames left in the ring after a cut, and uncommitted
    /// 16 kHz samples silenced after it.
    private(set) var droppedAtHold = (ringFrames: 0, pendingSamples: Int64(0))

    // Health window
    private var windowPower = 0.0
    private var windowSamples = 0
    private var zeroRun: Int64 = 0
    private var windowZeroRun: Int64 = 0
    private var windowRingHighWater = 0
    private var reportedRing: RingBufferStatistics
    private var reportedOverloads: UInt64 = 0
    private var drainCost = StageHistogramAccumulator()
    private var resampleCost = StageHistogramAccumulator()
    private var envelopeCost = StageHistogramAccumulator()
    private var gateCost = StageHistogramAccumulator()
    private var vadCost = StageHistogramAccumulator()

    init(trackKey: String, kind: TrackKind, source: TrackSource, nominalRate: Double, context: IOCaptureContext, services: TrackServices) {
        self.trackKey = trackKey
        self.kind = kind
        self.source = source
        self.nominalRate = nominalRate
        streamRate = nominalRate
        streamGeneration = context.generation
        self.context = context
        self.services = services
        estimator = MeasuredRateEstimator(nominalRate: nominalRate, timebase: services.clock.timebase)
        watchdog = CaptureWatchdog(settings: kind == .microphone ? .microphone : CaptureWatchdog.Settings())
        reportedRing = context.ring.statistics
        startedNs = services.clock.anchor().continuousNs
    }

    var isOpen: Bool { runId != nil }

    /// The run's `track.open` with the current rate, stream state and source (snapshots). It
    /// keeps the run's first epoch: the start and anchor it carries belong to that epoch.
    var openEvent: TrackOpenEvent? {
        guard var event = openedEvent else { return nil }
        event.nominalRate = streamRate
        event.measuredRate = measuredRate
        event.stream = stream
        event.source = source
        return event
    }

    /// The `track.update` that started the current epoch, with the current state (snapshots),
    /// when the epoch changed since the run opened.
    var epochChangeEvent: TrackUpdateEvent? {
        guard var event = epochChange else { return nil }
        event.nominalRate = streamRate
        event.measuredRate = measuredRate
        event.stream = stream
        event.source = source
        return event
    }

    /// The error that started the current spool outage (snapshots repeat it); nil while the
    /// spool writes.
    private(set) var spoolError: HelperEvent?

    var hasOpenRegion: Bool { openRegion != nil }
    var detectionParameters: SpeechActivityParameters? { pipeline?.parameters }
    var resamplerRebuilds: Int { resampler?.rebuildCount ?? 0 }
    var nextSampleIndex: Int64 { spool?.nextSampleIndex ?? 0 }
    var measuredRate: Double? { estimator.estimate.flatMap { $0.isSettled ? ($0.measuredRate * 10).rounded() / 10 : nil } }

    // MARK: Drain

    /// Processes every block the IO delivered. With `cutNs` (a hold starts), only what was
    /// captured before it: the rest of the ring is dropped, a block across it cut, and a block
    /// without a time dropped whole.
    func drain(cutNs: UInt64? = nil) -> DrainOutcome {
        var outcome = DrainOutcome()
        let start = services.clock.anchor()
        windowRingHighWater = max(windowRingHighWater, context.ring.availableFrames)
        context.ring.read { view in
            outcome.blocks += 1
            var block = view.block
            if let cutNs {
                adoptGeneration(block.generation)
                let kept = framesBefore(cutNs, block: block)
                droppedAtHold.ringFrames += block.frameCount - kept
                guard kept > 0 else { return }
                block.frameCount = kept
            }
            let frames = block.frameCount
            if view.head.count >= frames {
                process(block, UnsafeBufferPointer(rebasing: view.head.prefix(frames)), now: start.continuousNs, outcome: &outcome)
                return
            }
            // A block that wraps around the ring is copied once to be contiguous.
            var copy = [Float](repeating: 0, count: view.block.frameCount)
            copy.withUnsafeMutableBufferPointer { view.copy(into: $0.baseAddress!) }
            copy.withUnsafeBufferPointer { process(block, UnsafeBufferPointer(rebasing: $0.prefix(frames)), now: start.continuousNs, outcome: &outcome) }
        }
        if outcome.blocks > 0 {
            drainCost.record(services.clock.timebase.nanoseconds(fromTicks: services.clock.anchor().hostTicks &- start.hostTicks))
        }
        return outcome
    }

    private func process(_ block: RingBlock, _ samples: UnsafeBufferPointer<Float>, now: UInt64, outcome: inout DrainOutcome) {
        adoptGeneration(block.generation)
        lastBlockNs = now
        guard !discardInput else { return }
        if stream != .running && stream != .zeroSuspect && isOpen { setStream(.running, at: block.hostTicks) }
        var peak: Float = 0
        if let base = samples.baseAddress { vDSP_maxmgv(base, 1, &peak, vDSP_Length(samples.count)) }
        let allZero = peak == 0
        if outcome.firstHostTicks == nil, block.hostTicks != 0 { outcome.firstHostTicks = block.hostTicks }
        if !allZero { outcome.signal = true }
        if !allZero && !sawSignal {
            sawSignal = true
            outcome.firstSignal = true
        }

        if !isOpen {
            if let retry = spoolRetryAtNs, now < retry { return }
            guard openRun(firstHostTicks: block.hostTicks) else { return }
        }

        // Time the IO did not deliver: a restart (discontinuity), or callbacks that never came.
        if let missing = missingSeconds(before: block),
           block.flags.contains(.discontinuity) || missing > max(Self.minimumGapSeconds, 1.5 * lastBlockSeconds) {
            recordStall(seconds: missing)
        }
        if block.hostTicks != 0 {
            estimator.observe(hostTicks: block.hostTicks, frameCount: block.frameCount, droppedFramesBefore: block.droppedFramesBefore)
        }

        let rate = ResampleRatePolicy.inputRate(nominal: streamRate, estimate: estimator.estimate)
        if let previous = effectiveRate, previous != rate { switchRate(to: rate, at: block.hostTicks) }
        effectiveRate = rate

        var chunks: [ResampledChunk] = []
        let started = services.clock.anchor().hostTicks
        do {
            chunks = try resampler?.process(
                interleaved: samples, channelCount: 1, inputRate: rate, hostTicks: block.hostTicks, droppedFramesBefore: block.droppedFramesBefore
            ) ?? []
        } catch {
            services.emit(.warning("resampler.failed", "Resampling failed: \(error).", trackKey: trackKey))
        }
        resampleCost.record(services.clock.timebase.nanoseconds(fromTicks: services.clock.anchor().hostTicks &- started))
        let gapReason: GapReason = block.flags.contains(.gapBefore) ? .ringOverflow : .stall
        for chunk in chunks { consume(chunk, gapReason: gapReason) }
        lastBlockSeconds = Double(block.frameCount) / rate
        if block.hostTicks != 0 {
            lastBlockEndHostTicks = block.hostTicks &+ UInt64(max(0, services.clock.timebase.ticks(fromSeconds: lastBlockSeconds)))
        }

        let mismatch = estimator.estimate.map { $0.isSettled && $0.exceedsRebuildThreshold } ?? false
        let action = watchdog.observe(
            allZero: allZero,
            seconds: Double(block.frameCount) / rate,
            outputActiveInScope: outputActiveInScope,
            rateMismatch: mismatch,
            at: Double(now) / 1e9
        )
        switch action {
        case .none: break
        case .reportSuspect: setStream(.zeroSuspect, at: block.hostTicks)
        case .clearSuspect: setStream(.running, at: block.hostTicks)
        case .rebuild: break
        }
        if case .rebuild = action { outcome.action = action }
    }

    /// Frames of `block` captured before `cutNs`.
    private func framesBefore(_ cutNs: UInt64, block: RingBlock) -> Int {
        guard block.hostTicks != 0 else { return 0 }
        let startNs = services.clock.continuousNanoseconds(forHostTicks: block.hostTicks)
        guard cutNs > startNs else { return 0 }
        let frames = (Double(cutNs - startNs) / 1e9 * streamRate).rounded(.down)
        return frames >= Double(block.frameCount) ? block.frameCount : Int(frames)
    }

    /// Shorter unexplained spacing between blocks is timestamp jitter or a measured-rate error
    /// still settling, not lost audio.
    static let minimumGapSeconds = 0.1

    /// Host time between the end of the previous block and the start of this one that neither
    /// audio nor counted ring drops account for.
    private func missingSeconds(before block: RingBlock) -> Double? {
        guard block.hostTicks != 0, let lastEnd = lastBlockEndHostTicks, block.hostTicks > lastEnd else { return nil }
        let rate = effectiveRate ?? streamRate
        let missing = services.clock.timebase.seconds(fromTicks: Int64(block.hostTicks - lastEnd)) - Double(block.droppedFramesBefore) / rate
        return missing > 0 ? missing : nil
    }

    /// IO stopped inside the run: the missing time becomes a gap, and spool and pipeline move on
    /// to where this block belongs.
    private func recordStall(seconds: Double) {
        guard let spool else { return }
        let lost = Int64((seconds * Double(SpoolFormat.sampleRate)).rounded())
        guard lost > 0, let resampler else { return }
        if let tail = try? resampler.flush() { consume(tail, gapReason: .stall) }
        let resume = spool.nextSampleIndex + lost
        resampler.reset(nextOutputIndex: resume)
        estimator.reset()
        applyGap(lost: lost, reason: .stall)
    }

    private func switchRate(to rate: Double, at hostTicks: UInt64) {
        guard let resampler, let spool else { return }
        // The old converter's tail belongs to the old epoch.
        if let tail = try? resampler.flush() { consume(tail, gapReason: .stall) }
        epoch = services.allocateEpoch()
        handle(spool.beginEpoch(epoch))
        let at = clockPoint(sample: spool.nextSampleIndex) ?? clockPoint(hostTicks: hostTicks)
        let update = TrackUpdateEvent(
            trackKey: trackKey, runId: runIdText, epoch: epoch, reason: .rateChange, sampleIndex: spool.nextSampleIndex,
            at: at, nominalRate: streamRate, measuredRate: measuredRate, stream: stream, source: source
        )
        epochChange = update
        services.emit(.trackUpdate(update))
    }

    /// The first block of a newer generation: the older blocks are drained, so the stream now
    /// runs at the rate announced for it.
    private func adoptGeneration(_ generation: UInt32) {
        guard generation != streamGeneration else { return }
        streamGeneration = generation
        guard let index = pendingRates.firstIndex(where: { $0.generation == generation }) else { return }
        let rate = pendingRates[index].rate
        pendingRates.removeFirst(index + 1)
        guard rate != streamRate else { return }
        streamRate = rate
        estimator.reset(nominalRate: rate)
    }

    private func consume(_ chunk: ResampledChunk, gapReason: GapReason) {
        guard let spool, let pipeline, !chunk.samples.isEmpty else { return }
        var samples = chunk.samples
        var first = chunk.firstSampleIndex
        if first > spool.nextSampleIndex {
            applyGap(lost: first - spool.nextSampleIndex, reason: gapReason)
        } else if first < spool.nextSampleIndex {
            let overlap = Int(min(Int64(samples.count), spool.nextSampleIndex - first))
            samples.removeFirst(overlap)
            first += Int64(overlap)
            guard !samples.isEmpty else { return }
        }
        timeline.append((first, chunk.firstSampleHostTicks))
        if timeline.count > 512 { timeline.removeFirst(timeline.count - 512) }
        accumulate(samples)

        let appended = spool.append(floats: samples, firstSampleHostTicks: chunk.firstSampleHostTicks)
        handle(appended.events)
        let before = pipeline.statistics
        do {
            let output = try pipeline.push(samples)
            spool.appendEnvelope(output.envelope)
            for event in output.events { handle(event) }
        } catch {
            services.emit(.error(.vadUnavailable, "VAD failed: \(error).", trackKey: trackKey))
        }
        let after = pipeline.statistics
        envelopeCost.record(after.envelopeCost.wallNs &- before.envelopeCost.wallNs)
        gateCost.record(after.gateCost.wallNs &- before.gateCost.wallNs)
        if after.vadCost.calls > before.vadCost.calls { vadCost.record(after.vadCost.wallNs &- before.vadCost.wallNs) }
    }

    private func applyGap(lost: Int64, reason: GapReason) {
        guard let spool, let pipeline, lost > 0 else { return }
        handle(spool.markGap(lostSamples: lost, reason: reason))
        if let events = try? pipeline.gap(lostSamples: lost) { for event in events { handle(event) } }
        zeroRun = 0
    }

    private func accumulate(_ samples: [Float]) {
        var meanSquare: Float = 0
        samples.withUnsafeBufferPointer { vDSP_measqv($0.baseAddress!, 1, &meanSquare, vDSP_Length($0.count)) }
        windowPower += Double(meanSquare) * Double(samples.count)
        windowSamples += samples.count
        for value in samples {
            if value == 0 {
                zeroRun += 1
                windowZeroRun = max(windowZeroRun, zeroRun)
            } else {
                zeroRun = 0
            }
        }
    }

    // MARK: Run lifecycle

    private var runIdText: String { (runId ?? UUID()).uuidString.lowercased() }

    private func openRun(firstHostTicks: UInt64) -> Bool {
        let runId = UUID()
        let epoch = services.allocateEpoch()
        let fileSystem = TimedSpoolFileSystem(base: services.makeFileSystem())
        let spool: SpoolWriter
        do {
            spool = try SpoolWriter(
                root: services.spoolRoot,
                identity: SpoolIdentity(sessionId: services.sessionId, trackKey: trackKey, runId: runId, helperVersion: services.helperVersion),
                epoch: epoch,
                configuration: services.spoolConfiguration,
                fileSystem: fileSystem,
                clock: services.clock
            )
        } catch {
            let full = (error as? SpoolIOError)?.isNoSpace ?? false
            if !spoolOpenFailed {
                let event = HelperEvent.error(full ? .diskFull : .spoolIO, "Cannot open the spool: \(error).", trackKey: trackKey)
                spoolError = event
                services.emit(event)
            }
            spoolOpenFailed = true
            spoolRetryAtNs = services.clock.anchor().continuousNs + 10_000_000_000
            return false
        }
        if spoolOpenFailed {
            spoolOpenFailed = false
            spoolError = nil
            services.emit(.warning("spool.resumed", "Spool writing resumed in a new run.", trackKey: trackKey))
        }
        epochChange = nil
        services.detector?.reset()
        self.runId = runId
        self.epoch = epoch
        self.spool = spool
        self.fileSystem = fileSystem
        pipeline = SpeechActivityPipeline(parameters: services.parameters, detector: services.detector)
        resampler = StreamResampler(firstOutputIndex: 0, timebase: services.clock.timebase)
        estimator.reset(nominalRate: streamRate)
        effectiveRate = nil
        timeline = [(0, firstHostTicks)]
        lastBlockEndHostTicks = nil
        lastBlockSeconds = 0
        spoolRetryAtNs = nil
        stream = .running
        let anchor = services.clock.anchor()
        let start = firstHostTicks == 0 ? ClockPoint(hostTicks: anchor.hostTicks, continuousNs: anchor.continuousNs) : clockPoint(hostTicks: firstHostTicks)
        let event = TrackOpenEvent(
            trackKey: trackKey, runId: runId.uuidString.lowercased(), epoch: epoch, start: start,
            anchor: WireClockAnchor(anchor), nominalRate: streamRate, measuredRate: nil, stream: .running, source: source
        )
        openedEvent = event
        services.emit(.trackOpen(event))
        services.runChanged()
        return true
    }

    /// Finishes the run: closes the open region, commits and closes the spool, then `track.close`.
    /// The caller stops IO first and drains what is left. With `silenceFromNs` (a hold), the
    /// samples from then on that are not committed yet are stored as silence: the run keeps its
    /// length and its regions, not that audio.
    func close(reason: TrackEndReason, replyTo: String? = nil, silenceFromNs: UInt64? = nil) {
        guard let runId, let spool, let pipeline else { return }
        if let resampler, let tail = try? resampler.flush() { consume(tail, gapReason: .stall) }
        if let events = try? pipeline.finish() { for event in events { handle(event) } }
        if let silenceFromNs {
            droppedAtHold.pendingSamples += spool.silencePending(from: sampleIndex(atNs: silenceFromNs))
        }
        handle(spool.close())
        let end = spool.nextSampleIndex
        let at = clockPoint(sample: end) ?? clockPoint(hostTicks: services.clock.anchor().hostTicks)
        services.emit(.trackClose(TrackCloseEvent(
            replyTo: replyTo, trackKey: trackKey, runId: runId.uuidString.lowercased(), epoch: epoch, endSample: end, at: at, reason: reason
        )))
        self.runId = nil
        self.spool = nil
        self.pipeline = nil
        self.resampler = nil
        openedEvent = nil
        epochChange = nil
        // A run that ends ends its outage; the next one reports its own.
        if !spoolOpenFailed { spoolError = nil }
        openRegion = nil
        zeroRun = 0
        services.runChanged()
    }

    /// The device or aggregate reported a new nominal rate. Blocks from now on belong to a new
    /// generation; once the drain reaches the first of them, the estimator restarts and the
    /// resampler is rebuilt (before any device or tap rebuild). Queued blocks keep the old rate.
    func noteNominalRate(_ rate: Double, now: UInt64, armWatchdog: Bool = true) {
        guard rate > 0, rate != nominalRate else { return }
        nominalRate = rate
        pendingRates.append((context.beginGeneration(), rate))
        if armWatchdog { watchdog.noteRateChange(at: Double(now) / 1e9) }
    }

    /// New capture-gate settings (a `config` with another VAD setup). The open run's pipeline
    /// closes its segmenter at the last decided window and continues with the new settings, so
    /// each region is decided under one set; the next run starts with them.
    func updateDetection(_ parameters: SpeechActivityParameters) {
        guard parameters != services.parameters else { return }
        services.parameters = parameters
        guard let pipeline else { return }
        do {
            for event in try pipeline.reconfigure(segmenter: parameters.segmenter) { handle(event) }
        } catch {
            services.emit(.error(.vadUnavailable, "VAD failed: \(error).", trackKey: trackKey))
        }
    }

    func noteRouteEvent(now: UInt64) {
        watchdog.noteEvent(at: Double(now) / 1e9)
    }

    /// The processes in scope with output running. The tap must hear the latest one to start;
    /// once none runs, a suspected stall clears.
    func updateOutputInScope(_ processes: Set<HALObjectID>, now: UInt64) {
        outputStarts = outputStarts.filter { processes.contains($0.key) }
        for id in processes where outputStarts[id] == nil { outputStarts[id] = Double(now) / 1e9 }
        watchdog.latestOutputStart = outputStarts.values.max()
        if outputStarts.isEmpty, watchdog.clearSuspect(), stream == .zeroSuspect {
            setStream(.running, at: services.clock.anchor().hostTicks)
        }
    }

    /// IO was restarted inside the run (a rebuild); the next block measures the stall gap. After
    /// a stall, the new tap must hear something before zeros stop counting.
    func noteIORestarted(afterStall: Bool) {
        context.markDiscontinuity()
        watchdog.reset(keepingSignal: !afterStall)
        setStream(.starting, at: services.clock.anchor().hostTicks)
    }

    func updateSource(_ newSource: TrackSource) {
        guard newSource != source else { return }
        source = newSource
        guard isOpen, let spool else { return }
        let anchor = services.clock.anchor()
        services.emit(.trackUpdate(TrackUpdateEvent(
            trackKey: trackKey, runId: runIdText, epoch: epoch, reason: .source, sampleIndex: spool.nextSampleIndex,
            at: ClockPoint(hostTicks: anchor.hostTicks, continuousNs: anchor.continuousNs),
            nominalRate: streamRate, measuredRate: measuredRate, stream: stream, source: source
        )))
    }

    /// Marks the stream stalled when no IO cycle arrived for 2 s, and says when the IO should be
    /// restarted (`CaptureWatchdog.observeNoIO`). Never while input is discarded: a muted
    /// microphone proves nothing.
    func checkStall(now: UInt64) -> CaptureWatchdog.Action {
        let last = lastBlockNs ?? startedNs
        let silent = now > last ? Double(now - last) / 1e9 : 0
        if isOpen, stream == .running || stream == .zeroSuspect, silent > 2 {
            setStream(.stalled, at: services.clock.anchor().hostTicks)
        }
        guard !discardInput else { return .none }
        return watchdog.observeNoIO(seconds: silent, at: Double(now) / 1e9)
    }

    /// Commits pending audio now (pause, shutdown).
    func commit() {
        guard let spool else { return }
        handle(spool.commit())
    }

    private func setStream(_ state: StreamState, at hostTicks: UInt64) {
        guard state != stream else { return }
        stream = state
        guard isOpen, let spool else { return }
        services.emit(.trackUpdate(TrackUpdateEvent(
            trackKey: trackKey, runId: runIdText, epoch: epoch, reason: .stream, sampleIndex: spool.nextSampleIndex,
            at: clockPoint(hostTicks: hostTicks), nominalRate: streamRate, measuredRate: measuredRate, stream: state, source: source
        )))
        if state == .zeroSuspect {
            services.emit(.warning("tap.zero-stall", "The track delivers only exact zeros while output is running.", trackKey: trackKey))
        }
    }

    // MARK: Events

    private func handle(_ events: [SpoolEvent]) {
        for event in events {
            switch event {
            case .fileOpened:
                break
            case .committed(let commit):
                services.emit(.commit(CommitEvent(
                    trackKey: trackKey, runId: runIdText, file: commit.file, seq: commit.commit.seq, epoch: commit.commit.epoch,
                    committedOffset: commit.commit.committedOffset, sampleIndex: commit.commit.sampleIndex,
                    sampleCount: commit.commit.sampleCount, crc32: commit.commit.crc32, at: commit.commit.at,
                    gaps: Self.bounded(commit.gaps.map(GapSpan.init))
                )))
            case .gapRecorded:
                break
            case .failed(let failure, _):
                switch failure {
                case .diskFull(let message):
                    spoolError = .error(.diskFull, "The spool volume is full; writing stopped (\(message)).", trackKey: trackKey)
                case .writeError(let message):
                    spoolError = .error(.spoolIO, "Spool write failed: \(message).", trackKey: trackKey)
                }
                if let spoolError { services.emit(spoolError) }
            case .resumed(let gap):
                spoolError = nil
                services.emit(.warning("spool.resumed", "Spool writing resumed after losing \(gap.sampleCount) samples.", trackKey: trackKey))
            }
        }
    }

    private func handle(_ event: SegmenterEvent) {
        switch event {
        case .opened(_, let speechStart):
            let region = RegionOpenEvent(
                regionId: UUID().uuidString.lowercased(), trackKey: trackKey, runId: runIdText, epoch: epoch,
                startSample: speechStart, at: clockPoint(sample: speechStart) ?? clockPoint(hostTicks: services.clock.anchor().hostTicks)
            )
            openRegion = region
            services.emit(.regionOpen(region))
        case .closed(let region):
            let regionId = openRegion.flatMap { UUID(uuidString: $0.regionId) } ?? UUID()
            openRegion = nil
            let record = ManifestRegion(region: region, regionId: regionId)
            spool?.appendRegion(record)
            services.emit(.regionClose(RegionCloseEvent(
                trackKey: trackKey, runId: runIdText, regionId: record.regionId, startSample: record.startSample,
                endSample: record.endSample, voicedSamples: record.voicedSamples, closeReason: record.closeReason, speechProbability: record.speechProbability,
                level: record.level, at: clockPoint(sample: record.endSample) ?? clockPoint(hostTicks: services.clock.anchor().hostTicks),
                foreground: foregroundSpans(startSample: record.startSample, endSample: record.endSample)
            )))
        }
    }

    /// The protocol allows 64 spans per region.
    static let maxForegroundSpans = 64

    /// The apps in front over a region, in its samples: each change is placed by interpolating
    /// between the clocks of the region's two ends, neighbours of one app are joined, and past
    /// the protocol's bound the longest spans are kept.
    func foregroundSpans(startSample: Int64, endSample: Int64) -> [ForegroundSpan] {
        guard endSample > startSample,
              let start = clockPoint(sample: startSample)?.continuousNs.value,
              let end = clockPoint(sample: endSample)?.continuousNs.value,
              end > start else { return [] }
        let samples = Double(endSample - startSample)
        let seconds = Double(end - start)
        let sample = { (ns: UInt64) -> Int64 in
            min(endSample, startSample + Int64((Double(ns - start) / seconds * samples).rounded()))
        }
        var spans: [ForegroundSpan] = []
        for span in services.foreground(start, end) {
            let from = sample(span.fromNs)
            let to = sample(span.toNs)
            guard to > from else { continue }
            if let last = spans.last, last.bundleId == span.app.bundleId, last.endSample == from {
                spans[spans.count - 1].endSample = to
            } else {
                spans.append(ForegroundSpan(bundleId: span.app.bundleId, name: span.app.name, startSample: from, endSample: to))
            }
        }
        guard spans.count > Self.maxForegroundSpans else { return spans }
        return Array(spans.enumerated()
            .sorted { ($0.element.endSample - $0.element.startSample, $1.offset) > ($1.element.endSample - $1.element.startSample, $0.offset) }
            .prefix(Self.maxForegroundSpans))
            .sorted { $0.offset < $1.offset }
            .map(\.element)
    }

    /// The protocol allows 64 gaps per commit; extra ones merge into the last span.
    static func bounded(_ gaps: [GapSpan]) -> [GapSpan] {
        guard gaps.count > 64 else { return gaps }
        var result = Array(gaps.prefix(63))
        let rest = gaps.dropFirst(63)
        if let first = rest.first, let last = rest.last {
            result.append(GapSpan(reason: first.reason, fromSample: first.fromSample, toSample: last.toSample))
        }
        return result
    }

    // MARK: Clocks

    func clockPoint(hostTicks: UInt64) -> ClockPoint {
        ClockPoint(hostTicks: hostTicks, continuousNs: services.clock.continuousNanoseconds(forHostTicks: hostTicks))
    }

    /// The run sample captured at a continuous time, from the latest resampler anchor at or
    /// before it (0 before the run).
    func sampleIndex(atNs ns: UInt64) -> Int64 {
        let anchors = timeline.map { (index: $0.index, ns: services.clock.continuousNanoseconds(forHostTicks: $0.hostTicks)) }
        guard let anchor = anchors.last(where: { $0.ns <= ns }) else { return 0 }
        return anchor.index + Int64((Double(ns - anchor.ns) / 1e9 * Double(SpoolFormat.sampleRate)).rounded(.down))
    }

    /// Host time of a run sample, from the latest resampler anchor at or before it.
    func clockPoint(sample: Int64) -> ClockPoint? {
        guard let anchor = timeline.last(where: { $0.index <= sample }) ?? timeline.first else { return nil }
        let ticks = Int64(anchor.hostTicks) + services.clock.timebase.ticks(fromSeconds: Double(sample - anchor.index) / Double(SpoolFormat.sampleRate))
        return clockPoint(hostTicks: UInt64(max(0, ticks)))
    }

    // MARK: Health

    /// Health of the open run since the previous call, and its stage histograms.
    func takeHealth() -> (track: TrackHealth?, stages: [StageHistogram]) {
        defer {
            windowPower = 0
            windowSamples = 0
            windowZeroRun = zeroRun
            windowRingHighWater = 0
            drainCost = StageHistogramAccumulator()
            resampleCost = StageHistogramAccumulator()
            envelopeCost = StageHistogramAccumulator()
            gateCost = StageHistogramAccumulator()
            vadCost = StageHistogramAccumulator()
        }
        let ring = context.ring.statistics
        let overflowDelta = ring.overflowEpisodes &- reportedRing.overflowEpisodes
        let droppedDelta = ring.droppedFrames &- reportedRing.droppedFrames
        reportedRing = ring
        let overloadDelta = overloads &- reportedOverloads
        reportedOverloads = overloads

        var stages = [
            context.ioCost.take().wire(stage: .ioCallback, trackKey: trackKey),
            drainCost.wire(stage: .drain, trackKey: trackKey),
            resampleCost.wire(stage: .resample, trackKey: trackKey),
            envelopeCost.wire(stage: .envelope, trackKey: trackKey),
            gateCost.wire(stage: .energyGate, trackKey: trackKey),
            vadCost.wire(stage: .vad, trackKey: trackKey),
        ]
        if let fileSystem {
            let spool = fileSystem.takeHistograms()
            stages += [
                spool.write.wire(stage: .spoolWrite, trackKey: trackKey),
                spool.dataSync.wire(stage: .spoolFsync, trackKey: trackKey),
                spool.manifestSync.wire(stage: .manifestFsync, trackKey: trackKey),
            ]
        }
        guard let runId else { return (nil, stages) }
        let level: Double? = windowSamples > 0 && windowPower > 0
            ? max(Double(LogEnergyEnvelope.floorDb), min(0, 10 * log10(windowPower / Double(windowSamples))))
            : nil
        let rate = effectiveRate ?? streamRate
        let track = TrackHealth(
            trackKey: trackKey,
            runId: runId.uuidString.lowercased(),
            stream: stream,
            measuredRate: measuredRate,
            level: level.map { ($0 * 10).rounded() / 10 },
            zeroRunMs: windowZeroRun / 16,
            ringHighWaterMs: Int64((Double(windowRingHighWater) / rate * 1_000).rounded()),
            ringOverflows: overflowDelta,
            droppedSamples: UInt64((Double(droppedDelta) * Double(SpoolFormat.sampleRate) / rate).rounded()),
            overloads: overloadDelta
        )
        return (track, stages)
    }
}
