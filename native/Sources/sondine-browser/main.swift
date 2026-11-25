import Darwin
import Foundation

// sondine-browser: a browser's native messaging to Sondine's browser socket (ADR 023).
//
// A Chromium browser starts it for Sondine's extension, with the extension's
// origin (`chrome-extension://<id>/`) as its first argument. It names the app
// that started it, sends core one hello line, hands core's one-line answer to
// the extension, then turns native messages (a 4-byte length in native byte
// order, then UTF-8 JSON) into lines and lines back into native messages
// until either side closes. Core checks everything; this tool holds no logic
// and no state. It runs under App Sandbox and reaches only the app group
// container, where the socket is.
//
//   → {"v":1,"origin":"chrome-extension://<id>/","browser":{"bundleId":…,"name":…,"path":…}|null}\n
//   ← {"ok":true}\n  then the extension's messages, one JSON per line
//   ← {"ok":false,"reason":"disabled|busy|bad-hello"}\n  and close
// When Sondine cannot be reached, the relay itself answers the extension
// {"ok":false,"reason":"not-running"}.

let relayVersion = "0.1.0"
let appGroup = "P5G8WAJ2G2.app.sondine"
let socketInContainer = "run/browser.sock"
/** Longest message from the extension (BROWSER_LINE_MAX in packages/protocol). */
let lineMax = 64 * 1024
/** Longest message a browser accepts from its host. */
let frameMax = 1024 * 1024
/** How far up the process tree the browser is looked for. */
let ancestorSteps = 8

func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(Data("sondine-browser: \(message)\n".utf8))
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

/// Fills `buffer` from `fd`; the count read, short only at end of file, or nil on an error.
func readFully(_ fd: Int32, _ buffer: UnsafeMutableRawBufferPointer) -> Int? {
    var offset = 0
    while offset < buffer.count {
        let count = read(fd, buffer.baseAddress! + offset, buffer.count - offset)
        if count == 0 { break }
        if count < 0 {
            if errno == EINTR { continue }
            return nil
        }
        offset += count
    }
    return offset
}

/// One native message: its length in native byte order, then its bytes.
func writeFrame(_ fd: Int32, _ message: some Collection<UInt8>) -> Bool {
    var frame = [UInt8]()
    frame.reserveCapacity(4 + message.count)
    withUnsafeBytes(of: UInt32(message.count)) { frame.append(contentsOf: $0) }
    frame.append(contentsOf: message)
    return frame.withUnsafeBytes { writeAll(fd, $0) }
}

// MARK: The browser

func parent(of pid: pid_t) -> pid_t? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&name, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
    return info.kp_eproc.e_ppid
}

func executablePath(of pid: pid_t) -> String? {
    // PROC_PIDPATHINFO_MAXSIZE
    var buffer = [UInt8](repeating: 0, count: 4 * Int(MAXPATHLEN))
    let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    guard length > 0 else { return nil }
    return String(decoding: buffer[..<Int(length)], as: UTF8.self)
}

/// The outermost `.app` in a path: a browser's helpers live inside its own bundle.
func outermostApp(_ path: String) -> URL? {
    var parts: [Substring] = []
    for part in path.split(separator: "/") {
        parts.append(part)
        if part.count > 4 && part.lowercased().hasSuffix(".app") {
            return URL(fileURLWithPath: "/" + parts.joined(separator: "/"), isDirectory: true)
        }
    }
    return nil
}

/// Matches BundleId in packages/protocol: ^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$
func isBundleId(_ text: String) -> Bool {
    let bytes = Array(text.utf8)
    func allowed(_ byte: UInt8) -> Bool {
        switch byte {
        case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"),
            UInt8(ascii: "0")...UInt8(ascii: "9"):
            return true
        default:
            return false
        }
    }
    guard let first = bytes.first, allowed(first), bytes.count <= 255 else { return false }
    return bytes.dropFirst().allSatisfy { allowed($0) || $0 == UInt8(ascii: "_") || $0 == UInt8(ascii: ".") || $0 == UInt8(ascii: "-") }
}

/// At most `limit` UTF-16 units (JavaScript's length), cut between characters.
func truncated(_ text: String, to limit: Int) -> String {
    var result = ""
    var length = 0
    for character in text {
        length += character.utf16.count
        if length > limit { break }
        result.append(character)
    }
    return result
}

func describe(app: URL) -> [String: String]? {
    guard app.path.utf16.count <= 1024,
        let bundle = Bundle(url: app),
        let bundleId = bundle.bundleIdentifier, isBundleId(bundleId)
    else { return nil }
    let names = [
        bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String,
        bundle.object(forInfoDictionaryKey: "CFBundleName") as? String,
        app.deletingPathExtension().lastPathComponent,
    ]
    let name = names.lazy
        .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
        .first { !$0.isEmpty }
    guard let name else { return nil }
    return ["bundleId": bundleId, "name": truncated(name, to: 120), "path": app.path]
}

/// The nearest ancestor inside an app bundle, named by its outermost bundle;
/// nil when that bundle cannot be read (the sandbox hides ~/Applications),
/// rather than naming an app further up.
func findBrowser() -> [String: String]? {
    var pid = getppid()
    for _ in 0..<ancestorSteps {
        if pid <= 1 { return nil }
        if let path = executablePath(of: pid), let app = outermostApp(path) {
            return describe(app: app)
        }
        guard let next = parent(of: pid) else { return nil }
        pid = next
    }
    return nil
}

// MARK: Sondine

