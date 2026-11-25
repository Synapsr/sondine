import Darwin
import Dispatch
import Foundation
import SondineCapture
import SondineKit
import SondineSilero

struct ServeOptions {
    enum HAL: String { case coreAudio = "core-audio", fake }
    enum Vad: String { case silero, none }

    var socket: String
    var data: URL
    var models: URL?
    var drainIntervalMs = 256
    var hal = HAL.coreAudio
    var vad = Vad.silero

    static func parse(_ arguments: [String]) throws -> ServeOptions {
        var values: [String: String] = [:]
        let known: Set = ["--socket", "--data", "--models", "--drain-interval-ms", "--hal", "--vad"]
        var index = 0
        while index < arguments.count {
            let flag = arguments[index]
            guard known.contains(flag) else { throw ParameterError("unknown option \(flag)") }
            guard index + 1 < arguments.count else { throw ParameterError("\(flag) needs a value") }
            guard values[flag] == nil else { throw ParameterError("\(flag) given twice") }
            values[flag] = arguments[index + 1]
            index += 2
        }
        guard let socket = values["--socket"] else { throw ParameterError("--socket is required") }
        guard let data = values["--data"] else { throw ParameterError("--data is required") }
        var options = ServeOptions(socket: socket, data: URL(filePath: data, directoryHint: .isDirectory))
        options.models = values["--models"].map { URL(filePath: $0, directoryHint: .isDirectory) }
        if let text = values["--drain-interval-ms"] {
            guard let value = Int(text), (100...1_000).contains(value) else { throw ParameterError("--drain-interval-ms must be 100 to 1000") }
            options.drainIntervalMs = value
        }
        if let text = values["--hal"] {
            guard let hal = HAL(rawValue: text) else { throw ParameterError("--hal must be core-audio or fake") }
            options.hal = hal
        }
        if let text = values["--vad"] {
            guard let vad = Vad(rawValue: text) else { throw ParameterError("--vad must be silero or none") }
            options.vad = vad
        }
        return options
    }
}

/// `sondine-audio serve`: the always-on helper. Main spawns it (so TCC credits Sondine.app)
/// and holds only its stdin; core connects to the socket.
enum ServeCommand {
    static func run(_ arguments: [String]) -> Int32 {
        let options: ServeOptions
        do {
            options = try ServeOptions.parse(arguments)
        } catch {
            fputs("sondine-audio serve: \(error)\n", stderr)
            return ExitCode.usage
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: options.data.path(percentEncoded: false), isDirectory: &isDirectory), isDirectory.boolValue else {
            fputs("sondine-audio serve: the data directory does not exist\n", stderr)
            return ExitCode.usage
        }
        // Before recovery or any write: the spool may not leave the data directory.
        let spool: URL
        do {
            spool = try SpoolLayout.resolveRoot(dataDirectory: options.data)
        } catch {
            fputs("sondine-audio serve: unsafe spool location: \(error)\n", stderr)
            return ExitCode.failure
        }
        signal(SIGPIPE, SIG_IGN)

        var problems: [HelperEvent] = []
        var vadInfo = (engine: "energy-gate", version: "1")
        var modelURL: URL?
        if options.vad == .silero {
            if let url = SondineAudioCommand.defaultModelURL(models: options.models),
               FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) {
                modelURL = url
                vadInfo = (engine: "silero", version: SileroVoiceActivityDetector.modelVersion)
            } else {
                problems.append(.error(.vadUnavailable, "The Silero model is missing; speech regions come from the energy gate alone."))
            }
        }
        let environment = makeEnvironment(options: options, spool: spool, modelURL: modelURL, vad: vadInfo)
        let engine = CaptureEngine(environment: environment)
        let server = HelperServer(socketPath: options.socket, engine: engine)
        do {
            try server.start()
        } catch {
            fputs("sondine-audio serve: \(error)\n", stderr)
            return ExitCode.failure
        }
        engine.start()
        for problem in problems { engine.report(problem) }
        // Fake hardware has no IO thread of its own: feed it a steady signal.
        let fakeSignal = (environment.hal as? FakeAudioHardware).map(FakeSignalDriver.init(hal:))
        fakeSignal?.start()
        fputs("sondine-audio: serving session \(engine.sessionId.uuidString.lowercased()) pid \(getpid())\n", stderr)

