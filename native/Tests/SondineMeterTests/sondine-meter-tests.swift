import Darwin
import Foundation
import Testing

@testable import sondine_meter

// Unit tests for sondine-meter's math and parsers, plus CLI tests that sample a child `sleep`
// (this user's process: no permission prompt, no audio device).

@Suite struct TimebaseTests {
    @Test func appleSiliconTicksBecomeNanoseconds() {
        let timebase = Timebase(numer: 125, denom: 3)
        #expect(timebase.nanoseconds(fromTicks: 24_000_000) == 1_000_000_000)
        #expect(timebase.nanoseconds(fromTicks: 3) == 125)
        #expect(timebase.nanoseconds(fromTicks: 1) == 41)
        #expect(Timebase.identity.nanoseconds(fromTicks: 12_345) == 12_345)
    }

    @Test func largeTickCountsDoNotOverflow() {
        let timebase = Timebase(numer: 125, denom: 3)
        // About 4.4 years of uptime: ticks * 125 would overflow UInt64.
        let ticks: UInt64 = 3_300_000_000_000_000
        #expect(timebase.nanoseconds(fromTicks: ticks) == 137_500_000_000_000_000)
    }

    @Test func currentTimebaseMatchesTheUptimeClock() {
        let ticks = mach_absolute_time()
        let ns = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
        let converted = Timebase.current.nanoseconds(fromTicks: ticks)
        #expect(converted <= ns && ns - converted < 5_000_000)
    }

    /// The SDK header does not say which unit ri_user_time uses; check it is Mach ticks by
    /// comparing with the process CPU clock (nanoseconds) around a busy loop.
    @Test func rusageCpuTimesAreMachTicks() throws {
        func cpuClock() -> UInt64 { clock_gettime_nsec_np(CLOCK_PROCESS_CPUTIME_ID) }
        let before = try ProcessInspector.rusage(of: getpid()).get()
        let clockBefore = cpuClock()
        var accumulator = 0.0
        while cpuClock() - clockBefore < 200_000_000 { accumulator += sin(accumulator + 1) }
        let after = try ProcessInspector.rusage(of: getpid()).get()
        let clockDelta = Double(cpuClock() - clockBefore)
        let rusageDelta = Double(after.userNs + after.systemNs) - Double(before.userNs + before.systemNs)
        #expect(accumulator.isFinite)
        #expect(abs(rusageDelta / clockDelta - 1) < 0.05, "converted rusage CPU \(rusageDelta) ns vs clock \(clockDelta) ns")
        #expect(after.energyNj > before.energyNj)
    }
}

@Suite struct CpuMathTests {
    @Test func percentFromTickDeltas() throws {
        let timebase = Timebase(numer: 125, denom: 3)
        // 12 M user ticks (0.5 s) + 6 M system ticks (0.25 s) over 1 s of wall time.
        let cpuNs = timebase.nanoseconds(fromTicks: 12_000_000) + timebase.nanoseconds(fromTicks: 6_000_000)
        let percent = try #require(cpuPercent(cpuNanoseconds: Double(cpuNs), wallNanoseconds: 1e9))
        #expect(abs(percent - 75) < 1e-9)
        #expect(cpuPercent(cpuNanoseconds: 1, wallNanoseconds: 0) == nil)
    }

    @Test func meanOverAMeteredRun() throws {
        // 1 % of a core: 10 ms of CPU per second, sampled every second for a minute.
        let points = (0...60).map { CounterPoint(tick: $0, uptimeNs: UInt64($0) * 1_000_000_000, value: UInt64($0) * 10_000_000) }
        let intervals = counterIntervals(points)
        #expect(intervals.count == 60)
        let rate = try #require(meanRatePerSecond([intervals]))
        #expect(abs(rate * 1e-7 - 1) < 1e-9)
    }

    @Test func counterResetStartsANewBaseline() {
        let points = [
            CounterPoint(tick: 0, uptimeNs: 0, value: 100),
            CounterPoint(tick: 1, uptimeNs: 1_000, value: 150),
            CounterPoint(tick: 2, uptimeNs: 2_000, value: 10),
            CounterPoint(tick: 3, uptimeNs: 2_000, value: 20),
            CounterPoint(tick: 4, uptimeNs: 3_000, value: 30),
        ]
        let intervals = counterIntervals(points)
        #expect(intervals.map(\.delta) == [50, 10])
        #expect(intervals.map(\.endTick) == [1, 4])
    }

