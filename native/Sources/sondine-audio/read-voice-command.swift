import Darwin
import Foundation
import SondineCapture
import SondineKit

/// `sondine-audio read-voice` (ADR 034): records the user reading a text aloud for Sondine to
/// learn their voice, into one file of 16 kHz PCM16 mono (mode 0600, created new), and prints one
/// JSON line per drain on stdout: `{"event":"started"}`, then `{"event":"level","ms":…,"rms":…,
/// "peak":…}` every 100 ms, then `{"event":"stopped","ms":…}`. It stops when stdin ends (main),
/// on SIGTERM, or at `--max-seconds`; it exits 0 once the file is complete. Main spawns it, as it
/// spawns `serve`, so macOS credits Sondine.app for the microphone.
enum ReadVoiceCommand {
    struct Options {
        var output: URL
        var maxSeconds: Int
        var hal: ServeOptions.HAL
    }

    static let drainInterval: DispatchTimeInterval = .milliseconds(100)

    static func parse(_ arguments: [String]) throws -> Options {
        var values: [String: String] = [:]
        var index = 0
        let known: Set = ["--out", "--max-seconds", "--hal"]
        while index < arguments.count {
            let flag = arguments[index]
            guard known.contains(flag) else { throw ParameterError("unknown option \(flag)") }
            guard index + 1 < arguments.count else { throw ParameterError("\(flag) needs a value") }
            guard values[flag] == nil else { throw ParameterError("\(flag) given twice") }
            values[flag] = arguments[index + 1]
            index += 2
        }
        guard let output = values["--out"] else { throw ParameterError("--out is required") }
        guard let maxSeconds = Int(values["--max-seconds"] ?? "60"), (1...120).contains(maxSeconds) else {
            throw ParameterError("--max-seconds must be 1 to 120")
        }
        guard let hal = ServeOptions.HAL(rawValue: values["--hal"] ?? "core-audio") else {
            throw ParameterError("--hal must be core-audio or fake")
        }
        return Options(output: URL(filePath: output), maxSeconds: maxSeconds, hal: hal)
    }

    static func run(_ arguments: [String]) -> Int32 {
        let options: Options
        do {
            options = try parse(arguments)
        } catch {
            fputs("sondine-audio read-voice: \(error)\n", stderr)
            return ExitCode.usage
        }
        // A new file only: a read never overwrites anything.
        let descriptor = open(options.output.path(percentEncoded: false), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else {
            fputs("sondine-audio read-voice: cannot create the file (errno \(errno))\n", stderr)
            return ExitCode.failure
        }
        let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        let hal: any AudioHardware
        let fakeSignal: FakeSignalDriver?
        switch options.hal {
        case .coreAudio:
            hal = CoreAudioHardware()
            fakeSignal = nil
        case .fake:
            // Development (`dev:fake-hal`): the helper's quiet noise and tone, no hardware.
            let fake = FakeAudioHardware.macBook()
            fakeSignal = FakeSignalDriver(hal: fake)
            hal = fake
        }
        let recorder = VoiceReadRecorder(hal: hal) { samples in
            try samples.withUnsafeBytes { try file.write(contentsOf: Data($0)) }
        }
        do {
            try recorder.start()
        } catch {
            fputs("sondine-audio read-voice: \(error)\n", stderr)
            unlink(options.output.path(percentEncoded: false))
            return ExitCode.failure
        }
        fakeSignal?.start()
        say(#"{"event":"started"}"#)

        let queue = DispatchQueue.main
        let maxMs = options.maxSeconds * 1000
        nonisolated(unsafe) var stopped = false
        let finish: @Sendable () -> Void = {
            dispatchPrecondition(condition: .onQueue(.main))
            guard !stopped else { return }
            stopped = true
            fakeSignal?.stop()
            do {
                let level = try recorder.stop()
                try file.synchronize()
                try file.close()
                say(#"{"event":"stopped","ms":\#(level.ms)}"#)
                exit(ExitCode.success)
            } catch {
                fputs("sondine-audio read-voice: \(error)\n", stderr)
                exit(ExitCode.failure)
            }
        }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + drainInterval, repeating: drainInterval, leeway: .milliseconds(10))
        timer.setEventHandler {
            guard !stopped else { return }
            do {
                let level = try recorder.drain()
                say(String(format: #"{"event":"level","ms":%d,"rms":%.5f,"peak":%.5f}"#, level.ms, level.rms, level.peak))
                if level.ms >= maxMs { finish() }
            } catch {
                fputs("sondine-audio read-voice: \(error)\n", stderr)
                exit(ExitCode.failure)
            }
        }
        timer.resume()
        // A microphone that stops delivering writes nothing, so `ms` never reaches the limit:
        // the wall clock ends the recording too.
        queue.asyncAfter(deadline: .now() + .seconds(options.maxSeconds + 2)) { finish() }
        Lifetime.watchStdin { _ in finish() }
        Lifetime.watchSignals { _ in finish() }
        withExtendedLifetime(timer) { dispatchMain() }
    }

    private static func say(_ line: String) {
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }
}
