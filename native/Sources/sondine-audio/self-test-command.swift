import Darwin
import Foundation
import SondineCapture
import SondineKit

/// `sondine-audio self-test sandbox`: what the helper can and cannot do under its App Sandbox
/// (ADR 010: native children run without `network.client`). It never prompts and never
/// touches audio: one TCP connect attempt, process lookups (Core Audio's client list, no IO),
/// and a few files in the data and model directories, removed afterwards. Every check is one JSON line on stdout; the exit
/// status is 0 whatever the results, so the caller judges them.
enum SelfTestCommand {
    struct Options {
        var data: URL
        var models: URL?
        var host = "192.0.2.1"
        var port: UInt16 = 443

        static func parse(_ arguments: [String]) throws -> Options {
            var values: [String: String] = [:]
            let known: Set = ["--data", "--models", "--target"]
            var index = 0
            while index < arguments.count {
                let flag = arguments[index]
                guard known.contains(flag) else { throw ParameterError("unknown option \(flag)") }
                guard index + 1 < arguments.count else { throw ParameterError("\(flag) needs a value") }
                guard values[flag] == nil else { throw ParameterError("\(flag) given twice") }
                values[flag] = arguments[index + 1]
                index += 2
            }
            guard let data = values["--data"] else { throw ParameterError("--data is required") }
            var options = Options(data: URL(filePath: data, directoryHint: .isDirectory))
            options.models = values["--models"].map { URL(filePath: $0, directoryHint: .isDirectory) }
            if let target = values["--target"] {
                let parts = target.split(separator: ":")
                var address = in_addr()
                guard parts.count == 2, inet_pton(AF_INET, String(parts[0]), &address) == 1, let port = UInt16(parts[1]), port > 0 else {
                    throw ParameterError("--target must be <IPv4>:<port>")
                }
                options.host = String(parts[0])
                options.port = port
            }
            return options
        }
    }