    @Test func groupMeanSumsMembersOverTheSharedSpan() throws {
        // A runs the full 10 s at 2 units/s; B lives for the last 5 s at 4 units/s.
        let a = counterIntervals((0...10).map { CounterPoint(tick: $0, uptimeNs: UInt64($0) * 1_000_000_000, value: UInt64($0) * 2) })
        let b = counterIntervals((5...10).map { CounterPoint(tick: $0, uptimeNs: UInt64($0) * 1_000_000_000, value: UInt64($0 - 5) * 4) })
        let rate = try #require(meanRatePerSecond([a, b]))
        #expect(abs(rate - 4) < 1e-9) // (20 + 20) / 10 s
        let merged = mergeIntervals([a, b])
        #expect(merged.count == 10)
        #expect(merged.last?.delta == 6)
    }

    @Test func sparseAndDenseMembersSumOnACommonTimeline() throws {
        // Two processes each wake once a second; A is read every second, B every 60 s (top).
        func wakeups(every seconds: Int) -> [CounterInterval] {
            counterIntervals(stride(from: 0, through: 120, by: seconds).map {
                CounterPoint(tick: $0, uptimeNs: UInt64($0) * 1_000_000_000, value: UInt64($0))
            })
        }
        let merged = mergeIntervals([wakeups(every: 1), wakeups(every: 60)])
        #expect(abs(merged.reduce(0) { $0 + $1.delta } - 240) < 1e-6)
        let rates = windowRatesPerSecond(merged, windowNs: 10_000_000_000)
        #expect(rates.count == 12)
        #expect(rates.allSatisfy { abs($0 - 2) < 1e-9 }, "\(rates)")
        #expect(abs(try #require(percentile(rates, 0.95)) - 2) < 1e-9)
    }
}

@Suite struct DistributionTests {
    @Test func percentileInterpolatesBetweenRanks() throws {
        let values = (1...100).map(Double.init)
        #expect(abs(try #require(percentile(values, 0.95)) - 95.05) < 1e-9)
        #expect(percentile([7], 0.95) == 7)
        #expect(percentile([], 0.95) == nil)
        #expect(percentile([3, 1, 2], 0.5) == 2)
    }

    @Test func windowsDropAShortTail() {
        let intervals = (1...25).map { CounterInterval(endTick: $0, startNs: UInt64($0 - 1) * 1_000_000_000, endNs: UInt64($0) * 1_000_000_000, delta: Double($0)) }
        let rates = windowRatesPerSecond(intervals, windowNs: 10_000_000_000)
        // 1…10 (mean 5.5), 11…20 (15.5), 21…25 is 5 s, exactly half a window: kept (23).
        #expect(rates == [5.5, 15.5, 23])
        let shorter = windowRatesPerSecond(Array(intervals.prefix(24)), windowNs: 10_000_000_000)
        #expect(shorter == [5.5, 15.5])
    }
}

@Suite struct SlopeTests {
    private func points(hours: Double, every seconds: Double, _ mib: (Double) -> Double) -> [GaugePoint] {
        stride(from: 0.0, through: hours * 3_600, by: seconds).enumerated().map { index, second in
            GaugePoint(tick: index, uptimeNs: UInt64(second * 1e9), bytes: UInt64((mib(second / 3_600) * 1_048_576).rounded()))
        }
    }

    @Test func linearGrowthGivesItsSlope() throws {
        let slope = try #require(slopeMiBPerHour(points(hours: 1, every: 60) { 30 + 10 * $0 }))
        #expect(abs(slope - 10) < 1e-4)
    }

    @Test func flatFootprintHasNoSlope() throws {
        let slope = try #require(slopeMiBPerHour(points(hours: 1, every: 60) { _ in 42 }))
        #expect(abs(slope) < 1e-9)
    }

