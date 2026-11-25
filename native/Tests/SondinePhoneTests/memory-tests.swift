import Foundation
import SondinePhone
import Testing

// Reading the Mac's memory from the phone (ADR 008, plan § M5.4): the golden
// fixtures shared with `packages/protocol`, and the reads against the fake
// Mac, which leave no file behind.

private let fixtures = repository.appending(path: "packages/protocol/fixtures/phone")

private func lines(_ name: String) throws -> [(PhoneMemorySchema, Data)] {
    try String(contentsOf: fixtures.appending(path: name), encoding: .utf8)
        .split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        .map { line in
            let whole = try #require(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? NSDictionary)
            let schema = try #require(PhoneMemorySchema(rawValue: whole["schema"] as? String ?? ""), "schema in \(line)")
            return (schema, try JSONSerialization.data(withJSONObject: try #require(whole["value"])))
        }
}

/// The first valid fixture of a schema whose JSON contains `marker`.
private func fixture(_ schema: PhoneMemorySchema, containing marker: String = "") throws -> Data {
    try #require(try lines("memory-valid.jsonl").first { $0.0 == schema && String(decoding: $0.1, as: UTF8.self).contains(marker) }?.1)
}

/// Every file under `root` with its size and modification time.
private func files(_ root: URL) -> [String: String] {
    var found: [String: String] = [:]
    let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
    guard let walk = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys) else { return found }
    for case let url as URL in walk {
        guard let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { continue }
        found[url.path(percentEncoded: false)] =
            "\(values.fileSize ?? -1) \(values.contentModificationDate?.timeIntervalSince1970 ?? -1)"
    }
    return found
}

@Suite struct PhoneMemoryFixtureTests {
    @Test func everyValidMessageDecodesAndEncodesToTheSameJson() throws {
        let valid = try lines("memory-valid.jsonl")
        #expect(valid.count == 19)
        for (schema, value) in valid {
            let again = try schema.roundTrip(value)
            let before = try JSONSerialization.jsonObject(with: value) as? NSDictionary
            let after = try JSONSerialization.jsonObject(with: again) as? NSDictionary
            #expect(before == after, "re-encoded \(schema.rawValue): \(String(decoding: value, as: UTF8.self))")
        }
        #expect(Set(valid.map(\.0)) == Set(PhoneMemorySchema.allCases), "every schema has a valid fixture")
    }

    @Test func everyInvalidMessageIsRefused() throws {
        let invalid = try lines("memory-invalid.jsonl")
        #expect(invalid.count == 22)
        for (schema, value) in invalid {
            #expect(throws: (any Error).self, "accepted \(schema.rawValue): \(String(decoding: value, as: UTF8.self))") {
                try schema.roundTrip(value)
            }
        }
    }

    @Test func aLateCommitmentIsOneDueBeforeTheMacsToday() throws {
        let line = try PhoneJournalLine(
            kind: .commitment, text: "Envoyer le tableau", voices: [], sentenceIds: [1], startMs: 1, done: false,
            due: "2026-11-12")
        let open = try MemoryCommitments(
            today: "2026-11-13", commitments: [try PhoneMemoryLine(line: line, episodeId: 1)], nextBeforeMs: 0)
        #expect(open.isLate(open.commitments[0]))
        var notYet = open.commitments[0]
        notYet.line.due = "2026-11-13"
        #expect(!open.isLate(notYet))
        notYet.line.due = nil
        #expect(!open.isLate(notYet))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "Europe/Paris"))
        #expect(memoryDay(Date(timeIntervalSince1970: 1_794_567_600), calendar: calendar) == "2026-11-13")
    }
}

