@preconcurrency import AVFAudio
import Darwin
import Foundation
import SondineKit
import Synchronization
import Testing

enum Signal {
    /// Interleaved sine starting at time `start` seconds (phase-continuous across calls).
    static func sine(
        frequency: Double,
        rate: Double,
        seconds: Double,
        amplitude: Float = 0.5,
        channels: Int = 1,
        start: Double = 0
    ) -> [Float] {
        let frames = Int((seconds * rate).rounded())
        var samples = [Float](repeating: 0, count: frames * channels)
        for frame in 0..<frames {
            let time = start + Double(frame) / rate
            let value = amplitude * Float(sin(2 * Double.pi * frequency * time))
            for channel in 0..<channels { samples[frame * channels + channel] = value }
        }
        return samples
    }

    /// Deterministic white noise at an RMS level in dBFS.
    static func noise(seconds: Double, rate: Double = 16_000, rmsDb: Float, seed: UInt64 = 1) -> [Float] {
        var generator = SplitMix(seed: seed)
        let count = Int(seconds * rate)
        // Uniform in [-a, a] has RMS a / √3.
        let amplitude = powf(10, rmsDb / 20) * sqrtf(3)
        return (0..<count).map { _ in amplitude * (Float(generator.next() >> 40) / Float(1 << 24) * 2 - 1) }
    }

    /// Frequency from linearly interpolated rising zero crossings.
    static func frequency(_ samples: ArraySlice<Float>, rate: Double) -> Double {
        var crossings: [Double] = []
        let values = Array(samples)
        for index in 1..<values.count where values[index - 1] < 0 && values[index] >= 0 {
            let fraction = Double(-values[index - 1] / (values[index] - values[index - 1]))
            crossings.append(Double(index - 1) + fraction)
        }
        guard crossings.count >= 2, let first = crossings.first, let last = crossings.last else { return 0 }
        return Double(crossings.count - 1) / ((last - first) / rate)
    }

    /// THD+N in dB: residual after a least-squares fit of a sine at `frequency` (plus offset).
    static func thdPlusNoiseDb(_ samples: ArraySlice<Float>, rate: Double, frequency: Double) -> Double {
        let values = samples.map(Double.init)
        let n = Double(values.count)
        var sumC = 0.0, sumS = 0.0, sumCC = 0.0, sumSS = 0.0, sumCS = 0.0, sumX = 0.0, sumXC = 0.0, sumXS = 0.0
        for (index, x) in values.enumerated() {
            let phase = 2 * Double.pi * frequency * Double(index) / rate
            let c = cos(phase), s = sin(phase)
            sumC += c; sumS += s; sumCC += c * c; sumSS += s * s; sumCS += c * s
            sumX += x; sumXC += x * c; sumXS += x * s
        }
        // Solve the 3×3 normal equations for x ≈ a·cos + b·sin + d.
        let matrix = [[sumCC, sumCS, sumC], [sumCS, sumSS, sumS], [sumC, sumS, n]]
        let vector = [sumXC, sumXS, sumX]
        let solution = solve3(matrix, vector)
        var residual = 0.0, fitted = 0.0
        for (index, x) in values.enumerated() {
            let phase = 2 * Double.pi * frequency * Double(index) / rate
            let fit = solution[0] * cos(phase) + solution[1] * sin(phase) + solution[2]
            residual += (x - fit) * (x - fit)
            fitted += (fit - solution[2]) * (fit - solution[2])
        }
        return 10 * log10(max(residual, 1e-30) / max(fitted, 1e-30))
    }

    private static func solve3(_ a: [[Double]], _ b: [Double]) -> [Double] {
        func det(_ m: [[Double]]) -> Double {
            m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
        }
        let d = det(a)
        return (0..<3).map { column in
            var m = a
            for row in 0..<3 { m[row][column] = b[row] }
            return det(m) / d
        }
    }
}

