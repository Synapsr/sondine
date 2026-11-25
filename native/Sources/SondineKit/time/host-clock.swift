import Darwin

/// `mach_timebase_info` ratio: nanoseconds = ticks × numer / denom.
public struct HostTimebase: Sendable, Equatable, Codable {
    public var numer: UInt32
    public var denom: UInt32

    public init(numer: UInt32, denom: UInt32) {
        precondition(numer > 0 && denom > 0, "timebase terms must be positive")
        self.numer = numer
        self.denom = denom
    }

    public static let current: HostTimebase = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return HostTimebase(numer: info.numer, denom: info.denom)
    }()

    public var ticksPerSecond: Double { 1e9 * Double(denom) / Double(numer) }

    public func nanoseconds(fromTicks ticks: UInt64) -> UInt64 {
        // Split to avoid overflowing ticks × numer for large uptimes.
        let whole = ticks / UInt64(denom)
        let rest = ticks % UInt64(denom)
        return whole * UInt64(numer) + rest * UInt64(numer) / UInt64(denom)
    }

    public func ticks(fromNanoseconds ns: UInt64) -> UInt64 {
        let whole = ns / UInt64(numer)
        let rest = ns % UInt64(numer)
        return whole * UInt64(denom) + rest * UInt64(denom) / UInt64(numer)
    }

    public func ticks(fromSeconds seconds: Double) -> Int64 {
        Int64((seconds * ticksPerSecond).rounded())
    }

    public func seconds(fromTicks ticks: Int64) -> Double {
        Double(ticks) / ticksPerSecond
    }
}

/// One reading of the three clocks, taken back to back.
public struct ClockAnchor: Sendable, Equatable {
    /// `mach_absolute_time`, stops during sleep.
    public var hostTicks: UInt64
    /// `mach_continuous_time` in nanoseconds, keeps counting during sleep.
    public var continuousNs: UInt64
    /// Unix wall clock in nanoseconds.
    public var wallNs: UInt64

    public init(hostTicks: UInt64, continuousNs: UInt64, wallNs: UInt64) {
        self.hostTicks = hostTicks
        self.continuousNs = continuousNs
        self.wallNs = wallNs
    }
}

/// Clock source for the spool; tests replace it with a fixed clock.
public protocol HostClock: Sendable {
    var timebase: HostTimebase { get }
    func anchor() -> ClockAnchor
}

extension HostClock {
    /// Continuous time of a host-ticks instant, assuming no sleep since it was captured.
    public func continuousNanoseconds(forHostTicks hostTicks: UInt64) -> UInt64 {
        let now = anchor()
        let nowHostNs = timebase.nanoseconds(fromTicks: now.hostTicks)
        let thenHostNs = timebase.nanoseconds(fromTicks: hostTicks)
        let sleptNs = now.continuousNs &- nowHostNs
        return thenHostNs &+ sleptNs
    }
}

public struct MachHostClock: HostClock {
    public init() {}

    public var timebase: HostTimebase { .current }

    public func anchor() -> ClockAnchor {
        let host = mach_absolute_time()
        let continuous = mach_continuous_time()
        let wall = clock_gettime_nsec_np(CLOCK_REALTIME)
        return ClockAnchor(
            hostTicks: host,
            continuousNs: HostTimebase.current.nanoseconds(fromTicks: continuous),
            wallNs: wall
        )
    }
}

/// CPU time of the calling thread, used for per-stage cost reports.
public enum ThreadCPUClock {
    public static func nanoseconds() -> UInt64 {
        clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
    }
}