    @Test func sawtoothAroundATrendRecoversTheTrend() throws {
        // GC-like ±3 MiB sawtooth over 8 h around +2 MiB/h.
        let slope = try #require(slopeMiBPerHour(points(hours: 8, every: 60) { hour in
            100 + 2 * hour + 3 * (hour * 12).truncatingRemainder(dividingBy: 1) - 1.5
        }))
        #expect(abs(slope - 2) < 0.05)
    }

    @Test func needsTwoDistinctTimes() {
        #expect(slopeMiBPerHour([GaugePoint(tick: 0, uptimeNs: 0, bytes: 1)]) == nil)
        #expect(slopeMiBPerHour([GaugePoint(tick: 0, uptimeNs: 5, bytes: 1), GaugePoint(tick: 1, uptimeNs: 5, bytes: 2)]) == nil)
    }

    @Test func groupFootprintCarriesSparseReadingsAndDropsExitedMembers() {
        let dense = (0...4).map { GaugePoint(tick: $0, uptimeNs: UInt64($0), bytes: 100) }
        let sparse = [GaugePoint(tick: 0, uptimeNs: 0, bytes: 10), GaugePoint(tick: 3, uptimeNs: 3, bytes: 20)]
        let exited = [GaugePoint(tick: 1, uptimeNs: 1, bytes: 1_000), GaugePoint(tick: 2, uptimeNs: 2, bytes: 1_000)]
        let sum = mergeGaugesByTick([dense, sparse, exited]).map(\.bytes)
        #expect(sum == [110, 1_110, 1_110, 120, 100])
    }
}

@Suite struct ParserTests {
    @Test func psTimes() {
        #expect(parsePsTime("207:10.12") == 12_430_120_000_000)
        #expect(parsePsTime("0:00.05") == 50_000_000)
        #expect(parsePsTime("3:16.71") == 196_710_000_000)
        #expect(parsePsTime("1:02:03.50") == 3_723_500_000_000)
        #expect(parsePsTime("2-01:00:00.00") == 176_400_000_000_000)
        #expect(parsePsTime("12") == nil)
        #expect(parsePsTime("a:00.00") == nil)
        #expect(parsePsTime("1:2:3:4.00") == nil)
    }

    @Test func topMemoryAndRows() {
        #expect(parseTopMemory("43457K") == 43_457 * 1_024)
        #expect(parseTopMemory("47M+") == 47 * 1_048_576)
        #expect(parseTopMemory("0B") == 0)
        #expect(parseTopMemory("2G") == 2 << 30)
        #expect(parseTopMemory("12") == nil)
        #expect(parseTopRow("621    15019277+ 42M") == TopRow(pid: 621, idleWakeups: 15_019_277, footprintBytes: 42 << 20))
        #expect(parseTopRow("PID    IDLEW    MEM") == nil)
        #expect(parseTopRow("Processes: 1011 total, 4 running") == nil)
    }

    @Test func processArguments() throws {
        var bytes: [UInt8] = []
        withUnsafeBytes(of: Int32(2).littleEndian) { bytes += $0 }
        bytes += Array("/Applications/Sondine.app/Contents/MacOS/Sondine Helper".utf8) + [0, 0, 0]
        bytes += Array("Sondine Helper".utf8) + [0]
        bytes += Array("--type=utility".utf8) + [0]
        bytes += Array("ENV=1".utf8) + [0]
        let arguments = try #require(parseProcessArguments(bytes[...]))
        #expect(arguments == ["Sondine Helper", "--type=utility"])
        #expect(parseProcessArguments([1, 0][...]) == nil)
    }

    @Test func sampleOptions() throws {
        let options = try parseSampleOptions(["--pids", "12, 34", "--duration-s", "5", "--interval-ms", "250", "--no-coreaudiod"])
        #expect(options.pids == [12, 34])
        #expect(options.durationS == 5)
        #expect(options.intervalMs == 250)
        #expect(!options.includeCoreaudiod)
        #expect(options.privilegedIntervalS == 60)
        #expect(throws: UsageError.self) { try parseSampleOptions([]) }
        #expect(throws: UsageError.self) { try parseSampleOptions(["--pids", "x"]) }
        #expect(throws: UsageError.self) { try parseSampleOptions(["--match", "a", "--interval-ms", "0"]) }
        #expect(throws: UsageError.self) { try parseSampleOptions(["--match", "a", "--match", "b"]) }
    }

