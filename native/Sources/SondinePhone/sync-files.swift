import Foundation
import Security
import Synchronization

// What the phone keeps for sync (ADR 008, « What the phone keeps »): no
// database. `device.json` (the device id, the paired Mac's id and pin, the
// latest time seen), the credential in the Keychain, and
// `outbox/<operationId>.json`. All of them « complete »: written and read
// with the phone unlocked only. The device id also has its own file,
// `device-id`, readable from the first unlock: a recording started from the
// Lock Screen writes it in its header (M5.6).

/// The Mac this phone paired with.
public struct PairedMac: Codable, Equatable, Sendable {
    public var macId: UUID
    /// SHA-256 of the Mac's TLS key (SubjectPublicKeyInfo, DER), lowercase hex: the only thing trusted.
    public var pin: String
    /// The service's name from the QR (« Sondine K7Q2 »).
    public var name: String
    public var port: Int
    /// Addresses to try when Bonjour finds nothing: from the QR, then each `hello`.
    public var addrs: [String]
    public var pairedAtMs: Int64
    /// The last answer from it, and the last sync that went to its end.
    public var lastSeenMs: Int64?
    public var lastSyncMs: Int64?

    public init(macId: UUID, pin: String, name: String, port: Int, addrs: [String], pairedAtMs: Int64) {
        self.macId = macId
        self.pin = pin
        self.name = name
        self.port = port
        self.addrs = addrs
        self.pairedAtMs = pairedAtMs
    }
}

/// Why the phone is no longer paired, said once on « Mac ».
public struct LostMac: Codable, Equatable, Sendable {
    public var name: String
    public var atMs: Int64
}

/// `device.json`: the app's random install id, and the Mac it paired with.
public struct DeviceFile: Codable, Equatable, Sendable {
    public var deviceId: UUID
    public var mac: PairedMac?
    /// Set when the Mac revoked this phone; cleared by the next pairing.
    public var revokedBy: LostMac?
    /// The last Mac this phone paired with: an outbox kept for it is dropped when another one pairs.
    public var lastMacId: UUID?
    /// The latest time the phone has seen, its own clock's or the Mac's: the 30 days of results
    /// count back from it, so a clock set back does not extend them.
    public var latestSeenMs: Int64?
    /// The Mac's tags, the latest used first, as its last sync said (ADR 039): offered offline.
    public var macTags: [String]?

    public init(deviceId: UUID) { self.deviceId = deviceId }
}

/// Reads a file, telling a missing one from one the phone keeps locked.
public protocol FileReading: Sendable {
    /// nil when there is no such file; throws `FileLocked` when it exists but
    /// cannot be read now (« complete » files while the phone is locked).
    func read(_ url: URL) throws(FileLocked) -> Data?
}

public struct FileLocked: Error, Equatable {
    public init() {}
}

public struct SystemFileReader: FileReading {
    public init() {}
    public func read(_ url: URL) throws(FileLocked) -> Data? {
        guard FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) else { return nil }
        do {
            return try Data(contentsOf: url)
        } catch {
            throw FileLocked()
        }
    }
}

/// Reads and writes `device.json` (« complete ») and `device-id`
/// (readable from the first unlock). Nothing read while the phone is locked
/// is made up and kept: the id stays unknown, the pairing unread, until
/// they can be read.
public final class DeviceStore: Sendable {
    public let url: URL
    public let idURL: URL
    private let protection: any FileProtecting
    private let reader: any FileReading
    private let lock = Mutex<(file: DeviceFile?, id: UUID?)>((nil, nil))

    /// `root`: `Application Support/Sondine`.
    public init(root: URL, protection: any FileProtecting = NoFileProtection(), reader: any FileReading = SystemFileReader()) {
        url = root.appending(path: "device.json")
        idURL = root.appending(path: "device-id")
        self.protection = protection
        self.reader = reader
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    /// The app's random install id, in every recording's header; made at the
    /// first launch. nil only before the first unlock after a restart, or
    /// while the phone is locked on the first launch of a version older
    /// installs updated from (the id was then in `device.json` alone).
    public var deviceId: UUID? {
        lock.withLock { cached in
            if let id = cached.id { return id }
            guard let id = loadId() else { return nil }
            cached.id = id
            return id
        }
    }

    /// `device.json`. While the phone keeps it locked: not paired, with the
    /// id when known, and nothing cached; `update` then refuses.
    public var file: DeviceFile {
        lock.withLock { cached in
            if let file = cached.file { return file }
            let id = cached.id ?? loadId()
            cached.id = id
            let read: Data?
            do {
                read = try reader.read(url)
            } catch {
                return DeviceFile(deviceId: id ?? UUID())
            }
            var file = read.flatMap { try? JSONDecoder().decode(DeviceFile.self, from: $0) }
                ?? DeviceFile(deviceId: id ?? UUID())
            if let id { file.deviceId = id }
            if read == nil { try? write(file) }
            cached.file = file
            return file
        }
    }

    public func update(_ change: (inout DeviceFile) -> Void) throws {
        _ = file
        try lock.withLock { cached in
            guard var file = cached.file else { throw FileLocked() }
            change(&file)
            try write(file)
            cached.file = file
        }
    }

    /// `device-id`, else the id `device.json` holds (written to `device-id`
    /// once read), else a new one when neither exists. nil when what holds it
    /// cannot be read, or the id cannot be written, now.
    private func loadId() -> UUID? {
        do {
            if let data = try reader.read(idURL),
               let id = UUID(uuidString: String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)) {
                return id
            }
            let id = try reader.read(url).flatMap { try? JSONDecoder().decode(DeviceFile.self, from: $0) }?.deviceId
                ?? UUID()
            // An id that could not be kept would change at the next launch.
            try writeId(id)
            return id
        } catch {
            return nil
        }
    }

