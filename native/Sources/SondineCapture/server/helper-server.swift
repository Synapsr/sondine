import Darwin
import Dispatch
import Foundation

/// Serves the JSON-lines protocol to one core client at a time over the private Unix socket.
///
/// Capture never depends on the connection: while no client is connected (core restarting),
/// durable events (commits, track and region events, problems) wait in a bounded FIFO and are
/// sent after the next `ready`; state events are dropped because core asks for a `snapshot`
/// after reconnecting. Durable events a connection did not take before it closed go back to
/// the front of that FIFO; what the FIFO cannot hold is counted and reported as
/// `events.dropped`. The spool keeps every sample either way.
///
/// Each connection has a generation. Requests reach the engine tagged with it, and replies go
/// only to the connection that asked, while it is open.
public final class HelperServer: CaptureEventSink, @unchecked Sendable {
    public struct Options: Sendable {
        public var maxBufferedEvents = 16_384
        /// A client that stops reading is dropped past this much pending output.
        public var maxPendingBytes = 8 * 1_024 * 1_024
        /// Buffered events move to a connection in slices of about this size, so a replay never
        /// counts as a client that stopped reading.
        public var replayWindowBytes = 256 * 1_024
        /// After `shutdown` is acknowledged, a client that does not read its last lines is
        /// closed after this long.
        public var shutdownFlushSeconds = 2.0
        public init() {}
    }

    private struct Line {
        var data: Data
        var durable: Bool
    }

    private final class Client {
        let fd: Int32
        let generation: UInt64
        var readSource: DispatchSourceRead?
        var writeSource: DispatchSourceWrite?
        var framer = JSONLineFramer()
        /// Lines not fully written yet, oldest first; `sentBytes` of the first are on the wire.
        var queue: [Line] = []
        var queueStart = 0
        var sentBytes = 0
        var pendingBytes = 0
        var greeted = false
        /// Close this connection once its output is written (the helper keeps running).
        var closeAfterFlush = false
        var isOpen = true

        init(fd: Int32, generation: UInt64) {
            self.fd = fd
            self.generation = generation
        }

        var hasQueuedLines: Bool { queueStart < queue.count }
    }

    public let socketPath: String
    public let options: Options
    public let engine: CaptureEngine
    private let queue = DispatchQueue(label: "app.sondine.audio.server", qos: .utility)
    private var listenFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    private var client: Client?
    private var nextGeneration: UInt64 = 0
    /// Durable events waiting for a greeted client; while one replays, also its live events.
    private var backlog: [Line] = []
    private var backlogStart = 0
    private var dropped = 0
    private var forwarded = 0
    private var closed = false
    private var shutdownRequested = false
    private var shutdownCompleted = false
    /// Called once the `shutdown` ack was written and the connection closed.
    public var onShutdownComplete: (@Sendable () -> Void)?

    public init(socketPath: String, engine: CaptureEngine, options: Options = Options()) {
        self.socketPath = socketPath
        self.engine = engine
        self.options = options
    }

    /// Validates the socket location, binds (0600) and starts accepting.
    public func start() throws {
        let fd = try UnixSocket.listen(path: socketPath)
        engine.sink = self
        engine.onShutdown = { [weak self] in self?.shutdownAcknowledged() }
        queue.sync {
            listenFD = fd
            let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
            source.setEventHandler { [weak self] in self?.acceptClients() }
            source.resume()
            acceptSource = source
        }
    }

    /// Closes the client and the listener and removes the socket file.
    public func stop() {
        queue.sync {
            guard !closed else { return }
            closed = true
            if let client { disconnect(client) }
            acceptSource?.cancel()
            acceptSource = nil
            if listenFD >= 0 {
                close(listenFD)
                listenFD = -1
                unlink(socketPath)
            }
        }
    }

    /// Waits for queued server work (tests).
    public func sync() { queue.sync {} }

    public var isClientConnected: Bool { queue.sync { client != nil } }

    /// Requests handed to the engine so far (tests).
    var forwardedRequests: Int { queue.sync { forwarded } }

    // MARK: CaptureEventSink

    public func emit(_ event: HelperEvent) {
        let routed = event.replyTo.flatMap(Self.untag)
        let event = routed.map { event.replying(to: $0.id) } ?? event
        let target = routed?.generation
        let line: Data
        do {
            line = try event.encodedLine()
        } catch {
            fputs("sondine-audio: cannot encode \(event.type): \(error)\n", stderr)
            return
        }
        let isReply = event.replyTo != nil
        let durable = Self.isDurable(event)
        let isReady: Bool = if case .ready = event { true } else { false }
        queue.async { [weak self] in self?.deliver(Line(data: line, durable: durable), isReply: isReply, isReady: isReady, target: target) }
    }

    static func isDurable(_ event: HelperEvent) -> Bool {
        switch event {
        case .commit, .trackOpen, .trackUpdate, .trackClose, .regionOpen, .regionClose, .call, .listen, .warning, .error:
            event.replyTo == nil
        default:
            false
        }
    }

    // MARK: Request routing

    /// Request ids cannot contain `#` (`WireText.isRequestId`), so the tag is unambiguous.
    private static func tag(_ id: String, generation: UInt64) -> String { "\(generation)#\(id)" }

