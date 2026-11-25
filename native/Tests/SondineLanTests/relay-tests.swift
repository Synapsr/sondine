import Foundation
import Network
@testable import SondineLan
import Testing

@Suite struct IdentityTests {
    @Test func aP256IdentityLoadsInMemoryWithOpensslsPin() throws {
        let made = try TestIdentity()
        let identity = try made.load()
        #expect(identity.pin == made.pin)
        #expect(identity.pin8 == String(made.pin.prefix(8)))
        #expect(txtRecord(pin8: identity.pin8) == ["v": "1", "pin8": String(made.pin.prefix(8))])
    }

    @Test func aWrongPasswordIsRefused() throws {
        let made = try TestIdentity()
        let data = try Data(contentsOf: made.p12)
        #expect(throws: LanIdentityError.self) { try LanIdentity.load(p12: data, password: "wrong") }
        #expect(throws: Never.self) { try LanIdentity.load(p12: data, password: made.password) }
    }

    @Test func aKeyThatIsNotP256IsRefused() throws {
        let rsa = try TestIdentity { key in
            try TestIdentity.check(run("/usr/bin/openssl", ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", key]))
        }
        #expect(throws: LanIdentityError.self) { try rsa.load() }
    }

    /// /usr/bin/openssl (LibreSSL) writes a P-256 key whose top byte is zero
    /// in 31 bytes, in the key file and again in the PKCS #12, and macOS then
    /// pairs no key with the certificate. Whoever makes the identity (core)
    /// makes another key while `openssl ec -outform DER` is not 121 bytes, as
    /// `TestIdentity` does. This key is one /usr/bin/openssl made.
    @Test func aKeyWrittenInFewerThan32BytesIsRefused() throws {
        let short = try TestIdentity { key in
            let folder = URL(filePath: key).deletingLastPathComponent()
            let config = folder.appending(path: "key.cnf")
            try Data("""
                asn1=SEQUENCE:ec
                [ec]
                version=INTEGER:1
                priv=FORMAT:HEX,OCTETSTRING:6506EA26B96A8F8DEC3E63DBFDC45585193B142032C3C28FD010265AC7BAFD
                params=EXPLICIT:0,OID:prime256v1
                pub=EXPLICIT:1,FORMAT:HEX,BITSTRING:04cfca3a8c568b105d0c90adf539cc4529c07fc19138accdd7493b632763db18c47d48dd26fc945ba067d8337b832892c78259be1af6496a74250f1a2cd74b291a

                """.utf8).write(to: config)
            let der = folder.appending(path: "short.der").path(percentEncoded: false)
            try TestIdentity.check(run("/usr/bin/openssl", ["asn1parse", "-genconf", config.path(percentEncoded: false), "-noout", "-out", der]))
            try TestIdentity.check(run("/usr/bin/openssl", ["ec", "-inform", "DER", "-in", der, "-out", key]))
        }
        #expect {
            try short.load()
        } throws: { error in
            "\(error)".contains("fewer than 32 bytes")
        }
    }
}

/// The hello matches `packages/protocol`'s golden `PhoneRelayHello` lines.
@Suite struct HelloTests {
    @Test func helloLinesMatchTheProtocolFixtures() throws {
        let fixtures = Paths.repository.appending(path: "packages/protocol/fixtures/phone/sync-valid.jsonl")
        let lines = try String(contentsOf: fixtures, encoding: .utf8).split(separator: "\n")
        var checked = 0
        for line in lines {
            let entry = try #require(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
            guard entry["schema"] as? String == "PhoneRelayHello", let value = entry["value"] as? NSDictionary else { continue }
            let via = try #require(value["via"] as? String)
            let address = try #require(value["peer"] as? String)
            let path = try #require(PeerPath(rawValue: via))
            let peer = try #require(PeerAddress(address))
            let hello = helloLine(path: path, peer: peer)
            #expect(hello.last == 0x0A)
            #expect(try JSONSerialization.jsonObject(with: hello.dropLast()) as? NSDictionary == value)
            checked += 1
        }
        #expect(checked == 3)
    }
}

/// The relay in this process, on loopback (allowed for these tests), with a
/// test server standing for core's socket.
@Suite struct RelayTests {
    @Test func aPeerIsRelayedAfterTheHelloBothWays() async throws {
        let relay = try RunningRelay()
        let client = try await relay.client()
        #expect(await eventually { client.isReady })
        client.send(Data("POST /v1/sync.hello HTTP/1.1\r\n".utf8))
        let core = try #require(relay.server.accept())
        #expect(core.line() == #"{"v":1,"via":"loopback","peer":"127.0.0.1"}"#)
        #expect(core.read(31) == Data("POST /v1/sync.hello HTTP/1.1\r\n".utf8))
        let large = Data((0..<300_000).map { UInt8($0 % 251) })
        core.write(large)
        #expect(await client.receive(large.count) == large)
        client.send(large)
        #expect(core.read(large.count) == large)
        // Core ends: the phone sees the end, and the relay forgets the connection.
        core.end()
        #expect(await client.sawEnd())
        #expect(await eventually { relay.count { if case .closed(_, .ended) = $0 { true } else { false } } == 1 })
    }

