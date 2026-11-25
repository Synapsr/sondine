import Foundation
import SondinePhone
import Synchronization
import Testing

/// The Live Activity as the app's ActivityKit adapter would receive it.
final class FakeActivity: LiveActivityPresenting, @unchecked Sendable {
    enum Call: Equatable {
        case start(LiveActivityDisplay)
        case update(LiveActivityDisplay)
        case end
    }

    private let state = Mutex((calls: [Call](), starts: 0, allowed: Int?.none))
    /// `allowed`: how many starts iOS accepts (nil: all; 0: Live Activities turned off).
    init(allowed: Int? = nil) { state.withLock { $0.allowed = allowed } }

    func start(_ display: LiveActivityDisplay) async -> Bool {
        state.withLock {
            $0.calls.append(.start(display))
            $0.starts += 1
            let starts = $0.starts
            return $0.allowed.map { $0 >= starts } ?? true
        }
    }

    func update(_ display: LiveActivityDisplay) async { state.withLock { $0.calls.append(.update(display)) } }
    func end() async { state.withLock { $0.calls.append(.end) } }
    func refuseFromNow() { state.withLock { $0.allowed = $0.starts } }
    var calls: [Call] { state.withLock { $0.calls } }
    var starts: Int { state.withLock { $0.starts } }
}

final class FakeControlState: ControlStatePublishing, @unchecked Sendable {
    private let state = Mutex<[(ControlState, Bool)]>([])
    func publish(_ value: ControlState, changed: Bool) { state.withLock { $0.append((value, changed)) } }
    var last: ControlState? { state.withLock { $0.last?.0 } }
    var reloads: Int { state.withLock { $0.count(where: \.1) } }
}

/// The recorder with what shows it outside the app, as the app wires them.
struct Gestures {
    let rig: Rig
    let activity: FakeActivity
    let control = FakeControlState()
    let presence: RecordingPresence
    let gesture: RecordingControl

    init(activity: FakeActivity = FakeActivity(), configure: (inout PhoneRecorder.Configuration) -> Void = { _ in }) throws {
        rig = try Rig(configure: configure)
        self.activity = activity
        presence = RecordingPresence(
            recorder: rig.recorder, activity: activity, control: control, notifier: rig.notifications, clock: rig.clock)
        gesture = RecordingControl(recorder: rig.recorder, presence: presence, notifier: rig.notifications)
    }

    func set(_ on: Bool, _ context: RecordingControl.Context = .background(canOpenApp: true)) async -> RecordingControl.Outcome {
        await gesture.set(recording: on, context: context)
    }
}

@Suite struct RecordingControlTests {
    @Test func onStartsOnAgainChangesNothingOffStopsAsArreterDoes() async throws {
        let g = try Gestures()
        #expect(await g.set(true) == .started)
        // The Live Activity is up before the gesture returns.
        #expect(g.activity.starts == 1)
        await g.rig.speak(seconds: 2)
        #expect(await g.set(true) == .unchanged)
        #expect(await g.set(false, .background(canOpenApp: false)) == .stopped)
        await g.rig.recorder.settle()
        #expect(await g.rig.phase() == .idle)
        #expect(!g.rig.session.isActive)
        #expect(g.activity.calls.last == .end)
        // Stopped from the Lock Screen, the file is closed as « Arrêter » closes it.
        let recording = try #require(g.rig.recordings().first)
        #expect(recording.end == .stopped)
        #expect(recording.samples == 2 * phoneSampleRate)
        #expect(await g.set(false, .app) == .unchanged)
        #expect(g.rig.notifications.all.isEmpty)
    }

    @Test func onAfterAnInterruptionResumesTheSessionAndOffEndsIt() async throws {
        let g = try Gestures()
        try await g.rig.recorder.start()
        await g.presence.refresh()
        await g.rig.speak(seconds: 1)
        await g.rig.recorder.handle(.interruptionBegan(.call))
        #expect(await g.set(true) == .resumed)
        guard case let .recording(state) = await g.rig.phase() else { Issue.record("not resumed"); return }
        #expect(state.part == 2)
        await g.rig.recorder.handle(.interruptionBegan(.other))
        #expect(await g.set(false) == .stopped)
        #expect(await g.rig.phase() == .idle)
    }

    @Test func iOSRefusingTheMicrophoneInTheBackgroundOpensTheApp() async throws {
        let g = try Gestures()
        g.rig.session.failActivation("privacy block")
        #expect(await g.set(true) == .openApp(.session("activationFailed(\"privacy block\")")))
        // The app comes to the front and asks again: there it starts.
        g.rig.session.failActivation(nil)
        #expect(await g.set(true, .app) == .started)
        #expect(g.rig.notifications.all.isEmpty)
        await g.rig.recorder.stop()
    }