    private static func untag(_ replyTo: String) -> (generation: UInt64, id: String)? {
        guard let separator = replyTo.firstIndex(of: "#"), let generation = UInt64(replyTo[..<separator]) else { return nil }
        return (generation, String(replyTo[replyTo.index(after: separator)...]))
    }

    private func forward(_ message: ControlMessage, from client: Client) {
        forwarded += 1
        engine.handle(message.with(id: Self.tag(message.id, generation: client.generation)))
    }

    // MARK: Delivery

    private func deliver(_ line: Line, isReply: Bool, isReady: Bool, target: UInt64?) {
        guard !closed else { return }
        if isReply {
            // A tagged reply goes to the connection that asked; an untagged one (a request the
            // engine got directly) to the current connection.
            guard let client, client.isOpen, target == nil || target == client.generation else { return }
            if client.greeted {
                send(line, to: client)
            } else {
                enqueue(line, to: client)
                if isReady {
                    client.greeted = true
                    pump(client)
                } else {
                    flush(client)
                }
            }
            return
        }
        if let client, client.greeted {
            send(line, to: client)
            return
        }
        // No greeted client: keep durable events for the next one.
        guard line.durable else { return }
        backlog.append(line)
        trimBacklog()
    }

    /// Live output for a greeted client, behind any replay still under way.
    private func send(_ line: Line, to client: Client) {
        if backlogStart < backlog.count {
            backlog.append(line)
            trimBacklog()
            pump(client)
        } else {
            enqueue(line, to: client)
            flush(client)
        }
        if client.isOpen, client.pendingBytes > options.maxPendingBytes {
            fputs("sondine-audio: core is not reading; dropping the connection\n", stderr)
            disconnect(client)
        }
    }

    private func enqueue(_ line: Line, to client: Client) {
        client.queue.append(line)
        client.pendingBytes += line.data.count
    }

    /// Moves buffered lines to the client a window at a time, then the `events.dropped` notice.
    private func pump(_ client: Client) {
        while client.isOpen, client.greeted {
            while backlogStart < backlog.count, client.pendingBytes < options.replayWindowBytes {
                enqueue(backlog[backlogStart], to: client)
                backlogStart += 1
            }
            if backlogStart == backlog.count {
                backlog.removeAll(keepingCapacity: backlog.count < 4_096)
                backlogStart = 0
                if dropped > 0 {
                    let warning = HelperEvent.warning("events.dropped", "\(dropped) events were dropped while core was disconnected; read the manifests.")
                    if let data = try? warning.encodedLine() { enqueue(Line(data: data, durable: true), to: client) }
                    dropped = 0
                }
            } else if backlogStart > 4_096 {
                backlog.removeFirst(backlogStart)
                backlogStart = 0
            }
            // Wait for the socket when it is full; go on while it takes everything.
            guard flush(client), backlogStart < backlog.count else { return }
        }
    }

    /// Bounds the backlog. A greeted client whose backlog overflows is not reading: it is closed
    /// first (its durable lines come back), then the oldest durable events are dropped.
    private func trimBacklog() {
        guard backlog.count - backlogStart > options.maxBufferedEvents else { return }
        if let client, client.greeted, client.isOpen {
            fputs("sondine-audio: core is not reading; dropping the connection\n", stderr)
            disconnect(client)
        }
        let excess = backlog.count - backlogStart - options.maxBufferedEvents
        guard excess > 0 else { return }
        dropped += backlog[backlogStart..<backlogStart + excess].filter(\.durable).count
        backlogStart += excess
        if backlogStart > 4_096 {
            backlog.removeFirst(backlogStart)
            backlogStart = 0
        }
    }

    /// Writes what the socket takes. Returns true when the client's queue is empty.
    @discardableResult
    private func flush(_ client: Client) -> Bool {
        while client.isOpen, client.hasQueuedLines {
            let data = client.queue[client.queueStart].data
            let written = data.withUnsafeBytes { bytes in
                Darwin.write(client.fd, bytes.baseAddress! + client.sentBytes, bytes.count - client.sentBytes)
            }
            if written > 0 {
                client.sentBytes += written
                client.pendingBytes -= written
                if client.sentBytes == data.count {
                    client.queueStart += 1
                    client.sentBytes = 0
                }
                continue
            }
            if written < 0, errno == EINTR { continue }
            if written < 0, errno == EAGAIN || errno == EWOULDBLOCK {
                armWriteSource(client)
                return false
            }
            disconnect(client)
            return false
        }
        guard client.isOpen else { return false }
        client.queue.removeAll(keepingCapacity: true)
        client.queueStart = 0
        client.writeSource?.cancel()
        client.writeSource = nil
        if client.closeAfterFlush {
            disconnect(client)
            return false
        }
        return true
    }

    private func armWriteSource(_ client: Client) {
        guard client.writeSource == nil else { return }
        let source = DispatchSource.makeWriteSource(fileDescriptor: client.fd, queue: queue)
        source.setEventHandler { [weak self, weak client] in
            guard let self, let client, client.isOpen else { return }
            if self.flush(client) { self.pump(client) }
        }
        source.resume()
        client.writeSource = source
    }

