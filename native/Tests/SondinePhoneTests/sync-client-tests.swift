import CryptoKit
import Foundation
import SondinePhone
import Testing

/// The phone's sync against a fake Mac (ADR 008): pairing, sending with
/// resume, the Mac's answers, deletion both ways, revocation.
@Suite struct PhoneSyncClientTests {
    @Test func pairingKeepsTheCredentialAndTheMac() async throws {
        let mac = FakeMac()
        let rig = try SyncRig()
        let invite = try mac.invite()
        let paired = try await rig.client.pair(invite)
        #expect(paired.macId == mac.macId)
        #expect(paired.pin == mac.pin)
        #expect(rig.credentials.read()?.hasPrefix("sdp_") == true)
        #expect(rig.device.file.mac == paired)
        #expect(await rig.client.status.mac == paired)
        // The same QR again: the token was used.
        await #expect(throws: PhoneSyncClient.PairingFailure.expired) { try await rig.client.pair(invite) }
    }

    @Test func aMacThatCannotBeReachedFailsThePairing() async throws {
        let rig = try SyncRig()
        let invite = try PairingInvite(
            pin: String(repeating: "ab", count: 32), token: String(repeating: "A", count: 43), name: "Sondine 0000",
            port: 1, addrs: ["192.0.2.1"])
        await #expect(throws: PhoneSyncClient.PairingFailure.unreachable) { try await rig.client.pair(invite) }
        #expect(rig.credentials.read() == nil)
    }

    @Test func notPairedNothingIsSent() async throws {
        let rig = try SyncRig()
        try rig.recording(bytes: 1_000)
        #expect(await rig.client.sync() == .notPaired)
    }

    @Test func aStoredRecordingLosesItsAudioAndKeepsItsFolder() async throws {
        let mac = FakeMac()
        let rig = try SyncRig()
        try await rig.paired(with: mac)
        let recording = try rig.recording(bytes: 300_000)
        let bytes = try rig.audio(recording)
        #expect(await rig.client.sync() == .done)

        let after = try require(rig.store.recording(recording.id))
        #expect(!after.hasAudio)
        #expect(after.sync.stored)
        #expect(after.sync.mac == .waiting)
        #expect(FileManager.default.fileExists(atPath: after.folder.events.path(percentEncoded: false)))
        #expect(FileManager.default.fileExists(atPath: after.folder.state.path(percentEncoded: false)))
        guard case let .stored(_, sha256, data) = mac.state.withLock({ $0.held[recording.id] }) else {
            Issue.record("not stored on the Mac")
            return
        }
        #expect(data == bytes)
        #expect(sha256 == hex(SHA256.hash(data: bytes)))
        #expect(rig.device.file.mac?.lastSyncMs != nil)

        // Sent again: nothing goes, the Mac's state comes back.
        mac.state.withLock { $0.analysis[recording.id] = .ready }
        let uploads = mac.requests.filter { $0.hasPrefix("PUT") }.count
        #expect(await rig.client.sync() == .done)
        #expect(mac.requests.filter { $0.hasPrefix("PUT") }.count == uploads)
        #expect(rig.store.recording(recording.id)?.sync.mac == .ready)
    }

    @Test func audioLeftByAKillAfterStoredGoesAtTheNextPass() async throws {
        let rig = try SyncRig()
        try await rig.paired(with: FakeMac())
        let recording = try rig.recording(bytes: 2_000)
        // Killed between saving `stored` and removing the file.
        try rig.store.updateSync(recording.id) { $0.stored = true }
        #expect(try require(rig.store.recording(recording.id)).hasAudio)
        _ = await rig.client.sync()
        #expect(try require(rig.store.recording(recording.id)).hasAudio == false)
    }

    @Test func aCutTransferResumesFromWhatTheMacHolds() async throws {
        let mac = FakeMac()
        let rig = try SyncRig()
        try await rig.paired(with: mac)
        let recording = try rig.recording(bytes: 500_000)
        let bytes = try rig.audio(recording)
        mac.state.withLock { $0.cutAfter = 200_000 }

        #expect(await rig.client.sync() == .unreachable)
        let cut = try require(rig.store.recording(recording.id))
        #expect(cut.hasAudio)
        #expect(!cut.sync.stored)
        #expect(cut.sync.sha256 == hex(SHA256.hash(data: bytes)))
        #expect(await rig.client.status.reachable == false)

        #expect(await rig.client.sync() == .done)
        guard case let .stored(_, _, data) = mac.state.withLock({ $0.held[recording.id] }) else {
            Issue.record("not stored on the Mac")
            return
        }
        #expect(data == bytes, "one file, the same bytes")
        #expect(rig.store.recording(recording.id)?.hasAudio == false)
        // The second upload started where the first stopped.
        #expect(mac.requests.filter { $0.hasPrefix("PUT") }.count == 2)
    }

