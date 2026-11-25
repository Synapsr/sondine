import Foundation
import SondineKit
import Testing
@testable import SondineCapture

/// Private zones the helper enforces itself (ADR 029), on the fake HAL: an excluded app's call or
/// listen holds the microphone, and calls, the screen away, hours and networks hold everything,
/// each until its trigger ends. A hold is never a pause, a lifted occurrence holds nothing, and
/// what a hold's trigger was captured after and not committed is dropped.
@Suite(.serialized)
struct PrivateZonesTests {
    static let mic = "BuiltInMicrophoneDevice"
    static let micTrack = "input:BuiltInMicrophoneDevice"
    static let speakers = "BuiltInSpeakerDevice"
    static let paris = TimeZone(identifier: "Europe/Paris")!
    static let key = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
    static let office = NetworkSignature("IPv4.Router=192.168.1.1;IPv4.RouterHardwareAddress=aa:bb:cc:dd:ee:ff")
    static let officeHash = "156d3845f9cf77804e66d475ef0ed074"
    static let home = NetworkSignature("IPv4.Router=10.0.0.1;IPv4.RouterHardwareAddress=02:11:22:33:44:55")
    static let homeHash = "3b15e743933ce75589a8106d131b38a2"

    static let zoom = AppBundle(bundleId: "us.zoom.xos", name: "Zoom")
    static let discord = AppBundle(bundleId: "com.hnc.Discord", name: "Discord")
    static let music = AppBundle(bundleId: "com.apple.Music", name: "Music")
    static let hex = AppBundle(bundleId: "anomaly.hex", name: "Hex")

    /// A fake Mac with a microphone and apps resolved by pid, fed in 256 ms IO cycles.
    final class Mac {
        let harness: EngineHarness
        var frame: Int64 = 0

        init(
            apps: [Int32: AppBundle] = [:], wall: Date? = nil, networks: [NetworkSignature] = [],
            configure: (inout CaptureConfig) -> Void = { _ in }
        ) throws {
            harness = try EngineHarness(
                introspection: FixtureIntrospection(rows: apps.mapValues { .init(app: $0) }), networks: FakeNetworks(networks)
            )
            if let wall { harness.clock.setWall(wall) }
            harness.start(Self.config(configure))
        }

        static func config(_ configure: (inout CaptureConfig) -> Void = { _ in }) -> CaptureConfig {
            var config = CaptureConfig()
            config.systemAudio.appTaps.enabled = true
            configure(&config)
            return config
        }

        var hal: FakeAudioHardware { harness.hal }
        var engine: CaptureEngine { harness.engine }
        var state: CaptureState { engine.state }
        var recorder: EventRecorder { harness.recorder }
        var clock: ManualClock { harness.clock }

        @discardableResult
        func process(pid: Int32, bundleID: String?, frequency: Double) -> HALObjectID {
            let id = hal.addProcess(pid: pid, bundleID: bundleID)
            hal.setTone(id, .init(frequency: frequency, amplitude: 0.1))
            harness.settle()
            return id
        }

        func play(_ id: HALObjectID, _ on: Bool = true, input: Bool = false) {
            hal.setProcessIO(id, input: input, output: on, inputDevices: input ? [PrivateZonesTests.mic] : [], outputDevices: on ? [PrivateZonesTests.speakers] : [])
            harness.settle()
        }

        /// `seconds` of microphone noise and of every started tap, drained at the helper's cadence.
        func run(seconds: Double, amplitude: Float = 0.01) {
            var left = Int((seconds * 48_000).rounded())
            while left > 0 {
                let frames = min(12_288, left)
                deliverMicrophone(frames: frames, amplitude: amplitude)
                hal.deliverToTaps(startFrame: frame, frames: frames, hostTicks: clock.nanoseconds)
                frame += Int64(frames)
                left -= frames
                clock.advance(seconds: Double(frames) / 48_000)
                engine.drainNow()
            }
        }

