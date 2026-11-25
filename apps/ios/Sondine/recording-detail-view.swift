@preconcurrency import AVFoundation
import SondinePhone
import SwiftUI

/// Un enregistrement (iphone-screens.md §4, U9): its name as the page's
/// title, then when, how long and where it stands in one line; the player;
/// once the Mac transcribed it, its journal lines and commitments (each
/// opening its sentence), its notes and the transcript, a sentence playing
/// from there. « Partager… », « Ajouter une note » and « Supprimer… » wait
/// in « ··· ». Playback reads the phone's own file while it has it, then
/// streams the Mac's, or says the Mac cannot be reached.
struct RecordingDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let id: UUID
    @State private var name = ""
    @State private var confirmsDelete = false
    @State private var shared: URL?
    @State private var player = FilePlayer()
    @State private var macPlayer = MacPlayer()
    @State private var result: StoredResult?
    @State private var writesNote = false
    @FocusState private var naming: Bool

    private var recording: StoredRecording? { model.recordings.first { $0.id == id } }

    var body: some View {
        if let recording {
            ScrollViewReader { proxy in
                page(recording, proxy: proxy)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { actions(recording) } }
            .onAppear {
                name = recording.name ?? ""
                shared = recording.hasAudio ? ShareFile.link(recording) : nil
            }
            .task(id: recording.resultRevision) {
                result = recording.resultRevision == nil ? nil : model.result(recording)
            }
            .onDisappear {
                player.stop()
                macPlayer.stop()
                if name != (recording.name ?? "") { model.rename(recording, to: name) }
            }
            .sheet(isPresented: $writesNote) {
                NoteSheet { text in
                    Task { await model.addNote(recording, text: text) }
                }
            }
            .confirmationDialog("Delete this recording?", isPresented: $confirmsDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    player.stop()
                    macPlayer.stop()
                    model.delete(recording)
                    dismiss()
                }
            } message: {
                if model.isPaired {
                    Text("Deleted from the phone now, and from the Mac at the next sync.")
                } else {
                    Text("Deleted from this iPhone. If you already sent it to the Mac, delete it there too.")
                }
            }
        } else {
            Text("This recording is no longer on the iPhone.").foregroundStyle(Theme.muted)
        }
    }

    /// « ··· »: share, add a note, delete.
    private func actions(_ recording: StoredRecording) -> some View {
        Menu {
            if let shared {
                ShareLink(item: shared) {
                    Label("Share…", systemImage: "square.and.arrow.up")
                }
            }
            if model.isPaired {
                Button {
                    writesNote = true
                } label: {
                    Label("Add a note…", systemImage: "square.and.pencil")
                }
                .accessibilityIdentifier("add-note")
            }
            Button {
                naming = true
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            Divider()
            Button(role: .destructive) {
                confirmsDelete = true
            } label: {
                Label("Delete…", systemImage: "trash")
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .accessibilityLabel(Text("More"))
        .accessibilityIdentifier("recording-actions")
    }

    private func page(_ recording: StoredRecording, proxy: ScrollViewProxy) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                TextField(recording.title, text: $name, axis: .vertical)
                    .font(Theme.Text.xl)
                    .tracking(-0.64)
                    .foregroundStyle(Theme.text)
                    .focused($naming)
                    .submitLabel(.done)
                    .onChange(of: name) { _, text in
                        // A return ends the name: it is one line.
                        if text.contains("\n") {
                            name = text.replacingOccurrences(of: "\n", with: "")
                            naming = false
                            model.rename(recording, to: name)
                        }
                    }
                    .accessibilityLabel(Text("Name"))
                Text(meta(recording))
                    .font(Theme.Text.s)
                    .foregroundStyle(Theme.muted)
                    .padding(.top, Theme.Space.xxs)
                // Tags and « C'est moi » go to the Mac: shown once one is paired (ADR 039).
                if model.isPaired {
                    RecordingTags(recording: recording)
                        .padding(.top, Theme.Space.s)
                    if let result {
                        SelfGuess(recording: recording, result: result.result)
                            .padding(.top, Theme.Space.xs)
                    }
                }
                if recording.sync.conflict {
                    warning("The Mac holds another recording under this one's id. This one stays on the iPhone: share it to keep it.")
                } else if recording.sync.refused != nil {
                    warning("The Mac cannot take this recording. It stays on the iPhone: share it to keep it.")
                }
                playback(recording)
                    .padding(.top, Theme.Space.l)
                if let result, !result.result.journal.isEmpty {
                    journal(result.result, proxy: proxy)
                }
                notes(recording)
                if let result, !result.result.sentences.isEmpty {
                    SectionHeading("Transcript")
                        .padding(.top, Theme.Space.xl)
                        .padding(.bottom, Theme.Space.xxs)
                    ForEach(result.result.sentences) { sentence in
                        SentenceView(
                            speaker: VoiceWords.speaker(sentence.speaker.flatMap { ordinal in result.result.speakers.first { $0.ordinal == ordinal } }),
                            startMs: sentence.startMs, text: sentence.text)
                        .padding(.horizontal, -Theme.Space.xs)
                        .id(Self.anchor(sentence.id))
                        .contentShape(.rect)
                        .onTapGesture { play(recording, from: sentence) }
                    }
                }
            }
            .padding(.horizontal, Theme.Space.l)
            .padding(.top, Theme.Space.s)
            .padding(.bottom, Theme.Space.xxl)
        }
        .background(Theme.canvas)
        .scrollDismissesKeyboard(.interactively)
    }

    static func anchor(_ id: Int) -> String { "sentence-\(id)" }

    /// « Lundi 23 novembre · 10:05 · 48 min », then where it stands until the Mac transcribed it.
    private func meta(_ recording: StoredRecording) -> String {
        var parts = [
            DayWords.heading(Calendar.current.startOfDay(for: Date(milliseconds: recording.startedAtMs))).capitalizedFirst,
            Notices.clock(recording.startedAtMs),
        ]
        let length = RecordingWords.shortLength(recording)
        if !length.isEmpty { parts.append(length) }
        if recording.header.part > 1 { parts.append(String(localized: "Part \(recording.header.part)")) }
        if recording.sync.mac != .ready { parts.append(RecordingWords.state(recording, sync: model.syncStatus)) }
        return parts.joined(separator: " · ")
    }

    private func warning(_ text: LocalizedStringKey) -> some View {
        Text(text)
            .font(Theme.Text.s)
            .foregroundStyle(Theme.danger)
            .padding(.top, Theme.Space.s)
    }

    private func journal(_ result: PhoneResult, proxy: ScrollViewProxy) -> some View {
        let lines = result.journal.filter { $0.kind == .line }
        let commitments = result.journal.filter { $0.kind == .commitment }
        return VStack(alignment: .leading, spacing: 0) {
            SectionHeading("Journal")
                .padding(.top, Theme.Space.xl)
                .padding(.bottom, Theme.Space.xs)
            VStack(alignment: .leading, spacing: Theme.Space.s) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    Button {
                        reveal(line, proxy: proxy)
                    } label: {
                        JournalLine(text: VoiceWords.text(line), meta: Notices.clock(line.startMs))
                    }
                    .buttonStyle(.plain)
                }
            }
            if !commitments.isEmpty {
                SectionHeading("Commitments")
                    .padding(.top, Theme.Space.l)
                    .padding(.bottom, Theme.Space.xxs)
                ForEach(Array(commitments.enumerated()), id: \.offset) { _, line in
                    Button {
                        reveal(line, proxy: proxy)
                    } label: {
                        CommitmentLine(
                            text: VoiceWords.text(line), done: line.done,
                            meta: CommitmentWords.meta(line, late: false))
                        .padding(.vertical, Theme.Space.xs)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func reveal(_ line: PhoneJournalLine, proxy: ScrollViewProxy) {
        guard let first = line.sentenceIds.first else { return }
        withAnimation(Theme.Motion.large) { proxy.scrollTo(Self.anchor(first), anchor: .top) }
    }

    /// The phone's own file while it has it; then the Mac's audio, streamed.
    @ViewBuilder
    private func playback(_ recording: StoredRecording) -> some View {
        if recording.hasAudio {
            PlayerBar(
                playing: player.playing, disabled: recording.end == nil,
                durationMs: recording.durationMs ?? 0, position: { player.position }
            ) {
                player.toggle(recording.folder.audio)
            }
        } else if let audio = result?.result.audio, model.isPaired {
            if !model.syncStatus.reachable && !macPlayer.isPlaying {
                ProblemText(text: String(localized: "The Mac cannot be reached."))
            } else {
                PlayerBar(
                    playing: macPlayer.isPlaying, disabled: false, durationMs: audio.durationMs,
                    position: { macPlayer.position }
                ) {
                    if macPlayer.isPlaying { macPlayer.pause() } else { play(recording, from: nil) }
                }
                .accessibilityIdentifier("mac-play")
            }
            switch macPlayer.state {
            case .gone:
                ProblemText(text: String(localized: "The Mac no longer has this audio.")).padding(.top, Theme.Space.xs)
            case .stale:
                ProblemText(text: String(localized: "The audio changed on the Mac. Try again in a moment.")).padding(.top, Theme.Space.xs)
            case .failed:
                ProblemText(text: String(localized: "Playback stopped: the Mac did not answer.")).padding(.top, Theme.Space.xs)
            default:
                EmptyView()
            }
        } else {
            ProblemText(text: String(localized: "The audio is on the Mac."))
        }
    }

    private func play(_ recording: StoredRecording, from sentence: PhoneSentence?) {
        guard !recording.hasAudio, model.isPaired, let audio = result?.result.audio else { return }
        let offset = sentence.map { $0.startMs - audio.startedAtMs }
        let model = model
        macPlayer.play(
            recording.id, audio: audio, fromMs: offset, fetch: model.audioFetch(recording, generation: audio.generation)
        ) { read in
            // A new generation comes with the next result; an unreachable Mac shows as such.
            if case .refused(_, .stale) = read { model.syncNow() }
            if read == .unreachable { model.syncNow() }
        }
    }

    @ViewBuilder
    private func notes(_ recording: StoredRecording) -> some View {
        let pending = model.pendingNotes(recording)
        let notes = result?.result.notes ?? []
        if !notes.isEmpty || !pending.isEmpty {
            SectionHeading("Notes")
                .padding(.top, Theme.Space.l)
                .padding(.bottom, Theme.Space.xxs)
            ForEach(notes) { note in
                Text(note.text).font(Theme.Text.m).foregroundStyle(Theme.text).padding(.vertical, Theme.Space.xxs)
            }
            ForEach(pending) { note in
                VStack(alignment: .leading, spacing: 2) {
                    Text(note.text ?? "").font(Theme.Text.m).foregroundStyle(Theme.text)
                    Text("Waiting for the Mac").font(Theme.Text.xs).foregroundStyle(Theme.muted)
                }
                .padding(.vertical, Theme.Space.xxs)
            }
        }
    }
}

/// Play or pause, round and ink, and how far playback is.
private struct PlayerBar: View {
    let playing: Bool
    let disabled: Bool
    let durationMs: Int64
    let position: () -> Double
    let toggle: () -> Void

    var body: some View {
        HStack(spacing: Theme.Space.s) {
            Button(action: toggle) {
                Image(systemName: playing ? "pause.fill" : "play.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.onInk)
                    .contentTransition(.symbolEffect(.replace))
                    .frame(width: 44, height: 44)
                    .background(Theme.ink, in: .circle)
            }
            .buttonStyle(.plain)
            .disabled(disabled)
            .accessibilityLabel(playing ? Text("Pause") : Text("Play"))
            TimelineView(.animation(minimumInterval: 0.1, paused: !playing)) { _ in
                let seconds = position()
                let total = max(Double(durationMs) / 1000, 1)
                VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                    GeometryReader { geometry in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Theme.surface)
                            Capsule().fill(Theme.ink).frame(width: geometry.size.width * min(1, seconds / total))
                        }
                    }
                    .frame(height: 4)
                    HStack {
                        Text(Duration.seconds(seconds).formatted(.time(pattern: .minuteSecond)))
                        Spacer()
                        Text(Duration.seconds(total).formatted(.time(pattern: total >= 3_600 ? .hourMinuteSecond : .minuteSecond)))
                    }
                    .font(Theme.Text.xs.monospacedDigit())
                    .foregroundStyle(Theme.muted)
                }
            }
        }
        .padding(Theme.Space.s)
        .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.m))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.m).strokeBorder(Theme.line, lineWidth: 1))
    }
}

