import Foundation
import Security
import SondinePhone
import Testing

private let fixtures = repository.appending(path: "packages/protocol/fixtures")

private func lines(_ path: String) throws -> [String] {
    try String(contentsOf: fixtures.appending(path: path), encoding: .utf8)
        .split(separator: "\n").map(String.init)
        .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
}

private func object(_ data: Data) throws -> NSDictionary {
    try #require(try JSONSerialization.jsonObject(with: data) as? NSDictionary)
}

/// A fixture line: the schema's name and the message.
private func fixture(_ line: String) throws -> (PhoneSyncSchema, Data) {
    let whole = try object(Data(line.utf8))
    let name = try #require(whole["schema"] as? String)
    let schema = try #require(PhoneSyncSchema(rawValue: name), "schema in \(line)")
    let value = try JSONSerialization.data(withJSONObject: try #require(whole["value"]))
    return (schema, value)
}

/// Golden fixtures shared with `packages/protocol` (phone-sync.ts).
@Suite struct PhoneSyncFixtureTests {
    @Test func everyValidMessageDecodesAndEncodesToTheSameJson() throws {
        let valid = try lines("phone/sync-valid.jsonl")
        #expect(valid.count == 51)
        var seen = Set<PhoneSyncSchema>()
        for line in valid {
            let (schema, value) = try fixture(line)
            seen.insert(schema)
            let again = try schema.roundTrip(value)
            #expect(try object(again) == object(value), "re-encoded \(line)")
        }
        #expect(seen == Set(PhoneSyncSchema.allCases), "every schema has a valid fixture")
    }

    @Test func everyInvalidMessageIsRefused() throws {
        let invalid = try lines("phone/sync-invalid.jsonl")
        #expect(invalid.count == 44)
        for line in invalid {
            let (schema, value) = try fixture(line)
            #expect(throws: (any Error).self, "accepted \(line)") { try schema.roundTrip(value) }
        }
    }

    @Test func theSixDigitsMatchTheVectors() throws {
        let vectors = try lines("vectors/pairing-digits.jsonl")
        #expect(vectors.count == 3)
        for line in vectors {
            let vector = try object(Data(line.utf8))
            let digits = pairingDigits(
                token: try #require(vector["token"] as? String),
                deviceId: try #require(UUID(uuidString: vector["deviceId"] as? String ?? "")),
                pin: try #require(vector["pin"] as? String))
            #expect(digits == vector["digits"] as? String, "\(line)")
        }
    }

    @Test func aPairingUrlReadsBackAsItsInvite() throws {
        for line in try lines("phone/sync-valid.jsonl") {
            let (schema, value) = try fixture(line)
            guard schema == .pairingInvite else { continue }
            let invite = try JSONDecoder().decode(PairingInvite.self, from: value)
            #expect(PairingInvite.scan(invite.url) == .invite(invite), "\(invite.url)")
        }
    }

    @Test func aScanSaysWhatItIs() throws {
        // As `formatPairingUrl` writes it: a space as `+`, commas and `%` escaped.
        let url = "sondine://pair?v=1&pin=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
            + "&token=q3Zk1F0x9bT2Yw8-hJcL5nR_uVe4mPa7sDoGiK6tQzE&name=Sondine+K7Q2&port=49321"
            + "&addr=192.168.1.24%2Cfe80%3A%3A1c2b%3A3a4d%3A5e6f%3A7081%25en0"
        guard case let .invite(invite) = PairingInvite.scan(url) else {
            Issue.record("not read")
            return
        }
        #expect(invite.name == "Sondine K7Q2")
        #expect(invite.addrs == ["192.168.1.24", "fe80::1c2b:3a4d:5e6f:7081%en0"])
        #expect(invite.url == url)
        #expect(PairingInvite.scan(url.replacingOccurrences(of: "v=1", with: "v=2")) == .version(2))
        #expect(PairingInvite.scan("https://example.com") == .notAnInvite)
        #expect(PairingInvite.scan(url.replacingOccurrences(of: "port=49321", with: "port=0")) == .notAnInvite)
    }
}

/// The pin is SHA-256 of the key's SubjectPublicKeyInfo, as openssl computes it.
@Suite struct KeyPinTests {
    private func openssl(_ arguments: [String], in folder: URL) throws -> Data {
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
        #expect(process.terminationStatus == 0, "openssl \(arguments.joined(separator: " "))")
        return data
    }

    /// A self-signed certificate as core makes it (ADR 008), and the pin of its key by openssl.
    private func certificate(_ keygen: [String]) throws -> (SecTrust, String) {
        let folder = try scratch()
        _ = try openssl(keygen + ["-out", "key.pem"], in: folder)
        _ = try openssl([
            "req", "-x509", "-new", "-key", "key.pem", "-sha256", "-out", "cert.pem", "-days", "1", "-subj", "/CN=Sondine",
        ], in: folder)
        let der = try openssl(["x509", "-in", "cert.pem", "-outform", "DER"], in: folder)
        let spki = try openssl(["x509", "-in", "cert.pem", "-noout", "-pubkey"], in: folder)
        try spki.write(to: folder.appending(path: "pub.pem"))
        let spkiDer = try openssl(["pkey", "-pubin", "-in", "pub.pem", "-outform", "DER"], in: folder)
        let digest = try openssl(["dgst", "-sha256", "-hex"], in: folder, input: spkiDer)
        let pin = try #require(String(decoding: digest, as: UTF8.self).split(separator: " ").last)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let certificate = try #require(SecCertificateCreateWithData(nil, der as CFData))
        var trust: SecTrust?
        #expect(SecTrustCreateWithCertificates(certificate, SecPolicyCreateSSL(true, "whatever" as CFString), &trust) == errSecSuccess)
        return (try #require(trust), pin)
    }

    private func openssl(_ arguments: [String], in folder: URL, input: Data) throws -> Data {
        let file = folder.appending(path: "input.bin")
        try input.write(to: file)
        return try openssl(arguments + [file.path(percentEncoded: false)], in: folder)
    }

    @Test func aP256KeysPinIsOpensslsSha256OfItsSpki() throws {
        let (trust, pin) = try certificate(["ecparam", "-name", "prime256v1", "-genkey", "-noout"])
        #expect(KeyPin.pin(of: trust) == pin)
        #expect(KeyPin.accepts(trust, pin: pin))
        #expect(!KeyPin.accepts(trust, pin: String(repeating: "0", count: 64)))
    }

    @Test func noOtherKindOfKeyIsTrusted() throws {
        let (trust, pin) = try certificate(["genrsa"])
        #expect(KeyPin.pin(of: trust) == nil)
        #expect(!KeyPin.accepts(trust, pin: pin))
    }
}

/// Tag names (ADR 039): the same vectors as `packages/core/src/text/tags.test.ts`.
@Suite struct TagNameTests {
    @Test func cleansAndKeysAsCoreDoes() throws {
        for line in try lines("vectors/tag-names.jsonl") {
            let vector = try object(Data(line.utf8))
            let typed = try #require(vector["typed"] as? String)
            let name = vector["name"] as? String
            #expect(TagName.clean(typed) == name, "clean \(line)")
            if let name { #expect(TagName.key(name) == vector["key"] as? String, "key \(line)") }
        }
    }
}