    // MARK: Connections

    private func acceptClients() {
        while true {
            let fd = accept(listenFD, nil, nil)
            guard fd >= 0 else { return }
            UnixSocket.setNonBlocking(fd)
            guard UnixSocket.peerIsSameUser(fd) else {
                close(fd)
                continue
            }
            if client != nil {
                // One core at a time; a second client learns why and is closed.
                let refusal = HelperEvent.error(.requestRejected, "Another core client is connected.")
                if let line = try? refusal.encodedLine() { _ = line.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) } }
                close(fd)
                continue
            }
            nextGeneration += 1
            let connection = Client(fd: fd, generation: nextGeneration)
            let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
            source.setEventHandler { [weak self, weak connection] in
                guard let self, let connection, connection.isOpen else { return }
                self.read(connection)
            }
            source.resume()
            connection.readSource = source
            client = connection
        }
    }

    private func read(_ client: Client) {
        var buffer = [UInt8](repeating: 0, count: 65_536)
        let count = buffer.withUnsafeMutableBytes { Darwin.read(client.fd, $0.baseAddress, $0.count) }
        if count < 0, errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR { return }
        guard count > 0 else {
            disconnect(client)
            return
        }
        for item in client.framer.push(buffer.prefix(count)) {
            guard client.isOpen, !client.closeAfterFlush else { return }
            switch item {
            case .oversized:
                reply(.error(.requestInvalid, "Line exceeds 1 MiB."), to: client)
            case .line(let line):
                handle(line, from: client)
            }
        }
    }

    private func handle(_ line: Data, from client: Client) {
        switch ControlMessage.decode(line: line) {
        case .failure(let failure):
            let event = HelperEvent.error(failure.code, failure.message, replyTo: failure.id)
            reply(event, to: client)
            if failure.code == .protocolUnsupported {
                // This connection closes; the helper keeps capturing for the next client.
                client.closeAfterFlush = true
                flush(client)
            }
        case .success(let message):
            if !client.greeted, case .hello = message {
                forward(message, from: client)
            } else if !client.greeted {
                reply(.error(.requestInvalid, "The first message must be hello.", replyTo: message.id), to: client)
            } else if case .hello = message {
                reply(.error(.requestInvalid, "hello was already received.", replyTo: message.id), to: client)
            } else {
                forward(message, from: client)
            }
        }
    }

    /// The server's own replies (decoding and handshake errors) go straight to the connection.
    private func reply(_ event: HelperEvent, to client: Client) {
        guard let data = try? event.encodedLine() else { return }
        enqueue(Line(data: data, durable: false), to: client)
        flush(client)
    }

    /// Idempotent. Durable lines the connection had not fully written go back to the front of
    /// the backlog; its replies and state events go with it.
    private func disconnect(_ client: Client) {
        guard client.isOpen else { return }
        client.isOpen = false
        client.readSource?.cancel()
        client.writeSource?.cancel()
        client.readSource = nil
        client.writeSource = nil
        close(client.fd)
        let unsent = client.queue[client.queueStart...].filter(\.durable)
        client.queue.removeAll()
        client.queueStart = 0
        client.pendingBytes = 0
        backlog = unsent + backlog[backlogStart...].filter(\.durable)
        backlogStart = 0
        if self.client === client { self.client = nil }
        trimBacklog()
        if shutdownRequested { completeShutdown() }
    }

    // MARK: Shutdown

    /// Only an acknowledged `shutdown` stops the helper: the connection closes once the ack
    /// and what precedes it are written (or after `shutdownFlushSeconds`).
    private func shutdownAcknowledged() {
        queue.async { [weak self] in
            guard let self else { return }
            self.shutdownRequested = true
            guard let client = self.client else {
                self.completeShutdown()
                return
            }
            client.closeAfterFlush = true
            self.flush(client)
            let generation = client.generation
            self.queue.asyncAfter(deadline: .now() + self.options.shutdownFlushSeconds) { [weak self] in
                guard let self else { return }
                if let client = self.client, client.generation == generation { self.disconnect(client) }
                self.completeShutdown()
            }
        }
    }

    private func completeShutdown() {
        guard !shutdownCompleted else { return }
        shutdownCompleted = true
        onShutdownComplete?()
    }
}

extension ControlMessage {
    /// The same request under another id (the server's connection tag).
    func with(id: String) -> ControlMessage {
        switch self {
        case .hello(_, let client): .hello(id: id, client: client)
        case .config(_, let config): .config(id: id, config)
        case .excludePids(_, let pids): .excludePids(id: id, pids: pids)
        case .pinInput(_, let uid, let allowBluetooth): .pinInput(id: id, deviceUid: uid, allowBluetooth: allowBluetooth)
        case .pause(_, let scope): .pause(id: id, scope: scope)
        case .resume(_, let scope): .resume(id: id, scope: scope)
        case .snapshot: .snapshot(id: id)
        case .shutdown: .shutdown(id: id)
        case .requestPermissions(_, let scope): .requestPermissions(id: id, scope: scope)
        }
    }
}
