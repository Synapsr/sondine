import Foundation
import Synchronization

/// Records by hand, for hours, with the screen locked (ADR 032): one file per
/// stretch of continuous audio, a new file of the same session after an
/// interruption, at 3 hours, or when the microphone changes, with no sample
/// lost at a rotation and never a silent hole: every stop is an `ended` line
/// in the file's log, and one iOS imposes is a local notification.
///
/// The microphone delivers samples on its own thread into a queue, and the
/// first block of a batch schedules a drain; the actor writes them in order. A file is never held across a suspension: it is
/// detached first, then finished, so samples always go to the current one.
public actor PhoneRecorder {
    public struct Configuration: Sendable {
        /// The app's random install id, in every header; read at each start,
        /// nil while the phone cannot read it yet (before the first unlock).
        public var deviceId: @Sendable () -> UUID?
        /// `0.1.0 (12)`.
        public var appVersion: String
        public var codec: PhoneCodec = .alac
        /// 3 hours: the Mac's episode cap, under its import's 4 hour limit.
        public var maxPartSamples = 3 * 3_600 * phoneSampleRate
        /// Recording does not start under 1 GB free…
        public var minFreeToStart: Int64 = 1_000_000_000
        /// …says how much is left under 500 MB…
        public var warnFreeBelow: Int64 = 500_000_000
        /// …and stops cleanly under 200 MB.
        public var minFreeWhileRecording: Int64 = 200_000_000
        /// Free space is read every 10 s of audio.
        public var spaceCheckSamples = 10 * phoneSampleRate
        /// A `progress` line every minute: the length a kill leaves in the log.
        public var progressSamples = 60 * phoneSampleRate

        public init(deviceId: @escaping @Sendable () -> UUID?, appVersion: String) {
            self.deviceId = deviceId
            self.appVersion = appVersion
        }

        public init(deviceId: UUID, appVersion: String) {
            self.init(deviceId: { deviceId }, appVersion: appVersion)
        }
    }

    public struct Recording: Equatable, Sendable {
        public var sessionId: UUID
        public var recordingId: UUID
        public var part: Int
        /// When the session started, on the wall clock.
        public var startedAtMs: Int64
        /// Samples recorded in the session, every file together.
        public var samples: Int
        /// The last block's level, dBFS (−120 for silence).
        public var levelDbfs: Double
        public var route: AudioRoute
        /// Free bytes, once under the warning threshold.
        public var lowSpaceBytes: Int64?

        public var elapsedMs: Int64 { Int64(samples) * 1000 / Int64(phoneSampleRate) }

        public init(
            sessionId: UUID, recordingId: UUID, part: Int, startedAtMs: Int64, samples: Int, levelDbfs: Double,
            route: AudioRoute, lowSpaceBytes: Int64? = nil
        ) {
            self.sessionId = sessionId
            self.recordingId = recordingId
            self.part = part
            self.startedAtMs = startedAtMs
            self.samples = samples
            self.levelDbfs = levelDbfs
            self.route = route
            self.lowSpaceBytes = lowSpaceBytes
        }
    }

    public struct Interrupted: Equatable, Sendable {
        public var sessionId: UUID
        public var atMs: Int64
        public var cause: InterruptionCause
        public var samples: Int
        /// iOS refused to resume when it ended: the user resumes from the app.
        public var resumeFailed: Bool

        public init(sessionId: UUID, atMs: Int64, cause: InterruptionCause, samples: Int, resumeFailed: Bool) {
            self.sessionId = sessionId
            self.atMs = atMs
            self.cause = cause
            self.samples = samples
            self.resumeFailed = resumeFailed
        }
    }

    public enum Phase: Equatable, Sendable {
        case idle
        case recording(Recording)
        case interrupted(Interrupted)
    }

    /// A recording that stopped by itself, until the next one starts.
    public struct Stop: Equatable, Sendable {
        public var atMs: Int64
        public var end: RecordingEnd
    }

    public struct Snapshot: Equatable, Sendable {
        public var phase: Phase = .idle
        public var lastStop: Stop?
        public init() {}
    }

    public enum StartRefusal: Error, Equatable {
        case busy
        case noPermission
        /// The device id cannot be read yet: the phone was not unlocked since it restarted.
        case locked
        /// Started from the Lock Screen, iOS keeps the microphone only with a
        /// Live Activity, and none could start (turned off for Sondine).
        case noLiveActivity
        case lowSpace(available: Int64)
        case session(String)
        case files(String)
    }

    private struct Session {
        let id: UUID
        let deviceId: UUID
        let startedAtMs: Int64
        var part = 0
        var samples = 0
    }

    private struct OpenPart {
        let header: PhoneRecordingHeader
        let folder: RecordingFolder
        let log: EventLog
        let writer: any PartWriter
        var samples = 0
        var sinceProgress = 0
        var sinceSpaceCheck = 0
    }

    private let store: RecordingStore
    private let audioSession: any AudioSessionControlling
    private let microphone: any MicrophoneSource
    private let writers: any PartWriterFactory
    private let disk: any DiskSpace
    private let clock: any PhoneClock
    private let notifier: any PhoneNotifying
    private let configuration: Configuration

    private var session: Session?
    private var part: OpenPart?
    private var route = AudioRoute.builtIn
    private var levelDbfs = -120.0
    private var lowSpaceBytes: Int64?
    private var finishing: Set<UUID> = []
    private var current = Snapshot()
    private var observers: [@Sendable (Snapshot) -> Void] = []
    /// Samples the microphone delivered, not written yet.
    private let queue = SampleQueue()
    private var eventsTask: Task<Void, Never>?

    public init(
        store: RecordingStore, session: any AudioSessionControlling, microphone: any MicrophoneSource,
        writers: any PartWriterFactory, disk: any DiskSpace, clock: any PhoneClock = SystemClock(),
        notifier: any PhoneNotifying, configuration: Configuration
    ) {
        self.store = store
        audioSession = session
        self.microphone = microphone
        self.writers = writers
        self.disk = disk
        self.clock = clock
        self.notifier = notifier
        self.configuration = configuration
    }

    public var snapshot: Snapshot { current }

    /// Calls `onChange` with every new snapshot, on the recorder's executor.
    public func observe(_ onChange: @escaping @Sendable (Snapshot) -> Void) {
        observers.append(onChange)
        onChange(current)
    }

    /// Follows the audio session's events until the recorder goes away.
    public func listen() {
        guard eventsTask == nil else { return }
        let events = audioSession.events
        eventsTask = Task { [weak self] in
            for await event in events {
                guard let self else { return }
                await self.handle(event)
            }
        }
    }

    /// The files being written or closed now: not to be taken for killed ones.
    public var openRecordingIds: Set<UUID> {
        finishing.union(part.map { [$0.header.recordingId] } ?? [])
    }

    /// The store's `reconcile`, on the recorder's executor, so a file opened
    /// meanwhile (a rotation) is never taken for one a kill left.
    @discardableResult
    public func reconcile() -> [StoredRecording] {
        store.reconcile(recording: openRecordingIds, nowMs: clock.nowMs())
    }

    // User actions

    /// « Enregistrer ».
    public func start() throws(StartRefusal) {
        guard case .idle = current.phase else { throw .busy }
        // Never a made-up id: the Mac files a recording by it.
        guard let deviceId = configuration.deviceId() else { throw .locked }
        try checkRoomToStart()
        let route = try activate()
        let now = clock.nowMs()
        session = Session(id: UUID(), deviceId: deviceId, startedAtMs: now)
        current.lastStop = nil
        do {
            try openPart(previous: nil, startMs: now, route: route)
            try startMicrophone()
        } catch {
            abandon()
            throw .files(String(describing: error))
        }
        publish()
    }

    /// « Reprendre » after an interruption: the next file of the same session.
    public func resume() throws(StartRefusal) {
        guard case .interrupted = current.phase, session != nil else { throw .busy }
        try checkRoomToStart()
        let route = try activate()
        do {
            try openPart(previous: .interruption, startMs: clock.nowMs(), route: route)
            try startMicrophone()
        } catch {
            // Still the same session: « Reprendre » can try again.
            abandon(keepingSession: true)
            throw .files(String(describing: error))
        }
        publish()
    }

    /// « Arrêter »: no confirmation, the recording is kept.
    public func stop() async {
        switch current.phase {
        case .idle:
            return
        case .interrupted:
            session = nil
            audioSession.deactivate()
            current.phase = .idle
            publish()
        case .recording:
            stopMicrophone()
            drain()
            let closing = part
            part = nil
            session = nil
            audioSession.deactivate()
            current.phase = .idle
            publish()
            if let closing { await finish(closing, end: .stopped) }
        }
    }

    // iOS

    public func handle(_ event: AudioSessionEvent) async {
        switch event {
        case let .interruptionBegan(cause):
            await interrupt(cause: cause)
        case let .interruptionEnded(shouldResume):
            guard case var .interrupted(state) = current.phase, shouldResume else { return }
            do {
                try resume()
            } catch {
                // Reactivation can fail until the app is opened: the notification stands.
                state.resumeFailed = true
                current.phase = .interrupted(state)
                publish()
            }
        case let .routeChanged(newRoute):
            guard case .recording = current.phase else {
                route = newRoute
                return
            }
            guard newRoute.kind != route.kind else {
                route = newRoute
                publish()
                return
            }
            // Another microphone: the next file says so, with no gap but the switch.
            stopMicrophone()
            drain()
            guard let closing = part else { return }
            part = nil
            do {
                try openPart(previous: .interruption, startMs: clock.nowMs(), route: newRoute)
                try startMicrophone()
                publish()
                await finish(closing, end: .route)
            } catch {
                stoppedByItself(closing, end: .writeFailed)
                await settle()
            }
        case .mediaServicesReset:
            guard case .recording = current.phase else { return }
            await interrupt(cause: .other)
            await handle(.interruptionEnded(shouldResume: true))
        }
    }

    // Samples

    /// Writes what the microphone delivered so far, in order. A block's arrival
    /// schedules it; tests call it too.
    public func drain() {
        let batches = queue.take()
        for batch in batches { write(batch) }
        if !batches.isEmpty, case .recording = current.phase { publish() }
    }

    /// Waits until every sample delivered so far is written, and closed files are finished.
    public func settle() async {
        drain()
        while !finishing.isEmpty { await Task.yield() }
    }

    private func write(_ samples: [Int16]) {
        var rest = samples[...]
        while !rest.isEmpty {
            guard var open = part, var running = session else { return }
            let room = configuration.maxPartSamples - open.samples
            let take = rest.prefix(room)
            do {
                try open.writer.append(Array(take))
            } catch {
                stoppedByItself(open, end: .writeFailed)
                return
            }
            rest = rest.dropFirst(take.count)
            open.samples += take.count
            open.sinceProgress += take.count
            open.sinceSpaceCheck += take.count
            running.samples += take.count
            session = running
            levelDbfs = Self.level(take)
            if open.sinceProgress >= configuration.progressSamples {
                open.sinceProgress -= configuration.progressSamples
                try? open.log.append(RecordingEvent(kind: .progress, atMs: clock.nowMs(), samples: open.samples))
            }
            part = open
            if open.sinceSpaceCheck >= configuration.spaceCheckSamples {
                open.sinceSpaceCheck -= configuration.spaceCheckSamples
                part = open
                if !checkRoomWhileRecording() { return }
            }
            if open.samples >= configuration.maxPartSamples { rotate() }
        }
    }

    /// The file reached 3 hours: the next one starts where it ended, to the sample.
    private func rotate() {
        guard let closing = part else { return }
        part = nil
        let duration = Int64(closing.samples) * 1000 / Int64(phoneSampleRate)
        do {
            try openPart(previous: .rotation, startMs: closing.header.startedWallMs + duration, route: route)
            finishLater(closing, end: .rotation)
        } catch {
            stoppedByItself(closing, end: .writeFailed)
        }
    }

    // Internals

    private func checkRoomToStart() throws(StartRefusal) {
        if let available = disk.availableBytes(), available < configuration.minFreeToStart {
            throw .lowSpace(available: available)
        }
    }

    /// False when recording had to stop for room.
    private func checkRoomWhileRecording() -> Bool {
        guard let available = disk.availableBytes() else { return true }
        if available < configuration.minFreeWhileRecording {
            if let closing = part { stoppedByItself(closing, end: .lowSpace) }
            return false
        }
        lowSpaceBytes = available < configuration.warnFreeBelow ? available : nil
        return true
    }

    private func activate() throws(StartRefusal) -> AudioRoute {
        do {
            route = try audioSession.activate()
            return route
        } catch AudioSessionError.permissionDenied {
            throw .noPermission
        } catch {
            throw .session(String(describing: error))
        }
    }

    private func openPart(previous: PhoneRecordingHeader.PartEnd?, startMs: Int64, route: AudioRoute) throws {
        guard var running = session else { return }
        running.part += 1
        let header = PhoneRecordingHeader(
            recordingId: UUID(), sessionId: running.id, part: running.part, startedWallMs: startMs,
            utcOffsetMin: clock.utcOffsetMin(), deviceId: running.deviceId, input: route.kind,
            previous: previous, app: configuration.appVersion)
        let (folder, log) = try store.create(header, atMs: clock.nowMs())
        let writer: any PartWriter
        do {
            writer = try writers.makeWriter(url: folder.audio, header: header)
        } catch {
            try? log.append(RecordingEvent(kind: .ended, atMs: clock.nowMs(), samples: 0, end: .writeFailed))
            log.close()
            throw error
        }
        session = running
        self.route = route
        part = OpenPart(header: header, folder: folder, log: log, writer: writer)
        current.phase = .recording(recordingState())
    }

    private func recordingState() -> Recording {
        Recording(
            sessionId: session?.id ?? UUID(), recordingId: part?.header.recordingId ?? UUID(),
            part: part?.header.part ?? 0, startedAtMs: session?.startedAtMs ?? 0,
            samples: session?.samples ?? 0, levelDbfs: levelDbfs, route: route, lowSpaceBytes: lowSpaceBytes)
    }

    private func startMicrophone() throws {
        let queue = queue
        try microphone.start({ [weak self] samples in
            // One drain is enough for every block queued before it runs.
            guard queue.put(samples), let self else { return }
            Task { await self.drain() }
        }, failed: { [weak self] _ in
            guard let self else { return }
            Task { await self.interrupt(cause: .other) }
        })
    }

    private func stopMicrophone() { microphone.stop() }

    private func interrupt(cause: InterruptionCause) async {
        guard case .recording = current.phase, let running = session else { return }
        stopMicrophone()
        drain()
        let closing = part
        part = nil
        let now = clock.nowMs()
        current.phase = .interrupted(Interrupted(
            sessionId: running.id, atMs: now, cause: cause, samples: session?.samples ?? 0, resumeFailed: false))
        publish()
        notifier.recordingInterrupted(atMs: now, cause: cause)
        if let closing { await finish(closing, end: .interruption) }
    }

    /// Recording stopped by itself (no room, the file could not be written):
    /// nothing records from here, the user is told, and the file is closed.
    private func stoppedByItself(_ closing: OpenPart, end: RecordingEnd) {
        stopMicrophone()
        // What the microphone delivered after this has nowhere to go.
        _ = queue.take()
        if part?.header.recordingId == closing.header.recordingId { part = nil }
        session = nil
        audioSession.deactivate()
        let now = clock.nowMs()
        current.phase = .idle
        current.lastStop = Stop(atMs: now, end: end)
        publish()
        notifier.recordingStopped(atMs: now, end: end)
        finishLater(closing, end: end)
    }

    /// Closes a file without holding up the samples that go to the next one.
    private func finishLater(_ closing: OpenPart, end: RecordingEnd) {
        finishing.insert(closing.header.recordingId)
        Task { await self.finish(closing, end: end) }
    }

    /// Something failed while starting: nothing records. A resume that failed
    /// stays interrupted, its session kept for the next try.
    private func abandon(keepingSession: Bool = false) {
        stopMicrophone()
        _ = queue.take()
        if let open = part {
            try? open.log.append(RecordingEvent(kind: .ended, atMs: clock.nowMs(), samples: open.samples, end: .writeFailed))
            open.log.close()
        }
        part = nil
        audioSession.deactivate()
        if keepingSession, let running = session {
            current.phase = .interrupted(Interrupted(
                sessionId: running.id, atMs: clock.nowMs(), cause: .other, samples: running.samples,
                resumeFailed: true))
        } else {
            session = nil
            current.phase = .idle
        }
        publish()
    }

    private func finish(_ closing: OpenPart, end: RecordingEnd) async {
        finishing.insert(closing.header.recordingId)
        var end = end
        do {
            try await closing.writer.finish()
        } catch {
            if end != .lowSpace { end = .writeFailed }
        }
        try? closing.log.append(RecordingEvent(kind: .ended, atMs: clock.nowMs(), samples: closing.samples, end: end))
        closing.log.close()
        finishing.remove(closing.header.recordingId)
    }

    private func publish() {
        if case .recording = current.phase { current.phase = .recording(recordingState()) }
        for observer in observers { observer(current) }
    }

    /// dBFS of a block's mean power.
    static func level(_ samples: ArraySlice<Int16>) -> Double {
        guard !samples.isEmpty else { return -120 }
        let power = samples.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(samples.count)
        guard power > 0 else { return -120 }
        return max(-120, 10 * log10(power / (32_768.0 * 32_768.0)))
    }
}

/// Blocks the microphone's thread hands to the recorder, in order.
final class SampleQueue: Sendable {
    private let pending = Mutex<[[Int16]]>([])

    /// Queues a block; true when the queue was empty, so a drain must be scheduled.
    func put(_ samples: [Int16]) -> Bool {
        pending.withLock { pending in
            pending.append(samples)
            return pending.count == 1
        }
    }

    func take() -> [[Int16]] {
        pending.withLock { pending in
            defer { pending.removeAll() }
            return pending
        }
    }
}
