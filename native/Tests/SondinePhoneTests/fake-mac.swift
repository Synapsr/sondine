import CryptoKit
import Foundation
import SondinePhone
import Synchronization

/// The Mac's side of the sync, in memory, as ADR 008 describes it: the
/// tests' server, behind a URLProtocol stub so the phone's real URLSession
/// transport builds and sends every request (TLS aside, tested on its own).
final class FakeMac: Sendable {
    enum Held: Equatable {
        case receiving(bytes: Int64, sha256: String, data: Data)
        case stored(bytes: Int64, sha256: String, data: Data)
        case deleted
    }

    struct State {
        var credentials: Set<String> = []
        var revoked = false
        var token: String?
        var held: [UUID: Held] = [:]
        /// States `states` answers beyond what `held` says (« transcribing », « ready »).
        var analysis: [UUID: MacRecordingState] = [:]
        var deleteOperations: [UUID] = []
        var forgotten = false
        /// The next upload stops after this many bytes, as Wi-Fi going off would.
        var cutAfter: Int?
        var noRoom = false
        /// The next upload is refused with `offset`, as when the part changed after the announcement.
        var refuseOffsetOnce = false
        /// The phone's address is refused after too many wrong credentials: `busy` (429) before anything is read.
        var throttled = false
        /// Every request but pairing is refused with `version` and this version.
        var macVersion: Int?
        var requests: [String] = []
        /// What `get` answers for a ready recording: its result and revision.
        var results: [UUID: (revision: String, result: PhoneResult)] = [:]
        /// `get` answers this instead, once.
        var getOnce: [UUID: GetAnswer] = [:]
        /// The revisions each `get` sent, in order.
        var getRevisions: [String?] = []
        /// The name each recording holds, and when it was typed.
        var names: [UUID: (name: String?, typedAtMs: Int64)] = [:]
        /// Notes added, by recording, and the operations done.
        var notes: [UUID: [String]] = [:]
        /// Tags by recording, by their name as cleaned (ADR 039), and the Mac's tags.
        var tags: [UUID: [String]] = [:]
        var macTags: [String] = []
        /// Voices the phone said are the user's, by recording.
        var selves: [UUID: [Int]] = [:]
        var operations: Set<UUID> = []
        /// What playback serves, by recording: the generation and the WAV.
        var audio: [UUID: (generation: Int, data: Data)] = [:]
        /// What each memory read answers (M5.4), by path: its JSON.
        var memory: [String: Data] = [:]
        /// How many times a memory read answers `withheld` first, by path.
        var withheld: [String: Int] = [:]
        /// The bodies of the memory reads, in order.
        var memoryRequests: [Data] = []
        /// Its Tailscale address once `addTunnel()` gave it one (M5.5): `hello` lists it after the home one.
        var tunnel = false
        /// The path of each `hello`, as the relay would have said it.
        var hellos: [MacPath] = []
    }

    /// An address of its own, so tests running together reach their own Mac.
    let host = "10.\(UInt8.random(in: 1...254)).\(UInt8.random(in: 1...254)).\(UInt8.random(in: 1...254))"
    let port = 49_321
    let macId = UUID()
    let pin = String(repeating: "ab", count: 32)
    let state = Mutex(State())

    /// Its address in Tailscale's range, answered once `addTunnel()` ran.
    let tunnelHost = "100.\(UInt8.random(in: 64...127)).\(UInt8.random(in: 1...254)).\(UInt8.random(in: 1...254))"

    var endpoint: MacEndpoint { MacEndpoint(host: host, port: port) }

    init() { FakeMacProtocol.register(self, at: host) }
    deinit {
        FakeMacProtocol.unregister(host)
        FakeMacProtocol.unregister(tunnelHost)
    }

    /// « Autoriser par Tailscale » on, Tailscale running: `hello` gives the tunnel's address too.
    func addTunnel() {
        state.withLock { $0.tunnel = true }
        FakeMacProtocol.register(self, at: tunnelHost)
    }

