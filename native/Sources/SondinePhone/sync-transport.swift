import CryptoKit
import Foundation
@preconcurrency import Network
import Security
import Synchronization

// How the phone reaches the Mac (ADR 008, « Transport »): HTTP/1.1 inside
// TLS 1.3, pinned to the SHA-256 of the Mac's public key; the certificate's
// name, dates and chain are ignored, nothing else is trusted. URLSession in
// the foreground only. Bonjour finds the Mac at home; the QR and each
// `hello` give addresses to try when mDNS is blocked.

/// An address and port where the Mac's relay may listen.
public struct MacEndpoint: Hashable, Sendable, CustomStringConvertible {
    public var host: String
    public var port: Int

    public init(host: String, port: Int) {
        self.host = host
        self.port = port
    }

    public var description: String { host.contains(":") ? "[\(host)]:\(port)" : "\(host):\(port)" }

    /// In Tailscale's ranges, 100.64.0.0/10 or fd7a:115c:a1e0::/48: reached
    /// through the tunnel, away from home (ADR 008, « Which peers »).
    public var isTailnet: Bool {
        var v4 = in_addr()
        if inet_pton(AF_INET, host, &v4) == 1 {
            return UInt32(bigEndian: v4.s_addr) >> 22 == 0x191
        }
        var v6 = in6_addr()
        let bare = host.split(separator: "%", maxSplits: 1).first.map(String.init) ?? host
        guard inet_pton(AF_INET6, bare, &v6) == 1 else { return false }
        return withUnsafeBytes(of: v6) { Array($0.prefix(6)) } == [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0]
    }

    /// `https://host:port/path`; an IPv6 literal in brackets, its zone escaped.
    public func url(_ path: String) -> URL? {
        let host = self.host.contains(":") ? "[\(self.host.replacingOccurrences(of: "%", with: "%25"))]" : self.host
        return URL(string: "https://\(host):\(port)\(path)")
    }
}

/// An HTTP answer: its status, body, and the headers playback reads.
public struct SyncReply: Sendable {
    public var status: Int
    public var body: Data
    /// `Content-Range` of a `206`: `bytes <start>-<end>/<total>`.
    public var contentRange: String?

    public init(status: Int, body: Data, contentRange: String? = nil) {
        self.status = status
        self.body = body
        self.contentRange = contentRange
    }
}

/// What carries the requests: URLSession pinned to the Mac's key on the
/// phone; the same URLSession over a stub protocol in the tests.
public protocol SyncTransport: Sendable {
    /// `POST path` with a JSON body; throws when the Mac could not be reached or the TLS key was not the pinned one.
    func post(
        _ path: String, json: Data, credential: String?, to endpoint: MacEndpoint, pin: String, timeout: TimeInterval
    ) async throws -> SyncReply
    /// `PUT path` with the file's bytes from `offset` to its end; `progress` gets the bytes the Mac holds as they go.
    func put(
        _ path: String, file: URL, offset: Int64, credential: String, to endpoint: MacEndpoint, pin: String,
        progress: @escaping @Sendable (Int64) -> Void
    ) async throws -> SyncReply
    /// `GET path` with `Range: bytes=<lower>-<upper>`: the answer held in memory, never cached.
    func get(
        _ path: String, range: ClosedRange<Int64>, credential: String, to endpoint: MacEndpoint, pin: String,
        timeout: TimeInterval
    ) async throws -> SyncReply
}

public enum SyncTransportError: Error, Equatable {
    case badAddress
    case notHttp
}

// Pinning

/// The pin of a TLS key: SHA-256 of its SubjectPublicKeyInfo (DER), lowercase hex.
public enum KeyPin {
    /// The DER header of a P-256 SubjectPublicKeyInfo, before the 65-byte uncompressed point:
    /// SEQUENCE { SEQUENCE { id-ecPublicKey, prime256v1 }, BIT STRING (0 unused bits) }.
    static let p256Header: [UInt8] = [
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01,
        0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
    ]

