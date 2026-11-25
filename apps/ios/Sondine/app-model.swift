import Foundation
import Observation
import os
import SondinePhone
import UIKit
import UserNotifications

/// What the screens show and do: the recorder's state, the recordings on the
/// phone, the build's expiry, and the sync with the paired Mac (ADR 008),
/// which runs only while the app is in front and the phone unlocked: the
/// results it fetched (30 days of them), names and notes, playback streamed
/// from the Mac, and the Mac's memory read live (M5.4), held by the screens
/// that show it. From M5.6 also the gestures made outside the app (the
/// control, the Live Activity), and what shows the recording there.
@MainActor @Observable
final class AppModel: RecordingGestureHandling {
    /// One per process: the app's screens, its notifications' actions and the
    /// gestures iOS runs in the background all reach the same recorder.
    static let shared = AppModel()

    /// The UI test runs on a scripted audio session and a tone, in its own folder.
    static let uiTesting = ProcessInfo.processInfo.arguments.contains("-SondineUITest")
    #if DEBUG
    /// The demonstration with invented data (`demo-data.swift`); `-SondineFirstRun` starts it on the first run.
    static let demo = ProcessInfo.processInfo.arguments.contains("-SondineDemo")
    #else
    static let demo = false
    #endif
    /// No real microphone, network, Keychain or Live Activity: the UI test and the demonstration.
    static let scripted = uiTesting || demo

    private(set) var snapshot = PhoneRecorder.Snapshot()
    private(set) var recordings: [StoredRecording] = []
    /// Recordings a kill cut, to say once.
    private(set) var killed: [StoredRecording] = []
    /// What each row shows of the Mac's result, by recording, read again when its revision moves.
    private(set) var glances: [UUID: ResultGlance] = [:]
    /// Why « Enregistrer » did nothing, until the next try.
    private(set) var refusal: PhoneRecorder.StartRefusal?
    var firstRunDone: Bool {
        didSet { UserDefaults.standard.set(firstRunDone, forKey: "firstRunDone") }
    }

    let build = BuildInfo.current
    let store: RecordingStore
    let finder: any MacFinding
    private let recorder: PhoneRecorder
    private let control: RecordingControl
    private let presence: RecordingPresence
    private let session: any AudioSessionControlling
    private let outbox: Outbox
    private let device: DeviceStore
    private let sync: PhoneSyncClient
    private(set) var syncStatus = PhoneSyncClient.Status()
    /// Syncs while the app is in front; nil in the background.
    private var syncLoop: Task<Void, Never>?
    /// Live reads of the Mac's memory: search, a day, its journal, commitments, a conversation.
    let memory: MacMemory
    /// Moves when the app comes to the front or leaves it: memory screens drop what they read, and read again.
    private(set) var memorySession = 0
    /// In front: memory screens may read.
    private(set) var isActive = false
    private static let memoryLog = Logger(subsystem: "app.sondine.ios", category: "memory")