    /// The phone leaves home (its Wi-Fi's address no longer answers), or comes back.
    func reachableAtHome(_ reachable: Bool) {
        if reachable { FakeMacProtocol.register(self, at: host) } else { FakeMacProtocol.unregister(host) }
    }

    /// A QR for this Mac, its token waiting for a pairing.
    func invite() throws -> PairingInvite {
        let token = Data((0..<32).map { _ in UInt8.random(in: 0...255) }).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        state.withLock { $0.token = token }
        return try PairingInvite(pin: pin, token: token, name: "Sondine K7Q2", port: port, addrs: [host])
    }

    var requests: [String] { state.withLock { $0.requests } }

    /// What an HTTP request gets; nil for a connection cut mid-upload.
    func handle(method: String, path: String, headers: [String: String], body: Data, via: MacPath = .home) -> (Int, Data)? {
        state.withLock { $0.requests.append("\(method) \(path)") }
        if path == PhoneSync.Route.pair {
            return pair(body)
        }
        if state.withLock({ $0.throttled }) { return (429, json(PhoneError(error: .busy))) }
        let credential = headers["Authorization"]?.replacingOccurrences(of: "Bearer ", with: "")
        let refusal: PhoneErrorCode? = state.withLock { state in
            guard let credential, state.credentials.contains(credential) else { return .unauthorized }
            return state.revoked ? .revoked : nil
        }
        if let refusal { return (401, json(PhoneError(error: refusal))) }
        if let version = state.withLock({ $0.macVersion }) {
            return (400, json(PhoneError(error: .version, macVersion: version)))
        }
        if method == "PUT", path.hasSuffix("/audio"), let id = UUID(uuidString: String(path.split(separator: "/")[2])) {
            return upload(id, offset: headers[PhoneSync.offsetHeader].flatMap { Int64($0) } ?? -1, body: body)
        }
        switch path {
        case PhoneSync.Route.hello:
            guard (try? JSONDecoder().decode(HelloRequest.self, from: body)) != nil else { return bad() }
            let addrs = state.withLock { state in
                state.hellos.append(via)
                return state.tunnel ? [host, tunnelHost] : [host]
            }
            let answer = try! HelloAnswer(
                clockMs: 1_793_442_721_000, macId: macId, addrs: addrs, port: port, maxFileBytes: PhoneSync.maxFileBytes,
                via: via)
            return (200, json(answer))
        case PhoneSync.Route.announce:
            guard let request = try? JSONDecoder().decode(AnnounceRequest.self, from: body) else { return bad() }
            return (200, json(announce(request)))
        case PhoneSync.Route.states:
            guard let request = try? JSONDecoder().decode(StatesRequest.self, from: body) else { return bad() }
            let states = state.withLock { state in
                request.recordingIds.map { id -> StatesAnswer.Entry in
                    let value: MacRecordingState = switch state.held[id] {
                    case nil: .unknown
                    case .receiving: .receiving
                    case .stored: state.analysis[id] ?? .waiting
                    case .deleted: .deleted
                    }
                    return StatesAnswer.Entry(recordingId: id, state: value)
                }
            }
            return (200, json(StatesAnswer(states: states)))
        case PhoneSync.Route.delete:
            guard let request = try? JSONDecoder().decode(DeleteRequest.self, from: body) else { return bad() }
            state.withLock { state in
                if !state.deleteOperations.contains(request.operationId) { state.deleteOperations.append(request.operationId) }
                state.held[request.recordingId] = .deleted
            }
            return (200, Data(#"{"status":"deleted"}"#.utf8))
        case PhoneSync.Route.get:
            guard let request = try? JSONDecoder().decode(GetRequest.self, from: body) else { return bad() }
            let answer: GetAnswer = state.withLock { state in
                state.getRevisions.append(request.revision)
                if let once = state.getOnce.removeValue(forKey: request.recordingId) { return once }
                switch state.held[request.recordingId] {
                case nil: return .unavailable(.unknown)
                case .receiving: return .unavailable(.receiving)
                case .deleted: return .unavailable(.deleted)
                case .stored:
                    guard state.analysis[request.recordingId] == .ready, let kept = state.results[request.recordingId] else {
                        return .unavailable(.waiting)
                    }
                    return kept.revision == request.revision ? .unchanged : .result(revision: kept.revision, kept.result)
                }
            }
            return (200, json(answer))
        case PhoneSync.Route.rename:
            guard let request = try? JSONDecoder().decode(RenameRequest.self, from: body) else { return bad() }
            return (200, json(operation(request.operationId, request.recordingId) { state in
                // Of two names, the later one typed wins.
                if let kept = state.names[request.recordingId], kept.typedAtMs > request.typedAtMs { return }
                state.names[request.recordingId] = (request.name, request.typedAtMs)
            }))
        case PhoneSync.Route.note:
            guard let request = try? JSONDecoder().decode(NoteRequest.self, from: body) else { return bad() }
            return (200, json(operation(request.operationId, request.recordingId) { state in
                state.notes[request.recordingId, default: []].append(request.text)
            }))
        case PhoneSync.Route.tag:
            guard let request = try? JSONDecoder().decode(TagRequest.self, from: body) else { return bad() }
            return (200, json(operation(request.operationId, request.recordingId) { state in
                guard let name = TagName.clean(request.name) else { return }
                state.tags[request.recordingId, default: []].removeAll { TagName.key($0) == TagName.key(name) }
                if request.on { state.tags[request.recordingId, default: []].append(name) }
            }))
        case PhoneSync.Route.voice:
            guard let request = try? JSONDecoder().decode(VoiceRequest.self, from: body) else { return bad() }
            return (200, json(operation(request.operationId, request.recordingId) { state in
                state.selves[request.recordingId, default: []].append(request.ordinal)
            }))
        case PhoneSync.Route.tags:
            guard (try? JSONDecoder().decode(TagsRequest.self, from: body)) != nil else { return bad() }
            return (200, json(try! TagsAnswer(tags: state.withLock(\.macTags))))
        case PhoneSync.Route.forget:
            guard (try? JSONDecoder().decode(ForgetRequest.self, from: body)) != nil else { return bad() }
            state.withLock {
                $0.forgotten = true
                $0.credentials.removeAll()
            }
            return (200, Data(#"{"status":"forgotten"}"#.utf8))
        default:
            guard path.hasPrefix("/v1/memory/") else { return (404, json(PhoneError(error: .badRequest))) }
            return state.withLock { state in
                state.memoryRequests.append(body)
                if let left = state.withheld[path], left > 0 {
                    state.withheld[path] = left - 1
                    return (200, Data(#"{"status":"withheld"}"#.utf8))
                }
                guard let answer = state.memory[path] else { return (400, json(PhoneError(error: .badRequest))) }
                return (200, answer)
            }
        }
    }

    /// An operation of the outbox: done once by its id, `later` before the recording is stored.
    private func operation(_ id: UUID, _ recordingId: UUID, _ apply: (inout State) -> Void) -> OperationAnswer {
        state.withLock { state in
            if state.operations.contains(id) { return .done }
            switch state.held[recordingId] {
            case .deleted: return .deleted
            case .stored:
                apply(&state)
                state.operations.insert(id)
                return .done
            default: return .later
            }
        }
    }

    /// `GET …/audio?g=` with a `Range`: a `206` of those bytes, or a refusal.
    func audio(path: String, query: String?, headers: [String: String]) -> (Int, Data, [String: String]) {
        state.withLock { $0.requests.append("GET \(path)") }
        let credential = headers["Authorization"]?.replacingOccurrences(of: "Bearer ", with: "")
        guard let credential, state.withLock({ $0.credentials.contains(credential) && !$0.revoked }) else {
            return (401, json(PhoneError(error: .revoked)), [:])
        }
        guard let id = UUID(uuidString: String(path.split(separator: "/")[2])),
              let generation = query?.wholeMatch(of: /g=(\d+)/).flatMap({ Int($0.1) })
        else { return (400, json(PhoneError(error: .badRequest)), [:]) }
        guard let served = state.withLock({ $0.audio[id] }) else { return (410, json(PhoneError(error: .gone)), [:]) }
        guard served.generation == generation else { return (409, json(PhoneError(error: .stale)), [:]) }
        let total = served.data.count
        guard let header = headers["Range"], let match = header.wholeMatch(of: /bytes=(\d+)-(\d+)/),
              let start = Int(match.1), let asked = Int(match.2)
        else { return (200, served.data, ["Content-Type": "audio/wav"]) }
        guard start < total else { return (416, json(PhoneError(error: .range)), [:]) }
        let end = min(asked, total - 1)
        return (206, served.data.subdata(in: start..<(end + 1)), [
            "Content-Type": "audio/wav", "Content-Range": "bytes \(start)-\(end)/\(total)",
        ])
    }

    private func pair(_ body: Data) -> (Int, Data) {
        guard let request = try? JSONDecoder().decode(PairRequest.self, from: body) else { return bad() }
        return state.withLock { state in
            guard let token = state.token, token == request.token else {
                return (409, json(PhoneError(error: .pairingUsed)))
            }
            // Consumed at its first presentation.
            state.token = nil
            let credential = "sdp_" + String(repeating: "c", count: 42) + String(state.credentials.count)
            state.credentials.insert(credential)
            return (200, json(try! PairAnswer(credential: credential, macId: macId)))
        }
    }

    private func announce(_ request: AnnounceRequest) -> UploadStatus {
        state.withLock { state in
            if state.noRoom { return .refused(.noRoom) }
            switch state.held[request.recordingId] {
            case .deleted: return .deleted
            case let .stored(bytes, sha256, _):
                return bytes == request.bytes && sha256 == request.sha256 ? .stored : .conflict
            case let .receiving(bytes, sha256, data) where bytes == request.bytes && sha256 == request.sha256:
                return .send(offset: Int64(data.count))
            default:
                // Another length or hash: the part is discarded.
                state.held[request.recordingId] = .receiving(bytes: request.bytes, sha256: request.sha256, data: Data())
                return .send(offset: 0)
            }
        }
    }

    private func upload(_ id: UUID, offset: Int64, body: Data) -> (Int, Data)? {
        state.withLock { state -> (Int, Data)? in
            guard case let .receiving(bytes, sha256, data) = state.held[id] else {
                return (200, json(UploadStatus.refused(.offset)))
            }
            guard offset == Int64(data.count), !state.refuseOffsetOnce else {
                state.refuseOffsetOnce = false
                return (200, json(UploadStatus.refused(.offset)))
            }
            if let cut = state.cutAfter {
                state.cutAfter = nil
                state.held[id] = .receiving(bytes: bytes, sha256: sha256, data: data + body.prefix(cut))
                return nil
            }
            let whole = data + body
            guard Int64(whole.count) >= bytes else {
                state.held[id] = .receiving(bytes: bytes, sha256: sha256, data: whole)
                return (200, json(UploadStatus.send(offset: Int64(whole.count))))
            }
            guard Int64(whole.count) == bytes, hex(SHA256.hash(data: whole)) == sha256 else {
                state.held[id] = nil
                return (200, json(UploadStatus.refused(.hash)))
            }
            state.held[id] = .stored(bytes: bytes, sha256: sha256, data: whole)
            return (200, json(UploadStatus.stored))
        }
    }

    private func bad() -> (Int, Data) { (400, json(PhoneError(error: .badRequest))) }
    private func json(_ value: some Encodable) -> Data { try! JSONEncoder().encode(value) }
}

func hex(_ digest: some Sequence<UInt8>) -> String { digest.map { String(format: "%02x", $0) }.joined() }

/// Hands every request to the fake Mac at its address; nothing else answers.
final class FakeMacProtocol: URLProtocol, @unchecked Sendable {
    private static let macs = Mutex<[String: FakeMac]>([:])

    static func register(_ mac: FakeMac, at host: String) { macs.withLock { $0[host] = mac } }
    static func unregister(_ host: String) {
        _ = macs.withLock { $0.removeValue(forKey: host) }
        _ = impostors.withLock { $0.remove(host) }
    }

    /// Another machine at this address: it accepts the connection, and its
    /// key is not the pinned one, so URLSession cancels the request at the
    /// trust challenge, as on the phone.
    private static let impostors = Mutex<Set<String>>([])
    static func impostor(at host: String) {
        _ = macs.withLock { $0.removeValue(forKey: host) }
        _ = impostors.withLock { $0.insert(host) }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        if let host = request.url?.host, Self.impostors.withLock({ $0.contains(host) }) {
            client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
            return
        }
        guard let url = request.url, let host = url.host,
              let mac = Self.macs.withLock({ $0[host] })
        else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let body = request.httpBody ?? request.httpBodyStream.map(Self.read) ?? Data()
        let headers = request.allHTTPHeaderFields ?? [:]
        let status: Int
        let answer: Data
        var fields = ["Content-Type": "application/json"]
        if request.httpMethod == "GET" {
            let reply = mac.audio(path: url.path, query: url.query, headers: headers)
            (status, answer) = (reply.0, reply.1)
            fields.merge(reply.2) { $1 }
        } else {
            guard let reply = mac.handle(
                method: request.httpMethod ?? "GET", path: url.path, headers: headers, body: body,
                via: host == mac.tunnelHost ? .tailnet : .home)
            else {
                client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
                return
            }
            (status, answer) = reply
        }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: fields)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: answer)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

/// A phone with its files, a credential in memory, and the real transport over the stub.
struct SyncRig {
    let root: URL
    let store: RecordingStore
    let outbox: Outbox
    let device: DeviceStore
    let credentials = MemoryCredentials()
    let clock = ScriptedClock(nowMs: 1_793_442_720_000)
    let open = OpenRecordings()
    let client: PhoneSyncClient

    init(root existing: URL? = nil, finder: any MacFinding = KnownMacFinder()) throws {
        root = try existing ?? scratch()
        store = try RecordingStore(root: root.appending(path: "recordings"))
        outbox = try Outbox(root: root.appending(path: "outbox"))
        device = DeviceStore(root: root)
        let transport = URLSessionTransport { $0.protocolClasses = [FakeMacProtocol.self] }
        let open = open
        client = PhoneSyncClient(
            store: store, outbox: outbox, device: device, credentials: credentials, transport: transport,
            finder: finder, clock: clock, configuration: .init(deviceName: "iPhone de Téo"),
            openRecordings: { open.ids })
    }

    /// A finished recording of `bytes` random bytes, `minutesAgo` before the clock.
    @discardableResult
    func recording(bytes: Int, minutesAgo: Int64 = 0, ended: Bool = true) throws -> StoredRecording {
        let header = PhoneRecordingHeader(
            recordingId: UUID(), sessionId: UUID(), part: 1, startedWallMs: clock.nowMs() - minutesAgo * 60_000,
            utcOffsetMin: 60, deviceId: device.file.deviceId, input: .builtIn, previous: nil, app: "0.1.0 (12)")
        let (folder, log) = try store.create(header, atMs: header.startedWallMs)
        try Data((0..<bytes).map { _ in UInt8.random(in: 0...255) }).write(to: folder.audio)
        if ended { try log.append(RecordingEvent(kind: .ended, atMs: clock.nowMs(), samples: 16_000, end: .stopped)) }
        log.close()
        return try require(store.recording(header.recordingId))
    }

    func paired(with mac: FakeMac) async throws {
        _ = try await client.pair(try mac.invite())
    }

    func audio(_ recording: StoredRecording) throws -> Data { try Data(contentsOf: recording.folder.audio) }
}

/// `#require` outside a test function.
func require<T>(_ value: T?, _ message: String = "missing") throws -> T {
    guard let value else { throw RequireError(message: message) }
    return value
}

struct RequireError: Error { let message: String }

/// The ids the recorder holds open, as the test says.
final class OpenRecordings: Sendable {
    private let value = Mutex<Set<UUID>>([])
    var ids: Set<UUID> { value.withLock { $0 } }
    func set(_ ids: Set<UUID>) { value.withLock { $0 = ids } }
}