@Suite struct MacMemoryTests {
    /// A paired phone, the fake Mac answering every read from the fixtures.
    private func pairedRig() async throws -> (SyncRig, FakeMac, MacMemory) {
        let mac = FakeMac()
        let rig = try SyncRig()
        try await rig.paired(with: mac)
        try mac.state.withLock { state in
            state.memory = [
                PhoneSync.MemoryRoute.search: try fixture(.memorySearchAnswer, containing: "\"total\":42"),
                PhoneSync.MemoryRoute.day: try fixture(.memoryDayAnswer, containing: "conversations"),
                PhoneSync.MemoryRoute.journal: try fixture(.memoryJournalAnswer, containing: "lines"),
                PhoneSync.MemoryRoute.commitments: try fixture(.memoryCommitmentsAnswer, containing: "today"),
                PhoneSync.MemoryRoute.conversation: try fixture(.memoryConversationAnswer, containing: "sentences"),
            ]
        }
        return (rig, mac, MacMemory(client: rig.client))
    }

    @Test func aReadingSessionLeavesNoFileInTheAppsFolder() async throws {
        let (rig, mac, memory) = try await pairedRig()
        _ = try rig.recording(bytes: 1_000)
        let before = files(rig.root)
        #expect(!before.isEmpty)

        guard case let .read(page) = await memory.search("  budget ", offset: 0) else {
            Issue.record("no results")
            return
        }
        #expect(page.total == 42)
        #expect(page.nextOffset == 20)
        #expect(page.episodes.first?.episode.phone?.recordingId != nil)
        #expect(page.episodes.first?.hits.first?.speaker?.isSelf == true)
        guard case let .read(day) = await memory.day("2026-11-12") else {
            Issue.record("no day")
            return
        }
        #expect(day.conversations.map(\.episodeId) == [13, 12, 14])
        guard case let .read(journal) = await memory.journal("2026-11-12") else {
            Issue.record("no journal")
            return
        }
        #expect(journal.lines.first?.episodeId == 12)
        #expect(journal.commitments.count == 2)
        guard case let .read(open) = await memory.commitments() else {
            Issue.record("no commitments")
            return
        }
        #expect(open.today == "2026-11-13")
        guard case let .read(conversation) = await memory.conversation(12) else {
            Issue.record("no conversation")
            return
        }
        #expect(conversation.sentences.map(\.id) == [41, 42])
        #expect(conversation.speakers.last?.guess == "Marie")

        // What was sent: the trimmed text, the day, nothing else.
        let sent = mac.state.withLock { $0.memoryRequests }.map { String(decoding: $0, as: UTF8.self) }
        #expect(sent.first == #"{"offset":0,"text":"budget"}"# || sent.first == #"{"text":"budget","offset":0}"#)
        #expect(sent.count == 5)
        // The app's folder holds the same files, unchanged: the answers live in memory only.
        #expect(files(rig.root) == before)
    }