        func deliverMicrophone(frames: Int, amplitude: Float = 0.01) {
            hal.deliver(toDevice: PrivateZonesTests.mic, interleaved: EngineHarness.noise(frames: frames, amplitude: amplitude), channels: 1, hostTicks: clock.nanoseconds)
        }

        func send(_ message: ControlMessage) { harness.send(message) }

        /// The holds as last said.
        var holds: [HoldOccurrence] { recorder.holds.last?.holds ?? [] }

        var heldCloses: [String] { recorder.trackCloses.filter { $0.reason == .held }.map(\.trackKey) }

        /// The microphone records: unmuted, with a run open.
        var microphoneRecords: Bool { !state.microphoneMuted && state.microphoneRunId != nil }
    }

    // MARK: Apps the user excluded

    @Test func anExcludedAppsCallHoldsTheMicrophoneUntil10SecondsAfterAndStaysUnreported() throws {
        let mac = try Mac(apps: [7_001: Self.zoom, 7_002: Self.music]) { $0.excludedBundleIds = ["us.zoom.xos"] }
        let music = mac.process(pid: 7_002, bundleID: "com.apple.Music", frequency: 300)
        mac.play(music)
        mac.run(seconds: 2)
        #expect(mac.microphoneRecords)
        #expect(mac.state.appTracks.map(\.bundleId) == ["com.apple.Music"])

        let zoom = mac.process(pid: 7_001, bundleID: "us.zoom.xos", frequency: 700)
        mac.play(zoom, input: true)
        // The microphone is held at once, the Mac's sound is not.
        #expect(mac.state.heldMicrophone && !mac.state.heldEverything)
        #expect(mac.state.microphoneMuted && mac.state.microphoneRunId == nil)
        #expect(mac.heldCloses == [Self.micTrack])
        let hold = try #require(mac.holds.first)
        #expect(mac.holds.count == 1)
        #expect(hold.reason == .app && hold.scope == .microphone && hold.bundleId == "us.zoom.xos" && !hold.lifted)
        mac.run(seconds: 5)
        #expect(mac.state.microphoneRunId == nil)
        #expect(mac.state.appTracks.map(\.bundleId) == ["com.apple.Music"])

        // The call ends: the microphone stays held 10 s more.
        mac.play(zoom, false)
        mac.run(seconds: 9.5)
        #expect(mac.state.heldMicrophone && mac.state.microphoneRunId == nil)
        mac.run(seconds: 1)
        #expect(!mac.state.heldMicrophone && mac.microphoneRecords)
        #expect(mac.holds.isEmpty)
        // Never a call, never a tap, never named in front.
        #expect(mac.recorder.calls.isEmpty)
        #expect(!mac.recorder.trackOpens.contains { $0.trackKey == "app:us.zoom.xos" })
        #expect(mac.state.paused == PausedState())
    }

    @Test func anExcludedDictationAppListeningHoldsTheMicrophone() throws {
        let mac = try Mac(apps: [7_001: Self.hex]) { $0.excludedBundleIds = ["anomaly.hex"] }
        mac.run(seconds: 1)
        let hex = mac.process(pid: 7_001, bundleID: "anomaly.hex", frequency: 500)
        mac.hal.setProcessIO(hex, input: true, output: false, inputDevices: [Self.mic])
        mac.harness.settle()
        #expect(mac.holds.map(\.reason) == [.app] && mac.holds.first?.bundleId == "anomaly.hex")
        #expect(mac.state.microphoneMuted)
        // Its listen spans stay unreported.
        #expect(!mac.recorder.all.contains { if case .listen = $0 { true } else { false } })
    }

    // MARK: Calls, screen, hours, networks