    @Test func whenTheAppCannotBeOpenedANotificationSaysWhy() async throws {
        let g = try Gestures()
        g.rig.session.failActivation("privacy block")
        let refusal = PhoneRecorder.StartRefusal.session("activationFailed(\"privacy block\")")
        #expect(await g.set(true, .background(canOpenApp: false)) == .refused(refusal))
        #expect(g.rig.notifications.all == [.couldNotStart(refusal)])
        #expect(await g.rig.phase() == .idle)
        // In front, the app's own screen says it: no notification.
        #expect(await g.set(true, .app) == .refused(refusal))
        #expect(g.rig.notifications.all.count == 1)
    }

    @Test func aRefusalTheAppCannotOvercomeIsSaidAtOnce() async throws {
        let g = try Gestures()
        g.rig.disk.set(400_000_000)
        #expect(await g.set(true) == .refused(.lowSpace(available: 400_000_000)))
        #expect(g.rig.notifications.all == [.couldNotStart(.lowSpace(available: 400_000_000))])
        #expect(RecordingControl.needsApp(.noPermission))
        #expect(!RecordingControl.needsApp(.files("x")))
    }

    @Test func withLiveActivitiesOffAStartFromTheLockScreenStopsAndOpensTheApp() async throws {
        let g = try Gestures(activity: FakeActivity(allowed: 0))
        // iOS would cut a microphone started out of sight with nothing showing it.
        #expect(await g.set(true) == .openApp(.noLiveActivity))
        await g.rig.recorder.settle()
        #expect(await g.rig.phase() == .idle)
        #expect(!g.rig.session.isActive)
        // In front, the app records without one.
        #expect(await g.set(true, .app) == .started)
        guard case .recording = await g.rig.phase() else { Issue.record("not recording"); return }
        await g.rig.recorder.stop()
        // And when the app cannot come to the front, the notification says it.
        #expect(await g.set(true, .background(canOpenApp: false)) == .refused(.noLiveActivity))
        #expect(g.rig.notifications.all == [.couldNotStart(.noLiveActivity)])
        #expect(await g.rig.phase() == .idle)
    }

    @Test func withoutItsDeviceIdTheRecorderRefusesRatherThanMakeOneUp() async throws {
        final class Readable: Sendable { let id = Mutex<UUID?>(nil) }
        let readable = Readable()
        let g = try Gestures { $0.deviceId = { readable.id.withLock { $0 } } }
        #expect(await g.set(true, .background(canOpenApp: false)) == .refused(.locked))
        #expect(g.rig.notifications.all == [.couldNotStart(.locked)])
        #expect(g.rig.recordings().isEmpty)
        #expect(RecordingControl.needsApp(.locked))
        // Once readable, the recording carries it.
        let known = UUID()
        readable.id.withLock { $0 = known }
        #expect(await g.set(true) == .started)
        await g.rig.speak(seconds: 1)
        await g.rig.recorder.stop()
        #expect(g.rig.recordings().first?.header.deviceId == known)
    }
}

@Suite struct LiveActivityPlanTests {
    let start: Int64 = 1_793_442_720_000
    let session = UUID()

    func recording(elapsedMs: Int64) -> PhoneRecorder.Phase {
        .recording(PhoneRecorder.Recording(
            sessionId: session, recordingId: UUID(), part: 1, startedAtMs: start,
            samples: Int(elapsedMs) * phoneSampleRate / 1000, levelDbfs: -20, route: .builtIn))
    }

    func interrupted(atMs: Int64, recordedMs: Int64) -> PhoneRecorder.Phase {
        .interrupted(PhoneRecorder.Interrupted(
            sessionId: session, atMs: atMs, cause: .call, samples: Int(recordedMs) * phoneSampleRate / 1000,
            resumeFailed: false))
    }

