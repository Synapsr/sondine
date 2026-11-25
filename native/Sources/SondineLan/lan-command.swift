import Darwin
import Foundation

public let lanRelayVersion = "0.1.0"

public struct UsageError: Error, CustomStringConvertible {
    public let description: String
    init(_ description: String) { self.description = description }
}

/// `sondine-lan serve` options (the contract core codes against).
public struct ServeOptions: Equatable, Sendable {
    public var identity: String
    public var passwordFile: String
    public var socket: String
    public var name: String
    public var port: UInt16 = 0
    public var tailnet = false
    public var allowLoopback = false
    /// Debug builds only: `::1` stands for a peer through Tailscale (`pnpm test:native`).
    public var loopbackV6AsTailnet = false

    public static func parse(_ arguments: [String]) throws -> ServeOptions {
        var values: [String: String] = [:]
        var tailnet = false
        var allowLoopback = false
        var loopbackV6AsTailnet = false
        let valued: Set = ["--identity", "--password-file", "--socket", "--name", "--port"]
        var index = 0
        while index < arguments.count {
            let flag = arguments[index]
            switch flag {
            case "--tailnet": tailnet = true
            case "--allow-loopback": allowLoopback = true
            #if DEBUG
            case "--loopback-v6-as-tailnet": loopbackV6AsTailnet = true
            #endif
            case _ where valued.contains(flag):
                guard index + 1 < arguments.count else { throw UsageError("\(flag) needs a value") }
                guard values[flag] == nil else { throw UsageError("\(flag) given twice") }
                values[flag] = arguments[index + 1]
                index += 1
            default:
                throw UsageError("unknown option \(flag)")
            }
            index += 1
        }
        func required(_ flag: String) throws -> String {
            guard let value = values[flag], !value.isEmpty else { throw UsageError("\(flag) is required") }
            return value
        }
        var options = ServeOptions(
            identity: try required("--identity"), passwordFile: try required("--password-file"),
            socket: try required("--socket"), name: try required("--name")
        )
        if let port = values["--port"] {
            guard let value = UInt16(port) else { throw UsageError("--port must be 0 to 65535") }
            options.port = value
        }
        // A DNS-SD instance name: 1 to 63 bytes of UTF-8, no control characters.
        guard options.name.utf8.count <= 63, !options.name.unicodeScalars.contains(where: { $0.properties.generalCategory == .control }) else {
            throw UsageError("--name must be 1 to 63 bytes without control characters")
        }
        guard !loopbackV6AsTailnet || allowLoopback else { throw UsageError("--loopback-v6-as-tailnet needs --allow-loopback") }
        options.tailnet = tailnet
        options.allowLoopback = allowLoopback
        options.loopbackV6AsTailnet = loopbackV6AsTailnet
        return options
    }
}

public enum LanCommand {
    static let usage = """
    usage: sondine-lan serve --identity <p12> --password-file <path> --socket <phone.sock> --name <name> [--port <n>] [--tailnet] [--allow-loopback]
           sondine-lan self-test sandbox
           sondine-lan --version

    serve: listens with TLS 1.3 on --port (0: the system picks), advertises \(phoneServiceType)
      under --name, accepts peers on the local network (with --tailnet, also on a tunnel from
      Tailscale's ranges; with --allow-loopback, loopback, for development), and relays each
      to --socket after one hello line. Until end of input on stdin. stdout carries JSON lines
      only: {"event":"listening","port":N} once ready, {"event":"error","message":"…"} before a
      non-zero exit.
    self-test sandbox: a file in the home folder must be refused (App Sandbox) and a
      listening socket allowed; JSON lines; exit 0 when both hold.
    """

    public static func main(_ arguments: [String]) -> Never {
        signal(SIGPIPE, SIG_IGN)
        switch arguments.first {
        case "--version":
            print("sondine-lan \(lanRelayVersion)")
            exit(0)
        case "self-test":
            guard arguments.dropFirst().first == "sandbox", arguments.count == 2 else {
                log("the only self-test is \"sandbox\"")
                exit(64)
            }
            exit(SandboxSelfTest.run())
        case "serve":
            serve(Array(arguments.dropFirst()))
        default:
            FileHandle.standardError.write(Data((usage + "\n").utf8))
            exit(64)
        }
    }

    static func serve(_ arguments: [String]) -> Never {
        let options: ServeOptions
        do {
            options = try ServeOptions.parse(arguments)
        } catch {
            fail("\(error)", code: 64)
        }
        let identity: LanIdentity
        do {
            identity = try LanIdentity.load(p12: URL(filePath: options.identity), passwordFile: URL(filePath: options.passwordFile))
        } catch {
            fail("\(error)", code: 66)
        }
        let configuration = LanRelayConfiguration(
            port: options.port, socketPath: options.socket, serviceName: options.name,
            policy: PeerPolicy(
                tailnet: options.tailnet, loopback: options.allowLoopback, loopbackV6AsTailnet: options.loopbackV6AsTailnet)
        )
        let relay = LanRelay(identity: identity, configuration: configuration) { event in
            switch event {
            case .listening(let port):
                emit(["event": "listening", "port": Int(port)])
                log("listening on port \(port), advertised as \(phoneServiceType)")
            case .failed(let message):
                fail(message, code: 69)
            case .refused(let reason, let addressClass):
                log("refused a peer (\(addressClass)): \(reason.rawValue)")
            case .accepted(let id, let path):
                log("connection \(id): accepted from the \(path.rawValue) path")
            case .relaying(let id):
                log("connection \(id): relaying")
            case .closed(let id, let reason):
                log("connection \(id): closed (\(reason.rawValue))")
            case .stopped:
                log("stopped")
            }
        }
        do {
            try relay.start()
        } catch {
            fail("cannot listen: \(error)", code: 69)
        }
        // Core holds stdin: its end means stop, withdraw the advertisement and exit.
        Thread.detachNewThread {
            var buffer = [UInt8](repeating: 0, count: 512)
            while true {
                let count = buffer.withUnsafeMutableBytes { read(STDIN_FILENO, $0.baseAddress!, $0.count) }
                if count > 0 || (count < 0 && errno == EINTR) { continue }
                break
            }
            relay.stop { exit(0) }
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { exit(0) }
        }
        dispatchMain()
    }

    private static let output = NSLock()

    /// One JSON line on stdout, the only thing stdout carries.
    static func emit(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]) else { return }
        output.withLock { FileHandle.standardOutput.write(data + Data("\n".utf8)) }
    }

    static func log(_ message: String) {
        FileHandle.standardError.write(Data("sondine-lan: \(message)\n".utf8))
    }

    static func fail(_ message: String, code: Int32) -> Never {
        log(message)
        emit(["event": "error", "message": message])
        exit(code)
    }
}
