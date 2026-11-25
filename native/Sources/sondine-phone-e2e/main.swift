import CryptoKit
import Foundation
import SondinePhone

// The iPhone's side of the end-to-end sync test (`pnpm test:native`,
// apps/desktop/test/phone-sync-e2e.test.ts): SondinePhone's real sync client
// and URLSession transport, pinned TLS included, against the real
// `sondine-lan` and core. The test drives it with one JSON command per line on
// stdin; each answer is one JSON line on stdout.
//
//   sondine-phone-e2e --root <dir> --mac <host:port>
//
// --mac is where every request goes (the test's cutting proxy in front of the
// relay), as a finder would have found it. Commands: device, add, pair, sync,
// list, delete, state (with the path of the last sync, M5.5), find (Bonjour,
// as the app browses), and from M5.3
// result {id} (the result as the phone keeps it), rename {id, name|null},
// note {id, text}, audio {id, generation, from, to} (a byte range read as
// the app's player reads it, by requests of at most 1 MiB), and from M5.4
// the live reads of the Mac's memory as the app's screens read them: search
// {text, offset?}, day {day}, journal {day}, commitments, conversation
// {episodeId}, each answering the Mac's answer as JSON; time-search {text,
// count} (each search's milliseconds, through the whole client: TLS, relay,
// core); files (every file under --root with its size and time).

func argument(_ name: String) -> String? {
    let arguments = CommandLine.arguments
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("sondine-phone-e2e: \(message)\n".utf8))
    exit(2)
}

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
        fail("cannot encode an answer")
    }
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

/// Always the one address the test gives: where the app's finder would have found the Mac.
struct GivenFinder: MacFinding {
    let endpoint: MacEndpoint
    func find(pin: String, known: [MacEndpoint]) async -> [MacEndpoint] { [endpoint] }
    /// The proxy is both paths: the test switches it between home and the tunnel.
    func findTunnel(pin: String, known: [MacEndpoint]) async -> [MacEndpoint] { [] }
}

guard let rootPath = argument("--root"), let mac = argument("--mac"),
      let colon = mac.lastIndex(of: ":"), let port = Int(mac[mac.index(after: colon)...])
else { fail("usage: --root <dir> --mac <host:port>") }
let endpoint = MacEndpoint(host: String(mac[..<colon]), port: port)
let root = URL(filePath: rootPath)
let store: RecordingStore
let outbox: Outbox
do {
    store = try RecordingStore(root: root.appending(path: "recordings"))
    outbox = try Outbox(root: root.appending(path: "outbox"))
} catch {
    fail("cannot open the store: \(error)")
}
let device = DeviceStore(root: root)
let credentials = MemoryCredentials()
var configuration = PhoneSyncClient.Configuration(deviceName: "iPhone de Téo")
// « No room » on the Mac waits for the next pass here, not 15 minutes.
configuration.fullBackoffMs = 0
let client = PhoneSyncClient(
    store: store, outbox: outbox, device: device, credentials: credentials, transport: URLSessionTransport(),
    finder: GivenFinder(endpoint: endpoint), configuration: configuration)
let memory = MacMemory(client: client)

func outcomeName(_ outcome: PhoneSyncClient.Outcome) -> String {
    switch outcome {
    case .notPaired: "not-paired"
    case .alreadyRunning: "already-running"
    case .unreachable: "unreachable"
    case .done: "done"
    case .revoked: "revoked"
    case .stopped(.busy): "busy"
    case .stopped(.macFull): "mac-full"
    case .stopped(.version): "version"
    case .cancelled: "cancelled"
    }
}

func recordingJson(_ recording: StoredRecording) -> [String: Any] {
    [
        "id": recording.id.wire, "hasAudio": recording.hasAudio, "bytes": recording.bytes,
        "stored": recording.sync.stored, "conflict": recording.sync.conflict,
        "sentBytes": recording.sync.sentBytes, "mac": recording.sync.mac?.rawValue ?? NSNull(),
        "sha256": recording.sync.sha256 ?? NSNull(), "refused": recording.sync.refused?.rawValue ?? NSNull(),
        "hasResult": recording.resultRevision != nil, "revision": recording.resultRevision ?? NSNull(),
        "name": recording.name ?? NSNull(),
    ]
}

func recordingId(_ command: [String: Any]) -> UUID? { (command["id"] as? String).flatMap(UUID.init(uuidString:)) }

func hexDigest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

/// A memory read as the screens get it: the Mac's answer as JSON, or why there is none.
func memoryJson<Value>(_ read: MemoryRead<Value>, _ answer: (Value) -> some Encodable) throws -> [String: Any] {
    switch read {
    case let .read(value):
        return ["answer": try JSONSerialization.jsonObject(with: try JSONEncoder().encode(answer(value)))]
    case .notPaired: return ["error": "not paired"]
    case .unreachable: return ["error": "unreachable"]
    case .withheld: return ["error": "withheld"]
    case .gone: return ["answer": ["status": "gone"]]
    case let .refused(code): return ["error": "refused: \(code.rawValue)"]
    }
}

/// Every file under the phone's folder, with its size and modification time.
func filesUnder(_ root: URL) -> [String: String] {
    var found: [String: String] = [:]
    let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
    guard let walk = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys) else { return found }
    for case let url as URL in walk {
        guard let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { continue }
        found[url.path(percentEncoded: false)] =
            "\(values.fileSize ?? -1) \(values.contentModificationDate?.timeIntervalSince1970 ?? -1)"
    }
    return found
}

