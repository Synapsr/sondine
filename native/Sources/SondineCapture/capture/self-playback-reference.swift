import Foundation
import SondineKit

/// What a tap's IOProc feeds and its aggregate's listeners update: a track processor, or the
/// `self:playback` reference.
protocol TapStream: AnyObject, Sendable {
    var context: IOCaptureContext { get }
    var nominalRate: Double { get }
    var overloads: UInt64 { get set }
    func noteNominalRate(_ rate: Double, now: UInt64, armWatchdog: Bool)
}

extension TrackProcessor: TapStream {}

/// The private `self:playback` reference (ADR 035): what Sondine's own processes play, drained
/// from their tap, resampled to 16 kHz and reduced to 10 ms energy frames, sent to core as
/// `self.envelope` and dropped. No run, no spool, no VAD: nothing of it is kept here beyond the
/// frames not yet sent (under a second), and nothing of it can be heard again.
///
/// Confined to the engine queue.
final class SelfPlaybackReference: TapStream, @unchecked Sendable {
    /// Frames sent together: one event a second while Sondine plays.
    static let framesPerEvent = 100

    let context: IOCaptureContext
    private(set) var nominalRate: Double
    var overloads: UInt64 = 0
    private let clock: any HostClock
    private var generation: UInt32
    /// Rates announced to the IO context and not drained yet, oldest first.
    private var pendingRates: [(generation: UInt32, rate: Double)] = []
    private var streamRate: Double

    private var resampler: StreamResampler
    private var envelope = LogEnergyEnvelope()
    /// A run of frames started (the first chunk since a gap).
    private var running = false
    private var lastBlockEnd: UInt64?
    private var pending: [Int] = []
    private var pendingFirstFrame: Int64 = 0
    /// Host time of the first pending frame, from the chunk it ended in: each event is placed
    /// by the blocks' own timestamps, so a device clock that drifts from the host's never
    /// accumulates over a long playback.
    private var pendingStartHostTicks: UInt64 = 0
    /// What the drains cost (envelope included), for the health window and the bench.
    private(set) var cost = StageHistogramAccumulator()
    private(set) var framesSent: UInt64 = 0

    init(nominalRate: Double, context: IOCaptureContext, clock: any HostClock) {
        self.nominalRate = nominalRate
        streamRate = nominalRate
        self.context = context
        self.clock = clock
        generation = context.generation
        resampler = StreamResampler(firstOutputIndex: 0, timebase: clock.timebase)
    }

    func noteNominalRate(_ rate: Double, now: UInt64, armWatchdog: Bool) {
        guard rate > 0, rate != nominalRate else { return }
        nominalRate = rate
        pendingRates.append((context.beginGeneration(), rate))
    }

    /// Drains every block the tap delivered; returns the events to send. With `cutNs` (a hold
    /// starts), only what was played before it: later blocks are dropped, one across it cut.
    func drain(cutNs: UInt64? = nil) -> [HelperEvent] {
        let started = clock.anchor().hostTicks
        var events: [HelperEvent] = []
        var blocks = 0
        context.ring.read { view in
            blocks += 1
            var block = view.block
            if let cutNs {
                guard block.hostTicks != 0 else { return }
                let startNs = clock.continuousNanoseconds(forHostTicks: block.hostTicks)
                guard cutNs > startNs else { return }
                let kept = (Double(cutNs - startNs) / 1e9 * streamRate).rounded(.down)
                if kept < Double(block.frameCount) { block.frameCount = Int(kept) }
                guard block.frameCount > 0 else { return }
            }
            let frames = block.frameCount
            if view.head.count >= frames {
                process(block, UnsafeBufferPointer(rebasing: view.head.prefix(frames)), into: &events)
                return
            }
            var copy = [Float](repeating: 0, count: frames)
            copy.withUnsafeMutableBufferPointer { view.copy(into: $0.baseAddress!) }
            copy.withUnsafeBufferPointer { process(block, $0, into: &events) }
        }
        if pending.count >= Self.framesPerEvent, let event = flush() { events.append(event) }
        if blocks > 0 { cost.record(clock.timebase.nanoseconds(fromTicks: clock.anchor().hostTicks &- started)) }
        return events
    }