let notRunning = Array(#"{"ok":false,"reason":"not-running"}"#.utf8)

/// Tells the extension Sondine cannot be reached, and ends.
func answerNotRunning(_ detail: String) -> Never {
    FileHandle.standardError.write(Data("sondine-browser: \(detail)\n".utf8))
    _ = writeFrame(STDOUT_FILENO, notRunning)
    exit(0)
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
    if result != 0 { answerNotRunning("Sondine is not running (connect: errno \(errno)).") }
    return fd
}

/// Reads core's answer line; the bytes after it already belong to the stream.
func readAnswer(_ fd: Int32) -> (line: [UInt8], rest: [UInt8]) {
    var timeout = timeval(tv_sec: 10, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var received = [UInt8]()
    var chunk = [UInt8](repeating: 0, count: 1024)
    while true {
        if let newline = received.firstIndex(of: UInt8(ascii: "\n")) {
            timeout = timeval(tv_sec: 0, tv_usec: 0)
            setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            return (Array(received[..<newline]), Array(received[(newline + 1)...]))
        }
        if received.count > 1024 { fail("Sondine sent an unexpected answer.", code: 76) }
        let count = chunk.withUnsafeMutableBytes { read(fd, $0.baseAddress!, $0.count) }
        if count < 0 && errno == EINTR { continue }
        if count == 0 { answerNotRunning("Sondine closed the connection before answering.") }
        if count < 0 { answerNotRunning("Sondine did not answer (errno \(errno)).") }
        received.append(contentsOf: chunk[0..<count])
    }
}

// MARK: The relay

/// The extension's native messages to core, one line each; true at a clean end.
func relayFrames(to socket: Int32) -> Bool {
    var header = [UInt8](repeating: 0, count: 4)
    var payload = [UInt8](repeating: 0, count: lineMax + 1)
    while true {
        guard let got = header.withUnsafeMutableBytes({ readFully(STDIN_FILENO, $0) }) else {
            fail("cannot read from the browser (errno \(errno)).", code: 74)
        }
        if got == 0 { return true }
        if got < 4 { fail("the browser sent a truncated message.", code: 65) }
        let length = Int(header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) })
        if length == 0 { fail("the browser sent an empty message.", code: 65) }
        if length > lineMax { fail("the browser sent a message over \(lineMax) bytes.", code: 65) }
        let body = payload.withUnsafeMutableBytes {
            readFully(STDIN_FILENO, UnsafeMutableRawBufferPointer(rebasing: $0[0..<length]))
        }
        if body != length { fail("the browser sent a truncated message.", code: 65) }
        if payload[0..<length].contains(UInt8(ascii: "\n")) {
            fail("the browser sent a message with a raw newline.", code: 65)
        }
        payload[length] = UInt8(ascii: "\n")
        let ok = payload.withUnsafeBytes {
            writeAll(socket, UnsafeRawBufferPointer(rebasing: $0[0...length]))
        }
        if !ok { return false }
    }
}

/// Core's lines to the extension, one native message each, until core closes.
func relayLines(from socket: Int32, startingWith initial: [UInt8]) -> Never {
    var pending = initial
    var chunk = [UInt8](repeating: 0, count: 64 << 10)
    while true {
        var start = pending.startIndex
        while let newline = pending[start...].firstIndex(of: UInt8(ascii: "\n")) {
            let line = pending[start..<newline]
            if line.count > frameMax { fail("Sondine sent a line over \(frameMax) bytes.", code: 76) }
            if !line.isEmpty && !writeFrame(STDOUT_FILENO, line) {
                fail("lost the browser.", code: 74)
            }
            start = newline + 1
        }
        pending.removeSubrange(..<start)
        if pending.count > frameMax { fail("Sondine sent a line over \(frameMax) bytes.", code: 76) }
        let count = chunk.withUnsafeMutableBytes { read(socket, $0.baseAddress!, $0.count) }
        if count == 0 { exit(0) }
        if count < 0 {
            if errno == EINTR { continue }
            fail("lost the connection to Sondine.", code: 74)
        }
        pending.append(contentsOf: chunk[0..<count])
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.contains("--version") {
    print("sondine-browser \(relayVersion)")
    exit(0)
}

signal(SIGPIPE, SIG_IGN)
// Core refuses anything but `chrome-extension://<id>/` (bad-hello).
let origin = arguments.first ?? ""
let browser: Any = findBrowser() ?? NSNull()
let fd = connect(to: socketPath(arguments: arguments))
let hello = try! JSONSerialization.data(
    withJSONObject: ["v": 1, "origin": origin, "browser": browser],
    options: [.withoutEscapingSlashes]
) + Data("\n".utf8)
if !hello.withUnsafeBytes({ writeAll(fd, $0) }) {
    answerNotRunning("Sondine closed the connection.")
}
let (line, rest) = readAnswer(fd)
guard (try? JSONSerialization.jsonObject(with: Data(line))) is [String: Any] else {
    fail("Sondine sent an unexpected answer.", code: 76)
}
if !writeFrame(STDOUT_FILENO, line) { fail("lost the browser.", code: 74) }
// Anything but a plain yes ends the link; the extension reads the reason.
if line != Array(#"{"ok":true}"#.utf8) { exit(0) }

// The extension's messages to core; at their end, core sees the end too.
Thread.detachNewThread {
    if !relayFrames(to: fd) { fail("lost the connection to Sondine.", code: 74) }
    shutdown(fd, SHUT_WR)
}
// Core's lines to the extension; when core closes, the relay ends.
relayLines(from: fd, startingWith: rest)
