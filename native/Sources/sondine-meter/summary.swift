import Foundation

// `sondine-meter summarize` output (schema sondine.meter-summary, version 1). Rates use awake
// time (uptime). CPU is in percent of one core. A field is absent when no sample carried it.

struct SummaryOptions: Equatable {
    struct Group: Equatable {
        var label: String
        var pids: [Int32]
    }

    var input: String = ""
    var output: String?
    var groups: [Group] = []
    var windowS: Double = 10
    var skipS: Double = 0
}

struct MeterSummary: Codable, Equatable {
    var schema = "sondine.meter-summary"
    var version = 1
    var input: InputInfo
    var windowS: Double
    var skipS: Double
    var processes: [ProcessSummary]
    var groups: [GroupSummary]
    var total: Stats
    var warnings: [String]

    struct InputInfo: Codable, Equatable {
        var records: Int
        var intervalMs: Int
        var startedAt: String
        var ticks: Int
        var durationS: Double
        var sleptS: Double
        var endReason: String?
        var meter: MeterOverhead?
    }

    struct ProcessSummary: Codable, Equatable {
        var pid: Int32
        var startUs: UInt64
        var name: String
        var path: String?
        var access: Access
        var exited: Bool
        var stats: Stats
    }

    struct GroupSummary: Codable, Equatable {
        var label: String
        var pids: [Int32]
        var stats: Stats
    }

    struct Stats: Codable, Equatable {
        var samples: Int
        var coveredS: Double
        var cpu: Cpu
        var wakeups: Wakeups
        var footprint: Footprint
        var energy: Energy
        var neuralFootprintMaxBytes: UInt64?
        var graphicsFootprintMaxBytes: UInt64?
        var disk: Disk
    }

    struct Cpu: Codable, Equatable {
        var meanPercent: Double?
        var p95Percent: Double?
        var maxPercent: Double?
        var seconds: Double?
        var qosSeconds: [String: Double]?
    }

    struct Wakeups: Codable, Equatable {
        var interruptPerS: Double?
        var interruptP95PerS: Double?
        var idlePerS: Double?
        var idleP95PerS: Double?
    }

    struct Footprint: Codable, Equatable {
        var maxBytes: UInt64?
        var meanBytes: Double?
        var lastBytes: UInt64?
        var lifetimeMaxBytes: UInt64?
        var slopeMiBPerHour: Double?
    }

    struct Energy: Codable, Equatable {
        var joules: Double?
        var joulesPerHour: Double?
        var milliwatts: Double?
        var pCoreJoules: Double?
    }

    struct Disk: Codable, Equatable {
        var readBytes: Double?
        var writtenBytes: Double?
        var logicalWrites: Double?
    }
}

struct SummaryError: Error, CustomStringConvertible {
    var description: String
}

/// One process incarnation's readings, split per metric so sparse sources (top every 60 s)
/// and dense ones (rusage every tick) each produce their own intervals.
struct ProcessSeries {
    var cpu: [CounterPoint] = []
    var interruptWakeups: [CounterPoint] = []
    var idleWakeups: [CounterPoint] = []
    var energy: [CounterPoint] = []
    var pEnergy: [CounterPoint] = []
    var diskRead: [CounterPoint] = []
    var diskWritten: [CounterPoint] = []
    var logicalWrites: [CounterPoint] = []
    var qos: [String: [CounterPoint]] = [:]
    var footprint: [GaugePoint] = []
    var lifetimeMaxFootprint: UInt64?
    var neuralMax: UInt64?
    var graphicsMax: UInt64?
    var samples = 0

    mutating func add(_ sample: SampleRecord) {
        samples += 1
        func point(_ value: UInt64?) -> CounterPoint? {
            value.map { CounterPoint(tick: sample.tick, uptimeNs: sample.uptimeNs, value: $0) }
        }
        if let p = point(sample.cpuNs) { cpu.append(p) }
        if let p = point(sample.interruptWakeups) { interruptWakeups.append(p) }
        if let p = point(sample.idleWakeups) { idleWakeups.append(p) }
        if let p = point(sample.energyNj) { energy.append(p) }
        if let p = point(sample.pEnergyNj) { pEnergy.append(p) }
        if let p = point(sample.diskReadBytes) { diskRead.append(p) }
        if let p = point(sample.diskWrittenBytes) { diskWritten.append(p) }
        if let p = point(sample.logicalWrites) { logicalWrites.append(p) }
        if let times = sample.qosNs {
            for (name, value) in zip(QosTimes.names, times.values) {
                qos[name, default: []].append(CounterPoint(tick: sample.tick, uptimeNs: sample.uptimeNs, value: value))
            }
        }
        if let bytes = sample.footprintBytes {
            footprint.append(GaugePoint(tick: sample.tick, uptimeNs: sample.uptimeNs, bytes: bytes))
        }
        if let value = sample.lifetimeMaxFootprintBytes { lifetimeMaxFootprint = max(lifetimeMaxFootprint ?? 0, value) }
        if let value = sample.neuralFootprintBytes { neuralMax = max(neuralMax ?? 0, value) }
        if let value = sample.graphicsFootprintBytes { graphicsMax = max(graphicsMax ?? 0, value) }
    }
}