    private func writeId(_ id: UUID) throws {
        try Data(id.uuidString.lowercased().utf8).write(to: idURL, options: .atomic)
        try protection.protect(idURL, .untilFirstUnlock)
    }

    private func write(_ file: DeviceFile) throws {
        try JSONEncoder().encode(file).write(to: url, options: .atomic)
        try protection.protect(url, .complete)
    }

    /// How far the kept time may lag behind: it is written at most once a minute.
    static let seenStepMs: Int64 = 60_000

    /// The latest time seen, after `nowMs` (a clock's, or the Mac's): never moves back.
    @discardableResult
    public func seen(_ nowMs: Int64) -> Int64 {
        let kept = file.latestSeenMs
        if let kept, nowMs < kept + Self.seenStepMs { return max(kept, nowMs) }
        // Locked, the file cannot be written: the time is kept at the next chance.
        try? update { $0.latestSeenMs = max($0.latestSeenMs ?? nowMs, nowMs) }
        return max(kept ?? nowMs, nowMs)
    }
}

/// The device credential (`sdp_…`): in the Keychain on the phone, in memory in tests.
public protocol CredentialStoring: Sendable {
    func read() -> String?
    func write(_ credential: String) throws
    func erase()
}

public final class MemoryCredentials: CredentialStoring {
    private let value = Mutex<String?>(nil)
    public init(_ credential: String? = nil) { value.withLock { $0 = credential } }
    public func read() -> String? { value.withLock { $0 } }
    public func write(_ credential: String) throws { value.withLock { $0 = credential } }
    public func erase() { value.withLock { $0 = nil } }
}

public enum KeychainError: Error, Equatable {
    case status(OSStatus)
}

/// The Keychain, `WhenUnlockedThisDeviceOnly`: never synced, never restored on another device.
public struct KeychainCredentials: CredentialStoring {
    private let service: String
    private let account = "mac-credential"

    public init(service: String = "app.sondine.ios.sync") { self.service = service }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: account, kSecUseDataProtectionKeychain as String: true]
    }

    public func read() -> String? {
        var item: CFTypeRef?
        var search = query
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        guard SecItemCopyMatching(search as CFDictionary, &item) == errSecSuccess, let data = item as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    public func write(_ credential: String) throws {
        erase()
        var item = query
        item[kSecValueData as String] = Data(credential.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.status(status) }
    }

    public func erase() { SecItemDelete(query as CFDictionary) }
}