    @Test func aCallHoldsEverythingUntil10SecondsAfterAndIsStillReported() throws {
        let mac = try Mac(apps: [7_001: Self.discord, 7_002: Self.music]) { $0.holds.calls = true }
        let music = mac.process(pid: 7_002, bundleID: "com.apple.Music", frequency: 300)
        mac.play(music)
        mac.run(seconds: 2)
        #expect(mac.state.appTracks.map(\.bundleId) == ["com.apple.Music"] && mac.microphoneRecords)

        let discord = mac.process(pid: 7_001, bundleID: "com.hnc.Discord", frequency: 700)
        mac.play(discord, input: true)
        #expect(mac.state.heldEverything && mac.state.heldMicrophone)
        #expect(mac.state.appTracks.isEmpty && mac.state.systemRunId == nil && mac.state.microphoneMuted)
        #expect(Set(mac.heldCloses) == [Self.micTrack, "app:com.apple.Music"])
        #expect(mac.holds.map(\.reason) == [.calls] && mac.holds.first?.scope == .all)
        // The call itself is a fact core still hears about.
        #expect(mac.recorder.calls.map(\.bundleId) == ["com.hnc.Discord"])
        mac.run(seconds: 5)
        #expect(mac.hal.taps.isEmpty && mac.state.microphoneRunId == nil)

        mac.play(discord, false)
        mac.run(seconds: 9.5)
        #expect(mac.state.heldEverything && mac.hal.taps.isEmpty)
        mac.run(seconds: 1)
        #expect(!mac.state.heldEverything && mac.holds.isEmpty)
        #expect(mac.state.appTracks.map(\.bundleId) == ["com.apple.Music"] && mac.microphoneRecords)
    }

    @Test func theScreenAwayHoldsEverythingUntilItComesBack() throws {
        let mac = try Mac(apps: [7_002: Self.music]) { $0.holds.screen = true }
        let music = mac.process(pid: 7_002, bundleID: "com.apple.Music", frequency: 300)
        mac.play(music)
        mac.run(seconds: 1)
        mac.harness.screen.set(away: true)
        mac.harness.settle()
        #expect(mac.recorder.situations.last == SituationEvent(screenAway: true, networks: []))
        #expect(mac.state.heldEverything && mac.state.microphoneMuted && mac.state.appTracks.isEmpty)
        #expect(mac.holds.map(\.reason) == [.screen])
        mac.run(seconds: 3)
        #expect(mac.hal.taps.isEmpty)
        mac.harness.screen.set(away: false)
        mac.harness.settle()
        #expect(mac.recorder.situations.last?.screenAway == false)
        #expect(!mac.state.heldEverything && mac.holds.isEmpty)
        mac.run(seconds: 1)
        #expect(mac.microphoneRecords && mac.state.appTracks.map(\.bundleId) == ["com.apple.Music"])
    }

    @Test func theScreenAwayWithoutItsZoneHoldsNothing() throws {
        let mac = try Mac()
        mac.run(seconds: 1)
        mac.harness.screen.set(away: true)
        mac.harness.settle()
        #expect(mac.recorder.situations.last?.screenAway == true)
        #expect(mac.recorder.holds.isEmpty && mac.microphoneRecords)
    }

    /// Fri 2026-11-13 22:59:50 in Paris (UTC+1).
    static let fridayNight = Date(timeIntervalSince1970: 1_794_607_190)

    @Test func hoursHoldFromTheirStartAcrossMidnightToTheirEnd() throws {
        let window = CaptureConfig.ScheduleWindow(days: [5], startMinute: 23 * 60, endMinute: 7 * 60)
        let mac = try Mac(wall: Self.fridayNight) { $0.holds.schedule = [window] }
        mac.run(seconds: 5)
        #expect(mac.holds.isEmpty && mac.microphoneRecords)
        let openedAt = try #require(mac.recorder.trackOpens.first { $0.trackKey == Self.micTrack }).start.continuousNs.value
        mac.run(seconds: 6)
        let hold = try #require(mac.holds.first)
        #expect(hold.reason == .schedule && hold.window == 0 && hold.sinceWallMs == 1_794_607_200_000)
        #expect(mac.state.heldEverything && mac.state.microphoneMuted)
        // The run ends at 23:00 sharp, not at the drain that saw it.
        let close = try #require(mac.recorder.trackCloses.last { $0.trackKey == Self.micTrack })
        #expect(close.reason == .held)
        let boundary = openedAt + 10_000_000_000
        #expect(abs(Double(close.endSample) - Double(boundary - openedAt) / 1e9 * 16_000) <= 64)

        // The clock jumps to Saturday 06:59:55 (a clock set): the same night, the same hold.
        mac.clock.setWall(Date(timeIntervalSince1970: 1_794_635_995))
        mac.harness.wallClock.changed()
        mac.harness.settle()
        #expect(mac.holds.map(\.occurrenceId) == [hold.occurrenceId])
        mac.run(seconds: 4)
        #expect(mac.state.heldEverything)
        mac.run(seconds: 2)
        #expect(!mac.state.heldEverything && mac.holds.isEmpty && mac.microphoneRecords)
    }