    /// The frames not sent yet, as one event (the tap stops, or a gap starts); with `cutNs`, only
    /// those played before it.
    func flush(cutNs: UInt64? = nil) -> HelperEvent? {
        guard !pending.isEmpty, running else {
            pending.removeAll()
            return nil
        }
        let hostTicks = pendingStartHostTicks
        let start = ClockPoint(hostTicks: hostTicks, continuousNs: clock.continuousNanoseconds(forHostTicks: hostTicks))
        if let cutNs {
            let startNs = start.continuousNs.value
            let kept = cutNs > startNs ? Int((cutNs - startNs) / 10_000_000) : 0
            if kept < pending.count { pending.removeLast(pending.count - kept) }
            guard !pending.isEmpty else { return nil }
        }
        let levels = pending
        pending.removeAll(keepingCapacity: true)
        pendingFirstFrame += Int64(levels.count)
        framesSent += UInt64(levels.count)
        return .selfEnvelope(SelfEnvelopeEvent(start: start, levels: levels))
    }

    /// A gap: what came before is sent, and the next block starts a new run of frames.
    private func restart(into events: inout [HelperEvent]) {
        if let event = flush() { events.append(event) }
        _ = try? resampler.flush()
        resampler.reset(nextOutputIndex: 0)
        envelope = LogEnergyEnvelope()
        running = false
        pendingFirstFrame = 0
    }

    private func process(_ block: RingBlock, _ samples: UnsafeBufferPointer<Float>, into events: inout [HelperEvent]) {
        if block.generation != generation {
            generation = block.generation
            if let index = pendingRates.firstIndex(where: { $0.generation == block.generation }) {
                streamRate = pendingRates[index].rate
                pendingRates.removeFirst(index + 1)
            }
            restart(into: &events)
        }
        // Without a time a block cannot be placed; time the tap did not deliver is a gap.
        guard block.hostTicks != 0 else {
            restart(into: &events)
            lastBlockEnd = nil
            return
        }
        let seconds = Double(block.frameCount) / streamRate
        if let end = lastBlockEnd {
            let missing = clock.timebase.seconds(fromTicks: Int64(bitPattern: block.hostTicks &- end))
            if block.droppedFramesBefore > 0 || block.flags.contains(.discontinuity) || abs(missing) > 0.1 {
                restart(into: &events)
            }
        }
        lastBlockEnd = block.hostTicks &+ UInt64(max(0, clock.timebase.ticks(fromSeconds: seconds)))
        let chunks = (try? resampler.process(interleaved: samples, channelCount: 1, inputRate: streamRate, hostTicks: block.hostTicks)) ?? []
        for chunk in chunks where !chunk.samples.isEmpty {
            if !running {
                running = true
                envelope.restart(at: chunk.firstSampleIndex)
                pendingFirstFrame = envelope.frameIndex + (chunk.firstSampleIndex % Int64(LogEnergyEnvelope.frameSamples) == 0 ? 0 : 1)
            }
            var frames: [EnvelopeFrame] = []
            chunk.samples.withUnsafeBufferPointer { envelope.push($0, into: &frames) }
            for frame in frames {
                // Frames follow one another within a run; one that does not starts a new one.
                if frame.index != pendingFirstFrame + Int64(pending.count) {
                    if let event = flush() { events.append(event) }
                    pendingFirstFrame = frame.index
                }
                if pending.isEmpty { pendingStartHostTicks = hostTicks(ofSample: frame.index * Int64(LogEnergyEnvelope.frameSamples), in: chunk) }
                pending.append(Int((max(LogEnergyEnvelope.floorDb, min(0, frame.db)) * 10).rounded()))
                if pending.count >= SelfEnvelopeEvent.maxFrames, let event = flush() { events.append(event) }
            }
        }
    }

    /// Host time of 16 kHz sample `index`, placed from the chunk that holds the frame's end.
    private func hostTicks(ofSample index: Int64, in chunk: ResampledChunk) -> UInt64 {
        let seconds = Double(index - chunk.firstSampleIndex) / StreamResampler.outputRate
        let ticks = clock.timebase.ticks(fromSeconds: abs(seconds))
        return seconds >= 0 ? chunk.firstSampleHostTicks &+ UInt64(ticks) : chunk.firstSampleHostTicks &- UInt64(ticks)
    }
}
