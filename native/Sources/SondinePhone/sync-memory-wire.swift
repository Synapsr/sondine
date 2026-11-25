import Foundation

// The phone's live reads of the Mac's memory (ADR 008, M5.4): search, a day,
// its journal, the open commitments and an episode's text. The schemas and
// their fixtures live in `packages/protocol` (`phone-memory.ts`,
// `fixtures/phone/memory-*.jsonl`); these types decode exactly what zod
// accepts there and encode what it reads back. What they carry lives in the
// app's memory only, never in a file.

extension PhoneSync {
    /// Largest answer of a memory read: a long conversation's text.
    public static let maxMemoryBytes = 8 << 20
    /// Episodes in one page of search results.
    public static let searchPage = 20

    public enum MemoryRoute {
        public static let search = "/v1/memory/search"
        public static let day = "/v1/memory/day"
        public static let journal = "/v1/memory/journal"
        public static let commitments = "/v1/memory/commitments"
        public static let conversation = "/v1/memory/conversation"
    }
}

/// An episode of the Mac's memory as the phone lists it.
public struct PhoneEpisode: Codable, Equatable, Sendable, Identifiable {
    public enum Context: String, Codable, Sendable {
        case call
        case inPerson = "in_person"
        case media, mixed, dictation, imported
    }

    public enum Size: String, Codable, Sendable { case trace, moment, conversation }

    /// A phone recording: its name, and its id when this phone made it.
    public struct Phone: Equatable, Sendable {
        public var name: String?
        public var recordingId: UUID?

        public init(name: String?, recordingId: UUID?) throws {
            self.name = try name.map(Wire.recordingName)
            self.recordingId = recordingId
        }
    }

    public var episodeId: Int
    public var startedAtMs: Int64
    /// Nil while it goes on.
    public var endedAtMs: Int64?
    public var context: Context?
    public var size: Size?
    public var firstWords: String?
    /// The names the user gave its voices.
    public var people: [String]
    /// Whom Sondine takes other voices for: unconfirmed.
    public var guesses: [String]
    public var apps: [String]
    public var phone: Phone?

    public var id: Int { episodeId }

    public init(
        episodeId: Int, startedAtMs: Int64, endedAtMs: Int64?, context: Context?, size: Size?, firstWords: String?,
        people: [String], guesses: [String], apps: [String], phone: Phone?
    ) throws {
        self.episodeId = try Wire.atLeast(1, episodeId)
        self.startedAtMs = try Wire.atLeast(0, startedAtMs)
        self.endedAtMs = try endedAtMs.map { try Wire.atLeast(0, $0) }
        self.context = context
        self.size = size
        self.firstWords = try firstWords.map { try Wire.text($0, 0, 120) }
        self.people = try Wire.atMost(16, people.map { try Wire.text($0, 1, 200) })
        self.guesses = try Wire.atMost(16, guesses.map { try Wire.text($0, 1, 200) })
        self.apps = try Wire.atMost(8, apps.map { try Wire.text($0, 1, 120) })
        self.phone = phone
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject([
            "episodeId", "startedAtMs", "endedAtMs", "context", "size", "firstWords", "people", "guesses", "apps", "phone",
        ])
        let context = try c.nullable("context") { key in
            guard let value = Context(rawValue: try c.string(key)) else { throw WireError.value("context") }
            return value
        }
        let size = try c.nullable("size") { key in
            guard let value = Size(rawValue: try c.string(key)) else { throw WireError.value("size") }
            return value
        }
        let phone = try c.nullable("phone") { key -> Phone in
            let p = try c.nestedContainer(keyedBy: WireKey.self, forKey: WireKey(key))
            let keys = Set(p.allKeys.map(\.stringValue))
            guard keys == ["name", "recordingId"] else { throw WireError.fields }
            return try Phone(name: p.nullable("name", p.string), recordingId: p.nullable("recordingId", p.uuid))
        }
        try self.init(
            episodeId: c.int("episodeId"), startedAtMs: c.int64("startedAtMs"),
            endedAtMs: c.nullable("endedAtMs", c.int64), context: context, size: size,
            firstWords: c.nullable("firstWords", c.string), people: c.strings("people"), guesses: c.strings("guesses"),
            apps: c.strings("apps"), phone: phone)
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(episodeId, "episodeId")
        try c.put(startedAtMs, "startedAtMs")
        try c.putNullable(endedAtMs, "endedAtMs")
        try c.putNullable(context?.rawValue, "context")
        try c.putNullable(size?.rawValue, "size")
        try c.putNullable(firstWords, "firstWords")
        try c.put(people, "people")
        try c.put(guesses, "guesses")
        try c.put(apps, "apps")
        if let phone {
            var p = c.nestedContainer(keyedBy: WireKey.self, forKey: WireKey("phone"))
            try p.putNullable(phone.name, "name")
            try p.putNullable(phone.recordingId?.wire, "recordingId")
        } else {
            try c.encodeNil(forKey: WireKey("phone"))
        }
    }
}

