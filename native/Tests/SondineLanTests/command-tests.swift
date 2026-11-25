import Foundation
@testable import SondineLan
import Testing

@Suite struct ServeOptionsTests {
    private let required = ["--identity", "/d/lan/identity.p12", "--password-file", "/d/lan/password", "--socket", "/d/run/phone.sock", "--name", "Sondine K3QZ"]

    @Test func theContractsOptionsParse() throws {
        let options = try ServeOptions.parse(required + ["--port", "51234", "--tailnet", "--allow-loopback"])
        #expect(options == ServeOptions(
            identity: "/d/lan/identity.p12", passwordFile: "/d/lan/password", socket: "/d/run/phone.sock",
            name: "Sondine K3QZ", port: 51234, tailnet: true, allowLoopback: true
        ))
        let defaults = try ServeOptions.parse(required)
        #expect(defaults.port == 0 && !defaults.tailnet && !defaults.allowLoopback && !defaults.loopbackV6AsTailnet)
    }

    /// The test's stand-in for Tailscale exists in debug builds only, and only with loopback allowed.
    @Test func loopbackAsTailnetIsADebugOnlyOption() throws {
        #if DEBUG
        let options = try ServeOptions.parse(required + ["--allow-loopback", "--loopback-v6-as-tailnet"])
        #expect(options.loopbackV6AsTailnet)
        #expect(throws: UsageError.self) { try ServeOptions.parse(required + ["--loopback-v6-as-tailnet"]) }
        #else
        #expect(throws: UsageError.self) { try ServeOptions.parse(required + ["--allow-loopback", "--loopback-v6-as-tailnet"]) }
        #endif
    }

    @Test func badOptionsAreRefused() {
        #expect(throws: UsageError.self) { try ServeOptions.parse(Array(required.dropLast(2))) }
        #expect(throws: UsageError.self) { try ServeOptions.parse(required + ["--port", "65536"]) }
        #expect(throws: UsageError.self) { try ServeOptions.parse(required + ["--port"]) }
        #expect(throws: UsageError.self) { try ServeOptions.parse(required + ["--name", "again"]) }
        #expect(throws: UsageError.self) { try ServeOptions.parse(required + ["--verbose"]) }
        #expect(throws: UsageError.self) { try ServeOptions.parse(Array(required.dropLast()) + [String(repeating: "x", count: 64)]) }
        #expect(throws: UsageError.self) { try ServeOptions.parse(Array(required.dropLast()) + ["Sondine\nK3QZ"]) }
    }
}

/// The built `sondine-lan`, as core starts it.
@Suite(.enabled(if: Paths.binary != nil, "sondine-lan is not built"))
struct BinaryTests {
    private var binary: String { Paths.binary!.path(percentEncoded: false) }

    /// Serve end to end: `listening` on stdout, a pinned TLS 1.3 client
    /// relayed to the socket after the hello, both ways, then end of input
    /// on stdin stops it with status 0.
    @Test func serveRelaysUntilEndOfInput() async throws {
        let identity = try TestIdentity()
        let server = try UnixServer()
        let process = Process()
        process.executableURL = URL(filePath: binary)
        process.arguments = [
            "serve", "--identity", identity.p12.path(percentEncoded: false), "--password-file", identity.passwordFile.path(percentEncoded: false),
            "--socket", server.path, "--name", "Sondine Test \(UUID().uuidString.prefix(4))", "--port", "0", "--allow-loopback",
        ]
        let stdin = Pipe()
        let stdout = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        try process.run()
        defer { if process.isRunning { process.terminate() } }

        let first = try #require(readLine(stdout.fileHandleForReading))
        let event = try #require(try JSONSerialization.jsonObject(with: Data(first.utf8)) as? [String: Any])
        #expect(event["event"] as? String == "listening")
        let port = try #require(event["port"] as? Int)
        #expect(port > 0)

        let client = TestClient(port: UInt16(port), tls: identity.pin)
        #expect(await eventually { client.isReady })
        client.send(Data("ping".utf8))
        let core = try #require(server.accept())
        #expect(core.line() == #"{"v":1,"via":"loopback","peer":"127.0.0.1"}"#)
        #expect(core.read(4) == Data("ping".utf8))
        core.write(Data("pong".utf8))
        #expect(await client.receive(4) == Data("pong".utf8))

        try stdin.fileHandleForWriting.close()
        #expect(await eventually { !process.isRunning })
        #expect(process.terminationStatus == 0)
        #expect(core.sawEnd())
        #expect(await client.sawEnd())
        // Nothing but the one event on stdout.
        #expect(stdout.fileHandleForReading.readDataToEndOfFile().isEmpty)
    }