    @Test func startsWithRecordingAndMovesOnlyWhenItMust() {
        var plan = LiveActivityPlan()
        let stale = LiveActivityPlan.staleAfterMs
        #expect(plan.next(recording(elapsedMs: 0), nowMs: start) == [
            .start(LiveActivityDisplay(state: .recording, countsFromMs: start, staleAtMs: start + stale)),
        ])
        // Blocks arriving: the counter iOS draws is right, nothing to send.
        #expect(plan.next(recording(elapsedMs: 900), nowMs: start + 1_000) == [])
        #expect(plan.next(recording(elapsedMs: 60_000), nowMs: start + 60_500) == [])
        // Every 2 minutes the activity is said again, its out-of-date time moved on.
        let now = start + LiveActivityPlan.refreshMs
        #expect(plan.next(recording(elapsedMs: LiveActivityPlan.refreshMs), nowMs: now) == [
            .update(LiveActivityDisplay(state: .recording, countsFromMs: start, staleAtMs: now + stale)),
        ])
        #expect(plan.next(.idle, nowMs: now + 1) == [.end])
        #expect(plan.next(.idle, nowMs: now + 2) == [])
    }

    @Test func anInterruptionStopsTheCounterWithNoStaleDateAndResumingCountsOn() {
        var plan = LiveActivityPlan()
        _ = plan.next(recording(elapsedMs: 0), nowMs: start)
        let at = start + 10_000
        // Nothing is expected from the app while interrupted: no « no longer answers » however long it lasts.
        #expect(plan.next(interrupted(atMs: at, recordedMs: 10_000), nowMs: at) == [
            .update(LiveActivityDisplay(state: .interrupted(atMs: at, cause: .call), countsFromMs: start, staleAtMs: nil)),
        ])
        #expect(plan.next(interrupted(atMs: at, recordedMs: 10_000), nowMs: at + 3_600_000) == [])
        // Resumed an hour later: the counter goes on from 10 s, not from the session's start.
        let back = at + 3_600_000
        #expect(plan.next(recording(elapsedMs: 10_000), nowMs: back) == [
            .update(LiveActivityDisplay(
                state: .recording, countsFromMs: back - 10_000, staleAtMs: back + LiveActivityPlan.staleAfterMs)),
        ])
    }

    @Test func nearEightHoursANewActivityTakesOver() {
        var plan = LiveActivityPlan()
        _ = plan.next(recording(elapsedMs: 0), nowMs: start)
        let rollover = start + LiveActivityPlan.rolloverMs
        let steps = plan.next(recording(elapsedMs: LiveActivityPlan.rolloverMs), nowMs: rollover)
        #expect(steps == [.rollover(LiveActivityDisplay(
            state: .recording, countsFromMs: start, staleAtMs: rollover + LiveActivityPlan.staleAfterMs))])
        // The new one has its own 8 hours.
        #expect(plan.next(recording(elapsedMs: LiveActivityPlan.afterLimitMs), nowMs: start + LiveActivityPlan.afterLimitMs)
            .allSatisfy { if case .update = $0 { true } else { false } })
        #expect(plan.isShowing)
        let second = rollover + LiveActivityPlan.rolloverMs
        #expect(plan.next(recording(elapsedMs: second - start), nowMs: second).count == 1)
    }

    @Test func aRefusedRolloverWaitsForIOSAndSaysTheRecordingGoesOnOnlyAfter() {
        var plan = LiveActivityPlan()
        _ = plan.next(recording(elapsedMs: 0), nowMs: start)
        let rollover = start + LiveActivityPlan.rolloverMs
        #expect(plan.next(recording(elapsedMs: LiveActivityPlan.rolloverMs), nowMs: rollover).count == 1)
        plan.rolloverRefused()
        // The old activity runs to iOS's end; nothing is said yet.
        let limit = start + LiveActivityPlan.iosLimitMs
        #expect(!plan.next(recording(elapsedMs: LiveActivityPlan.iosLimitMs), nowMs: limit).contains {
            if case .retire = $0 { true } else { false }
        })
        // A minute after, the recording truly went on: now it is said, once.
        let after = start + LiveActivityPlan.afterLimitMs
        #expect(plan.next(recording(elapsedMs: LiveActivityPlan.afterLimitMs), nowMs: after) == [.retire(sinceMs: start)])
        #expect(!plan.isShowing)
        #expect(plan.next(recording(elapsedMs: LiveActivityPlan.afterLimitMs + 600_000), nowMs: after + 600_000) == [])
        // Stopped, then a new recording: a new activity.
        #expect(plan.next(.idle, nowMs: after + 700_000) == [])
        #expect(plan.next(recording(elapsedMs: 0), nowMs: after + 800_000).count == 1)
    }

    @Test func ifIOSStoppedTheRecordingWithItsActivityNothingClaimsItGoesOn() {
        var plan = LiveActivityPlan()
        _ = plan.next(recording(elapsedMs: 0), nowMs: start)
        _ = plan.next(recording(elapsedMs: LiveActivityPlan.rolloverMs), nowMs: start + LiveActivityPlan.rolloverMs)
        plan.rolloverRefused()
        // iOS cut the microphone with the activity: an interruption, which has its own notification.
        let limit = start + LiveActivityPlan.iosLimitMs
        _ = plan.next(interrupted(atMs: limit, recordedMs: LiveActivityPlan.iosLimitMs), nowMs: limit)
        let after = start + LiveActivityPlan.afterLimitMs
        #expect(plan.next(interrupted(atMs: limit, recordedMs: LiveActivityPlan.iosLimitMs), nowMs: after) == [.end])
    }

    @Test func anotherSessionReplacesTheActivity() {
        var plan = LiveActivityPlan()
        _ = plan.next(recording(elapsedMs: 0), nowMs: start)
        let other = PhoneRecorder.Phase.recording(PhoneRecorder.Recording(
            sessionId: UUID(), recordingId: UUID(), part: 1, startedAtMs: start + 5_000, samples: 0,
            levelDbfs: -20, route: .builtIn))
        let steps = plan.next(other, nowMs: start + 5_000)
        #expect(steps.first == LiveActivityPlan.Step.end)
        #expect(steps.count == 2)
    }

    @Test func liveActivitiesTurnedOffMeanNoneForTheSession() {
        var plan = LiveActivityPlan()
        #expect(plan.next(recording(elapsedMs: 0), nowMs: start).count == 1)
        plan.activityRefused()
        #expect(!plan.isShowing)
        #expect(plan.next(recording(elapsedMs: 300_000), nowMs: start + 300_000) == [])
        let later = start + LiveActivityPlan.afterLimitMs
        #expect(plan.next(recording(elapsedMs: LiveActivityPlan.afterLimitMs), nowMs: later) == [])
    }
}