/// Where the search matched in a text, in UTF-16 code units.
public struct PhoneTextRange: Codable, Equatable, Sendable {
    public var start: Int
    public var end: Int

    public init(start: Int, end: Int) throws {
        self.start = try Wire.atLeast(0, start)
        self.end = try Wire.atLeast(0, end)
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["start", "end"])
        try self.init(start: c.int("start"), end: c.int("end"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(start, "start")
        try c.put(end, "end")
    }
}

/// A sentence the search found, with the voice that said it.
public struct PhoneSearchHit: Codable, Equatable, Sendable, Identifiable {
    public var sentenceId: Int
    public var startMs: Int64
    public var endMs: Int64
    public var text: String
    public var highlights: [PhoneTextRange]
    public var speaker: PhoneSpeaker?

    public var id: Int { sentenceId }

    public init(
        sentenceId: Int, startMs: Int64, endMs: Int64, text: String, highlights: [PhoneTextRange], speaker: PhoneSpeaker?
    ) throws {
        self.sentenceId = try Wire.atLeast(1, sentenceId)
        self.startMs = try Wire.atLeast(0, startMs)
        self.endMs = try Wire.atLeast(0, endMs)
        self.text = try Wire.text(text, 0, 20_000)
        self.highlights = try Wire.atMost(64, highlights)
        self.speaker = speaker
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["sentenceId", "startMs", "endMs", "text", "highlights", "speaker"])
        try self.init(
            sentenceId: c.int("sentenceId"), startMs: c.int64("startMs"), endMs: c.int64("endMs"), text: c.string("text"),
            highlights: c.decode([PhoneTextRange].self, forKey: WireKey("highlights")),
            speaker: c.nullable("speaker") { try c.decode(PhoneSpeaker.self, forKey: WireKey($0)) })
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(sentenceId, "sentenceId")
        try c.put(startMs, "startMs")
        try c.put(endMs, "endMs")
        try c.put(text, "text")
        try c.put(highlights, "highlights")
        try c.putNullable(speaker, "speaker")
    }
}

/// A note or a link the search found: its first 500 characters.
public struct PhoneSearchNote: Codable, Equatable, Sendable {
    public var text: String
    public var highlights: [PhoneTextRange]

    public init(text: String, highlights: [PhoneTextRange]) throws {
        self.text = try Wire.text(text, 1, 500)
        self.highlights = try Wire.atMost(64, highlights)
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["text", "highlights"])
        try self.init(text: c.string("text"), highlights: c.decode([PhoneTextRange].self, forKey: WireKey("highlights")))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(text, "text")
        try c.put(highlights, "highlights")
    }
}

/// An episode the search found: its matches.
public struct PhoneSearchEpisode: Codable, Equatable, Sendable, Identifiable {
    public var episode: PhoneEpisode
    public var hitCount: Int
    public var hits: [PhoneSearchHit]
    public var notes: [PhoneSearchNote]

    public var id: Int { episode.episodeId }