    private init() {
        let support = URL.applicationSupportDirectory.appending(path: "Sondine")
        let root = Self.scripted
            ? FileManager.default.temporaryDirectory.appending(path: Self.demo ? "sondine-demo" : "sondine-ui-test-\(UUID().uuidString)")
            : support
        #if targetEnvironment(simulator)
        let protection: any FileProtecting = NoFileProtection()
        #else
        let protection: any FileProtecting = SystemFileProtection()
        #endif
        // The demonstration starts from its invented recordings each time.
        if Self.demo { try? FileManager.default.removeItem(at: root) }
        // A store that cannot open is a broken install: nothing else can work.
        store = try! RecordingStore(root: root.appending(path: "recordings"), protection: protection)
        outbox = try! Outbox(root: root.appending(path: "outbox"), protection: protection)
        device = DeviceStore(root: root, protection: protection)
        let microphone: any MicrophoneSource
        if Self.scripted {
            session = ScriptedAudioSession()
            microphone = ToneMicrophone()
        } else {
            session = SystemAudioSession()
            microphone = EngineMicrophone()
        }
        // Read at each start: launched by a gesture with the phone locked, the
        // id may only be readable later, and is never made up meanwhile.
        let device = device
        var configuration = PhoneRecorder.Configuration(deviceId: { device.deviceId }, appVersion: build.headerVersion)
        configuration.codec = .alac
        let notifier = LocalNotifier(texts: Notices.words)
        recorder = PhoneRecorder(
            store: store, session: session, microphone: microphone,
            writers: AssetPartWriterFactory(codec: configuration.codec),
            disk: Self.scripted ? ScriptedDiskSpace() : VolumeDiskSpace(url: root),
            notifier: notifier, configuration: configuration)
        presence = RecordingPresence(
            recorder: recorder, activity: Self.scripted ? NoLiveActivity() as any LiveActivityPresenting : ActivityKitPresenter(),
            control: Self.scripted ? NoLiveActivity() as any ControlStatePublishing : SharedControlState(),
            notifier: notifier)
        control = RecordingControl(recorder: recorder, presence: presence, notifier: notifier)
        firstRunDone = Self.uiTesting ? false : Self.demo ? !ProcessInfo.processInfo.arguments.contains("-SondineFirstRun") : UserDefaults.standard.bool(forKey: "firstRunDone")
        // The UI test never touches the network or the Keychain.
        finder = Self.scripted ? KnownMacFinder() : NetworkMacFinder()
        let recorder = recorder
        sync = PhoneSyncClient(
            store: store, outbox: outbox, device: device,
            credentials: Self.scripted ? MemoryCredentials() : KeychainCredentials(),
            transport: URLSessionTransport(), finder: finder,
            configuration: .init(deviceName: UIDevice.current.name),
            openRecordings: { await recorder.openRecordingIds })
        #if DEBUG
        memory = Self.demo ? MacMemory(read: DemoData.read) : MacMemory(client: sync)
        if Self.demo {
            let uploading = DemoData.seed(store)
            let bytes = uploading.flatMap { store.recording($0)?.bytes } ?? 0
            syncStatus = DemoData.status(uploading: uploading, bytes: bytes)
        }
        #else
        memory = MacMemory(client: sync)
        #endif
        // Links made for « Partager… » keep their audio alive: none survives a launch.
        ShareFile.removeAll()
        // A deletion the app was killed in the middle of is finished.
        outbox.finishDeletions(in: store)
        // Results of recordings older than 30 days before the latest time seen go.
        expireResults()
        let sync = sync
        let presence = presence
        // The Live Activity and the control follow the recorder: the latest
        // state only, one refresh at a time.
        let (changes, changed) = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
        Task {
            await presence.clearLeftovers()
            for await _ in changes { await presence.refresh() }
        }
        Task { [weak self] in
            await recorder.listen()
            await recorder.observe { snapshot in
                changed.yield()
                Task { @MainActor in self?.update(snapshot) }
            }
            // The demonstration's Mac is invented: the real client never speaks.
            guard !Self.demo else { return }
            await sync.observe { status in
                Task { @MainActor in self?.syncStatus = status }
            }
        }
        refresh()
        RecordingGestures.handler = self
        // Launched with the phone locked, the pairing could not be read: read it once unlocked.
        NotificationCenter.default.addObserver(
            forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main
        ) { _ in
            Task { await sync.reloadPairing() }
        }
    }

    private var previousPhase: PhoneRecorder.Phase = .idle

    private func update(_ snapshot: PhoneRecorder.Snapshot) {
        let changedKind = !Self.samePhaseKind(previousPhase, snapshot.phase)
        previousPhase = snapshot.phase
        self.snapshot = snapshot
        if changedKind { refresh() }
    }

    private static func samePhaseKind(_ a: PhoneRecorder.Phase, _ b: PhoneRecorder.Phase) -> Bool {
        switch (a, b) {
        case (.idle, .idle), (.interrupted, .interrupted): true
        case let (.recording(x), .recording(y)): x.recordingId == y.recordingId
        default: false
        }
    }

    /// Reads the folders again; at launch and when the app comes back, closes
    /// what a kill left open.
    func refresh() {
        Task {
            await recorder.reconcile()
            recordings = store.list()
            killed = recordings.filter(\.killNoticePending)
            updateGlances()
        }
    }

    private func updateGlances() {
        var next: [UUID: ResultGlance] = [:]
        for recording in recordings {
            guard let revision = recording.resultRevision else { continue }
            if let known = glances[recording.id], known.revision == revision {
                next[recording.id] = known
            } else if let result = result(recording) {
                next[recording.id] = ResultGlance(revision: revision, result: result.result)
            }
        }
        if next != glances { glances = next }
    }

    // Recording

    var isRecording: Bool {
        if case .recording = snapshot.phase { return true }
        return false
    }

    var interrupted: PhoneRecorder.Interrupted? {
        if case let .interrupted(state) = snapshot.phase { return state }
        return nil
    }

    func record() async {
        refusal = nil
        do {
            try await recorder.start()
        } catch {
            refusal = error
        }
    }

    func resume() async {
        refusal = nil
        do {
            try await recorder.resume()
        } catch {
            refusal = error
        }
    }

    func stop() async {
        await recorder.stop()
        refresh()
        syncNow()
    }

    // Outside the app: the control and the Live Activity (M5.6)

