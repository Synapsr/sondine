import SondinePhone
import SwiftUI

// The Mac's memory on the phone (iphone-screens.md §6 « Chercher », §7
// « Aujourd'hui », M5.4): search results, the day's journal and commitments,
// and a conversation's text, read only. Each screen reads live and keeps
// what it read in its own state: gone when the screen goes, dropped when the
// app leaves the front and read again when it comes back. Nothing is written
// on the phone.

/// A conversation of the Mac's memory to open, at a sentence when known.
/// One of this iPhone's own recordings (`recordingId`) opens its own screen
/// instead, with its result and playback, while the iPhone holds it.
struct MemoryTarget: Hashable {
    let episodeId: Int
    let sentenceId: Int?
    var recordingId: UUID?
}

/// « Aujourd'hui », from the home screen.
enum HomeRoute: Hashable {
    case today
}

/// What a memory screen holds: nothing yet, or what the Mac answered.
enum Reading<Value: Equatable & Sendable>: Equatable {
    case loading
    case done(MemoryRead<Value>)
}

/// Reads while the app is in front, again at each return; drops what it read when the app leaves.
private struct LiveReading<Value: Equatable & Sendable>: ViewModifier {
    @Environment(AppModel.self) private var model
    @Binding var reading: Reading<Value>
    let key: String
    let read: (AppModel) async -> MemoryRead<Value>

    func body(content: Content) -> some View {
        content.task(id: "\(key)#\(model.memorySession)") {
            reading = .loading
            guard model.isActive else { return }
            let answer = await read(model)
            if !Task.isCancelled { reading = .done(answer) }
        }
    }
}

extension View {
    func reads<Value>(
        _ reading: Binding<Reading<Value>>, key: String, _ read: @escaping (AppModel) async -> MemoryRead<Value>
    ) -> some View {
        modifier(LiveReading(reading: reading, key: key, read: read))
    }
}

extension MemoryRead {
    /// The same read, its value changed.
    func map<Other>(_ change: (Value) -> Other) -> MemoryRead<Other> {
        switch self {
        case let .read(value): .read(change(value))
        case .notPaired: .notPaired
        case .unreachable: .unreachable
        case .withheld: .withheld
        case .gone: .gone
        case let .refused(code): .refused(code)
        }
    }
}

/// Why there is nothing to show.
enum MemoryWords {
    static func problem<Value>(_ read: MemoryRead<Value>, search: Bool = false) -> String? {
        switch read {
        case .read: nil
        case .notPaired:
            search
                ? String(localized: "Pair this iPhone with your Mac to search its memory.")
                : String(localized: "Pair this iPhone with your Mac to read its memory.")
        case .unreachable:
            search
                ? String(localized: "The Mac cannot be reached. Search reads its memory live.")
                : String(localized: "The Mac cannot be reached. Its memory is read live.")
        case .withheld: String(localized: "Something is being deleted on the Mac. Try again in a moment.")
        case .gone: String(localized: "This conversation was deleted on the Mac.")
        case .refused(.revoked), .refused(.unauthorized): String(localized: "This Mac removed this iPhone's access.")
        case .refused(.version): String(localized: "Update Sondine on the Mac and on the iPhone.")
        case .refused: String(localized: "The Mac did not answer. Try again.")
        }
    }

    /// « En personne », « Appel · FaceTime »…
    static func kind(_ episode: PhoneEpisode) -> String {
        let base = switch episode.context {
        case .call: String(localized: "Call")
        case .media: String(localized: "Media")
        case .mixed: String(localized: "Mixed")
        case .dictation: String(localized: "Dictation")
        case .imported: String(localized: "Imported")
        case .inPerson, nil: String(localized: "In person")
        }
        guard let app = episode.apps.first else { return base }
        return "\(base) · \(app)"
    }

