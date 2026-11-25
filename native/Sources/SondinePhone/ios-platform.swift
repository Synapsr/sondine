import Foundation

/// Free space as iOS counts it for files the user cares about.
public struct VolumeDiskSpace: DiskSpace {
    public let url: URL
    public init(url: URL) { self.url = url }
    public func availableBytes() -> Int64? {
        try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
            .volumeAvailableCapacityForImportantUsage
    }
}

#if os(iOS)
@preconcurrency import AVFoundation
@preconcurrency import CallKit
@preconcurrency import UserNotifications

/// The app's `AVAudioSession`: record only, no voice processing, the
/// microphone iOS routes, and a call shown as a banner interrupts only once
/// answered (ADR 032).
public final class SystemAudioSession: AudioSessionControlling, @unchecked Sendable {
    public let events: AsyncStream<AudioSessionEvent>
    private let continuation: AsyncStream<AudioSessionEvent>.Continuation
    private let calls = CXCallObserver()
    private var observers: [NSObjectProtocol] = []

    public init() {
        (events, continuation) = AsyncStream.makeStream()
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        let continuation = continuation
        let calls = calls
        // iOS 27: the session says it became inactive, then whether to resume.
        observers.append(center.addObserver(
            forName: AVAudioSession.didBecomeInactiveNotification, object: session, queue: nil
        ) { note in
            let context = note.userInfo?[AVAudioSession.deactivationContextKey] as? AVAudioSession.DeactivationContext
            // The app's own deactivation (« Arrêter ») is no interruption.
            guard context?.source == .system else { return }
            let onCall = calls.calls.contains { !$0.hasEnded }
            continuation.yield(.interruptionBegan(onCall ? .call : .other))
        })
        observers.append(center.addObserver(
            forName: AVAudioSession.resumptionRecommendationNotification, object: session, queue: nil
        ) { note in
            let context = note.userInfo?[AVAudioSession.resumptionContextKey] as? AVAudioSession.ResumptionContext
            continuation.yield(.interruptionEnded(shouldResume: context?.recommendation == .shouldResume))
        })
        observers.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: session, queue: nil
        ) { _ in
            continuation.yield(.routeChanged(Self.route(of: session)))
        })
        observers.append(center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil
        ) { _ in
            continuation.yield(.mediaServicesReset)
        })
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    public func activate() throws -> AudioRoute {
        guard AVAudioApplication.shared.recordPermission == .granted else {
            throw AudioSessionError.permissionDenied
        }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .default, options: [.allowBluetoothHFP])
            try session.setPrefersNoInterruptionsFromSystemAlerts(true)
            try session.setActive(true)
        } catch {
            throw AudioSessionError.activationFailed(String(describing: error))
        }
        return Self.route(of: session)
    }

    public func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    public func requestPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    static func route(of session: AVAudioSession) -> AudioRoute {
        guard let input = session.currentRoute.inputs.first else { return .builtIn }
        switch input.portType {
        case .builtInMic:
            return .builtIn
        case .headsetMic:
            return AudioRoute(kind: .wired, name: input.portName)
        case .bluetoothHFP, .bluetoothLE, .bluetoothA2DP:
            return AudioRoute(kind: .bluetooth, name: input.portName)
        default:
            return AudioRoute(kind: .other, name: input.portName)
        }
    }
}

