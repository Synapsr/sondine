import Foundation

/// The protection class of a file on the iPhone (ADR 008, « What the phone keeps »).
public enum ProtectionClass: String, Sendable {
    /// Created and kept open while the phone is locked: the file being recorded and its log.
    case completeUnlessOpen
    /// Read and written with the phone unlocked only.
    case complete
    /// Readable from the first unlock after a restart, locked or not: the
    /// device id a recording started from the Lock Screen needs.
    case untilFirstUnlock
}

/// Sets protection classes; iOS's data protection on the phone, nothing on a Mac.
public protocol FileProtecting: Sendable {
    func protect(_ url: URL, _ protection: ProtectionClass) throws
}

/// For the Mac, where tests run: no data protection to set.
public struct NoFileProtection: FileProtecting {
    public init() {}
    public func protect(_ url: URL, _ protection: ProtectionClass) throws {}
}

#if os(iOS)
/// iOS data protection. A folder's class is the default for files created in it.
public struct SystemFileProtection: FileProtecting {
    public init() {}
    public func protect(_ url: URL, _ protection: ProtectionClass) throws {
        let type: FileProtectionType = switch protection {
        case .completeUnlessOpen: .completeUnlessOpen
        case .complete: .complete
        case .untilFirstUnlock: .completeUntilFirstUserAuthentication
        }
        try FileManager.default.setAttributes([.protectionKey: type], ofItemAtPath: url.path(percentEncoded: false))
    }
}
#endif

/// Why a recording's file ended.
public enum RecordingEnd: String, Sendable, Codable {
    /// « Arrêter ».
    case stopped
    /// A call, Siri, an alarm, another app's microphone: the session was interrupted.
    case interruption
    /// The microphone changed (a headset connected): the next file goes on.
    case route
    /// The file reached 3 hours; the next one goes on with no sample lost.
    case rotation
    /// Less than 200 MB left: stopped cleanly.
    case lowSpace = "low-space"
    /// The file could not be written (the disk filled up, the encoder failed).
    case writeFailed = "write-failed"
    /// The app was killed, crashed, or the battery died: found at the next launch.
    case killed
}

/// One line of a recording's `events.log`: what happened to it, appended.
/// It holds no name and no word: times, sample counts, reasons.
public struct RecordingEvent: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case started, ended, progress
    }

    public var kind: Kind
    public var atMs: Int64
    /// `started`: the header, as the file's comment tag holds it.
    public var header: String?
    /// `ended`, `progress`: samples written to the file so far.
    public var samples: Int?
    /// `ended`: why.
    public var end: RecordingEnd?

    public init(kind: Kind, atMs: Int64, header: String? = nil, samples: Int? = nil, end: RecordingEnd? = nil) {
        self.kind = kind
        self.atMs = atMs
        self.header = header
        self.samples = samples
        self.end = end
    }
}

/// `events.log`, held open while its file records, each line synced to disk:
/// after a kill it says what happened up to then.
public final class EventLog: @unchecked Sendable {
    private let handle: FileHandle
    private let lock = NSLock()

    init(url: URL) throws {
        if !FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) {
            guard FileManager.default.createFile(atPath: url.path(percentEncoded: false), contents: nil) else {
                throw CocoaError(.fileWriteUnknown)
            }
        }
        handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
    }

    public func append(_ event: RecordingEvent) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var line = try encoder.encode(event)
        line.append(0x0A)
        try lock.withLock {
            try handle.write(contentsOf: line)
            try handle.synchronize()
        }
    }

    public func close() {
        lock.withLock { try? handle.close() }
    }

    static func read(_ url: URL) -> [RecordingEvent] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        let decoder = JSONDecoder()
        // A kill may cut the last line: what parses is kept.
        return data.split(separator: 0x0A).compactMap { try? decoder.decode(RecordingEvent.self, from: Data($0)) }
    }
}

/// One recording's folder: `recordings/<recordingId>/` (ADR 008).
public struct RecordingFolder: Sendable, Equatable {
    public let id: UUID
    public let url: URL
    public var audio: URL { url.appending(path: "audio.m4a") }
    public var events: URL { url.appending(path: "events.log") }
    public var state: URL { url.appending(path: "state.json") }
    /// The Mac's result for this recording, once fetched (M5.3).
    public var result: URL { url.appending(path: "result.json") }
}

/// Where a recording stands with the paired Mac, kept in its `state.json`.
public struct RecordingSync: Codable, Equatable, Sendable {
    /// Bytes the Mac holds of the file, as it last said.
    public var sentBytes: Int64 = 0
    /// The file's length and SHA-256 when it was last announced (a closed file does not change).
    public var bytes: Int64?
    public var sha256: String?
    /// The Mac's state, as `states` or the upload last said.
    public var mac: MacRecordingState?
    /// The Mac answered `stored`, and the audio left the phone.
    public var stored: Bool = false
    /// The Mac holds another recording under this id: the phone keeps its file (« Conflit »).
    public var conflict: Bool = false
    /// The Mac will never take this file.
    public var refused: RecordingRefusal?

