import Darwin
import Foundation

public enum SpoolIOError: Error, Equatable, CustomStringConvertible {
    /// ENOSPC or EDQUOT.
    case noSpace(operation: String, path: String)
    case failed(operation: String, path: String, errno: Int32)

    public var description: String {
        switch self {
        case .noSpace(let operation, let path): "\(operation) \(path): no space left on device"
        case .failed(let operation, let path, let code): "\(operation) \(path): \(String(cString: strerror(code)))"
        }
    }

    public var isNoSpace: Bool {
        if case .noSpace = self { true } else { false }
    }

    static func from(errno code: Int32, operation: String, path: String) -> SpoolIOError {
        code == ENOSPC || code == EDQUOT ? .noSpace(operation: operation, path: path) : .failed(operation: operation, path: path, errno: code)
    }
}

/// How `sync` makes bytes durable.
public enum SpoolSyncMode: String, Sendable, Codable {
    /// `fsync`: the architecture's commit protocol. CRCs catch reordering by the drive cache.
    case fsync
    /// `F_BARRIERFSYNC`: also orders the writes against later ones on APFS.
    case barrier
    /// `F_FULLFSYNC`: flushes the drive cache; the most durable and the most expensive.
    case full
}

public struct SpoolFileHandle: Sendable, Hashable {
    public let descriptor: Int32
    public let path: String
}

/// File operations the spool needs. Tests inject failures (disk full, I/O errors) through it.
public protocol SpoolFileSystem: AnyObject {
    func createDirectory(at url: URL) throws
    /// Creates a new file for writing; fails if it exists.
    func createFile(at url: URL) throws -> SpoolFileHandle
    /// Opens an existing file for reading and writing.
    func openFile(at url: URL) throws -> SpoolFileHandle
    func write(_ bytes: UnsafeRawBufferPointer, to handle: SpoolFileHandle, at offset: Int64) throws
    func sync(_ handle: SpoolFileHandle, mode: SpoolSyncMode) throws
    func truncate(_ handle: SpoolFileHandle, to length: Int64) throws
    func size(of handle: SpoolFileHandle) throws -> Int64
    func read(_ handle: SpoolFileHandle, at offset: Int64, count: Int) throws -> [UInt8]
    func close(_ handle: SpoolFileHandle)
    /// Makes directory entries (new files) durable.
    func syncDirectory(at url: URL) throws
    func contentsOfDirectory(at url: URL) throws -> [URL]
    func fileExists(at url: URL) -> Bool
    func isDirectory(at url: URL) -> Bool
}

/// POSIX implementation: explicit-offset `pwrite`, `fsync`/`fcntl` syncs, no buffering.
public final class PosixSpoolFileSystem: SpoolFileSystem {
    public init() {}

    public func createDirectory(at url: URL) throws {
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        } catch {
            throw SpoolIOError.failed(operation: "mkdir", path: url.path(percentEncoded: false), errno: Self.errnoValue(of: error))
        }
    }

    public func createFile(at url: URL) throws -> SpoolFileHandle {
        try open(url, flags: O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, operation: "create")
    }

    public func openFile(at url: URL) throws -> SpoolFileHandle {
        try open(url, flags: O_RDWR | O_CLOEXEC, operation: "open")
    }

    public func write(_ bytes: UnsafeRawBufferPointer, to handle: SpoolFileHandle, at offset: Int64) throws {
        guard var base = bytes.baseAddress else { return }
        var remaining = bytes.count
        var position = offset
        while remaining > 0 {
            let written = pwrite(handle.descriptor, base, remaining, off_t(position))
            if written < 0 {
                if errno == EINTR { continue }
                throw SpoolIOError.from(errno: errno, operation: "write", path: handle.path)
            }
            remaining -= written
            position += Int64(written)
            base += written
        }
    }

    public func sync(_ handle: SpoolFileHandle, mode: SpoolSyncMode) throws {
        let result: Int32 = switch mode {
        case .fsync: fsync(handle.descriptor)
        case .barrier: fcntl(handle.descriptor, F_BARRIERFSYNC)
        case .full: fcntl(handle.descriptor, F_FULLFSYNC)
        }
        if result != 0 { throw SpoolIOError.from(errno: errno, operation: "fsync", path: handle.path) }
    }

    public func truncate(_ handle: SpoolFileHandle, to length: Int64) throws {
        if ftruncate(handle.descriptor, off_t(length)) != 0 {
            throw SpoolIOError.from(errno: errno, operation: "truncate", path: handle.path)
        }
    }

    public func size(of handle: SpoolFileHandle) throws -> Int64 {
        var info = stat()
        if fstat(handle.descriptor, &info) != 0 { throw SpoolIOError.from(errno: errno, operation: "stat", path: handle.path) }
        return Int64(info.st_size)
    }

    public func read(_ handle: SpoolFileHandle, at offset: Int64, count: Int) throws -> [UInt8] {
        var buffer = [UInt8](repeating: 0, count: count)
        var filled = 0
        while filled < count {
            let result = buffer.withUnsafeMutableBytes { raw in
                pread(handle.descriptor, raw.baseAddress! + filled, count - filled, off_t(offset + Int64(filled)))
            }
            if result < 0 {
                if errno == EINTR { continue }
                throw SpoolIOError.from(errno: errno, operation: "read", path: handle.path)
            }
            if result == 0 { break }
            filled += result
        }
        return Array(buffer.prefix(filled))
    }

    public func close(_ handle: SpoolFileHandle) {
        Darwin.close(handle.descriptor)
    }

    public func syncDirectory(at url: URL) throws {
        let path = url.path(percentEncoded: false)
        let descriptor = Darwin.open(path, O_RDONLY | O_CLOEXEC)
        guard descriptor >= 0 else { throw SpoolIOError.from(errno: errno, operation: "open", path: path) }
        defer { Darwin.close(descriptor) }
        if fsync(descriptor) != 0 { throw SpoolIOError.from(errno: errno, operation: "fsync", path: path) }
    }

    public func contentsOfDirectory(at url: URL) throws -> [URL] {
        do {
            return try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil)
        } catch {
            throw SpoolIOError.failed(operation: "list", path: url.path(percentEncoded: false), errno: Self.errnoValue(of: error))
        }
    }

    public func fileExists(at url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path(percentEncoded: false))
    }

    public func isDirectory(at url: URL) -> Bool {
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path(percentEncoded: false), isDirectory: &directory) && directory.boolValue
    }

    private func open(_ url: URL, flags: Int32, operation: String) throws -> SpoolFileHandle {
        let path = url.path(percentEncoded: false)
        let descriptor = Darwin.open(path, flags, 0o600)
        guard descriptor >= 0 else { throw SpoolIOError.from(errno: errno, operation: operation, path: path) }
        return SpoolFileHandle(descriptor: descriptor, path: path)
    }

    private static func errnoValue(of error: any Error) -> Int32 {
        let underlying = (error as NSError).userInfo[NSUnderlyingErrorKey] as? NSError
        if let underlying, underlying.domain == NSPOSIXErrorDomain { return Int32(underlying.code) }
        return EIO
    }
}