    /// The SubjectPublicKeyInfo of a P-256 public key; nil for any other key.
    public static func spki(of key: SecKey) -> Data? {
        guard let attributes = SecKeyCopyAttributes(key) as? [String: Any],
              attributes[kSecAttrKeyType as String] as? String == kSecAttrKeyTypeECSECPrimeRandom as String,
              (attributes[kSecAttrKeySizeInBits as String] as? NSNumber)?.intValue == 256,
              let point = SecKeyCopyExternalRepresentation(key, nil) as Data?,
              point.count == 65, point.first == 0x04
        else { return nil }
        return Data(p256Header) + point
    }

    public static func pin(of key: SecKey) -> String? {
        spki(of: key).map { SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined() }
    }

    /// The pin of the key the server's own certificate carries; nil when it is not P-256.
    public static func pin(of trust: SecTrust) -> String? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first,
              let key = SecCertificateCopyKey(leaf)
        else { return nil }
        return pin(of: key)
    }

    /// The only trust decision the app makes: the server's key is the pinned one.
    public static func accepts(_ trust: SecTrust, pin expected: String) -> Bool {
        guard let actual = pin(of: trust) else { return false }
        // Compared whole, without an early exit.
        return actual.utf8.count == expected.utf8.count
            && zip(actual.utf8, expected.utf8).reduce(0) { $0 | ($1.0 ^ $1.1) } == 0
    }
}

/// Answers the server-trust challenge with the pin alone; refuses every other challenge.
final class PinningDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate, Sendable {
    let pin: String

    init(pin: String) { self.pin = pin }

    private func answer(_ challenge: URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust, KeyPin.accepts(trust, pin: pin)
        else { return (.cancelAuthenticationChallenge, nil) }
        return (.useCredential, URLCredential(trust: trust))
    }

    func urlSession(
        _ session: URLSession, didReceive challenge: URLAuthenticationChallenge
    ) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        answer(challenge)
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge
    ) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        answer(challenge)
    }
}

/// An upload's bytes from an offset, and its progress.
final class UploadDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    let file: URL
    let offset: Int64
    let progress: @Sendable (Int64) -> Void

    init(file: URL, offset: Int64, progress: @escaping @Sendable (Int64) -> Void) {
        self.file = file
        self.offset = offset
        self.progress = progress
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        progress(offset + totalBytesSent)
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask, needNewBodyStream completionHandler: @escaping @Sendable (InputStream?) -> Void
    ) {
        completionHandler(URLSessionTransport.stream(file, from: offset))
    }
}

/// URLSession, one ephemeral session per pin and path: TLS 1.3 only, no
/// cache, no cookies, no credential storage, no waiting for a network. At
/// home it never uses cellular; through Tailscale (a tunnel address, M5.5)
/// it may, since the tunnel may run over it.
public final class URLSessionTransport: SyncTransport {
    private struct SessionKey: Hashable {
        let pin: String
        let tailnet: Bool
    }

    private let sessions = Mutex<[SessionKey: URLSession]>([:])
    private let configure: @Sendable (URLSessionConfiguration) -> Void

    /// `configure`: the tests put their stub protocol here.
    public init(configure: @escaping @Sendable (URLSessionConfiguration) -> Void = { _ in }) {
        self.configure = configure
    }

    deinit {
        sessions.withLock { $0.values.forEach { $0.invalidateAndCancel() } }
    }

    private func session(_ pin: String, _ endpoint: MacEndpoint) -> URLSession {
        let key = SessionKey(pin: pin, tailnet: endpoint.isTailnet)
        return sessions.withLock { sessions in
            if let session = sessions[key] { return session }
            let configuration = URLSessionConfiguration.ephemeral
            configuration.tlsMinimumSupportedProtocolVersion = .TLSv13
            configuration.urlCache = nil
            configuration.httpCookieStorage = nil
            configuration.urlCredentialStorage = nil
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            configuration.waitsForConnectivity = false
            configuration.httpMaximumConnectionsPerHost = 1
            configuration.allowsCellularAccess = key.tailnet
            configure(configuration)
            let session = URLSession(configuration: configuration, delegate: PinningDelegate(pin: pin), delegateQueue: nil)
            sessions[key] = session
            return session
        }
    }