    @Test func thePhoneEndingClosesCoresSide() async throws {
        let relay = try RunningRelay()
        let client = try await relay.client()
        #expect(await eventually { client.isReady })
        let core = try #require(relay.server.accept())
        #expect(core.line() != nil)
        client.connection.cancel()
        #expect(core.sawEnd())
    }

    @Test func linkLocalPeersCarryTheirInterface() async throws {
        let relay = try RunningRelay()
        let client = try await relay.client(host: "fe80::1%lo0")
        #expect(await eventually { client.isReady })
        let core = try #require(relay.server.accept())
        #expect(core.line() == #"{"v":1,"via":"loopback","peer":"fe80::1%lo0"}"#)
    }

    @Test func aPeerOffTheAllowedPathsIsRefusedBeforeTls() async throws {
        let relay = try RunningRelay(policy: PeerPolicy())
        let client = try await relay.client()
        #expect(await client.sawEnd())
        #expect(!client.isReady)
        #expect(relay.events.contains(.refused(.notLocal, addressClass: "loopback")))
        #expect(!relay.events.contains { if case .accepted = $0 { true } else { false } })
        #expect(relay.server.accept(timeout: .milliseconds(200)) == nil, "core never hears of it")
    }

    /// The end-to-end test's stand-in for Tailscale: `::1` refused without the
    /// switch, relayed as `tailnet` with it; 127.0.0.1 stays loopback.
    @Test func loopbackV6StandsForATailnetPeerOnlyWithTheSwitch() async throws {
        let off = try RunningRelay(policy: PeerPolicy(loopback: true, loopbackV6AsTailnet: true))
        let refused = try await off.client(host: "::1")
        #expect(await refused.sawEnd())
        #expect(!refused.isReady)
        #expect(off.events.contains(.refused(.notLocal, addressClass: "loopback")))

        let on = try RunningRelay(policy: PeerPolicy(tailnet: true, loopback: true, loopbackV6AsTailnet: true))
        let away = try await on.client(host: "::1")
        #expect(await eventually { away.isReady })
        let core = try #require(on.server.accept())
        #expect(core.line() == #"{"v":1,"via":"tailnet","peer":"::1"}"#)
        let home = try await on.client()
        #expect(await eventually { home.isReady })
        let second = try #require(on.server.accept())
        #expect(second.line() == #"{"v":1,"via":"loopback","peer":"127.0.0.1"}"#)
    }

    @Test func tls12IsRefused() async throws {
        let relay = try RunningRelay()
        let client = try await relay.client(maxVersion: .TLSv12)
        #expect(await eventually { client.hasFailed })
        #expect(!client.isReady)
        #expect(await eventually { relay.events.contains(.closed(id: 1, .handshakeFailed)) })
        #expect(relay.server.accept(timeout: .milliseconds(200)) == nil)
    }