struct SplitMix {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

/// A clock with fixed readings, so manifests are deterministic.
struct FixedClock: HostClock {
    var timebase = HostTimebase(numer: 125, denom: 3)
    var hostTicks: UInt64 = 1_000_000_000
    var sleptNs: UInt64 = 5_000_000_000
    var wallNs: UInt64 = 1_793_610_000_000_000_000

    func anchor() -> ClockAnchor {
        ClockAnchor(
            hostTicks: hostTicks,
            continuousNs: timebase.nanoseconds(fromTicks: hostTicks) + sleptNs,
            wallNs: wallNs
        )
    }
}

/// A temporary directory removed when the value is released.
final class TemporaryDirectory {
    let url: URL

    init() throws {
        url = FileManager.default.temporaryDirectory.appending(path: "sondine-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    deinit { try? FileManager.default.removeItem(at: url) }
}

/// Real POSIX file system with injectable failures.
final class FaultInjectingFileSystem: SpoolFileSystem {
    let base = PosixSpoolFileSystem()
    /// Called before each write; returning an error makes the write fail without touching the file.
    var writeFault: ((SpoolFileHandle, Int64) -> SpoolIOError?)?
    /// A failed write first stores the first half of its bytes (a torn write).
    var tearFailedWrites = false
    var syncFault: ((SpoolFileHandle) -> SpoolIOError?)?
    var truncateFault: ((SpoolFileHandle) -> SpoolIOError?)?
    var createFault: ((URL) -> SpoolIOError?)?
    var syncDirectoryFault: ((URL) -> SpoolIOError?)?
    private(set) var failedWrites = 0
    /// Descriptors opened through this file system and not closed yet.
    private(set) var openDescriptors: Set<Int32> = []

    func createDirectory(at url: URL) throws { try base.createDirectory(at: url) }

    func createFile(at url: URL) throws -> SpoolFileHandle {
        if let error = createFault?(url) { throw error }
        let handle = try base.createFile(at: url)
        openDescriptors.insert(handle.descriptor)
        return handle
    }

    func openFile(at url: URL) throws -> SpoolFileHandle {
        let handle = try base.openFile(at: url)
        openDescriptors.insert(handle.descriptor)
        return handle
    }

    func write(_ bytes: UnsafeRawBufferPointer, to handle: SpoolFileHandle, at offset: Int64) throws {
        if let error = writeFault?(handle, offset) {
            failedWrites += 1
            if tearFailedWrites { try base.write(UnsafeRawBufferPointer(rebasing: bytes[..<(bytes.count / 2)]), to: handle, at: offset) }
            throw error
        }
        try base.write(bytes, to: handle, at: offset)
    }

    func sync(_ handle: SpoolFileHandle, mode: SpoolSyncMode) throws {
        if let error = syncFault?(handle) { throw error }
        try base.sync(handle, mode: mode)
    }

    func truncate(_ handle: SpoolFileHandle, to length: Int64) throws {
        if let error = truncateFault?(handle) { throw error }
        try base.truncate(handle, to: length)
    }

    func size(of handle: SpoolFileHandle) throws -> Int64 { try base.size(of: handle) }
    func read(_ handle: SpoolFileHandle, at offset: Int64, count: Int) throws -> [UInt8] {
        try base.read(handle, at: offset, count: count)
    }

    func close(_ handle: SpoolFileHandle) {
        openDescriptors.remove(handle.descriptor)
        base.close(handle)
    }

    func syncDirectory(at url: URL) throws {
        if let error = syncDirectoryFault?(url) { throw error }
        try base.syncDirectory(at: url)
    }
    func contentsOfDirectory(at url: URL) throws -> [URL] { try base.contentsOfDirectory(at: url) }
    func fileExists(at url: URL) -> Bool { base.fileExists(at: url) }
    func isDirectory(at url: URL) -> Bool { base.isDirectory(at: url) }
}

/// Counts malloc-family calls made by the current thread while `body` runs, through libmalloc's
/// `malloc_logger` hook. Returns nil when the hook is unavailable.
enum AllocationCounter {
    private typealias Logger = @convention(c) (UInt32, UInt, UInt, UInt, UInt, UInt32) -> Void

    private static let count = Atomic<Int>(0)
    private static let target = Atomic<UInt>(0)
    private static let lock = Mutex(())

    static func count(_ body: () -> Void) -> Int? {
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "malloc_logger") else { return nil }
        let slot = symbol.assumingMemoryBound(to: Logger?.self)
        return lock.withLock { _ in
            count.store(0, ordering: .relaxed)
            target.store(UInt(bitPattern: pthread_self()), ordering: .relaxed)
            slot.pointee = { _, _, _, _, _, _ in
                if UInt(bitPattern: pthread_self()) == AllocationCounter.target.load(ordering: .relaxed) {
                    AllocationCounter.count.add(1, ordering: .relaxed)
                }
            }
            body()
            slot.pointee = nil
            target.store(0, ordering: .relaxed)
            return count.load(ordering: .relaxed)
        }
    }
}

enum Paths {
    /// native/
    static let native = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
    static let sileroModel = native.appending(path: ".models/silero-vad/silero_vad.onnx")
    static let protocolFixtures = native.deletingLastPathComponent().appending(path: "packages/protocol/fixtures")

