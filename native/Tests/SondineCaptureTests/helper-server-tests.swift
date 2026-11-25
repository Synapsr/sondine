import Darwin
import Foundation
import Synchronization
import Testing
@testable import SondineCapture

/// A blocking JSON-lines client on the helper socket.
final class SocketClient {
    let fd: Int32
    private var framer = JSONLineFramer()
    private var pending: [Data] = []

    init(path: String) throws {
        fd = try UnixSocket.connect(path: path)
        var timeout = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    }

    deinit { close(fd) }

    func send(_ line: String) {
        let bytes = Array((line + "\n").utf8)
        _ = bytes.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
    }

    /// The next event, or nil at end of file.
    func next() throws -> HelperEvent? {
        while pending.isEmpty {
            var buffer = [UInt8](repeating: 0, count: 65_536)
            let count = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            if count == 0 { return nil }
            guard count > 0 else { throw SocketError("read: \(String(cString: strerror(errno)))") }
            for item in framer.push(buffer.prefix(count)) {
                if case .line(let line) = item { pending.append(line) }
            }
        }
        return try JSONDecoder().decode(HelperEvent.self, from: pending.removeFirst())
    }

    /// Events up to and including the ack of `id`.
    func until(ack id: String) throws -> [HelperEvent] {
        var events: [HelperEvent] = []
        while let event = try next() {
            events.append(event)
            if case .ack(let ack) = event, ack.replyTo == id { return events }
        }
        throw SocketError("connection closed before the ack of \(id)")
    }
}

@Suite(.serialized)
struct HelperServerTests {
    private static let hello = #"{"type":"hello","id":"h1","protocol":\#(HelperProtocol.version),"client":{"name":"sondine-core","version":"0.1.0"}}"#

    private func makeServer(_ harness: EngineHarness, options: HelperServer.Options = HelperServer.Options()) throws -> HelperServer {
        let server = HelperServer(socketPath: harness.directory.path + "/audio.sock", engine: harness.engine, options: options)
        try server.start()
        harness.engine.start()
        return server
    }

