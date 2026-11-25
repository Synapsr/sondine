import Darwin
import Foundation

/// Where a track run's files live under the spool root: `<track directory>/<runId>/NNNN.pcm`
/// with `NNNN.jsonl` next to each PCM file. Paths are protocol `SpoolPath`s.
public enum SpoolLayout {
    /// A file-system-safe directory name for a track key (`input:Built In` → `input-Built_In`).
    /// Different keys may map to the same name; the run id below it keeps runs apart.
    public static func trackDirectory(for trackKey: String) -> String {
        var name = ""
        for scalar in trackKey.unicodeScalars.prefix(128) {
            switch scalar {
            case ":": name.append("-")
            case "a"..."z", "A"..."Z", "0"..."9", "-", "_", ".": name.unicodeScalars.append(scalar)
            default: name.append("_")
            }
        }
        if name.isEmpty || name.hasPrefix(".") { name = "_" + name }
        return name
    }

    public static func runDirectory(trackKey: String, runId: String) -> String {
        "\(trackDirectory(for: trackKey))/\(runId)"
    }

    public static func fileName(sequence: Int64) -> String { name(sequence) + ".pcm" }
    public static func manifestName(sequence: Int64) -> String { name(sequence) + ".jsonl" }

    private static func name(_ sequence: Int64) -> String {
        let digits = String(sequence)
        return digits.count >= 4 ? digits : String(repeating: "0", count: 4 - digits.count) + digits
    }
}

/// The spool root cannot be used safely.
public struct SpoolLocationError: Error, Equatable, CustomStringConvertible {
    public let description: String

    public init(_ description: String) { self.description = description }
}

extension SpoolLayout {
    /// `<data>/spool`, created (0700) when missing, resolved through symlinks. The result must
    /// be a directory inside the canonical data directory; callers use the returned canonical
    /// path for recovery and every write, so a link replaced later is not followed.
    public static func resolveRoot(dataDirectory: URL) throws -> URL {
        guard let data = canonicalPath(dataDirectory.path(percentEncoded: false)) else {
            throw SpoolLocationError("the data directory cannot be resolved: \(String(cString: strerror(errno)))")
        }
        let spool = (data.hasSuffix("/") ? data : data + "/") + "spool"
        var info = stat()
        if lstat(spool, &info) != 0 {
            guard errno == ENOENT else { throw SpoolLocationError("cannot inspect \(spool): \(String(cString: strerror(errno)))") }
            // mkdir never follows a final symlink, so this creates the directory or fails.
            guard mkdir(spool, 0o700) == 0 || errno == EEXIST else {
                throw SpoolLocationError("cannot create \(spool): \(String(cString: strerror(errno)))")
            }
        }
        guard let resolved = canonicalPath(spool) else {
            throw SpoolLocationError("\(spool) cannot be resolved: \(String(cString: strerror(errno)))")
        }
        let prefix = data.hasSuffix("/") ? data : data + "/"
        guard resolved.hasPrefix(prefix), resolved.count > prefix.count else {
            throw SpoolLocationError("\(spool) resolves to \(resolved), outside the data directory \(data)")
        }
        guard stat(resolved, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else {
            throw SpoolLocationError("\(resolved) is not a directory")
        }
        return URL(filePath: resolved, directoryHint: .isDirectory)
    }

    private static func canonicalPath(_ path: String) -> String? {
        guard let resolved = realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }
}