    @Test func hoursFollowTheWallClockAcrossADSTChangeAndATimeZoneChange() throws {
        // Sat 2026-10-24 22:59:55 CEST (UTC+2); summer time ends at 03:00 that night.
        let window = CaptureConfig.ScheduleWindow(days: [6], startMinute: 23 * 60, endMinute: 7 * 60)
        let mac = try Mac(wall: Date(timeIntervalSince1970: 1_792_875_595)) { $0.holds.schedule = [window] }
        mac.run(seconds: 6)
        let hold = try #require(mac.holds.first)
        #expect(hold.sinceWallMs == 1_792_875_600_000)
        // 06:00 CET is eight hours after 23:00 CEST, and an hour before 07:00: still held.
        mac.clock.setWall(Date(timeIntervalSince1970: 1_792_904_400 - 5))
        mac.harness.wallClock.changed()
        mac.run(seconds: 10)
        #expect(mac.state.heldEverything && mac.holds.map(\.occurrenceId) == [hold.occurrenceId])
        // 07:00 CET.
        mac.clock.setWall(Date(timeIntervalSince1970: 1_792_908_000 - 5))
        mac.harness.wallClock.changed()
        mac.run(seconds: 6)
        #expect(!mac.state.heldEverything && mac.holds.isEmpty)

        // The Mac travels: at 2:00 in Paris the next Saturday night it is 20:00 in New York.
        mac.clock.setWall(Date(timeIntervalSince1970: 1_793_494_800))
        mac.harness.wallClock.changed()
        mac.harness.settle()
        #expect(mac.state.heldEverything)
        mac.harness.wallClock.changed(timeZone: TimeZone(identifier: "America/New_York")!)
        mac.harness.settle()
        #expect(!mac.state.heldEverything && mac.holds.isEmpty)
    }

    @Test func aNetworkHoldsWhileTheMacIsOnItAndAMomentAfter() throws {
        let mac = try Mac(networks: [Self.office, Self.home]) { config in
            config.holds.networkKey = Self.key
            config.holds.networks = [Self.officeHash]
        }
        #expect(mac.state.networks == [Self.officeHash, Self.homeHash].sorted())
        #expect(mac.recorder.situations.last?.networks == [Self.officeHash, Self.homeHash].sorted())
        let hold = try #require(mac.holds.first)
        #expect(hold.reason == .network && hold.network == Self.officeHash && mac.holds.count == 1)
        mac.run(seconds: 2)
        #expect(mac.state.microphoneRunId == nil && mac.state.heldEverything)

        // Off the network: a Wi-Fi drop is not leaving it, 10 s is.
        mac.harness.networks.set([Self.home])
        mac.harness.settle()
        #expect(mac.recorder.situations.last?.networks == [Self.homeHash])
        mac.run(seconds: 5)
        #expect(mac.state.heldEverything)
        mac.harness.networks.set([Self.office, Self.home])
        mac.harness.settle()
        mac.run(seconds: 8)
        #expect(mac.holds.map(\.occurrenceId) == [hold.occurrenceId])
        mac.harness.networks.set([])
        mac.harness.settle()
        mac.run(seconds: 9.5)
        #expect(mac.state.heldEverything)
        mac.run(seconds: 1)
        #expect(!mac.state.heldEverything && mac.holds.isEmpty && mac.microphoneRecords)

        // No raw signature ever leaves the helper.
        for event in mac.recorder.all {
            let line = String(decoding: try event.encodedLine(), as: UTF8.self)
            #expect(!line.contains("Router") && !line.contains("192.168.1.1") && !line.contains("aa:bb:cc"))
        }
    }

