import Darwin
import Foundation
import Network
@testable import SondineLan
import os
import Testing

enum Paths {
    /// native/
    static let native = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static let repository = native.deletingLastPathComponent()
    static let lanEntitlements = repository.appending(path: "apps/desktop/build/entitlements.lan.plist")

    /// The built `sondine-lan`: next to the test bundle, else `.build/debug`.
    static var binary: URL? {
        let bundle = Bundle.allBundles.first { $0.bundleURL.pathExtension == "xctest" }
        return [bundle?.bundleURL.deletingLastPathComponent(), native.appending(path: ".build/debug")]
            .compactMap { $0?.appending(path: "sondine-lan") }
            .first { FileManager.default.isExecutableFile(atPath: $0.path(percentEncoded: false)) }
    }
}

struct TestFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// A new folder in the temporary directory.
func scratch() throws -> URL {
    let url = URL(filePath: NSTemporaryDirectory()).appending(path: "sondine-lan-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// Runs a tool to completion; stdout and stderr captured.
@discardableResult
func run(_ executable: String, _ arguments: [String], stdin: FileHandle? = nil) throws -> (status: Int32, stdout: String, stderr: String) {
    let process = Process()
    process.executableURL = URL(filePath: executable)
    process.arguments = arguments
    process.standardInput = stdin ?? FileHandle.nullDevice
    let out = Pipe()
    let err = Pipe()
    process.standardOutput = out
    process.standardError = err
    try process.run()
    let stdout = out.fileHandleForReading.readDataToEndOfFile()
    let stderr = err.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return (process.terminationStatus, String(decoding: stdout, as: UTF8.self), String(decoding: stderr, as: UTF8.self))
}

/// A throwaway identity made as core makes it: a P-256 key, a self-signed
/// certificate and a PKCS #12 with a password, all by /usr/bin/openssl.
/// Its folder goes with it.
final class TestIdentity {
    let folder: URL
    let p12: URL
    let passwordFile: URL
    let password = "correct horse \(UUID().uuidString.prefix(6))"
    /// SHA-256 of the SPKI DER, as openssl computes it.
    let pin: String

    /// - Parameter key: writes the private key to the path it is given;
    ///   by default a P-256 key, made again until its DER form is 121 bytes:
    ///   /usr/bin/openssl writes a key whose top byte is zero in 31 bytes
    ///   instead of 32 (about one in 256), and macOS refuses it
    ///   (`aKeyWrittenInFewerThan32BytesIsRefused`).
    init(key makeKey: ((String) throws -> Void)? = nil) throws {
        folder = try scratch()
        let key = folder.appending(path: "key.pem").path(percentEncoded: false)
        let certificate = folder.appending(path: "cert.pem").path(percentEncoded: false)
        p12 = folder.appending(path: "identity.p12")
        passwordFile = folder.appending(path: "password")
        try Data((password + "\n").utf8).write(to: passwordFile)
        let openssl = "/usr/bin/openssl"
        if let makeKey {
            try makeKey(key)
        } else {
            let der = folder.appending(path: "key.der")
            repeat {
                try Self.check(run(openssl, ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key]))
                try Self.check(run(openssl, ["ec", "-in", key, "-outform", "DER", "-out", der.path(percentEncoded: false)]))
            } while try Data(contentsOf: der).count != 121
        }
        try Self.check(run(openssl, ["req", "-new", "-x509", "-key", key, "-out", certificate, "-days", "3650", "-subj", "/CN=Sondine"]))
        try Self.check(run(openssl, [
            "pkcs12", "-export", "-inkey", key, "-in", certificate, "-out", p12.path(percentEncoded: false),
            "-passout", "file:" + passwordFile.path(percentEncoded: false),
        ]))
        let der = folder.appending(path: "spki.der").path(percentEncoded: false)
        try Self.check(run(openssl, ["pkey", "-in", key, "-pubout", "-outform", "DER", "-out", der]))
        let digest = try run(openssl, ["dgst", "-sha256", "-r", der])
        try Self.check(digest)
        pin = String(digest.stdout.prefix(64))
    }

    deinit { try? FileManager.default.removeItem(at: folder) }

    func load() throws -> LanIdentity {
        try LanIdentity.load(p12: p12, passwordFile: passwordFile)
    }

    static func check(_ result: (status: Int32, stdout: String, stderr: String)) throws {
        if result.status != 0 { throw TestFailure("openssl: \(result.stderr)") }
    }
}

/// Core's side of the phone socket, for tests: a Unix socket server.
final class UnixServer: @unchecked Sendable {
    let path: String
    private let fd: Int32

    init() throws {
        path = NSTemporaryDirectory() + "sl-\(UUID().uuidString.prefix(8)).sock"
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0, listen(fd, 16) == 0 else { throw TestFailure("cannot listen on \(path)") }
    }

    deinit {
        close(fd)
        unlink(path)
    }

    /// The next connection, or nil after `timeout`.
    func accept(timeout: Duration = .seconds(5)) -> UnixPeer? {
        guard wait(fd, timeout) else { return nil }
        let client = Darwin.accept(fd, nil, nil)
        return client >= 0 ? UnixPeer(fd: client) : nil
    }
}

final class UnixPeer: @unchecked Sendable {
    let fd: Int32
    private var buffer = Data()

    init(fd: Int32) { self.fd = fd }
    deinit { close(fd) }

    /// Reads what is available into the buffer; false at end of file or after `timeout`.
    private func fill(until deadline: ContinuousClock.Instant) -> Bool {
        let left = deadline - ContinuousClock.now
        guard left > .zero, wait(fd, left) else { return false }
        var chunk = [UInt8](repeating: 0, count: 64 << 10)
        let got = Darwin.read(fd, &chunk, chunk.count)
        if got <= 0 { return false }
        buffer.append(contentsOf: chunk[0..<got])
        return true
    }

    /// Exactly `count` bytes, or what came before `timeout` or end of file.
    func read(_ count: Int, timeout: Duration = .seconds(5)) -> Data {
        let deadline = ContinuousClock.now + timeout
        while buffer.count < count, fill(until: deadline) {}
        let taken = Data(buffer.prefix(count))
        buffer.removeFirst(taken.count)
        return taken
    }

    /// One line, without its newline.
    func line(timeout: Duration = .seconds(5)) -> String? {
        let deadline = ContinuousClock.now + timeout
        while buffer.firstIndex(of: 0x0A) == nil {
            guard fill(until: deadline) else { return nil }
        }
        let newline = buffer.firstIndex(of: 0x0A)!
        let line = String(decoding: buffer[buffer.startIndex..<newline], as: UTF8.self)
        buffer.removeSubrange(buffer.startIndex...newline)
        return line
    }

    /// Ends the connection both ways, as core closing it.
    func end() {
        shutdown(fd, SHUT_RDWR)
    }

    func write(_ data: Data) {
        _ = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!, $0.count) }
    }

    /// Whether the other side closed before `timeout`; bytes before the end are skipped.
    func sawEnd(timeout: Duration = .seconds(5)) -> Bool {
        let deadline = ContinuousClock.now + timeout
        while true {
            let left = deadline - ContinuousClock.now
            guard left > .zero, wait(fd, left) else { return false }
            var chunk = [UInt8](repeating: 0, count: 4096)
            if Darwin.read(fd, &chunk, chunk.count) <= 0 { return true }
        }
    }
}