    func setRecording(_ on: Bool, context: RecordingControl.Context) async -> RecordingControl.Outcome {
        let outcome = await control.set(recording: on, context: context)
        switch outcome {
        case let .refused(reason) where context == .app:
            refusal = reason
        case .started, .resumed:
            refusal = nil
        case .stopped:
            refresh()
            syncNow()
        default:
            break
        }
        return outcome
    }

    func words(for refusal: PhoneRecorder.StartRefusal) -> String {
        RefusalWords.gesture(refusal)
    }

    // First run

    func allowMicrophone() async -> Bool {
        let allowed = await session.requestPermission()
        if !Self.scripted {
            // « Enregistrement interrompu à 14:32 » needs notifications: asked in the same step.
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
        }
        return allowed
    }

    // A recording

    /// Renames it here, and on the Mac once it holds it.
    func rename(_ recording: StoredRecording, to name: String) {
        guard RecordingStore.cleanName(name) != recording.name else { return }
        let sync = sync
        Task {
            try? await sync.rename(recording.id, to: name)
            refresh()
            syncNow()
        }
    }

    /// « Ajouter une note »: waits in the outbox until the Mac adds it.
    func addNote(_ recording: StoredRecording, text: String) async {
        _ = try? await sync.addNote(recording.id, text: text)
        refresh()
        syncNow()
    }

    /// Notes typed here the Mac has not added yet.
    func pendingNotes(_ recording: StoredRecording) -> [OutboxOperation] {
        outbox.all().filter { $0.kind == .note && $0.recordingId == recording.id }
    }

    // Tags and « C'est moi » (ADR 039)

    /// Bumped when the phone changes a tag or a voice: what reads the outbox shows again.
    private(set) var choices = 0

    /// Its tags: the Mac's, with what still waits in the outbox on top.
    func tags(_ recording: StoredRecording) -> [String] {
        _ = choices
        return TagName.shown(
            mac: result(recording)?.result.tags ?? [], waiting: outbox.all(), recordingId: recording.id)
    }

    /// The tags to offer: those put here lately, then the Mac's.
    func recentTags() -> [String] {
        _ = choices
        #if DEBUG
        if Self.demo { return TagName.recent(waiting: outbox.all(), mac: DemoData.macTags) }
        #endif
        return TagName.recent(waiting: outbox.all(), mac: device.file.macTags ?? [])
    }

    /// The tags to tick for it: those it has, then the recent ones, once each.
    func offeredTags(_ recording: StoredRecording) -> [String] {
        var out: [String] = []
        for tag in tags(recording) + recentTags() where !out.contains(where: { TagName.key($0) == TagName.key(tag) }) {
            out.append(tag)
        }
        return out
    }

    /// Puts a tag on it or takes it off; waits in the outbox until the Mac applies it.
    func setTag(_ recording: StoredRecording, name: String, on: Bool) {
        #if DEBUG
        // The demonstration has no Mac to send to: its choices wait in the outbox.
        if Self.demo {
            try? outbox.add(.tag(recording.id, name: name, on: on, atMs: SystemClock().nowMs()))
            choices += 1
            return
        }
        #endif
        let sync = sync
        Task {
            _ = try? await sync.setTag(recording.id, name: name, on: on)
            choices += 1
            syncNow()
        }
    }

    /// « C'est moi » on a voice Sondine took for the user.
    func confirmSelf(_ recording: StoredRecording, ordinal: Int, sentenceId: Int) {
        #if DEBUG
        if Self.demo {
            try? outbox.add(.voice(recording.id, ordinal: ordinal, sentenceId: sentenceId, atMs: SystemClock().nowMs()))
            choices += 1
            return
        }
        #endif
        let sync = sync
        Task {
            _ = try? await sync.confirmSelf(recording.id, ordinal: ordinal, sentenceId: sentenceId)
            choices += 1
            syncNow()
        }
    }

    /// The voices the user said are theirs that the Mac has not named yet.
    func pendingSelf(_ recording: StoredRecording) -> Set<Int> {
        _ = choices
        return Set(outbox.all().filter { $0.kind == .voice && $0.recordingId == recording.id }.compactMap(\.ordinal))
    }

    /// The Mac's result for it, checked against 30 days before the latest time seen first.
    func result(_ recording: StoredRecording) -> StoredResult? {
        store.result(recording.id, latestSeenMs: device.seen(SystemClock().nowMs()))
    }

    private func expireResults() {
        store.expireResults(latestSeenMs: device.seen(SystemClock().nowMs()))
    }

    /// Reads one range of the Mac's audio of a recording, for the player.
    func audioFetch(_ recording: StoredRecording, generation: Int) -> RemoteAudioReader.Fetch {
        let sync = sync
        let id = recording.id
        return { range in await sync.audio(id, generation: generation, range: range) }
    }

