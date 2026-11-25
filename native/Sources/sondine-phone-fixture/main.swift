import Foundation
import SondinePhone

// Writes a phone recording as the iPhone app does (AssetPartWriter: fragmented
// m4a, header in the comment tag), then either closes it or kills itself
// mid-write, as a crash or an empty battery would. Used by the cross-language
// test (`pnpm test:native`): the file is made at test time, never committed.
//
//   sondine-phone-fixture --out <file.m4a> --seconds <n> [--kill-after <s>]
//     [--codec alac|aac] [--recording-id <uuid>] [--started-ms <ms>] [--hertz <hz>]
//     [--device-id <uuid>]
//
// Prints one JSON line on stdout before writing: the header it wrote.

func argument(_ name: String) -> String? {
    let arguments = CommandLine.arguments
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("sondine-phone-fixture: \(message)\n".utf8))
    exit(2)
}

guard let out = argument("--out"), let seconds = argument("--seconds").flatMap(Int.init), seconds > 0 else {
    fail("usage: --out <file.m4a> --seconds <n> [--kill-after <s>] [--codec alac|aac] [--recording-id <uuid>] [--started-ms <ms>] [--hertz <hz>] [--device-id <uuid>]")
}
let killAfter = argument("--kill-after").flatMap(Int.init)
let codecName = argument("--codec") ?? "alac"
guard let codec = PhoneCodec(rawValue: codecName) else { fail("unknown codec \(codecName)") }
let idText = argument("--recording-id") ?? UUID().uuidString.lowercased()
guard let recordingId = UUID(uuidString: idText) else { fail("bad id \(idText)") }
let startedMs = argument("--started-ms").flatMap(Int64.init) ?? SystemClock().nowMs() - Int64(seconds) * 1000
let hertz = argument("--hertz").flatMap(Double.init) ?? 440
let deviceText = argument("--device-id") ?? "c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b"
guard let deviceId = UUID(uuidString: deviceText) else { fail("bad device id \(deviceText)") }

let header = PhoneRecordingHeader(
    recordingId: recordingId, sessionId: UUID(), part: 1, startedWallMs: startedMs, utcOffsetMin: 60,
    deviceId: deviceId, input: .builtIn, previous: nil,
    app: "0.1.0 (1)")
let url = URL(filePath: out)
try? FileManager.default.removeItem(at: url)
let writer: AssetPartWriter
do {
    writer = try AssetPartWriter(url: url, header: header, codec: codec)
    print(try header.json())
    fflush(stdout)
} catch {
    fail("cannot write: \(error)")
}

// 100 ms blocks, as the microphone delivers them, at ten times real time:
// the encoder keeps up, as it does with the microphone.
let block = phoneSampleRate / 10
for index in 0..<(seconds * 10) {
    do {
        try writer.append(tone(hertz: hertz, from: index * block, count: block))
    } catch {
        fail("append: \(error)")
    }
    usleep(10_000)
    if let killAfter, index + 1 == killAfter * 10 {
        // Nothing closes the file: what a kill, a crash or a dead battery leaves.
        kill(getpid(), SIGKILL)
    }
}
do {
    try await writer.finish()
} catch {
    fail("finish: \(error)")
}
