import Darwin

/// Clocks for one sampling tick. Rates use uptime, which stops while the Mac sleeps, so a
/// sleep inside a run does not dilute CPU or wakeup rates; continuous time shows the sleep.
struct ClockReading: Sendable {
    var uptimeNs: UInt64
    var continuousNs: UInt64
    var wallNs: UInt64

    static func now() -> ClockReading {
        var wall = timespec()
        clock_gettime(CLOCK_REALTIME, &wall)
        return ClockReading(
            uptimeNs: clock_gettime_nsec_np(CLOCK_UPTIME_RAW),
            continuousNs: clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW),
            wallNs: UInt64(wall.tv_sec) * 1_000_000_000 + UInt64(wall.tv_nsec)
        )
    }

    /// ISO 8601 in UTC with milliseconds, e.g. 2026-11-03T05:50:01.002Z.
    var iso8601: String {
        var seconds = time_t(wallNs / 1_000_000_000)
        var parts = tm()
        gmtime_r(&seconds, &parts)
        let millis = Int(wallNs / 1_000_000 % 1000)
        func pad(_ value: Int32, _ width: Int) -> String {
            let text = String(value)
            return String(repeating: "0", count: max(0, width - text.count)) + text
        }
        return "\(pad(parts.tm_year + 1900, 4))-\(pad(parts.tm_mon + 1, 2))-\(pad(parts.tm_mday, 2))T"
            + "\(pad(parts.tm_hour, 2)):\(pad(parts.tm_min, 2)):\(pad(parts.tm_sec, 2)).\(pad(Int32(millis), 3))Z"
    }
}

extension Timebase {
    static let current: Timebase = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return Timebase(numer: info.numer, denom: info.denom)
    }()
}

/// Who a pid is. `startUs` (process start, µs since 1970) tells a reused pid apart.
struct ProcessIdentity: Equatable, Sendable {
    var pid: Int32
    var ppid: Int32
    var uid: UInt32
    var startUs: UInt64
    var name: String
    var path: String?

    var executableName: String {
        guard let path, let slash = path.lastIndex(of: "/") else { return name }
        return String(path[path.index(after: slash)...])
    }
}

/// One proc_pid_rusage(RUSAGE_INFO_V6) reading with times already in nanoseconds.
struct RusageReading: Sendable {
    /// ri_proc_start_abstime: changes when the pid now names another process.
    var startAbstime: UInt64
    var userNs: UInt64
    var systemNs: UInt64
    var interruptWakeups: UInt64
    var idleWakeups: UInt64
    var footprintBytes: UInt64
    var lifetimeMaxFootprintBytes: UInt64
    var energyNj: UInt64
    var pEnergyNj: UInt64
    var neuralFootprintBytes: UInt64
    var lifetimeMaxNeuralFootprintBytes: UInt64
    var instructions: UInt64
    var cycles: UInt64
    var diskReadBytes: UInt64
    var diskWrittenBytes: UInt64
    var logicalWrites: UInt64
    var runnableNs: UInt64
    var qos: QosTimes
}

enum ProcessInspector {
    static func allPids() -> [Int32] {
        let estimate = proc_listallpids(nil, 0)
        guard estimate > 0 else { return [] }
        var pids = [Int32](repeating: 0, count: Int(estimate) + 64)
        let count = pids.withUnsafeMutableBytes { buffer in
            proc_listallpids(buffer.baseAddress, Int32(buffer.count))
        }
        guard count > 0 else { return [] }
        return pids.prefix(Int(count)).filter { $0 > 0 }.sorted()
    }

    /// Works for every user's processes (sysctl kern.proc and proc_pidpath are not restricted).
    static func identity(of pid: Int32) -> ProcessIdentity? {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        guard sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
        let start = info.kp_proc.p_starttime
        return ProcessIdentity(
            pid: pid,
            ppid: info.kp_eproc.e_ppid,
            uid: info.kp_eproc.e_ucred.cr_uid,
            startUs: UInt64(start.tv_sec) * 1_000_000 + UInt64(start.tv_usec),
            name: name(of: pid) ?? commandName(info),
            path: path(of: pid)
        )
    }

