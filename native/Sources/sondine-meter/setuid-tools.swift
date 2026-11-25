import Darwin

// proc_pid_rusage refuses other users' processes (coreaudiod runs as _coreaudiod: EPERM).
// /bin/ps and /usr/bin/top are setuid root and can read them.
// - ps is cheap (a few ms), so it runs every tick for CPU time: 10 ms resolution per reading,
//   exact over a run because the counter is cumulative.
// - top walks every process: its first sample costs about 1.5 s of CPU, each later sample of
//   the same top process about 0.2 s. One long-running `top -s <privilegedIntervalS>` streams
//   the cumulative idle-wakeup counter and the footprint (about 0.3 % of a core at 60 s).

struct TopRow: Equatable, Sendable {
    var pid: Int32
    var idleWakeups: UInt64
    var footprintBytes: UInt64
}

enum SetuidTools {
    static let psPath = "/bin/ps"
    static let topPath = "/usr/bin/top"

    /// Cumulative user + system CPU time in ns per pid; pids that exited are absent.
    static func cpuTimes(of pids: [Int32]) -> [Int32: UInt64] {
        guard !pids.isEmpty else { return [:] }
        let list = pids.map(String.init).joined(separator: ",")
        guard let output = runTool(psPath, ["-o", "pid=,time=", "-p", list], timeoutSeconds: 10) else { return [:] }
        var result: [Int32: UInt64] = [:]
        for line in output.split(whereSeparator: \.isNewline) {
            let fields = line.split(whereSeparator: \.isWhitespace)
            guard fields.count == 2, let pid = Int32(fields[0]), let ns = parsePsTime(String(fields[1])) else { continue }
            result[pid] = ns
        }
        return result
    }
}

/// A `top -l <samples> -s <interval>` child whose rows the sampler drains every tick without
/// blocking. Rows reach the meter within one tick of top printing them.
final class TopStream {
    let pids: [Int32]
    private let child: pid_t
    private let readEnd: Int32
    private var pending: [UInt8] = []
    private var stopped = false

    /// `samples` 0 means until stopped. A bounded count lets an orphaned top end by itself.
    init?(pids: [Int32], intervalS: Int, samples: Int) {
        guard !pids.isEmpty else { return nil }
        var arguments = ["-l", String(max(0, samples)), "-s", String(max(1, intervalS)), "-stats", "pid,idlew,mem"]
        for pid in pids { arguments += ["-pid", String(pid)] }
        guard let spawned = spawnTool(SetuidTools.topPath, arguments) else { return nil }
        let flags = fcntl(spawned.readEnd, F_GETFL)
        _ = fcntl(spawned.readEnd, F_SETFL, flags | O_NONBLOCK)
        self.pids = pids
        child = spawned.pid
        readEnd = spawned.readEnd
    }

    deinit { stop() }

    /// Rows printed since the last call, in order.
    func drain() -> [TopRow] {
        guard !stopped else { return [] }
        var chunk = [UInt8](repeating: 0, count: 16_384)
        while true {
            let count = chunk.withUnsafeMutableBytes { read(readEnd, $0.baseAddress, $0.count) }
            if count > 0 {
                pending.append(contentsOf: chunk.prefix(count))
                continue
            }
            if count < 0, errno == EINTR { continue }
            break
        }
        guard let lastNewline = pending.lastIndex(of: 0x0A) else { return [] }
        let complete = String(decoding: pending[...lastNewline], as: UTF8.self)
        pending.removeSubrange(...lastNewline)
        return complete.split(whereSeparator: \.isNewline).compactMap { line in
            parseTopRow(String(line)).flatMap { pids.contains($0.pid) ? $0 : nil }
        }
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        kill(child, SIGTERM)
        var status: Int32 = 0
        while waitpid(child, &status, 0) < 0, errno == EINTR {}
        close(readEnd)
    }
}

/// ps TIME: `[[dd-]hh:]mm:ss.cc`, where macOS lets the minutes grow past 59 (e.g. 207:10.12).
func parsePsTime(_ text: String) -> UInt64? {
    var rest = Substring(text)
    var days: UInt64 = 0
    if let dash = rest.firstIndex(of: "-") {
        guard let value = UInt64(rest[..<dash]) else { return nil }
        days = value
        rest = rest[rest.index(after: dash)...]
    }
    let parts = rest.split(separator: ":", omittingEmptySubsequences: false)
    guard (2...3).contains(parts.count), let secondsPart = parts.last else { return nil }
    let secondFields = secondsPart.split(separator: ".", omittingEmptySubsequences: false)
    guard (1...2).contains(secondFields.count), let seconds = UInt64(secondFields[0]) else { return nil }
    var fractionNs: UInt64 = 0
    if secondFields.count == 2 {
        let digits = secondFields[1]
        guard !digits.isEmpty, digits.count <= 9, let value = UInt64(digits) else { return nil }
        fractionNs = value * UInt64(powerOfTen(9 - digits.count))
    }
    var minutes: UInt64 = 0
    var hours: UInt64 = 0
    if parts.count == 3 {
        guard let h = UInt64(parts[0]), let m = UInt64(parts[1]) else { return nil }
        hours = h
        minutes = m
    } else {
        guard let m = UInt64(parts[0]) else { return nil }
        minutes = m
    }
    let totalSeconds = ((days * 24 + hours) * 60 + minutes) * 60 + seconds
    return totalSeconds * 1_000_000_000 + fractionNs
}

