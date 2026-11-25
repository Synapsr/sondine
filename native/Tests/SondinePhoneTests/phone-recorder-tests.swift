import Foundation
import SondinePhone
import Synchronization
import Testing

@Suite struct PhoneRecorderTests {
    @Test func recordsOneFileUntilStopped() async throws {
        let rig = try Rig()
        try await rig.recorder.start()
        #expect(rig.session.isActive)
        await rig.speak(seconds: 3)
        guard case let .recording(state) = await rig.phase() else { Issue.record("not recording"); return }
        #expect(state.samples == 3 * phoneSampleRate)
        #expect(state.elapsedMs == 3_000)
        // A sine at a quarter of full scale: −15.3 dBFS.
        #expect(state.levelDbfs > -16 && state.levelDbfs < -14)
        await rig.recorder.stop()
        await rig.recorder.settle()
        #expect(await rig.phase() == .idle)
        #expect(!rig.session.isActive)
        #expect(!rig.microphone.isRunning)
        let recordings = rig.recordings()
        #expect(recordings.count == 1)
        let first = try #require(recordings.first)
        #expect(first.header.part == 1)
        #expect(first.header.previous == nil)
        #expect(first.header.startedWallMs == 1_793_442_720_000)
        #expect(first.header.utcOffsetMin == 60)
        #expect(first.end == .stopped)
        #expect(first.samples == 3 * phoneSampleRate)
        #expect(rig.notifications.all.isEmpty)
    }

    @Test func aCallClosesTheFileAndResumingMakesTheNextOneOfTheSession() async throws {
        let rig = try Rig()
        rig.session.send(.routeChanged(.builtIn))
        try await rig.recorder.start()
        await rig.speak(seconds: 2)
        await rig.recorder.handle(.interruptionBegan(.call))
        let interruptedAt = rig.clock.nowMs()
        guard case let .interrupted(state) = await rig.phase() else { Issue.record("not interrupted"); return }
        #expect(state.cause == .call)
        #expect(state.atMs == interruptedAt)
        #expect(!rig.microphone.isRunning)
        // Never a silent hole: the user is told.
        #expect(rig.notifications.all == [.interrupted(atMs: interruptedAt, cause: .call)])
        // Samples iOS still delivers while interrupted are not written anywhere.
        #expect(!rig.microphone.push(tone(hertz: 440, from: 0, count: 1_600)))

        rig.clock.advance(ms: 60_000)
        await rig.recorder.handle(.interruptionEnded(shouldResume: true))
        guard case let .recording(resumed) = await rig.phase() else { Issue.record("not resumed"); return }
        #expect(resumed.part == 2)
        #expect(resumed.sessionId == state.sessionId)
        await rig.speak(seconds: 1)
        await rig.recorder.stop()
        await rig.recorder.settle()

        let recordings = rig.recordings()
        #expect(recordings.map(\.header.part) == [1, 2])
        #expect(recordings.map(\.end) == [.interruption, .stopped])
        #expect(recordings.map(\.samples) == [2 * phoneSampleRate, phoneSampleRate])
        #expect(recordings[1].header.previous == .interruption)
        #expect(recordings[1].header.sessionId == recordings[0].header.sessionId)
        #expect(recordings[1].header.recordingId != recordings[0].header.recordingId)
        // The second file starts when it did, a minute after the first ended.
        #expect(recordings[1].header.startedWallMs == interruptedAt + 60_000)
    }

    @Test func whenIOSDoesNotRecommendResumingTheUserResumes() async throws {
        let rig = try Rig()
        try await rig.recorder.start()
        await rig.speak(seconds: 1)
        await rig.recorder.handle(.interruptionBegan(.other))
        await rig.recorder.handle(.interruptionEnded(shouldResume: false))
        guard case .interrupted = await rig.phase() else { Issue.record("resumed alone"); return }
        try await rig.recorder.resume()
        guard case let .recording(state) = await rig.phase() else { Issue.record("not resumed"); return }
        #expect(state.part == 2)
        await rig.recorder.stop()
    }

