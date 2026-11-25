import Foundation
import SondinePhone
import Testing

/// A result as the Mac makes one, for a recording.
func sampleResult(_ id: UUID, text: String = "Bonjour Sondine") throws -> PhoneResult {
    try PhoneResult(
        recordingId: id, name: nil, startedAtMs: 1_793_442_000_000, endedAtMs: 1_793_442_060_000, timeUncertain: false,
        speakers: [try PhoneSpeaker(ordinal: 1, name: nil, guess: "Marie", isSelf: false)],
        sentences: [try PhoneSentence(id: 1, startMs: 1_793_442_001_000, endMs: 1_793_442_002_000, speaker: 1, text: text)],
        journal: [], notes: [],
        audio: try PhoneResultAudio(generation: 1, startedAtMs: 1_793_442_000_000, durationMs: 60_000))
}

private let revisionA = String(repeating: "a", count: 64)
private let revisionB = String(repeating: "b", count: 64)

/// A paired phone whose one recording the Mac holds and has transcribed.
private func readyRig(_ mac: FakeMac, minutesAgo: Int64 = 10) async throws -> (SyncRig, StoredRecording) {
    let rig = try SyncRig()
    try await rig.paired(with: mac)
    let recording = try rig.recording(bytes: 1_000, minutesAgo: minutesAgo)
    #expect(await rig.client.sync() == .done)
    mac.state.withLock { $0.analysis[recording.id] = .ready }
    return (rig, recording)
}

/// Results on the phone (ADR 008, plan § M5.3): fetched when their revision
/// moved, kept 30 days, erased with the recording.
@Suite struct PhoneResultTests {
    @Test func aResultIsFetchedOnceAndAgainWhenItsRevisionMoves() async throws {
        let mac = FakeMac()
        let (rig, recording) = try await readyRig(mac)
        mac.state.withLock { $0.results[recording.id] = (revisionA, try! sampleResult(recording.id)) }
        #expect(await rig.client.sync() == .done)
        let first = try require(rig.store.result(recording.id, latestSeenMs: rig.clock.nowMs()))
        #expect(first.revision == revisionA)
        #expect(first.result.sentences.first?.text == "Bonjour Sondine")
        #expect(rig.store.recording(recording.id)?.resultRevision == revisionA)

        // Nothing moved: `unchanged`, the file stays as it was.
        rig.clock.advance(ms: 1_000)
        #expect(await rig.client.sync() == .done)
        #expect(rig.store.result(recording.id, latestSeenMs: rig.clock.nowMs())?.fetchedAtMs == first.fetchedAtMs)

        // A correction on the Mac: a new revision, a new result.
        mac.state.withLock { $0.results[recording.id] = (revisionB, try! sampleResult(recording.id, text: "Bonjour Sondine !")) }
        #expect(await rig.client.sync() == .done)
        let second = try require(rig.store.result(recording.id, latestSeenMs: rig.clock.nowMs()))
        #expect(second.revision == revisionB)
        #expect(second.result.sentences.first?.text == "Bonjour Sondine !")
        #expect(mac.state.withLock { $0.getRevisions } == [nil, revisionA, revisionA])
    }

    @Test func aDeletedAnswerRemovesTheFolderAndWithheldKeepsTheResult() async throws {
        let mac = FakeMac()
        let (rig, recording) = try await readyRig(mac)
        mac.state.withLock { $0.results[recording.id] = (revisionA, try! sampleResult(recording.id)) }
        #expect(await rig.client.sync() == .done)

        // A deletion landed while the Mac read it: withheld, the result kept, asked again next pass.
        mac.state.withLock {
            $0.results[recording.id] = (revisionB, try! sampleResult(recording.id, text: "Autre"))
            $0.getOnce[recording.id] = .withheld
        }
        #expect(await rig.client.sync() == .done)
        #expect(rig.store.recording(recording.id)?.resultRevision == revisionA)
        #expect(await rig.client.sync() == .done)
        #expect(rig.store.recording(recording.id)?.resultRevision == revisionB)

        // Deleted between `states` and `get`: the folder goes.
        mac.state.withLock { $0.getOnce[recording.id] = .unavailable(.deleted) }
        #expect(await rig.client.sync() == .done)
        #expect(!FileManager.default.fileExists(atPath: recording.folder.url.path(percentEncoded: false)))
    }