    public init() {}
}

/// The Mac's result for a recording, as `result.json` keeps it (« complete »).
public struct StoredResult: Codable, Equatable, Sendable {
    /// The Mac's revision of it: sent back with `get`, which answers « unchanged » while it holds.
    public var revision: String
    public var fetchedAtMs: Int64
    public var result: PhoneResult

    public init(revision: String, fetchedAtMs: Int64, result: PhoneResult) {
        self.revision = revision
        self.fetchedAtMs = fetchedAtMs
        self.result = result
    }
}

/// What the user and the app keep about a recording once the phone is unlocked.
struct RecordingState: Codable, Equatable {
    /// The user's name for it; null shows its hour.
    var name: String?
    /// When the name was typed (also for a name cleared): of two names, the later one typed wins on the Mac.
    var nameTypedAtMs: Int64?
    /// The typed time of the last name the Mac acknowledged.
    var nameSentTypedAtMs: Int64?
    /// The revision of `result.json`, read without opening it.
    var resultRevision: String?
    /// It ended by a kill, found at launch, and the app has not said so yet.
    var killNoticePending: Bool = false
    /// Its files went to « complete » protection once closed.
    var sealed: Bool = false
    var sync: RecordingSync?
}

/// A recording as the list shows it.
public struct StoredRecording: Sendable, Equatable, Identifiable {
    public let id: UUID
    public let header: PhoneRecordingHeader
    public let folder: RecordingFolder
    public var name: String?
    /// When its name was typed; nil when it never was (a name from before M5.3 counts from its start).
    public var nameTypedAtMs: Int64?
    /// The typed time of the last name the Mac acknowledged.
    public var nameSentTypedAtMs: Int64?
    /// The revision of the Mac's result the phone holds; nil without one.
    public var resultRevision: String?
    /// Null while it records.
    public var end: RecordingEnd?
    /// Samples the file holds as far as its log knows (after a kill: the last progress line).
    public var samples: Int?
    public var endedAtMs: Int64?
    /// The audio file's size; 0 once the Mac holds it and the phone erased it.
    public var bytes: Int64
    public var killNoticePending: Bool
    public var sync: RecordingSync
    /// The phone still holds its audio.
    public var hasAudio: Bool
    /// Still being recorded: never sent.
    public var isOpen: Bool { end == nil }

    public var startedAtMs: Int64 { header.startedWallMs }
    /// When its current name (or its clearing) was typed, as the Mac is told.
    public var effectiveNameTypedAtMs: Int64? { nameTypedAtMs ?? (name == nil ? nil : startedAtMs) }
    /// A name typed that the Mac has not acknowledged.
    public var nameUnsent: Bool {
        guard let typed = effectiveNameTypedAtMs else { return false }
        return typed > (nameSentTypedAtMs ?? Int64.min)
    }
    /// Its length in ms, as far as its log knows.
    public var durationMs: Int64? { samples.map { Int64($0) * 1000 / Int64(phoneSampleRate) } }
}

public enum RecordingStoreError: Error, Equatable {
    case missing
    case unreadableHeader
}

/// The phone's recordings: no database, one folder each (ADR 008), excluded
/// from backup. The folder being recorded is « complete unless open », so a
/// locked phone keeps writing it and can start the next file; everything is
/// « complete » once closed.
public final class RecordingStore: Sendable {
    public let root: URL
    private let protection: any FileProtecting
    /// Every read-modify-write of a `state.json`: the recorder, the screens and the sync touch them.
    private let stateLock = NSLock()

    /// `root`: `Application Support/Sondine/recordings`.
    public init(root: URL, protection: any FileProtecting = NoFileProtection()) throws {
        self.root = root
        self.protection = protection
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var excluded = root
        try excluded.setResourceValues(values)
    }

    public func folder(_ id: UUID) -> RecordingFolder {
        RecordingFolder(id: id, url: root.appending(path: id.uuidString.lowercased()))
    }

    /// Creates a recording's folder and opens its log with a `started` line.
    public func create(_ header: PhoneRecordingHeader, atMs: Int64) throws -> (RecordingFolder, EventLog) {
        let folder = folder(header.recordingId)
        try FileManager.default.createDirectory(at: folder.url, withIntermediateDirectories: false)
        // New files take the folder's class: writable while locked as long as they stay open.
        try protection.protect(folder.url, .completeUnlessOpen)
        let log = try EventLog(url: folder.events)
        try log.append(RecordingEvent(kind: .started, atMs: atMs, header: try header.json()))
        return (folder, log)
    }