@Suite struct RecordingPresenceTests {
    /// Hours with the screen locked: a block now and then keeps the presence refreshed.
    func pass(_ g: Gestures, untilMs end: Int64) async {
        while g.rig.clock.nowMs() < end {
            g.rig.clock.advance(ms: LiveActivityPlan.refreshMs - 100)
            await g.rig.speak(seconds: 0.1)
            await g.presence.refresh()
        }
    }

    @Test func aRecordingLongerThanEightHoursKeepsALiveActivity() async throws {
        let g = try Gestures()
        let startedAt = g.rig.clock.nowMs()
        #expect(await g.set(true) == .started)
        #expect(g.control.last == ControlState(recording: true, updatedAtMs: startedAt))
        #expect(g.control.reloads == 1)
        await pass(g, untilMs: startedAt + LiveActivityPlan.rolloverMs + 1)
        // A new activity took over before iOS's limit; the old one went with it (the adapter ends it).
        #expect(g.activity.starts == 2)
        #expect(!g.activity.calls.contains(.end))
        #expect(g.rig.notifications.all.isEmpty)
        // The control keeps believing it: said again every 2 minutes, never reloaded.
        #expect(g.control.last?.isRecording(nowMs: g.rig.clock.nowMs()) == true)
        #expect(g.control.reloads == 1)

        #expect(await g.set(false, .background(canOpenApp: false)) == .stopped)
        await g.rig.recorder.settle()
        #expect(g.control.last?.recording == false)
        #expect(g.control.reloads == 2)
        #expect(g.activity.calls.last == .end)
        #expect(g.rig.recordings().last?.end == .stopped)
    }

    @Test func whenIOSRefusesTheNextActivityTheRecordingGoesOnAndIsSaidSo() async throws {
        let g = try Gestures()
        let startedAt = g.rig.clock.nowMs()
        #expect(await g.set(true) == .started)
        g.activity.refuseFromNow()
        await pass(g, untilMs: startedAt + LiveActivityPlan.iosLimitMs)
        #expect(g.activity.starts == 2)
        #expect(g.rig.notifications.all.isEmpty)
        await pass(g, untilMs: startedAt + LiveActivityPlan.afterLimitMs)
        #expect(g.activity.calls.last == .end)
        #expect(g.rig.notifications.all == [.continues(sinceMs: startedAt)])

        // And it does go on: samples are still written, and no new activity is tried.
        guard case let .recording(before) = await g.rig.phase() else { Issue.record("stopped"); return }
        await g.rig.speak(seconds: 1)
        await g.presence.refresh()
        guard case let .recording(after) = await g.rig.phase() else { Issue.record("stopped"); return }
        #expect(after.samples == before.samples + phoneSampleRate)
        #expect(g.activity.starts == 2)
        await g.rig.recorder.stop()
    }