    @Test func twoConnectionsPerPeerAddress() async throws {
        let relay = try RunningRelay()
        // Plain TCP: each one waits in the TLS handshake and holds its slot.
        let first = try await relay.client(tls: false)
        let second = try await relay.client(tls: false)
        #expect(await eventually { relay.count { if case .accepted = $0 { true } else { false } } == 2 })
        let third = try await relay.client(tls: false)
        #expect(await third.sawEnd())
        #expect(relay.events.contains(.refused(.tooManyFromPeer, addressClass: "loopback")))
        // Another address of the same Mac is another peer.
        let fromIPv6 = try await relay.client(host: "::1", tls: false)
        #expect(await eventually { relay.count { if case .accepted = $0 { true } else { false } } == 3 })
        // A slot freed is a slot again.
        first.connection.cancel()
        #expect(await eventually { relay.events.contains { if case .closed(1, _) = $0 { true } else { false } } })
        let fourth = try await relay.client()
        #expect(await eventually { fourth.isReady })
        _ = (second, fromIPv6)
    }

    @Test func connectionsAtMostAcrossPeers() async throws {
        var limits = RelayLimits()
        limits.maxConnections = 3
        limits.maxPerPeer = 8
        let relay = try RunningRelay(limits: limits)
        let held = [try await relay.client(tls: false), try await relay.client(tls: false), try await relay.client(tls: false)]
        #expect(await eventually { relay.count { if case .accepted = $0 { true } else { false } } == 3 })
        let refused = try await relay.client()
        #expect(await refused.sawEnd())
        #expect(relay.events.contains(.refused(.tooManyConnections, addressClass: "loopback")))
        _ = held
    }

    @Test func theDefaultLimits() {
        let limits = RelayLimits()
        #expect(limits.maxConnections == 8)
        #expect(limits.maxPerPeer == 2)
        #expect(limits.handshakeTimeout == .seconds(10))
        #expect(limits.idleTimeout == .seconds(60))
    }

    @Test func aHandshakeNotFinishedInTimeIsClosed() async throws {
        var limits = RelayLimits()
        limits.handshakeTimeout = .milliseconds(300)
        let relay = try RunningRelay(limits: limits)
        let silent = try await relay.client(tls: false)
        #expect(await eventually { relay.count { if case .accepted = $0 { true } else { false } } == 1 })
        #expect(await silent.sawEnd(timeout: .seconds(3)))
        #expect(relay.events.contains(.closed(id: 1, .handshakeTimeout)))
    }

    @Test func aConnectionWithoutABytePastTheIdleTimeIsClosed() async throws {
        var limits = RelayLimits()
        limits.idleTimeout = .milliseconds(600)
        let relay = try RunningRelay(limits: limits)
        let client = try await relay.client()
        #expect(await eventually { client.isReady })
        let core = try #require(relay.server.accept())
        #expect(core.line() != nil)
        // Bytes every 200 ms keep it open past the idle time…
        for _ in 0..<6 {
            client.send(Data("x".utf8))
            #expect(core.read(1) == Data("x".utf8))
            try await Task.sleep(for: .milliseconds(200))
        }
        #expect(!relay.events.contains { if case .closed = $0 { true } else { false } })
        // …and silence closes both sides.
        #expect(core.sawEnd(timeout: .seconds(3)))
        #expect(await client.sawEnd())
        #expect(relay.events.contains(.closed(id: 1, .idle)))
    }

    @Test func noCoreSocketClosesThePeer() async throws {
        let relay = try RunningRelay(socketPath: NSTemporaryDirectory() + "sl-missing.sock")
        let client = try await relay.client()
        #expect(await client.sawEnd())
        #expect(await eventually { relay.events.contains(.closed(id: 1, .coreUnavailable)) })
    }

    @Test func stoppingClosesEveryConnection() async throws {
        let relay = try RunningRelay()
        let client = try await relay.client()
        #expect(await eventually { client.isReady })
        let core = try #require(relay.server.accept())
        let stopped = AsyncStream<Void>.makeStream()
        relay.relay.stop { stopped.continuation.finish() }
        for await _ in stopped.stream {}
        #expect(core.sawEnd())
        #expect(await client.sawEnd())
        #expect(relay.events.contains(.closed(id: 1, .stopped)))
        #expect(relay.events.last == .stopped)
    }
}