    @Test func helloReadySnapshotShutdownRoundTrip() throws {
        let harness = try EngineHarness()
        let server = try makeServer(harness)
        let done = Atomic<Bool>(false)
        server.onShutdownComplete = { done.store(true, ordering: .relaxed) }

        var info = stat()
        #expect(lstat(server.socketPath, &info) == 0)
        #expect(info.st_mode & 0o777 == 0o600)

        let client = try SocketClient(path: server.socketPath)
        client.send(Self.hello)
        guard case .ready(let ready) = try client.next() else {
            Issue.record("the first event must be ready")
            return
        }
        #expect(ready.replyTo == "h1")
        #expect(ready.protocolVersion == HelperProtocol.version)
        #expect(ready.sessionId == harness.engine.sessionId.uuidString.lowercased())

        client.send(#"{"type":"config","id":"c2","microphone":{"enabled":true,"followCalls":true,"allowedTransports":["built-in","usb"]},"systemAudio":{"enabled":true,"appTaps":{"enabled":false,"max":8,"releaseAfterIdleMs":30000,"releaseAfterSilenceMs":120000}},"excludedBundleIds":[],"holds":{"calls":false,"screen":false,"schedule":[],"networks":[],"networkKey":"","lifted":[]},"vad":{"threshold":0.5,"minSpeechMs":250,"minSilenceMs":800},"healthIntervalMs":60000}"#)
        _ = try client.until(ack: "c2")
        client.send(#"{"type":"snapshot","id":"s1"}"#)
        let snapshot = try client.until(ack: "s1").filter { $0.replyTo == "s1" }.map(\.type)
        #expect(snapshot == ["permissions", "devices", "processes", "activity", "clock", "situation", "holds", "ack"])

        client.send(#"{"type":"shutdown","id":"x"}"#)
        let tail = try client.until(ack: "x")
        #expect(tail.contains { if case .trackClose(let close) = $0 { close.reason == .shutdown } else { false } } || tail.last?.type == "ack")
        #expect(try client.next() == nil)
        try waitUntil { done.load(ordering: .relaxed) }
        #expect(harness.hal.startedIOProcs.isEmpty)
        server.stop()
        #expect(access(server.socketPath, F_OK) != 0)
    }

    @Test func theFirstMessageMustBeHelloAndASecondClientIsRefused() throws {
        let harness = try EngineHarness()
        let server = try makeServer(harness)
        let client = try SocketClient(path: server.socketPath)
        client.send(#"{"type":"snapshot","id":"s1"}"#)
        guard case .error(let error) = try client.next() else {
            Issue.record("expected an error")
            return
        }
        #expect(error.code == .requestInvalid)
        #expect(error.replyTo == "s1")

        let second = try SocketClient(path: server.socketPath)
        guard case .error(let refusal) = try second.next() else {
            Issue.record("expected a refusal")
            return
        }
        #expect(refusal.code == .requestRejected)
        #expect(try second.next() == nil)

        client.send("not json")
        guard case .error(let invalid) = try client.next() else {
            Issue.record("expected an error")
            return
        }
        #expect(invalid.code == .requestInvalid)
        harness.engine.stop()
        server.stop()
    }

    @Test func captureContinuesAcrossACoreReconnect() throws {
        let harness = try EngineHarness()
        let server = try makeServer(harness)
        do {
            let client = try SocketClient(path: server.socketPath)
            client.send(Self.hello)
            _ = try client.next()
            harness.engine.handle(.config(id: "c", CaptureConfig()))
            _ = try client.until(ack: "c")
        }
        try waitUntil { !server.isClientConnected }
        // Core is gone: capture runs on, durable events wait.
        for _ in 0..<12 { harness.feedMicrophone(seconds: 0.25) }
        #expect(harness.engine.state.microphoneRunId != nil)
        #expect(!harness.hal.startedIOProcs.isEmpty)

        let client = try SocketClient(path: server.socketPath)
        client.send(#"{"type":"hello","id":"h2","protocol":\#(HelperProtocol.version),"client":{"name":"sondine-core","version":"0.1.0"}}"#)
        guard case .ready = try client.next() else {
            Issue.record("expected ready")
            return
        }
        // The buffered run and commits arrive after ready.
        harness.engine.handle(.snapshot(id: "s"))
        let events = try client.until(ack: "s")
        #expect(events.contains { if case .trackOpen(let open) = $0 { open.replyTo == nil } else { false } })
        #expect(events.contains { $0.type == "commit" })
        harness.engine.stop()
        server.stop()
    }

    /// The index carried by a numbered test warning.
    private static func index(_ event: HelperEvent) -> Int? {
        guard case .warning(let warning) = event, warning.code == "test.buffered" else { return nil }
        return Int(warning.message)
    }

    @Test func aDisconnectDuringReplayKeepsTheUnsentEvents() throws {
        let harness = try EngineHarness()
        let server = try makeServer(harness)
        for index in 0..<1_000 { server.emit(.warning("test.buffered", String(index))) }
        server.sync()

        // Core reads ready and a few events, then goes away while the replay is under way.
        var first: [Int] = []
        do {
            let client = try SocketClient(path: server.socketPath)
            client.send(Self.hello)
            guard case .ready = try client.next() else {
                Issue.record("expected ready")
                return
            }
            for _ in 0..<8 { if let event = try client.next(), let index = Self.index(event) { first.append(index) } }
        }
        try waitUntil { !server.isClientConnected }
        #expect(first == Array(0..<8))

        let client = try SocketClient(path: server.socketPath)
        client.send(#"{"type":"hello","id":"h2","protocol":\#(HelperProtocol.version),"client":{"name":"sondine-core","version":"0.1.0"}}"#)
        guard case .ready = try client.next() else {
            Issue.record("expected ready")
            return
        }
        var second: [Int] = []
        while let event = try client.next() {
            if let index = Self.index(event) { second.append(index) }
            if second.last == 999 { break }
        }
        // What the first socket held in its kernel buffers (a few hundred short lines) is gone;
        // everything else is replayed, in order, without a hole.
        let start = try #require(second.first)
        #expect(second == Array(start...999))
        #expect(start < 500)
        harness.engine.stop()
        server.stop()
    }

    @Test func eventsBeyondTheBufferAreCountedAsDropped() throws {
        let harness = try EngineHarness()
        var options = HelperServer.Options()
        options.maxBufferedEvents = 10
        let server = try makeServer(harness, options: options)
        for index in 0..<15 { server.emit(.warning("test.buffered", String(index))) }
        let client = try SocketClient(path: server.socketPath)
        client.send(Self.hello)
        _ = try client.next()
        var indices: [Int] = []
        var dropped: WarningEvent?
        while dropped == nil, let event = try client.next() {
            if let index = Self.index(event) { indices.append(index) }
            if case .warning(let warning) = event, warning.code == "events.dropped" { dropped = warning }
        }
        #expect(indices == Array(5..<15))
        #expect(dropped?.message.hasPrefix("5 events") == true)
        harness.engine.stop()
        server.stop()
    }

    @Test func repliesGoOnlyToTheConnectionThatAsked() throws {
        let harness = try EngineHarness()
        let server = try makeServer(harness)
        // The engine is busy: A's hello is queued when A leaves.
        harness.engine.queue.suspend()
        do {
            let client = try SocketClient(path: server.socketPath)
            client.send(Self.hello)
            try waitUntil { server.forwardedRequests == 1 }
        }
        try waitUntil { !server.isClientConnected }
        let client = try SocketClient(path: server.socketPath)
        try waitUntil { server.isClientConnected }
        // B reuses A's request id.
        client.send(Self.hello)
        try waitUntil { server.forwardedRequests == 2 }
        harness.engine.queue.resume()

        guard case .ready(let ready) = try client.next() else {
            Issue.record("expected ready")
            return
        }
        #expect(ready.replyTo == "h1")
        client.send(#"{"type":"snapshot","id":"s1"}"#)
        let events = try client.until(ack: "s1")
        // A's ready never reached B.
        #expect(!events.contains { $0.type == "ready" })
        harness.engine.stop()
        server.stop()
    }

    @Test func aStaleReadyDoesNotGreetTheNextClient() throws {
        let harness = try EngineHarness()
        let server = try makeServer(harness)
        harness.engine.queue.suspend()
        do {
            let client = try SocketClient(path: server.socketPath)
            client.send(Self.hello)
            try waitUntil { server.forwardedRequests == 1 }
        }
        try waitUntil { !server.isClientConnected }
        let client = try SocketClient(path: server.socketPath)
        try waitUntil { server.isClientConnected }
        harness.engine.queue.resume()
        harness.engine.sync()
        server.sync()
        // B never said hello, so it may not take a snapshot.
        client.send(#"{"type":"snapshot","id":"s1"}"#)
        guard case .error(let error) = try client.next() else {
            Issue.record("expected an error")
            return
        }
        #expect(error.code == .requestInvalid)
        #expect(error.replyTo == "s1")
        harness.engine.stop()
        server.stop()
    }

    @Test func anUnsupportedHelloClosesTheConnectionButNotTheHelper() throws {
        let harness = try EngineHarness()
        let server = try makeServer(harness)
        let shutdowns = Atomic<Int>(0)
        server.onShutdownComplete = { shutdowns.add(1, ordering: .relaxed) }
        do {
            let client = try SocketClient(path: server.socketPath)
            client.send(Self.hello)
            _ = try client.next()
            harness.engine.handle(.config(id: "c", CaptureConfig()))
            _ = try client.until(ack: "c")
            client.send(#"{"type":"hello","id":"h9","protocol":99,"client":{"name":"sondine-core","version":"9.0.0"}}"#)
            var error: ErrorEvent?
            while let event = try client.next() {
                if case .error(let found) = event, found.replyTo == "h9" { error = found }
            }
            #expect(error?.code == .protocolUnsupported)
        }
        try waitUntil { !server.isClientConnected }
        server.sync()
        #expect(shutdowns.load(ordering: .relaxed) == 0)
        #expect(!harness.hal.startedIOProcs.isEmpty)

        // The helper still serves the next core.
        let client = try SocketClient(path: server.socketPath)
        client.send(#"{"type":"hello","id":"h2","protocol":\#(HelperProtocol.version),"client":{"name":"sondine-core","version":"0.1.0"}}"#)
        guard case .ready = try client.next() else {
            Issue.record("expected ready")
            return
        }
        client.send(#"{"type":"shutdown","id":"x"}"#)
        _ = try client.until(ack: "x")
        try waitUntil { shutdowns.load(ordering: .relaxed) == 1 }
        server.stop()
    }

    @Test func unsafeSocketLocationsAreRefused() throws {
        let directory = try ScratchDirectory()
        #expect(throws: SocketError.self) { try UnixSocket.prepare(path: "relative.sock") }
        #expect(throws: SocketError.self) { try UnixSocket.prepare(path: directory.path + "/missing/audio.sock") }
        #expect(throws: SocketError.self) { try UnixSocket.prepare(path: "/" + String(repeating: "a", count: 120)) }
        // A directory others can write to.
        let shared = directory.url.appending(path: "shared")
        try FileManager.default.createDirectory(at: shared, withIntermediateDirectories: false)
        chmod(shared.path(percentEncoded: false), 0o777)
        #expect(throws: SocketError.self) { try UnixSocket.prepare(path: shared.path(percentEncoded: false) + "/audio.sock") }
        // A directory owned by someone else.
        #expect(throws: SocketError.self) { try UnixSocket.prepare(path: "/usr/audio.sock") }
        // A regular file in the way.
        let file = directory.path + "/audio.sock"
        FileManager.default.createFile(atPath: file, contents: Data())
        #expect(throws: SocketError.self) { try UnixSocket.prepare(path: file) }
    }
}
