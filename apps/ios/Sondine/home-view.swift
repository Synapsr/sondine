import SondinePhone
import SwiftUI

/// Accueil (iphone-screens.md §2, U9): the recordings by day, newest first,
/// as rows of the Mac's Today (the hour, a tile, the name or whom it heard,
/// its journal line or where it stands); the day's journal from the Mac on
/// top while paired; « Enregistrer » floating at the bottom, which opens the
/// recording by zooming out of itself. The Mac's mark opens « Mac », the gear
/// « Réglages », the field searches the Mac's memory. In the last 14 days of
/// a build, one line says when it expires.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var showsRecorder = false
    @State private var showsSettings = false
    /// The recording just stopped, to tag in one tap (ADR 039).
    @State private var tagging: UUID?
    /// The search field, and what was searched (results show until the field is cleared).
    @State private var query = ""
    @State private var searched = ""
    @Namespace private var zoom

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if searched.isEmpty {
                        content
                    } else {
                        SearchResults(query: searched)
                    }
                }
                .padding(.horizontal, Theme.Space.s)
                .padding(.bottom, 120)
            }
            .background(Theme.canvas)
            .navigationTitle("Sondine")
            .searchable(text: $query, prompt: Text("Search the Mac"))
            .onSubmit(of: .search) {
                searched = query.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            .onChange(of: query) { _, text in
                if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { searched = "" }
            }
            .navigationDestination(for: UUID.self) { id in
                RecordingDetailView(id: id)
            }
            .navigationDestination(for: HomeRoute.self) { _ in
                TodayView()
            }
            .navigationDestination(for: MemoryTarget.self) { target in
                if let id = target.recordingId, model.recordings.contains(where: { $0.id == id }) {
                    RecordingDetailView(id: id)
                } else {
                    ConversationView(target: target)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    NavigationLink {
                        MacView()
                    } label: {
                        MacMark()
                    }
                    .accessibilityIdentifier("mac")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showsSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel(Text("Settings"))
                }
            }
            .safeAreaInset(edge: .bottom) {
                if searched.isEmpty { recordBar }
            }
            .sheet(isPresented: $showsSettings) { SettingsView() }
            .onChange(of: showsRecorder) { _, shows in
                if !shows, model.isPaired, let newest = model.recordings.first {
                    withAnimation(Theme.Motion.large) { tagging = newest.id }
                }
            }
            .onDisappear { tagging = nil }
            .fullScreenCover(isPresented: $showsRecorder) {
                RecordingInProgressView()
                    .navigationTransition(.zoom(sourceID: "record", in: zoom))
            }
            .onChange(of: model.snapshot.phase) { _, phase in
                // A session under way (or interrupted) shows its screen, also after a relaunch from a notification.
                if phase != .idle { showsRecorder = true }
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let days = expiryDaysLeft {
            Label {
                Text("This version expires in \(days) days")
            } icon: {
                Image(systemName: "clock.badge.exclamationmark")
            }
            .font(Theme.Text.s)
            .foregroundStyle(Theme.danger)
            .padding(.horizontal, Theme.Space.xs)
            .padding(.top, Theme.Space.s)
        }
        ForEach(model.killed) { recording in
            KilledNotice(recording: recording)
        }
        if model.isPaired {
            TodayEntry()
        }
        if model.recordings.isEmpty {
            EmptyHome()
        }
        ForEach(days, id: \.day) { group in
            DayHeading(day: group.day)
                .padding(.horizontal, Theme.Space.xs)
            ForEach(group.recordings) { recording in
                NavigationLink(value: recording.id) {
                    RecordingRow(recording: recording)
                }
                .buttonStyle(RowButtonStyle())
                if tagging == recording.id {
                    QuickTags(recording: recording)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
    }

    /// « Enregistrer », and why it did nothing, over the list's end.
    private var recordBar: some View {
        VStack(spacing: Theme.Space.xs) {
            if let refusal = model.refusal {
                BarNotice(text: RefusalWords.text(refusal))
            } else if let stop = model.snapshot.lastStop {
                BarNotice(text: StopWords.text(stop.end, atMs: stop.atMs))
            }
            Button {
                Task {
                    await model.record()
                    if model.refusal == nil { showsRecorder = true }
                }
            } label: {
                HStack(spacing: Theme.Space.xs) {
                    Circle().fill(Theme.danger).frame(width: 10, height: 10)
                    Text("Record")
                }
            }
            .buttonStyle(RecordButtonStyle())
            .matchedTransitionSource(id: "record", in: zoom)
            .accessibilityIdentifier("record")
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.top, Theme.Space.xl)
        .padding(.bottom, Theme.Space.xs)
        .frame(maxWidth: .infinity)
        // The list fades under the button instead of being cut by it.
        .background(
            LinearGradient(colors: [Theme.canvas.opacity(0), Theme.canvas], startPoint: .top, endPoint: .center)
                .allowsHitTesting(false))
        .animation(Theme.Motion.large, value: model.refusal)
    }

    private var expiryDaysLeft: Int? {
        let left = model.build.daysLeft()
        return left <= BuildInfo.warningDays ? max(left, 0) : nil
    }

    private var days: [(day: Date, recordings: [StoredRecording])] {
        let calendar = Calendar.current
        let grouped = Dictionary(grouping: model.recordings) {
            calendar.startOfDay(for: Date(milliseconds: $0.startedAtMs))
        }
        return grouped.keys.sorted(by: >).map { ($0, grouped[$0] ?? []) }
    }
}

/// The floating « Enregistrer »: ink, a pill, a shadow that lifts it off the list.
private struct RecordButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.Text.title)
            .foregroundStyle(Theme.onInk)
            .padding(.horizontal, Theme.Space.xl)
            .padding(.vertical, Theme.Space.m)
            .background(Theme.ink, in: .capsule)
            .shadow(color: .black.opacity(0.18), radius: 16, y: 6)
            .scaleEffect(configuration.isPressed ? 0.95 : 1)
            .animation(Theme.Motion.small, value: configuration.isPressed)
    }
}