    /// `YYYY-MM-DD`, a day in the Mac's (and the phone's) calendar.
    static func day(_ text: String) -> Date? {
        let parts = text.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    /// « jeu. 13 nov. · 14:32 ».
    static func when(_ ms: Int64) -> String {
        "\(Date(milliseconds: ms).formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))) · \(Notices.clock(ms))"
    }

    /// A sentence with what the search found in it in bold (ranges in UTF-16 units).
    static func highlighted(_ text: String, _ ranges: [PhoneTextRange]) -> AttributedString {
        var shown = AttributedString(text)
        let utf16 = text.utf16
        for range in ranges where range.start < range.end && range.end <= utf16.count {
            guard let from = utf16.index(utf16.startIndex, offsetBy: range.start, limitedBy: utf16.endIndex),
                  let to = utf16.index(utf16.startIndex, offsetBy: range.end, limitedBy: utf16.endIndex),
                  let lower = AttributedString.Index(from, within: shown),
                  let upper = AttributedString.Index(to, within: shown)
            else { continue }
            shown[lower..<upper].inlinePresentationIntent = .stronglyEmphasized
        }
        return shown
    }

    /// A tile's symbol for a conversation of the Mac's memory.
    static func symbol(_ episode: PhoneEpisode) -> String {
        if episode.phone != nil { return "iphone" }
        return switch episode.context {
        case .call: "phone"
        case .media: "play.rectangle"
        case .dictation: "mic"
        case .imported: "square.and.arrow.down"
        case .mixed, .inPerson, nil: "person.2"
        }
    }

    /// Whom it heard, else the phone's name, else its kind: a row's title.
    static func title(_ episode: PhoneEpisode) -> String {
        let voices = episode.people + episode.guesses.map { String(localized: "\($0)?") }
        if !voices.isEmpty { return ListFormatter.localizedString(byJoining: voices) }
        if let name = episode.phone?.name { return name }
        return kind(episode)
    }
}

// Chercher (§6)

/// The results of a search typed on the home screen, newest first, page by page.
struct SearchResults: View {
    @Environment(AppModel.self) private var model
    let query: String
    @State private var reading: Reading<MemorySearchResults> = .loading
    /// Pages after the first, as « Plus de résultats » brings them, for this search and session only.
    @State private var paging = SearchPaging()
    /// The page being read; cancelled when the search or the reading session changes.
    @State private var pagingTask: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch reading {
            case .loading:
                ProgressView().frame(maxWidth: .infinity).padding(.top, Theme.Space.xl)
            case let .done(.read(page)):
                if page.episodes.isEmpty {
                    ProblemText(text: String(localized: "Nothing found."))
                        .padding(.horizontal, Theme.Space.xs)
                        .padding(.top, Theme.Space.l)
                }
                ForEach(page.episodes + paging.more) { found in
                    SearchResultRow(found: found)
                }
                if page.untranscribed > 0 {
                    ProblemText(text: String(localized: "\(page.untranscribed) conversations are not transcribed yet: the search cannot see them."))
                        .padding(.horizontal, Theme.Space.xs)
                        .padding(.top, Theme.Space.m)
                }
                if paging.nextOffset != nil {
                    Button(paging.pending == nil ? String(localized: "More results") : String(localized: "Loading…")) {
                        loadMore()
                    }
                    .buttonStyle(SecondaryButtonStyle())
                    .disabled(paging.pending != nil)
                    .padding(.top, Theme.Space.l)
                }
            case let .done(read):
                ProblemText(text: MemoryWords.problem(read, search: true) ?? "")
                    .padding(.horizontal, Theme.Space.xs)
                    .padding(.top, Theme.Space.l)
            }
        }
        .animation(Theme.Motion.small, value: reading)
        .reads($reading, key: query) { model in
            await model.readMemory("search") { await $0.search(query) }
        }
        // A new first page, another search, the app leaving the front or coming back: what came after goes.
        .onChange(of: reading, initial: true) { _, reading in
            if case let .done(.read(page)) = reading { restart(first: page) } else { restart(first: nil) }
        }
        .onChange(of: query) { restart(first: nil) }
        .onChange(of: model.memorySession) { restart(first: nil) }
        .onDisappear { pagingTask?.cancel() }
    }

    private func restart(first: MemorySearchResults?) {
        pagingTask?.cancel()
        pagingTask = nil
        paging.start(query: query, session: model.memorySession, first: first)
    }

    private func loadMore() {
        guard let request = paging.next() else { return }
        pagingTask = Task {
            let read = await model.readMemory("search") { await $0.search(request.query, offset: request.offset) }
            // An answer for another search or session is dropped by `receive` too.
            guard !Task.isCancelled else { return }
            paging.receive(read, for: request)
        }
    }
}