    public init(episode: PhoneEpisode, hitCount: Int, hits: [PhoneSearchHit], notes: [PhoneSearchNote]) throws {
        self.episode = episode
        self.hitCount = try Wire.atLeast(0, hitCount)
        self.hits = try Wire.atMost(5, hits)
        self.notes = try Wire.atMost(5, notes)
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["episode", "hitCount", "hits", "notes"])
        try self.init(
            episode: c.decode(PhoneEpisode.self, forKey: WireKey("episode")), hitCount: c.int("hitCount"),
            hits: c.decode([PhoneSearchHit].self, forKey: WireKey("hits")),
            notes: c.decode([PhoneSearchNote].self, forKey: WireKey("notes")))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(episode, "episode")
        try c.put(hitCount, "hitCount")
        try c.put(hits, "hits")
        try c.put(notes, "notes")
    }
}

/// A line of the Mac's journal or a commitment, with the episode it is about.
public struct PhoneMemoryLine: Codable, Equatable, Sendable {
    public var line: PhoneJournalLine
    public var episodeId: Int

    public init(line: PhoneJournalLine, episodeId: Int) throws {
        self.line = line
        self.episodeId = try Wire.atLeast(1, episodeId)
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["kind", "text", "voices", "sentenceIds", "startMs", "done", "due", "episodeId"])
        guard let kind = PhoneJournalLine.Kind(rawValue: try c.string("kind")) else { throw WireError.value("kind") }
        try self.init(
            line: PhoneJournalLine(
                kind: kind, text: c.string("text"), voices: c.decode([PhoneLineVoice].self, forKey: WireKey("voices")),
                sentenceIds: c.decode([Int].self, forKey: WireKey("sentenceIds")), startMs: c.int64("startMs"),
                done: c.bool("done"), due: c.nullable("due", c.string)),
            episodeId: c.int("episodeId"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(line.kind.rawValue, "kind")
        try c.put(line.text, "text")
        try c.put(line.voices, "voices")
        try c.put(line.sentenceIds, "sentenceIds")
        try c.put(line.startMs, "startMs")
        try c.put(line.done, "done")
        try c.putNullable(line.due, "due")
        try c.put(episodeId, "episodeId")
    }
}

// Requests

/// A search of the Mac's transcripts, from `offset` (episodes skipped).
public struct MemorySearchRequest: Codable, Equatable, Sendable {
    public var text: String
    public var offset: Int

    /// `text` trimmed: 1 to 200 UTF-16 units, no control character.
    public init(text: String, offset: Int) throws {
        guard !text.isEmpty, text.utf16.count <= 200,
              !text.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F })
        else { throw WireError.value("text") }
        guard (0...10_000).contains(offset) else { throw WireError.value("offset") }
        self.text = text
        self.offset = offset
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["text", "offset"])
        try self.init(text: c.string("text"), offset: c.int("offset"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(text, "text")
        try c.put(offset, "offset")
    }
}

/// A day, `YYYY-MM-DD` in the Mac's time zone: the request of `day` and `journal`.
public struct MemoryDayRequest: Codable, Equatable, Sendable {
    public var day: String

    public init(day: String) throws { self.day = try Wire.isoDate(day) }

    public init(from decoder: any Decoder) throws {
        try self.init(day: decoder.strictObject(["day"]).string("day"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(day, "day")
    }
}

/// The open commitments made in the 90 days before `beforeMs` (now when nil).
public struct MemoryCommitmentsRequest: Codable, Equatable, Sendable {
    public var beforeMs: Int64?

    public init(beforeMs: Int64?) throws { self.beforeMs = try beforeMs.map { try Wire.atLeast(0, $0) } }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.strictObject(["beforeMs"])
        try self.init(beforeMs: c.nullable("beforeMs", c.int64))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.putNullable(beforeMs, "beforeMs")
    }
}

/// An episode's text, by its id on the Mac.
public struct MemoryConversationRequest: Codable, Equatable, Sendable {
    public var episodeId: Int

    public init(episodeId: Int) throws { self.episodeId = try Wire.atLeast(1, episodeId) }

