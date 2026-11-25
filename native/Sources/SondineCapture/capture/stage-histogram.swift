import Synchronization

/// Fixed log-scale buckets for stage durations (nanoseconds): 4 buckets per octave from 256 ns
/// to about 17 s. Percentiles come from bucket upper bounds, clamped to the observed maximum.
public enum HistogramBuckets {
    public static let count = 104
    static let firstShift = 8

    public static func index(of nanoseconds: UInt64) -> Int {
        guard nanoseconds >= 1 << firstShift else { return 0 }
        let octave = 63 - nanoseconds.leadingZeroBitCount
        let fraction = Int((nanoseconds >> UInt64(max(0, octave - 2))) & 0b11)
        return min(count - 1, (octave - firstShift) * 4 + fraction + 1)
    }

    /// Smallest value that falls in a later bucket.
    public static func upperBound(of index: Int) -> UInt64 {
        guard index > 0 else { return 1 << firstShift }
        let octave = (index - 1) / 4 + firstShift
        let fraction = UInt64((index - 1) % 4)
        return (UInt64(1) << UInt64(octave)) + (fraction + 1) * (UInt64(1) << UInt64(octave - 2))
    }
}

/// A histogram for one stage on one thread (the drain worker).
public struct StageHistogramAccumulator: Sendable, Equatable {
    public private(set) var buckets = [UInt64](repeating: 0, count: HistogramBuckets.count)
    public private(set) var count: UInt64 = 0
    public private(set) var sum: UInt64 = 0
    public private(set) var max: UInt64 = 0

    public init() {}

    public mutating func record(_ nanoseconds: UInt64) {
        buckets[HistogramBuckets.index(of: nanoseconds)] += 1
        count += 1
        sum &+= nanoseconds
        if nanoseconds > max { max = nanoseconds }
    }

    public mutating func merge(buckets other: [UInt64], count: UInt64, sum: UInt64, max: UInt64) {
        for index in buckets.indices { buckets[index] += other[index] }
        self.count += count
        self.sum &+= sum
        if max > self.max { self.max = max }
    }

    /// (p50, p95), consistent with the protocol rule p50 ≤ p95 ≤ max ≤ sum.
    public var percentiles: (p50: UInt64, p95: UInt64) {
        guard count > 0 else { return (0, 0) }
        func percentile(_ fraction: Double) -> UInt64 {
            let rank = UInt64((Double(count) * fraction).rounded(.up))
            var seen: UInt64 = 0
            for (index, value) in buckets.enumerated() {
                seen += value
                if seen >= Swift.max(rank, 1) { return Swift.min(HistogramBuckets.upperBound(of: index), max) }
            }
            return max
        }
        let p50 = percentile(0.5)
        return (p50, Swift.max(p50, percentile(0.95)))
    }

    public func wire(stage: HealthStage, trackKey: String?) -> StageHistogram {
        guard count > 0 else { return StageHistogram(stage: stage, trackKey: trackKey, count: 0, sum: 0, p50: 0, p95: 0, max: 0) }
        // Counters read from another thread can be a record apart; keep the protocol's ordering.
        let top = Swift.min(max, sum)
        let (p50, p95) = percentiles
        let high = Swift.min(p95, top)
        return StageHistogram(stage: stage, trackKey: trackKey, count: count, sum: sum, p50: Swift.min(p50, high), p95: high, max: top)
    }
}

/// Lock-free counters the IO thread updates (one producer) and the drain worker reads.
/// `record` does a handful of relaxed atomic adds: no lock, no allocation.
public final class AtomicStageHistogram: @unchecked Sendable {
    private let buckets: UnsafeMutablePointer<Atomic<UInt64>>
    private let total = Atomic<UInt64>(0)
    private let sumNs = Atomic<UInt64>(0)
    private let maxNs = Atomic<UInt64>(0)
    // Reader-owned copy of the counts at the last `take`.
    private var taken = [UInt64](repeating: 0, count: HistogramBuckets.count)
    private var takenTotal: UInt64 = 0
    private var takenSum: UInt64 = 0

    public init() {
        buckets = .allocate(capacity: HistogramBuckets.count)
        for index in 0..<HistogramBuckets.count { (buckets + index).initialize(to: Atomic(0)) }
    }

    deinit {
        buckets.deinitialize(count: HistogramBuckets.count)
        buckets.deallocate()
    }

    public func record(_ nanoseconds: UInt64) {
        buckets[HistogramBuckets.index(of: nanoseconds)].add(1, ordering: .relaxed)
        total.add(1, ordering: .relaxed)
        sumNs.add(nanoseconds, ordering: .relaxed)
        if nanoseconds > maxNs.load(ordering: .relaxed) { maxNs.store(nanoseconds, ordering: .relaxed) }
    }

    /// Counts since the previous `take` (reader thread only).
    public func take() -> StageHistogramAccumulator {
        var result = StageHistogramAccumulator()
        var delta = [UInt64](repeating: 0, count: HistogramBuckets.count)
        for index in 0..<HistogramBuckets.count {
            let value = buckets[index].load(ordering: .relaxed)
            delta[index] = value &- taken[index]
            taken[index] = value
        }
        let count = total.load(ordering: .relaxed)
        let sum = sumNs.load(ordering: .relaxed)
        let max = maxNs.exchange(0, ordering: .relaxed)
        result.merge(buckets: delta, count: count &- takenTotal, sum: sum &- takenSum, max: max)
        takenTotal = count
        takenSum = sum
        return result
    }
}
