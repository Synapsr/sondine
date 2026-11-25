import CoreAudio
import Darwin
import Dispatch
import Foundation
import SondineCapture
import SondineKit

/// `sondine-audio self-test taps`: what N process taps cost, in one aggregate device or in one
/// aggregate each (architecture §3, M0 spike). It starts `--players` copies of `afplay` on a
/// quiet tone (-70 dBFS, 1 kHz), taps the first N of them, runs IO for `--seconds`, and reports
/// coreaudiod's CPU (read through the setuid `/bin/ps`), this process's CPU and wakeups, and the
/// frames and peak each tap delivered. A peak of silence means the taps were not allowed:
/// system-audio capture needs a grant for the responsible app, so run it from an app bundle
/// that macOS can ask about (see native/README.md). Writes JSON lines to stdout or `--out`.
enum TapSelfTest {
    struct Options {
        var counts = [0, 1, 2, 4, 8]
        var seconds = 60.0
        var settle = 5.0
        var player = "/usr/bin/afplay"
        var out: URL?
        /// Seconds to wait for a first non-silent sample (the system-audio grant) before measuring.
        var wait = 600.0

        static func parse(_ arguments: [String]) throws -> Options {
            var options = Options()
            var index = 0
            while index < arguments.count {
                let flag = arguments[index]
                guard index + 1 < arguments.count else { throw ParameterError("\(flag) needs a value") }
                let value = arguments[index + 1]
                switch flag {
                case "--counts":
                    let counts = value.split(separator: ",").compactMap { Int($0) }
                    guard !counts.isEmpty, counts.allSatisfy({ (0...16).contains($0) }) else { throw ParameterError("--counts must list 0 to 16") }
                    options.counts = counts.sorted()
                case "--seconds":
                    guard let seconds = Double(value), (5...3_600).contains(seconds) else { throw ParameterError("--seconds must be 5 to 3600") }
                    options.seconds = seconds
                case "--player":
                    options.player = value
                case "--out":
                    options.out = URL(filePath: value)
                case "--wait":
                    guard let wait = Double(value), (0...86_400).contains(wait) else { throw ParameterError("--wait must be 0 to 86400") }
                    options.wait = wait
                default:
                    throw ParameterError("unknown option \(flag)")
                }
                index += 2
            }
            return options
        }
    }

    /// Written by the IO thread, read once the IO stopped.
    private final class TapStats: @unchecked Sendable {
        var frames: UInt64 = 0
        var peak: Float = 0
    }

    private struct Config {
        var taps: Int
        var shared: Bool
        var label: String { taps <= 1 ? "\(taps)" : "\(taps)-\(shared ? "shared" : "separate")" }
    }

