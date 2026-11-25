import Darwin
import SondineKit

/// The helper's own cost for `health.process`: phys_footprint, CPU time and wakeups from
/// `proc_pid_rusage` (rusage v6), reported as deltas over the health window.
struct ProcessMetrics {
    private var lastCpuNs: UInt64?
    private var lastWakeups: UInt64?

    mutating func take() -> ProcessCost {
        var info = rusage_info_v6()
        let status = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(getpid(), RUSAGE_INFO_V6, $0) }
        }
        guard status == 0 else { return ProcessCost(footprintBytes: 0, cpuNs: 0, wakeups: 0) }
        // ri_user_time and ri_system_time count mach absolute time units on Apple silicon.
        let cpu = HostTimebase.current.nanoseconds(fromTicks: info.ri_user_time &+ info.ri_system_time)
        let wakeups = info.ri_pkg_idle_wkups &+ info.ri_interrupt_wkups
        defer {
            lastCpuNs = cpu
            lastWakeups = wakeups
        }
        return ProcessCost(
            footprintBytes: info.ri_phys_footprint,
            cpuNs: cpu &- (lastCpuNs ?? cpu),
            wakeups: wakeups &- (lastWakeups ?? wakeups)
        )
    }
}
