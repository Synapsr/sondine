import Foundation
import SondineKit
import Synchronization
import Testing

@Suite struct FrameRingBufferTests {
    private func drain(_ ring: FrameRingBuffer) -> [(RingBlock, [Float])] {
        var result: [(RingBlock, [Float])] = []
        ring.read { view in
            var samples = [Float](repeating: 0, count: view.block.frameCount * ring.channelCount)
            samples.withUnsafeMutableBufferPointer { view.copy(into: $0.baseAddress!) }
            result.append((view.block, samples))
        }
        return result
    }

    @Test func storesInterleavedBlocksWithTimestamps() {
        let ring = FrameRingBuffer(channelCount: 2, minimumFrames: 1_000)
        #expect(ring.capacityFrames == 1_024)
        let first: [Float] = [1, -1, 2, -2, 3, -3]
        let second: [Float] = [4, -4]
        first.withUnsafeBufferPointer { #expect(ring.write(interleaved: $0.baseAddress!, frameCount: 3, hostTicks: 100)) }
        second.withUnsafeBufferPointer { #expect(ring.write(interleaved: $0.baseAddress!, frameCount: 1, hostTicks: 200)) }
        #expect(ring.availableFrames == 4)

        let blocks = drain(ring)
        #expect(blocks.count == 2)
        #expect(blocks[0].0 == RingBlock(streamFrame: 0, frameCount: 3, hostTicks: 100, droppedFramesBefore: 0, flags: []))
        #expect(blocks[0].1 == first)
        #expect(blocks[1].0.streamFrame == 3)
        #expect(blocks[1].1 == second)
        #expect(ring.availableFrames == 0)
    }

    @Test func wrappingBlockArrivesInTwoParts() {
        let ring = FrameRingBuffer(channelCount: 1, minimumFrames: 8)
        let six = (0..<6).map(Float.init)
        six.withUnsafeBufferPointer { _ = ring.write(interleaved: $0.baseAddress!, frameCount: 6, hostTicks: 1) }
        _ = drain(ring)
        let five = (10..<15).map(Float.init)
        five.withUnsafeBufferPointer { #expect(ring.write(interleaved: $0.baseAddress!, frameCount: 5, hostTicks: 2)) }
        var parts: [(Int, Int)] = []
        var joined: [Float] = []
        ring.read { view in
            parts.append((view.head.count, view.tail.count))
            joined = Array(view.head) + Array(view.tail)
        }
        #expect(parts.count == 1)
        #expect(parts[0] == (2, 3))
        #expect(joined == five)
    }

    @Test func overflowDropsTheIncomingBlockAndFlagsTheNextOne() {
        let ring = FrameRingBuffer(channelCount: 1, minimumFrames: 16)
        let block = [Float](repeating: 1, count: 10)
        block.withUnsafeBufferPointer { buffer in
            #expect(ring.write(interleaved: buffer.baseAddress!, frameCount: 10, hostTicks: 1))
            #expect(!ring.write(interleaved: buffer.baseAddress!, frameCount: 10, hostTicks: 2))
            #expect(!ring.write(interleaved: buffer.baseAddress!, frameCount: 8, hostTicks: 3))
            #expect(ring.write(interleaved: buffer.baseAddress!, frameCount: 3, hostTicks: 4))
        }
        let statistics = ring.statistics
        #expect(statistics.droppedFrames == 18)
        #expect(statistics.overflowEpisodes == 1)
        #expect(statistics.highWaterFrames == 13)

        let blocks = drain(ring)
        #expect(blocks.count == 2)
        #expect(blocks[0].0.flags.isEmpty)
        #expect(blocks[1].0.flags == [.gapBefore])
        #expect(blocks[1].0.droppedFramesBefore == 18)
        // Stream position counts the dropped frames, so time stays exact.
        #expect(blocks[1].0.streamFrame == 28)
    }

    @Test func blockQueueAlsoBoundsTheRing() {
        let ring = FrameRingBuffer(channelCount: 1, minimumFrames: 1_024, minimumBlocks: 2)
        let one: [Float] = [0.5]
        one.withUnsafeBufferPointer { buffer in
            #expect(ring.write(interleaved: buffer.baseAddress!, frameCount: 1, hostTicks: 1))
            #expect(ring.write(interleaved: buffer.baseAddress!, frameCount: 1, hostTicks: 2))
            #expect(!ring.write(interleaved: buffer.baseAddress!, frameCount: 1, hostTicks: 3))
        }
        #expect(ring.statistics.droppedFrames == 1)
    }

    @Test func producerCallerFlagsPassThrough() {
        let ring = FrameRingBuffer(channelCount: 1, minimumFrames: 64)
        let samples: [Float] = [0, 0]
        samples.withUnsafeBufferPointer {
            _ = ring.write(interleaved: $0.baseAddress!, frameCount: 2, hostTicks: 7, flags: .discontinuity)
        }
        #expect(drain(ring).first?.0.flags == [.discontinuity])
    }

    @Test func writePathDoesNotAllocate() throws {
        let ring = FrameRingBuffer(channelCount: 2, minimumFrames: 8_192)
        let source = [Float](repeating: 0.25, count: 512 * 2)
        var stored = 0
        // `while` loops: a `for-in` over a range allocates per iteration in debug builds.
        let allocations = source.withUnsafeBufferPointer { buffer -> Int? in
            AllocationCounter.count {
                var round = 0
                while round < 20_000 {
                    if ring.write(interleaved: buffer.baseAddress!, frameCount: 512, hostTicks: UInt64(round)) { stored += 1 }
                    // A fill closure, as the HAL callback uses to downmix or deinterleave in place.
                    ring.write(frameCount: 256, hostTicks: UInt64(round)) { destination, _ in
                        var index = 0
                        while index < destination.count {
                            destination[index] = 0
                            index += 1
                        }
                    }
                    if round % 16 == 0 { ring.read { _ in } }
                    round += 1
                }
            }
        }
        let count = try #require(allocations, "malloc_logger hook unavailable")
        #expect(count == 0)
        #expect(stored > 0)
        #expect(ring.statistics.droppedFrames > 0)
    }

    @Test func concurrentProducerAndConsumerKeepOrderAndCountDrops() throws {
        let ring = FrameRingBuffer(channelCount: 1, minimumFrames: 4_096, minimumBlocks: 64)
        let blocks = 50_000
        let frames = 64
        let done = Atomic<Bool>(false)

        let producer = Thread {
            var buffer = [Float](repeating: 0, count: frames)
            var stream: UInt64 = 0
            for block in 0..<blocks {
                for index in 0..<frames { buffer[index] = Float(stream + UInt64(index)) }
                buffer.withUnsafeBufferPointer {
                    _ = ring.write(interleaved: $0.baseAddress!, frameCount: frames, hostTicks: UInt64(block))
                }
                stream += UInt64(frames)
                if block % 1_000 == 0 { usleep(200) }
            }
            done.store(true, ordering: .releasing)
        }
        producer.start()

        var expectedStream: UInt64 = 0
        var droppedSeen: UInt64 = 0
        var received = 0
        var orderViolations = 0
        var valueViolations = 0
        while true {
            let finished = done.load(ordering: .acquiring)
            ring.read { view in
                let block = view.block
                if block.streamFrame != expectedStream + block.droppedFramesBefore { orderViolations += 1 }
                if block.droppedFramesBefore > 0, !block.flags.contains(.gapBefore) { orderViolations += 1 }
                droppedSeen += block.droppedFramesBefore
                let samples = Array(view.head) + Array(view.tail)
                for (index, value) in samples.enumerated() where value != Float(block.streamFrame + UInt64(index)) {
                    valueViolations += 1
                }
                expectedStream = block.streamFrame + UInt64(block.frameCount)
                received += 1
            }
            if finished, ring.availableFrames == 0 { break }
        }
        #expect(orderViolations == 0)
        #expect(valueViolations == 0)
        // Frames dropped after the last stored block are counted but not yet attributed to a block.
        #expect(droppedSeen <= ring.statistics.droppedFrames)
        #expect(UInt64(received * frames) + ring.statistics.droppedFrames == UInt64(blocks * frames))
    }

    /// A third thread reading the occupancy while both ends advance (health reporting) must get
    /// a value within the capacity, never trap on a stale write position.
    @Test func occupancyIsSafeToReadFromAnotherThread() {
        let ring = FrameRingBuffer(channelCount: 1, minimumFrames: 64, minimumBlocks: 64)
        let stop = Atomic<Bool>(false)
        let one: [Float] = [0]
        let producer = Thread {
            one.withUnsafeBufferPointer { buffer in
                while !stop.load(ordering: .relaxed) { _ = ring.write(interleaved: buffer.baseAddress!, frameCount: 1, hostTicks: 0) }
            }
        }
        let consumer = Thread {
            while !stop.load(ordering: .relaxed) { ring.read { _ in } }
        }
        producer.start()
        consumer.start()
        var outOfRange = 0
        let deadline = Date().addingTimeInterval(0.5)
        while Date() < deadline {
            for _ in 0..<10_000 {
                let available = ring.availableFrames
                if available < 0 || available > ring.capacityFrames { outOfRange += 1 }
            }
        }
        stop.store(true, ordering: .relaxed)
        while producer.isExecuting || consumer.isExecuting { usleep(1_000) }
        #expect(outOfRange == 0)
    }
}