    static var hasSileroModel: Bool { FileManager.default.fileExists(atPath: sileroModel.path(percentEncoded: false)) }
    static var hasProtocolFixtures: Bool {
        FileManager.default.fileExists(atPath: protocolFixtures.appending(path: "manifest-records.jsonl").path(percentEncoded: false))
    }

    /// Directory holding the built executables: next to the test bundle, else `.build/debug`.
    static var products: URL {
        if let bundle = Bundle.allBundles.first(where: { $0.bundleURL.pathExtension == "xctest" }) {
            return bundle.bundleURL.deletingLastPathComponent()
        }
        return native.appending(path: ".build/debug")
    }

    static func product(_ name: String) -> URL? {
        let url = products.appending(path: name)
        return FileManager.default.isExecutableFile(atPath: url.path(percentEncoded: false)) ? url : nil
    }
}

/// Runs an executable to completion and captures its output.
struct ProcessResult {
    var status: Int32
    var stdout: String
    var stderr: String

    /// stdin is `input` then end of file (/dev/null without it), so a child that waits for end
    /// of file on stdin (`serve`) sees it at once.
    static func run(_ executable: URL, _ arguments: [String], environment: [String: String]? = nil, input: String? = nil) throws -> ProcessResult {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        let stdin = input.map { _ in Pipe() }
        process.standardInput = stdin ?? FileHandle.nullDevice
        if let environment { process.environment = environment }
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        try process.run()
        if let stdin, let input {
            stdin.fileHandleForWriting.write(Data(input.utf8))
            try stdin.fileHandleForWriting.close()
        }
        // Read before waiting so a full pipe cannot block the child.
        let stdout = out.fileHandleForReading.readDataToEndOfFile()
        let stderr = err.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return ProcessResult(
            status: process.terminationStatus,
            stdout: String(decoding: stdout, as: UTF8.self),
            stderr: String(decoding: stderr, as: UTF8.self)
        )
    }
}

enum WaveFile {
    /// Writes interleaved Float32 frames as a 16-bit PCM WAV.
    static func write(_ samples: [Float], rate: Double, channels: Int, to url: URL) throws {
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: rate,
            AVNumberOfChannelsKey: channels,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
        ]
        let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: true)
        let frames = samples.count / channels
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(frames)))
        buffer.frameLength = AVAudioFrameCount(frames)
        let destination = try #require(buffer.floatChannelData?[0])
        samples.withUnsafeBufferPointer { source in
            if let base = source.baseAddress { destination.update(from: base, count: samples.count) }
        }
        try file.write(from: buffer)
        file.close()
    }
}

func lines(of url: URL) throws -> [String] {
    try String(contentsOf: url, encoding: .utf8).split(separator: "\n", omittingEmptySubsequences: false)
        .map(String.init).filter { !$0.isEmpty }
}
