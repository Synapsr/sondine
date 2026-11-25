import Darwin
import Dispatch
import Foundation
import Synchronization

struct SampleOptions: Equatable {
    var pids: [Int32] = []
    var matchPattern: String?
    var includeCoreaudiod = true
    var intervalMs = 1_000
    /// nil samples until SIGINT or SIGTERM.
    var durationS: Double?
    var output: String?
    var privilegedIntervalS = 60
    var rediscoverS = 10
    var fallback = true
}

/// Set from signal handlers; the semaphore cuts the sleep short.
final class StopRequest: Sendable {
    let requested = Atomic<Bool>(false)
    let wake = DispatchSemaphore(value: 0)

    func request() {
        requested.store(true, ordering: .relaxed)
        wake.signal()
    }

    var isRequested: Bool { requested.load(ordering: .relaxed) }
}

/// Matches a process when the pattern is found in its name, executable name, or path.
struct ProcessMatcher {
    let regex: Regex<AnyRegexOutput>

    init(pattern: String) throws {
        regex = try Regex(pattern)
    }

    func matches(_ identity: ProcessIdentity) -> Bool {
        let candidates = [identity.name, identity.executableName, identity.path ?? ""]
        return candidates.contains { !$0.isEmpty && $0.contains(regex) }
    }
}

enum Sampler {
    struct Target {
        var identity: ProcessIdentity
        var access: Access
        var startAbstime: UInt64?
        var warned = false
    }