    @Test func aResultNotReadyAnyMoreIsErasedUntilTheNextOne() async throws {
        let mac = FakeMac()
        let (rig, recording) = try await readyRig(mac)
        mac.state.withLock { $0.results[recording.id] = (revisionA, try! sampleResult(recording.id)) }
        #expect(await rig.client.sync() == .done)
        #expect(rig.store.recording(recording.id)?.resultRevision == revisionA)

        // A passage deleted on the Mac sends it back to analysis: the result held may show it, so it goes.
        mac.state.withLock { $0.analysis[recording.id] = .transcribing }
        #expect(await rig.client.sync() == .done)
        #expect(rig.store.recording(recording.id)?.resultRevision == nil)
        #expect(!FileManager.default.fileExists(atPath: recording.folder.result.path(percentEncoded: false)))

        // Ready again: the new result, asked with no revision.
        mac.state.withLock {
            $0.analysis[recording.id] = .ready
            $0.results[recording.id] = (revisionB, try! sampleResult(recording.id, text: "Sans le passage"))
        }
        #expect(await rig.client.sync() == .done)
        #expect(rig.store.result(recording.id, latestSeenMs: rig.clock.nowMs())?.result.sentences.first?.text == "Sans le passage")
        #expect(mac.state.withLock { $0.getRevisions.last } == .some(nil))

        // `get` itself saying it is not ready (between `states` and `get`) erases it too.
        mac.state.withLock { $0.getOnce[recording.id] = .unavailable(.waiting) }
        #expect(await rig.client.sync() == .done)
        #expect(rig.store.recording(recording.id)?.resultRevision == nil)
    }

    @Test func aResultWrittenWithoutItsRevisionStillExpires() async throws {
        let mac = FakeMac()
        let (rig, recording) = try await readyRig(mac, minutesAgo: 29 * 24 * 60)
        // Killed between writing `result.json` and its revision in `state.json`.
        let kept = StoredResult(revision: revisionA, fetchedAtMs: rig.clock.nowMs(), result: try sampleResult(recording.id))
        try JSONEncoder().encode(kept).write(to: recording.folder.result)
        #expect(rig.store.recording(recording.id)?.resultRevision == nil)
        rig.clock.advance(ms: 2 * 24 * 3_600_000)
        let latest = rig.device.seen(rig.clock.nowMs())
        #expect(rig.store.expireResults(latestSeenMs: latest) == [recording.id])
        #expect(!FileManager.default.fileExists(atPath: recording.folder.result.path(percentEncoded: false)))
    }

    @Test func resultsOlderThanThirtyDaysAreNeitherFetchedNorKept() async throws {
        let mac = FakeMac()
        let rig = try SyncRig()
        try await rig.paired(with: mac)
        let old = try rig.recording(bytes: 1_000, minutesAgo: 31 * 24 * 60)
        let recent = try rig.recording(bytes: 1_000, minutesAgo: 20 * 24 * 60)
        #expect(await rig.client.sync() == .done)
        mac.state.withLock {
            $0.analysis[old.id] = .ready
            $0.analysis[recent.id] = .ready
            $0.results[old.id] = (revisionA, try! sampleResult(old.id))
            $0.results[recent.id] = (revisionA, try! sampleResult(recent.id))
        }
        #expect(await rig.client.sync() == .done)
        #expect(rig.store.recording(old.id)?.resultRevision == nil)
        #expect(rig.store.recording(recent.id)?.resultRevision == revisionA)
        #expect(mac.state.withLock { $0.getRevisions.count } == 1, "only the recent one is asked for")

        // Eleven days on, the next launch erases it.
        rig.clock.advance(ms: 11 * 24 * 3_600_000)
        let latest = rig.device.seen(rig.clock.nowMs())
        #expect(rig.store.expireResults(latestSeenMs: latest) == [recent.id])
        #expect(!FileManager.default.fileExists(atPath: recent.folder.result.path(percentEncoded: false)))
        #expect(rig.store.recording(recent.id) != nil, "the recording stays; only its result goes")
    }

