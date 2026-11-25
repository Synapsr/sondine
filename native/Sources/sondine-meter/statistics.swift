// Pure math behind `sondine-meter summarize`. No Darwin calls, so tests can feed synthetic series.

/// Mach absolute-time ticks to nanoseconds. Apple silicon reports 125/3 (one tick is 41.67 ns);
/// `ri_user_time`, `ri_system_time` and the QoS times in rusage v6 are in these ticks.
struct Timebase: Codable, Equatable, Sendable {
    var numer: UInt32
    var denom: UInt32

    static let identity = Timebase(numer: 1, denom: 1)

    /// Splits the multiplication so `ticks * numer` cannot overflow for any uptime.
    func nanoseconds(fromTicks ticks: UInt64) -> UInt64 {
        guard denom > 0 else { return ticks }
        let numer = UInt64(self.numer)
        let denom = UInt64(self.denom)
        let whole = ticks / denom
        let remainder = ticks % denom
        return whole &* numer &+ (remainder &* numer) / denom
    }
}

/// Percent of one core: 100 means one core busy for the whole interval.
func cpuPercent(cpuNanoseconds: Double, wallNanoseconds: Double) -> Double? {
    guard wallNanoseconds > 0 else { return nil }
    return 100 * cpuNanoseconds / wallNanoseconds
}

/// A cumulative counter read at one tick (CPU ns, wakeups, energy nJ, bytes).
struct CounterPoint: Equatable, Sendable {
    var tick: Int
    var uptimeNs: UInt64
    var value: UInt64
}

/// The growth of a counter between two consecutive readings.
struct CounterInterval: Equatable, Sendable {
    var endTick: Int
    var startNs: UInt64
    var endNs: UInt64
    var delta: Double

    var durationNs: Double { Double(endNs - startNs) }
}

/// Consecutive deltas. A counter that goes down (a new process behind a reused pid) or a
/// reading that does not advance in time starts a new baseline instead of producing a delta.
func counterIntervals(_ points: [CounterPoint]) -> [CounterInterval] {
    var result: [CounterInterval] = []
    var previous: CounterPoint?
    for point in points {
        defer { previous = point }
        guard let start = previous, point.uptimeNs > start.uptimeNs, point.value >= start.value else { continue }
        result.append(
            CounterInterval(endTick: point.tick, startNs: start.uptimeNs, endNs: point.uptimeNs, delta: Double(point.value - start.value))
        )
    }
    return result
}

/// Sums several processes' intervals on a common timeline: the time is cut at every member's
/// reading and each interval's growth is spread evenly over its span. A member read every 60 s
/// (`top`) then adds its growth across the minute, not into a dense member's last second.
/// Each member's intervals must be in time order and not overlap (as `counterIntervals` gives).
func mergeIntervals(_ members: [[CounterInterval]]) -> [CounterInterval] {
    if members.count == 1, let only = members.first { return only }
    let bounds = Set(members.joined().flatMap { [$0.startNs, $0.endNs] }).sorted()
    var cursors = [Int](repeating: 0, count: members.count)
    var result: [CounterInterval] = []
    for (start, end) in zip(bounds, bounds.dropFirst()) {
        var delta = 0.0
        var endTick: Int?
        for (member, intervals) in members.enumerated() {
            var cursor = cursors[member]
            while cursor < intervals.count, intervals[cursor].endNs <= start { cursor += 1 }
            cursors[member] = cursor
            // Every reading time is a bound, so an interval that reaches into this span covers it.
            guard cursor < intervals.count, intervals[cursor].startNs < end else { continue }
            let interval = intervals[cursor]
            delta += interval.delta * Double(end - start) / interval.durationNs
            endTick = min(endTick ?? interval.endTick, interval.endTick)
        }
        if let endTick { result.append(CounterInterval(endTick: endTick, startNs: start, endNs: end, delta: delta)) }
    }
    return result
}