func run(_ command: [String: Any]) async throws -> [String: Any] {
    switch command["cmd"] as? String {
    case "device":
        return ["deviceId": device.file.deviceId.wire]
    case "add":
        // A file `sondine-phone-fixture` wrote, given its header: a finished recording, as the recorder leaves one.
        guard let file = command["file"] as? String, let text = command["header"] as? String else {
            return ["error": "add needs file and header"]
        }
        let header = try PhoneRecordingHeader.decode(text)
        let (folder, log) = try store.create(header, atMs: header.startedWallMs)
        try FileManager.default.moveItem(at: URL(filePath: file), to: folder.audio)
        try log.append(RecordingEvent(kind: .ended, atMs: SystemClock().nowMs(), end: .stopped))
        log.close()
        return ["recordingId": header.recordingId.wire]
    case "pair":
        guard let url = command["url"] as? String, case let .invite(invite) = PairingInvite.scan(url) else {
            return ["error": "not an invite"]
        }
        emit(["event": "digits", "digits": pairingDigits(token: invite.token, deviceId: device.file.deviceId, pin: invite.pin)])
        do {
            let paired = try await client.pair(invite)
            return ["macId": paired.macId.wire, "pin": paired.pin]
        } catch {
            return ["error": "\(error)"]
        }
    case "sync":
        return ["outcome": outcomeName(await client.sync())]
    case "list":
        return ["recordings": store.list().map(recordingJson)]
    case "delete":
        guard let id = (command["id"] as? String).flatMap(UUID.init(uuidString:)) else { return ["error": "bad id"] }
        try await client.delete(id)
        return ["outbox": outbox.all().count]
    case "result":
        guard let id = recordingId(command) else { return ["error": "bad id"] }
        guard let kept = store.result(id, latestSeenMs: await client.latestSeenMs()) else {
            return ["revision": NSNull(), "result": NSNull()]
        }
        let json = try JSONSerialization.jsonObject(with: try JSONEncoder().encode(kept.result))
        return ["revision": kept.revision, "result": json]
    case "rename":
        guard let id = recordingId(command) else { return ["error": "bad id"] }
        try await client.rename(id, to: command["name"] as? String)
        return ["outbox": outbox.all().count, "name": store.recording(id)?.name ?? NSNull()]
    case "note":
        guard let id = recordingId(command), let text = command["text"] as? String else { return ["error": "note needs id and text"] }
        guard try await client.addNote(id, text: text) else { return ["error": "not paired, blank, or no such recording"] }
        return ["outbox": outbox.all().count]
    case "audio":
        guard let id = recordingId(command), let generation = command["generation"] as? Int,
              let from = (command["from"] as? NSNumber)?.int64Value, let to = (command["to"] as? NSNumber)?.int64Value,
              from <= to
        else { return ["error": "audio needs id, generation, from, to"] }
        let reader = RemoteAudioReader { range in await client.audio(id, generation: generation, range: range) }
        var bytes = Data()
        let read = await reader.read(from: from, length: to - from + 1) { piece, _ in
            bytes.append(piece)
            return true
        }
        switch read {
        case let .success(total):
            return ["status": 206, "total": total, "bytes": bytes.count, "sha256": hexDigest(bytes)]
        case let .failure(.failed(.refused(status, code))):
            return ["status": status, "refusal": code.rawValue]
        case .failure(.failed(.notPaired)):
            return ["error": "not paired"]
        case .failure:
            return ["error": "unreachable"]
        }
    case "state":
        let status = await client.status
        return [
            "paired": status.mac != nil, "credential": credentials.read() != nil,
            "revoked": status.revokedBy != nil, "outbox": outbox.all().count,
            "deviceFileMac": device.file.mac != nil,
            // How the last sync reached the Mac (M5.5): "home" or "tailnet", as screen 5 says it.
            "path": status.reachable ? status.path?.rawValue ?? NSNull() : NSNull(),
        ]
    case "search":
        guard let text = command["text"] as? String else { return ["error": "search needs text"] }
        let read = await memory.search(text, offset: command["offset"] as? Int ?? 0)
        return try memoryJson(read) { MemorySearchAnswer.results($0) }
    case "day":
        guard let day = command["day"] as? String else { return ["error": "day needs day"] }
        return try memoryJson(await memory.day(day)) { MemoryDayAnswer.day($0) }
    case "journal":
        guard let day = command["day"] as? String else { return ["error": "journal needs day"] }
        return try memoryJson(await memory.journal(day)) { MemoryJournalAnswer.journal($0) }
    case "commitments":
        return try memoryJson(await memory.commitments()) { MemoryCommitmentsAnswer.commitments($0) }
    case "conversation":
        guard let episodeId = command["episodeId"] as? Int else { return ["error": "conversation needs episodeId"] }
        return try memoryJson(await memory.conversation(episodeId)) { MemoryConversationAnswer.conversation($0) }
    case "time-search":
        guard let text = command["text"] as? String, let count = command["count"] as? Int, count > 0 else {
            return ["error": "time-search needs text and count"]
        }
        var times: [Double] = []
        for _ in 0..<count {
            let start = ContinuousClock.now
            guard case .read = await memory.search(text) else { return ["error": "a search failed"] }
            let elapsed = ContinuousClock.now - start
            times.append(Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15)
        }
        return ["ms": times]
    case "files":
        return ["files": filesUnder(root)]
    case "find":
        guard let pin = command["pin"] as? String else { return ["error": "find needs pin"] }
        let found = await NetworkMacFinder().find(pin: pin, known: [])
        return ["endpoints": found.map { ["host": $0.host, "port": $0.port] }]
    default:
        return ["error": "unknown command"]
    }
}

while let line = readLine() {
    guard let command = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] else {
        emit(["error": "not json"])
        continue
    }
    do {
        emit(try await run(command))
    } catch {
        emit(["error": "\(error)"])
    }
}
