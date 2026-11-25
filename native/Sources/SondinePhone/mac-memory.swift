import Foundation

// The Mac's memory read from the phone (ADR 008, M5.4): search, a day, its
// journal, the open commitments and an episode's text, live. The answers
// live in the caller's memory and go with the screen that shows them;
// nothing here writes a file. An answer the Mac withheld (something was
// deleted while it was read) is asked again, twice at most.

/// What one live read got from the Mac.
public enum MacRead: Equatable, Sendable {
    /// The answer's JSON body.
    case answer(Data)
    case notPaired
    /// No address answered, or the key was not the pinned one.
    case unreachable
    case refused(status: Int, PhoneErrorCode)
}

/// A read of the Mac's memory, as a screen shows it.
public enum MemoryRead<Value: Equatable & Sendable>: Equatable, Sendable {
    case read(Value)
    /// No Mac is paired: there is nothing to read.
    case notPaired
    /// « Le Mac n'est pas joignable ».
    case unreachable
    /// Withheld three times in a row: the Mac is deleting; try again in a moment.
    case withheld
    /// The episode was deleted on the Mac, or never there.
    case gone
    /// Revoked, another version, busy, or an answer the contract does not allow.
    case refused(PhoneErrorCode)
}

/// The day the phone shows, as the Mac names days: `YYYY-MM-DD` in the phone's calendar.
public func memoryDay(_ date: Date, calendar: Calendar = .current) -> String {
    let parts = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
}

public struct MacMemory: Sendable {
    /// How many times a withheld answer is asked for, in all.
    static let attempts = 3

    /// Asks the Mac: a route and its JSON request, the answer as it came.
    public typealias Read = @Sendable (_ path: String, _ json: Data) async -> MacRead

    private let read: Read

    public init(client: PhoneSyncClient) { read = { path, json in await client.read(path, json: json) } }

    /// Answers from elsewhere than a paired Mac: the app's demonstration with invented data.
    public init(read: @escaping Read) { self.read = read }

    /// A page of results for `text` (trimmed), from `offset`.
    public func search(_ text: String, offset: Int = 0) async -> MemoryRead<MemorySearchResults> {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let request = try? MemorySearchRequest(text: trimmed, offset: offset) else { return .refused(.badRequest) }
        return await ask(PhoneSync.MemoryRoute.search, request, MemorySearchAnswer.self) { answer in
            switch answer {
            case let .results(page): .read(page)
            case .withheld: nil
            }
        }
    }

    /// A day's conversations and counts, `YYYY-MM-DD`.
    public func day(_ day: String) async -> MemoryRead<MemoryDay> {
        guard let request = try? MemoryDayRequest(day: day) else { return .refused(.badRequest) }
        return await ask(PhoneSync.MemoryRoute.day, request, MemoryDayAnswer.self) { answer in
            switch answer {
            case let .day(day): .read(day)
            case .withheld: nil
            }
        }
    }

    /// A day's journal lines and the commitments made that day.
    public func journal(_ day: String) async -> MemoryRead<MemoryJournal> {
        guard let request = try? MemoryDayRequest(day: day) else { return .refused(.badRequest) }
        return await ask(PhoneSync.MemoryRoute.journal, request, MemoryJournalAnswer.self) { answer in
            switch answer {
            case let .journal(journal): .read(journal)
            case .withheld: nil
            }
        }
    }

    /// The open commitments of the 90 days before `beforeMs` (now when nil).
    public func commitments(before beforeMs: Int64? = nil) async -> MemoryRead<MemoryCommitments> {
        guard let request = try? MemoryCommitmentsRequest(beforeMs: beforeMs) else { return .refused(.badRequest) }
        return await ask(PhoneSync.MemoryRoute.commitments, request, MemoryCommitmentsAnswer.self) { answer in
            switch answer {
            case let .commitments(open): .read(open)
            case .withheld: nil
            }
        }
    }

    /// An episode's text, read only.
    public func conversation(_ episodeId: Int) async -> MemoryRead<MemoryConversation> {
        guard let request = try? MemoryConversationRequest(episodeId: episodeId) else { return .refused(.badRequest) }
        return await ask(PhoneSync.MemoryRoute.conversation, request, MemoryConversationAnswer.self) { answer in
            switch answer {
            case let .conversation(read): .read(read)
            case .gone: .gone
            case .withheld: nil
            }
        }
    }

    /// Asks, decodes, and asks again while withheld (`unwrap` answers nil then).
    private func ask<Answer: Decodable, Value>(
        _ path: String, _ request: some Encodable, _ type: Answer.Type, unwrap: (Answer) -> MemoryRead<Value>?
    ) async -> MemoryRead<Value> {
        guard let json = try? JSONEncoder().encode(request) else { return .refused(.badRequest) }
        for _ in 0..<Self.attempts {
            switch await read(path, json) {
            case .notPaired: return .notPaired
            case .unreachable: return .unreachable
            case let .refused(_, code): return .refused(code)
            case let .answer(body):
                guard let answer = try? JSONDecoder().decode(type, from: body) else { return .refused(.badRequest) }
                if let value = unwrap(answer) { return value }
            }
        }
        return .withheld
    }
}

/// The pages after the first of one search, as « Plus de résultats » brings
/// them. A page is kept only as the answer to the request still pending: one
/// asked for another search, or before the reading session moved (the app
/// left the front), is dropped when it comes.
public struct SearchPaging: Equatable, Sendable {
    /// A page asked for: its search, the reading session it belongs to, where it starts.
    public struct Request: Equatable, Sendable {
        public let query: String
        public let session: Int
        public let offset: Int

        public init(query: String, session: Int, offset: Int) {
            self.query = query
            self.session = session
            self.offset = offset
        }
    }

    public private(set) var query: String
    public private(set) var session: Int
    /// The episodes of the pages after the first, none twice.
    public private(set) var more: [PhoneSearchEpisode] = []
    /// Where the next page starts; nil on the last one.
    public private(set) var nextOffset: Int?
    /// The page asked for and not answered yet.
    public private(set) var pending: Request?
    private var seen: Set<Int> = []

    public init(query: String = "", session: Int = 0) {
        self.query = query
        self.session = session
    }

    /// A search's first page (nil while it loads, or when it failed): what came after another one goes.
    public mutating func start(query: String, session: Int, first: MemorySearchResults?) {
        self = SearchPaging(query: query, session: session)
        nextOffset = first?.nextOffset
        seen = Set(first?.episodes.map(\.id) ?? [])
    }

    /// The next page to ask for; nil on the last page or while one is pending.
    public mutating func next() -> Request? {
        guard pending == nil, let nextOffset else { return nil }
        let request = Request(query: query, session: session, offset: nextOffset)
        pending = request
        return request
    }

    /// A page's answer: kept only for the request still pending (true then).
    /// A failed read leaves the offset, to ask again.
    @discardableResult
    public mutating func receive(_ read: MemoryRead<MemorySearchResults>, for request: Request) -> Bool {
        guard request == pending else { return false }
        pending = nil
        guard case let .read(page) = read else { return true }
        for found in page.episodes where seen.insert(found.id).inserted { more.append(found) }
        nextOffset = page.nextOffset
        return true
    }
}