    @Test func aFailedReactivationWaitsForTheUser() async throws {
        let rig = try Rig()
        try await rig.recorder.start()
        await rig.speak(seconds: 1)
        await rig.recorder.handle(.interruptionBegan(.other))
        rig.session.failActivation("cannot activate from the background")
        await rig.recorder.handle(.interruptionEnded(shouldResume: true))
        guard case let .interrupted(state) = await rig.phase() else { Issue.record("not interrupted"); return }
        #expect(state.resumeFailed)
        #expect(rig.notifications.all.count == 1)
        await #expect(throws: PhoneRecorder.StartRefusal.self) { try await rig.recorder.resume() }
        rig.session.failActivation(nil)
        try await rig.recorder.resume()
        guard case .recording = await rig.phase() else { Issue.record("not resumed"); return }
        await rig.recorder.stop()
        await rig.recorder.settle()
        #expect(rig.recordings().map(\.end) == [.interruption, .stopped])
    }

    @Test func anotherMicrophoneStartsTheNextFileWithItsKind() async throws {
        let rig = try Rig()
        try await rig.recorder.start()
        await rig.speak(seconds: 1)
        // The same kind of microphone: the file goes on.
        await rig.recorder.handle(.routeChanged(AudioRoute(kind: .builtIn)))
        await rig.speak(seconds: 1)
        await rig.recorder.handle(.routeChanged(AudioRoute(kind: .bluetooth, name: "AirPods")))
        guard case let .recording(state) = await rig.phase() else { Issue.record("stopped"); return }
        #expect(state.route.name == "AirPods")
        await rig.speak(seconds: 1)
        await rig.recorder.stop()
        await rig.recorder.settle()
        let recordings = rig.recordings()
        #expect(recordings.map(\.header.input) == [.builtIn, .bluetooth])
        #expect(recordings.map(\.end) == [.route, .stopped])
        #expect(recordings.map(\.samples) == [2 * phoneSampleRate, phoneSampleRate])
        #expect(recordings[1].header.previous == .interruption)
        // The switch is announced by the next file itself, not by a notification.
        #expect(rig.notifications.all.isEmpty)
    }

    @Test func threeHoursRotateToTheNextFileWithNoSampleLost() async throws {
        let writers = CountingWriters()
        let rig = try Rig(writers: writers)
        try await rig.recorder.start()
        // 3 h 10 in blocks that do not divide 3 hours: one straddles the rotation.
        let block = 16_001 * 7
        let total = (3 * 3_600 + 600) * phoneSampleRate
        var pushed = 0
        let samples = [Int16](repeating: 100, count: block)
        while pushed < total {
            let count = min(block, total - pushed)
            rig.microphone.push(count == block ? samples : Array(samples.prefix(count)))
            pushed += count
            if pushed % (block * 64) == 0 { await rig.recorder.settle() }
        }
        await rig.recorder.settle()
        guard case let .recording(state) = await rig.phase() else { Issue.record("stopped"); return }
        #expect(state.samples == total)
        #expect(state.part == 2)
        await rig.recorder.stop()
        await rig.recorder.settle()
        let recordings = rig.recordings()
        #expect(recordings.map(\.samples) == [3 * 3_600 * phoneSampleRate, 600 * phoneSampleRate])
        #expect(writers.all.map(\.samples) == [3 * 3_600 * phoneSampleRate, 600 * phoneSampleRate])
        #expect(writers.all.allSatisfy { $0.finished })
        #expect(recordings.map(\.end) == [.rotation, .stopped])
        #expect(recordings[1].header.previous == .rotation)
        // The next file starts where the first ended, to the millisecond.
        #expect(recordings[1].header.startedWallMs == recordings[0].header.startedWallMs + 10_800_000)
        // A progress line a minute: what a kill leaves in the log.
        let lines = try String(contentsOf: recordings[0].folder.events, encoding: .utf8).split(separator: "\n")
        #expect(lines.count == 1 + 180 + 1)
    }

    @Test func rotatedFilesAreEachReadableWithTheirHeader() async throws {
        let rig = try Rig(writers: AssetPartWriterFactory()) { $0.maxPartSamples = 5 * phoneSampleRate }
        try await rig.recorder.start()
        await rig.speak(seconds: 12)
        await rig.recorder.stop()
        await rig.recorder.settle()
        let recordings = rig.recordings()
        #expect(recordings.map(\.header.part) == [1, 2, 3])
        var seconds: [Double] = []
        for recording in recordings {
            let info = try afinfo(recording.folder.audio)
            seconds.append(info.seconds)
            let comment = try #require(info.comment)
            #expect(try PhoneRecordingHeader.decode(comment) == recording.header)
        }
        #expect(seconds == [5, 5, 2])
        #expect(recordings.map(\.header.previous) == [nil, .rotation, .rotation])
    }