private func wait(_ fd: Int32, _ timeout: Duration) -> Bool {
    var poller = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
    let milliseconds = Int32(timeout.components.seconds * 1_000 + timeout.components.attoseconds / 1_000_000_000_000_000)
    return poll(&poller, 1, max(milliseconds, 1)) > 0
}

/// The phone's side, for tests: a Network.framework client, TLS 1.3 pinned
/// to the Mac's key as the app pins it, or plain TCP.
final class TestClient: @unchecked Sendable {
    let connection: NWConnection
    private let queue = DispatchQueue(label: "test-client")
    private let state = OSAllocatedUnfairLock<NWConnection.State>(initialState: .setup)

    init(host: String = "127.0.0.1", port: UInt16, tls pin: String?, maxVersion: tls_protocol_version_t = .TLSv13) {
        let parameters: NWParameters
        if let pin {
            let tls = NWProtocolTLS.Options()
            let options = tls.securityProtocolOptions
            sec_protocol_options_set_min_tls_protocol_version(options, .TLSv12)
            sec_protocol_options_set_max_tls_protocol_version(options, maxVersion)
            sec_protocol_options_set_verify_block(options, { _, trust, complete in
                let chain = SecTrustCopyCertificateChain(sec_trust_copy_ref(trust).takeRetainedValue()) as? [SecCertificate]
                let leaf = chain?.first
                complete(leaf.flatMap { try? LanIdentity.pin(of: $0) } == pin)
            }, DispatchQueue(label: "verify"))
            parameters = NWParameters(tls: tls)
        } else {
            parameters = .tcp
        }
        connection = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port)!, using: parameters)
        connection.stateUpdateHandler = { [state] new in state.withLock { $0 = new } }
        connection.start(queue: queue)
    }

    deinit { connection.cancel() }

    var isReady: Bool { state.withLock { if case .ready = $0 { true } else { false } } }
    var hasFailed: Bool {
        state.withLock {
            switch $0 {
            case .failed, .cancelled, .waiting: true
            default: false
            }
        }
    }

    func send(_ data: Data) {
        connection.send(content: data, completion: .idempotent)
    }

    /// Up to `count` bytes, or what arrived before the end; nil on error.
    func receive(_ count: Int, timeout: Duration = .seconds(5)) async -> Data? {
        let received = OSAllocatedUnfairLock(initialState: Data())
        let deadline = ContinuousClock.now + timeout
        while received.withLock({ $0.count }) < count, ContinuousClock.now < deadline {
            let chunk: (Data?, Bool) = await withCheckedContinuation { continuation in
                connection.receive(minimumIncompleteLength: 1, maximumLength: count - received.withLock { $0.count }) { data, _, complete, error in
                    continuation.resume(returning: (error == nil ? data ?? Data() : nil, complete))
                }
            }
            guard let data = chunk.0 else { return nil }
            received.withLock { $0.append(data) }
            if chunk.1 { break }
        }
        return received.withLock { $0 }
    }

    /// Whether the server ended the stream or the connection; bytes before the end are skipped.
    func sawEnd(timeout: Duration = .seconds(5)) async -> Bool {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if hasFailed { return true }
            let left = deadline - ContinuousClock.now
            // true: ended; false: timed out; nil: bytes came, read on.
            let outcome: Bool? = await withCheckedContinuation { continuation in
                let once = OSAllocatedUnfairLock(initialState: false)
                let finish: @Sendable (Bool?) -> Void = { value in
                    if once.withLock({ let first = !$0; $0 = true; return first }) { continuation.resume(returning: value) }
                }
                connection.receive(minimumIncompleteLength: 1, maximumLength: 64 << 10) { data, _, complete, error in
                    finish(complete || error != nil ? true : (data?.isEmpty == false ? nil : true))
                }
                queue.asyncAfter(deadline: .now() + left.dispatch) { finish(false) }
            }
            if let outcome { return outcome }
        }
        return false
    }
}

