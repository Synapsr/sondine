import Darwin
import Foundation
import Synchronization

/// An app bundle a process belongs to.
public struct AppBundle: Sendable, Equatable {
    public var bundleId: String
    public var name: String?

    public init(bundleId: String, name: String?) {
        self.bundleId = bundleId
        self.name = name
    }
}

/// What the resolver may ask the OS about a process. The Darwin implementation uses private
/// SPI where it must; tests replay fixtures recorded from a real Mac.
public protocol ProcessIntrospection: Sendable {
    /// `responsibility_get_pid_responsible_for_pid`; nil when the SPI is missing or fails.
    func responsiblePID(_ pid: Int32) -> Int32?
    func parentPID(_ pid: Int32) -> Int32?
    /// Process start time in wall-clock nanoseconds (half of the incarnation key).
    func startWallNs(_ pid: Int32) -> UInt64?
    func executablePath(_ pid: Int32) -> String?
    func processName(_ pid: Int32) -> String?
    /// The app whose main executable this process runs (what `NSRunningApplication` reports).
    func runningApp(_ pid: Int32) -> AppBundle?
    /// The outermost `.app` bundle that contains `path`.
    func enclosingApp(path: String) -> AppBundle?
}

/// The real OS. No AppKit: apps are read from their bundle on disk, which keeps the helper's
/// footprint down; results are cached per bundle path.
public final class DarwinProcessIntrospection: ProcessIntrospection, @unchecked Sendable {
    private typealias ResponsibleFunction = @convention(c) (pid_t) -> pid_t

    private let responsible: ResponsibleFunction?
    private let bundles = Mutex<[String: AppBundle?]>([:])

    public init() {
        // Private SPI in libquarantine (Chromium uses it too); behavioural fallbacks follow.
        if let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") {
            responsible = unsafeBitCast(symbol, to: ResponsibleFunction.self)
        } else {
            responsible = nil
        }
    }

    public var hasResponsibilitySPI: Bool { responsible != nil }

    public func responsiblePID(_ pid: Int32) -> Int32? {
        guard let responsible else { return nil }
        let result = responsible(pid)
        return result > 0 ? result : nil
    }

    public func parentPID(_ pid: Int32) -> Int32? {
        guard let info = bsdInfo(pid) else { return nil }
        return info.pbi_ppid > 0 ? Int32(info.pbi_ppid) : nil
    }

    public func startWallNs(_ pid: Int32) -> UInt64? {
        guard let info = bsdInfo(pid), info.pbi_start_tvsec > 0 else { return nil }
        return info.pbi_start_tvsec * 1_000_000_000 + info.pbi_start_tvusec * 1_000
    }

    public func executablePath(_ pid: Int32) -> String? {
        var buffer = [CChar](repeating: 0, count: Int(4 * MAXPATHLEN))
        let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard length > 0 else { return nil }
        return String(decoding: buffer.prefix(Int(length)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }

    public func processName(_ pid: Int32) -> String? {
        var buffer = [CChar](repeating: 0, count: 256)
        let length = proc_name(pid, &buffer, UInt32(buffer.count))
        guard length > 0 else { return nil }
        return String(decoding: buffer.prefix(Int(length)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }

    public func runningApp(_ pid: Int32) -> AppBundle? {
        guard let path = executablePath(pid) else { return nil }
        // `X.app/Contents/MacOS/<executable>`: the process is that app's main executable.
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard components.count >= 4, components[components.count - 2] == "MacOS", components[components.count - 3] == "Contents",
              components[components.count - 4].hasSuffix(".app")
        else { return nil }
        return bundle(at: components.dropLast(3).joined(separator: "/"))
    }

    public func enclosingApp(path: String) -> AppBundle? {
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard let index = components.firstIndex(where: { $0.hasSuffix(".app") }) else { return nil }
        return bundle(at: components[...index].joined(separator: "/"))
    }

    private func bundle(at path: String) -> AppBundle? {
        if let cached = bundles.withLock({ $0[path] }) { return cached }
        var result: AppBundle?
        if let bundle = Bundle(path: path), let identifier = bundle.bundleIdentifier, !identifier.isEmpty {
            let info = bundle.infoDictionary ?? [:]
            let name = info["CFBundleDisplayName"] as? String
                ?? info["CFBundleName"] as? String
                ?? URL(filePath: path).deletingPathExtension().lastPathComponent
            result = AppBundle(bundleId: identifier, name: name)
        }
        bundles.withLock { $0[path] = .some(result) }
        return result
    }

    private func bsdInfo(_ pid: Int32) -> proc_bsdinfo? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return info
    }
}