    @Test func withoutAKeyNoNetworkIsRead() throws {
        let mac = try Mac(networks: [Self.office])
        #expect(mac.state.networks.isEmpty && mac.recorder.situations.isEmpty)
        mac.send(.config(id: "c2", Mac.config { $0.holds.networkKey = Self.key }))
        #expect(mac.recorder.situations.last?.networks == [Self.officeHash])
        mac.send(.config(id: "c3", Mac.config()))
        #expect(mac.recorder.situations.last?.networks == [])
    }

    @Test func aNetworkHoldOutlivesSleepWhileTheNetworkComesBack() throws {
        let mac = try Mac(networks: [Self.office]) { config in
            config.holds.networkKey = Self.key
            config.holds.networks = [Self.officeHash]
        }
        let hold = try #require(mac.holds.first)
        mac.harness.power.send(.willSleep)
        mac.harness.networks.set([])
        mac.harness.settle()
        mac.clock.advance(seconds: 3_600)
        mac.harness.power.send(.didWake)
        mac.harness.settle()
        // Back from sleep, the Wi-Fi is not up yet: the hold waits for it.
        mac.run(seconds: 30)
        #expect(mac.state.heldEverything && mac.holds.map(\.occurrenceId) == [hold.occurrenceId])
        mac.harness.networks.set([Self.office])
        mac.harness.settle()
        mac.run(seconds: 60)
        #expect(mac.holds.map(\.occurrenceId) == [hold.occurrenceId])
    }

    // MARK: Lifting, pausing, sleeping, snapshots

    @Test func aLiftedOccurrenceCapturesUntilItEndsAndTheNextOneHoldsAgain() throws {
        let mac = try Mac(networks: [Self.office]) { $0.holds.screen = true }
        mac.run(seconds: 1)
        mac.harness.screen.set(away: true)
        mac.harness.settle()
        let first = try #require(mac.holds.first?.occurrenceId)
        #expect(mac.state.heldEverything)

        mac.send(.config(id: "lift", Mac.config { config in
            config.holds.screen = true
            config.holds.lifted = [first]
        }))
        #expect(mac.holds.first?.lifted == true && !mac.state.heldEverything)
        mac.run(seconds: 1)
        #expect(mac.microphoneRecords)

        // Another hold that is not lifted still holds.
        mac.send(.config(id: "office", Mac.config { config in
            config.holds.screen = true
            config.holds.lifted = [first]
            config.holds.networkKey = Self.key
            config.holds.networks = [Self.officeHash]
        }))
        #expect(mac.state.heldEverything && mac.holds.count == 2)
        mac.send(.config(id: "lifted", Mac.config { config in
            config.holds.screen = true
            config.holds.lifted = [first]
        }))
        #expect(!mac.state.heldEverything)

        // The screen comes back: that occurrence is over. Away again: a new one, held.
        mac.harness.screen.set(away: false)
        mac.harness.settle()
        #expect(mac.holds.isEmpty)
        mac.harness.screen.set(away: true)
        mac.harness.settle()
        let second = try #require(mac.holds.first)
        #expect(second.occurrenceId != first && !second.lifted && mac.state.heldEverything)
    }