/// Polls `condition` until it holds or `timeout` passes.
func eventually(timeout: Duration = .seconds(5), _ condition: () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
}

/// A relay started in this process, with its events recorded.
final class RunningRelay: @unchecked Sendable {
    let relay: LanRelay
    let server: UnixServer
    let identity: TestIdentity
    private let recorded = OSAllocatedUnfairLock<[RelayEvent]>(initialState: [])

    init(policy: PeerPolicy = PeerPolicy(loopback: true), limits: RelayLimits = RelayLimits(), socketPath: String? = nil) throws {
        identity = try TestIdentity()
        server = try UnixServer()
        let configuration = LanRelayConfiguration(
            port: 0, socketPath: socketPath ?? server.path, serviceName: nil, policy: policy, limits: limits
        )
        let recorded = recorded
        relay = LanRelay(identity: try identity.load(), configuration: configuration) { event in
            recorded.withLock { $0.append(event) }
        }
        try relay.start()
    }

    deinit { relay.stop {} }

    var events: [RelayEvent] { recorded.withLock { $0 } }

    func port() async throws -> UInt16 {
        guard await eventually({ events.contains { if case .listening = $0 { true } else { false } } }) else {
            throw TestFailure("not listening: \(events)")
        }
        for case .listening(let port) in events { return port }
        throw TestFailure("unreachable")
    }

    func count(_ predicate: (RelayEvent) -> Bool) -> Int { events.filter(predicate).count }

    func client(host: String = "127.0.0.1", tls: Bool = true, maxVersion: tls_protocol_version_t = .TLSv13) async throws -> TestClient {
        TestClient(host: host, port: try await port(), tls: tls ? identity.pin : nil, maxVersion: maxVersion)
    }
}
