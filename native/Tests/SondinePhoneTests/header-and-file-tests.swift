import Foundation
import SondinePhone
import Testing

private let fixtures = repository.appending(path: "packages/protocol/fixtures/phone")

private func lines(_ name: String) throws -> [String] {
    try String(contentsOf: fixtures.appending(path: name), encoding: .utf8)
        .split(separator: "\n").map(String.init)
        .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
}

private func object(_ text: String) throws -> NSDictionary {
    try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? NSDictionary)
}

/// Golden fixtures shared with `packages/protocol` (phone-recording.ts).
@Suite struct PhoneHeaderFixtureTests {
    @Test func everyValidHeaderDecodesAndEncodesToTheSameJson() throws {
        let valid = try lines("header-valid.jsonl")
        #expect(valid.count == 4)
        for line in valid {
            let header = try PhoneRecordingHeader.decode(line)
            #expect(try object(header.json()) == object(line), "re-encoded \(line)")
        }
    }

    @Test func everyInvalidHeaderIsRefused() throws {
        let invalid = try lines("header-invalid.jsonl")
        #expect(!invalid.isEmpty)
        for line in invalid {
            #expect(throws: PhoneHeaderError.self, "accepted \(line)") { try PhoneRecordingHeader.decode(line) }
        }
    }

    @Test func aHeaderWithAnInconsistentPartIsNeverWritten() {
        var header = PhoneRecordingHeader(
            recordingId: UUID(), sessionId: UUID(), part: 2, startedWallMs: 0, utcOffsetMin: 0, deviceId: UUID(),
            input: .builtIn, previous: nil, app: "0.1.0 (1)")
        #expect(throws: PhoneHeaderError.previous) { try header.json() }
        header.previous = .rotation
        #expect(throws: Never.self) { try header.json() }
    }
}

/// The file the app writes, read the way the Mac's import reads it (`afinfo`).
@Suite struct PhoneFileTests {
    private static var fixtureBinary: URL? {
        let bundle = Bundle.allBundles.first { $0.bundleURL.pathExtension == "xctest" }
        let candidates = [bundle?.bundleURL.deletingLastPathComponent(), repository.appending(path: "native/.build/debug")]
        return candidates.compactMap { $0?.appending(path: "sondine-phone-fixture") }
            .first { FileManager.default.isExecutableFile(atPath: $0.path(percentEncoded: false)) }
    }

    @Test(arguments: [PhoneCodec.alac, .aac])
    func aClosedFileHoldsEverySampleAndItsHeader(codec: PhoneCodec) async throws {
        let url = try scratch().appending(path: "audio.m4a")
        let header = PhoneRecordingHeader(
            recordingId: UUID(), sessionId: UUID(), part: 1, startedWallMs: 1_793_442_720_000, utcOffsetMin: 60,
            deviceId: UUID(), input: .wired, previous: nil, app: "0.1.0 (12)")
        let writer = try AssetPartWriter(url: url, header: header, codec: codec)
        for index in 0..<70 { try writer.append(tone(hertz: 440, from: index * 1_600, count: 1_600)) }
        try await writer.finish()
        let info = try afinfo(url)
        #expect(info.seconds == 7)
        #expect(try PhoneRecordingHeader.decode(try #require(info.comment)) == header)
    }

    /// Killed five times at different points: each file reads up to its last
    /// seconds, header included. On the Mac; the iPhone's own measurement
    /// (and an empty battery) is M5.1's device exit.
    @Test(.enabled(if: fixtureBinary != nil), arguments: [3, 7, 12, 21, 34])
    func aKilledWriterLeavesAFileReadUpToItsLastSeconds(killAfter: Int) throws {
        let binary = try #require(Self.fixtureBinary)
        let url = try scratch().appending(path: "killed.m4a")
        let process = Process()
        process.executableURL = binary
        process.arguments = ["--out", url.path(percentEncoded: false), "--seconds", "60", "--kill-after", String(killAfter)]
        let out = Pipe()
        process.standardOutput = out
        try process.run()
        let written = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        #expect(process.terminationReason == .uncaughtSignal)
        #expect(process.terminationStatus == SIGKILL)
        let info = try afinfo(url)
        let lost = Double(killAfter) - info.seconds
        #expect(lost >= 0 && lost <= 2.5, "lost \(lost) s after \(killAfter) s")
        let header = String(decoding: written, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        #expect(info.comment == header)
    }
}