    @Test func aConflictKeepsTheFileAndIsNotSentAgain() async throws {
        let mac = FakeMac()
        let rig = try SyncRig()
        try await rig.paired(with: mac)
        let recording = try rig.recording(bytes: 10_000)
        mac.state.withLock {
            $0.held[recording.id] = .stored(bytes: 9, sha256: String(repeating: "0", count: 64), data: Data())
        }
        #expect(await rig.client.sync() == .done)
        let after = try require(rig.store.recording(recording.id))
        #expect(after.hasAudio)
        #expect(after.sync.conflict)
        #expect(await rig.client.sync() == .done)
        #expect(mac.requests.filter { $0.contains("announce") }.count == 1)
    }

    @Test func aRecordingDeletedOnTheMacLeavesThePhone() async throws {
        let mac = FakeMac()
        let rig = try SyncRig()
        try await rig.paired(with: mac)
        // Never sent: the announcement says `deleted`.
        let unsent = try rig.recording(bytes: 1_000, minutesAgo: 10)
        mac.state.withLock { $0.held[unsent.id] = .deleted }
        // Sent before: `states` says `deleted`.
        let sent = try rig.recording(bytes: 1_000)
        #expect(await rig.client.sync() == .done)
        #expect(rig.store.recording(sent.id)?.sync.stored == true)
        #expect(rig.store.recording(unsent.id) == nil)

        mac.state.withLock { $0.held[sent.id] = .deleted }
        #expect(await rig.client.sync() == .done)
        #expect(!FileManager.default.fileExists(atPath: sent.folder.url.path(percentEncoded: false)))
    }

    @Test func recordingsGoOldestFirstAndOneBeingRecordedNever() async throws {
        let mac = FakeMac()
        let rig = try SyncRig()
        try await rig.paired(with: mac)
        let newer = try rig.recording(bytes: 1_000, minutesAgo: 5)
        let older = try rig.recording(bytes: 1_000, minutesAgo: 50)
        let recordingNow = try rig.recording(bytes: 1_000, ended: false)
        let rotated = try rig.recording(bytes: 1_000, minutesAgo: 1)
        rig.open.set([rotated.id])
        #expect(await rig.client.sync() == .done)
        let puts = mac.requests.filter { $0.hasPrefix("PUT") }
        #expect(puts == ["PUT \(PhoneSync.Route.audio(older.id))", "PUT \(PhoneSync.Route.audio(newer.id))"])
        #expect(rig.store.recording(recordingNow.id)?.hasAudio == true)
        #expect(rig.store.recording(rotated.id)?.hasAudio == true)
    }

    @Test func aDeletionOnThePhoneReachesTheMacOnce() async throws {
        let mac = FakeMac()
        let rig = try SyncRig()
        try await rig.paired(with: mac)
        let recording = try rig.recording(bytes: 1_000)
        #expect(await rig.client.sync() == .done)
        try await rig.client.delete(recording.id)
        #expect(rig.store.recording(recording.id) == nil)
        let operation = try require(rig.outbox.all().first)
        #expect(operation.recordingId == recording.id)

        #expect(await rig.client.sync() == .done)
        #expect(rig.outbox.all().isEmpty)
        #expect(mac.state.withLock { $0.held[recording.id] } == .deleted)

        // Acknowledged but sent again (the answer was lost): one deletion on the Mac.
        try rig.outbox.add(operation)
        #expect(await rig.client.sync() == .done)
        #expect(rig.outbox.all().isEmpty)
        #expect(mac.state.withLock { $0.deleteOperations } == [operation.operationId])
    }

    @Test func aDeletionCutByAKillIsFinishedAtLaunchThenSent() async throws {
        let mac = FakeMac()
        let first = try SyncRig()
        try await first.paired(with: mac)
        let recording = try first.recording(bytes: 1_000)
        // Killed between writing the deletion and removing the folder.
        try first.outbox.add(OutboxOperation(kind: .delete, recordingId: recording.id, atMs: first.clock.nowMs()))
        #expect(first.store.recording(recording.id) != nil)

        let relaunched = try SyncRig(root: first.root)
        try relaunched.credentials.write(try require(first.credentials.read()))
        #expect(relaunched.outbox.finishDeletions(in: relaunched.store) == [recording.id])
        #expect(relaunched.store.recording(recording.id) == nil)
        #expect(await relaunched.client.sync() == .done)
        #expect(relaunched.outbox.all().isEmpty)
        #expect(mac.state.withLock { $0.held[recording.id] } == .deleted)
        // Nothing of it was sent before it went.
        #expect(!mac.requests.contains { $0.contains(recording.id.wire) && $0.hasPrefix("PUT") })
    }

    @Test func aRecordingIsDeletedOnceInTheOutbox() throws {
        let rig = try SyncRig()
        let recording = try rig.recording(bytes: 10)
        try rig.outbox.delete(recording.id, from: rig.store, atMs: 1)
        #expect(throws: RecordingStoreError.missing) { try rig.outbox.delete(recording.id, from: rig.store, atMs: 2) }
        #expect(rig.outbox.all().count == 1)
    }