/// How the transcript and the journal call a voice: the user's name, a guess
/// as a question (it is answered on the Mac), the user, or its number.
enum VoiceWords {
    static func speaker(_ speaker: PhoneSpeaker?) -> String {
        guard let speaker else { return String(localized: "Someone") }
        return words(name: speaker.name, guess: speaker.guess, isSelf: speaker.isSelf, ordinal: speaker.ordinal)
    }

    static func line(_ voice: PhoneLineVoice) -> String {
        words(name: voice.name, guess: voice.guess, isSelf: voice.isSelf, ordinal: voice.ordinal)
    }

    private static func words(name: String?, guess: String?, isSelf: Bool, ordinal: Int?) -> String {
        if isSelf { return String(localized: "Me") }
        if let name { return name }
        if let guess { return String(localized: "\(guess)?") }
        if let ordinal, ordinal > 0 { return String(localized: "Voice \(ordinal)") }
        return String(localized: "Someone")
    }

    /// A journal line's text, its `{P2}` replaced by the voices' words.
    static func text(_ line: PhoneJournalLine) -> String {
        line.voices.reduce(line.text) { text, voice in text.replacingOccurrences(of: "{\(voice.ref)}", with: Self.line(voice)) }
    }
}


/// « Ajouter une note »: a few lines for the conversation, added on the Mac at the next sync.
private struct NoteSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    let add: (String) -> Void

    var body: some View {
        NavigationStack {
            Form {
                TextField("Note", text: $text, axis: .vertical)
                    .lineLimit(4...12)
                    .accessibilityIdentifier("note-text")
                Text("The note goes to the Mac at the next sync, with this conversation.")
                    .font(Theme.Text.s)
                    .foregroundStyle(Theme.muted)
            }
            .navigationTitle("Add a note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        add(text)
                        dismiss()
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// A name the Mac and Files show, as a hard link to the file: no copy of the
/// audio. A link keeps the audio alive, so deleting a recording removes its
/// link, and the app removes every link at launch.
enum ShareFile {
    static let prefix = "share-"

    static func folder(_ id: UUID) -> URL {
        FileManager.default.temporaryDirectory.appending(path: "\(prefix)\(id.uuidString.lowercased())")
    }

    static func remove(_ id: UUID) {
        try? FileManager.default.removeItem(at: folder(id))
    }

    static func removeAll() {
        let tmp = FileManager.default.temporaryDirectory
        for name in (try? FileManager.default.contentsOfDirectory(atPath: tmp.path(percentEncoded: false))) ?? []
        where name.hasPrefix(prefix) {
            try? FileManager.default.removeItem(at: tmp.appending(path: name))
        }
    }

    @MainActor static func link(_ recording: StoredRecording) -> URL? {
        let stamp = Date(milliseconds: recording.startedAtMs)
            .formatted(.verbatim("\(year: .defaultDigits)-\(month: .twoDigits)-\(day: .twoDigits) \(hour: .twoDigits(clock: .twentyFourHour, hourCycle: .zeroBased))-\(minute: .twoDigits)", timeZone: .current, calendar: .current))
        let folder = folder(recording.id)
        let url = folder.appending(path: "Sondine \(stamp).m4a")
        try? FileManager.default.removeItem(at: folder)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileManager.default.linkItem(at: recording.folder.audio, to: url)
            return url
        } catch {
            return recording.folder.audio
        }
    }
}

/// Plays the phone's own file.
@MainActor @Observable
final class FilePlayer: NSObject, AVAudioPlayerDelegate {
    private(set) var playing = false
    private var player: AVAudioPlayer?

    func toggle(_ url: URL) {
        if playing {
            player?.pause()
            playing = false
            return
        }
        if player == nil {
            try? AVAudioSession.sharedInstance().setCategory(.playback)
            player = try? AVAudioPlayer(contentsOf: url)
            player?.delegate = self
        }
        playing = player?.play() ?? false
    }

    /// Where playback is, in seconds: the player's bar.
    var position: Double { player?.currentTime ?? 0 }

    func stop() {
        player?.stop()
        player = nil
        playing = false
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.playing = false }
    }
}