    @Test func aWithheldAnswerIsAskedAgainTwiceAtMost() async throws {
        let (_, mac, memory) = try await pairedRig()
        mac.state.withLock { $0.withheld[PhoneSync.MemoryRoute.journal] = 2 }
        guard case .read = await memory.journal("2026-11-12") else {
            Issue.record("not read on the third try")
            return
        }
        mac.state.withLock { $0.withheld[PhoneSync.MemoryRoute.journal] = 3 }
        #expect(await memory.journal("2026-11-12") == .withheld)
        mac.state.withLock { $0.memory[PhoneSync.MemoryRoute.conversation] = Data(#"{"status":"gone"}"#.utf8) }
        #expect(await memory.conversation(99) == .gone)
    }

    @Test func withoutTheMacItSaysSoAndRevokedItUnpairs() async throws {
        // Never paired: nothing is asked.
        let lone = try SyncRig()
        #expect(await MacMemory(client: lone.client).search("budget") == .notPaired)

        let (rig, mac, memory) = try await pairedRig()
        // A blank search, a day that does not exist: refused before anything is sent.
        #expect(await memory.search("   ") == .refused(.badRequest))
        #expect(await memory.day("2026-02-30") == .refused(.badRequest))
        #expect(mac.state.withLock { $0.memoryRequests }.isEmpty)

        // The Mac away: « Le Mac n'est pas joignable », and the pairing stays.
        mac.reachableAtHome(false)
        #expect(await memory.search("budget") == .unreachable)
        #expect(await rig.client.status.reachable == false)
        #expect(await rig.client.status.mac != nil)
        mac.reachableAtHome(true)

        // Revoked on the Mac: the read is refused and the phone forgets the pairing.
        mac.state.withLock { $0.revoked = true }
        #expect(await memory.commitments() == .refused(.revoked))
        #expect(await rig.client.status.mac == nil)
        #expect(await memory.commitments() == .notPaired)
    }
}

/// « Plus de résultats » (M5.4): a page belongs to the search and the reading session it was asked for.
@Suite struct SearchPagingTests {
    private func page(_ ids: [Int], next: Int?) throws -> MemorySearchResults {
        let episodes = try ids.map { id in
            try PhoneSearchEpisode(
                episode: PhoneEpisode(
                    episodeId: id, startedAtMs: 1, endedAtMs: 2, context: .inPerson, size: .conversation,
                    firstWords: nil, people: [], guesses: [], apps: [], phone: nil),
                hitCount: 1, hits: [], notes: [])
        }
        return try MemorySearchResults(episodes: episodes, total: 100, untranscribed: 0, nextOffset: next)
    }

    @Test func aPageOfAnOldSearchNeverEntersTheNewOne() throws {
        var paging = SearchPaging()
        paging.start(query: "budget", session: 1, first: try page([1, 2], next: 20))
        let askedAsked = paging.next()
        let asked = try #require(askedAsked)
        #expect(asked == SearchPaging.Request(query: "budget", session: 1, offset: 20))
        let twice = paging.next()
        #expect(twice == nil, "one page at a time")
        // Another search is submitted before the page comes back.
        paging.start(query: "marie", session: 1, first: try page([7], next: 40))
        let late = try page([3, 4], next: 60)
        let kept = paging.receive(.read(late), for: asked)
        #expect(!kept)
        #expect(paging.more.isEmpty)
        #expect(paging.nextOffset == 40)
        let next = paging.next()
        #expect(next?.offset == 40)
        #expect(next?.query == "marie")
    }

    @Test func aPageAskedBeforeTheAppLeftTheFrontIsDropped() throws {
        var paging = SearchPaging()
        paging.start(query: "budget", session: 1, first: try page([1], next: 20))
        let askedAsked = paging.next()
        let asked = try #require(askedAsked)
        // The app left the front: the screen drops what it read, the same search reads again.
        paging.start(query: "budget", session: 2, first: nil)
        let late = try page([3], next: nil)
        let kept = paging.receive(.read(late), for: asked)
        #expect(!kept)
        #expect(paging.more.isEmpty)
        #expect(paging.nextOffset == nil)
        #expect(paging.pending == nil)
    }

    @Test func pagesFollowEachOtherWithoutAnEpisodeTwice() throws {
        var paging = SearchPaging()
        paging.start(query: "budget", session: 1, first: try page([1, 2], next: 2))
        let failedAsked = paging.next()
        let failed = try #require(failedAsked)
        let answered = paging.receive(.unreachable, for: failed)
        #expect(answered)
        // A failed page leaves the offset, to ask again.
        let againAsked = paging.next()
        let again = try #require(againAsked)
        #expect(again.offset == 2)
        let second = try page([2, 3], next: 4)
        let keptSecond = paging.receive(.read(second), for: again)
        #expect(keptSecond)
        #expect(paging.more.map(\.id) == [3])
        let lastAsked = paging.next()
        let last = try #require(lastAsked)
        let third = try page([5], next: nil)
        let keptThird = paging.receive(.read(third), for: last)
        #expect(keptThird)
        #expect(paging.more.map(\.id) == [3, 5])
        let none = paging.next()
        #expect(none == nil)
        let extra = try page([9], next: nil)
        let keptTwice = paging.receive(.read(extra), for: last)
        #expect(!keptTwice, "answered once")
    }
}