    static func name(of pid: Int32) -> String? {
        var buffer = [CChar](repeating: 0, count: 2 * Int(MAXCOMLEN) + 1)
        guard proc_name(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
        return String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }

    static func path(of pid: Int32) -> String? {
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
        return String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }

    private static func commandName(_ info: kinfo_proc) -> String {
        withUnsafeBytes(of: info.kp_proc.p_comm) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
    }

    /// argv of a process owned by this user (KERN_PROCARGS2); nil for other users' processes.
    static func arguments(of pid: Int32) -> [String]? {
        var argmax: Int32 = 0
        var argmaxSize = MemoryLayout<Int32>.size
        guard sysctlbyname("kern.argmax", &argmax, &argmaxSize, nil, 0) == 0, argmax > 0 else { return nil }
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var buffer = [UInt8](repeating: 0, count: Int(argmax))
        var size = buffer.count
        guard sysctl(&mib, UInt32(mib.count), &buffer, &size, nil, 0) == 0 else { return nil }
        return parseProcessArguments(buffer.prefix(size))
    }

    static func rusage(of pid: Int32, timebase: Timebase = .current) -> Result<RusageReading, Errno> {
        var info = rusage_info_v6()
        let status = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V6, $0) }
        }
        guard status == 0 else { return .failure(Errno(errno)) }
        let ns = timebase.nanoseconds(fromTicks:)
        return .success(
            RusageReading(
                startAbstime: info.ri_proc_start_abstime,
                userNs: ns(info.ri_user_time),
                systemNs: ns(info.ri_system_time),
                interruptWakeups: info.ri_interrupt_wkups,
                idleWakeups: info.ri_pkg_idle_wkups,
                footprintBytes: info.ri_phys_footprint,
                lifetimeMaxFootprintBytes: info.ri_lifetime_max_phys_footprint,
                energyNj: info.ri_energy_nj,
                pEnergyNj: info.ri_penergy_nj,
                neuralFootprintBytes: info.ri_neural_footprint,
                lifetimeMaxNeuralFootprintBytes: info.ri_lifetime_max_neural_footprint,
                instructions: info.ri_instructions,
                cycles: info.ri_cycles,
                diskReadBytes: info.ri_diskio_bytesread,
                diskWrittenBytes: info.ri_diskio_byteswritten,
                logicalWrites: info.ri_logical_writes,
                runnableNs: ns(info.ri_runnable_time),
                qos: QosTimes(
                    default: ns(info.ri_cpu_time_qos_default),
                    maintenance: ns(info.ri_cpu_time_qos_maintenance),
                    background: ns(info.ri_cpu_time_qos_background),
                    utility: ns(info.ri_cpu_time_qos_utility),
                    legacy: ns(info.ri_cpu_time_qos_legacy),
                    userInitiated: ns(info.ri_cpu_time_qos_user_initiated),
                    userInteractive: ns(info.ri_cpu_time_qos_user_interactive)
                )
            )
        )
    }

    /// IOKit/Metal memory tagged to the task (task_vm_info rev 3+). Needs a task name port,
    /// which macOS grants only for this user's processes.
    static func graphicsFootprint(of pid: Int32) -> UInt64? {
        var port: mach_port_name_t = 0
        guard task_name_for_pid(mach_task_self_, pid, &port) == KERN_SUCCESS else { return nil }
        defer { mach_port_deallocate(mach_task_self_, port) }
        var info = task_vm_info_data_t()
        let fullCount = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        var count = fullCount
        let status = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(port, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        // TASK_VM_INFO_REV3_COUNT (the first with ledger tags) is the rev 7 count minus the
        // 9 natural_t that revs 4-7 append; the macro itself does not import into Swift.
        guard status == KERN_SUCCESS, count >= fullCount - 9, info.ledger_tag_graphics_footprint >= 0 else { return nil }
        return UInt64(info.ledger_tag_graphics_footprint)
    }

    /// Alive and visible, whatever its owner: kill(pid, 0) fails with ESRCH only once it is gone.
    static func isAlive(_ pid: Int32) -> Bool {
        kill(pid, 0) == 0 || errno == EPERM
    }
}

/// KERN_PROCARGS2 layout: argc (Int32), the exec path, NUL padding, then argc NUL-terminated args.
func parseProcessArguments(_ bytes: ArraySlice<UInt8>) -> [String]? {
    guard bytes.count >= 4 else { return nil }
    let start = bytes.startIndex
    let argc = Int(Int32(littleEndian: bytes[start..<start + 4].withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }))
    var index = start + 4
    while index < bytes.endIndex, bytes[index] != 0 { index += 1 }
    while index < bytes.endIndex, bytes[index] == 0 { index += 1 }
    var arguments: [String] = []
    while arguments.count < argc, index < bytes.endIndex {
        let begin = index
        while index < bytes.endIndex, bytes[index] != 0 { index += 1 }
        arguments.append(String(decoding: bytes[begin..<index], as: UTF8.self))
        index += 1
    }
    return arguments
}

struct Errno: Error, Equatable, Sendable, CustomStringConvertible {
    var code: Int32
    init(_ code: Int32) { self.code = code }

    var symbol: String {
        switch code {
        case EPERM: "EPERM"
        case ESRCH: "ESRCH"
        case EACCES: "EACCES"
        case EINVAL: "EINVAL"
        default: "errno \(code)"
        }
    }

    var description: String { "\(symbol) (\(String(cString: strerror(code))))" }
}
