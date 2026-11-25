import Darwin
import Foundation

// `sondine-meter sample` writes JSON lines, one record per line, keys sorted:
//   meta (first), process (when a pid is first seen), sample (each pid each tick),
//   exit, warning, end (last; absent if the meter was killed).
// Counters are cumulative since the process started; `summarize` turns them into rates.
// A field is absent when the source cannot read it (for instance energy for coreaudiod).

enum MeterFormat {
    static let schema = "sondine.meter"
    static let version = 1
    static let meterVersion = "0.1.0"
}

/// How a pid is read: proc_pid_rusage (this user's processes), the setuid `ps` and `top`
/// fallback (other users' processes such as coreaudiod), or not at all.
enum Access: String, Codable, Sendable {
    case rusage
    case setuidTools = "setuid-tools"
    case denied
}

struct QosTimes: Codable, Equatable, Sendable {
    var `default`: UInt64
    var maintenance: UInt64
    var background: UInt64
    var utility: UInt64
    var legacy: UInt64
    var userInitiated: UInt64
    var userInteractive: UInt64

    static let zero = QosTimes(default: 0, maintenance: 0, background: 0, utility: 0, legacy: 0, userInitiated: 0, userInteractive: 0)

    static let names = ["default", "maintenance", "background", "utility", "legacy", "userInitiated", "userInteractive"]

    /// Same order as `names`.
    var values: [UInt64] { [self.default, maintenance, background, utility, legacy, userInitiated, userInteractive] }
}

struct RecordKind: Decodable {
    var type: String
}

struct MetaRecord: Codable, Equatable {
    var type = "meta"
    var schema = MeterFormat.schema
    var version = MeterFormat.version
    var meterVersion = MeterFormat.meterVersion
    var startedAt: String
    var intervalMs: Int
    var privilegedIntervalS: Int
    var timebase: Timebase
    var meterPid: Int32
}

struct ProcessRecord: Codable, Equatable {
    var type = "process"
    var tick: Int
    var at: String
    var pid: Int32
    var ppid: Int32
    var uid: UInt32
    var startUs: UInt64
    var name: String
    var path: String?
    var access: Access
    var error: String?
}

struct SampleRecord: Codable, Equatable {
    var type = "sample"
    var tick: Int
    var at: String
    var uptimeNs: UInt64
    var continuousNs: UInt64
    var pid: Int32
    var source: Access
    var cpuNs: UInt64?
    var userNs: UInt64?
    var systemNs: UInt64?
    var interruptWakeups: UInt64?
    var idleWakeups: UInt64?
    var footprintBytes: UInt64?
    var lifetimeMaxFootprintBytes: UInt64?
    var energyNj: UInt64?
    var pEnergyNj: UInt64?
    var neuralFootprintBytes: UInt64?
    var lifetimeMaxNeuralFootprintBytes: UInt64?
    var graphicsFootprintBytes: UInt64?
    var instructions: UInt64?
    var cycles: UInt64?
    var diskReadBytes: UInt64?
    var diskWrittenBytes: UInt64?
    var logicalWrites: UInt64?
    var runnableNs: UInt64?
    var qosNs: QosTimes?

    init(tick: Int, at: String, clock: ClockReading, pid: Int32, source: Access) {
        self.tick = tick
        self.at = at
        uptimeNs = clock.uptimeNs
        continuousNs = clock.continuousNs
        self.pid = pid
        self.source = source
    }

    init(tick: Int, at: String, clock: ClockReading, pid: Int32, rusage reading: RusageReading, graphicsFootprintBytes: UInt64?) {
        self.init(tick: tick, at: at, clock: clock, pid: pid, source: .rusage)
        cpuNs = reading.userNs + reading.systemNs
        userNs = reading.userNs
        systemNs = reading.systemNs
        interruptWakeups = reading.interruptWakeups
        idleWakeups = reading.idleWakeups
        footprintBytes = reading.footprintBytes
        lifetimeMaxFootprintBytes = reading.lifetimeMaxFootprintBytes
        energyNj = reading.energyNj
        pEnergyNj = reading.pEnergyNj
        neuralFootprintBytes = reading.neuralFootprintBytes
        lifetimeMaxNeuralFootprintBytes = reading.lifetimeMaxNeuralFootprintBytes
        self.graphicsFootprintBytes = graphicsFootprintBytes
        instructions = reading.instructions
        cycles = reading.cycles
        diskReadBytes = reading.diskReadBytes
        diskWrittenBytes = reading.diskWrittenBytes
        logicalWrites = reading.logicalWrites
        runnableNs = reading.runnableNs
        qosNs = reading.qos
    }
}

struct ExitRecord: Codable, Equatable {
    var type = "exit"
    var tick: Int
    var at: String
    var pid: Int32
    /// `exited`, or `reused` when the pid now belongs to another process.
    var reason: String
}

struct WarningRecord: Codable, Equatable {
    var type = "warning"
    var tick: Int
    var at: String
    var pid: Int32?
    var message: String
}

/// The meter's own cost, children (ps, top) included, so a reader can judge the perturbation.
struct MeterOverhead: Codable, Equatable {
    var cpuNs: UInt64
    var childrenCpuNs: UInt64
    var interruptWakeups: UInt64?
    var idleWakeups: UInt64?
    var energyNj: UInt64?
    var lifetimeMaxFootprintBytes: UInt64?
}

struct EndRecord: Codable, Equatable {
    var type = "end"
    var ticks: Int
    var at: String
    var uptimeNs: UInt64
    var continuousNs: UInt64
    /// `duration` or `signal`.
    var reason: String
    var meter: MeterOverhead
}

/// One line of `sondine-meter list`.
struct ListedProcess: Codable, Equatable {
    var pid: Int32
    var ppid: Int32
    var uid: UInt32
    var startUs: UInt64
    var name: String
    var path: String?
    var access: Access
    var arguments: [String]?
}

enum JSONLines {
    static func encode(_ value: some Encodable) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(value)
        data.append(0x0A)
        return data
    }
}

/// Appends whole lines with one write(2) per batch, so a reader never sees half a tick.
final class LineWriter {
    private let descriptor: Int32
    private let ownsDescriptor: Bool
    private(set) var failed = false

    init(path: String?) throws {
        if let path, path != "-" {
            let descriptor = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0o644)
            guard descriptor >= 0 else { throw Errno(errno) }
            self.descriptor = descriptor
            ownsDescriptor = true
        } else {
            descriptor = STDOUT_FILENO
            ownsDescriptor = false
        }
    }

    deinit {
        if ownsDescriptor { close(descriptor) }
    }

    func write(_ lines: [Data]) {
        guard !lines.isEmpty, !failed else { return }
        var batch = Data()
        for line in lines { batch.append(line) }
        batch.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let written = Darwin.write(descriptor, raw.baseAddress! + offset, raw.count - offset)
                if written < 0 {
                    if errno == EINTR { continue }
                    failed = true
                    return
                }
                offset += written
            }
        }
    }
}