    @Test func aClockSetBackDoesNotKeepAResultLonger() async throws {
        let mac = FakeMac()
        let (rig, recording) = try await readyRig(mac, minutesAgo: 29 * 24 * 60)
        mac.state.withLock { $0.results[recording.id] = (revisionA, try! sampleResult(recording.id)) }
        #expect(await rig.client.sync() == .done)
        // Two days pass: the result is past 30 days, and the latest time seen says so.
        rig.clock.advance(ms: 2 * 24 * 3_600_000)
        _ = rig.device.seen(rig.clock.nowMs())
        // The clock is set back a week before the app opens again.
        rig.clock.advance(ms: -7 * 24 * 3_600_000)
        let relaunched = try SyncRig(root: rig.root)
        let latest = relaunched.device.seen(rig.clock.nowMs())
        #expect(latest > rig.clock.nowMs())
        #expect(relaunched.store.expireResults(latestSeenMs: latest) == [recording.id])
        #expect(relaunched.store.result(recording.id, latestSeenMs: latest) == nil)
    }

    @Test func showingAResultChecksItsAgeFirst() async throws {
        let mac = FakeMac()
        let (rig, recording) = try await readyRig(mac, minutesAgo: 29 * 24 * 60)
        mac.state.withLock { $0.results[recording.id] = (revisionA, try! sampleResult(recording.id)) }
        #expect(await rig.client.sync() == .done)
        #expect(rig.store.result(recording.id, latestSeenMs: rig.clock.nowMs()) != nil)
        let later = rig.clock.nowMs() + 2 * 24 * 3_600_000
        #expect(rig.store.result(recording.id, latestSeenMs: later) == nil)
        #expect(!FileManager.default.fileExists(atPath: recording.folder.result.path(percentEncoded: false)))
    }

    @Test func theLatestTimeSeenNeverMovesBack() throws {
        let rig = try SyncRig()
        let now = rig.clock.nowMs()
        #expect(rig.device.seen(now) == now)
        #expect(rig.device.seen(now - 86_400_000) == now)
        #expect(rig.device.seen(now + 3_600_000) == now + 3_600_000)
        #expect(DeviceStore(root: rig.root).file.latestSeenMs == now + 3_600_000)
    }
}

/// Names and notes from the phone's outbox (ADR 008).
@Suite struct PhoneNameAndNoteTests {
    @Test func ofTwoNamesTheLaterOneTypedWinsAndARetryDoesNothingTwice() async throws {
        let mac = FakeMac()
        let rig = try SyncRig()
        try await rig.paired(with: mac)
        let recording = try rig.recording(bytes: 1_000)
        #expect(await rig.client.sync() == .done)

        try await rig.client.rename(recording.id, to: "Premier")
        rig.clock.advance(ms: 1_000)
        try await rig.client.rename(recording.id, to: "  Réunion budget\n")
        let pending = rig.outbox.all()
        #expect(pending.count == 1, "the later name replaces the earlier one")
        #expect(pending.first?.name == "Réunion budget")
        #expect(await rig.client.sync() == .done)
        #expect(rig.outbox.all().isEmpty)
        #expect(mac.state.withLock { $0.names[recording.id]?.name } == "Réunion budget")
        #expect(rig.store.recording(recording.id)?.nameUnsent == false)

        // The acknowledgement was lost: the same operation again changes nothing.
        let renamed = mac.state.withLock { $0.names[recording.id] }
        try rig.outbox.add(try require(pending.first))
        #expect(await rig.client.sync() == .done)
        #expect(rig.outbox.all().isEmpty)
        #expect(mac.state.withLock { $0.names[recording.id]?.typedAtMs } == renamed?.typedAtMs)

        // An older name arriving late loses.
        try rig.outbox.add(.rename(recording.id, to: "Ancien", typedAtMs: 1))
        #expect(await rig.client.sync() == .done)
        #expect(mac.state.withLock { $0.names[recording.id]?.name } == "Réunion budget")
        // Its recording's name on the phone stays.
        #expect(rig.store.recording(recording.id)?.name == "Réunion budget")
    }

    @Test func aNameTypedBeforePairingReachesTheMacOnceItHoldsTheRecording() async throws {
        let mac = FakeMac()
        let rig = try SyncRig()
        let recording = try rig.recording(bytes: 1_000)
        try await rig.client.rename(recording.id, to: "Hors ligne")
        #expect(rig.outbox.all().isEmpty)
        try await rig.paired(with: mac)
        #expect(await rig.client.sync() == .done)
        #expect(mac.state.withLock { $0.names[recording.id]?.name } == "Hors ligne")
        let renames = mac.requests.filter { $0.hasSuffix("/rename") }.count
        #expect(await rig.client.sync() == .done)
        #expect(mac.requests.filter { $0.hasSuffix("/rename") }.count == renames, "acknowledged: not sent again")
    }