    public init(from decoder: any Decoder) throws {
        try self.init(episodeId: decoder.strictObject(["episodeId"]).int("episodeId"))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        try c.put(episodeId, "episodeId")
    }
}

// Answers: each may be `withheld` (something was deleted while it was read: ask again).

/// A page of search results.
public struct MemorySearchResults: Equatable, Sendable {
    public var episodes: [PhoneSearchEpisode]
    public var total: Int
    /// Closed episodes not transcribed yet: the search cannot see them.
    public var untranscribed: Int
    /// Nil on the last page.
    public var nextOffset: Int?

    public init(episodes: [PhoneSearchEpisode], total: Int, untranscribed: Int, nextOffset: Int?) throws {
        self.episodes = try Wire.atMost(PhoneSync.searchPage, episodes)
        self.total = try Wire.atLeast(0, total)
        self.untranscribed = try Wire.atLeast(0, untranscribed)
        self.nextOffset = try nextOffset.map { try Wire.atLeast(1, $0) }
    }
}

public enum MemorySearchAnswer: Codable, Equatable, Sendable {
    case results(MemorySearchResults)
    case withheld

    public init(from decoder: any Decoder) throws {
        switch try MemoryStatus.of(decoder) {
        case "results":
            let c = try decoder.strictObject(["status", "episodes", "total", "untranscribed", "nextOffset"])
            self = .results(try MemorySearchResults(
                episodes: c.decode([PhoneSearchEpisode].self, forKey: WireKey("episodes")), total: c.int("total"),
                untranscribed: c.int("untranscribed"), nextOffset: c.nullable("nextOffset", c.int)))
        case "withheld": self = try MemoryStatus.withheld(decoder, .withheld)
        default: throw WireError.value("status")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        switch self {
        case let .results(page):
            try c.put("results", "status")
            try c.put(page.episodes, "episodes")
            try c.put(page.total, "total")
            try c.put(page.untranscribed, "untranscribed")
            try c.putNullable(page.nextOffset, "nextOffset")
        case .withheld: try c.put("withheld", "status")
        }
    }
}

/// A day of the Mac's memory: its conversations, and how many other episodes it had.
public struct MemoryDay: Equatable, Sendable {
    public var day: String
    public var conversations: [PhoneEpisode]
    public var moments: Int
    public var media: Int
    public var dictations: Int
    public var traces: Int

    public init(day: String, conversations: [PhoneEpisode], moments: Int, media: Int, dictations: Int, traces: Int) throws {
        self.day = try Wire.isoDate(day)
        self.conversations = try Wire.atMost(100, conversations)
        self.moments = try Wire.atLeast(0, moments)
        self.media = try Wire.atLeast(0, media)
        self.dictations = try Wire.atLeast(0, dictations)
        self.traces = try Wire.atLeast(0, traces)
    }
}

public enum MemoryDayAnswer: Codable, Equatable, Sendable {
    case day(MemoryDay)
    case withheld

    public init(from decoder: any Decoder) throws {
        switch try MemoryStatus.of(decoder) {
        case "day":
            let c = try decoder.strictObject(["status", "day", "conversations", "moments", "media", "dictations", "traces"])
            self = .day(try MemoryDay(
                day: c.string("day"), conversations: c.decode([PhoneEpisode].self, forKey: WireKey("conversations")),
                moments: c.int("moments"), media: c.int("media"), dictations: c.int("dictations"), traces: c.int("traces")))
        case "withheld": self = try MemoryStatus.withheld(decoder, .withheld)
        default: throw WireError.value("status")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        switch self {
        case let .day(day):
            try c.put("day", "status")
            try c.put(day.day, "day")
            try c.put(day.conversations, "conversations")
            try c.put(day.moments, "moments")
            try c.put(day.media, "media")
            try c.put(day.dictations, "dictations")
            try c.put(day.traces, "traces")
        case .withheld: try c.put("withheld", "status")
        }
    }
}

/// A day's journal: its lines and the commitments made that day.
public struct MemoryJournal: Equatable, Sendable {
    public var day: String
    public var lines: [PhoneMemoryLine]
    public var commitments: [PhoneMemoryLine]
    /// Conversations of the day not written yet.
    public var pending: Int
    public var writing: Bool

