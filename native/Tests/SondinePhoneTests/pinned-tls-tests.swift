import Foundation
@preconcurrency import Network
import Security
import SondinePhone
import Synchronization
import Testing

/// The real transport over real TLS 1.3 on loopback, against a self-signed
/// P-256 certificate made as core makes it: the pinned key is the only thing
/// trusted, and any other key is refused before a byte of request leaves.
@Suite struct PinnedTlsTests {
    /// A key, its self-signed certificate, the identity in memory, and the pin openssl computes.
    private static func identity() throws -> (SecIdentity, String) {
        let folder = try scratch()
        func openssl(_ arguments: [String]) throws -> Data {
            let process = Process()
            process.executableURL = URL(filePath: "/usr/bin/openssl")
            process.arguments = arguments
            process.currentDirectoryURL = folder
            let out = Pipe()
            process.standardOutput = out
            process.standardError = Pipe()
            try process.run()
            let data = out.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { throw RequireError(message: "openssl \(arguments)") }
            return data
        }
        _ = try openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "key.pem"])
        _ = try openssl(["req", "-x509", "-new", "-key", "key.pem", "-sha256", "-out", "cert.pem", "-days", "1", "-subj", "/CN=Sondine"])
        _ = try openssl(["pkey", "-in", "key.pem", "-pubout", "-outform", "DER", "-out", "spki.der"])
        let digest = try openssl(["dgst", "-sha256", "-hex", "spki.der"])
        let pin = String(decoding: digest, as: UTF8.self).split(separator: " ").last.map {
            $0.trimmingCharacters(in: .whitespacesAndNewlines)
        } ?? ""
        _ = try openssl(["pkcs12", "-export", "-inkey", "key.pem", "-in", "cert.pem", "-out", "id.p12", "-passout", "pass:sondine"])
        let p12 = try Data(contentsOf: folder.appending(path: "id.p12"))
        var items: CFArray?
        let options: [String: Any] = [kSecImportExportPassphrase as String: "sondine", kSecImportToMemoryOnly as String: true]
        guard SecPKCS12Import(p12 as CFData, options as CFDictionary, &items) == errSecSuccess,
              let first = (items as? [[String: Any]])?.first,
              let identity = first[kSecImportItemIdentity as String]
        else { throw RequireError(message: "PKCS12 import") }
        return (identity as! SecIdentity, pin)
    }

    /// A one-answer HTTPS server on loopback: TLS 1.3 with the identity, `{"status":"forgotten"}` to a
    /// POST, and to a GET with a range the bytes of a 100-byte body that count up from zero.
    private final class Server: Sendable {
        let listener: NWListener
        let requests = Counter()

        init(identity: SecIdentity) throws {
            let tls = NWProtocolTLS.Options()
            sec_protocol_options_set_local_identity(tls.securityProtocolOptions, sec_identity_create(identity)!)
            sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv13)
            listener = try NWListener(using: NWParameters(tls: tls), on: .any)
            let requests = requests
            listener.newConnectionHandler = { connection in
                connection.start(queue: .global())
                Server.answer(connection, received: Data(), requests: requests)
            }
        }

        func start() async throws -> Int {
            let ready = Mutex<CheckedContinuation<Int, any Error>?>(nil)
            return try await withCheckedThrowingContinuation { continuation in
                ready.withLock { $0 = continuation }
                listener.stateUpdateHandler = { [listener] state in
                    switch state {
                    case .ready:
                        ready.withLock { $0?.resume(returning: Int(listener.port?.rawValue ?? 0)); $0 = nil }
                    case let .failed(error):
                        ready.withLock { $0?.resume(throwing: error); $0 = nil }
                    default: break
                    }
                }
                listener.start(queue: .global())
            }
        }

        private static func answer(_ connection: NWConnection, received: Data, requests: Counter) {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, done, error in
                let all = received + (data ?? Data())
                guard let end = all.range(of: Data("\r\n\r\n".utf8)) else {
                    if !done, error == nil { answer(connection, received: all, requests: requests) } else { connection.cancel() }
                    return
                }
                let head = String(decoding: all[..<end.lowerBound], as: UTF8.self)
                let length = head.split(separator: "\r\n").first { $0.lowercased().hasPrefix("content-length:") }
                    .flatMap { Int($0.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) } ?? 0
                guard all.count - end.upperBound >= length else {
                    answer(connection, received: all, requests: requests)
                    return
                }
                requests.add()
                let range = head.split(separator: "\r\n").first { $0.lowercased().hasPrefix("range:") }
                    .flatMap { $0.firstMatch(of: /bytes=(\d+)-(\d+)/) }
                    .flatMap { match in Int(match.1).flatMap { start in Int(match.2).map { (start, $0) } } }
                if head.hasPrefix("GET"), let (start, end) = range {
                    let bytes = Data((start...end).map { UInt8($0) })
                    let response = "HTTP/1.1 206 Partial Content\r\nContent-Type: audio/wav\r\nContent-Range: bytes \(start)-\(end)/100\r\nContent-Length: \(bytes.count)\r\nConnection: close\r\n\r\n"
                    connection.send(content: Data(response.utf8) + bytes, completion: .contentProcessed { _ in connection.cancel() })
                    return
                }
                let body = #"{"status":"forgotten"}"#
                let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
                connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
            }
        }

        deinit { listener.cancel() }
    }

    @Test func onlyThePinnedKeyIsTrusted() async throws {
        let (identity, pin) = try Self.identity()
        let server = try Server(identity: identity)
        let port = try await server.start()
        let endpoint = MacEndpoint(host: "127.0.0.1", port: port)
        let transport = URLSessionTransport()

        let reply = try await transport.post(
            PhoneSync.Route.forget, json: Data("{}".utf8), credential: "sdp_x", to: endpoint, pin: pin, timeout: 5)
        #expect(reply.status == 200)
        #expect(String(decoding: reply.body, as: UTF8.self) == #"{"status":"forgotten"}"#)
        #expect(server.requests.value == 1)

        let other = String(repeating: "0", count: 64)
        await #expect(throws: (any Error).self) {
            try await transport.post(PhoneSync.Route.forget, json: Data("{}".utf8), credential: "sdp_x", to: endpoint, pin: other, timeout: 5)
        }
        // Refused at the handshake: the request never reached the server.
        #expect(server.requests.value == 1)
    }

    @Test func playbackReadsAByteRangeThroughThePinnedSession() async throws {
        let (identity, pin) = try Self.identity()
        let server = try Server(identity: identity)
        let port = try await server.start()
        let endpoint = MacEndpoint(host: "127.0.0.1", port: port)
        let reply = try await URLSessionTransport().get(
            PhoneSync.Route.audio(UUID(), generation: 2), range: 10...19, credential: "sdp_x", to: endpoint, pin: pin,
            timeout: 5)
        #expect(reply.status == 206)
        #expect(reply.body == Data((10...19).map { UInt8($0) }))
        #expect(reply.contentRange.flatMap(ContentRange.parse).map { [$0.start, $0.end, $0.total] } == [10, 19, 100])
    }
}

final class Counter: Sendable {
    private let count = Mutex(0)
    func add() { count.withLock { $0 += 1 } }
    var value: Int { count.withLock { $0 } }
}
