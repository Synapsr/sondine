import CryptoKit
import Foundation

// The sync with the paired Mac (ADR 008, « Sending a recording »,
// « Deletion, both ways », « What the phone keeps »), run while the app is
// open and the phone unlocked: `hello`, then each finished recording oldest
// first (announce, then `PUT …/audio` from the offset the Mac holds), then
// the Mac's state of every recording the phone holds, then the outbox
// (deletions, names, notes), then the results of ready recordings of the
// last 30 days whose revision moved. The audio leaves the phone only after
// `stored`. Playback reads the Mac's WAV by ranges, and the reads of the
// Mac's memory (M5.4) their answers, in memory only.

public actor PhoneSyncClient {
    /// What « Mac » and the rows show.
    public struct Status: Equatable, Sendable {
        public var mac: PairedMac?
        /// The last attempt reached the Mac.
        public var reachable = false
        /// How the last sync reached it, as the Mac's `hello` says (M5.5):
        /// at home or through Tailscale. Shown only while `reachable`.
        public var path: MacPath?
        public var syncing = false
        /// Bytes the Mac holds of each file being sent, live.
        public var uploads: [UUID: Int64] = [:]
        public var problem: Problem?
        /// The Mac revoked this phone: said on « Mac » until the next pairing.
        public var revokedBy: LostMac?

        public init() {}
    }

    public enum Problem: Equatable, Sendable {
        /// The Mac and the phone speak other protocol versions.
        case version(mac: Int, phone: Int)
        /// The Mac has no room for the next recording.
        case macFull
        /// The Mac is busy (another upload, too many connections): next time.
        case busy
    }

    /// How a sync ended.
    public enum Outcome: Equatable, Sendable {
        case notPaired
        case alreadyRunning
        case unreachable
        case done
        case revoked
        case stopped(Problem)
        case cancelled
    }

    public enum PairingFailure: Error, Equatable, Sendable {
        /// No address answered, or the key was not the QR's.
        case unreachable
        /// « Refuser » on the Mac.
        case refused
        /// The code was used or expired, or the pairing closed: a new QR is needed.
        case expired
        case version(mac: Int, phone: Int)
        /// Pairing happens at home, never through Tailscale.
        case tailnet
        case busy
        case failed
    }

    public struct Configuration: Sendable {
        /// The name the phone gives itself on the Mac.
        public var deviceName: String
        /// How long a JSON request may wait for an answer.
        public var timeout: TimeInterval = 10
        /// How long `/v1/pair` waits for « Appairer » on the Mac.
        public var pairingTimeout: TimeInterval = TimeInterval(PhoneSync.pairingAnswerMs) / 1000 + 15
        /// After « no room » on the Mac, uploads wait this long.
        public var fullBackoffMs: Int64 = 15 * 60_000

        public init(deviceName: String) { self.deviceName = deviceName }
    }

    private let store: RecordingStore
    private let outbox: Outbox
    private let device: DeviceStore
    private let credentials: any CredentialStoring
    private let transport: any SyncTransport
    private let finder: any MacFinding
    private let clock: any PhoneClock
    private let openRecordings: @Sendable () async -> Set<UUID>
    private var configuration: Configuration

    private var current = Status()
    private var observer: (@Sendable (Status) -> Void)?
    /// Bumped by « Oublier » and a revocation: a sync under way stops at its next step.
    private var generation = 0
    private var lastEndpoint: MacEndpoint?
    private var uploadsPausedUntilMs: Int64 = 0

    public init(
        store: RecordingStore, outbox: Outbox, device: DeviceStore, credentials: any CredentialStoring,
        transport: any SyncTransport, finder: any MacFinding, clock: any PhoneClock = SystemClock(),
        configuration: Configuration, openRecordings: @escaping @Sendable () async -> Set<UUID> = { [] }
    ) {
        self.store = store
        self.outbox = outbox
        self.device = device
        self.credentials = credentials
        self.transport = transport
        self.finder = finder
        self.clock = clock
        self.configuration = configuration
        self.openRecordings = openRecordings
        let file = device.file
        // A device file that names a Mac without a credential (restored, or a pairing lost half-way) is not paired.
        current.mac = credentials.read() == nil ? nil : file.mac
        current.revokedBy = file.revokedBy
    }

    public var status: Status { current }

    /// Reads the pairing again once the phone is unlocked: a launch with the
    /// phone locked (a recording started from the Lock Screen) could read
    /// neither `device.json` nor the credential.
    public func reloadPairing() {
        guard !current.syncing else { return }
        let file = device.file
        publish {
            $0.mac = credentials.read() == nil ? nil : file.mac
            $0.revokedBy = file.revokedBy
        }
    }

    public func observe(_ onChange: @escaping @Sendable (Status) -> Void) {
        observer = onChange
        onChange(current)
    }

    private func publish(_ change: (inout Status) -> Void) {
        var next = current
        change(&next)
        guard next != current else { return }
        current = next
        observer?(next)
    }

    // Deleting

    /// « Supprimer » on the phone: paired, the deletion waits in the outbox
    /// (written before the folder goes); not paired, the folder just goes.
    public func delete(_ recordingId: UUID) throws {
        if current.mac != nil {
            try outbox.delete(recordingId, from: store, atMs: clock.nowMs())
        } else {
            try store.delete(recordingId)
        }
    }

    // Names and notes (M5.3)

    /// The user renamed it on the phone (nil, or blanks: back to its hour).
    /// Paired, the name waits in the outbox; otherwise it goes after the next
    /// pairing, once the Mac holds the recording.
    public func rename(_ recordingId: UUID, to name: String?) throws {
        let typedAtMs = clock.nowMs()
        guard try store.rename(recordingId, to: name, typedAtMs: typedAtMs), current.mac != nil else { return }
        try outbox.add(.rename(recordingId, to: RecordingStore.cleanName(name), typedAtMs: typedAtMs))
    }

    /// « Ajouter une note »: waits in the outbox until the Mac adds it. False when not paired or blank.
    @discardableResult
    public func addNote(_ recordingId: UUID, text: String) throws -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard current.mac != nil, !trimmed.isEmpty, store.recording(recordingId) != nil else { return false }
        var cut = ""
        for character in trimmed where cut.utf16.count + String(character).utf16.count <= 20_000 { cut.append(character) }
        try outbox.add(.note(recordingId, text: cut, atMs: clock.nowMs()))
        return true
    }

    // Tags and « C'est moi » (ADR 039)

    /// A tag put on the recording, or taken off: waits in the outbox until
    /// the Mac applies it. False when not paired, or the name is empty or too long.
    @discardableResult
    public func setTag(_ recordingId: UUID, name: String, on: Bool) throws -> Bool {
        guard current.mac != nil, let clean = TagName.clean(name), store.recording(recordingId) != nil else { return false }
        try outbox.add(.tag(recordingId, name: clean, on: on, atMs: clock.nowMs()))
        return true
    }

    /// The recording's tags as the phone shows them: the Mac's, with what still waits applied on top.
    public func tags(_ recordingId: UUID, mac: [String]) -> [String] {
        TagName.shown(mac: mac, waiting: outbox.all(), recordingId: recordingId)
    }

    /// The tags to offer: those used on this phone lately, then the Mac's, once each.
    public func recentTags() -> [String] {
        TagName.recent(waiting: outbox.all(), mac: device.file.macTags ?? [])
    }

    /// « C'est moi » on a voice Sondine took for the user: waits in the outbox. False when not paired.
    @discardableResult
    public func confirmSelf(_ recordingId: UUID, ordinal: Int, sentenceId: Int) throws -> Bool {
        guard current.mac != nil, ordinal >= 1, sentenceId >= 1, store.recording(recordingId) != nil else { return false }
        try outbox.add(.voice(recordingId, ordinal: ordinal, sentenceId: sentenceId, atMs: clock.nowMs()))
        return true
    }

    /// The voices the user said are theirs that the Mac has not named yet.
    public func pendingSelf(_ recordingId: UUID) -> Set<Int> {
        Set(outbox.all().filter { $0.kind == .voice && $0.recordingId == recordingId }.compactMap(\.ordinal))
    }

    /// Notes typed on the phone the Mac has not added yet, oldest first.
    public func pendingNotes(_ recordingId: UUID) -> [OutboxOperation] {
        outbox.all().filter { $0.kind == .note && $0.recordingId == recordingId }
    }

    /// The latest time the phone has seen (its clock's, or the Mac's), kept: results count 30 days back from it.
    public func latestSeenMs() -> Int64 { device.seen(clock.nowMs()) }

    // Playback (M5.3)

    /// One byte range of what the Mac plays for this recording, at this generation.
    public func audio(_ recordingId: UUID, generation: Int, range: ClosedRange<Int64>) async -> RemoteAudioRead {
        guard let mac = device.file.mac, let credential = credentials.read() else { return .notPaired }
        let path = PhoneSync.Route.audio(recordingId, generation: generation)
        var candidates = candidates(mac, first: lastEndpoint)
        while let endpoint = await candidates.next() {
            let reply: SyncReply
            do {
                reply = try await transport.get(
                    path, range: range, credential: credential, to: endpoint, pin: mac.pin, timeout: configuration.timeout)
            } catch {
                if lastEndpoint == endpoint { lastEndpoint = nil }
                if Task.isCancelled { return .unreachable }
                continue
            }
            lastEndpoint = endpoint
            switch reply.status {
            case 206:
                guard let bounds = reply.contentRange.flatMap(ContentRange.parse), bounds.start == range.lowerBound,
                      Int64(reply.body.count) == bounds.end - bounds.start + 1
                else { return .refused(status: 206, .badRequest) }
                return .bytes(reply.body, total: bounds.total)
            case 200:
                // The whole WAV: what was asked of it.
                let total = Int64(reply.body.count)
                guard range.lowerBound < total else { return .refused(status: 416, .range) }
                let end = min(range.upperBound, total - 1)
                return .bytes(reply.body.subdata(in: Int(range.lowerBound)..<Int(end + 1)), total: total)
            default:
                let error = (try? JSONDecoder().decode(PhoneError.self, from: reply.body)) ?? PhoneError(error: .badRequest)
                if error.error == .revoked || error.error == .unauthorized { unpair(revoked: true) }
                return .refused(status: reply.status, error.error)
            }
        }
        publish { $0.reachable = false; $0.path = nil }
        return .unreachable
    }

    // Reading the Mac's memory (M5.4)

    /// One live read of the Mac's memory (`POST /v1/memory/…`): the answer's
    /// body, held by the caller in memory only. It writes nothing on the
    /// phone, but erases the pairing when the Mac says it was revoked.
    public func read(_ path: String, json: Data) async -> MacRead {
        guard let mac = device.file.mac, let credential = credentials.read() else { return .notPaired }
        var candidates = candidates(mac, first: lastEndpoint)
        while let endpoint = await candidates.next() {
            let reply: SyncReply
            do {
                reply = try await transport.post(
                    path, json: json, credential: credential, to: endpoint, pin: mac.pin, timeout: configuration.timeout)
            } catch {
                if lastEndpoint == endpoint { lastEndpoint = nil }
                if Task.isCancelled { return .unreachable }
                continue
            }
            lastEndpoint = endpoint
            publish { $0.reachable = true }
            guard reply.status == 200 else {
                let error = (try? JSONDecoder().decode(PhoneError.self, from: reply.body)) ?? PhoneError(error: .badRequest)
                if error.error == .revoked || error.error == .unauthorized { unpair(revoked: true) }
                return .refused(status: reply.status, error.error)
            }
            guard reply.body.count <= PhoneSync.maxMemoryBytes else { return .refused(status: 200, .badRequest) }
            return .answer(reply.body)
        }
        publish { $0.reachable = false }
        return .unreachable
    }

    /// Where this request tries the Mac (`MacCandidates`): the tunnel's
    /// addresses only after every home one failed.
    private func candidates(_ mac: PairedMac, first: MacEndpoint? = nil, preferred: MacEndpoint? = nil) -> MacCandidates {
        MacCandidates(
            finder: finder, pin: mac.pin, known: mac.addrs.map { MacEndpoint(host: $0, port: mac.port) },
            first: [first].compactMap { $0 }, preferred: preferred)
    }

    // Pairing

    /// Sends the QR's token and waits for « Appairer » on the Mac. The six
    /// digits are `pairingDigits(token:deviceId:pin:)`, shown meanwhile.
    public func pair(_ invite: PairingInvite) async throws(PairingFailure) -> PairedMac {
        let file = device.file
        let name = Self.wireDeviceName(configuration.deviceName)
        guard let request = try? PairRequest(token: invite.token, deviceId: file.deviceId, deviceName: name),
              let body = try? JSONEncoder().encode(request)
        else { throw .failed }
        let known = invite.addrs.map { MacEndpoint(host: $0, port: invite.port) }
        let candidates = await finder.find(pin: invite.pin, known: known)
        for endpoint in candidates {
            let reply: SyncReply
            do {
                reply = try await transport.post(
                    PhoneSync.Route.pair, json: body, credential: nil, to: endpoint, pin: invite.pin,
                    timeout: configuration.pairingTimeout)
            } catch {
                if Task.isCancelled { throw .failed }
                continue
            }
            guard reply.status == 200 else {
                switch (try? JSONDecoder().decode(PhoneError.self, from: reply.body))?.error {
                case .pairingRefused: throw .refused
                case .pairingUsed, .pairingClosed: throw .expired
                case .pairingTailnet: throw .tailnet
                case .busy: throw .busy
                case .version:
                    let mac = (try? JSONDecoder().decode(PhoneError.self, from: reply.body))?.macVersion ?? 0
                    throw .version(mac: mac, phone: PhoneSync.version)
                default: throw .failed
                }
            }
            guard let answer = try? JSONDecoder().decode(PairAnswer.self, from: reply.body) else { throw .failed }
            do {
                try credentials.write(answer.credential)
                let mac = PairedMac(
                    macId: answer.macId, pin: invite.pin, name: invite.name, port: invite.port, addrs: invite.addrs,
                    pairedAtMs: clock.nowMs())
                var dropOutbox = false
                try device.update { file in
                    // An outbox kept for another Mac means nothing to this one.
                    dropOutbox = file.lastMacId != nil && file.lastMacId != answer.macId
                    file.mac = mac
                    if file.lastMacId != answer.macId { file.macTags = nil }
                    file.lastMacId = answer.macId
                    file.revokedBy = nil
                }
                if dropOutbox { outbox.removeAll() }
                lastEndpoint = endpoint
                generation += 1
                publish {
                    $0.mac = mac
                    $0.reachable = true
                    $0.path = .home
                    $0.revokedBy = nil
                    $0.problem = nil
                }
                return mac
            } catch {
                credentials.erase()
                throw .failed
            }
        }
        throw .unreachable
    }

    /// The name the Mac shows: 1 to 64 UTF-16 units, no control character.
    public static func wireDeviceName(_ name: String) -> String {
        let clean = String(name.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7F })
            .trimmingCharacters(in: .whitespacesAndNewlines)
        var cut = ""
        for character in clean where cut.utf16.count + String(character).utf16.count <= 64 { cut.append(character) }
        return cut.isEmpty ? "iPhone" : cut
    }

    // « Oublier ce Mac »

    /// Tells the Mac when it can be reached, then erases the credential, the
    /// results fetched and the outbox. Recordings not sent stay. Returns how
    /// many operations the outbox dropped.
    @discardableResult
    public func forget() async -> Int {
        generation += 1
        if let mac = device.file.mac, let credential = credentials.read(), let body = try? JSONEncoder().encode(ForgetRequest()) {
            var candidates = candidates(mac, first: lastEndpoint)
            while let endpoint = await candidates.next() {
                if let reply = try? await transport.post(
                    PhoneSync.Route.forget, json: body, credential: credential, to: endpoint, pin: mac.pin,
                    timeout: 5) {
                    _ = reply
                    break
                }
            }
        }
        let dropped = outbox.removeAll()
        unpair(revoked: false)
        return dropped
    }

    /// The credential and the results go; recordings not sent stay.
    private func unpair(revoked: Bool) {
        generation += 1
        let mac = device.file.mac
        credentials.erase()
        store.eraseResults()
        try? device.update { file in
            if let mac { file.lastMacId = mac.macId }
            file.revokedBy = revoked ? mac.map { LostMac(name: $0.name, atMs: clock.nowMs()) } : nil
            file.mac = nil
            // The Mac's words go with its results (ADR 039).
            file.macTags = nil
        }
        lastEndpoint = nil
        publish {
            $0.mac = nil
            $0.reachable = false
            $0.path = nil
            $0.uploads = [:]
            $0.problem = nil
            $0.revokedBy = revoked ? self.device.file.revokedBy : nil
        }
    }

    // Sync

    private enum CallError: Error {
        /// The Mac could not be reached (or the key was not the pinned one).
        case network
        case refused(PhoneError)
        /// An answer the contract does not allow.
        case badAnswer
        case cancelled
    }

    private struct Session {
        let mac: PairedMac
        let credential: String
        let endpoint: MacEndpoint
        let generation: Int
    }

    /// One pass. Never runs twice at once.
    public func sync() async -> Outcome {
        guard !current.syncing else { return .alreadyRunning }
        // Audio the Mac already holds, left by a kill between `stored` and its removal.
        for recording in store.list() where recording.sync.stored && recording.hasAudio {
            try? store.eraseAudio(recording.id)
        }
        guard let mac = device.file.mac, let credential = credentials.read() else {
            publish { $0.mac = nil }
            return .notPaired
        }
        publish {
            $0.syncing = true
            $0.mac = mac
        }
        defer { publish { $0.syncing = false; $0.uploads = [:] } }
        let outcome = await run(mac: mac, credential: credential)
        if outcome == .done {
            try? device.update { $0.mac?.lastSyncMs = clock.nowMs() }
            publish { $0.mac = device.file.mac; $0.problem = nil }
        }
        return outcome
    }

    private func run(mac: PairedMac, credential: String) async -> Outcome {
        let generation = generation
        // `hello`, at the first address whose pinned key answers: home first,
        // the tunnel's only once every home address failed. The address that
        // answered last goes first when the finder found it again at home:
        // one left behind at home is not waited for away from it, and a
        // tunnel's never jumps ahead of home.
        var candidates = candidates(mac, preferred: lastEndpoint?.isTailnet == false ? lastEndpoint : nil)
        var session: Session?
        var hello: HelloAnswer?
        let held = store.list().map(\.id)
        while let endpoint = await candidates.next() {
            let attempt = Session(mac: mac, credential: credential, endpoint: endpoint, generation: generation)
            do {
                let request = try HelloRequest(clockMs: max(clock.nowMs(), 0), recordingIds: Array(held.prefix(PhoneSync.maxIds)))
                let answer = try await call(PhoneSync.Route.hello, request, HelloAnswer.self, attempt)
                // The pinned key answered: it is this Mac, unless it says otherwise.
                guard answer.macId == mac.macId else { continue }
                session = attempt
                hello = answer
                break
            } catch CallError.network {
                continue
            } catch CallError.refused(let error) {
                return refused(error)
            } catch {
                if Task.isCancelled { return .cancelled }
                continue
            }
        }
        guard let session, let hello else {
            lastEndpoint = nil
            publish { $0.reachable = false; $0.path = nil }
            return Task.isCancelled ? .cancelled : .unreachable
        }
        lastEndpoint = session.endpoint
        // The 30 days of results count back from the latest time seen, the Mac's clock included.
        let latestSeen = device.seen(max(clock.nowMs(), hello.clockMs))
        try? device.update { file in
            file.mac?.lastSeenMs = clock.nowMs()
            file.mac?.port = hello.port
            if !hello.addrs.isEmpty { file.mac?.addrs = hello.addrs }
        }
        publish {
            $0.reachable = true
            $0.path = hello.via
            $0.mac = device.file.mac
        }

        // The recordings, oldest first.
        if clock.nowMs() >= uploadsPausedUntilMs {
            let open = await openRecordings()
            for recording in store.list().reversed() where Self.sendable(recording, open: open) {
                switch await send(recording, session, maxFileBytes: hello.maxFileBytes) {
                case .next: continue
                case let .stop(outcome): return outcome
                }
            }
        }

        // Names typed before pairing, or before the Mac held the recording, go now.
        queueUnsentNames()

        // The Mac's state of every recording the phone holds.
        let ids = store.list().map(\.id)
        for start in stride(from: 0, to: ids.count, by: PhoneSync.maxIds) {
            let chunk = Array(ids[start..<min(start + PhoneSync.maxIds, ids.count)])
            do {
                let answer = try await call(PhoneSync.Route.states, try StatesRequest(recordingIds: chunk), StatesAnswer.self, session)
                apply(answer, open: await openRecordings())
            } catch {
                return failed(error)
            }
        }

        // The outbox.
        for operation in outbox.all() {
            if let outcome = await send(operation, session) { return outcome }
        }

        // The Mac's tags, to offer offline (ADR 039).
        do {
            let answer = try await call(PhoneSync.Route.tags, TagsRequest(), TagsAnswer.self, session)
            try? device.update { $0.macTags = answer.tags }
        } catch {
            return failed(error)
        }

        // The results of ready recordings of the last 30 days, when their revision moved.
        let open = await openRecordings()
        for recording in store.list().reversed()
        where recording.sync.mac == .ready && !open.contains(recording.id)
            && !RecordingStore.resultExpired(startedAtMs: recording.startedAtMs, latestSeenMs: latestSeen) {
            if let outcome = await fetchResult(recording, session) { return outcome }
        }
        return .done
    }

    /// A name not acknowledged by the Mac, for a recording it holds, waits in the outbox.
    private func queueUnsentNames() {
        let pending = outbox.all().filter { $0.kind == .rename }
        for recording in store.list() where recording.sync.stored && recording.nameUnsent {
            guard let typed = recording.effectiveNameTypedAtMs,
                  !pending.contains(where: { $0.recordingId == recording.id && ($0.typedAtMs ?? $0.atMs) >= typed })
            else { continue }
            try? outbox.add(.rename(recording.id, to: recording.name, typedAtMs: typed))
        }
    }

    /// Sends one operation of the outbox; an outcome when the pass ends there.
    private func send(_ operation: OutboxOperation, _ session: Session) async -> Outcome? {
        do {
            switch operation.kind {
            case .delete:
                let request = DeleteRequest(operationId: operation.operationId, recordingId: operation.recordingId)
                let body = try await callRaw(PhoneSync.Route.delete, request, session)
                _ = try StatusAnswer.decode(body, expecting: "deleted")
                outbox.remove(operation.operationId)
            case .rename:
                let typed = operation.typedAtMs ?? operation.atMs
                let request = try RenameRequest(
                    operationId: operation.operationId, recordingId: operation.recordingId, name: operation.name,
                    typedAtMs: max(typed, 0))
                let answer = try await call(PhoneSync.Route.rename, request, OperationAnswer.self, session)
                guard answer != .later else { return nil }
                if answer == .done { try? store.nameSent(operation.recordingId, typedAtMs: typed) }
                outbox.remove(operation.operationId)
            case .note:
                let request = try NoteRequest(
                    operationId: operation.operationId, recordingId: operation.recordingId, text: operation.text ?? "")
                let answer = try await call(PhoneSync.Route.note, request, OperationAnswer.self, session)
                guard answer != .later else { return nil }
                outbox.remove(operation.operationId)
            case .tag:
                let request = try TagRequest(
                    operationId: operation.operationId, recordingId: operation.recordingId, name: operation.name ?? "",
                    on: operation.on ?? true)
                let answer = try await call(PhoneSync.Route.tag, request, OperationAnswer.self, session)
                guard answer != .later else { return nil }
                outbox.remove(operation.operationId)
            case .voice:
                let request = try VoiceRequest(
                    operationId: operation.operationId, recordingId: operation.recordingId, ordinal: operation.ordinal ?? 0,
                    sentenceId: operation.sentenceId ?? 0)
                let answer = try await call(PhoneSync.Route.voice, request, OperationAnswer.self, session)
                guard answer != .later else { return nil }
                outbox.remove(operation.operationId)
            }
            return nil
        } catch CallError.refused(let error) where error.error == .notYours {
            // Another phone's recording: nothing to do here.
            outbox.remove(operation.operationId)
            return nil
        } catch is WireError {
            // An operation the wire refuses (a file from another build): it can never go.
            outbox.remove(operation.operationId)
            return nil
        } catch {
            return failed(error)
        }
    }

    /// Asks for a recording's result with the revision the phone holds; an outcome when the pass ends there.
    private func fetchResult(_ recording: StoredRecording, _ session: Session) async -> Outcome? {
        do {
            let request = try GetRequest(recordingId: recording.id, revision: recording.resultRevision)
            let answer = try await call(
                PhoneSync.Route.get, request, GetAnswer.self, session, maxBytes: PhoneSync.maxResultBytes)
            switch answer {
            case let .result(revision, result):
                try? store.writeResult(recording.id, StoredResult(revision: revision, fetchedAtMs: clock.nowMs(), result: result))
            case .unavailable(.deleted):
                try? store.delete(recording.id)
            case .unavailable:
                // Not ready any more: the result held may show what the Mac deleted.
                store.eraseResult(recording.id)
            case .unchanged, .withheld:
                // Kept as it is; a withheld answer is asked again at the next pass.
                break
            }
            return nil
        } catch CallError.refused(let error) where error.error == .notYours || error.error == .badRequest {
            return nil
        } catch {
            return failed(error)
        }
    }

    /// Finished, closed, still holding its audio, and not refused for good.
    static func sendable(_ recording: StoredRecording, open: Set<UUID>) -> Bool {
        !recording.isOpen && !open.contains(recording.id) && recording.hasAudio && recording.bytes > 0
            && !recording.sync.stored && !recording.sync.conflict && recording.sync.refused == nil
    }

    private enum Step {
        case next
        case stop(Outcome)
    }

    private func send(_ recording: StoredRecording, _ session: Session, maxFileBytes: Int64) async -> Step {
        let id = recording.id
        let size = recording.bytes
        guard size <= min(maxFileBytes, PhoneSync.maxFileBytes) else {
            try? store.updateSync(id) { $0.refused = .tooLarge }
            return .next
        }
        let sha256: String
        if recording.sync.bytes == size, let known = recording.sync.sha256 {
            sha256 = known
        } else {
            guard let hashed = Self.sha256(recording.folder.audio) else { return .next }
            sha256 = hashed
            try? store.updateSync(id) {
                $0.bytes = size
                $0.sha256 = hashed
            }
        }
        guard let announce = try? AnnounceRequest(recordingId: id, bytes: size, sha256: sha256) else { return .next }
        var status: UploadStatus
        do {
            status = try await call(PhoneSync.Route.announce, announce, UploadStatus.self, session)
        } catch {
            return recordingFailure(error, id)
        }
        // Each step either finishes, or sends bytes the Mac did not hold: a few rounds at most.
        var reannounced = false
        for _ in 0..<4 {
            switch status {
            case let .send(offset):
                guard offset <= size else { return .next }
                try? store.updateSync(id) { $0.sentBytes = offset; $0.mac = .receiving }
                publish { $0.uploads[id] = offset }
                do {
                    status = try await upload(recording, from: offset, session)
                } catch {
                    publish { $0.uploads[id] = nil }
                    return recordingFailure(error, id)
                }
            case .stored:
                try? store.eraseAudio(id)
                publish { $0.uploads[id] = nil }
                return .next
            case .conflict:
                try? store.updateSync(id) { $0.conflict = true }
                publish { $0.uploads[id] = nil }
                return .next
            case .deleted:
                try? store.delete(id)
                publish { $0.uploads[id] = nil }
                return .next
            case let .refused(reason):
                publish { $0.uploads[id] = nil }
                switch reason {
                case .tooLarge, .header, .unreadable:
                    try? store.updateSync(id) { $0.refused = reason }
                    return .next
                case .hash:
                    // The part was discarded: hashed again and sent from the start next time.
                    try? store.updateSync(id) { $0.sha256 = nil; $0.sentBytes = 0 }
                    return .next
                case .offset:
                    guard !reannounced else { return .next }
                    reannounced = true
                    do {
                        status = try await call(PhoneSync.Route.announce, announce, UploadStatus.self, session)
                    } catch {
                        return recordingFailure(error, id)
                    }
                case .noRoom:
                    uploadsPausedUntilMs = clock.nowMs() + configuration.fullBackoffMs
                    publish { $0.problem = .macFull }
                    return .stop(.stopped(.macFull))
                case .busy:
                    publish { $0.problem = .busy }
                    return .stop(.stopped(.busy))
                }
            }
        }
        return .next
    }

    private func upload(_ recording: StoredRecording, from offset: Int64, _ session: Session) async throws -> UploadStatus {
        guard generation == session.generation else { throw CallError.cancelled }
        let id = recording.id
        let reply: SyncReply
        do {
            reply = try await transport.put(
                PhoneSync.Route.audio(id), file: recording.folder.audio, offset: offset, credential: session.credential,
                to: session.endpoint, pin: session.mac.pin
            ) { [weak self] held in
                Task { await self?.progress(id, held) }
            }
        } catch {
            throw Task.isCancelled ? CallError.cancelled : CallError.network
        }
        return try decode(reply, UploadStatus.self)
    }

    private func progress(_ id: UUID, _ held: Int64) {
        guard current.uploads[id] != nil else { return }
        publish { $0.uploads[id] = held }
    }

    /// What the Mac said of each recording the phone holds.
    private func apply(_ answer: StatesAnswer, open: Set<UUID>) {
        for entry in answer.states where !open.contains(entry.recordingId) {
            if entry.state == .deleted {
                // Deleted on the Mac: the phone's copy goes too.
                try? store.delete(entry.recordingId)
            } else {
                try? store.updateSync(entry.recordingId) { $0.mac = entry.state }
                // No longer ready (a passage deleted sends it back to analysis): what the
                // phone holds may show what the Mac deleted, so it goes until the next result.
                if entry.state != .ready { store.eraseResult(entry.recordingId) }
            }
        }
    }

    /// A failure while sending one recording: the next one, or the end of this pass.
    private func recordingFailure(_ error: Error, _ id: UUID) -> Step {
        switch error {
        case CallError.refused(let refusal) where refusal.error == .notYours:
            // The Mac holds this id for another phone: as a conflict, the file stays.
            try? store.updateSync(id) { $0.conflict = true }
            return .next
        case CallError.refused(let refusal) where refusal.error == .badRequest:
            return .next
        default:
            return .stop(failed(error))
        }
    }

    private func failed(_ error: Error) -> Outcome {
        switch error {
        case CallError.refused(let refusal): return refused(refusal)
        case CallError.cancelled: return .cancelled
        case CallError.network:
            lastEndpoint = nil
            publish { $0.reachable = false; $0.path = nil }
            return Task.isCancelled ? .cancelled : .unreachable
        default: return .unreachable
        }
    }

    private func refused(_ error: PhoneError) -> Outcome {
        switch error.error {
        case .revoked, .unauthorized:
            unpair(revoked: true)
            return .revoked
        case .version:
            let problem = Problem.version(mac: error.macVersion ?? 0, phone: PhoneSync.version)
            publish { $0.problem = problem }
            return .stopped(problem)
        default:
            publish { $0.problem = .busy }
            return .stopped(.busy)
        }
    }

    private func call<Answer: Decodable>(
        _ path: String, _ request: some Encodable, _ answer: Answer.Type, _ session: Session,
        maxBytes: Int = PhoneSync.maxJsonBytes
    ) async throws -> Answer {
        let body = try await callRaw(path, request, session, maxBytes: maxBytes)
        guard let decoded = try? JSONDecoder().decode(answer, from: body) else { throw CallError.badAnswer }
        return decoded
    }

    /// The answer's body when the status is 200.
    private func callRaw(
        _ path: String, _ request: some Encodable, _ session: Session, maxBytes: Int = PhoneSync.maxJsonBytes
    ) async throws -> Data {
        guard generation == session.generation else { throw CallError.cancelled }
        guard let json = try? JSONEncoder().encode(request) else { throw CallError.badAnswer }
        let reply: SyncReply
        do {
            reply = try await transport.post(
                path, json: json, credential: session.credential, to: session.endpoint, pin: session.mac.pin,
                timeout: configuration.timeout)
        } catch {
            throw Task.isCancelled ? CallError.cancelled : CallError.network
        }
        guard generation == session.generation else { throw CallError.cancelled }
        guard reply.status == 200 else {
            guard let error = try? JSONDecoder().decode(PhoneError.self, from: reply.body) else { throw CallError.badAnswer }
            throw CallError.refused(error)
        }
        guard reply.body.count <= maxBytes else { throw CallError.badAnswer }
        return reply.body
    }

    private func decode<Answer: Decodable>(_ reply: SyncReply, _ answer: Answer.Type) throws -> Answer {
        guard reply.status == 200 else {
            guard let error = try? JSONDecoder().decode(PhoneError.self, from: reply.body) else { throw CallError.badAnswer }
            throw CallError.refused(error)
        }
        guard let decoded = try? JSONDecoder().decode(answer, from: reply.body) else { throw CallError.badAnswer }
        return decoded
    }

    /// A file's SHA-256, read by 1 MiB.
    static func sha256(_ url: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try? handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
