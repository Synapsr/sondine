import Darwin
import Foundation

public struct SocketError: Error, Equatable, CustomStringConvertible {
    public var message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// The helper's private Unix socket (architecture §3 Helper protocol): mode 0600, in a
/// directory the helper's user owns and nobody else can write.
enum UnixSocket {
    /// `sun_path` holds 104 bytes including the terminator.
    static let maxPathBytes = 103

    /// Refuses unsafe locations; removes a stale socket left by a dead helper.
    static func prepare(path: String) throws {
        guard path.hasPrefix("/") else { throw SocketError("the socket path must be absolute") }
        guard path.utf8.count <= maxPathBytes else { throw SocketError("the socket path is longer than \(maxPathBytes) bytes") }
        let parent = (path as NSString).deletingLastPathComponent
        var info = stat()
        guard lstat(parent, &info) == 0 else { throw SocketError("the socket directory does not exist") }
        guard info.st_mode & S_IFMT == S_IFDIR else { throw SocketError("the socket directory is not a directory") }
        guard info.st_uid == geteuid() else { throw SocketError("the socket directory is not owned by this user") }
        guard info.st_mode & 0o022 == 0 else { throw SocketError("the socket directory is writable by other users") }
        guard lstat(path, &info) == 0 else { return }
        guard info.st_mode & S_IFMT == S_IFSOCK, info.st_uid == geteuid() else {
            throw SocketError("the socket path exists and is not this user's socket")
        }
        if isListening(path) { throw SocketError("another helper is listening on the socket") }
        guard unlink(path) == 0 else { throw SocketError("cannot remove the stale socket: \(String(cString: strerror(errno)))") }
    }

    static func listen(path: String) throws -> Int32 {
        try prepare(path: path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SocketError("socket: \(String(cString: strerror(errno)))") }
        var address = try socketAddress(path)
        // The node is created with mode 0600 (umask), then set explicitly.
        let previous = umask(0o177)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        umask(previous)
        guard bound == 0 else {
            let message = String(cString: strerror(errno))
            close(fd)
            throw SocketError("bind: \(message)")
        }
        chmod(path, 0o600)
        guard Darwin.listen(fd, 4) == 0 else {
            let message = String(cString: strerror(errno))
            close(fd)
            unlink(path)
            throw SocketError("listen: \(message)")
        }
        setNonBlocking(fd)
        return fd
    }

    static func connect(path: String) throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SocketError("socket: \(String(cString: strerror(errno)))") }
        var address = try socketAddress(path)
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard result == 0 else {
            let message = String(cString: strerror(errno))
            close(fd)
            throw SocketError("connect: \(message)")
        }
        return fd
    }

    static func isListening(_ path: String) -> Bool {
        guard let fd = try? connect(path: path) else { return false }
        close(fd)
        return true
    }

    static func setNonBlocking(_ fd: Int32) {
        let flags = fcntl(fd, F_GETFL)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
        var on: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    }

    /// The connecting process runs as this user.
    static func peerIsSameUser(_ fd: Int32) -> Bool {
        var uid: uid_t = 0
        var gid: gid_t = 0
        return getpeereid(fd, &uid, &gid) == 0 && uid == geteuid()
    }

    private static func socketAddress(_ path: String) throws -> sockaddr_un {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count <= maxPathBytes else { throw SocketError("the socket path is longer than \(maxPathBytes) bytes") }
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            buffer.copyBytes(from: bytes)
            buffer[bytes.count] = 0
        }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        return address
    }
}
