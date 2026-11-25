import AVFAudio
import Darwin
import Dispatch
import Foundation
import SondineCapture
import SondineKit

/// `sondine-audio self-test listeners`: are Core Audio's notifications reliable enough for
/// listener-driven discovery (ADR 004: no periodic scan)? Each round starts a short, silent
/// `afplay` and creates then destroys a private aggregate device, and records whether the
/// process object list, the process's `IsRunningOutput`, and the device list notified us, and
/// how fast. It needs no permission: no audio is captured, and the clip is digital silence.
/// One JSON line per round on stdout, then a summary; the exit status is 0 whatever the results.
enum ListenerSelfTest {
    struct Options {
        var rounds = 20
        var player = "/usr/bin/afplay"

        static func parse(_ arguments: [String]) throws -> Options {
            var options = Options()
            var index = 0
            while index < arguments.count {
                let flag = arguments[index]
                guard index + 1 < arguments.count else { throw ParameterError("\(flag) needs a value") }
                let value = arguments[index + 1]
                switch flag {
                case "--rounds":
                    guard let rounds = Int(value), (1...500).contains(rounds) else { throw ParameterError("--rounds must be 1 to 500") }
                    options.rounds = rounds
                case "--player":
                    options.player = value
                default:
                    throw ParameterError("unknown option \(flag)")
                }
                index += 2
            }
            return options
        }
    }

    /// What one process object went through, in ns of `mach_continuous_time` converted.
    private struct Seen {
        var pid: Int32
        var appeared: UInt64
        var outputOn: UInt64?
        var outputOff: UInt64?
        var removed: UInt64?
    }

    /// Confined to `queue`.
    private final class Observer: @unchecked Sendable {
        let hal: CoreAudioHardware
        let queue: DispatchQueue
        var objects: [HALObjectID: Seen] = [:]
        var tokens: [HALObjectID: [HALListenerToken]] = [:]
        var deviceNotices: [UInt64] = []
        var listNotices = 0
        var outputNotices = 0
        var ownObject: HALObjectID?
        var registrations = (ok: 0, failed: 0)
        var notices: [String: Int] = [:]
        /// Reads of `IsRunningOutput` made while the player runs, with no notification (control).
        var polledOutputOn: Set<Int32> = []

        init(hal: CoreAudioHardware, queue: DispatchQueue) {
            self.hal = hal
            self.queue = queue
        }

        func start() throws {
            _ = try hal.addListener(halSystemObject, .processObjectList, queue: queue) { [weak self] in self?.listChanged() }
            _ = try hal.addListener(halSystemObject, .devices, queue: queue) { [weak self] in self?.deviceNotices.append(now()) }
            for id in (try? hal.processObjectIDs()) ?? [] { objects[id] = Seen(pid: (try? hal.processInfo(id).pid) ?? 0, appeared: 0) }
        }

        private func listChanged() {
            listNotices += 1
            let time = now()
            let ids = Set((try? hal.processObjectIDs()) ?? [])
            for id in ids where objects[id] == nil {
                let pid = (try? hal.processInfo(id).pid) ?? 0
                objects[id] = Seen(pid: pid, appeared: time)
                // The helper's own set (ProcessCatalog): all four, counted apart.
                var list: [HALListenerToken] = []
                for (name, property) in [("isRunningOutput", HALProperty.processIsRunningOutput), ("isRunningInput", .processIsRunningInput), ("devicesOutput", .processDevices(.output)), ("devicesInput", .processDevices(.input))] {
                    do {
                        list.append(try hal.addListener(id, property, queue: queue) { [weak self] in
                            self?.notices[name, default: 0] += 1
                            self?.outputChanged(id)
                        })
                        registrations.ok += 1
                    } catch {
                        registrations.failed += 1
                    }
                }
                tokens[id] = list
                outputChanged(id, initial: true)
            }
            for (id, seen) in objects where !ids.contains(id) && seen.removed == nil {
                objects[id]?.removed = time
                tokens.removeValue(forKey: id)?.forEach(hal.discardListener)
            }
        }

        func poll(pid: Int32) {
            for (id, seen) in objects where seen.pid == pid && seen.removed == nil {
                if (try? hal.processIO(id))?.runningOutput == true { polledOutputOn.insert(pid) }
            }
        }

        private func outputChanged(_ id: HALObjectID, initial: Bool = false) {
            if !initial { outputNotices += 1 }
            guard let io = try? hal.processIO(id) else { return }
            let time = now()
            if io.runningOutput, objects[id]?.outputOn == nil { objects[id]?.outputOn = time }
            if !io.runningOutput, objects[id]?.outputOn != nil, objects[id]?.outputOff == nil { objects[id]?.outputOff = time }
        }