enum Summarizer {
    static func summarize(lines: [Substring], options: SummaryOptions) throws -> MeterSummary {
        let decoder = JSONDecoder()
        var meta: MetaRecord?
        var end: EndRecord?
        var warnings: [String] = []
        var records = 0

        struct Incarnation {
            var record: ProcessRecord
            var series = ProcessSeries()
            var exited = false
        }
        var incarnations: [Incarnation] = []
        var current: [Int32: Int] = [:]
        var samples: [(index: Int, sample: SampleRecord)] = []

        for (number, text) in lines.enumerated() where !text.allSatisfy(\.isWhitespace) {
            let data = Data(text.utf8)
            let kind: RecordKind
            do {
                kind = try decoder.decode(RecordKind.self, from: data)
            } catch {
                // The meter may have been killed mid-line; only the last line may be torn.
                if number == lines.count - 1 {
                    warnings.append("ignored a torn last line")
                    continue
                }
                throw SummaryError(description: "line \(number + 1): not a meter record")
            }
            records += 1
            do {
                switch kind.type {
                case "meta":
                    meta = try decoder.decode(MetaRecord.self, from: data)
                case "process":
                    let record = try decoder.decode(ProcessRecord.self, from: data)
                    current[record.pid] = incarnations.count
                    incarnations.append(Incarnation(record: record))
                    if record.access == .denied {
                        warnings.append("pid \(record.pid) (\(record.name)) could not be read: \(record.error ?? "denied")")
                    }
                case "sample":
                    let sample = try decoder.decode(SampleRecord.self, from: data)
                    guard let index = current[sample.pid] else {
                        throw SummaryError(description: "line \(number + 1): sample for pid \(sample.pid) before its process record")
                    }
                    samples.append((index, sample))
                case "exit":
                    let record = try decoder.decode(ExitRecord.self, from: data)
                    if let index = current[record.pid] { incarnations[index].exited = true }
                    current[record.pid] = nil
                case "warning":
                    let record = try decoder.decode(WarningRecord.self, from: data)
                    warnings.append(record.pid.map { "pid \($0): \(record.message)" } ?? record.message)
                case "end":
                    end = try decoder.decode(EndRecord.self, from: data)
                default:
                    warnings.append("line \(number + 1): unknown record type \(kind.type)")
                }
            } catch let error as SummaryError {
                throw error
            } catch {
                throw SummaryError(description: "line \(number + 1): invalid \(kind.type) record: \(error)")
            }
        }
        guard let meta else { throw SummaryError(description: "no meta record: not a sondine-meter file") }
        guard meta.schema == MeterFormat.schema, meta.version == MeterFormat.version else {
            throw SummaryError(description: "unsupported meter file \(meta.schema) v\(meta.version)")
        }
        if end == nil { warnings.append("no end record: the meter stopped early") }

        let firstUptime = samples.map(\.sample.uptimeNs).min() ?? 0
        let skipNs = UInt64(max(0, options.skipS) * 1e9)
        let kept = samples.filter { $0.sample.uptimeNs >= firstUptime + skipNs }
        for (index, sample) in kept { incarnations[index].series.add(sample) }

        let first = kept.min { $0.sample.uptimeNs < $1.sample.uptimeNs }?.sample
        let last = kept.max { $0.sample.uptimeNs < $1.sample.uptimeNs }?.sample
        var durationS = 0.0
        var sleptS = 0.0
        if let first, let last {
            durationS = Double(last.uptimeNs - first.uptimeNs) / 1e9
            let awake = Double(last.uptimeNs - first.uptimeNs)
            let elapsed = Double(last.continuousNs) - Double(first.continuousNs)
            sleptS = max(0, (elapsed - awake) / 1e9)
        }
        let windowNs = UInt64(max(0.001, options.windowS) * 1e9)

        let processes = incarnations.map { incarnation in
            MeterSummary.ProcessSummary(
                pid: incarnation.record.pid,
                startUs: incarnation.record.startUs,
                name: incarnation.record.name,
                path: incarnation.record.path,
                access: incarnation.record.access,
                exited: incarnation.exited,
                stats: stats(of: [incarnation.series], windowNs: windowNs)
            )
        }
        let groups = options.groups.map { group in
            let members = incarnations.filter { group.pids.contains($0.record.pid) }.map(\.series)
            for pid in group.pids where !incarnations.contains(where: { $0.record.pid == pid }) {
                warnings.append("group \(group.label): pid \(pid) is not in the file")
            }
            return MeterSummary.GroupSummary(label: group.label, pids: group.pids, stats: stats(of: members, windowNs: windowNs))
        }

        return MeterSummary(
            input: MeterSummary.InputInfo(
                records: records,
                intervalMs: meta.intervalMs,
                startedAt: meta.startedAt,
                ticks: end?.ticks ?? (samples.map(\.sample.tick).max().map { $0 + 1 } ?? 0),
                durationS: durationS,
                sleptS: sleptS,
                endReason: end?.reason,
                meter: end?.meter
            ),
            windowS: options.windowS,
            skipS: options.skipS,
            processes: processes,
            groups: groups,
            total: stats(of: incarnations.map(\.series), windowNs: windowNs),
            warnings: warnings
        )
    }