    @Test func aKilledAppLeavesNoActivityAndTheControlStopsBelievingIt() async throws {
        let g = try Gestures()
        let now = g.rig.clock.nowMs()
        // What a killed recording left: the control said « recording » 6 minutes ago.
        #expect(!ControlState(recording: true, updatedAtMs: now - 360_000).isRecording(nowMs: now))
        #expect(ControlState(recording: true, updatedAtMs: now - 60_000).isRecording(nowMs: now))
        await g.presence.clearLeftovers()
        #expect(g.activity.calls == [.end])
        #expect(g.control.last == ControlState(recording: false, updatedAtMs: now))
    }

    @Test func aGestureThatLaunchedTheAppKeepsItsActivity() async throws {
        let g = try Gestures()
        // The control launched the app in the background and started before the launch's cleanup ran.
        #expect(await g.set(true) == .started)
        await g.presence.clearLeftovers()
        #expect(g.activity.starts == 1)
        #expect(!g.activity.calls.contains(.end))
        await g.rig.recorder.stop()
    }

    @Test func liveActivitiesTurnedOffStillRecordFromTheApp() async throws {
        let g = try Gestures(activity: FakeActivity(allowed: 0))
        #expect(await g.set(true, .app) == .started)
        g.rig.clock.advance(ms: LiveActivityPlan.afterLimitMs)
        await g.rig.speak(seconds: 1)
        await g.presence.refresh()
        #expect(g.activity.starts == 1)
        #expect(g.rig.notifications.all.isEmpty)
        guard case .recording = await g.rig.phase() else { Issue.record("stopped"); return }
        await g.rig.recorder.stop()
    }
}

/// `device.json` is « complete »: unreadable while the phone is locked.
final class LockableReader: FileReading, @unchecked Sendable {
    private let locked = Mutex<Set<String>>([])
    /// Files that cannot be read now, by name.
    func lock(_ names: Set<String>) { locked.withLock { $0 = names } }

    func read(_ url: URL) throws(FileLocked) -> Data? {
        guard FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) else { return nil }
        if locked.withLock({ $0.contains(url.lastPathComponent) }) { throw FileLocked() }
        return try? Data(contentsOf: url)
    }
}

@Suite struct DeviceIdentityTests {
    let mac = PairedMac(macId: UUID(), pin: "ab", name: "Sondine K7Q2", port: 7_420, addrs: [], pairedAtMs: 1)

    @Test func aLockedLaunchKeepsTheRealIdAndReadsThePairingOnceUnlocked() throws {
        let root = try scratch()
        let paired = DeviceStore(root: root)
        let id = try #require(paired.deviceId)
        try paired.update { $0.mac = mac }

        // Killed, then launched by the control with the phone locked.
        let reader = LockableReader()
        reader.lock(["device.json"])
        let device = DeviceStore(root: root, reader: reader)
        #expect(device.deviceId == id)
        #expect(device.file.mac == nil)
        #expect(device.file.deviceId == id)
        #expect(throws: FileLocked.self) { try device.update { $0.lastMacId = UUID() } }

        // Unlocked: nothing guessed was kept.
        reader.lock([])
        #expect(device.file.mac == mac)
        #expect(device.deviceId == id)
    }

    @Test func anInstallFromBeforeTheIdFileNeverMakesUpAnIdWhileLocked() throws {
        let root = try scratch()
        let old = DeviceFile(deviceId: UUID())
        try JSONEncoder().encode(old).write(to: root.appending(path: "device.json"))

        let reader = LockableReader()
        reader.lock(["device.json"])
        let device = DeviceStore(root: root, reader: reader)
        #expect(device.deviceId == nil)
        #expect(!FileManager.default.fileExists(atPath: device.idURL.path(percentEncoded: false)))

        reader.lock([])
        #expect(device.deviceId == old.deviceId)
        // Kept in its own file, readable from the first unlock on.
        reader.lock(["device.json"])
        #expect(DeviceStore(root: root, reader: reader).deviceId == old.deviceId)
    }

    @Test func aNewInstallMakesOneIdAndKeepsIt() throws {
        let root = try scratch()
        let protection = ProtectionSpy()
        let device = DeviceStore(root: root, protection: protection)
        let id = try #require(device.deviceId)
        #expect(device.file.deviceId == id)
        #expect(protection["device-id"] == .untilFirstUnlock)
        #expect(protection["device.json"] == .complete)
        #expect(DeviceStore(root: root).deviceId == id)
        #expect(DeviceStore(root: root).file.deviceId == id)
    }

    @Test func beforeTheFirstUnlockNothingIsKnown() throws {
        let root = try scratch()
        _ = DeviceStore(root: root).file
        let reader = LockableReader()
        reader.lock(["device.json", "device-id"])
        #expect(DeviceStore(root: root, reader: reader).deviceId == nil)
    }
}
