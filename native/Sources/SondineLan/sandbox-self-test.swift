import Darwin
import Foundation

/// `sondine-lan self-test sandbox` (ADR 008, ADR 010): the relay runs under
/// App Sandbox (a file in the home folder cannot be created) and may listen.
/// It holds `network.client` too, which Network.framework's listener needs to
/// answer a peer on the Wi-Fi, so an outbound connection is not something the
/// sandbox refuses any more. One JSON line per check on stdout; exit 0 when
/// all hold.
enum SandboxSelfTest {
    static func run() -> Int32 {
        var results: [Bool] = []
        func report(_ line: [String: Any]) {
            if let ok = line["ok"] as? Bool { results.append(ok) }
            LanCommand.emit(line)
        }
        report(sandboxStatus())
        report(homeWriteDenied())
        report(listenAllowed())
        let ok = !results.contains(false)
        report(["check": "summary", "ok": ok, "passed": results.filter { $0 }.count, "failed": results.filter { !$0 }.count])
        return ok ? 0 : 1
    }

    /// Informational: whether the kernel sees this process as sandboxed.
    private static func sandboxStatus() -> [String: Any] {
        typealias SandboxCheck = @convention(c) (pid_t, UnsafePointer<CChar>?, Int32) -> Int32
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "sandbox_check") else {
            return ["check": "sandboxed", "value": NSNull()]
        }
        return ["check": "sandboxed", "value": unsafeBitCast(symbol, to: SandboxCheck.self)(getpid(), nil, 0) != 0]
    }

    /// The sandbox in effect: creating a file in the user's real home folder
    /// (not the container's) is refused.
    private static func homeWriteDenied() -> [String: Any] {
        guard let home = getpwuid(getuid())?.pointee.pw_dir else {
            return ["check": "file.home-write-denied", "ok": false, "outcome": "no-home"]
        }
        let path = String(cString: home) + "/.sondine-lan-self-test-\(getpid())"
        let fd = open(path, O_CREAT | O_EXCL | O_WRONLY, 0o600)
        if fd >= 0 {
            close(fd)
            unlink(path)
            return ["check": "file.home-write-denied", "ok": false, "outcome": "created"]
        }
        let code = errno
        let denied = code == EPERM || code == EACCES
        return [
            "check": "file.home-write-denied", "ok": denied, "outcome": denied ? "denied" : "failed",
            "errno": String(cString: strerror(code)),
        ]
    }

    /// `network.server` in effect: a TCP socket binds and listens on loopback.
    private static func listenAllowed() -> [String: Any] {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return ["check": "network.listen-allowed", "ok": false, "errno": String(cString: strerror(errno))] }
        defer { close(fd) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = in_addr_t(INADDR_LOOPBACK).bigEndian
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        let ok = bound == 0 && listen(fd, 1) == 0
        return ["check": "network.listen-allowed", "ok": ok, "errno": ok ? NSNull() : String(cString: strerror(errno))]
    }
}