    @Test func summaryOptions() throws {
        let options = try parseSummaryOptions(["--in", "a.jsonl", "--group", "core=1,2", "--group", "audio=3", "--window-s", "5"])
        #expect(options.groups == [.init(label: "core", pids: [1, 2]), .init(label: "audio", pids: [3])])
        #expect(options.windowS == 5)
        #expect(throws: UsageError.self) { try parseSummaryOptions(["--in", "a", "--group", "=1"]) }
        #expect(throws: UsageError.self) { try parseSummaryOptions(["--in", "a", "--group", "x=1", "--group", "x=2"]) }
        #expect(throws: UsageError.self) { try parseSummaryOptions(["--group", "x=1"]) }
    }
}

/// Builds a synthetic sample file: one rusage process at 1 % CPU, 20 interrupt wakeups/s,
/// 5 mW and +12 MiB/h; one setuid-tools process at 0.5 % CPU with sparse top readings.
private func syntheticRun(seconds: Int = 600, tornTail: Bool = false) throws -> [Substring] {
    func ns(_ second: Int) -> UInt64 { 1_000_000_000_000 + UInt64(second) * 1_000_000_000 }
    var lines: [Data] = []
    lines.append(try JSONLines.encode(MetaRecord(startedAt: "2026-11-03T06:00:00.000Z", intervalMs: 1_000, privilegedIntervalS: 60, timebase: Timebase(numer: 125, denom: 3), meterPid: 1)))
    lines.append(try JSONLines.encode(ProcessRecord(tick: 0, at: "t", pid: 10, ppid: 1, uid: 501, startUs: 5, name: "sondine-audio", path: "/x/sondine-audio", access: .rusage)))
    lines.append(try JSONLines.encode(ProcessRecord(tick: 0, at: "t", pid: 621, ppid: 1, uid: 202, startUs: 6, name: "coreaudiod", path: "/usr/sbin/coreaudiod", access: .setuidTools, error: "EPERM")))
    for second in 0...seconds {
        let clock = ClockReading(uptimeNs: ns(second), continuousNs: ns(second) + (second >= 300 ? 60_000_000_000 : 0), wallNs: 0)
        var audio = SampleRecord(tick: second, at: "t", clock: clock, pid: 10, source: .rusage)
        audio.cpuNs = UInt64(second) * 10_000_000
        audio.interruptWakeups = UInt64(second) * 20
        audio.idleWakeups = UInt64(second) * 5
        audio.energyNj = UInt64(second) * 5_000_000
        audio.pEnergyNj = UInt64(second) * 1_000_000
        audio.footprintBytes = 30 * 1_048_576 + UInt64(second) * 12 * 1_048_576 / 3_600
        audio.lifetimeMaxFootprintBytes = 40 * 1_048_576
        audio.qosNs = QosTimes(default: 0, maintenance: 0, background: 0, utility: UInt64(second) * 10_000_000, legacy: 0, userInitiated: 0, userInteractive: 0)
        lines.append(try JSONLines.encode(audio))
        var daemon = SampleRecord(tick: second, at: "t", clock: clock, pid: 621, source: .setuidTools)
        daemon.cpuNs = 1_000_000_000_000 + UInt64(second) * 5_000_000
        if second % 60 == 2 {
            daemon.idleWakeups = 1_000 + UInt64(second) * 30
            daemon.footprintBytes = 44 << 20
        }
        lines.append(try JSONLines.encode(daemon))
    }
    lines.append(try JSONLines.encode(EndRecord(ticks: seconds + 1, at: "t", uptimeNs: ns(seconds), continuousNs: ns(seconds), reason: "duration", meter: MeterOverhead(cpuNs: 1, childrenCpuNs: 2))))
    var text = lines.map { String(decoding: $0, as: UTF8.self) }.joined()
    if tornTail { text += #"{"at":"t","cpuNs":12"# }
    return text.split(separator: "\n", omittingEmptySubsequences: false)
}

@Suite struct SummarizeTests {
    @Test func perProcessStatistics() throws {
        let summary = try Summarizer.summarize(lines: try syntheticRun(), options: SummaryOptions(input: "x"))
        #expect(summary.input.durationS == 600)
        #expect(abs(summary.input.sleptS - 60) < 1e-9)
        #expect(summary.input.endReason == "duration")
        let audio = try #require(summary.processes.first { $0.pid == 10 }).stats
        #expect(abs(try #require(audio.cpu.meanPercent) - 1) < 1e-9)
        #expect(abs(try #require(audio.cpu.p95Percent) - 1) < 1e-9)
        #expect(abs(try #require(audio.cpu.qosSeconds?["utility"]) - 6) < 1e-9)
        #expect(abs(try #require(audio.wakeups.interruptPerS) - 20) < 1e-9)
        #expect(abs(try #require(audio.wakeups.idlePerS) - 5) < 1e-9)
        #expect(abs(try #require(audio.energy.milliwatts) - 5) < 1e-9)
        #expect(abs(try #require(audio.energy.joulesPerHour) - 18) < 1e-9)
        #expect(abs(try #require(audio.energy.joules) - 3) < 1e-9)
        #expect(abs(try #require(audio.footprint.slopeMiBPerHour) - 12) < 0.01)
        #expect(audio.footprint.maxBytes == 32 * 1_048_576)
        #expect(audio.footprint.lifetimeMaxBytes == 40 * 1_048_576)

        let daemon = try #require(summary.processes.first { $0.pid == 621 })
        #expect(daemon.access == .setuidTools)
        #expect(abs(try #require(daemon.stats.cpu.meanPercent) - 0.5) < 1e-9)
        // Idle wakeups from readings at 2 s, 62 s, …, 542 s: 30/s.
        #expect(abs(try #require(daemon.stats.wakeups.idlePerS) - 30) < 1e-9)
        #expect(daemon.stats.wakeups.interruptPerS == nil)
        #expect(daemon.stats.energy.milliwatts == nil)
        #expect(daemon.stats.footprint.maxBytes == 44 << 20)
    }

    @Test func groupsAndTotal() throws {
        var options = SummaryOptions(input: "x")
        options.groups = [.init(label: "sondine", pids: [10]), .init(label: "missing", pids: [999])]
        let summary = try Summarizer.summarize(lines: try syntheticRun(), options: options)
        let group = try #require(summary.groups.first { $0.label == "sondine" }).stats
        #expect(abs(try #require(group.cpu.meanPercent) - 1) < 1e-9)
        #expect(abs(try #require(summary.total.cpu.meanPercent) - 1.5) < 1e-9)
        #expect(summary.warnings.contains { $0.contains("pid 999") })
    }

    @Test func skipDropsTheSettlingPeriod() throws {
        var options = SummaryOptions(input: "x")
        options.skipS = 100
        let summary = try Summarizer.summarize(lines: try syntheticRun(), options: options)
        #expect(summary.input.durationS == 500)
        let audio = try #require(summary.processes.first { $0.pid == 10 }).stats
        #expect(audio.footprint.maxBytes == 32 * 1_048_576)
        #expect(abs(try #require(audio.cpu.seconds) - 5) < 1e-9)
    }

    @Test func tornLastLineIsIgnored() throws {
        let summary = try Summarizer.summarize(lines: try syntheticRun(seconds: 20, tornTail: true), options: SummaryOptions(input: "x"))
        #expect(summary.warnings.contains("ignored a torn last line"))
    }

    @Test func rejectsFilesThatAreNotMeterOutput() {
        #expect(throws: SummaryError.self) {
            try Summarizer.summarize(lines: [#"{"type":"sample","pid":1}"#, ""], options: SummaryOptions(input: "x"))
        }
        #expect(throws: SummaryError.self) {
            try Summarizer.summarize(lines: ["not json", "{}"], options: SummaryOptions(input: "x"))
        }
    }
}

/// Runs the built executable: next to the test bundle, else in the package's .build/debug.
private enum MeterBinary {
    static var url: URL? {
        let package = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bundle = Bundle.allBundles.first { $0.bundleURL.pathExtension == "xctest" }
        let candidates = [bundle?.bundleURL.deletingLastPathComponent(), package.appending(path: ".build/debug")]
        return candidates.compactMap { $0?.appending(path: "sondine-meter") }
            .first { FileManager.default.isExecutableFile(atPath: $0.path(percentEncoded: false)) }
    }

    struct Missing: Error {}

    static func run(_ arguments: [String]) throws -> (status: Int32, stdout: String, stderr: String) {
        guard let executable = url else { throw Missing() }
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        try process.run()
        let stdout = out.fileHandleForReading.readDataToEndOfFile()
        let stderr = err.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: stdout, as: UTF8.self), String(decoding: stderr, as: UTF8.self))
    }
}