    func delete(_ recording: StoredRecording) {
        ShareFile.remove(recording.id)
        let sync = sync
        Task {
            // Paired, the deletion is written to the outbox before the folder goes.
            try? await sync.delete(recording.id)
            refresh()
            syncNow()
        }
    }

    func noticeSeen(_ recording: StoredRecording) {
        try? store.noticeSeen(recording.id)
        refresh()
    }

    /// Recordings whose audio waits for the Mac: never expired, they are the only copy.
    var waiting: [StoredRecording] { recordings.filter { $0.hasAudio && !$0.sync.stored } }
    var waitingBytes: Int64 { waiting.reduce(0) { $0 + $1.bytes } }

    // The Mac

    var isPaired: Bool { syncStatus.mac != nil }

    /// The app came to the front: sync now, then every 30 s while it stays there.
    func becameActive() {
        isActive = true
        memorySession += 1
        if UIApplication.shared.isProtectedDataAvailable { expireResults() }
        refresh()
        syncLoop?.cancel()
        guard !Self.scripted else { return }
        syncLoop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.syncOnce()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    /// The app left the front: no transfer in the background (ADR 008).
    func wentToBackground() {
        syncLoop?.cancel()
        syncLoop = nil
        // What was read of the Mac's memory goes with the app leaving the screen.
        isActive = false
        memorySession += 1
    }

    /// A read of the Mac's memory, its time in the system log: the route and the milliseconds, never the words.
    func readMemory<Value>(
        _ route: String, _ read: (MacMemory) async -> MemoryRead<Value>
    ) async -> MemoryRead<Value> {
        let started = ContinuousClock.now
        let answer = await read(memory)
        let elapsed = started.duration(to: .now)
        let ms = Int(elapsed.components.seconds * 1000 + elapsed.components.attoseconds / 1_000_000_000_000_000)
        Self.memoryLog.info("read \(route, privacy: .public) \(ms, privacy: .public) ms")
        return answer
    }

    /// « Synchroniser maintenant », and after a recording or a deletion.
    func syncNow() {
        guard syncLoop != nil else { return }
        Task { await syncOnce() }
    }

    private func syncOnce() async {
        // Locked, the phone's files cannot be read: nothing is sent.
        guard UIApplication.shared.isProtectedDataAvailable else { return }
        let outcome = await sync.sync()
        if outcome != .alreadyRunning { refresh() }
    }

    func pairingDigits(_ invite: PairingInvite) -> String {
        SondinePhone.pairingDigits(token: invite.token, deviceId: device.file.deviceId, pin: invite.pin)
    }

    /// Waits for « Appairer » on the Mac; nil when paired.
    func pair(_ invite: PairingInvite) async -> PhoneSyncClient.PairingFailure? {
        do {
            _ = try await sync.pair(invite)
            becameActive()
            return nil
        } catch {
            return error
        }
    }

    /// « Oublier ce Mac »: how many operations were not sent.
    func forgetMac() async -> Int {
        let dropped = await sync.forget()
        refresh()
        return dropped
    }
}

/// What a row shows of the Mac's result: whom it heard and its first journal line.
struct ResultGlance: Equatable {
    let revision: String
    /// « Marie, Lucas ? », without the user.
    let voices: String?
    let summary: String?

    init(revision: String, result: PhoneResult) {
        self.revision = revision
        let others = result.speakers.filter { !$0.isSelf && ($0.name != nil || $0.guess != nil) }
        voices = others.isEmpty ? nil : ListFormatter.localizedString(byJoining: others.map(VoiceWords.speaker))
        summary = result.journal.first { $0.kind == .line }.map(VoiceWords.text)
    }
}

/// The app's version and when its build stops opening.
struct BuildInfo {
    let version: String
    let build: String
    let builtAt: Date

    /// A TestFlight build stops opening 90 days after its upload (ADR 031).
    static let lifetimeDays = 90
    /// The home screen warns in the last 14 days.
    static let warningDays = 14

    var expiresAt: Date { builtAt.addingTimeInterval(TimeInterval(Self.lifetimeDays) * 86_400) }
    /// `0.1.0 (12)`, as headers carry it.
    var headerVersion: String { "\(version) (\(build))" }

    func daysLeft(now: Date = .now) -> Int {
        Int((expiresAt.timeIntervalSince(now) / 86_400).rounded(.up))
    }

    static var current: BuildInfo {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "0.1.0"
        let build = info["CFBundleVersion"] as? String ?? "1"
        // `pnpm release:ios` writes the build time; a development build counts from its executable.
        let stamped = (info["SondineBuildTime"] as? String).flatMap(TimeInterval.init).map(Date.init(timeIntervalSince1970:))
        let executable = Bundle.main.executableURL.flatMap {
            try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
        }
        return BuildInfo(version: version, build: build, builtAt: stamped ?? executable ?? .now)
    }
}
