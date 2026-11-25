import CoreAudio
import Darwin
import Foundation
import SondineKit
import Synchronization
import Testing
@testable import SondineCapture

/// Counts heap operations made by one thread through libmalloc's logger hook (`malloc_logger`,
/// the hook `malloc_history` and Instruments use). Every malloc, calloc, realloc and free in
/// the process calls it while it is set; only calls from the watched thread are counted.
enum AllocationCounter {
    typealias Logger = @convention(c) (UInt32, UInt, UInt, UInt, UInt, UInt32) -> Void

    private static let watchedThread = Atomic<UInt>(0)
    private static let operations = Atomic<Int>(0)
    private static let lock = Mutex(())

    /// Address of the `malloc_logger` variable (kept as bits: a pointer is not Sendable).
    private static let hookAddress = UInt(bitPattern: dlsym(UnsafeMutableRawPointer(bitPattern: -2), "malloc_logger"))

    private static var hook: UnsafeMutablePointer<Logger?>? {
        UnsafeMutableRawPointer(bitPattern: hookAddress)?.assumingMemoryBound(to: Logger?.self)
    }

    static var isAvailable: Bool { hookAddress != 0 }

    /// Heap operations `body` made on this thread.
    static func count(_ body: () -> Void) -> Int {
        guard let hook else { return -1 }
        return lock.withLock { _ in
            operations.store(0, ordering: .sequentiallyConsistent)
            watchedThread.store(UInt(bitPattern: pthread_self()), ordering: .sequentiallyConsistent)
            hook.pointee = { _, _, _, _, _, _ in
                if UInt(bitPattern: pthread_self()) == AllocationCounter.watchedThread.load(ordering: .relaxed) {
                    AllocationCounter.operations.add(1, ordering: .relaxed)
                }
            }
            body()
            hook.pointee = nil
            watchedThread.store(0, ordering: .sequentiallyConsistent)
            return operations.load(ordering: .sequentiallyConsistent)
        }
    }
}

struct IOCaptureContextTests {
    /// A stereo, non-interleaved buffer list like a HAL input stream delivers.
    private final class Delivery {
        let list = AudioBufferList.allocate(maximumBuffers: 2)
        let left: UnsafeMutablePointer<Float>
        let right: UnsafeMutablePointer<Float>
        let time = UnsafeMutablePointer<AudioTimeStamp>.allocate(capacity: 1)
        let frames: Int

        init(frames: Int) {
            self.frames = frames
            left = .allocate(capacity: frames)
            right = .allocate(capacity: frames)
            for index in 0..<frames {
                left[index] = 0.5
                right[index] = -0.25
            }
            list[0] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(frames * 4), mData: UnsafeMutableRawPointer(left))
            list[1] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(frames * 4), mData: UnsafeMutableRawPointer(right))
            time.initialize(to: AudioTimeStamp())
            time.pointee.mFlags = .hostTimeValid
        }

        deinit {
            free(list.unsafeMutablePointer)
            left.deallocate()
            right.deallocate()
            time.deallocate()
        }
    }

    @Test func ingestDownmixesIntoTheRing() {
        let context = IOCaptureContext(rate: 48_000, ringSeconds: 1, timebase: HostTimebase(numer: 1, denom: 1))
        let delivery = Delivery(frames: 512)
        delivery.time.pointee.mHostTime = 1_234
        context.ingest(delivery.list.unsafePointer, delivery.time)
        var blocks: [RingBlock] = []
        var first: Float = 0
        context.ring.read { view in
            blocks.append(view.block)
            first = view.head[0]
        }
        #expect(blocks.count == 1)
        #expect(blocks[0].frameCount == 512)
        #expect(blocks[0].hostTicks == 1_234)
        #expect(blocks[0].flags.contains(.discontinuity))
        #expect(first == 0.125)
        #expect(context.callbacks == 1)
    }

    @Test func malformedBufferListsAreRejectedNotRead() {
        let context = IOCaptureContext(rate: 48_000, ringSeconds: 1)
        let delivery = Delivery(frames: 256)
        delivery.list[1].mDataByteSize = 100 * 4
        context.ingest(delivery.list.unsafePointer, delivery.time)
        #expect(context.rejectedBuffers == 1)
        #expect(context.ring.availableFrames == 0)
    }

    /// The IO callback path never touches the heap: buffer validation, downmix, ring write,
    /// discontinuity flag and the cost histogram, including a ring wrap and an overflow.
    @Test(.enabled(if: AllocationCounter.isAvailable, "malloc_logger is not exported"))
    func ingestDoesNotAllocate() {
        let context = IOCaptureContext(rate: 48_000, ringSeconds: 1)
        let delivery = Delivery(frames: 4_096)
        context.markDiscontinuity()
        // Warm up lazy runtime state (metadata, witness tables) outside the measurement.
        context.ingest(delivery.list.unsafePointer, delivery.time)
        context.ring.read { _ in }

        // Positive control: the hook sees an allocation made on this thread.
        let control = AllocationCounter.count {
            let array = [Float](repeating: 1, count: Int.random(in: 1_000...2_000))
            #expect(array.count >= 1_000)
        }
        #expect(control > 0)

        let operations = AllocationCounter.count {
            // 30 callbacks: more than the 1 s ring holds, so the ring wraps and then overflows.
            // A while loop: `for in` over a range allocates an iterator in unoptimized test code.
            var cycle: UInt64 = 0
            while cycle < 30 {
                delivery.time.pointee.mHostTime = cycle * 85_000_000
                if cycle == 3 { context.markDiscontinuity() }
                context.ingest(delivery.list.unsafePointer, delivery.time)
                cycle += 1
            }
        }
        #expect(operations == 0)
        #expect(context.ring.statistics.overflowEpisodes >= 1)
        #expect(context.callbacks == 31)
    }
}