    /// The file's bytes from `offset`.
    static func stream(_ file: URL, from offset: Int64) -> InputStream? {
        let stream = InputStream(url: file)
        // Set before the stream opens, the offset is where reading starts.
        stream?.setProperty(NSNumber(value: offset), forKey: .fileCurrentOffsetKey)
        return stream
    }

    private func request(_ method: String, _ path: String, _ endpoint: MacEndpoint, credential: String?) throws -> URLRequest {
        guard let url = endpoint.url(path) else { throw SyncTransportError.badAddress }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let credential { request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization") }
        return request
    }

    private func reply(_ data: Data, _ response: URLResponse) throws -> SyncReply {
        guard let http = response as? HTTPURLResponse else { throw SyncTransportError.notHttp }
        return SyncReply(status: http.statusCode, body: data, contentRange: http.value(forHTTPHeaderField: "Content-Range"))
    }

    public func post(
        _ path: String, json: Data, credential: String?, to endpoint: MacEndpoint, pin: String, timeout: TimeInterval
    ) async throws -> SyncReply {
        var request = try request("POST", path, endpoint, credential: credential)
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = json
        let (data, response) = try await session(pin, endpoint).data(for: request)
        return try reply(data, response)
    }

    public func put(
        _ path: String, file: URL, offset: Int64, credential: String, to endpoint: MacEndpoint, pin: String,
        progress: @escaping @Sendable (Int64) -> Void
    ) async throws -> SyncReply {
        let size = try FileManager.default.attributesOfItem(atPath: file.path(percentEncoded: false))[.size] as? Int64 ?? 0
        var request = try request("PUT", path, endpoint, credential: credential)
        // Core closes an upload 30 s without a byte; the phone gives up as soon.
        request.timeoutInterval = 30
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue(String(offset), forHTTPHeaderField: PhoneSync.offsetHeader)
        request.setValue(String(max(size - offset, 0)), forHTTPHeaderField: "Content-Length")
        request.httpBodyStream = Self.stream(file, from: offset)
        let (data, response) = try await session(pin, endpoint).data(
            for: request, delegate: UploadDelegate(file: file, offset: offset, progress: progress))
        return try reply(data, response)
    }

    public func get(
        _ path: String, range: ClosedRange<Int64>, credential: String, to endpoint: MacEndpoint, pin: String,
        timeout: TimeInterval
    ) async throws -> SyncReply {
        var request = try request("GET", path, endpoint, credential: credential)
        request.timeoutInterval = timeout
        request.setValue("bytes=\(range.lowerBound)-\(range.upperBound)", forHTTPHeaderField: "Range")
        // The session has no cache: the bytes live in this answer only.
        let (data, response) = try await session(pin, endpoint).data(for: request)
        return try reply(data, response)
    }
}

// Discovery

/// Where to try the Mac, in two steps (M5.5). A TCP connection that opens
/// is not the Mac: only the pinned `hello` says so. So the client tries
/// every address `find` gave, and asks `findTunnel` only once all of them
/// failed (another machine at the home address, away from home, accepts
/// the port and fails the pin).
public protocol MacFinding: Sendable {
    /// At home: the relay's Bonjour service whose TXT pin matches, then the
    /// `known` addresses outside Tailscale's ranges that accept a connection.
    func find(pin: String, known: [MacEndpoint]) async -> [MacEndpoint]
    /// Away: the `known` addresses in Tailscale's ranges that accept a connection.
    func findTunnel(pin: String, known: [MacEndpoint]) async -> [MacEndpoint]
}

/// The known addresses as they are, home and tunnel apart: the tests' finder.
public struct KnownMacFinder: MacFinding {
    public init() {}
    public func find(pin: String, known: [MacEndpoint]) async -> [MacEndpoint] { known.filter { !$0.isTailnet } }
    public func findTunnel(pin: String, known: [MacEndpoint]) async -> [MacEndpoint] { known.filter(\.isTailnet) }
}

/// The addresses one request tries, each once, in order: `first` (the one
/// that answered last), then what the finder finds at home (`preferred`
/// ahead when found again), then, only once every one of those failed,
/// the tunnel addresses.
public struct MacCandidates: Sendable {
    private let finder: any MacFinding
    private let pin: String
    private let known: [MacEndpoint]
    private let preferred: MacEndpoint?
    private var queue: [MacEndpoint]
    private var step = Step.first
    private var tried: Set<MacEndpoint> = []

