import Foundation
import SondinePhone
import Synchronization

/// The repository's root, from this file.
let repository = URL(filePath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

/// A fresh folder for one test's recordings.
func scratch() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appending(path: "sondine-phone-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// A writer that counts samples instead of encoding them, and can run out of room.
final class CountingWriter: PartWriter, @unchecked Sendable {
    let url: URL
    let header: PhoneRecordingHeader
    private let state = Mutex((samples: 0, finished: false, failAfter: Int?.none))

    init(url: URL, header: PhoneRecordingHeader, failAfter: Int?) {
        self.url = url
        self.header = header
        state.withLock { $0.failAfter = failAfter }
    }

    func append(_ samples: [Int16]) throws {
        try state.withLock {
            if let limit = $0.failAfter, $0.samples + samples.count > limit {
                throw PartWriterError.appendFailed("disk full")
            }
            $0.samples += samples.count
        }
    }

    func finish() async throws { state.withLock { $0.finished = true } }
    var samples: Int { state.withLock { $0.samples } }
    var finished: Bool { state.withLock { $0.finished } }
}

final class CountingWriters: PartWriterFactory, @unchecked Sendable {
    private let made = Mutex<[CountingWriter]>([])
    /// The next writers throw once they would hold more than this many samples.
    let failAfter = Mutex<Int?>(nil)

    func makeWriter(url: URL, header: PhoneRecordingHeader) throws -> any PartWriter {
        let writer = CountingWriter(url: url, header: header, failAfter: failAfter.withLock { $0 })
        made.withLock { $0.append(writer) }
        return writer
    }

    var all: [CountingWriter] { made.withLock { $0 } }
}

/// Records the class each file was given.
final class ProtectionSpy: FileProtecting, @unchecked Sendable {
    private let classes = Mutex<[String: ProtectionClass]>([:])
    func protect(_ url: URL, _ protection: ProtectionClass) throws {
        classes.withLock { $0[url.lastPathComponent] = protection }
    }

    subscript(_ name: String) -> ProtectionClass? { classes.withLock { $0[name] } }
}

/// A recorder over scripted iOS, as the tests drive it.
struct Rig {
    let root: URL
    let store: RecordingStore
    let session = ScriptedAudioSession()
    let microphone = ScriptedMicrophone()
    let disk = ScriptedDiskSpace()
    let clock = ScriptedClock(nowMs: 1_793_442_720_000)
    let notifications = RecordedNotifications()
    let recorder: PhoneRecorder

    init(writers: any PartWriterFactory = CountingWriters(), protection: any FileProtecting = NoFileProtection(),
         configure: (inout PhoneRecorder.Configuration) -> Void = { _ in }) throws {
        root = try scratch()
        store = try RecordingStore(root: root, protection: protection)
        var configuration = PhoneRecorder.Configuration(
            deviceId: UUID(uuidString: "c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b")!, appVersion: "0.1.0 (12)")
        configure(&configuration)
        recorder = PhoneRecorder(
            store: store, session: session, microphone: microphone, writers: writers, disk: disk, clock: clock,
            notifier: notifications, configuration: configuration)
    }

    /// `seconds` of tone through the microphone, in 100 ms blocks, then written.
    func speak(seconds: Double) async {
        let blocks = Int(seconds * 10)
        for _ in 0..<blocks { microphone.push(tone(hertz: 440, from: 0, count: phoneSampleRate / 10)) }
        clock.advance(ms: Int64(seconds * 1000))
        await recorder.settle()
    }

    func phase() async -> PhoneRecorder.Phase { await recorder.snapshot.phase }

    /// The store's recordings, oldest first.
    func recordings() -> [StoredRecording] { store.list().reversed() }
}

/// `afinfo -b` and `-i` on a file: its length in seconds and its comment.
func afinfo(_ url: URL) throws -> (seconds: Double, comment: String?) {
    func run(_ flag: String) throws -> String {
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/afinfo")
        process.arguments = [flag, url.path(percentEncoded: false)]
        let out = Pipe()
        process.standardOutput = out
        process.standardError = Pipe()
        try process.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }
    let brief = try run("-b")
    let seconds = brief.firstMatch(of: /([0-9.]+) sec, format/).flatMap { Double($0.1) } ?? -1
    let comment = try run("-i").firstMatch(of: /comments\s*: "(.*)"\s*\n/).map { String($0.1) }
    return (seconds, comment)
}