        let exit: @Sendable (String) -> Void = { reason in
            DispatchQueue.main.async {
                fakeSignal?.stop()
                engine.stop(reason: .shutdown)
                server.stop()
                fputs("sondine-audio: exit (\(reason))\n", stderr)
                Darwin.exit(0)
            }
        }
        server.onShutdownComplete = { exit("shutdown") }
        let startedAt = ProcessInfo.processInfo.systemUptime
        Lifetime.watchStdin(onEnd: { quit in
            // Main said it quits: a normal end. Otherwise it died: bring Sondine back first.
            if quit { exit("stdin closed") }
            else {
                let uptime = ProcessInfo.processInfo.systemUptime - startedAt
                DispatchQueue.main.async {
                    Relaunch.openApp(uptime: uptime, done: { exit("main gone") })
                }
            }
        })
        Lifetime.watchSignals(onSignal: { exit("signal \($0)") })
        // The main run loop, not `dispatchMain()`: it serves the main queue the same way, and
        // NSWorkspace needs it to say which app is in front (WorkspaceForegroundApps), as
        // SystemConfiguration does to say the network changed (SystemNetworkSignatures).
        CFRunLoopRun()
        return ExitCode.failure
    }

    private static func makeEnvironment(options: ServeOptions, spool: URL, modelURL: URL?, vad: (engine: String, version: String)) -> CaptureEnvironment {
        var capture = CaptureOptions()
        capture.drainIntervalMs = options.drainIntervalMs
        capture.helperVersion = SondineAudioCommand.version
        // One model for every track (each detector keeps its own state), loaded with the first.
        let model = SharedSileroModel(url: modelURL)
        // The app in front and whether the screen is away come from one workspace observer.
        let workspace = WorkspaceForegroundApps()
        let detector: (TrackKind) -> (any VoiceActivityDetector)? = { _ in
            model.load().map(SileroVoiceActivityDetector.init(model:))
        }
        switch options.hal {
        case .coreAudio:
            return CaptureEnvironment(
                hal: CoreAudioHardware(),
                introspection: DarwinProcessIntrospection(),
                permissions: SystemPermissionProbe(),
                speechHold: IOPMSpeechHold(),
                powerEvents: IOKitSystemPowerEvents(),
                foreground: workspace,
                screen: workspace,
                networks: SystemNetworkSignatures(),
                wallClock: SystemWallClock(),
                spoolRoot: spool,
                makeDetector: detector,
                vad: vad,
                options: capture
            )
        case .fake:
            // Something plays on the fake Mac, so `system:other` records as it would: a process
            // with no app (no such pid), which no app tap takes (ADR 026).
            let hal = FakeAudioHardware.macBook()
            let player = hal.addProcess(pid: Int32.max, bundleID: nil)
            hal.setProcessIO(player, input: false, output: true, outputDevices: ["BuiltInSpeakerDevice"])
            return CaptureEnvironment(
                hal: hal,
                introspection: DarwinProcessIntrospection(),
                permissions: FakePermissionProbe(),
                speechHold: FakeSpeechHold(),
                powerEvents: FakeSystemPowerEvents(),
                foreground: workspace,
                screen: workspace,
                networks: SystemNetworkSignatures(),
                wallClock: SystemWallClock(),
                spoolRoot: spool,
                makeDetector: detector,
                vad: vad,
                options: capture
            )
        }
    }
}

/// The helper's lifetime: stdin is a pipe from Electron main; end of file means main is gone.
/// Main writes `quit` on it first when it quits on purpose (`HelperSupervisor.retire`).
enum Lifetime {
    nonisolated(unsafe) private static var sources: [any DispatchSourceProtocol] = []
    /// The word main writes before it lets the helper go.
    static let quitWord = Array("quit".utf8)

    /// Calls `onEnd(quit)` at end of file: `quit` is whether main said it quits.
    static func watchStdin(onEnd: @escaping @Sendable (Bool) -> Void) {
        let source = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
        nonisolated(unsafe) var received: [UInt8] = []
        source.setEventHandler {
            var buffer = [UInt8](repeating: 0, count: 4_096)
            let count = buffer.withUnsafeMutableBytes { read(STDIN_FILENO, $0.baseAddress, $0.count) }
            if count > 0 {
                // Only the last few bytes matter: the word may arrive split.
                received = Array((received + buffer.prefix(count)).suffix(64))
            } else if count == 0 || (errno != EAGAIN && errno != EINTR) {
                source.cancel()
                onEnd(received.firstRange(of: quitWord) != nil)
            }
        }
        source.resume()
        sources.append(source)
    }

    static func watchSignals(onSignal: @escaping @Sendable (Int32) -> Void) {
        for number in [SIGTERM, SIGINT, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { onSignal(number) }
            source.resume()
            sources.append(source)
        }
    }
}

/// The Silero model the helper's tracks share, loaded on first use (the engine queue asks).
final class SharedSileroModel: @unchecked Sendable {
    private let url: URL?
    private var model: SileroModel?

    init(url: URL?) {
        self.url = url
    }

    func load() -> SileroModel? {
        if let model { return model }
        guard let url else { return nil }
        model = try? SileroModel(modelURL: url)
        return model
    }
}