    @Test func aHoldIsNeverAPauseAndAResumeDuringItOpensNothing() throws {
        let mac = try Mac { $0.holds.screen = true }
        mac.run(seconds: 1)
        mac.harness.screen.set(away: true)
        mac.harness.settle()
        #expect(mac.state.heldEverything && mac.state.paused == PausedState())
        mac.send(.hello(id: "h", client: ClientInfo(name: "core", version: "1")))
        let ready = try #require(mac.recorder.all.compactMap { if case .ready(let ready) = $0 { ready } else { nil } }.last)
        #expect(ready.paused == PausedState())

        mac.send(.resume(id: "r", scope: .all))
        mac.run(seconds: 2)
        #expect(mac.state.microphoneMuted && mac.state.microphoneRunId == nil && mac.hal.taps.isEmpty)

        // The user pauses during the hold; the hold ends; the pause stays.
        mac.send(.pause(id: "p", scope: .all))
        mac.harness.screen.set(away: false)
        mac.harness.settle()
        mac.run(seconds: 1)
        #expect(mac.state.paused == PausedState(microphone: true, systemAudio: true))
        #expect(mac.state.microphoneMuted && mac.state.microphoneRunId == nil)
        mac.send(.resume(id: "r2", scope: .all))
        mac.run(seconds: 1)
        #expect(mac.microphoneRecords)
    }

    @Test func sleepAndWakeEndNoOccurrence() throws {
        let mac = try Mac { $0.holds.screen = true }
        mac.harness.screen.set(away: true)
        mac.harness.settle()
        let hold = try #require(mac.holds.first)
        let saidBefore = mac.recorder.holds.count
        mac.harness.power.send(.willSleep)
        mac.clock.advance(seconds: 600)
        mac.harness.power.send(.didWake)
        mac.harness.settle()
        mac.run(seconds: 1)
        #expect(mac.holds == [hold] && mac.recorder.holds.count == saidBefore)
        #expect(mac.state.heldEverything && mac.state.microphoneRunId == nil)
    }

    @Test func aSnapshotReplaysTheSituationAndTheHoldsBeforeItsAck() throws {
        let mac = try Mac(networks: [Self.office]) { config in
            config.holds.screen = true
            config.holds.networkKey = Self.key
        }
        mac.harness.screen.set(away: true)
        mac.harness.settle()
        mac.recorder.clear()
        mac.send(.snapshot(id: "s"))
        let replies = mac.recorder.all.filter { $0.replyTo == "s" }
        #expect(Array(replies.map(\.type).suffix(3)) == ["situation", "holds", "ack"])
        guard case .situation(let situation) = replies[replies.count - 3], case .holds(let holds) = replies[replies.count - 2] else {
            Issue.record("no situation or holds replayed")
            return
        }
        #expect(situation.screenAway && situation.networks == [Self.officeHash])
        #expect(holds.holds.map(\.reason) == [.screen])
    }

    // MARK: What a hold drops

    @Test func aHoldDropsWhatTheRingHeldAfterItsTrigger() throws {
        let mac = try Mac { $0.holds.screen = true }
        mac.run(seconds: 2)
        let before = try #require(mac.engine.queue.sync { mac.engine.mic?.processor.nextSampleIndex })
        // One second reached the ring and was not drained; the screen went away half-way.
        mac.deliverMicrophone(frames: 48_000)
        mac.clock.advance(seconds: 0.5)
        mac.harness.screen.set(away: true)
        mac.clock.advance(seconds: 0.5)
        mac.harness.settle()
        let close = try #require(mac.recorder.trackCloses.last { $0.trackKey == Self.micTrack })
        #expect(close.reason == .held)
        #expect(abs(close.endSample - (before + 8_000)) <= 64)
    }

    @Test func aHoldSilencesWhatItsTriggerFollowedAndWasNotCommitted() throws {
        let mac = try Mac { $0.holds.screen = true }
        mac.run(seconds: 0.5)
        let seen = mac.clock.anchor()
        // A drain ran before the engine got to the change: 1 s after it is in the commit buffer.
        mac.run(seconds: 1)
        mac.engine.queue.sync { mac.engine.screenChanged(true, at: seen) }
        mac.harness.settle()
        let close = try #require(mac.recorder.trackCloses.last { $0.trackKey == Self.micTrack })
        #expect(close.reason == .held && close.endSample >= 23_000)
        let silenced = try #require(mac.engine.queue.sync { mac.engine.mic?.processor.droppedAtHold.pendingSamples })
        #expect(abs(silenced - (close.endSample - 8_000)) <= 64)
        mac.engine.stop()
        let pcm = try AppTapsTests.pcm(root: mac.harness.directory.url.appending(path: "spool", directoryHint: .isDirectory), trackKey: Self.micTrack)
        #expect(pcm.count == Int(close.endSample))
        #expect(pcm.prefix(7_900).contains { $0 != 0 })
        #expect(pcm.dropFirst(8_100).allSatisfy { $0 == 0 })
    }