private func powerOfTen(_ exponent: Int) -> Int {
    (0..<exponent).reduce(1) { value, _ in value * 10 }
}

/// top MEM: an integer with a binary unit (`B`, `K`, `M`, `G`, `T`) and an optional trend mark.
func parseTopMemory(_ text: String) -> UInt64? {
    let trimmed = text.trimmingSuffix { "+-*".contains($0) }
    guard let unit = trimmed.last, let value = UInt64(trimmed.dropLast()) else { return nil }
    let shift: UInt64
    switch unit {
    case "B": shift = 0
    case "K": shift = 10
    case "M": shift = 20
    case "G": shift = 30
    case "T": shift = 40
    default: return nil
    }
    return value << shift
}

/// A data row of `top -stats pid,idlew,mem`, e.g. `621  15019277+ 42M`.
func parseTopRow(_ line: String) -> TopRow? {
    let fields = line.split(whereSeparator: \.isWhitespace)
    guard fields.count == 3, let pid = Int32(fields[0]) else { return nil }
    let wakeupsText = String(fields[1]).trimmingSuffix { "+-*".contains($0) }
    guard let wakeups = UInt64(wakeupsText), let memory = parseTopMemory(String(fields[2])) else { return nil }
    return TopRow(pid: pid, idleWakeups: wakeups, footprintBytes: memory)
}

extension String {
    fileprivate func trimmingSuffix(while predicate: (Character) -> Bool) -> String {
        var end = endIndex
        while end > startIndex, predicate(self[index(before: end)]) { end = index(before: end) }
        return String(self[..<end])
    }
}

/// Starts a tool with stdin and stderr on /dev/null and stdout on a pipe. The child gets
/// default signal handling back (the meter ignores SIGINT, SIGTERM and SIGPIPE), so Ctrl-C
/// reaches it and it dies on a broken pipe if the meter is gone.
func spawnTool(_ path: String, _ arguments: [String]) -> (pid: pid_t, readEnd: Int32)? {
    var pipeEnds: [Int32] = [0, 0]
    guard pipe(&pipeEnds) == 0 else { return nil }
    let readEnd = pipeEnds[0]
    let writeEnd = pipeEnds[1]

    var actions: posix_spawn_file_actions_t? = nil
    posix_spawn_file_actions_init(&actions)
    defer { posix_spawn_file_actions_destroy(&actions) }
    posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0)
    posix_spawn_file_actions_adddup2(&actions, writeEnd, STDOUT_FILENO)
    posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0)

    var attributes: posix_spawnattr_t? = nil
    posix_spawnattr_init(&attributes)
    defer { posix_spawnattr_destroy(&attributes) }
    var defaults = sigset_t()
    sigemptyset(&defaults)
    for signalNumber in [SIGINT, SIGTERM, SIGPIPE] { sigaddset(&defaults, signalNumber) }
    posix_spawnattr_setsigdefault(&attributes, &defaults)
    // CLOEXEC_DEFAULT: only the descriptors set up above reach the child (not the sample file).
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF))

    let argv: [UnsafeMutablePointer<CChar>?] = ([path] + arguments).map { strdup($0) } + [nil]
    defer { argv.forEach { free($0) } }
    var child: pid_t = 0
    let status = posix_spawn(&child, path, &actions, &attributes, argv, environ)
    close(writeEnd)
    guard status == 0 else {
        close(readEnd)
        return nil
    }
    return (child, readEnd)
}

/// Runs a tool and returns its stdout, or nil when it cannot start, exceeds the timeout (then
/// it is killed), or exits non-zero with no output.
func runTool(_ path: String, _ arguments: [String], timeoutSeconds: Int) -> String? {
    guard let (child, readEnd) = spawnTool(path, arguments) else { return nil }
    defer { close(readEnd) }
    var output: [UInt8] = []
    var chunk = [UInt8](repeating: 0, count: 16_384)
    let deadline = clock_gettime_nsec_np(CLOCK_UPTIME_RAW) + UInt64(timeoutSeconds) * 1_000_000_000
    var timedOut = false
    while true {
        let now = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
        guard now < deadline else {
            timedOut = true
            break
        }
        var descriptor = pollfd(fd: readEnd, events: Int16(POLLIN), revents: 0)
        let ready = poll(&descriptor, 1, Int32(min(1_000, (deadline - now) / 1_000_000 + 1)))
        if ready < 0, errno == EINTR { continue }
        guard ready > 0 else { continue }
        let count = chunk.withUnsafeMutableBytes { read(readEnd, $0.baseAddress, $0.count) }
        if count < 0, errno == EINTR { continue }
        guard count > 0 else { break }
        output.append(contentsOf: chunk.prefix(count))
    }
    if timedOut { kill(child, SIGKILL) }
    var exitStatus: Int32 = 0
    while waitpid(child, &exitStatus, 0) < 0, errno == EINTR {}
    let text = String(decoding: output, as: UTF8.self)
    if timedOut || (exitStatus != 0 && text.isEmpty) { return nil }
    return text
}
