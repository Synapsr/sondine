import Darwin
import Foundation

// sondine-mcp: an agent's stdio to Sondine's agent socket (ADR 011).
//
// An MCP client (Claude Code, Codex) starts it with the agent's key in
// SONDINE_TOKEN. It sends the key in one hello line, reads Sondine's one-line
// answer, then copies bytes both ways until either side closes. Sondine's
// core checks the key and runs the MCP server; this tool holds no logic and
// no state. It runs under App Sandbox and reaches only the app group
// container, where the socket is.
//
//   → {"v":1,"token":"sdn_…"}\n
//   ← {"ok":true}\n  then MCP messages, one JSON per line, both ways
//   ← {"ok":false,"reason":"unknown|revoked|disabled|busy|bad-hello"}\n  and close

let relayVersion = "0.1.0"
let appGroup = "P5G8WAJ2G2.app.sondine"
let socketInContainer = "run/mcp.sock"
/** Where agents are added and their keys revoked. */
let settingsHint = "Sondine ▸ Settings ▸ Agents"

func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(Data("sondine-mcp: \(message)\n".utf8))
    exit(code)
}

func writeAll(_ fd: Int32, _ bytes: UnsafeRawBufferPointer) -> Bool {
    var offset = 0
    while offset < bytes.count {
        let written = write(fd, bytes.baseAddress! + offset, bytes.count - offset)
        if written < 0 {
            if errno == EINTR { continue }
            return false
        }
        offset += written
    }
    return true
}

func writeAll(_ fd: Int32, _ data: Data) -> Bool {
    data.withUnsafeBytes { writeAll(fd, $0) }
}

/// Copies `from` to `to` until end of file or an error; true at a clean end.
func pump(from: Int32, to: Int32) -> Bool {
    var buffer = [UInt8](repeating: 0, count: 64 << 10)
    while true {
        let count = buffer.withUnsafeMutableBytes { read(from, $0.baseAddress!, $0.count) }
        if count == 0 { return true }
        if count < 0 {
            if errno == EINTR { continue }
            return false
        }
        let ok = buffer.withUnsafeBytes { writeAll(to, UnsafeRawBufferPointer(rebasing: $0[0..<count])) }
        if !ok { return false }
    }
}

func socketPath(arguments: [String]) -> String {
    #if DEBUG
    // Development builds keep their data outside the group container.
    if let index = arguments.firstIndex(of: "--socket"), index + 1 < arguments.count {
        return arguments[index + 1]
    }
    #endif
    guard let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroup
    ) else {
        fail("this copy of Sondine cannot reach its data (no app group container).", code: 69)
    }
    return container.appendingPathComponent(socketInContainer).path
}

func connect(to path: String) -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    if fd < 0 { fail("cannot open a socket (errno \(errno)).", code: 71) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let capacity = MemoryLayout.size(ofValue: address.sun_path)
    let bytes = Array(path.utf8)
    if bytes.count >= capacity { fail("the socket path is too long: \(path)", code: 64) }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
        raw.copyBytes(from: bytes)
        raw[bytes.count] = 0
    }
    let length = socklen_t(MemoryLayout<sockaddr_un>.size)
    let result = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, length) }
    }
    if result != 0 {
        fail("Sondine is not running, or agent access is off (\(settingsHint)).", code: 69)
    }
    return fd
}

/// Reads Sondine's answer line; the bytes after it already belong to the MCP stream.
func readAnswer(_ fd: Int32) -> (line: Data, rest: Data) {
    var timeout = timeval(tv_sec: 10, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var received = Data()
    var chunk = [UInt8](repeating: 0, count: 1024)
    while true {
        if let newline = received.firstIndex(of: UInt8(ascii: "\n")) {
            timeout = timeval(tv_sec: 0, tv_usec: 0)
            setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            return (received[received.startIndex..<newline], received[(newline + 1)...])
        }
        if received.count > 1024 { fail("Sondine sent an unexpected answer.", code: 76) }
        let count = chunk.withUnsafeMutableBytes { read(fd, $0.baseAddress!, $0.count) }
        if count < 0 && errno == EINTR { continue }
        if count <= 0 { fail("Sondine closed the connection before answering.", code: 76) }
        received.append(contentsOf: chunk[0..<count])
    }
}

func refusal(_ reason: String) -> String {
    switch reason {
    case "unknown", "revoked":
        return "Sondine refused this agent: its key was revoked or never given. Add it again in \(settingsHint)."
    case "disabled":
        return "agent access is off in \(settingsHint)."
    case "busy":
        return "too many agents are connected to Sondine right now; try again in a moment."
    default:
        return "Sondine refused the connection (\(reason))."
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.contains("--version") {
    print("sondine-mcp \(relayVersion)")
    exit(0)
}
guard let token = ProcessInfo.processInfo.environment["SONDINE_TOKEN"], !token.isEmpty else {
    fail("SONDINE_TOKEN is not set. Add this agent in \(settingsHint) and use the command it shows.", code: 64)
}

signal(SIGPIPE, SIG_IGN)
let fd = connect(to: socketPath(arguments: arguments))
let hello = try! JSONSerialization.data(withJSONObject: ["v": 1, "token": token]) + Data("\n".utf8)
if !writeAll(fd, hello) { fail("Sondine closed the connection.", code: 76) }
let (line, rest) = readAnswer(fd)
guard let answer = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
    fail("Sondine sent an unexpected answer.", code: 76)
}
if answer["ok"] as? Bool != true {
    fail(refusal(answer["reason"] as? String ?? "unknown"), code: 77)
}
if !rest.isEmpty && !writeAll(STDOUT_FILENO, rest) { exit(0) }

// The agent's messages to Sondine; at their end, Sondine sees the end too.
Thread.detachNewThread {
    if !pump(from: STDIN_FILENO, to: fd) { fail("lost the connection to Sondine.", code: 74) }
    shutdown(fd, SHUT_WR)
}
// Sondine's answers to the agent; when Sondine closes, the relay ends.
if !pump(from: fd, to: STDOUT_FILENO) { fail("lost the connection to Sondine.", code: 74) }
exit(0)
