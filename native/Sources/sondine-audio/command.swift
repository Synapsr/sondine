import Darwin
import Foundation
import SondineCapture
import SondineKit
import SondineSilero

enum ExitCode {
    static let success: Int32 = 0
    static let failure: Int32 = 1
    static let usage: Int32 = 64
}

enum SondineAudioCommand {
    /// Also in Info.plist (CFBundleShortVersionString and CFBundleVersion).
    static let version = "0.1.0"

    static let usage = """
        usage: sondine-audio <command> [options]

        commands:
          serve      run the always-on capture helper on a private Unix socket
          segment    run the capture gate over an audio file and write regions as JSON
          read-voice record the user reading a text for Sondine to learn their voice (ADR 034)
          self-test  self-test sandbox: report what the helper's sandbox allows, as JSON lines;
                     self-test listeners: measure Core Audio's process and device notifications;
                     self-test taps: measure what N process taps cost, shared or separate;
                     self-test network: whether the networks' signatures are readable (ADR 029)

        serve options:
          --socket <path>          Unix socket to listen on (mode 0600; its directory must be
                                   owned by this user and not writable by others)
          --data <dir>             data directory; the spool goes to <dir>/spool
          --models <dir>           model directory (Silero at <dir>/silero-vad/silero_vad.onnx)
          --drain-interval-ms <n>  drain cadence, 100 to 1000 (default 256)
          --vad <engine>           silero (default) or none (energy gate only)
          --hal <hal>              core-audio (default) or fake (tests: no hardware, no prompts)
        serve exits when stdin reaches end of file (main's lifetime pipe), on SIGTERM, or after
        acknowledging `shutdown`.

        segment options:
          --in <file>          audio file (any format AVAudioFile reads)
          --out <file>         result JSON (written atomically)
          --params <json>      parameter overrides: a JSON file path, or inline JSON starting with {
          --vad <engine>       silero (default) or none (energy gate only)
          --vad-model <file>   silero_vad.onnx; default $SONDINE_VAD_MODEL, else the nearest
                               .models/silero-vad/silero_vad.onnx above the executable

        read-voice options (main spawns it; core pauses the helper's microphone meanwhile):
          --out <file>         a new file (mode 0600) for 16 kHz PCM16 mono
          --max-seconds <n>    stop after this much audio, 1 to 120 (default 60)
          --hal <hal>          core-audio (default) or fake (tests: no hardware, no prompts)
        read-voice prints one JSON line per 100 ms (`level`: ms written, rms, peak) and stops,
        closing its file, when stdin reaches end of file, on SIGTERM, or at --max-seconds.

        self-test sandbox options (no prompt, no audio; always exits 0):
          --data <dir>         data directory: a file and a Unix socket are created and removed
          --models <dir>       model directory to read (default: the one segment would use)
          --target <ip:port>   outbound TCP connect that must be denied (default 192.0.2.1:443)

        self-test listeners options (no prompt: afplay of digital silence and a private
        aggregate device per round; always exits 0; run it unsandboxed, from native/.build):
          --rounds <n>         rounds, 1 to 500 (default 20)
          --player <path>      the short-lived output process (default /usr/bin/afplay)

        self-test taps options (taps receive audio only with a system-audio grant for the
        responsible app: run it from an app bundle; always exits 0):
          --counts <list>      tap counts, 0 to 16 (default 0,1,2,4,8); 2 and up run shared
                               (one aggregate) and separate (one aggregate per tap)
          --seconds <n>        measured seconds per configuration, 5 to 3600 (default 60)
          --player <path>      the output process each tap captures (default /usr/bin/afplay)
          --out <file>         write the JSON lines there instead of stdout
          --wait <n>           seconds to wait for the first sample (the grant), up to 86400
                               (default 600)

        self-test network (no options, no prompt; always exits 0): one JSON line, whether a
        network signature was readable and how many networks, each as the first 4 hex digits
        of its hash under a key made for this run; never a signature.
        """