/// Why « Enregistrer » did nothing, or why the last recording stopped, on glass over the list.
private struct BarNotice: View {
    let text: String

    var body: some View {
        Text(text)
            .font(Theme.Text.s)
            .foregroundStyle(Theme.danger)
            .multilineTextAlignment(.center)
            .padding(.horizontal, Theme.Space.m)
            .padding(.vertical, Theme.Space.s)
            .glassEffect(.regular, in: .rect(cornerRadius: Theme.Radius.m))
            .transition(.blurReplace)
            .accessibilityIdentifier("state-line")
    }
}

/// No recording yet: what to do, in one sentence.
private struct EmptyHome: View {
    var body: some View {
        VStack(spacing: Theme.Space.s) {
            KindTile(symbol: "waveform", size: 56)
            Text("No recording yet").font(Theme.Text.title).foregroundStyle(Theme.text)
            Text("Tap Record, then lock the iPhone: it goes on for hours.")
                .font(Theme.Text.s)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, Theme.Space.xxl * 2)
        .padding(.horizontal, Theme.Space.xl)
    }
}

/// The day's journal from the Mac, on top while paired: its first line, or
/// how many conversations it has; opens « Aujourd'hui ».
private struct TodayEntry: View {
    @Environment(AppModel.self) private var model
    @State private var journal: Reading<MemoryJournal> = .loading