/// One operation the Mac has not acknowledged: `outbox/<operationId>.json`.
/// Its id goes with every try, so the Mac does it once.
public struct OutboxOperation: Codable, Equatable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable {
        case delete, rename, note, tag, voice
    }

    public var operationId: UUID
    public var kind: Kind
    public var recordingId: UUID
    public var atMs: Int64
    /// `rename`: the name (nil: back to the hour), and when it was typed.
    public var name: String?
    public var typedAtMs: Int64?
    /// `note`: its text.
    public var text: String?
    /// `tag` (ADR 039): put on (true) or taken off; its name is `name`.
    public var on: Bool?
    /// `voice` (ADR 039): the voice the user said is theirs (« C'est moi »), and one of its sentences.
    public var ordinal: Int?
    public var sentenceId: Int?
    public var id: UUID { operationId }

    public init(operationId: UUID = UUID(), kind: Kind, recordingId: UUID, atMs: Int64) {
        self.operationId = operationId
        self.kind = kind
        self.recordingId = recordingId
        self.atMs = atMs
    }

    public static func rename(_ recordingId: UUID, to name: String?, typedAtMs: Int64) -> OutboxOperation {
        var operation = OutboxOperation(kind: .rename, recordingId: recordingId, atMs: typedAtMs)
        operation.name = name
        operation.typedAtMs = typedAtMs
        return operation
    }

    public static func note(_ recordingId: UUID, text: String, atMs: Int64) -> OutboxOperation {
        var operation = OutboxOperation(kind: .note, recordingId: recordingId, atMs: atMs)
        operation.text = text
        return operation
    }

    public static func tag(_ recordingId: UUID, name: String, on: Bool, atMs: Int64) -> OutboxOperation {
        var operation = OutboxOperation(kind: .tag, recordingId: recordingId, atMs: atMs)
        operation.name = name
        operation.on = on
        return operation
    }

    public static func voice(_ recordingId: UUID, ordinal: Int, sentenceId: Int, atMs: Int64) -> OutboxOperation {
        var operation = OutboxOperation(kind: .voice, recordingId: recordingId, atMs: atMs)
        operation.ordinal = ordinal
        operation.sentenceId = sentenceId
        return operation
    }

    /// A `tag` operation's key: two operations on one recording with the same key are one choice.
    public var tagKey: String? {
        guard kind == .tag, let name else { return nil }
        return TagName.key(TagName.clean(name) ?? name)
    }
}

/// Deletions, names, notes, tags and « C'est moi » the Mac has not
/// acknowledged. Written first: a deletion's file exists before its folder
/// goes, and at launch a deletion without its removal is finished. A deletion
/// beats any other operation on its recording; of two names, the later one
/// typed stays; of two tags with one key on a recording, the later one stays,
/// written before the earlier goes (ADR 039).
public final class Outbox: Sendable {
    public let root: URL
    private let protection: any FileProtecting

    /// `root`: `Application Support/Sondine/outbox`.
    public init(root: URL, protection: any FileProtecting = NoFileProtection()) throws {
        self.root = root
        self.protection = protection
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var excluded = root
        try excluded.setResourceValues(values)
    }

    private func url(_ id: UUID) -> URL { root.appending(path: "\(id.wire).json") }

    /// Oldest first.
    public func all() -> [OutboxOperation] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path(percentEncoded: false))) ?? []
        return names.filter { $0.hasSuffix(".json") }
            .compactMap { try? JSONDecoder().decode(OutboxOperation.self, from: Data(contentsOf: root.appending(path: $0))) }
            .sorted { ($0.atMs, $0.operationId.wire) < ($1.atMs, $1.operationId.wire) }
    }

    public func add(_ operation: OutboxOperation) throws {
        let mine = all().filter { $0.recordingId == operation.recordingId && $0.operationId != operation.operationId }
        switch operation.kind {
        case .delete:
            // A deletion beats any other operation on its recording.
            for other in mine where other.kind != .delete { remove(other.operationId) }
        case .rename, .note, .tag, .voice:
            // Nothing more for a recording being deleted.
            if mine.contains(where: { $0.kind == .delete }) { return }
            if operation.kind == .rename {
                let typed = operation.typedAtMs ?? operation.atMs
                let names = mine.filter { $0.kind == .rename }
                // A later name already waits: this one is lost anyway.
                if names.contains(where: { ($0.typedAtMs ?? $0.atMs) > typed }) { return }
                for other in names { remove(other.operationId) }
            }
        }
        let file = url(operation.operationId)
        try JSONEncoder().encode(operation).write(to: file, options: .atomic)
        try protection.protect(file, .complete)
        // The same tag chosen again replaces what still waits, once this one is written.
        if let key = operation.tagKey {
            for other in mine where other.tagKey == key { remove(other.operationId) }
        }
    }

    /// The Mac acknowledged it.
    public func remove(_ id: UUID) {
        try? FileManager.default.removeItem(at: url(id))
    }

    /// « Oublier ce Mac »: how many were dropped.
    @discardableResult
    public func removeAll() -> Int {
        let operations = all()
        for operation in operations { remove(operation.operationId) }
        return operations.count
    }

    /// « Supprimer » once paired: the deletion is written, then the folder goes.
    public func delete(_ recordingId: UUID, from store: RecordingStore, atMs: Int64) throws {
        if !all().contains(where: { $0.kind == .delete && $0.recordingId == recordingId }) {
            try add(OutboxOperation(kind: .delete, recordingId: recordingId, atMs: atMs))
        }
        try store.delete(recordingId)
    }

    /// At launch: a deletion whose folder is still there (the app was killed between the two) is finished.
    @discardableResult
    public func finishDeletions(in store: RecordingStore) -> [UUID] {
        all().filter { $0.kind == .delete }.compactMap { operation in
            (try? store.delete(operation.recordingId)) == nil ? nil : operation.recordingId
        }
    }
}