    static func run(_ arguments: [String]) -> Int32 {
        let options: Options
        do {
            options = try Options.parse(arguments)
        } catch {
            fputs("sondine-audio self-test taps: \(error)\n", stderr)
            return ExitCode.usage
        }
        var lines: [Data] = []
        func emit(_ line: [String: Any]) {
            guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]) else { return }
            lines.append(data + Data("\n".utf8))
            if options.out == nil { FileHandle.standardOutput.write(data + Data("\n".utf8)) }
        }
        defer {
            if let out = options.out { try? lines.reduce(Data(), +).write(to: out) }
        }

        let configs = options.counts.flatMap { count in
            count <= 1 ? [Config(taps: count, shared: true)] : [Config(taps: count, shared: true), Config(taps: count, shared: false)]
        }
        let total = Double(configs.count) * (options.seconds + options.settle + 3) + 30
        let clip = FileManager.default.temporaryDirectory.appending(path: "sondine-tap-test-\(getpid()).wav")
        defer { try? FileManager.default.removeItem(at: clip) }
        do {
            try quietTone(seconds: total).write(to: clip)
        } catch {
            emit(["check": "error", "message": "cannot write the clip: \(error)"])
            return ExitCode.failure
        }

        // The same players run through every configuration, so each one pays for them alike.
        let playerCount = options.counts.max() ?? 0
        var players: [Process] = []
        defer { for player in players where player.isRunning { player.terminate() } }
        for _ in 0..<max(1, playerCount) {
            let player = Process()
            player.executableURL = URL(filePath: options.player)
            player.arguments = [clip.path(percentEncoded: false)]
            do { try player.run() } catch {
                emit(["check": "error", "message": "cannot start \(options.player): \(error)"])
                return ExitCode.failure
            }
            players.append(player)
        }
        Thread.sleep(forTimeInterval: 2)
        let hal = CoreAudioHardware()
        let pids = Set(players.map(\.processIdentifier))
        let objects = ((try? hal.processObjectIDs()) ?? []).filter { pids.contains((try? hal.processInfo($0).pid) ?? 0) }
        guard let coreaudiod = pid(of: "coreaudiod") else {
            emit(["check": "error", "message": "coreaudiod not found"])
            return ExitCode.failure
        }
        emit(["check": "setup", "players": players.count, "playerObjects": objects.count, "coreaudiodPid": Int(coreaudiod), "seconds": options.seconds])
        if let first = objects.first {
            let waited = waitForSignal(hal: hal, object: first, seconds: options.wait)
            emit([
                "check": "authorized", "ok": waited.seconds != nil,
                "afterSeconds": waited.seconds.map(round2) ?? NSNull(), "lastError": waited.error ?? NSNull(),
            ])
            guard waited.seconds != nil else { return ExitCode.success }
        }

        for config in configs {
            guard config.taps <= objects.count else {
                emit(["check": "taps", "config": config.label, "error": "only \(objects.count) player objects"])
                continue
            }
            var taps: [HALObjectID] = []
            var aggregates: [HALObjectID] = []
            var procs: [HALIOProcHandle] = []
            var stats: [TapStats] = []
            var failure: String?
            do {
                for (index, object) in objects.prefix(config.taps).enumerated() {
                    taps.append(try hal.createProcessTap(TapDescription(scope: .processes([object]), name: "Sondine tap probe \(index)")))
                }
                let uids = try taps.map(hal.tapUID)
                let groups = config.shared ? [uids] : uids.map { [$0] }
                for (index, group) in groups.enumerated() where !group.isEmpty {
                    let aggregate = try hal.createAggregateDevice(AggregateDescription(
                        name: "Sondine tap probe", uid: "app.sondine.tap-probe.\(getpid()).\(config.label).\(index)", tapUIDs: group
                    ))
                    aggregates.append(aggregate)
                    let tapStats = TapStats()
                    stats.append(tapStats)
                    let proc = try hal.createIOProc(device: aggregate, inputOnly: true) { input, _ in
                        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
                        for buffer in buffers {
                            guard let data = buffer.mData else { continue }
                            let count = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
                            let samples = data.assumingMemoryBound(to: Float.self)
                            var peak = tapStats.peak
                            for index in 0..<count { peak = max(peak, abs(samples[index])) }
                            tapStats.peak = peak
                            tapStats.frames &+= UInt64(count / max(1, Int(buffer.mNumberChannels)))
                        }
                    }
                    procs.append(proc)
                    try hal.startIO(proc)
                }
            } catch {
                failure = "\(error)"
            }
            if failure == nil {
                Thread.sleep(forTimeInterval: options.settle)
                let start = Snapshot(coreaudiod: coreaudiod)
                Thread.sleep(forTimeInterval: options.seconds)
                let end = Snapshot(coreaudiod: coreaudiod)
                for proc in procs { hal.stopIO(proc) }
                let wall = Double(end.wallNs &- start.wallNs) / 1e9
                let framesPerSecond = stats.map { Double($0.frames) / (wall + options.settle) }
                emit([
                    "check": "taps", "config": config.label, "taps": config.taps, "aggregates": aggregates.count,
                    "coreaudiodCpuPercent": round2(Double(end.coreaudiodCpuNs &- start.coreaudiodCpuNs) / 1e7 / wall),
                    "probeCpuPercent": round2(Double(end.ownCpuNs &- start.ownCpuNs) / 1e7 / wall),
                    "probeWakeupsPerSecond": round2(Double(end.ownWakeups &- start.ownWakeups) / wall),
                    "framesPerSecond": framesPerSecond.map { $0.rounded() },
                    "peakDbfs": stats.map { $0.peak > 0 ? round2(20 * log10(Double($0.peak))) : -200 },
                ])
            } else {
                emit(["check": "taps", "config": config.label, "error": failure ?? ""])
            }
            for proc in procs { hal.stopIO(proc); hal.destroyIOProc(proc) }
            for aggregate in aggregates { hal.destroyAggregateDevice(aggregate) }
            for tap in taps { hal.destroyProcessTap(tap) }
            Thread.sleep(forTimeInterval: 2)
        }
        emit(["check": "summary", "configs": configs.count])
        return ExitCode.success
    }

    /// One tap on `object` until a non-zero sample arrives: macOS asks for the grant at the
    /// first IO and delivers silence (or refuses the tap) until then, so a failed setup is retried.
    /// Returns the seconds it took, or the last setup error past `seconds`.
    private static func waitForSignal(hal: CoreAudioHardware, object: HALObjectID, seconds: Double) -> (seconds: Double?, error: String?) {
        let start = Date()
        var lastError: String?
        while Date().timeIntervalSince(start) < seconds {
            let stats = TapStats()
            var tap: HALObjectID = 0
            var aggregate: HALObjectID = 0
            var proc: HALIOProcHandle?
            do {
                tap = try hal.createProcessTap(TapDescription(scope: .processes([object]), name: "Sondine tap probe check"))
                aggregate = try hal.createAggregateDevice(AggregateDescription(
                    name: "Sondine tap probe", uid: "app.sondine.tap-probe.\(getpid()).check", tapUIDs: [try hal.tapUID(tap)]
                ))
                let handle = try hal.createIOProc(device: aggregate, inputOnly: true) { input, _ in
                    for buffer in UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input)) {
                        guard let data = buffer.mData else { continue }
                        let samples = data.assumingMemoryBound(to: Float.self)
                        for index in 0..<(Int(buffer.mDataByteSize) / MemoryLayout<Float>.size) where samples[index] != 0 { stats.peak = 1 }
                    }
                }
                proc = handle
                try hal.startIO(handle)
                // Up to 10 s of signal on this setup, then build it again.
                for _ in 0..<20 where stats.peak == 0 { Thread.sleep(forTimeInterval: 0.5) }
            } catch {
                lastError = "\(error)"
                Thread.sleep(forTimeInterval: 2)
            }
            if let proc { hal.stopIO(proc); hal.destroyIOProc(proc) }
            if aggregate != 0 { hal.destroyAggregateDevice(aggregate) }
            if tap != 0 { hal.destroyProcessTap(tap) }
            if stats.peak > 0 { return (Date().timeIntervalSince(start), nil) }
        }
        return (nil, lastError ?? "silence only")
    }

    private struct Snapshot {
        var wallNs: UInt64
        var coreaudiodCpuNs: UInt64
        var ownCpuNs: UInt64
        var ownWakeups: UInt64

        init(coreaudiod: Int32) {
            wallNs = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)
            coreaudiodCpuNs = psCpuNs(coreaudiod) ?? 0
            var info = rusage_info_v4()
            let status = withUnsafeMutablePointer(to: &info) {
                $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(getpid(), RUSAGE_INFO_V4, $0) }
            }
            ownCpuNs = status == 0 ? machToNs(info.ri_user_time &+ info.ri_system_time) : 0
            ownWakeups = status == 0 ? info.ri_interrupt_wkups &+ info.ri_pkg_idle_wkups : 0
        }
    }

    private static func pid(of name: String) -> Int32? {
        guard let output = run("/usr/bin/pgrep", ["-x", name]) else { return nil }
        return output.split(whereSeparator: \.isNewline).first.flatMap { Int32($0) }
    }

    /// Cumulative CPU time from the setuid `/bin/ps` (another user's process): `[[h:]m:]s.cc`.
    private static func psCpuNs(_ pid: Int32) -> UInt64? {
        guard let output = run("/bin/ps", ["-o", "time=", "-p", String(pid)])?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        var seconds = 0.0
        for part in output.split(separator: ":") {
            guard let value = Double(part) else { return nil }
            seconds = seconds * 60 + value
        }
        return UInt64(seconds * 1e9)
    }

    private static func run(_ path: String, _ arguments: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(filePath: path)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(data: data, encoding: .utf8)
    }

    private static func machToNs(_ ticks: UInt64) -> UInt64 {
        var timebase = mach_timebase_info_data_t()
        mach_timebase_info(&timebase)
        return ticks &* UInt64(timebase.numer) / UInt64(timebase.denom)
    }

    private static func round2(_ value: Double) -> Double { (value * 100).rounded() / 100 }

    /// 16-bit mono 48 kHz, a 1 kHz tone at -70 dBFS: inaudible at normal volume, but not silence.
    private static func quietTone(seconds: Double) -> Data {
        let frames = Int(48_000 * seconds)
        var data = Data(capacity: 44 + frames * 2)
        func append<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        data.append(contentsOf: Array("RIFF".utf8)); append(UInt32(36 + frames * 2))
        data.append(contentsOf: Array("WAVEfmt ".utf8)); append(UInt32(16)); append(UInt16(1)); append(UInt16(1))
        append(UInt32(48_000)); append(UInt32(96_000)); append(UInt16(2)); append(UInt16(16))
        data.append(contentsOf: Array("data".utf8)); append(UInt32(frames * 2))
        let amplitude = 32_767 * pow(10, -70.0 / 20)
        var samples = [Int16](repeating: 0, count: frames)
        for index in 0..<frames { samples[index] = Int16((amplitude * sin(2 * Double.pi * 1_000 * Double(index) / 48_000)).rounded()) }
        samples.withUnsafeBytes { data.append(contentsOf: $0) }
        return data
    }
}
