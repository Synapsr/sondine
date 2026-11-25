import Foundation
import Network

// The relay (ADR 008, « Who listens on the Mac »): TLS 1.3 on a TCP port,
// Bonjour, a peer check before TLS, and a byte copy to core's phone socket
// after one hello line. No HTTP, no credential, no logic.

public let phoneServiceType = "_sondine._tcp"
/// The version of the Bonjour record and the relay's first line (`PhoneSync.linkVersion`),
/// unchanged by sync version 2 (ADR 039) so older phones still find the Mac.
public let phoneSyncVersion = 1

public struct RelayLimits: Sendable {
    public var maxConnections = 8
    public var maxPerPeer = 2
    public var handshakeTimeout: Duration = .seconds(10)
    public var idleTimeout: Duration = .seconds(60)

    public init() {}
}

public struct LanRelayConfiguration: Sendable {
    /// 0: the system picks one.
    public var port: UInt16
    /// Core's `phone.sock`.
    public var socketPath: String
    /// The Bonjour instance name; nil advertises nothing (tests).
    public var serviceName: String?
    public var policy: PeerPolicy
    public var limits: RelayLimits

    public init(port: UInt16, socketPath: String, serviceName: String?, policy: PeerPolicy, limits: RelayLimits = RelayLimits()) {
        self.port = port
        self.socketPath = socketPath
        self.serviceName = serviceName
        self.policy = policy
        self.limits = limits
    }
}

public enum RefusalReason: String, Sendable {
    case notLocal = "not on an allowed path"
    case tooManyConnections = "too many connections"
    case tooManyFromPeer = "too many connections from this address"
    case unsupportedEndpoint = "not an IP peer"
}

public enum CloseReason: String, Sendable {
    case handshakeTimeout = "TLS handshake took too long"
    case handshakeFailed = "TLS handshake failed"
    case idle = "idle"
    case ended = "ended"
    case coreUnavailable = "core's socket is unreachable"
    case stopped = "relay stopped"
}

public enum RelayEvent: Sendable, Equatable {
    case listening(port: UInt16)
    case failed(String)
    /// Refused before TLS; only the address's class is told.
    case refused(RefusalReason, addressClass: String)
    case accepted(id: Int, PeerPath)
    /// TLS done and core's socket connected: bytes flow.
    case relaying(id: Int)
    case closed(id: Int, CloseReason)
    case stopped
}

/// What the TXT record says: the protocol version and the pin's first 8 hex digits.
public func txtRecord(pin8: String) -> [String: String] {
    ["v": String(phoneSyncVersion), "pin8": pin8]
}

/// The first line on core's socket (`PhoneRelayHello`).
public func helloLine(path: PeerPath, peer: PeerAddress) -> Data {
    Data("{\"v\":\(phoneSyncVersion),\"via\":\"\(path.rawValue)\",\"peer\":\"\(peer.description)\"}\n".utf8)
}

public final class LanRelay: @unchecked Sendable {
    // Everything below is touched on `queue` only.
    private let queue = DispatchQueue(label: "app.sondine.lan")
    private let identity: LanIdentity
    private let configuration: LanRelayConfiguration
    private let interfaces: @Sendable () -> [NetworkInterface]
    private let events: @Sendable (RelayEvent) -> Void
    private var listener: NWListener?
    private var connections: [Int: Relayed] = [:]
    private var perPeer: [String: Int] = [:]
    private var nextId = 0
    private var announced = false
    private var onStopped: (@Sendable () -> Void)?

    /// - Parameter events: called on the relay's queue.
    public init(
        identity: LanIdentity,
        configuration: LanRelayConfiguration,
        interfaces: @escaping @Sendable () -> [NetworkInterface] = NetworkInterfaces.current,
        events: @escaping @Sendable (RelayEvent) -> Void
    ) {
        self.identity = identity
        self.configuration = configuration
        self.interfaces = interfaces
        self.events = events
    }