    @Test func aPinThatIsNotTheMacsFailsTheHandshake() async throws {
        let identity = try TestIdentity()
        let other = try TestIdentity()
        let server = try UnixServer()
        let process = Process()
        process.executableURL = URL(filePath: binary)
        process.arguments = [
            "serve", "--identity", identity.p12.path(percentEncoded: false), "--password-file", identity.passwordFile.path(percentEncoded: false),
            "--socket", server.path, "--name", "Sondine Test \(UUID().uuidString.prefix(4))", "--allow-loopback",
        ]
        let stdin = Pipe()
        let stdout = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        try process.run()
        defer { try? stdin.fileHandleForWriting.close() }
        let first = try #require(readLine(stdout.fileHandleForReading))
        let event = try JSONSerialization.jsonObject(with: Data(first.utf8)) as? [String: Any]
        let port = try #require(event?["port"] as? Int)
        let client = TestClient(port: UInt16(port), tls: other.pin)
        #expect(await eventually { client.hasFailed })
        #expect(server.accept(timeout: .milliseconds(200)) == nil)
    }

    @Test func failuresAreOneErrorEventAndANonZeroStatus() throws {
        let identity = try TestIdentity()
        let folder = try scratch()
        defer { try? FileManager.default.removeItem(at: folder) }
        let wrongPassword = folder.appending(path: "password")
        try Data("nope".utf8).write(to: wrongPassword)
        let cases: [[String]] = [
            ["serve", "--identity", identity.p12.path(percentEncoded: false)],
            ["serve", "--identity", identity.p12.path(percentEncoded: false), "--password-file", wrongPassword.path(percentEncoded: false), "--socket", "/nowhere.sock", "--name", "Sondine Test"],
            ["serve", "--identity", "/nowhere.p12", "--password-file", wrongPassword.path(percentEncoded: false), "--socket", "/nowhere.sock", "--name", "Sondine Test"],
        ]
        for arguments in cases {
            let result = try run(binary, arguments)
            #expect(result.status != 0, "\(arguments)")
            let lines = result.stdout.split(separator: "\n")
            #expect(lines.count == 1)
            let event = try #require(try JSONSerialization.jsonObject(with: Data(lines[0].utf8)) as? [String: Any])
            #expect(event["event"] as? String == "error")
            #expect((event["message"] as? String)?.isEmpty == false)
        }
    }

    @Test func versionAndUsage() throws {
        #expect(try run(binary, ["--version"]).stdout == "sondine-lan \(lanRelayVersion)\n")
        let usage = try run(binary, [])
        #expect(usage.status == 64)
        #expect(usage.stdout.isEmpty)
        #expect(usage.stderr.contains("sondine-lan serve"))
    }

    /// Unsandboxed (a debug build), a file in the home folder can be created: the self-test fails.
    @Test func theSelfTestFailsOutsideTheSandbox() throws {
        let result = try run(binary, ["self-test", "sandbox"])
        #expect(result.status == 1)
        let checks = try result.stdout.split(separator: "\n").map { try #require(try JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]) }
        #expect(checks.first { $0["check"] as? String == "sandboxed" }?["value"] as? Bool == false)
        #expect(checks.first { $0["check"] as? String == "file.home-write-denied" }?["ok"] as? Bool == false)
        #expect(checks.first { $0["check"] as? String == "network.listen-allowed" }?["ok"] as? Bool == true)
    }

    /// A twin signed ad hoc with the packaged entitlements (apps/desktop/build/entitlements.lan.plist):
    /// App Sandbox refuses a file in the home folder and allows listening.
    @Test(.enabled(if: FileManager.default.fileExists(atPath: Paths.lanEntitlements.path(percentEncoded: false))))
    func theSelfTestPassesWithThePackagedEntitlements() throws {
        let folder = try scratch()
        defer { try? FileManager.default.removeItem(at: folder) }
        let twin = folder.appending(path: "sondine-lan")
        try FileManager.default.copyItem(at: URL(filePath: binary), to: twin)
        let signed = try run("/usr/bin/codesign", [
            "--force", "--options", "runtime", "--identifier", "app.sondine.lan",
            "--entitlements", Paths.lanEntitlements.path(percentEncoded: false), "--sign", "-", twin.path(percentEncoded: false),
        ])
        #expect(signed.status == 0, "\(signed.stderr)")
        let result = try run(twin.path(percentEncoded: false), ["self-test", "sandbox"])
        #expect(result.status == 0, "\(result.stdout)")
        #expect(result.stdout.contains(#""check":"sandboxed","value":true"#))
        #expect(result.stdout.contains(#""outcome":"denied""#))
    }

    private func readLine(_ handle: FileHandle) -> String? {
        var line = Data()
        while true {
            let byte = handle.readData(ofLength: 1)
            if byte.isEmpty { return line.isEmpty ? nil : String(decoding: line, as: UTF8.self) }
            if byte == Data("\n".utf8) { return String(decoding: line, as: UTF8.self) }
            line.append(byte)
        }
    }
}