    var body: some View {
        NavigationLink(value: HomeRoute.today) {
            HStack(alignment: .top, spacing: Theme.Space.s) {
                KindTile(symbol: "text.book.closed")
                VStack(alignment: .leading, spacing: 2) {
                    Text("Today's journal").font(Theme.Text.title).foregroundStyle(Theme.text)
                    Text(detail)
                        .font(Theme.Text.s)
                        .foregroundStyle(Theme.muted)
                        .lineLimit(2)
                        .contentTransition(.opacity)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.faint)
                    .padding(.top, 9)
            }
            .padding(Theme.Space.s)
            .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.m))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.m).strokeBorder(Theme.line, lineWidth: 1))
        }
        .buttonStyle(RowButtonStyle())
        .padding(.top, Theme.Space.s)
        .accessibilityIdentifier("today")
        .reads($journal, key: memoryDay(.now)) { model in
            await model.readMemory("journal") { await $0.journal(memoryDay(.now)) }
        }
        .animation(Theme.Motion.small, value: journal)
    }

    private var detail: String {
        switch journal {
        case .loading: String(localized: "On the Mac")
        case let .done(.read(written)):
            if let first = written.lines.first { VoiceWords.text(first.line) } else {
                String(localized: "Nothing in the journal yet today.")
            }
        case let .done(read): MemoryWords.problem(read) ?? ""
        }
    }
}

struct RecordingRow: View {
    @Environment(AppModel.self) private var model
    let recording: StoredRecording

    var body: some View {
        let glance = model.glances[recording.id]
        let state = RecordingWords.state(recording, sync: model.syncStatus)
        let transcribed = glance != nil && recording.sync.mac == .ready
        ThreadRow(
            time: Notices.clock(recording.startedAtMs),
            title: recording.name ?? glance?.voices ?? String(localized: "Recording"),
            detail: transcribed ? (glance?.summary ?? state) : state,
            detailIsProblem: recording.sync.conflict || recording.sync.refused != nil
        ) {
            KindTile(symbol: "waveform")
                .symbolEffect(.variableColor.iterative, isActive: busy)
                .overlay { UploadRing(share: uploadShare) }
        } trailing: {
            Text(RecordingWords.shortLength(recording))
                .font(Theme.Text.s.monospacedDigit())
                .foregroundStyle(Theme.muted)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("recording-row")
    }

    /// Being sent or transcribed: the tile's waveform moves.
    private var busy: Bool {
        model.syncStatus.uploads[recording.id] != nil || recording.sync.mac == .transcribing
            || recording.sync.mac == .receiving || recording.sync.mac == .waiting
    }

    private var uploadShare: Double? {
        guard let held = model.syncStatus.uploads[recording.id], recording.bytes > 0 else { return nil }
        return Double(held) / Double(recording.bytes)
    }
}

/// How much of a file the Mac holds, as a ring around the tile.
private struct UploadRing: View {
    let share: Double?

    var body: some View {
        if let share {
            ZStack {
                Circle().stroke(Theme.line, lineWidth: 2.5)
                Circle()
                    .trim(from: 0, to: share)
                    .stroke(Theme.ink, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(Theme.Motion.large, value: share)
            }
            .frame(width: 18, height: 18)
            .padding(3)
            .background(Theme.canvas, in: .circle)
            .offset(x: 12, y: 12)
        }
    }
}

/// « L'enregistrement de 14:32 s'est arrêté brusquement », once, at the next launch.
private struct KilledNotice: View {
    @Environment(AppModel.self) private var model
    let recording: StoredRecording

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.s) {
            Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.danger)
            Text("The recording of \(Notices.clock(recording.startedAtMs)) stopped abruptly: the app was closed, or the battery ran out. It is kept up to its last seconds.")
                .font(Theme.Text.s)
                .foregroundStyle(Theme.text)
            Spacer(minLength: 0)
            Button {
                withAnimation(Theme.Motion.small) { model.noticeSeen(recording) }
            } label: {
                Image(systemName: "xmark").foregroundStyle(Theme.muted)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(Text("Dismiss"))
        }
        .padding(Theme.Space.s)
        .background(Theme.surface, in: .rect(cornerRadius: Theme.Radius.m))
        .padding(.top, Theme.Space.s)
    }
}

extension StoredRecording {
    /// The user's name, else its hour.
    var title: String {
        name ?? Date(milliseconds: startedAtMs).formatted(date: .omitted, time: .shortened)
    }
}

