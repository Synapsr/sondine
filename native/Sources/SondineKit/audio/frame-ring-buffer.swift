import Synchronization

public struct RingBlockFlags: OptionSet, Sendable, Hashable {
    public let rawValue: UInt32
    public init(rawValue: UInt32) { self.rawValue = rawValue }

    /// Frames were dropped (ring full) right before this block.
    public static let gapBefore = RingBlockFlags(rawValue: 1 << 0)
    /// The producer saw a discontinuity (for example a HAL overload) before this block.
    public static let discontinuity = RingBlockFlags(rawValue: 1 << 1)
}

/// One IO callback's worth of frames, as the producer wrote it.
public struct RingBlock: Sendable, Equatable {
    /// Position in the producer's stream, counting dropped frames, so time stays exact across gaps.
    public var streamFrame: UInt64
    public var frameCount: Int
    /// Host time of the first frame.
    public var hostTicks: UInt64
    /// Frames dropped between the previous block and this one.
    public var droppedFramesBefore: UInt64
    public var flags: RingBlockFlags
    /// The producer's format generation when it wrote the block (a rate change starts a new
    /// one), so the consumer reads each queued block with the rate it was captured at.
    public var generation: UInt32

    public init(
        streamFrame: UInt64, frameCount: Int, hostTicks: UInt64, droppedFramesBefore: UInt64, flags: RingBlockFlags, generation: UInt32 = 0
    ) {
        self.streamFrame = streamFrame
        self.frameCount = frameCount
        self.hostTicks = hostTicks
        self.droppedFramesBefore = droppedFramesBefore
        self.flags = flags
        self.generation = generation
    }
}

/// A block and its interleaved samples, split in two when the block wraps around the ring.
public struct RingBlockView {
    public var block: RingBlock
    public var head: UnsafeBufferPointer<Float>
    public var tail: UnsafeBufferPointer<Float>

    /// Copies the samples into `destination` (at least `block.frameCount × channels` long).
    public func copy(into destination: UnsafeMutablePointer<Float>) {
        if let base = head.baseAddress, !head.isEmpty {
            destination.update(from: base, count: head.count)
        }
        if let base = tail.baseAddress, !tail.isEmpty {
            (destination + head.count).update(from: base, count: tail.count)
        }
    }
}

public struct RingBufferStatistics: Sendable, Equatable {
    public var droppedFrames: UInt64
    public var overflowEpisodes: UInt64
    public var highWaterFrames: Int
    public var capacityFrames: Int
}

/// Lock-free single-producer single-consumer ring of interleaved Float32 frames.
///
/// The producer side (`write`) runs on the real-time IO thread: it never locks, allocates, or
/// blocks. When the ring is full the incoming block is dropped, counted, and the next stored
/// block carries `.gapBefore` with the exact number of dropped frames.
///
/// Exactly one thread may call `write` and exactly one thread may call `read` at a time.
public final class FrameRingBuffer: @unchecked Sendable {
    public let channelCount: Int
    public let capacityFrames: Int
    public let capacityBlocks: Int

    private let frameMask: UInt64
    private let blockMask: UInt64
    private let samples: UnsafeMutablePointer<Float>
    private let blocks: UnsafeMutablePointer<RingBlock>

    // Published positions. Frames count stored frames only; dropped frames never enter the ring.
    private let writtenFrames = Atomic<UInt64>(0)
    private let readFrames = Atomic<UInt64>(0)
    private let writtenBlocks = Atomic<UInt64>(0)
    private let readBlocks = Atomic<UInt64>(0)

    // Statistics, written by the producer and read from any thread.
    private let droppedFramesTotal = Atomic<UInt64>(0)
    private let overflowEpisodeCount = Atomic<UInt64>(0)
    private let highWater = Atomic<Int>(0)

    // Producer-owned state.
    private var offeredFrames: UInt64 = 0
    private var pendingDroppedFrames: UInt64 = 0

    /// - Parameters:
    ///   - minimumFrames: rounded up to a power of two.
    ///   - minimumBlocks: rounded up to a power of two; bounds how many IO callbacks can queue.
    public init(channelCount: Int, minimumFrames: Int, minimumBlocks: Int = 4096) {
        precondition(channelCount > 0, "channelCount must be positive")
        precondition(minimumFrames > 0 && minimumBlocks > 0, "capacities must be positive")
        self.channelCount = channelCount
        capacityFrames = Self.powerOfTwo(atLeast: minimumFrames)
        capacityBlocks = Self.powerOfTwo(atLeast: minimumBlocks)
        frameMask = UInt64(capacityFrames - 1)
        blockMask = UInt64(capacityBlocks - 1)
        samples = .allocate(capacity: capacityFrames * channelCount)
        samples.initialize(repeating: 0, count: capacityFrames * channelCount)
        blocks = .allocate(capacity: capacityBlocks)
        blocks.initialize(
            repeating: RingBlock(streamFrame: 0, frameCount: 0, hostTicks: 0, droppedFramesBefore: 0, flags: []),
            count: capacityBlocks
        )
    }

    deinit {
        samples.deallocate()
        blocks.deallocate()
    }

    // MARK: Producer (IO thread)

