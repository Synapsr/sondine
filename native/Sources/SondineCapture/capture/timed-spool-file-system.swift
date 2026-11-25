import Darwin
import Foundation
import SondineKit

/// Wraps the spool's file system to measure writes and syncs per track (`spool-write`,
/// `spool-fsync`, `manifest-fsync` health stages). Used on the drain worker only.
final class TimedSpoolFileSystem: SpoolFileSystem {
    private let base: any SpoolFileSystem
    private(set) var write = StageHistogramAccumulator()
    private(set) var dataSync = StageHistogramAccumulator()
    private(set) var manifestSync = StageHistogramAccumulator()

    init(base: any SpoolFileSystem = PosixSpoolFileSystem()) {
        self.base = base
    }

    func takeHistograms() -> (write: StageHistogramAccumulator, dataSync: StageHistogramAccumulator, manifestSync: StageHistogramAccumulator) {
        defer {
            write = StageHistogramAccumulator()
            dataSync = StageHistogramAccumulator()
            manifestSync = StageHistogramAccumulator()
        }
        return (write, dataSync, manifestSync)
    }

    private func timed<T>(_ body: () throws -> T, into histogram: inout StageHistogramAccumulator) rethrows -> T {
        let start = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
        defer { histogram.record(clock_gettime_nsec_np(CLOCK_UPTIME_RAW) &- start) }
        return try body()
    }

    func createDirectory(at url: URL) throws { try base.createDirectory(at: url) }
    func createFile(at url: URL) throws -> SpoolFileHandle { try base.createFile(at: url) }
    func openFile(at url: URL) throws -> SpoolFileHandle { try base.openFile(at: url) }

    func write(_ bytes: UnsafeRawBufferPointer, to handle: SpoolFileHandle, at offset: Int64) throws {
        try timed({ try base.write(bytes, to: handle, at: offset) }, into: &write)
    }

    func sync(_ handle: SpoolFileHandle, mode: SpoolSyncMode) throws {
        if handle.path.hasSuffix(".jsonl") {
            try timed({ try base.sync(handle, mode: mode) }, into: &manifestSync)
        } else {
            try timed({ try base.sync(handle, mode: mode) }, into: &dataSync)
        }
    }

    func truncate(_ handle: SpoolFileHandle, to length: Int64) throws { try base.truncate(handle, to: length) }
    func size(of handle: SpoolFileHandle) throws -> Int64 { try base.size(of: handle) }
    func read(_ handle: SpoolFileHandle, at offset: Int64, count: Int) throws -> [UInt8] { try base.read(handle, at: offset, count: count) }
    func close(_ handle: SpoolFileHandle) { base.close(handle) }
    func syncDirectory(at url: URL) throws { try base.syncDirectory(at: url) }
    func contentsOfDirectory(at url: URL) throws -> [URL] { try base.contentsOfDirectory(at: url) }
    func fileExists(at url: URL) -> Bool { base.fileExists(at: url) }
    func isDirectory(at url: URL) -> Bool { base.isDirectory(at: url) }
}