    /// Every recording, newest first.
    public func list() -> [StoredRecording] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path(percentEncoded: false))) ?? []
        return names.compactMap { name in UUID(uuidString: name).flatMap { read(folder($0)) } }
            .sorted { ($0.startedAtMs, $0.header.part) > ($1.startedAtMs, $1.header.part) }
    }

    public func recording(_ id: UUID) -> StoredRecording? { read(folder(id)) }

    func read(_ folder: RecordingFolder) -> StoredRecording? {
        let events = EventLog.read(folder.events)
        guard let text = events.first(where: { $0.kind == .started })?.header,
              let header = try? PhoneRecordingHeader.decode(text)
        else { return nil }
        let ended = events.last(where: { $0.kind == .ended })
        let progress = events.last(where: { $0.kind == .progress })
        let state = stateLock.withLock { readState(folder) }
        let size = (try? FileManager.default.attributesOfItem(atPath: folder.audio.path(percentEncoded: false))[.size] as? Int64)
        return StoredRecording(
            id: header.recordingId, header: header, folder: folder, name: state.name,
            nameTypedAtMs: state.nameTypedAtMs, nameSentTypedAtMs: state.nameSentTypedAtMs,
            resultRevision: FileManager.default.fileExists(atPath: folder.result.path(percentEncoded: false))
                ? state.resultRevision : nil,
            end: ended?.end, samples: ended?.samples ?? progress?.samples, endedAtMs: ended?.atMs,
            bytes: size ?? 0, killNoticePending: state.killNoticePending, sync: state.sync ?? RecordingSync(),
            hasAudio: size != nil)
    }

    private func readState(_ folder: RecordingFolder) -> RecordingState {
        guard let data = try? Data(contentsOf: folder.state),
              let state = try? JSONDecoder().decode(RecordingState.self, from: data)
        else { return RecordingState() }
        return state
    }

    private func writeState(_ state: RecordingState, _ folder: RecordingFolder) throws {
        try JSONEncoder().encode(state).write(to: folder.state, options: .atomic)
        try protection.protect(folder.state, .complete)
    }

    /// Reads, changes and writes a recording's state under the store's lock.
    private func mutateState(_ folder: RecordingFolder, _ change: (inout RecordingState) throws -> Void) throws {
        try stateLock.withLock {
            var state = readState(folder)
            try change(&state)
            try writeState(state, folder)
        }
    }

    /// At launch and when the app comes back, unlocked: a recording whose log
    /// has no end and that is not being recorded was cut by a kill. Its log
    /// gets `ended: killed`, the app says so once, and closed files go to
    /// « complete ». Returns the recordings found killed.
    @discardableResult
    public func reconcile(recording active: Set<UUID>, nowMs: Int64) -> [StoredRecording] {
        var killed: [StoredRecording] = []
        for recording in list() where !active.contains(recording.id) {
            try? mutateState(recording.folder) { state in
                if recording.end == nil {
                    if let log = try? EventLog(url: recording.folder.events) {
                        try? log.append(RecordingEvent(kind: .ended, atMs: nowMs, samples: recording.samples, end: .killed))
                        log.close()
                    }
                    state.killNoticePending = true
                    killed.append(recording)
                }
                if !state.sealed {
                    try? protection.protect(recording.folder.audio, .complete)
                    try? protection.protect(recording.folder.events, .complete)
                    try? protection.protect(recording.folder.url, .complete)
                    state.sealed = true
                }
            }
        }
        return killed.compactMap { self.recording($0.id) }
    }

    /// The name as kept and sent: trimmed, without control characters, at most 200 UTF-16 units; nil when blank.
    public static func cleanName(_ name: String?) -> String? {
        guard let name else { return nil }
        let printable = String(String.UnicodeScalarView(name.unicodeScalars.map { $0.value < 0x20 || $0.value == 0x7F ? " " : $0 }))
        let trimmed = printable.trimmingCharacters(in: .whitespacesAndNewlines)
        var cut = ""
        for character in trimmed where cut.utf16.count + String(character).utf16.count <= 200 { cut.append(character) }
        let clean = cut.trimmingCharacters(in: .whitespacesAndNewlines)
        return clean.isEmpty ? nil : clean
    }

    /// Renames it; `typedAtMs` is when, for the Mac. Returns whether the name changed.
    @discardableResult
    public func rename(_ id: UUID, to name: String?, typedAtMs: Int64? = nil) throws -> Bool {
        let folder = folder(id)
        guard read(folder) != nil else { throw RecordingStoreError.missing }
        let clean = Self.cleanName(name)
        var changed = false
        try mutateState(folder) {
            changed = $0.name != clean
            guard changed else { return }
            $0.name = clean
            if let typedAtMs { $0.nameTypedAtMs = typedAtMs }
        }
        return changed
    }

    /// The Mac acknowledged the name typed at this time.
    public func nameSent(_ id: UUID, typedAtMs: Int64) throws {
        try mutateState(folder(id)) { $0.nameSentTypedAtMs = max($0.nameSentTypedAtMs ?? typedAtMs, typedAtMs) }
    }

    /// The app said a kill happened.
    public func noticeSeen(_ id: UUID) throws {
        try mutateState(folder(id)) { $0.killNoticePending = false }
    }

    /// Changes what the phone knows of a recording's place on the Mac.
    public func updateSync(_ id: UUID, _ change: (inout RecordingSync) -> Void) throws {
        let folder = folder(id)
        guard FileManager.default.fileExists(atPath: folder.events.path(percentEncoded: false)) else {
            throw RecordingStoreError.missing
        }
        try mutateState(folder) { state in
            var sync = state.sync ?? RecordingSync()
            change(&sync)
            state.sync = sync
        }
    }

    /// The Mac answered `stored`: the audio leaves the phone; the folder, its log and state stay.
    public func eraseAudio(_ id: UUID) throws {
        try updateSync(id) {
            $0.stored = true
            $0.sentBytes = $0.bytes ?? $0.sentBytes
            if $0.mac == nil || $0.mac == .unknown || $0.mac == .receiving { $0.mac = .waiting }
        }
        let audio = folder(id).audio
        if FileManager.default.fileExists(atPath: audio.path(percentEncoded: false)) {
            try FileManager.default.removeItem(at: audio)
        }
    }

    /// Keeps the Mac's result (« complete »): `result.json` first, then its revision in `state.json`.
    public func writeResult(_ id: UUID, _ result: StoredResult) throws {
        let folder = folder(id)
        guard FileManager.default.fileExists(atPath: folder.events.path(percentEncoded: false)) else {
            throw RecordingStoreError.missing
        }
        try JSONEncoder().encode(result).write(to: folder.result, options: .atomic)
        try protection.protect(folder.result, .complete)
        try mutateState(folder) { $0.resultRevision = result.revision }
    }

    /// Whether a recording started too long before the latest time seen to keep its result.
    public static func resultExpired(startedAtMs: Int64, latestSeenMs: Int64) -> Bool {
        startedAtMs < latestSeenMs - PhoneSync.resultKeptMs
    }

    /// The Mac's result, unless the recording is older than 30 days before
    /// the latest time seen: then it is erased, and nil.
    public func result(_ id: UUID, latestSeenMs: Int64) -> StoredResult? {
        guard let recording = recording(id) else { return nil }
        if Self.resultExpired(startedAtMs: recording.startedAtMs, latestSeenMs: latestSeenMs) {
            eraseResult(id)
            return nil
        }
        guard let data = try? Data(contentsOf: recording.folder.result) else { return nil }
        return try? JSONDecoder().decode(StoredResult.self, from: data)
    }

    /// At launch: erases the results of recordings made more than 30 days before the latest time seen,
    /// by the file itself (a kill between writing it and its revision leaves one without).
    @discardableResult
    public func expireResults(latestSeenMs: Int64) -> [UUID] {
        list().filter {
            Self.resultExpired(startedAtMs: $0.startedAtMs, latestSeenMs: latestSeenMs)
                && FileManager.default.fileExists(atPath: $0.folder.result.path(percentEncoded: false))
        }
        .map { recording in
            eraseResult(recording.id)
            return recording.id
        }
    }

    /// Erases a recording's result, and its revision with it.
    public func eraseResult(_ id: UUID) {
        let folder = folder(id)
        guard FileManager.default.fileExists(atPath: folder.result.path(percentEncoded: false)) else { return }
        try? FileManager.default.removeItem(at: folder.result)
        try? mutateState(folder) { $0.resultRevision = nil }
    }

    /// Erases every result fetched from the Mac (a revoked or forgotten Mac).
    public func eraseResults() {
        for recording in list() { eraseResult(recording.id) }
    }

    /// « Supprimer… » on the phone: the folder goes.
    public func delete(_ id: UUID) throws {
        let folder = folder(id)
        guard FileManager.default.fileExists(atPath: folder.url.path(percentEncoded: false)) else {
            throw RecordingStoreError.missing
        }
        try FileManager.default.removeItem(at: folder.url)
    }

    /// Room the recordings take, in bytes.
    public func bytes() -> Int64 { list().reduce(0) { $0 + $1.bytes } }
}