    static func run(_ options: SampleOptions) -> Int32 {
        let matcher: ProcessMatcher?
        do {
            matcher = try options.matchPattern.map(ProcessMatcher.init(pattern:))
        } catch {
            fputs("sondine-meter sample: invalid --match pattern: \(error)\n", stderr)
            return ExitCode.usage
        }
        let writer: LineWriter
        do {
            writer = try LineWriter(path: options.output)
        } catch {
            fputs("sondine-meter sample: cannot open \(options.output ?? "-"): \(error)\n", stderr)
            return ExitCode.failure
        }

        let stop = StopRequest()
        signal(SIGPIPE, SIG_IGN)
        var signalSources: [any DispatchSourceSignal] = []
        for signalNumber in [SIGINT, SIGTERM] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .global(qos: .utility))
            source.setEventHandler { stop.request() }
            source.resume()
            signalSources.append(source)
        }
        defer { signalSources.forEach { $0.cancel() } }

        let meterPid = getpid()
        let started = ClockReading.now()
        emit(writer, [
            line(
                MetaRecord(
                    startedAt: started.iso8601,
                    intervalMs: options.intervalMs,
                    privilegedIntervalS: options.privilegedIntervalS,
                    timebase: .current,
                    meterPid: meterPid
                )
            ),
        ])

        var targets: [Int32: Target] = [:]
        var pendingLines: [Data] = []

        func add(_ identity: ProcessIdentity, tick: Int, at: String) {
            guard identity.pid != meterPid, identity.ppid != meterPid, targets[identity.pid] == nil else { return }
            var access = Access.rusage
            var error: String?
            var startAbstime: UInt64?
            switch ProcessInspector.rusage(of: identity.pid) {
            case .success(let reading):
                startAbstime = reading.startAbstime
            case .failure(let failure):
                if failure.code == ESRCH { return }
                access = options.fallback ? .setuidTools : .denied
                error = failure.description
            }
            targets[identity.pid] = Target(identity: identity, access: access, startAbstime: startAbstime)
            pendingLines.append(
                line(
                    ProcessRecord(
                        tick: tick,
                        at: at,
                        pid: identity.pid,
                        ppid: identity.ppid,
                        uid: identity.uid,
                        startUs: identity.startUs,
                        name: identity.name,
                        path: identity.path,
                        access: access,
                        error: error
                    )
                )
            )
        }

        func discover(tick: Int, at: String, explicit: Bool) {
            if explicit {
                for pid in options.pids {
                    if let identity = ProcessInspector.identity(of: pid) {
                        add(identity, tick: tick, at: at)
                    } else {
                        pendingLines.append(line(WarningRecord(tick: tick, at: at, pid: pid, message: "no such process")))
                    }
                }
            }
            guard matcher != nil || options.includeCoreaudiod else { return }
            for pid in ProcessInspector.allPids() where targets[pid] == nil {
                guard let identity = ProcessInspector.identity(of: pid) else { continue }
                let isCoreaudiod = identity.path == "/usr/sbin/coreaudiod" || identity.name == "coreaudiod"
                if (options.includeCoreaudiod && isCoreaudiod) || matcher?.matches(identity) == true {
                    add(identity, tick: tick, at: at)
                }
            }
        }

        let intervalNs = UInt64(options.intervalMs) * 1_000_000
        let durationNs = options.durationS.map { UInt64(($0 * 1e9).rounded()) }
        // Enough top samples for the run plus slack, so a top orphaned by a killed meter ends.
        let topSamples = options.durationS.map { Int(($0 + 30) / Double(options.privilegedIntervalS)) + 2 } ?? 0
        var topStream: TopStream?
        let rediscoverEveryTicks = max(1, Int((Double(options.rediscoverS) * 1_000 / Double(options.intervalMs)).rounded()))
        let origin = started.uptimeNs
        var tick = 0
        var reason = "duration"

        while true {
            let clock = ClockReading.now()
            let at = clock.iso8601
            let elapsed = clock.uptimeNs - origin
            let isFinal = stop.isRequested || durationNs.map { elapsed + intervalNs / 2 >= $0 } == true
            if stop.isRequested { reason = "signal" }

            if tick == 0 {
                discover(tick: tick, at: at, explicit: true)
            } else if matcher != nil, tick % rediscoverEveryTicks == 0 {
                discover(tick: tick, at: at, explicit: false)
            }
            if targets.isEmpty, tick == 0 {
                emit(writer, pendingLines)
                fputs("sondine-meter sample: no process to sample\n", stderr)
                return ExitCode.failure
            }

            var privileged: [Int32] = []
            for pid in targets.keys.sorted() {
                guard var target = targets[pid] else { continue }
                switch target.access {
                case .rusage:
                    switch ProcessInspector.rusage(of: pid) {
                    case .success(let reading):
                        if let known = target.startAbstime, known != reading.startAbstime {
                            pendingLines.append(line(ExitRecord(tick: tick, at: at, pid: pid, reason: "reused")))
                            targets[pid] = nil
                            if let current = ProcessInspector.identity(of: pid), matcher?.matches(current) == true {
                                add(current, tick: tick, at: at)
                            }
                            continue
                        }
                        let graphics = ProcessInspector.graphicsFootprint(of: pid)
                        pendingLines.append(
                            line(SampleRecord(tick: tick, at: at, clock: clock, pid: pid, rusage: reading, graphicsFootprintBytes: graphics))
                        )
                    case .failure(let failure) where failure.code == ESRCH:
                        pendingLines.append(line(ExitRecord(tick: tick, at: at, pid: pid, reason: "exited")))
                        targets[pid] = nil
                    case .failure(let failure):
                        if !target.warned {
                            pendingLines.append(line(WarningRecord(tick: tick, at: at, pid: pid, message: "proc_pid_rusage: \(failure)")))
                            target.warned = true
                            targets[pid] = target
                        }
                    }
                case .setuidTools:
                    if ProcessInspector.isAlive(pid) {
                        privileged.append(pid)
                    } else {
                        pendingLines.append(line(ExitRecord(tick: tick, at: at, pid: pid, reason: "exited")))
                        targets[pid] = nil
                    }
                case .denied:
                    if !ProcessInspector.isAlive(pid) {
                        pendingLines.append(line(ExitRecord(tick: tick, at: at, pid: pid, reason: "exited")))
                        targets[pid] = nil
                    }
                }
            }

            if privileged != topStream?.pids {
                topStream?.stop()
                topStream = TopStream(pids: privileged, intervalS: options.privilegedIntervalS, samples: topSamples)
            }
            if !privileged.isEmpty {
                let cpu = SetuidTools.cpuTimes(of: privileged)
                var top: [Int32: TopRow] = [:]
                for row in topStream?.drain() ?? [] { top[row.pid] = row }
                for pid in privileged {
                    guard cpu[pid] != nil || top[pid] != nil else {
                        if var target = targets[pid], !target.warned {
                            pendingLines.append(line(WarningRecord(tick: tick, at: at, pid: pid, message: "ps returned nothing")))
                            target.warned = true
                            targets[pid] = target
                        }
                        continue
                    }
                    var sample = SampleRecord(tick: tick, at: at, clock: clock, pid: pid, source: .setuidTools)
                    sample.cpuNs = cpu[pid]
                    sample.idleWakeups = top[pid]?.idleWakeups
                    sample.footprintBytes = top[pid]?.footprintBytes
                    pendingLines.append(line(sample))
                }
            }

            emit(writer, pendingLines)
            pendingLines.removeAll(keepingCapacity: true)
            if writer.failed {
                reason = "write-error"
                break
            }
            tick += 1
            if isFinal { break }

            let next = origin + UInt64(tick) * intervalNs
            let now = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
            if next > now { _ = stop.wake.wait(timeout: .now() + .nanoseconds(Int(next - now))) }
        }

        topStream?.stop()
        let end = ClockReading.now()
        let endRecord = EndRecord(
            ticks: tick,
            at: end.iso8601,
            uptimeNs: end.uptimeNs,
            continuousNs: end.continuousNs,
            reason: reason,
            meter: overhead()
        )
        emit(writer, [line(endRecord)])
        return reason == "write-error" ? ExitCode.failure : ExitCode.success
    }

    private static func overhead() -> MeterOverhead {
        var children = rusage()
        getrusage(RUSAGE_CHILDREN, &children)
        func ns(_ time: timeval) -> UInt64 { UInt64(time.tv_sec) * 1_000_000_000 + UInt64(time.tv_usec) * 1_000 }
        let childrenNs = ns(children.ru_utime) + ns(children.ru_stime)
        switch ProcessInspector.rusage(of: getpid()) {
        case .success(let reading):
            return MeterOverhead(
                cpuNs: reading.userNs + reading.systemNs,
                childrenCpuNs: childrenNs,
                interruptWakeups: reading.interruptWakeups,
                idleWakeups: reading.idleWakeups,
                energyNj: reading.energyNj,
                lifetimeMaxFootprintBytes: reading.lifetimeMaxFootprintBytes
            )
        case .failure:
            var own = rusage()
            getrusage(RUSAGE_SELF, &own)
            return MeterOverhead(cpuNs: ns(own.ru_utime) + ns(own.ru_stime), childrenCpuNs: childrenNs)
        }
    }

    private static func line(_ record: some Encodable) -> Data {
        // Encoding these plain records cannot fail (no floats, no custom encoders).
        (try? JSONLines.encode(record)) ?? Data()
    }

    private static func emit(_ writer: LineWriter, _ lines: [Data]) {
        writer.write(lines)
    }
}