    public func start() throws {
        let tls = NWProtocolTLS.Options()
        let security = tls.securityProtocolOptions
        sec_protocol_options_set_min_tls_protocol_version(security, .TLSv13)
        sec_protocol_options_set_max_tls_protocol_version(security, .TLSv13)
        guard let local = sec_identity_create(identity.identity) else {
            throw LanIdentityError("the identity cannot be used for TLS")
        }
        sec_protocol_options_set_local_identity(security, local)
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        let parameters = NWParameters(tls: tls, tcp: tcp)
        parameters.includePeerToPeer = false
        // The port is kept across restarts; a closed connection's TIME_WAIT must not hold it.
        parameters.allowLocalEndpointReuse = true
        let port = configuration.port == 0 ? NWEndpoint.Port.any : NWEndpoint.Port(rawValue: configuration.port)!
        let listener = try NWListener(using: parameters, on: port)
        if let name = configuration.serviceName {
            listener.service = NWListener.Service(
                name: name, type: phoneServiceType, domain: nil,
                txtRecord: NWTXTRecord(txtRecord(pin8: identity.pin8)).data
            )
        }
        listener.stateUpdateHandler = { [self] state in listenerChanged(state) }
        listener.newConnectionHandler = { [self] connection in accept(connection) }
        queue.sync { self.listener = listener }
        listener.start(queue: queue)
    }

    /// Withdraws the advertisement, closes every connection, then calls `completion`.
    public func stop(completion: @escaping @Sendable () -> Void) {
        queue.async { [self] in
            for relayed in Array(connections.values) { close(relayed, .stopped) }
            guard let listener else {
                completion()
                return
            }
            onStopped = completion
            listener.cancel()
        }
    }

    // MARK: Listener

    private func listenerChanged(_ state: NWListener.State) {
        switch state {
        case .ready:
            guard !announced, let port = listener?.port?.rawValue else { return }
            announced = true
            events(.listening(port: port))
        case .failed(let error), .waiting(let error):
            events(.failed("cannot listen: \(error)"))
        case .cancelled:
            events(.stopped)
            onStopped?()
            onStopped = nil
        default:
            break
        }
    }