    /// Stats for one process, or the sum of several (a group or the total).
    static func stats(of members: [ProcessSeries], windowNs: UInt64) -> MeterSummary.Stats {
        func intervals(_ metric: KeyPath<ProcessSeries, [CounterPoint]>) -> [[CounterInterval]] {
            members.map { counterIntervals($0[keyPath: metric]) }.filter { !$0.isEmpty }
        }
        func total(_ perMember: [[CounterInterval]]) -> Double? {
            perMember.isEmpty ? nil : perMember.joined().reduce(0) { $0 + $1.delta }
        }
        func p95(_ perMember: [[CounterInterval]]) -> Double? {
            percentile(windowRatesPerSecond(mergeIntervals(perMember), windowNs: windowNs), 0.95)
        }
        func maximum(_ perMember: [[CounterInterval]]) -> Double? {
            windowRatesPerSecond(mergeIntervals(perMember), windowNs: windowNs).max()
        }

        let cpu = intervals(\.cpu)
        let interrupt = intervals(\.interruptWakeups)
        let idle = intervals(\.idleWakeups)
        let energy = intervals(\.energy)
        let pEnergy = intervals(\.pEnergy)
        let nsToPercent = 1e-7 // ns of CPU per second → percent of one core

        var qosSeconds: [String: Double] = [:]
        for name in QosTimes.names {
            let perMember = members.compactMap { $0.qos[name] }.map(counterIntervals).filter { !$0.isEmpty }
            if let ns = total(perMember) { qosSeconds[name] = ns / 1e9 }
        }

        let footprint = mergeGaugesByTick(members.map(\.footprint).filter { !$0.isEmpty })
        let energyRate = meanRatePerSecond(energy)
        let allPoints = members.flatMap { [$0.cpu, $0.interruptWakeups, $0.idleWakeups, $0.energy].joined() }.map(\.uptimeNs)
            + members.flatMap(\.footprint).map(\.uptimeNs)
        let covered = (allPoints.max() ?? 0) - (allPoints.min() ?? 0)

        return MeterSummary.Stats(
            samples: members.reduce(0) { $0 + $1.samples },
            coveredS: Double(covered) / 1e9,
            cpu: MeterSummary.Cpu(
                meanPercent: meanRatePerSecond(cpu).map { $0 * nsToPercent },
                p95Percent: p95(cpu).map { $0 * nsToPercent },
                maxPercent: maximum(cpu).map { $0 * nsToPercent },
                seconds: total(cpu).map { $0 / 1e9 },
                qosSeconds: qosSeconds.isEmpty ? nil : qosSeconds
            ),
            wakeups: MeterSummary.Wakeups(
                interruptPerS: meanRatePerSecond(interrupt),
                interruptP95PerS: p95(interrupt),
                idlePerS: meanRatePerSecond(idle),
                idleP95PerS: p95(idle)
            ),
            footprint: MeterSummary.Footprint(
                maxBytes: footprint.map(\.bytes).max(),
                meanBytes: footprint.isEmpty ? nil : footprint.reduce(0) { $0 + Double($1.bytes) } / Double(footprint.count),
                lastBytes: footprint.last?.bytes,
                lifetimeMaxBytes: members.count == 1 ? members.first?.lifetimeMaxFootprint : nil,
                slopeMiBPerHour: slopeMiBPerHour(footprint)
            ),
            energy: MeterSummary.Energy(
                joules: total(energy).map { $0 / 1e9 },
                joulesPerHour: energyRate.map { $0 * 3_600 / 1e9 },
                milliwatts: energyRate.map { $0 / 1e6 },
                pCoreJoules: total(pEnergy).map { $0 / 1e9 }
            ),
            neuralFootprintMaxBytes: members.compactMap(\.neuralMax).max(),
            graphicsFootprintMaxBytes: members.compactMap(\.graphicsMax).max(),
            disk: MeterSummary.Disk(
                readBytes: total(intervals(\.diskRead)),
                writtenBytes: total(intervals(\.diskWritten)),
                logicalWrites: total(intervals(\.logicalWrites))
            )
        )
    }

    static func run(_ options: SummaryOptions) -> Int32 {
        do {
            let text = try String(contentsOfFile: options.input, encoding: .utf8)
            let summary = try summarize(lines: text.split(separator: "\n", omittingEmptySubsequences: false), options: options)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            var data = try encoder.encode(summary)
            data.append(0x0A)
            if let output = options.output, output != "-" {
                try data.write(to: URL(filePath: output), options: .atomic)
            } else {
                FileHandle.standardOutput.write(data)
            }
            return ExitCode.success
        } catch {
            fputs("sondine-meter summarize: \(error)\n", stderr)
            return ExitCode.failure
        }
    }
}