    @Test func refusesToStartUnder1GBAndStopsCleanlyUnder200MB() async throws {
        let rig = try Rig()
        rig.disk.set(900_000_000)
        await #expect(throws: PhoneRecorder.StartRefusal.lowSpace(available: 900_000_000)) {
            try await rig.recorder.start()
        }
        #expect(!rig.session.isActive)
        #expect(rig.recordings().isEmpty)

        rig.disk.set(2_000_000_000)
        try await rig.recorder.start()
        await rig.speak(seconds: 10)
        rig.disk.set(400_000_000)
        await rig.speak(seconds: 10)
        guard case let .recording(state) = await rig.phase() else { Issue.record("stopped"); return }
        #expect(state.lowSpaceBytes == 400_000_000)
        rig.disk.set(150_000_000)
        await rig.speak(seconds: 10)
        await rig.recorder.settle()
        let snapshot = await rig.recorder.snapshot
        #expect(snapshot.phase == .idle)
        #expect(snapshot.lastStop?.end == .lowSpace)
        #expect(!rig.session.isActive)
        #expect(rig.notifications.all == [.stopped(atMs: rig.clock.nowMs(), end: .lowSpace)])
        let recording = try #require(rig.recordings().first)
        #expect(recording.end == .lowSpace)
        #expect(recording.samples == 30 * phoneSampleRate)
    }

    @Test func aFullDiskWhileWritingStopsAndSaysSo() async throws {
        let writers = CountingWriters()
        writers.failAfter.withLock { $0 = 5 * phoneSampleRate }
        let rig = try Rig(writers: writers)
        try await rig.recorder.start()
        await rig.speak(seconds: 8)
        await rig.recorder.settle()
        let snapshot = await rig.recorder.snapshot
        #expect(snapshot.phase == .idle)
        #expect(snapshot.lastStop?.end == .writeFailed)
        #expect(rig.notifications.all.count == 1)
        let recording = try #require(rig.recordings().first)
        #expect(recording.end == .writeFailed)
        #expect(recording.samples == 5 * phoneSampleRate)
    }

    @Test func withoutTheMicrophoneNothingStarts() async throws {
        let rig = try Rig()
        let denied = ScriptedAudioSession(permission: false)
        let recorder = PhoneRecorder(
            store: rig.store, session: denied, microphone: rig.microphone, writers: CountingWriters(), disk: rig.disk,
            clock: rig.clock, notifier: rig.notifications,
            configuration: .init(deviceId: UUID(), appVersion: "0.1.0 (12)"))
        await #expect(throws: PhoneRecorder.StartRefusal.noPermission) { try await recorder.start() }
        #expect(rig.recordings().isEmpty)
    }

    @Test func aKilledRecordingIsFoundAtTheNextLaunchAndSaidOnce() async throws {
        let rig = try Rig()
        try await rig.recorder.start()
        await rig.speak(seconds: 70)
        // The app dies here: nothing closes the file or its log.
        let open = await rig.recorder.openRecordingIds
        #expect(open.count == 1)
        // While it records, it is not taken for a killed one.
        #expect(await rig.recorder.reconcile().isEmpty)
        #expect(rig.recordings().first?.end == nil)

        let relaunched = try RecordingStore(root: rig.root)
        let killed = relaunched.reconcile(recording: [], nowMs: rig.clock.nowMs())
        #expect(killed.count == 1)
        let recording = try #require(relaunched.list().first)
        #expect(recording.end == .killed)
        // The log kept its length to the last minute.
        #expect(recording.samples == 60 * phoneSampleRate)
        #expect(recording.killNoticePending)
        try relaunched.noticeSeen(recording.id)
        #expect(relaunched.list().first?.killNoticePending == false)
        #expect(relaunched.reconcile(recording: [], nowMs: rig.clock.nowMs()).isEmpty)
    }

    @Test func filesBeingRecordedStayWritableLockedAndTheRestDoNot() async throws {
        let spy = ProtectionSpy()
        let rig = try Rig(protection: spy)
        try await rig.recorder.start()
        await rig.speak(seconds: 1)
        let id = try #require(await rig.recorder.openRecordingIds.first)
        let folder = id.uuidString.lowercased()
        #expect(spy[folder] == .completeUnlessOpen)
        await rig.recorder.stop()
        await rig.recorder.settle()
        rig.store.reconcile(recording: [], nowMs: rig.clock.nowMs())
        #expect(spy["audio.m4a"] == .complete)
        #expect(spy["events.log"] == .complete)
        #expect(spy["state.json"] == .complete)
        #expect(spy[folder] == .complete)
    }

    @Test func aMediaServicesResetIsAnInterruptionResumedAtOnce() async throws {
        let rig = try Rig()
        try await rig.recorder.start()
        await rig.speak(seconds: 1)
        await rig.recorder.handle(.mediaServicesReset)
        guard case let .recording(state) = await rig.phase() else { Issue.record("not resumed"); return }
        #expect(state.part == 2)
        await rig.recorder.stop()
    }
}