/// The words for a recording's state and length.
enum RecordingWords {
    /// Where it stands: on the phone, on its way to the Mac, on the Mac.
    static func state(_ recording: StoredRecording, sync: PhoneSyncClient.Status) -> String {
        guard recording.end != nil else { return String(localized: "Recording…") }
        if let held = sync.uploads[recording.id], recording.bytes > 0 {
            let done = (Double(held) / Double(recording.bytes)).formatted(.percent.precision(.fractionLength(0)))
            return String(localized: "Sending… \(done)")
        }
        if recording.sync.conflict { return String(localized: "Conflict") }
        if recording.sync.refused != nil { return String(localized: "Refused by the Mac") }
        if recording.sync.stored || !recording.hasAudio {
            switch recording.sync.mac {
            case .transcribing: return String(localized: "Transcribing…")
            case .ready: return String(localized: "Transcribed")
            default: return String(localized: "On the Mac")
            }
        }
        if sync.mac != nil { return String(localized: "Waiting for the Mac") }
        return phoneState(recording)
    }

    /// Before pairing: how its recording ended.
    static func phoneState(_ recording: StoredRecording) -> String {
        switch recording.end {
        case nil: String(localized: "Recording…")
        case .interruption, .route: String(localized: "Interrupted")
        case .killed: String(localized: "Stopped abruptly")
        case .lowSpace, .writeFailed: String(localized: "Stopped: iPhone full")
        case .stopped, .rotation: String(localized: "On the phone")
        }
    }

    static func length(_ recording: StoredRecording) -> String {
        guard let ms = recording.durationMs else { return "—" }
        return Duration.milliseconds(ms).formatted(.time(pattern: ms >= 3_600_000 ? .hourMinuteSecond : .minuteSecond))
    }

    /// « 48 min », « 1 h 32 », « 40 s »: a row's length.
    static func shortLength(_ recording: StoredRecording) -> String {
        guard let ms = recording.durationMs else { return "" }
        if ms < 60_000 { return Duration.milliseconds(ms).formatted(.units(allowed: [.seconds], width: .abbreviated)) }
        let minutes = Int(ms / 60_000)
        guard minutes >= 60 else { return String(localized: "\(minutes) min") }
        return String(localized: "\(minutes / 60) h \(String(format: "%02d", minutes % 60))")
    }
}

enum StopWords {
    static func text(_ end: RecordingEnd, atMs: Int64) -> String {
        let time = Notices.clock(atMs)
        return end == .lowSpace
            ? String(localized: "Recording stopped at \(time): the iPhone is almost full.")
            : String(localized: "Recording stopped at \(time): the file could not be written.")
    }
}

enum RefusalWords {
    static func text(_ refusal: PhoneRecorder.StartRefusal) -> String {
        switch refusal {
        case .busy: String(localized: "A recording is already under way.")
        case .noPermission: String(localized: "The microphone is off for Sondine. Turn it on in Settings.")
        case .locked: String(localized: "Unlock the iPhone once since it restarted, then record.")
        case .noLiveActivity: String(localized: "Live Activities are off for Sondine: without one, iOS does not let it record from the Lock Screen. Turn them on in Settings, or open Sondine to record.")
        case let .lowSpace(available):
            String(localized: "Only \(available.formatted(.byteCount(style: .file))) free: Sondine needs 1 GB to start.")
        case .session: String(localized: "iOS did not let Sondine use the microphone now. Try again.")
        case .files: String(localized: "The recording could not be created. Try again.")
        }
    }

    /// From the control or the Live Activity, where « try again » does not help
    /// when iOS refused the microphone outside the app.
    static func gesture(_ refusal: PhoneRecorder.StartRefusal) -> String {
        switch refusal {
        case .session: String(localized: "iOS did not let Sondine start the microphone outside the app. Open Sondine to record.")
        default: text(refusal)
        }
    }
}