    @Test func aNoteWaitsUntilTheMacHoldsItsRecordingAndIsAddedOnce() async throws {
        let mac = FakeMac()
        let rig = try SyncRig()
        try await rig.paired(with: mac)
        let recording = try rig.recording(bytes: 1_000)
        // Still open on the phone: not sent, so the Mac says `later`.
        rig.open.set([recording.id])
        #expect(try await rig.client.addNote(recording.id, text: "  Relancer Marie  "))
        #expect(await rig.client.sync() == .done)
        #expect(await rig.client.pendingNotes(recording.id).map(\.text) == ["Relancer Marie"])
        #expect(mac.state.withLock { $0.notes[recording.id] } == nil)

        rig.open.set([])
        #expect(await rig.client.sync() == .done)
        #expect(await rig.client.pendingNotes(recording.id).isEmpty)
        #expect(mac.state.withLock { $0.notes[recording.id] } == ["Relancer Marie"])

        // Another operation of the same words is a second note; the same operation again is not.
        let operation = OutboxOperation.note(recording.id, text: "Relancer Marie", atMs: 1)
        try rig.outbox.add(operation)
        #expect(await rig.client.sync() == .done)
        try rig.outbox.add(operation)
        #expect(await rig.client.sync() == .done)
        #expect(mac.state.withLock { $0.notes[recording.id] }?.count == 2)
        #expect(rig.outbox.all().isEmpty)
    }

    @Test func aNoteNeedsAPairingAndWords() async throws {
        let rig = try SyncRig()
        let recording = try rig.recording(bytes: 10)
        #expect(try await rig.client.addNote(recording.id, text: "Seul") == false)
        try await rig.paired(with: FakeMac())
        #expect(try await rig.client.addNote(recording.id, text: "   ") == false)
        #expect(rig.outbox.all().isEmpty)
    }

    @Test func aDeletionBeatsNamesAndNotes() throws {
        let rig = try SyncRig()
        let id = UUID()
        try rig.outbox.add(.rename(id, to: "Nom", typedAtMs: 5))
        try rig.outbox.add(.note(id, text: "Note", atMs: 6))
        try rig.outbox.add(OutboxOperation(kind: .delete, recordingId: id, atMs: 7))
        #expect(rig.outbox.all().map(\.kind) == [.delete])
        try rig.outbox.add(.note(id, text: "Trop tard", atMs: 8))
        try rig.outbox.add(.rename(id, to: "Trop tard", typedAtMs: 9))
        #expect(rig.outbox.all().map(\.kind) == [.delete])
    }

    @Test func outboxFilesOfM52StillRead() throws {
        let rig = try SyncRig()
        let id = UUID()
        let operation = UUID()
        let old = #"{"operationId":"\#(operation.uuidString)","kind":"delete","recordingId":"\#(id.uuidString)","atMs":3}"#
        try Data(old.utf8).write(to: rig.outbox.root.appending(path: "\(operation.wire).json"))
        #expect(rig.outbox.all().map(\.recordingId) == [id])
    }

    @Test func namesFitTheWire() {
        #expect(RecordingStore.cleanName("  a\nb\tc ") == "a b c")
        #expect(RecordingStore.cleanName(" \n ") == nil)
        #expect(RecordingStore.cleanName(String(repeating: "🎙", count: 150))?.utf16.count == 200)
    }
}

/// Playback streamed from the Mac by byte ranges (ADR 008, architecture §11).
@Suite struct RemoteAudioTests {
    @Test func aRangeIsReadInPiecesOfAtMostOneMebibyte() async throws {
        let mac = FakeMac()
        let (rig, recording) = try await readyRig(mac)
        let wav = Data((0..<(2 * 1_048_576 + 500_000)).map { UInt8(truncatingIfNeeded: $0 &* 31) })
        mac.state.withLock { $0.audio[recording.id] = (3, wav) }
        let client = rig.client
        let reader = RemoteAudioReader { range in await client.audio(recording.id, generation: 3, range: range) }
        var read = Data()
        let outcome = await reader.read(from: 0, length: nil) { piece, total in
            #expect(total == Int64(wav.count))
            read.append(piece)
            return true
        }
        #expect(outcome == .success(Int64(wav.count)))
        #expect(read == wav)
        #expect(mac.requests.filter { $0.hasPrefix("GET") }.count == 3)

        // A range inside, as a seek asks for it.
        var middle = Data()
        _ = await reader.read(from: 1_000_000, length: 100_000) { piece, _ in
            middle.append(piece)
            return true
        }
        #expect(middle == wav.subdata(in: 1_000_000..<1_100_000))
        // Nothing of it was written in the recording's folder.
        let names = try FileManager.default.contentsOfDirectory(atPath: recording.folder.url.path(percentEncoded: false))
        #expect(Set(names) == ["events.log", "state.json"])
    }