    /// The peer check, before the connection starts and so before TLS: a
    /// refused peer's connection is cancelled with nothing sent.
    private func accept(_ connection: NWConnection) {
        guard case .hostPort(let host, _) = connection.endpoint, let peer = PeerAddress(host) else {
            events(.refused(.unsupportedEndpoint, addressClass: "unknown"))
            connection.cancel()
            return
        }
        guard let path = PeerFilter.classify(peer, interfaces: interfaces(), policy: configuration.policy) else {
            events(.refused(.notLocal, addressClass: peer.addressClass))
            connection.cancel()
            return
        }
        let limits = configuration.limits
        guard connections.count < limits.maxConnections else {
            events(.refused(.tooManyConnections, addressClass: peer.addressClass))
            connection.cancel()
            return
        }
        let key = peer.description
        guard perPeer[key, default: 0] < limits.maxPerPeer else {
            events(.refused(.tooManyFromPeer, addressClass: peer.addressClass))
            connection.cancel()
            return
        }
        nextId += 1
        let relayed = Relayed(id: nextId, peerKey: key, peer: peer, path: path, connection: connection)
        connections[relayed.id] = relayed
        perPeer[key, default: 0] += 1
        events(.accepted(id: relayed.id, path))

        relayed.handshakeTimer = timer(after: limits.handshakeTimeout) { [self] in close(relayed, .handshakeTimeout) }
        connection.stateUpdateHandler = { [self] state in
            switch state {
            case .ready:
                relayed.handshakeTimer?.cancel()
                relayed.handshakeTimer = nil
                relayed.idleTimer = timer(after: limits.idleTimeout) { [self] in close(relayed, .idle) }
                connectCore(relayed)
            case .failed, .waiting:
                close(relayed, relayed.core == nil ? .handshakeFailed : .ended)
            case .cancelled:
                close(relayed, .ended)
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    // MARK: Relay

    private func connectCore(_ relayed: Relayed) {
        guard !relayed.closed else { return }
        let core = NWConnection(to: .unix(path: configuration.socketPath), using: .tcp)
        relayed.core = core
        core.stateUpdateHandler = { [self] state in
            switch state {
            case .ready:
                guard !relayed.closed else { return }
                events(.relaying(id: relayed.id))
                core.send(content: helloLine(path: relayed.path, peer: relayed.peer), completion: .contentProcessed { [self] error in
                    if error != nil { close(relayed, .coreUnavailable) }
                })
                pump(relayed, from: relayed.connection, to: core)
                pump(relayed, from: core, to: relayed.connection)
            case .failed, .waiting:
                close(relayed, .coreUnavailable)
            default:
                break
            }
        }
        core.start(queue: queue)
    }

    /// Copies `source` to `sink`, one read at a time: the next read waits for
    /// the previous write, so a slow side holds at most one chunk here.
    private func pump(_ relayed: Relayed, from source: NWConnection, to sink: NWConnection) {
        source.receive(minimumIncompleteLength: 1, maximumLength: 64 << 10) { [self] data, _, isComplete, error in
            guard !relayed.closed else { return }
            if let data, !data.isEmpty {
                touch(relayed)
                sink.send(content: data, completion: .contentProcessed { [self] sendError in
                    guard !relayed.closed else { return }
                    if sendError != nil { return close(relayed, .ended) }
                    touch(relayed)
                    if isComplete { finish(relayed, sink: sink) } else { pump(relayed, from: source, to: sink) }
                })
            } else if error != nil {
                close(relayed, .ended)
            } else if isComplete {
                finish(relayed, sink: sink)
            } else {
                pump(relayed, from: source, to: sink)
            }
        }
    }

    /// One side ended: the other gets an end of stream after what was
    /// already sent, then both close.
    private func finish(_ relayed: Relayed, sink: NWConnection) {
        sink.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [self] _ in
            close(relayed, .ended)
        })
    }

    private func touch(_ relayed: Relayed) {
        relayed.idleTimer?.schedule(deadline: .now() + configuration.limits.idleTimeout.dispatch)
    }

    private func close(_ relayed: Relayed, _ reason: CloseReason) {
        guard !relayed.closed else { return }
        relayed.closed = true
        relayed.handshakeTimer?.cancel()
        relayed.idleTimer?.cancel()
        relayed.connection.cancel()
        relayed.core?.cancel()
        connections[relayed.id] = nil
        let remaining = perPeer[relayed.peerKey, default: 1] - 1
        perPeer[relayed.peerKey] = remaining > 0 ? remaining : nil
        events(.closed(id: relayed.id, reason))
    }

    private func timer(after duration: Duration, _ fire: @escaping @Sendable () -> Void) -> DispatchSourceTimer {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + duration.dispatch)
        timer.setEventHandler(handler: fire)
        timer.resume()
        return timer
    }
}

/// One accepted peer and its core connection; touched on the relay's queue only.
private final class Relayed: @unchecked Sendable {
    let id: Int
    let peerKey: String
    let peer: PeerAddress
    let path: PeerPath
    let connection: NWConnection
    var core: NWConnection?
    var handshakeTimer: DispatchSourceTimer?
    var idleTimer: DispatchSourceTimer?
    var closed = false

    init(id: Int, peerKey: String, peer: PeerAddress, path: PeerPath, connection: NWConnection) {
        self.id = id
        self.peerKey = peerKey
        self.peer = peer
        self.path = path
        self.connection = connection
    }
}

extension PeerAddress {
    init?(_ host: NWEndpoint.Host) {
        switch host {
        case .ipv4(let address):
            let bytes = Array(address.rawValue)
            guard bytes.count == 4 else { return nil }
            self = .v4(UInt32(bytes[0]) << 24 | UInt32(bytes[1]) << 16 | UInt32(bytes[2]) << 8 | UInt32(bytes[3]))
        case .ipv6(let address):
            let bytes = Array(address.rawValue)
            guard bytes.count == 16 else { return nil }
            self = .ipv6(bytes, zone: address.interface?.name)
        default:
            return nil
        }
    }
}

extension Duration {
    var dispatch: DispatchTimeInterval {
        let (seconds, attoseconds) = components
        return .nanoseconds(Int(seconds) * 1_000_000_000 + Int(attoseconds / 1_000_000_000))
    }
}