/// A conversation found: its row, then the sentences that match, each opening there.
private struct SearchResultRow: View {
    let found: PhoneSearchEpisode

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeading(verbatim: MemoryWords.when(found.episode.startedAtMs).capitalizedFirst)
                .padding(.horizontal, Theme.Space.xs)
                .padding(.top, Theme.Space.l)
                .padding(.bottom, Theme.Space.xxs)
            NavigationLink(value: target(nil)) {
                ThreadRow(
                    time: Notices.clock(found.episode.startedAtMs), title: MemoryWords.title(found.episode),
                    detail: found.hits.isEmpty && found.notes.isEmpty ? found.episode.firstWords : nil
                ) {
                    KindTile(symbol: MemoryWords.symbol(found.episode))
                } trailing: {
                    EmptyView()
                }
            }
            .buttonStyle(RowButtonStyle())
            ForEach(found.hits) { hit in
                NavigationLink(value: target(hit.sentenceId)) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(MemoryWords.highlighted(hit.text, hit.highlights))
                            .font(Theme.Text.m)
                            .foregroundStyle(Theme.text)
                            .multilineTextAlignment(.leading)
                        Text("\(VoiceWords.speaker(hit.speaker)) · \(Notices.clock(hit.startMs))")
                            .font(Theme.Text.xs.monospacedDigit())
                            .foregroundStyle(Theme.muted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 44 + Theme.Space.s + 32 + Theme.Space.s)
                    .padding(.vertical, Theme.Space.xs)
                    .padding(.horizontal, Theme.Space.xs)
                }
                .buttonStyle(RowButtonStyle())
                .accessibilityIdentifier("search-hit")
            }
            ForEach(Array(found.notes.enumerated()), id: \.offset) { _, note in
                NavigationLink(value: target(nil)) {
                    Label {
                        Text(MemoryWords.highlighted(note.text, note.highlights)).font(Theme.Text.s)
                    } icon: {
                        Image(systemName: "note.text")
                    }
                    .foregroundStyle(Theme.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 44 + Theme.Space.s + 32 + Theme.Space.s)
                    .padding(.vertical, Theme.Space.xs)
                    .padding(.horizontal, Theme.Space.xs)
                }
                .buttonStyle(RowButtonStyle())
            }
            if found.hitCount > found.hits.count {
                Text("\(found.hitCount) sentences match")
                    .font(Theme.Text.xs)
                    .foregroundStyle(Theme.muted)
                    .padding(.leading, 44 + Theme.Space.s + 32 + Theme.Space.s + Theme.Space.xs)
            }
        }
    }

    private func target(_ sentenceId: Int?) -> MemoryTarget {
        MemoryTarget(
            episodeId: found.episode.episodeId, sentenceId: sentenceId, recordingId: found.episode.phone?.recordingId)
    }
}

// Aujourd'hui (§7)

/// A day of the Mac's memory, as its Today: the conversations with their
/// journal lines, then the commitments (today: every open one, late first).
/// The arrows and a swipe change the day. Read only.
struct TodayView: View {
    @Environment(AppModel.self) private var model
    @State private var day = Calendar.current.startOfDay(for: .now)
    @State private var journal: Reading<MemoryJournal> = .loading
    /// The open commitments, on today only (nil on another day, which shows its own).
    @State private var open: Reading<MemoryCommitments?> = .loading
    @State private var overview: Reading<MemoryDay> = .loading
    /// Which way the last change of day went, for the content to slide that way.
    @State private var forward = true