    @Test func aMovedGenerationOrAMissingAudioIsSaid() async throws {
        let mac = FakeMac()
        let (rig, recording) = try await readyRig(mac)
        mac.state.withLock { $0.audio[recording.id] = (4, Data(count: 100)) }
        #expect(await rig.client.audio(recording.id, generation: 3, range: 0...9) == .refused(status: 409, .stale))
        #expect(await rig.client.audio(UUID(), generation: 3, range: 0...9) == .refused(status: 410, .gone))
        #expect(await rig.client.audio(recording.id, generation: 4, range: 200...209) == .refused(status: 416, .range))
        #expect(await rig.client.audio(recording.id, generation: 4, range: 90...200) == .bytes(Data(count: 10), total: 100))
    }

    @Test func notPairedThereIsNothingToPlay() async throws {
        let rig = try SyncRig()
        #expect(await rig.client.audio(UUID(), generation: 1, range: 0...1) == .notPaired)
    }

    @Test func contentRangesAreReadStrictly() {
        #expect(ContentRange.parse("bytes 0-1/44").map { [$0.start, $0.end, $0.total] } == [0, 1, 44])
        #expect(ContentRange.parse("bytes 10-9/44") == nil)
        #expect(ContentRange.parse("bytes 0-44/44") == nil)
        #expect(ContentRange.parse("bytes 0-1/*") == nil)
    }
}

/// Tags and « C'est moi » from the phone's outbox (ADR 039).
@Suite struct PhoneTagTests {
    @Test func aTagWaitsForItsRecordingTheLaterChoiceWinsAndTheMacsTagsAreOffered() async throws {
        let mac = FakeMac()
        mac.state.withLock { $0.macTags = ["contenu", "Idées"] }
        let rig = try SyncRig()
        try await rig.paired(with: mac)
        let recording = try rig.recording(bytes: 1_000)
        rig.open.set([recording.id])
        #expect(try await rig.client.setTag(recording.id, name: " #idées", on: true))
        #expect(try await rig.client.setTag(recording.id, name: "#", on: true) == false)
        #expect(await rig.client.tags(recording.id, mac: []) == ["idées"])
        #expect(await rig.client.sync() == .done)
        // Not sent yet: the Mac says `later`, the phone keeps it and offers the Mac's tags.
        #expect(rig.outbox.all().count == 1)
        #expect(await rig.client.recentTags() == ["idées", "contenu"])

        // Taken off, then put on again: one choice waits, the last one.
        rig.clock.advance(ms: 1_000)
        #expect(try await rig.client.setTag(recording.id, name: "IDEES", on: false))
        rig.clock.advance(ms: 1_000)
        #expect(try await rig.client.setTag(recording.id, name: "Idées", on: true))
        #expect(rig.outbox.all().map(\.name) == ["Idées"])
        rig.clock.advance(ms: 1_000)
        #expect(try await rig.client.setTag(recording.id, name: "récap", on: true))

        rig.open.set([])
        #expect(await rig.client.sync() == .done)
        #expect(rig.outbox.all().isEmpty)
        #expect(mac.state.withLock { $0.tags[recording.id] } == ["Idées", "récap"])
        #expect(await rig.client.tags(recording.id, mac: ["Idées", "récap"]) == ["Idées", "récap"])
    }

    @Test func cestMoiReachesTheMacOnce() async throws {
        let mac = FakeMac()
        let rig = try SyncRig()
        try await rig.paired(with: mac)
        let recording = try rig.recording(bytes: 1_000)
        #expect(await rig.client.sync() == .done)
        #expect(try await rig.client.confirmSelf(recording.id, ordinal: 1, sentenceId: 41))
        #expect(await rig.client.pendingSelf(recording.id) == [1])
        #expect(await rig.client.sync() == .done)
        #expect(await rig.client.pendingSelf(recording.id).isEmpty)
        #expect(mac.state.withLock { $0.selves[recording.id] } == [1])
    }
}