@Suite(.serialized) struct CommandLineTests {
    @Test(.enabled(if: MeterBinary.url != nil)) func samplesAChildAndSummarizesIt() throws {
        let sleeper = Process()
        sleeper.executableURL = URL(filePath: "/bin/sleep")
        sleeper.arguments = ["10"]
        try sleeper.run()
        defer { sleeper.terminate() }
        let directory = FileManager.default.temporaryDirectory.appending(path: "sondine-meter-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let samples = directory.appending(path: "samples.jsonl").path(percentEncoded: false)
        let summaryPath = directory.appending(path: "summary.json").path(percentEncoded: false)

        let sampled = try MeterBinary.run([
            "sample", "--pids", String(sleeper.processIdentifier), "--no-coreaudiod", "--interval-ms", "200", "--duration-s", "1", "--out", samples,
        ])
        #expect(sampled.status == 0, "\(sampled.stderr)")
        let lines = try String(contentsOfFile: samples, encoding: .utf8).split(separator: "\n")
        let kinds = try lines.map { try JSONDecoder().decode(RecordKind.self, from: Data($0.utf8)).type }
        #expect(kinds.first == "meta")
        #expect(kinds.last == "end")
        #expect(kinds.filter { $0 == "sample" }.count == 6)
        let process = try JSONDecoder().decode(ProcessRecord.self, from: Data(try #require(lines.first { $0.contains(#""type":"process""#) }).utf8))
        #expect(process.access == .rusage)
        #expect(process.name == "sleep")

        let summarized = try MeterBinary.run(["summarize", "--in", samples, "--out", summaryPath, "--group", "child=\(sleeper.processIdentifier)"])
        #expect(summarized.status == 0, "\(summarized.stderr)")
        let summary = try JSONDecoder().decode(MeterSummary.self, from: Data(contentsOf: URL(filePath: summaryPath)))
        let stats = try #require(summary.processes.first).stats
        #expect(abs(summary.input.durationS - 1) < 0.1)
        #expect(try #require(stats.cpu.meanPercent) < 5)
        #expect(try #require(stats.footprint.maxBytes) > 0)
        #expect(stats.energy.milliwatts != nil)
        #expect(summary.groups.first?.label == "child")
    }

    @Test(.enabled(if: MeterBinary.url != nil)) func usageErrorsExitWith64() throws {
        #expect(try MeterBinary.run([]).status == 64)
        #expect(try MeterBinary.run(["sample"]).status == 64)
        #expect(try MeterBinary.run(["sample", "--match", "("]).status == 64)
        #expect(try MeterBinary.run(["frobnicate"]).status == 64)
        #expect(try MeterBinary.run(["summarize", "--in", "/nonexistent.jsonl"]).status == 1)
    }

    @Test(.enabled(if: MeterBinary.url != nil)) func listFindsThisTestRunner() throws {
        let result = try MeterBinary.run(["list", "--match", "^\(ProcessInspector.name(of: getpid()) ?? "x")$", "--arguments"])
        #expect(result.status == 0)
        let listed = try result.stdout.split(separator: "\n").map { try JSONDecoder().decode(ListedProcess.self, from: Data($0.utf8)) }
        let me = try #require(listed.first { $0.pid == getpid() })
        #expect(me.access == .rusage)
        #expect(me.arguments?.isEmpty == false)
    }
}