    /// Stores one block. `fill` is called once, or twice when the block wraps, with the
    /// destination region and the index of its first frame within the block.
    ///
    /// Returns `false` when the block was dropped because the ring is full.
    @discardableResult
    public func write(
        frameCount: Int,
        hostTicks: UInt64,
        flags: RingBlockFlags = [],
        generation: UInt32 = 0,
        fill: (_ destination: UnsafeMutableBufferPointer<Float>, _ firstFrame: Int) -> Void
    ) -> Bool {
        guard frameCount > 0 else { return true }
        let written = writtenFrames.load(ordering: .relaxed)
        let read = readFrames.load(ordering: .acquiring)
        let used = Int(written &- read)
        let blocksWritten = writtenBlocks.load(ordering: .relaxed)
        let blocksRead = readBlocks.load(ordering: .acquiring)

        if frameCount > capacityFrames - used || Int(blocksWritten &- blocksRead) >= capacityBlocks {
            if pendingDroppedFrames == 0 {
                overflowEpisodeCount.add(1, ordering: .relaxed)
            }
            pendingDroppedFrames &+= UInt64(frameCount)
            offeredFrames &+= UInt64(frameCount)
            droppedFramesTotal.add(UInt64(frameCount), ordering: .relaxed)
            return false
        }

        let position = Int(written & frameMask)
        let firstPart = min(frameCount, capacityFrames - position)
        fill(UnsafeMutableBufferPointer(start: samples + position * channelCount, count: firstPart * channelCount), 0)
        if firstPart < frameCount {
            fill(UnsafeMutableBufferPointer(start: samples, count: (frameCount - firstPart) * channelCount), firstPart)
        }

        var blockFlags = flags
        if pendingDroppedFrames > 0 { blockFlags.insert(.gapBefore) }
        blocks[Int(blocksWritten & blockMask)] = RingBlock(
            streamFrame: offeredFrames,
            frameCount: frameCount,
            hostTicks: hostTicks,
            droppedFramesBefore: pendingDroppedFrames,
            flags: blockFlags,
            generation: generation
        )
        pendingDroppedFrames = 0
        offeredFrames &+= UInt64(frameCount)

        writtenFrames.store(written &+ UInt64(frameCount), ordering: .releasing)
        writtenBlocks.store(blocksWritten &+ 1, ordering: .releasing)

        let nowUsed = used + frameCount
        if nowUsed > highWater.load(ordering: .relaxed) {
            highWater.store(nowUsed, ordering: .relaxed)
        }
        return true
    }

    /// Copies `frameCount` interleaved frames (`frameCount × channelCount` floats).
    @discardableResult
    public func write(
        interleaved source: UnsafePointer<Float>,
        frameCount: Int,
        hostTicks: UInt64,
        flags: RingBlockFlags = []
    ) -> Bool {
        let channels = channelCount
        return write(frameCount: frameCount, hostTicks: hostTicks, flags: flags) { destination, firstFrame in
            guard let base = destination.baseAddress else { return }
            base.update(from: source + firstFrame * channels, count: destination.count)
        }
    }

    // MARK: Consumer (drain worker)

    /// Hands each available block to `body`, oldest first, then releases its space.
    /// Returns the number of blocks consumed.
    @discardableResult
    public func read(maxBlocks: Int = .max, _ body: (RingBlockView) -> Void) -> Int {
        let available = writtenBlocks.load(ordering: .acquiring)
        var blocksRead = readBlocks.load(ordering: .relaxed)
        var framesRead = readFrames.load(ordering: .relaxed)
        var consumed = 0
        while blocksRead != available && consumed < maxBlocks {
            let block = blocks[Int(blocksRead & blockMask)]
            let position = Int(framesRead & frameMask)
            let firstPart = min(block.frameCount, capacityFrames - position)
            let head = UnsafeBufferPointer(start: samples + position * channelCount, count: firstPart * channelCount)
            let tail = UnsafeBufferPointer(start: samples, count: (block.frameCount - firstPart) * channelCount)
            body(RingBlockView(block: block, head: head, tail: tail))
            framesRead &+= UInt64(block.frameCount)
            blocksRead &+= 1
            readFrames.store(framesRead, ordering: .releasing)
            readBlocks.store(blocksRead, ordering: .releasing)
            consumed += 1
        }
        return consumed
    }

    /// Frames currently stored and not yet read. Safe from any thread.
    public var availableFrames: Int {
        // Read position first: it never passes the write position, so a later write load cannot be
        // behind it. Both may move between the loads, so the difference can exceed the capacity.
        let read = readFrames.load(ordering: .acquiring)
        let written = writtenFrames.load(ordering: .acquiring)
        return Int(min(written &- read, UInt64(capacityFrames)))
    }

    public var statistics: RingBufferStatistics {
        RingBufferStatistics(
            droppedFrames: droppedFramesTotal.load(ordering: .relaxed),
            overflowEpisodes: overflowEpisodeCount.load(ordering: .relaxed),
            highWaterFrames: highWater.load(ordering: .relaxed),
            capacityFrames: capacityFrames
        )
    }

    private static func powerOfTwo(atLeast value: Int) -> Int {
        var result = 1
        while result < value { result <<= 1 }
        return result
    }
}