@Suite struct RecordingStoreTests {
    @Test func namesDeletesAndCountsRecordings() async throws {
        let rig = try Rig()
        try await rig.recorder.start()
        await rig.speak(seconds: 1)
        await rig.recorder.stop()
        await rig.recorder.settle()
        let recording = try #require(rig.recordings().first)
        try rig.store.rename(recording.id, to: "  Réunion budget  ")
        #expect(rig.store.recording(recording.id)?.name == "Réunion budget")
        try rig.store.rename(recording.id, to: " ")
        #expect(rig.store.recording(recording.id)?.name == nil)
        try rig.store.delete(recording.id)
        #expect(rig.store.list().isEmpty)
        #expect(throws: RecordingStoreError.missing) { try rig.store.delete(recording.id) }
    }

    @Test func excludesRecordingsFromBackup() throws {
        let root = try scratch()
        _ = try RecordingStore(root: root)
        #expect(try root.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
    }
}

@Suite struct PhoneRecorderFailureTests {
    @Test func aMicrophoneThatStopsByItselfIsAnInterruptionNeverASilentHole() async throws {
        let rig = try Rig()
        try await rig.recorder.start()
        await rig.speak(seconds: 2)
        rig.microphone.fail("the engine could not restart")
        // The failure reaches the recorder through a task: wait for it.
        for _ in 0..<100 {
            if case .interrupted = await rig.phase() { break }
            await Task.yield()
        }
        guard case let .interrupted(state) = await rig.phase() else { Issue.record("still recording"); return }
        #expect(state.cause == .other)
        #expect(rig.notifications.all.count == 1)
        try await rig.recorder.resume()
        await rig.speak(seconds: 1)
        await rig.recorder.stop()
        await rig.recorder.settle()
        #expect(rig.recordings().map(\.end) == [.interruption, .stopped])
    }

    @Test func aResumeThatCannotCreateItsFileCanBeTriedAgain() async throws {
        let writers = FailingOnceWriters()
        let rig = try Rig(writers: writers)
        try await rig.recorder.start()
        await rig.speak(seconds: 1)
        await rig.recorder.handle(.interruptionBegan(.other))
        writers.failNext()
        await #expect(throws: PhoneRecorder.StartRefusal.self) { try await rig.recorder.resume() }
        guard case let .interrupted(state) = await rig.phase() else { Issue.record("session lost"); return }
        #expect(state.resumeFailed)
        try await rig.recorder.resume()
        guard case let .recording(resumed) = await rig.phase() else { Issue.record("not resumed"); return }
        #expect(resumed.sessionId == state.sessionId)
        await rig.recorder.stop()
    }
}

/// Writers whose next creation fails once, as a full disk would.
final class FailingOnceWriters: PartWriterFactory, @unchecked Sendable {
    private let fail = Mutex(false)
    func failNext() { fail.withLock { $0 = true } }
    func makeWriter(url: URL, header: PhoneRecordingHeader) throws -> any PartWriter {
        if fail.withLock({ value in defer { value = false }; return value }) {
            throw PartWriterError.cannotStart("disk full")
        }
        return CountingWriter(url: url, header: header, failAfter: nil)
    }
}
