import CoreAudio
import Darwin
import SondineKit
import Synchronization

/// The state an IOProc writes on the HAL's real-time thread: a mono SPSC ring, a cost histogram,
/// and a few counters. `ingest` only validates the buffer list, downmixes it into the ring, and
/// records its own duration. It never locks, allocates, or calls into Objective-C or the HAL;
/// `IOCaptureContextTests` checks this with libmalloc's logger hook.
public final class IOCaptureContext: @unchecked Sendable {
    public let ring: FrameRingBuffer
    public let ioCost = AtomicStageHistogram()
    public let timebase: HostTimebase

    private let discontinuity = Atomic<Bool>(true)
    private let formatGeneration = Atomic<UInt32>(0)
    private let callbackCount = Atomic<UInt64>(0)
    private let rejectedCount = Atomic<UInt64>(0)

    /// - Parameter ringSeconds: how much audio the ring holds at `rate` (the drain runs every
    ///   256 ms; the margin covers a stalled disk or a slow HAL call on the drain queue).
    public init(rate: Double, ringSeconds: Double = 10, timebase: HostTimebase = .current) {
        let frames = max(4_096, Int(rate * ringSeconds))
        ring = FrameRingBuffer(channelCount: 1, minimumFrames: frames, minimumBlocks: 2_048)
        self.timebase = timebase
    }

    public var callbacks: UInt64 { callbackCount.load(ordering: .relaxed) }
    /// Buffer lists that failed validation (route changes can briefly deliver odd shapes).
    public var rejectedBuffers: UInt64 { rejectedCount.load(ordering: .relaxed) }

    /// The next stored block is flagged `.discontinuity` (IO started or restarted).
    public func markDiscontinuity() {
        discontinuity.store(true, ordering: .relaxed)
    }

    /// Blocks written from now on belong to a new format generation (the drain worker learned
    /// of a rate change). Blocks already queued keep the old one.
    public func beginGeneration() -> UInt32 {
        formatGeneration.wrappingAdd(1, ordering: .relaxed).newValue
    }

    public var generation: UInt32 { formatGeneration.load(ordering: .relaxed) }

    /// The IOProc body.
    public func ingest(_ input: UnsafePointer<AudioBufferList>, _ inputTime: UnsafePointer<AudioTimeStamp>) {
        let started = mach_absolute_time()
        callbackCount.add(1, ordering: .relaxed)
        let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
        var frames = -1
        var channels = 0
        var index = 0
        while index < list.count {
            let buffer = list[index]
            index += 1
            // Streams marked unused (kAudioDevicePropertyIOProcStreamUsage) arrive with no data.
            guard buffer.mData != nil, buffer.mNumberChannels > 0 else { continue }
            let bytesPerFrame = MemoryLayout<Float>.size * Int(buffer.mNumberChannels)
            let size = Int(buffer.mDataByteSize)
            guard size > 0, size % bytesPerFrame == 0, frames < 0 || frames == size / bytesPerFrame else {
                rejectedCount.add(1, ordering: .relaxed)
                return
            }
            frames = size / bytesPerFrame
            channels += Int(buffer.mNumberChannels)
        }
        guard frames > 0, channels > 0 else { return }

        let time = inputTime.pointee
        // A raw bit test: `OptionSet.contains` on the imported flags allocates in unspecialized code.
        let hostTicks = time.mFlags.rawValue & AudioTimeStampFlags.hostTimeValid.rawValue != 0 ? time.mHostTime : 0
        var flags: RingBlockFlags = []
        if discontinuity.exchange(false, ordering: .relaxed) { flags.insert(.discontinuity) }
        let scale = 1 / Float(channels)
        let generation = formatGeneration.load(ordering: .relaxed)
        ring.write(frameCount: frames, hostTicks: hostTicks, flags: flags, generation: generation) { destination, firstFrame in
            Self.downmix(list, scale: scale, into: destination, firstFrame: firstFrame)
        }
        ioCost.record(timebase.nanoseconds(fromTicks: mach_absolute_time() &- started))
    }

    /// Averages every channel of every buffer into `destination` (mono), starting at `firstFrame`.
    private static func downmix(
        _ list: UnsafeMutableAudioBufferListPointer,
        scale: Float,
        into destination: UnsafeMutableBufferPointer<Float>,
        firstFrame: Int
    ) {
        guard let out = destination.baseAddress else { return }
        let count = destination.count
        var first = true
        var index = 0
        while index < list.count {
            let buffer = list[index]
            index += 1
            guard let data = buffer.mData, buffer.mNumberChannels > 0 else { continue }
            let channels = Int(buffer.mNumberChannels)
            let source = data.assumingMemoryBound(to: Float.self) + firstFrame * channels
            if first && channels == 1 && scale == 1 {
                out.update(from: source, count: count)
                return
            }
            var frame = 0
            while frame < count {
                var sum: Float = 0
                var channel = 0
                while channel < channels {
                    sum += source[frame * channels + channel]
                    channel += 1
                }
                out[frame] = first ? sum * scale : out[frame] + sum * scale
                frame += 1
            }
            first = false
        }
    }
}
