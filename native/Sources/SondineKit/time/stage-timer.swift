import Darwin

/// Accumulated cost of one pipeline stage on the calling thread.
public struct StageCost: Sendable, Equatable, Codable {
    public var calls = 0
    public var cpuNs: UInt64 = 0
    public var wallNs: UInt64 = 0

    public init() {}

    public var cpuMs: Double { Double(cpuNs) / 1e6 }
    public var wallMs: Double { Double(wallNs) / 1e6 }

    public static func += (lhs: inout StageCost, rhs: StageCost) {
        lhs.calls += rhs.calls
        lhs.cpuNs += rhs.cpuNs
        lhs.wallNs += rhs.wallNs
    }
}

extension StageCost {
    /// Runs `body` and adds its thread CPU time and wall time.
    @discardableResult
    public mutating func measure<T>(_ body: () throws -> T) rethrows -> T {
        let cpuStart = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
        let wallStart = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
        defer {
            cpuNs += clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) &- cpuStart
            wallNs += clock_gettime_nsec_np(CLOCK_UPTIME_RAW) &- wallStart
            calls += 1
        }
        return try body()
    }
}