    private enum Step: Sendable { case first, home, tunnel }

    public init(
        finder: any MacFinding, pin: String, known: [MacEndpoint], first: [MacEndpoint] = [], preferred: MacEndpoint? = nil
    ) {
        self.finder = finder
        self.pin = pin
        self.known = known
        self.preferred = preferred
        queue = first
    }

    public mutating func next() async -> MacEndpoint? {
        while true {
            if !queue.isEmpty {
                let endpoint = queue.removeFirst()
                if tried.insert(endpoint).inserted { return endpoint }
                continue
            }
            switch step {
            case .first:
                step = .home
                var home = await finder.find(pin: pin, known: known)
                if let preferred, home.contains(preferred) {
                    home.removeAll { $0 == preferred }
                    home.insert(preferred, at: 0)
                }
                queue = home
            case .home:
                step = .tunnel
                guard !Task.isCancelled else { return nil }
                queue = await finder.findTunnel(pin: pin, known: known)
            case .tunnel:
                return nil
            }
        }
    }
}

/// What the finder asks of the network; the tests give a fake one.
public protocol MacNetwork: Sendable {
    /// The relays' Bonjour services whose TXT pin starts the pinned one, after browsing `duration`.
    func browse(pin: String, for duration: Duration) async -> [MacEndpoint]
    /// Whether a TCP connection to `endpoint` opens (closed at once). Must
    /// return soon once its task is cancelled: the finder cancels it at its timeout.
    func connects(_ endpoint: MacEndpoint) async -> Bool
}

/// Bonjour and the home addresses, together (`find`); the tunnel addresses
/// (Tailscale's ranges) apart (`findTunnel`), which the client asks only
/// once home failed, so a phone at home with Tailscale on still syncs at
/// home. Every step has its time: a sync away from home starts within
/// `probeFor` and `tunnelProbeFor`, and nothing waits longer.
public struct NetworkMacFinder: MacFinding {
    public var browseFor: Duration = .milliseconds(1_500)
    public var probeFor: Duration = .seconds(2)
    /// Longer than at home: Tailscale may first find its way through a relay.
    public var tunnelProbeFor: Duration = .seconds(4)
    let network: any MacNetwork

    public init() { self.init(network: SystemMacNetwork()) }

    public init(network: any MacNetwork) { self.network = network }

    public func find(pin: String, known: [MacEndpoint]) async -> [MacEndpoint] {
        let home = known.filter { !$0.isTailnet }
        let network = network
        let browseFor = browseFor
        async let found = Self.within(browseFor + .seconds(1), []) { await network.browse(pin: pin, for: browseFor) }
        async let reachable = probe(home, for: probeFor)
        let services = await found
        var seen = Set(services)
        return services + (await reachable).filter { seen.insert($0).inserted }
    }

    public func findTunnel(pin: String, known: [MacEndpoint]) async -> [MacEndpoint] {
        await probe(known.filter(\.isTailnet), for: tunnelProbeFor)
    }

    /// Makes iOS ask for the local network now, after the app explained why.
    public func askForLocalNetwork() async {
        _ = await network.browse(pin: "", for: browseFor)
    }

    /// The endpoints that accept a connection within `limit`, in their order.
    private func probe(_ endpoints: [MacEndpoint], for limit: Duration) async -> [MacEndpoint] {
        let network = network
        return await withTaskGroup(of: (Int, Bool).self) { group in
            for (index, endpoint) in endpoints.enumerated() {
                group.addTask { (index, await Self.within(limit, false) { await network.connects(endpoint) }) }
            }
            var reachable = Set<Int>()
            for await (index, ok) in group where ok { reachable.insert(index) }
            return endpoints.enumerated().filter { reachable.contains($0.offset) }.map(\.element)
        }
    }