    public init(day: String, lines: [PhoneMemoryLine], commitments: [PhoneMemoryLine], pending: Int, writing: Bool) throws {
        self.day = try Wire.isoDate(day)
        self.lines = try Wire.atMost(1_000, lines)
        self.commitments = try Wire.atMost(2_000, commitments)
        self.pending = try Wire.atLeast(0, pending)
        self.writing = writing
    }
}

public enum MemoryJournalAnswer: Codable, Equatable, Sendable {
    case journal(MemoryJournal)
    case withheld

    public init(from decoder: any Decoder) throws {
        switch try MemoryStatus.of(decoder) {
        case "journal":
            let c = try decoder.strictObject(["status", "day", "lines", "commitments", "pending", "writing"])
            self = .journal(try MemoryJournal(
                day: c.string("day"), lines: c.decode([PhoneMemoryLine].self, forKey: WireKey("lines")),
                commitments: c.decode([PhoneMemoryLine].self, forKey: WireKey("commitments")), pending: c.int("pending"),
                writing: c.bool("writing")))
        case "withheld": self = try MemoryStatus.withheld(decoder, .withheld)
        default: throw WireError.value("status")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        switch self {
        case let .journal(journal):
            try c.put("journal", "status")
            try c.put(journal.day, "day")
            try c.put(journal.lines, "lines")
            try c.put(journal.commitments, "commitments")
            try c.put(journal.pending, "pending")
            try c.put(journal.writing, "writing")
        case .withheld: try c.put("withheld", "status")
        }
    }
}

/// A page of the open commitments, newest conversation first; one whose `due` is before `today` is late.
public struct MemoryCommitments: Equatable, Sendable {
    public var today: String
    public var commitments: [PhoneMemoryLine]
    public var nextBeforeMs: Int64

    public init(today: String, commitments: [PhoneMemoryLine], nextBeforeMs: Int64) throws {
        self.today = try Wire.isoDate(today)
        self.commitments = try Wire.atMost(500, commitments)
        self.nextBeforeMs = try Wire.atLeast(0, nextBeforeMs)
    }

    /// Due before the Mac's today (`YYYY-MM-DD` compares as text).
    public func isLate(_ commitment: PhoneMemoryLine) -> Bool {
        guard let due = commitment.line.due else { return false }
        return due < today
    }
}

public enum MemoryCommitmentsAnswer: Codable, Equatable, Sendable {
    case commitments(MemoryCommitments)
    case withheld

    public init(from decoder: any Decoder) throws {
        switch try MemoryStatus.of(decoder) {
        case "commitments":
            let c = try decoder.strictObject(["status", "today", "commitments", "nextBeforeMs"])
            self = .commitments(try MemoryCommitments(
                today: c.string("today"), commitments: c.decode([PhoneMemoryLine].self, forKey: WireKey("commitments")),
                nextBeforeMs: c.int64("nextBeforeMs")))
        case "withheld": self = try MemoryStatus.withheld(decoder, .withheld)
        default: throw WireError.value("status")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        switch self {
        case let .commitments(open):
            try c.put("commitments", "status")
            try c.put(open.today, "today")
            try c.put(open.commitments, "commitments")
            try c.put(open.nextBeforeMs, "nextBeforeMs")
        case .withheld: try c.put("withheld", "status")
        }
    }
}

/// An episode's text, read only.
public struct MemoryConversation: Equatable, Sendable {
    public var episode: PhoneEpisode
    public var speakers: [PhoneSpeaker]
    public var sentences: [PhoneSentence]
    public var notes: [PhoneNote]
    /// The last sentences did not fit in one answer.
    public var truncated: Bool