    static func run(arguments: [String]) -> Int32 {
        guard let command = arguments.first else {
            fputs(usage + "\n", stderr)
            return ExitCode.usage
        }
        let options = Array(arguments.dropFirst())
        switch command {
        case "serve":
            return ServeCommand.run(options)
        case "segment":
            return segment(options)
        case "read-voice":
            return ReadVoiceCommand.run(options)
        case "self-test":
            return SelfTestCommand.run(options)
        case "--version", "version":
            print("sondine-audio \(version)")
            return ExitCode.success
        case "--help", "-h", "help":
            print(usage)
            return ExitCode.success
        default:
            fputs("sondine-audio: unknown command \"\(command)\"\n\(usage)\n", stderr)
            return ExitCode.usage
        }
    }

    private static func segment(_ arguments: [String]) -> Int32 {
        let options: SegmentOptions
        do {
            options = try SegmentOptions.parse(arguments)
        } catch {
            fputs("sondine-audio segment: \(error)\n", stderr)
            return ExitCode.usage
        }
        do {
            let detector: (any VoiceActivityDetector)?
            switch options.vad {
            case .none:
                detector = nil
            case .silero:
                guard let model = options.vadModel ?? defaultModelURL() else {
                    throw OnnxRuntimeError.modelNotFound("--vad-model, $SONDINE_VAD_MODEL, or .models/silero-vad")
                }
                detector = try SileroVoiceActivityDetector(modelURL: model)
            }
            let result = try SegmentFile.run(input: options.input, parameters: options.parameters, detector: detector)
            try SegmentFile.encode(result).write(to: options.output, options: .atomic)
            let vad = result.stats.vad
            fputs(
                String(
                    format: "%d regions in %.1f s of audio; VAD evaluated %.0f%% of windows, %.2f CPU-s per audio hour\n",
                    result.regions.count,
                    result.output.durationMs / 1_000,
                    vad.evaluatedRatio * 100,
                    vad.cpuSecondsPerAudioHour
                ),
                stderr
            )
            return ExitCode.success
        } catch {
            fputs("sondine-audio segment: \(error)\n", stderr)
            return ExitCode.failure
        }
    }

    static func defaultModelURL(models: URL? = nil) -> URL? {
        if let models { return models.appending(path: "silero-vad/silero_vad.onnx") }
        if let path = ProcessInfo.processInfo.environment["SONDINE_VAD_MODEL"], !path.isEmpty {
            return URL(filePath: path)
        }
        var directory = URL(filePath: CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent()
        for _ in 0..<5 {
            let candidate = directory.appending(path: ".models/silero-vad/silero_vad.onnx")
            if FileManager.default.fileExists(atPath: candidate.path(percentEncoded: false)) { return candidate }
            directory.deleteLastPathComponent()
        }
        return nil
    }
}

struct SegmentOptions {
    enum Engine: String { case silero, none }

    var input: URL
    var output: URL
    var parameters: SpeechActivityParameters
    var vad: Engine
    var vadModel: URL?

    static func parse(_ arguments: [String]) throws -> SegmentOptions {
        var values: [String: String] = [:]
        var index = 0
        let known: Set = ["--in", "--out", "--params", "--vad", "--vad-model"]
        while index < arguments.count {
            let flag = arguments[index]
            guard known.contains(flag) else { throw ParameterError("unknown option \(flag)") }
            guard index + 1 < arguments.count else { throw ParameterError("\(flag) needs a value") }
            guard values[flag] == nil else { throw ParameterError("\(flag) given twice") }
            values[flag] = arguments[index + 1]
            index += 2
        }
        guard let input = values["--in"] else { throw ParameterError("--in is required") }
        guard let output = values["--out"] else { throw ParameterError("--out is required") }
        guard let vad = Engine(rawValue: values["--vad"] ?? "silero") else {
            throw ParameterError("--vad must be silero or none")
        }
        var parameters = SpeechActivityParameters()
        if let text = values["--params"] {
            let json: Data
            if text.hasPrefix("{") {
                json = Data(text.utf8)
            } else {
                do {
                    json = try Data(contentsOf: URL(filePath: text))
                } catch {
                    throw ParameterError("cannot read --params \(text): \(error.localizedDescription)")
                }
            }
            parameters = try SpeechActivityParameters.decode(json: json)
        }
        return SegmentOptions(
            input: URL(filePath: input),
            output: URL(filePath: output),
            parameters: parameters,
            vad: vad,
            vadModel: values["--vad-model"].map { URL(filePath: $0) }
        )
    }
}