    // MARK: Pure logic

    @Test func aWindowAcrossMidnightBelongsToItsStartDay() {
        let schedule = HoldSchedule(windows: [.init(days: [5], startMinute: 23 * 60, endMinute: 7 * 60)], timeZone: Self.paris)
        // Saturday 01:00: Friday's window. Saturday 23:30: none (Saturday is not a day of it).
        let saturdayNight = Date(timeIntervalSince1970: 1_794_614_400)
        #expect(schedule.active(at: saturdayNight).count == 1)
        #expect(schedule.active(at: saturdayNight.addingTimeInterval(22.5 * 3_600)).isEmpty)
        #expect(schedule.nextBoundary(after: saturdayNight) == Date(timeIntervalSince1970: 1_794_636_000))
    }

    @Test func windowsFollowTheClockOnTheWallAcrossDSTChanges() {
        let night = CaptureConfig.ScheduleWindow(days: [6], startMinute: 23 * 60, endMinute: 7 * 60)
        let schedule = HoldSchedule(windows: [night], timeZone: Self.paris)
        // Autumn: 23:00 CEST to 07:00 CET is nine hours.
        let autumn = schedule.active(at: Date(timeIntervalSince1970: 1_792_904_400))
        #expect(autumn.map(\.start) == [Date(timeIntervalSince1970: 1_792_875_600)])
        #expect(autumn.map(\.end) == [Date(timeIntervalSince1970: 1_792_908_000)])
        // Spring (2027-03-27): 23:00 CET to 07:00 CEST is seven hours.
        let spring = schedule.active(at: Date(timeIntervalSince1970: 1_806_188_400))
        #expect(spring.map { $0.end.timeIntervalSince($0.start) } == [7 * 3_600])
        // 02:30 does not exist that night: a window from it starts at 03:00 CEST.
        let skipped = HoldSchedule(windows: [.init(days: [0], startMinute: 150, endMinute: 240)], timeZone: Self.paris)
        let start = skipped.nextBoundary(after: Date(timeIntervalSince1970: 1_806_188_400))
        #expect(start == Date(timeIntervalSince1970: 1_806_195_600))
    }

    @Test func aWindowsOccurrenceIsTheSameWheneverItIsLookedAt() {
        let window = CaptureConfig.ScheduleWindow(days: [5, 6], startMinute: 23 * 60, endMinute: 7 * 60)
        let schedule = HoldSchedule(windows: [window, window], timeZone: Self.paris)
        let early = schedule.active(at: Date(timeIntervalSince1970: 1_794_607_300))
        let late = schedule.active(at: Date(timeIntervalSince1970: 1_794_630_000))
        #expect(early.count == 1 && early.first?.window == 0)
        #expect(early.map(\.occurrenceId) == late.map(\.occurrenceId))
        let next = schedule.active(at: Date(timeIntervalSince1970: 1_794_607_300 + 86_400))
        #expect(next.count == 1 && next.first?.occurrenceId != early.first?.occurrenceId)
        #expect(early.first.map { WireText.isUuid($0.occurrenceId) } == true)
    }

    @Test func networkHashesMatchTheSharedVectors() throws {
        let lines = try CapturePaths.lines("vectors/network-hash.jsonl")
        #expect(!lines.isEmpty)
        for line in lines {
            let vector = try #require(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: String])
            let key = try #require(vector["key"].flatMap { Data(base64Encoded: $0) })
            #expect(NetworkHashing.hash(signature: try #require(vector["signature"]), key: key) == vector["hash"])
        }
    }
}