    private var isToday: Bool { Calendar.current.isDateInToday(day) }
    private var key: String { memoryDay(day) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                switch journal {
                case .loading:
                    ProgressView().frame(maxWidth: .infinity).padding(.top, Theme.Space.xl)
                case let .done(.read(written)):
                    conversations(written)
                    commitments(written)
                case let .done(read):
                    ProblemText(text: MemoryWords.problem(read) ?? "")
                        .padding(.horizontal, Theme.Space.xs)
                        .padding(.top, Theme.Space.s)
                }
            }
            .id(key)
            .transition(.asymmetric(
                insertion: .offset(x: forward ? 40 : -40).combined(with: .opacity),
                removal: .opacity))
            .padding(.horizontal, Theme.Space.s)
            .padding(.bottom, Theme.Space.xl)
        }
        .background(Theme.canvas)
        .animation(Theme.Motion.large, value: key)
        .navigationTitle(DayWords.heading(day).capitalizedFirst)
        .navigationBarTitleDisplayMode(.large)
        .gesture(
            DragGesture(minimumDistance: 24)
                .onEnded { drag in
                    // A clearly sideways swipe changes the day; a scroll never does.
                    guard abs(drag.translation.width) > abs(drag.translation.height) * 2.5,
                          abs(drag.translation.width) > 60 else { return }
                    move(by: drag.translation.width < 0 ? 1 : -1)
                })
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    move(by: -1)
                } label: {
                    Image(systemName: "chevron.left")
                }
                .accessibilityLabel(Text("Previous day"))
                Button {
                    move(by: 1)
                } label: {
                    Image(systemName: "chevron.right")
                }
                .accessibilityLabel(Text("Next day"))
                .disabled(isToday)
            }
        }
        .sensoryFeedback(.selection, trigger: key)
        .reads($journal, key: key) { [key] model in await model.readMemory("journal") { await $0.journal(key) } }
        .reads($overview, key: key) { [key] model in await model.readMemory("day") { await $0.day(key) } }
        .reads($open, key: isToday ? "today" : "other") { [isToday] model in
            guard isToday else { return .read(nil) }
            return await model.readMemory("commitments") { await $0.commitments() }.map { $0 }
        }
    }

    private func move(by days: Int) {
        guard let next = Calendar.current.date(byAdding: .day, value: days, to: day) else { return }
        let target = min(next, Calendar.current.startOfDay(for: .now))
        guard target != day else { return }
        forward = days > 0
        day = target
    }

    /// The day's conversations, newest first, each with its journal lines;
    /// lines whose conversation is not listed come first.
    @ViewBuilder
    private func conversations(_ written: MemoryJournal) -> some View {
        let episodes: [PhoneEpisode] = if case let .done(.read(overview)) = overview {
            overview.conversations.sorted { $0.startedAtMs > $1.startedAtMs }
        } else { [] }
        let listed = Set(episodes.map(\.episodeId))
        let loose = written.lines.filter { !listed.contains($0.episodeId) }
        if episodes.isEmpty && written.lines.isEmpty {
            ProblemText(text: written.pending > 0
                ? String(localized: "The journal of this day is not written yet.")
                : String(localized: "Nothing in the journal this day."))
                .padding(.horizontal, Theme.Space.xs)
                .padding(.top, Theme.Space.s)
        }
        ForEach(Array(loose.enumerated()), id: \.offset) { _, line in
            NavigationLink(value: MemoryTarget(episodeId: line.episodeId, sentenceId: line.line.sentenceIds.first)) {
                JournalLine(text: VoiceWords.text(line.line), meta: Notices.clock(line.line.startMs))
                    .padding(Theme.Space.xs)
            }
            .buttonStyle(RowButtonStyle())
            .accessibilityIdentifier("memory-line")
        }
        if !episodes.isEmpty {
            SectionHeading("Conversations")
                .padding(.horizontal, Theme.Space.xs)
                .padding(.top, Theme.Space.s)
                .padding(.bottom, Theme.Space.xxs)
        }
        ForEach(episodes) { episode in
            let lines = written.lines.filter { $0.episodeId == episode.episodeId }
            NavigationLink(
                value: MemoryTarget(episodeId: episode.episodeId, sentenceId: nil, recordingId: episode.phone?.recordingId)
            ) {
                ThreadRow(
                    time: Notices.clock(episode.startedAtMs), title: MemoryWords.title(episode),
                    detail: lines.isEmpty ? episode.firstWords : lines.map { VoiceWords.text($0.line) }.joined(separator: " ")
                ) {
                    KindTile(symbol: MemoryWords.symbol(episode))
                } trailing: {
                    EmptyView()
                }
            }
            .buttonStyle(RowButtonStyle())
            .accessibilityIdentifier("memory-line")
        }
        if written.pending > 0 && !(episodes.isEmpty && written.lines.isEmpty) {
            ProblemText(text: String(localized: "\(written.pending) conversations are still to be written on the Mac."))
                .padding(.horizontal, Theme.Space.xs)
                .padding(.top, Theme.Space.xs)
        }
    }

    @ViewBuilder
    private func commitments(_ written: MemoryJournal) -> some View {
        let shown: [(line: PhoneMemoryLine, late: Bool)]? = if isToday {
            if case let .done(.read(open?)) = open {
                open.commitments.filter(open.isLate).map { ($0, true) }
                    + open.commitments.filter { !open.isLate($0) }.map { ($0, false) }
            } else { nil }
        } else {
            written.commitments.map { ($0, false) }
        }
        if let shown, !shown.isEmpty {
            SectionHeading(isToday ? "Open commitments" : "Commitments")
                .padding(.horizontal, Theme.Space.xs)
                .padding(.top, Theme.Space.l)
                .padding(.bottom, Theme.Space.xxs)
            ForEach(Array(shown.enumerated()), id: \.offset) { _, item in
                NavigationLink(value: MemoryTarget(episodeId: item.line.episodeId, sentenceId: item.line.line.sentenceIds.first)) {
                    CommitmentLine(
                        text: VoiceWords.text(item.line.line), done: item.line.line.done, late: item.late,
                        meta: CommitmentWords.meta(item.line.line, late: item.late))
                    .padding(.vertical, Theme.Space.xs)
                    .padding(.horizontal, Theme.Space.xs)
                }
                .buttonStyle(RowButtonStyle())
                .accessibilityIdentifier("memory-line")
            }
        } else if isToday, case let .done(read) = open, MemoryWords.problem(read) != nil {
            ProblemText(text: MemoryWords.problem(read) ?? "")
                .padding(.horizontal, Theme.Space.xs)
                .padding(.top, Theme.Space.l)
        }
    }
}