    static func run(_ arguments: [String]) -> Int32 {
        if arguments.first == "listeners" { return ListenerSelfTest.run(Array(arguments.dropFirst())) }
        if arguments.first == "taps" { return TapSelfTest.run(Array(arguments.dropFirst())) }
        if arguments.first == "network" { return networkCheck(Array(arguments.dropFirst())) }
        guard arguments.first == "sandbox" else {
            fputs("sondine-audio self-test: the tests are \"sandbox\", \"listeners\", \"taps\" and \"network\"\n", stderr)
            return ExitCode.usage
        }
        let options: Options
        do {
            options = try Options.parse(Array(arguments.dropFirst()))
        } catch {
            fputs("sondine-audio self-test: \(error)\n", stderr)
            return ExitCode.usage
        }
        signal(SIGPIPE, SIG_IGN)
        var results: [Bool] = []
        func report(_ line: [String: Any]) {
            if let ok = line["ok"] as? Bool { results.append(ok) }
            guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys, .withoutEscapingSlashes]) else { return }
            FileHandle.standardOutput.write(data + Data("\n".utf8))
        }
        report(sandboxStatus())
        report(networkDenied(host: options.host, port: options.port))
        let introspection = DarwinProcessIntrospection()
        for pid in samples(introspection) { report(resolution(of: pid, introspection: introspection)) }
        report(halClients(introspection))
        report(dataWritable(options.data))
        report(unixSocket(in: options.data))
        report(modelsReadable(options.models ?? defaultModelsDirectory()))
        report(["check": "summary", "ok": !results.contains(false), "passed": results.filter { $0 }.count, "failed": results.filter { !$0 }.count])
        return ExitCode.success
    }

    /// `self-test network`: whether the signed, sandboxed helper reads the networks' signatures
    /// (ADR 029). One JSON line: how many networks, and each one's hash under a key made for
    /// this run only, cut to 4 hex digits; never a signature.
    static func networkCheck(_ arguments: [String]) -> Int32 {
        guard arguments.isEmpty else {
            fputs("sondine-audio self-test network: no options\n", stderr)
            return ExitCode.usage
        }
        let signatures = SystemNetworkSignatures.readOnce()
        let key = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let prefixes = (signatures ?? []).map { String(NetworkHashing.hash(signature: $0.raw, key: key).prefix(4)) }
        let line: [String: Any] = [
            "check": "network",
            "ok": !(signatures ?? []).isEmpty,
            "storeReadable": signatures != nil,
            "networks": prefixes.count,
            "hashPrefixes": prefixes,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data + Data("\n".utf8))
        }
        return ExitCode.success
    }

    // MARK: Checks

    /// Informational: whether the kernel sees this process as sandboxed (`sandbox_check`, dlsym).
    private static func sandboxStatus() -> [String: Any] {
        typealias SandboxCheck = @convention(c) (pid_t, UnsafePointer<CChar>?, Int32) -> Int32
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "sandbox_check") else {
            return ["check": "sandboxed", "value": NSNull(), "detail": "sandbox_check is not available"]
        }
        let check = unsafeBitCast(symbol, to: SandboxCheck.self)
        return ["check": "sandboxed", "value": check(getpid(), nil, 0) != 0]
    }

    /// (a) An outbound TCP connect must be refused by the sandbox (EPERM or EACCES at
    /// `connect`). The default target is TEST-NET-1 (RFC 5737): the policy check happens before
    /// any routing, and without a sandbox the attempt goes nowhere.
    private static func networkDenied(host: String, port: UInt16) -> [String: Any] {
        var line: [String: Any] = ["check": "network.denied", "target": "\(host):\(port)"]
        func finish(_ outcome: String, errno code: Int32?) -> [String: Any] {
            let denied = code == EPERM || code == EACCES
            line["ok"] = denied
            line["outcome"] = denied ? "denied" : outcome
            line["errno"] = code.map { String(cString: strerror($0)) } ?? NSNull()
            return line
        }
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return finish("socket-failed", errno: errno) }
        defer { close(fd) }
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        _ = inet_pton(AF_INET, host, &address.sin_addr)
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        if result == 0 { return finish("connected", errno: nil) }
        guard errno == EINPROGRESS else { return finish("failed", errno: errno) }
        var poller = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
        guard poll(&poller, 1, 1_500) > 0 else { return finish("timeout", errno: nil) }
        var error: Int32 = 0
        var length = socklen_t(MemoryLayout<Int32>.size)
        getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length)
        return error == 0 ? finish("connected", errno: nil) : finish("failed", errno: error)
    }

    /// The helper, its parent and its responsible process (the app, as attribution sees the
    /// user's apps).
    private static func samples(_ introspection: DarwinProcessIntrospection) -> [Int32] {
        var samples = [getpid(), getppid()]
        if let responsible = introspection.responsiblePID(getpid()) { samples.append(responsible) }
        var seen = Set<Int32>()
        return samples.filter { seen.insert($0).inserted }
    }

    /// (b) pid → executable path, responsible pid, parent pid.
    private static func resolution(of pid: Int32, introspection: DarwinProcessIntrospection) -> [String: Any] {
        let path = introspection.executablePath(pid)
        let parent = introspection.parentPID(pid)
        let responsible = introspection.responsiblePID(pid)
        let ok = path != nil && parent != nil && (responsible != nil || !introspection.hasResponsibilitySPI)
        return [
            "check": "process.resolution",
            "ok": ok,
            "pid": Int(pid),
            "name": introspection.processName(pid) ?? NSNull(),
            "path": path ?? NSNull(),
            "parentPid": parent.map { Int($0) } ?? NSNull(),
            "responsiblePid": responsible.map { Int($0) } ?? NSNull(),
            "responsibilitySPI": introspection.hasResponsibilitySPI,
        ]
    }

    /// (b) The executable path of every client Core Audio lists, apps and system daemons alike:
    /// the pids attribution resolves in production. Listing them starts no IO and asks for no
    /// permission. (The sandbox empties `proc_listallpids`, so the HAL is the only source.)
    private static func halClients(_ introspection: DarwinProcessIntrospection) -> [String: Any] {
        let hal = CoreAudioHardware()
        guard let objects = try? hal.processObjectIDs() else {
            return ["check": "process.resolution.hal", "ok": false, "detail": "the HAL process list is not readable"]
        }
        let clients = objects.compactMap { try? hal.processInfo($0) }.filter { $0.pid > 0 }
        let paths = clients.map { introspection.executablePath($0.pid) }
        let unresolved = zip(clients, paths).filter { $0.1 == nil }.map { client, _ in
            ["pid": Int(client.pid), "bundleId": client.bundleID ?? NSNull()] as [String: Any]
        }
        let system = paths.compactMap { $0 }.filter { $0.hasPrefix("/System/") || $0.hasPrefix("/usr/") }
        return [
            "check": "process.resolution.hal",
            "ok": !clients.isEmpty && unresolved.isEmpty,
            "clients": clients.count,
            "systemPathsRead": system.count,
            "unresolved": unresolved,
        ]
    }

    /// (c) A file in the data directory can be created, written, synced and removed.
    private static func dataWritable(_ data: URL) -> [String: Any] {
        let path = data.appending(path: ".sondine-self-test-\(getpid())").path(percentEncoded: false)
        var line: [String: Any] = ["check": "data.writable", "path": data.path(percentEncoded: false)]
        let fd = open(path, O_CREAT | O_EXCL | O_WRONLY, 0o600)
        guard fd >= 0 else {
            line["ok"] = false
            line["errno"] = String(cString: strerror(errno))
            return line
        }
        let bytes = Array("sondine\n".utf8)
        let written = write(fd, bytes, bytes.count)
        let synced = fsync(fd) == 0
        close(fd)
        let removed = unlink(path) == 0
        line["ok"] = written == bytes.count && synced && removed
        return line
    }

    /// (c) A Unix socket can be bound in the data directory and reached through its path.
    private static func unixSocket(in data: URL) -> [String: Any] {
        let path = data.appending(path: ".st-\(getpid()).sock").path(percentEncoded: false)
        var line: [String: Any] = ["check": "data.unix-socket", "path": path]
        func fail(_ step: String) -> [String: Any] {
            line["ok"] = false
            line["step"] = step
            line["errno"] = String(cString: strerror(errno))
            return line
        }
        var address = sockaddr_un()
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        let bytes = Array(path.utf8)
        guard bytes.count < capacity else {
            line["ok"] = false
            line["step"] = "path longer than \(capacity - 1) bytes"
            return line
        }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let server = socket(AF_UNIX, SOCK_STREAM, 0)
        guard server >= 0 else { return fail("socket") }
        defer {
            close(server)
            unlink(path)
        }
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(server, $0, size) } }
        guard bound == 0 else { return fail("bind") }
        guard listen(server, 1) == 0 else { return fail("listen") }
        let client = socket(AF_UNIX, SOCK_STREAM, 0)
        guard client >= 0 else { return fail("socket") }
        defer { close(client) }
        let connected = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(client, $0, size) } }
        guard connected == 0 else { return fail("connect") }
        line["ok"] = true
        return line
    }

    /// (d) The model directory can be listed and its files read. Writing there is reported, not
    /// judged: ADR 010 wants it read-only for the helper.
    private static func modelsReadable(_ models: URL?) -> [String: Any] {
        guard let models else {
            return ["check": "models.readable", "ok": false, "detail": "no model directory: pass --models"]
        }
        let path = models.path(percentEncoded: false)
        var line: [String: Any] = ["check": "models.readable", "path": path]
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: path) else {
            line["ok"] = false
            line["errno"] = String(cString: strerror(errno))
            return line
        }
        line["entries"] = entries.count
        let model = models.appending(path: "silero-vad/silero_vad.onnx").path(percentEncoded: false)
        if FileManager.default.fileExists(atPath: model) {
            let fd = open(model, O_RDONLY)
            var header = [UInt8](repeating: 0, count: 16)
            line["modelRead"] = fd >= 0 && read(fd, &header, header.count) == header.count
            if fd >= 0 { close(fd) }
        } else {
            line["modelRead"] = NSNull()
        }
        let probe = models.appending(path: ".sondine-self-test-\(getpid())").path(percentEncoded: false)
        let fd = open(probe, O_CREAT | O_EXCL | O_WRONLY, 0o600)
        line["writable"] = fd >= 0
        if fd >= 0 {
            close(fd)
            unlink(probe)
        }
        line["ok"] = (line["modelRead"] as? Bool) ?? true
        return line
    }

    /// The directory that holds `silero-vad/` when no `--models` is given.
    private static func defaultModelsDirectory() -> URL? {
        SondineAudioCommand.defaultModelURL()?.deletingLastPathComponent().deletingLastPathComponent()
    }
}