    @Test func aRevokedPhoneErasesItsCredentialAndKeepsWhatItDidNotSend() async throws {
        let mac = FakeMac()
        let rig = try SyncRig()
        try await rig.paired(with: mac)
        let sent = try rig.recording(bytes: 1_000, minutesAgo: 10)
        #expect(await rig.client.sync() == .done)
        try Data("{}".utf8).write(to: sent.folder.result)
        let unsent = try rig.recording(bytes: 2_000)

        mac.state.withLock { $0.revoked = true }
        #expect(await rig.client.sync() == .revoked)
        #expect(rig.credentials.read() == nil)
        #expect(rig.device.file.mac == nil)
        #expect(rig.device.file.revokedBy?.name == "Sondine K7Q2")
        #expect(await rig.client.status.revokedBy?.name == "Sondine K7Q2")
        #expect(!FileManager.default.fileExists(atPath: sent.folder.result.path(percentEncoded: false)))
        #expect(rig.store.recording(unsent.id)?.hasAudio == true)
        #expect(await rig.client.sync() == .notPaired)

        // Pairing again clears it.
        try await rig.paired(with: mac)
        mac.state.withLock { $0.revoked = false }
        #expect(await rig.client.status.revokedBy == nil)
    }

    @Test func forgettingTheMacTellsItAndEmptiesTheOutbox() async throws {
        let mac = FakeMac()
        let rig = try SyncRig()
        try await rig.paired(with: mac)
        let kept = try rig.recording(bytes: 1_000)
        let deleted = try rig.recording(bytes: 1_000)
        try await rig.client.delete(deleted.id)
        #expect(await rig.client.forget() == 1)
        #expect(mac.state.withLock { $0.forgotten })
        #expect(rig.outbox.all().isEmpty)
        #expect(rig.credentials.read() == nil)
        #expect(rig.device.file.mac == nil)
        #expect(rig.device.file.revokedBy == nil)
        #expect(rig.store.recording(kept.id)?.hasAudio == true)
    }

    @Test func aFullMacStopsTheUploadsForAWhile() async throws {
        let mac = FakeMac()
        let rig = try SyncRig()
        try await rig.paired(with: mac)
        let recording = try rig.recording(bytes: 1_000)
        mac.state.withLock { $0.noRoom = true }
        #expect(await rig.client.sync() == .stopped(.macFull))
        #expect(await rig.client.status.problem == .macFull)
        mac.state.withLock { $0.noRoom = false }
        // Within the back-off, nothing is offered; the rest of the sync runs.
        #expect(await rig.client.sync() == .done)
        #expect(rig.store.recording(recording.id)?.hasAudio == true)
        rig.clock.advance(ms: 16 * 60_000)
        #expect(await rig.client.sync() == .done)
        #expect(rig.store.recording(recording.id)?.hasAudio == false)
    }

    @Test func anUnknownCredentialIsTreatedAsRevoked() async throws {
        let mac = FakeMac()
        let rig = try SyncRig()
        try await rig.paired(with: mac)
        mac.state.withLock { $0.credentials.removeAll() }
        #expect(await rig.client.sync() == .revoked)
        #expect(rig.credentials.read() == nil)
    }

    @Test func aThrottledAddressKeepsThePairing() async throws {
        let mac = FakeMac()
        let rig = try SyncRig()
        try await rig.paired(with: mac)
        // Too many wrong credentials from this address (another app, a stale phone): 429 `busy`, not `revoked`.
        mac.state.withLock { $0.throttled = true }
        #expect(await rig.client.sync() == .stopped(.busy))
        #expect(rig.credentials.read() != nil)
        #expect(rig.device.file.mac != nil)
        #expect(await rig.client.status.revokedBy == nil)
        mac.state.withLock { $0.throttled = false }
        #expect(await rig.client.sync() == .done)
    }

    @Test func anUploadRefusedForItsOffsetIsAnnouncedAgain() async throws {
        let mac = FakeMac()
        let rig = try SyncRig()
        try await rig.paired(with: mac)
        let recording = try rig.recording(bytes: 100_000)
        mac.state.withLock { $0.refuseOffsetOnce = true }
        #expect(await rig.client.sync() == .done)
        #expect(rig.store.recording(recording.id)?.sync.stored == true)
        #expect(mac.requests.filter { $0.hasSuffix("/announce") }.count == 2)
        #expect(mac.requests.filter { $0.hasPrefix("PUT") }.count == 2)
    }

    @Test func anotherVersionOfTheMacIsSaidWithBoth() async throws {
        let mac = FakeMac()
        let rig = try SyncRig()
        try await rig.paired(with: mac)
        mac.state.withLock { $0.macVersion = 3 }
        #expect(await rig.client.sync() == .stopped(.version(mac: 3, phone: 2)))
        #expect(await rig.client.status.problem == .version(mac: 3, phone: 2))
        #expect(rig.credentials.read() != nil)
    }

    @Test func theDeviceNameFitsTheWire() {
        #expect(PhoneSyncClientTests.name("  iPhone de Téo\n") == "iPhone de Téo")
        #expect(PhoneSyncClientTests.name("") == "iPhone")
        #expect(PhoneSyncClientTests.name(String(repeating: "é", count: 80)).utf16.count == 64)
    }

    static func name(_ text: String) -> String { PhoneSyncClient.wireDeviceName(text) }
}