        func seen(pid: Int32) -> Seen? { objects.values.filter { $0.pid == pid && $0.appeared > 0 }.max { $0.appeared < $1.appeared } }

        /// This process's own object: present from the start, so watched by hand.
        func watchOwn() -> HALObjectID? {
            guard let id = objects.first(where: { $0.value.pid == getpid() })?.key else { return nil }
            objects[id]?.appeared = 1
            var list: [HALListenerToken] = []
            for (name, property) in [("own.isRunningOutput", HALProperty.processIsRunningOutput), ("own.devicesOutput", .processDevices(.output))] {
                if let token = try? hal.addListener(id, property, queue: queue, { [weak self] in
                    self?.notices[name, default: 0] += 1
                    self?.outputChanged(id)
                }) { list.append(token) }
            }
            tokens[id] = list
            return id
        }

        func resetOwn(_ id: HALObjectID) {
            objects[id]?.outputOn = nil
            objects[id]?.outputOff = nil
        }
    }

    static func run(_ arguments: [String]) -> Int32 {
        let options: Options
        do {
            options = try Options.parse(arguments)
        } catch {
            fputs("sondine-audio self-test listeners: \(error)\n", stderr)
            return ExitCode.usage
        }
        let clip = FileManager.default.temporaryDirectory.appending(path: "sondine-listener-test-\(getpid()).wav")
        defer { try? FileManager.default.removeItem(at: clip) }
        do {
            try silentWAV(seconds: 0.6).write(to: clip)
        } catch {
            fputs("sondine-audio self-test listeners: cannot write the clip: \(error)\n", stderr)
            return ExitCode.failure
        }
        let hal = CoreAudioHardware()
        let queue = DispatchQueue(label: "app.sondine.audio.listener-test", qos: .utility)
        let observer = Observer(hal: hal, queue: queue)
        do {
            try queue.sync { try observer.start() }
        } catch {
            fputs("sondine-audio self-test listeners: cannot listen: \(error)\n", stderr)
            return ExitCode.failure
        }
        var appear: [Double] = [], outputOn: [Double] = [], outputOff: [Double] = [], removed: [Double] = [], device: [Double] = []
        var ownOn: [Double] = [], ownOff: [Double] = []
        // A short-lived player usually leaves before its output is seen stopping: `outputOff` of
        // the player is informative; this process's own output start and stop are the test.
        var misses = ["appeared": 0, "outputOn": 0, "removed": 0, "deviceAdded": 0, "deviceRemoved": 0, "ownOutputOn": 0, "ownOutputOff": 0]
        queue.sync { observer.ownObject = observer.watchOwn() }
        // Signed: Core Audio may drop a process object before Foundation reports its exit.
        let ms = { (from: UInt64, to: UInt64?) -> Double? in to.map { (Double($0) - Double(from)) / 1e6 } }

        for round in 1...options.rounds {
            // A silent, short-lived output process.
            let player = Process()
            player.executableURL = URL(filePath: options.player)
            // The clip is digital silence, so nothing is heard at any volume.
            player.arguments = [clip.path(percentEncoded: false)]
            let started = now()
            do { try player.run() } catch {
                fputs("sondine-audio self-test listeners: cannot start \(options.player): \(error)\n", stderr)
                return ExitCode.failure
            }
            // Control: read the property mid-clip, without waiting for a notification.
            Thread.sleep(forTimeInterval: 0.3)
            queue.sync { observer.poll(pid: player.processIdentifier) }
            player.waitUntilExit()
            let exited = now()
            Thread.sleep(forTimeInterval: 1.0)
            let seen = queue.sync { observer.seen(pid: player.processIdentifier) }

            // A private aggregate device: added, then removed.
            let before = queue.sync { observer.deviceNotices.count }
            let uid = "app.sondine.listener-test.\(getpid()).\(round)"
            let createdAt = now()
            let aggregate = try? hal.createAggregateDevice(AggregateDescription(name: "Sondine listener test", uid: uid, tapUIDs: []))
            Thread.sleep(forTimeInterval: 0.5)
            let added = queue.sync { observer.deviceNotices.dropFirst(before).first }
            let destroyedAt = now()
            let afterAdd = queue.sync { observer.deviceNotices.count }
            if let aggregate { hal.destroyAggregateDevice(aggregate) }
            Thread.sleep(forTimeInterval: 0.5)
            let gone = queue.sync { observer.deviceNotices.dropFirst(afterAdd).first }

            var line: [String: Any] = ["check": "listeners", "round": round, "pid": Int(player.processIdentifier)]
            func note(_ key: String, _ value: Double?, into list: inout [Double]) {
                if let value { list.append(value); line[key + "Ms"] = (value * 10).rounded() / 10 } else {
                    if misses[key] != nil { misses[key, default: 0] += 1 }
                    line[key + "Ms"] = NSNull()
                }
            }
            note("appeared", seen.flatMap { ms(started, $0.appeared) }, into: &appear)
            note("outputOn", seen.flatMap { ms(started, $0.outputOn) }, into: &outputOn)
            note("outputOff", seen.flatMap { ms(exited, $0.outputOff) }, into: &outputOff)
            note("removed", seen.flatMap { ms(exited, $0.removed) }, into: &removed)
            if aggregate == nil { line["aggregate"] = "not created" } else {
                note("deviceAdded", ms(createdAt, added), into: &device)
                note("deviceRemoved", ms(destroyedAt, gone), into: &device)
            }

            // This process starts and stops output while it stays alive.
            if let own = queue.sync(execute: { observer.ownObject }), let player = try? AVAudioPlayer(contentsOf: clip) {
                queue.sync { observer.resetOwn(own) }
                let playAt = now()
                player.play()
                Thread.sleep(forTimeInterval: 0.4)
                let stopAt = now()
                player.stop()
                // Control: poll the property until it reads false (at most 5 s).
                var actuallyOff: UInt64?
                for _ in 0..<100 where actuallyOff == nil {
                    Thread.sleep(forTimeInterval: 0.05)
                    if (try? hal.processIO(own))?.runningOutput == false { actuallyOff = now() }
                }
                Thread.sleep(forTimeInterval: 0.3)
                let seenOwn = queue.sync { observer.objects[own] }
                note("ownOutputOn", seenOwn.flatMap { ms(playAt, $0.outputOn) }, into: &ownOn)
                note("ownOutputOff", seenOwn.flatMap { ms(stopAt, $0.outputOff) }, into: &ownOff)
                line["ownOutputActuallyOffMs"] = ms(stopAt, actuallyOff).map { ($0 * 10).rounded() / 10 } ?? NSNull()
            }
            emit(line)
        }
        func summary(_ values: [Double]) -> [String: Any] {
            let sorted = values.sorted()
            guard !sorted.isEmpty else { return ["count": 0] }
            let pick = { (q: Double) in (sorted[min(sorted.count - 1, Int(Double(sorted.count - 1) * q))] * 10).rounded() / 10 }
            return ["count": sorted.count, "p50Ms": pick(0.5), "p95Ms": pick(0.95), "maxMs": pick(1)]
        }
        let (listNotices, polled, registrations, notices) = queue.sync {
            (observer.listNotices, observer.polledOutputOn.count, observer.registrations, observer.notices)
        }
        emit([
            "check": "summary", "rounds": options.rounds, "misses": misses, "processListNotices": listNotices,
            "processNotices": notices, "outputOnWhenPolled": polled,
            "registrations": ["ok": registrations.ok, "failed": registrations.failed],
            "appeared": summary(appear), "outputOn": summary(outputOn), "outputOff": summary(outputOff),
            "removed": summary(removed), "device": summary(device), "ownOutputOn": summary(ownOn), "ownOutputOff": summary(ownOff),
            "ok": misses.values.allSatisfy { $0 == 0 },
        ])
        return ExitCode.success
    }

    private static func emit(_ line: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]) else { return }
        FileHandle.standardOutput.write(data + Data("\n".utf8))
    }

    /// 16-bit mono 48 kHz silence.
    private static func silentWAV(seconds: Double) -> Data {
        let frames = Int(48_000 * seconds)
        var data = Data()
        func append<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        data.append(contentsOf: Array("RIFF".utf8)); append(UInt32(36 + frames * 2))
        data.append(contentsOf: Array("WAVEfmt ".utf8)); append(UInt32(16)); append(UInt16(1)); append(UInt16(1))
        append(UInt32(48_000)); append(UInt32(96_000)); append(UInt16(2)); append(UInt16(16))
        data.append(contentsOf: Array("data".utf8)); append(UInt32(frames * 2))
        data.append(Data(count: frames * 2))
        return data
    }
}

private func now() -> UInt64 {
    var timebase = mach_timebase_info_data_t()
    mach_timebase_info(&timebase)
    return mach_continuous_time() &* UInt64(timebase.numer) / UInt64(timebase.denom)
}