/// When a commitment was said and when it is due.
enum CommitmentWords {
    static func meta(_ line: PhoneJournalLine, late: Bool) -> String {
        let said = MemoryWords.when(line.startMs)
        guard let due = line.due.flatMap(MemoryWords.day) else { return said }
        let date = due.formatted(.dateTime.day().month(.abbreviated))
        return late ? String(localized: "Late · due \(date)") : String(localized: "\(said) · due \(date)")
    }
}

// A conversation's text, read only

struct ConversationView: View {
    let target: MemoryTarget
    @State private var reading: Reading<MemoryConversation> = .loading

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    switch reading {
                    case .loading:
                        ProgressView().frame(maxWidth: .infinity).padding(.top, Theme.Space.xl)
                    case let .done(.read(conversation)):
                        ConversationHeader(episode: conversation.episode)
                        if !conversation.notes.isEmpty {
                            SectionHeading("Notes")
                                .padding(.horizontal, Theme.Space.xs)
                                .padding(.top, Theme.Space.l)
                            ForEach(conversation.notes) { note in
                                Text(note.text)
                                    .font(Theme.Text.m)
                                    .padding(.horizontal, Theme.Space.xs)
                                    .padding(.vertical, Theme.Space.xxs)
                            }
                        }
                        SectionHeading("Transcript")
                            .padding(.horizontal, Theme.Space.xs)
                            .padding(.top, Theme.Space.l)
                            .padding(.bottom, Theme.Space.xxs)
                        if conversation.sentences.isEmpty {
                            ProblemText(text: String(localized: "No transcript yet."))
                                .padding(.horizontal, Theme.Space.xs)
                        }
                        ForEach(conversation.sentences) { sentence in
                            SentenceView(
                                speaker: VoiceWords.speaker(sentence.speaker.flatMap { ordinal in conversation.speakers.first { $0.ordinal == ordinal } }),
                                startMs: sentence.startMs, text: sentence.text, marked: sentence.id == target.sentenceId)
                            .id(sentence.id)
                        }
                        if conversation.truncated {
                            ProblemText(text: String(localized: "The rest of this conversation is too long for the iPhone: read it on the Mac."))
                                .padding(.horizontal, Theme.Space.xs)
                                .padding(.top, Theme.Space.s)
                        }
                    case let .done(read):
                        ProblemText(text: MemoryWords.problem(read) ?? "")
                            .padding(.horizontal, Theme.Space.xs)
                            .padding(.top, Theme.Space.s)
                    }
                }
                .padding(.horizontal, Theme.Space.s)
                .padding(.bottom, Theme.Space.xl)
            }
            .background(Theme.canvas)
            .onChange(of: reading) { _, reading in
                guard case .done(.read) = reading, let sentenceId = target.sentenceId else { return }
                withAnimation(Theme.Motion.large) { proxy.scrollTo(sentenceId, anchor: .center) }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .reads($reading, key: "\(target.episodeId)") { [target] model in
            await model.readMemory("conversation") { await $0.conversation(target.episodeId) }
        }
    }
}

/// A conversation's title, then when and what kind, in one line.
private struct ConversationHeader: View {
    let episode: PhoneEpisode

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xs) {
            HStack(spacing: Theme.Space.s) {
                KindTile(symbol: MemoryWords.symbol(episode), size: 40)
                Text(MemoryWords.title(episode))
                    .font(Theme.Text.l)
                    .foregroundStyle(Theme.text)
            }
            Text("\(MemoryWords.when(episode.startedAtMs).capitalizedFirst) · \(MemoryWords.kind(episode))")
                .font(Theme.Text.s)
                .foregroundStyle(Theme.muted)
        }
        .padding(.horizontal, Theme.Space.xs)
        .padding(.top, Theme.Space.s)
    }
}