    public init(
        episode: PhoneEpisode, speakers: [PhoneSpeaker], sentences: [PhoneSentence], notes: [PhoneNote], truncated: Bool
    ) throws {
        self.episode = episode
        self.speakers = try Wire.atMost(64, speakers)
        self.sentences = sentences
        self.notes = try Wire.atMost(500, notes)
        self.truncated = truncated
    }
}

public enum MemoryConversationAnswer: Codable, Equatable, Sendable {
    case conversation(MemoryConversation)
    /// Deleted on the Mac, or never there.
    case gone
    case withheld

    public init(from decoder: any Decoder) throws {
        switch try MemoryStatus.of(decoder) {
        case "conversation":
            let c = try decoder.strictObject(["status", "episode", "speakers", "sentences", "notes", "truncated"])
            self = .conversation(try MemoryConversation(
                episode: c.decode(PhoneEpisode.self, forKey: WireKey("episode")),
                speakers: c.decode([PhoneSpeaker].self, forKey: WireKey("speakers")),
                sentences: c.decode([PhoneSentence].self, forKey: WireKey("sentences")),
                notes: c.decode([PhoneNote].self, forKey: WireKey("notes")), truncated: c.bool("truncated")))
        case "gone": self = try MemoryStatus.withheld(decoder, .gone)
        case "withheld": self = try MemoryStatus.withheld(decoder, .withheld)
        default: throw WireError.value("status")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.object()
        switch self {
        case let .conversation(read):
            try c.put("conversation", "status")
            try c.put(read.episode, "episode")
            try c.put(read.speakers, "speakers")
            try c.put(read.sentences, "sentences")
            try c.put(read.notes, "notes")
            try c.put(read.truncated, "truncated")
        case .gone: try c.put("gone", "status")
        case .withheld: try c.put("withheld", "status")
        }
    }
}

/// The `status` that tells a memory answer's cases apart.
enum MemoryStatus {
    static func of(_ decoder: any Decoder) throws -> String {
        try decoder.container(keyedBy: WireKey.self).string("status")
    }

    /// An answer that is its status alone.
    static func withheld<T>(_ decoder: any Decoder, _ value: T) throws -> T {
        _ = try decoder.strictObject(["status"])
        return value
    }
}

// Fixtures

/// Every memory message by its schema's name, as the fixtures' `schema` field names it.
public enum PhoneMemorySchema: String, CaseIterable, Sendable {
    case memorySearchRequest = "MemorySearchRequest"
    case memorySearchAnswer = "MemorySearchAnswer"
    case memoryDayRequest = "MemoryDayRequest"
    case memoryDayAnswer = "MemoryDayAnswer"
    case memoryJournalRequest = "MemoryJournalRequest"
    case memoryJournalAnswer = "MemoryJournalAnswer"
    case memoryCommitmentsRequest = "MemoryCommitmentsRequest"
    case memoryCommitmentsAnswer = "MemoryCommitmentsAnswer"
    case memoryConversationRequest = "MemoryConversationRequest"
    case memoryConversationAnswer = "MemoryConversationAnswer"

    /// Decodes `json` as this schema and encodes it again; throws on anything the schema refuses.
    public func roundTrip(_ json: Data) throws -> Data {
        func again<T: Codable>(_ type: T.Type) throws -> Data { try JSONEncoder().encode(try JSONDecoder().decode(type, from: json)) }
        return switch self {
        case .memorySearchRequest: try again(MemorySearchRequest.self)
        case .memorySearchAnswer: try again(MemorySearchAnswer.self)
        case .memoryDayRequest, .memoryJournalRequest: try again(MemoryDayRequest.self)
        case .memoryDayAnswer: try again(MemoryDayAnswer.self)
        case .memoryJournalAnswer: try again(MemoryJournalAnswer.self)
        case .memoryCommitmentsRequest: try again(MemoryCommitmentsRequest.self)
        case .memoryCommitmentsAnswer: try again(MemoryCommitmentsAnswer.self)
        case .memoryConversationRequest: try again(MemoryConversationRequest.self)
        case .memoryConversationAnswer: try again(MemoryConversationAnswer.self)
        }
    }
}