/// Mean rate per second over the whole span the intervals cover (first start to last end).
/// Summing members' deltas over the shared span gives the group's mean, also when a member
/// lived for only part of the run.
func meanRatePerSecond(_ members: [[CounterInterval]]) -> Double? {
    let all = members.joined()
    guard let start = all.map(\.startNs).min(), let end = all.map(\.endNs).max(), end > start else { return nil }
    let delta = all.reduce(0) { $0 + $1.delta }
    return delta / Double(end - start) * 1e9
}

/// Rates per second over consecutive windows of at least `windowNs`. A trailing window shorter
/// than half the target is dropped so one short tail cannot dominate the p95.
func windowRatesPerSecond(_ intervals: [CounterInterval], windowNs: UInt64) -> [Double] {
    guard windowNs > 0 else { return [] }
    var rates: [Double] = []
    var delta = 0.0
    var duration = 0.0
    for interval in intervals {
        delta += interval.delta
        duration += interval.durationNs
        if duration >= Double(windowNs) {
            rates.append(delta / duration * 1e9)
            delta = 0
            duration = 0
        }
    }
    if duration >= Double(windowNs) / 2, duration > 0 {
        rates.append(delta / duration * 1e9)
    }
    return rates
}

/// Percentile with linear interpolation between closest ranks (the R-7 / NumPy default).
func percentile(_ values: [Double], _ fraction: Double) -> Double? {
    guard !values.isEmpty, fraction >= 0, fraction <= 1 else { return nil }
    let sorted = values.sorted()
    let position = fraction * Double(sorted.count - 1)
    let lower = Int(position.rounded(.down))
    let upper = Int(position.rounded(.up))
    let weight = position - Double(lower)
    return sorted[lower] + (sorted[upper] - sorted[lower]) * weight
}

/// A memory reading (bytes) at one tick.
struct GaugePoint: Equatable, Sendable {
    var tick: Int
    var uptimeNs: UInt64
    var bytes: UInt64
}

/// Least-squares slope of footprint over time, in MiB per hour.
func slopeMiBPerHour(_ points: [GaugePoint]) -> Double? {
    guard points.count >= 2 else { return nil }
    let xs = points.map { Double($0.uptimeNs) / 3.6e12 }
    let ys = points.map { Double($0.bytes) / 1_048_576 }
    let meanX = xs.reduce(0, +) / Double(xs.count)
    let meanY = ys.reduce(0, +) / Double(ys.count)
    var covariance = 0.0
    var variance = 0.0
    for (x, y) in zip(xs, ys) {
        covariance += (x - meanX) * (y - meanY)
        variance += (x - meanX) * (x - meanX)
    }
    guard variance > 0 else { return nil }
    return covariance / variance
}

/// Sum of several processes' footprints per tick. Each member keeps its last reading until its
/// next one (sparse sources such as `top` snapshots) and counts only between its first and last
/// readings, so a process that exited stops counting.
func mergeGaugesByTick(_ members: [[GaugePoint]]) -> [GaugePoint] {
    if members.count == 1, let only = members.first { return only }
    struct Member {
        var points: [GaugePoint]
        var next = 0
        var last: UInt64?
    }
    var states = members.filter { !$0.isEmpty }.map { Member(points: $0) }
    let ticks = Set(members.joined().map(\.tick)).sorted()
    var result: [GaugePoint] = []
    for tick in ticks {
        var sum: UInt64 = 0
        var uptime: UInt64 = 0
        for index in states.indices {
            var state = states[index]
            while state.next < state.points.count, state.points[state.next].tick <= tick {
                state.last = state.points[state.next].bytes
                uptime = max(uptime, state.points[state.next].uptimeNs)
                state.next += 1
            }
            if let last = state.last, let lastTick = state.points.last?.tick, tick <= lastTick {
                sum += last
            }
            states[index] = state
        }
        result.append(GaugePoint(tick: tick, uptimeNs: uptime, bytes: sum))
    }
    return result
}