    /// `work`'s answer, or `fallback` once `limit` passed (`work` is cancelled then).
    static func within<T: Sendable>(
        _ limit: Duration, _ fallback: T, _ work: @escaping @Sendable () async -> T
    ) async -> T {
        await withTaskGroup(of: T?.self) { group in
            group.addTask { await work() }
            group.addTask {
                try? await Task.sleep(for: limit)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first ?? fallback
        }
    }
}

/// Bonjour (`NWBrowser`) and TCP connections (`NWConnection`). The first
/// Bonjour operation is what makes iOS ask for the local network; the app
/// explains it before. A tunnel address is not on the local network
/// (TN3179): connecting to it asks nothing.
public struct SystemMacNetwork: MacNetwork {
    public init() {}

    public func browse(pin: String, for duration: Duration) async -> [MacEndpoint] {
        let browser = NWBrowser(
            for: .bonjourWithTXTRecord(type: PhoneSync.serviceType, domain: nil), using: .tcp)
        let results = Mutex<Set<NWBrowser.Result>>([])
        browser.browseResultsChangedHandler = { latest, _ in results.withLock { $0 = latest } }
        browser.start(queue: DispatchQueue(label: "sondine.browse"))
        try? await Task.sleep(for: duration)
        browser.cancel()
        let prefix = String(pin.prefix(8))
        let matching = results.withLock { $0 }.filter { result in
            guard !prefix.isEmpty, case let .bonjour(txt) = result.metadata else { return false }
            return txt[PhoneSync.txtPinKey] == prefix
                && txt[PhoneSync.txtVersionKey].flatMap(Int.init) == PhoneSync.linkVersion
        }
        var endpoints: [MacEndpoint] = []
        for result in matching where !Task.isCancelled {
            if let endpoint = await resolve(result.endpoint) { endpoints.append(endpoint) }
        }
        return endpoints
    }

    public func connects(_ endpoint: MacEndpoint) async -> Bool {
        guard let port = NWEndpoint.Port(rawValue: UInt16(clamping: endpoint.port)) else { return false }
        return await connect(.hostPort(host: NWEndpoint.Host(endpoint.host), port: port), Self.parameters(for: endpoint)) != nil
    }

    /// TCP that never uses cellular to reach a home address (a probe of a
    /// private address must not leave by the carrier), and may for a tunnel
    /// address, as the requests that follow (`URLSessionTransport`).
    public static func parameters(for endpoint: MacEndpoint?) -> NWParameters {
        let parameters = NWParameters.tcp
        if endpoint?.isTailnet != true { parameters.prohibitedInterfaceTypes = [.cellular] }
        return parameters
    }

    /// A service's address and port, read from a TCP connection to it (closed
    /// at once); a Bonjour service is on the local network, never cellular.
    private func resolve(_ endpoint: NWEndpoint) async -> MacEndpoint? {
        guard let path = await connect(endpoint, Self.parameters(for: nil)), case let .hostPort(host, port)? = path.remoteEndpoint else {
            return nil
        }
        let text: String = switch host {
        case let .ipv4(address): "\(address)"
        case let .ipv6(address): "\(address)"
        case let .name(name, _): name
        @unknown default: "\(host)"
        }
        return MacEndpoint(host: text, port: Int(port.rawValue))
    }

    /// The path of a TCP connection once ready; nil when it fails, waits for
    /// a network, or its task is cancelled (the finder's timeout).
    private func connect(_ endpoint: NWEndpoint, _ parameters: NWParameters) async -> NWPath? {
        let connection = NWConnection(to: endpoint, using: parameters)
        let outcome = Mutex<CheckedContinuation<NWPath?, Never>?>(nil)
        let finish: @Sendable (NWPath?) -> Void = { path in
            outcome.withLock { $0?.resume(returning: path); $0 = nil }
        }
        let path = await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                outcome.withLock { $0 = continuation }
                if Task.isCancelled { return finish(nil) }
                connection.stateUpdateHandler = { state in
                    switch state {
                    case .ready: finish(connection.currentPath)
                    case .failed, .cancelled, .waiting: finish(nil)
                    default: break
                    }
                }
                connection.start(queue: DispatchQueue(label: "sondine.probe"))
            }
        } onCancel: {
            finish(nil)
        }
        connection.cancel()
        return path
    }
}