/// The microphone through `AVAudioEngine`, converted to 16 kHz mono 16-bit.
/// A configuration change (a route switch) restarts the engine at once.
public final class EngineMicrophone: MicrophoneSource, @unchecked Sendable {
    private let engine = AVAudioEngine()
    /// Starting, stopping and restarting the engine, one at a time: the
    /// configuration change arrives on an internal queue of iOS's.
    private let lifecycle = DispatchQueue(label: "app.sondine.microphone")
    private let lock = NSLock()
    private var deliver: (@Sendable ([Int16]) -> Void)?
    private var converter: AVAudioConverter?
    private var observer: NSObjectProtocol?
    /// Bumped at each start and stop: a late restart of an older one does nothing.
    private var generation = 0
    private let target = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: Double(phoneSampleRate), channels: 1, interleaved: true)!

    public init() {}

    public func start(
        _ deliver: @escaping @Sendable ([Int16]) -> Void, failed: @escaping @Sendable (String) -> Void
    ) throws {
        try lifecycle.sync {
            generation += 1
            let mine = generation
            lock.withLock { self.deliver = deliver }
            try startEngine()
            observer = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
            ) { [weak self] _ in
                guard let queue = self?.lifecycle else { return }
                queue.async { [weak self] in
                    guard let self, self.generation == mine else { return }
                    do {
                        try self.startEngine()
                    } catch {
                        // Nothing records any more: the recorder says so, never a silent hole.
                        self.stopLocked()
                        failed(String(describing: error))
                    }
                }
            }
        }
    }

    public func stop() {
        lifecycle.sync { stopLocked() }
    }

    /// On `lifecycle`.
    private func stopLocked() {
        generation += 1
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        lock.withLock { deliver = nil }
    }

    /// On `lifecycle`.
    private func startEngine() throws {
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, let converter = AVAudioConverter(from: format, to: target) else {
            throw AudioSessionError.activationFailed("no input format")
        }
        lock.withLock { self.converter = converter }
        input.installTap(onBus: 0, bufferSize: 4_096, format: format) { [weak self] buffer, _ in
            self?.convert(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    private func convert(_ buffer: AVAudioPCMBuffer) {
        guard let (converter, deliver) = lock.withLock({ () -> (AVAudioConverter, @Sendable ([Int16]) -> Void)? in
            guard let converter, let deliver else { return nil }
            return (converter, deliver)
        }) else { return }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        // The converter asks for input until told there is none for now: one buffer per call.
        let given = Given()
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if given.done {
                status.pointee = .noDataNow
                return nil
            }
            given.done = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let channel = output.int16ChannelData?[0], output.frameLength > 0 else { return }
        deliver(Array(UnsafeBufferPointer(start: channel, count: Int(output.frameLength))))
    }
}

private final class Given: @unchecked Sendable {
    var done = false
}

/// Local notifications, no push service: « Enregistrement interrompu à 14:32 »,
/// with « Reprendre », and from M5.6 the 8 hour notice and a start the control
/// could not make.
public struct LocalNotifier: PhoneNotifying {
    /// The interruption's category, which carries « Reprendre ».
    public static let interruptedCategory = "recording-interrupted"
    /// « Reprendre » on that notification: it opens the app and resumes.
    public static let resumeAction = "resume"
    private let texts: @Sendable (Notice) -> (title: String, body: String)

    public enum Notice: Sendable {
        case interrupted(atMs: Int64, cause: InterruptionCause)
        case stopped(atMs: Int64, end: RecordingEnd)
        case continues(sinceMs: Int64)
        case couldNotStart(PhoneRecorder.StartRefusal)
    }

    /// `texts`: the words, from the app's String Catalog.
    public init(texts: @escaping @Sendable (Notice) -> (title: String, body: String)) {
        self.texts = texts
    }

    /// Registers « Reprendre » (`resumeTitle`, from the app's String Catalog) once at launch.
    public static func registerCategories(resumeTitle: String) {
        let resume = UNNotificationAction(identifier: resumeAction, title: resumeTitle, options: [.foreground])
        let interrupted = UNNotificationCategory(identifier: interruptedCategory, actions: [resume], intentIdentifiers: [])
        UNUserNotificationCenter.current().setNotificationCategories([interrupted])
    }

    public func recordingInterrupted(atMs: Int64, cause: InterruptionCause) {
        post(.interrupted(atMs: atMs, cause: cause), category: Self.interruptedCategory)
    }

    public func recordingStopped(atMs: Int64, end: RecordingEnd) {
        post(.stopped(atMs: atMs, end: end), category: nil)
    }

    public func recordingContinues(sinceMs: Int64) {
        post(.continues(sinceMs: sinceMs), category: nil)
    }

    public func recordingCouldNotStart(_ refusal: PhoneRecorder.StartRefusal) {
        post(.couldNotStart(refusal), category: nil)
    }

    private func post(_ notice: Notice, category: String?) {
        let words = texts(notice)
        let content = UNMutableNotificationContent()
        content.title = words.title
        content.body = words.body
        content.sound = .default
        if let category { content.categoryIdentifier = category }
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
#endif
