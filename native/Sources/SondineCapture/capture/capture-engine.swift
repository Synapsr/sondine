import Dispatch
import Foundation
import SondineKit

/// The always-on capture engine of `sondine-audio` (architecture §3): listener-driven discovery,
/// microphone selection and IO, the `system:other` tap, the drain worker, permissions, power,
/// health, and the protocol replies. All state lives on one serial utility-QoS queue; IO
/// callbacks only write rings.
public final class CaptureEngine: @unchecked Sendable {
    public let queue = DispatchQueue(label: "app.sondine.audio.engine", qos: .utility)
    public let sessionId = UUID()
    public weak var sink: (any CaptureEventSink)?
    /// Called on the engine queue after `shutdown` was acknowledged.
    public var onShutdown: (@Sendable () -> Void)?

    let env: CaptureEnvironment
    var hal: any AudioHardware { env.hal }
    var options: CaptureOptions { env.options }

    final class MicCapture {
        var choice: MicrophoneChoice
        let device: HALObjectID
        let processor: TrackProcessor
        var ioProc: HALIOProcHandle?
        var tokens: [HALListenerToken] = []

        init(choice: MicrophoneChoice, processor: TrackProcessor) {
            self.choice = choice
            device = choice.device.id
            self.processor = processor
        }
    }

    /// A private process tap, its tap-only aggregate and IOProc, and the track they feed.
    class TapCapture {
        var tap: HALObjectID = 0
        var tapUUID = UUID()
        var aggregate: HALObjectID = 0
        var ioProc: HALIOProcHandle?
        let stream: any TapStream
        var tokens: [HALListenerToken] = []
        var rebuilds = 0
        /// When the tap was asked for, until its first block (`tap-start`).
        var requestedNs: UInt64?

        init(stream: any TapStream) {
            self.stream = stream
        }
    }

    /// A tap that feeds a track.
    class TrackTapCapture: TapCapture {
        let processor: TrackProcessor

        init(processor: TrackProcessor) {
            self.processor = processor
            super.init(stream: processor)
        }
    }

    /// `system:other`: everything not on an app track, minus Sondine and excluded apps.
    final class SystemCapture: TrackTapCapture {
        var excluded: [HALObjectID]

        init(excluded: [HALObjectID], processor: TrackProcessor) {
            self.excluded = excluded
            super.init(processor: processor)
        }
    }

    // Queue-confined state.
    var started = false
    var stopped = false
    var config: CaptureConfig?
    var pin: InputPin?
    var paused = PausedState()
    var ownPIDs: Set<Int32>
    var asleep = false
    var sessionActive = true
    var epochCounter: UInt32 = 0
    var devices: DeviceCatalog!
    var processes: ProcessCatalog!
    var systemTokens: [HALListenerToken] = []
    var permissions = PermissionTracker()
    var mic: MicCapture?
    var system: SystemCapture?
    var micMuted = false
    var detectors: [TrackKind: any VoiceActivityDetector] = [:]
    var lastDevices: DevicesEvent?
    var lastProcesses: ProcessesEvent?
    var lastActivity: ActivityEvent?
    var activityScheduled = false
    var calls = CallTracker()
    var listens = ListenTracker()
    /// Calls seen whether Sondine listens or not (ADR 036): `call.seen`, never a call span.
    var seenCalls = CallTracker()
    var foreground = ForegroundTimeline()
    var timers: [DispatchSourceTimer] = []
    var healthTimer: DispatchSourceTimer?
    var speechHeld = false
    var lastInPersonNs: UInt64 = 0
    var metrics = ProcessMetrics()
    var healthWindowStartNs: UInt64 = 0
    var lastMicNotice: String?
    var systemRetry: DispatchWorkItem?
    var microphoneRetry: DispatchWorkItem?
    /// App taps by bundle id (ADR 026).
    var apps: [String: AppCapture] = [:]
    /// Apps released for silence: not tapped again until their output stops and starts.
    var quietApps: Set<String> = []
    /// When each app's output started running, for the order of the tap slots.
    var outputSince: [String: UInt64] = [:]
    /// Apps whose tap failed to start, until another try.
    var appBackoff: [String: UInt64] = [:]
    /// When nothing left in `system:other`'s scope played (it stops after `residualHoldSeconds`).
    var residualIdleSinceNs: UInt64?
    /// From the decision to start a tap to its first block, this health window.
    var tapStartCost = StageHistogramAccumulator()
    /// The device the last call used, and until when the microphone keeps following it.
    var callFollow: (uid: String, untilNs: UInt64?)?
    /// App taps stopped while their app still plays: they run until `system:other` delivers.
    var retiringApps: [AppCapture] = []
    /// The `self:playback` reference tap on Sondine's own processes (ADR 035).
    var selfPlayback: SelfPlaybackCapture?
    /// When Sondine's own output last ran while its tap was open, and when a failed start may retry.
    var selfIdleSinceNs: UInt64?
    var selfRetryAtNs: UInt64?
    /// Private zones: the Mac's situation and the holds it makes (ADR 029).
    var zones = ZoneState()

    public init(environment: CaptureEnvironment) {
        env = environment
        ownPIDs = [environment.ownPID]
    }

    // MARK: Public entry points (any thread)

    /// Registers listeners, reads devices and processes once, and starts the timers. Capture
    /// itself starts with the first `config`: until core states the policy (and any pause),
    /// nothing is recorded.
    public func start() {
        queue.sync { setUp() }
    }

    public func handle(_ message: ControlMessage) {
        queue.async { self.process(message) }
    }

    /// Commits and closes every run, releases the hardware, and stops the timers.
    public func stop(reason: TrackEndReason = .shutdown) {
        queue.sync { tearDown(reason: reason) }
    }

    /// Waits until everything queued so far has run (tests).
    public func sync() { queue.sync {} }

    /// One drain pass now (tests drive the worker by hand).
    public func drainNow() { queue.sync { drainTick() } }

    public func emitHealthNow() { queue.sync { healthTick() } }

    public func emitClockNow(reason: ClockReason = .periodic) { queue.sync { emitClock(reason: reason) } }

    public var state: CaptureState { queue.sync { currentState() } }

    /// Sends an event from outside the engine (startup problems), in order with the others.
    public func report(_ event: HelperEvent) {
        queue.async { self.emit(event) }
    }

    // MARK: Setup and teardown

    private func setUp() {
        guard !started else { return }
        started = true
        if options.recoverSpool { recoverSpool() }
        applyProcessFlags()
        sessionActive = (try? hal.userSessionIsActive()) ?? true
        // A HAL notice queued before teardown can run after the engine is gone.
        devices = DeviceCatalog(hal: hal, queue: queue) { [weak self] change in self?.deviceChanged(change) }
        processes = ProcessCatalog(hal: hal, queue: queue, resolver: ProcessResolver(introspection: env.introspection)) { [weak self] change in
            self?.processesChanged(change)
        }
        registerSystemListeners()
        _ = permissions.refresh(microphone: env.permissions.microphone(), systemAudio: env.permissions.systemAudio())
        env.powerEvents.start(queue: queue) { [weak self] event in self?.powerEvent(event) }
        startForeground()
        startSituation()
        _ = metrics.take()
        healthWindowStartNs = env.clock.anchor().continuousNs
        lastDevices = devicesEvent()
        lastProcesses = processesEvent()
        if options.timers { startTimers() }
    }

    func registerSystemListeners() {
        do {
            try devices.start()
            try processes.start()
        } catch {
            emit(.error(.captureFailed, "Cannot register Core Audio listeners: \(error)."))
        }
        let restart = try? hal.addListener(halSystemObject, .serviceRestarted, queue: queue) { [weak self] in self?.serviceRestarted() }
        let session = try? hal.addListener(halSystemObject, .userSessionIsActiveOrHeadless, queue: queue) { [weak self] in self?.sessionChanged() }
        systemTokens = [restart, session].compactMap { $0 }
    }

    private func applyProcessFlags() {
        // Running IO otherwise makes coreaudiod hold PreventUserIdleSystemSleep all day.
        do { try hal.setSleepingIsAllowed(true) } catch { emit(.warning("power.sleep-flag", "Cannot allow idle sleep during IO: \(error).")) }
        do { try hal.setPowerHintFavorSavingPower(true) } catch { emit(.warning("power.hint", "Cannot set the FavorSavingPower hint: \(error).")) }
        if micMuted { try? hal.setProcessInputMute(true) }
    }

    private func recoverSpool() {
        do {
            try FileManager.default.createDirectory(at: env.spoolRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let report = try SpoolRecovery.recover(directory: env.spoolRoot, fileSystem: env.makeFileSystem(), onlyNewestFilePerRun: true)
            if report.repairedFiles > 0 {
                emit(.warning("spool.recovered", "Recovered \(report.repairedFiles) spool files; \(report.lostSamples) samples were lost."))
            }
        } catch {
            emit(.error(.spoolIO, "Spool recovery failed: \(error)."))
        }
    }

    private func startTimers() {
        timers.append(makeTimer(seconds: Double(options.drainIntervalMs) / 1_000, leeway: .milliseconds(64)) { [weak self] in self?.drainTick() })
        timers.append(makeTimer(seconds: options.clockIntervalSeconds, leeway: .seconds(1)) { [weak self] in self?.emitClock(reason: .periodic) })
        scheduleHealthTimer(milliseconds: config?.healthIntervalMs ?? 60_000)
    }

    func scheduleHealthTimer(milliseconds: Int) {
        guard options.timers else { return }
        healthTimer?.cancel()
        healthTimer = makeTimer(seconds: Double(milliseconds) / 1_000, leeway: .seconds(1)) { [weak self] in self?.healthTick() }
    }

    private func makeTimer(seconds: Double, leeway: DispatchTimeInterval, _ handler: @escaping @Sendable () -> Void) -> DispatchSourceTimer {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        let interval = DispatchTimeInterval.milliseconds(Int(seconds * 1_000))
        timer.schedule(deadline: .now() + interval, repeating: interval, leeway: leeway)
        timer.setEventHandler(handler: handler)
        timer.resume()
        return timer
    }

    private func tearDown(reason: TrackEndReason) {
        guard started, !stopped else { return }
        stopped = true
        stopMicrophone(reason: reason)
        stopAppTaps(reason: reason)
        stopSystem(reason: reason)
        updateCalls()
        if micMuted { try? hal.setProcessInputMute(false) }
        endSpeechHold()
        for timer in timers { timer.cancel() }
        healthTimer?.cancel()
        timers.removeAll()
        systemRetry?.cancel()
        microphoneRetry?.cancel()
        env.powerEvents.stop()
        env.foreground.stop()
        stopSituation()
        for token in systemTokens { hal.removeListener(token) }
        systemTokens.removeAll()
        devices.stop()
        processes.stop()
    }

    // MARK: Control messages

    private func process(_ message: ControlMessage) {
        guard !stopped else {
            emit(.error(.requestRejected, "The helper is shutting down.", replyTo: message.id))
            return
        }
        switch message {
        case .hello(let id, _):
            emit(.ready(readyEvent(replyTo: id)))
        case .config(let id, let newConfig):
            let previous = config
            config = newConfig
            if previous?.healthIntervalMs != newConfig.healthIntervalMs { scheduleHealthTimer(milliseconds: newConfig.healthIntervalMs) }
            // Open runs switch to the new capture-gate settings before the ack.
            if previous?.vad != newConfig.vad {
                for processor in processors { processor.updateDetection(detectionParameters()) }
            }
            // Zones first: capture never opens, even for a moment, where a hold applies.
            if rehashNetworks() { publishSituationIfChanged() }
            updateHolds(configChanged: true)
            reconcile(reason: .disabled)
            publishProcessesIfChanged()
            emit(.ack(id))
        case .excludePids(let id, let pids):
            ownPIDs = Set(pids).union([env.ownPID])
            updateSystemExclusions()
            reconcileAppTaps(now: env.clock.anchor().continuousNs)
            publishProcessesIfChanged()
            emit(.ack(id))
        case .pinInput(let id, let uid, let allowBluetooth):
            if let uid {
                guard devices.device(uid: uid)?.hasInput == true else {
                    emit(.error(.requestRejected, "No input device with this UID.", replyTo: id))
                    return
                }
                pin = InputPin(deviceUid: uid, allowBluetooth: allowBluetooth)
            } else {
                pin = nil
            }
            reconcileMicrophone(reason: .deviceChanged)
            emit(.ack(id))
        case .pause(let id, let scope):
            if scope.coversMicrophone {
                paused.microphone = true
                muteMicrophone(reason: .paused)
            }
            if scope.coversSystemAudio {
                paused.systemAudio = true
                stopAppTaps(reason: .paused)
                stopSystem(reason: .paused)
            }
            updateCalls()
            emit(.ack(id))
        case .resume(let id, let scope):
            if scope.coversMicrophone { paused.microphone = false }
            if scope.coversSystemAudio { paused.systemAudio = false }
            reconcile(reason: .paused)
            emit(.ack(id))
        case .snapshot(let id):
            snapshot(replyTo: id)
        case .shutdown(let id):
            tearDown(reason: .shutdown)
            emit(.ack(id))
            onShutdown?()
        case .requestPermissions(let id, let scope):
            requestPermissions(id: id, scope: scope)
        }
    }

    private func snapshot(replyTo id: String) {
        emit(.permissions(PermissionsEvent(replyTo: id, microphone: permissions.microphone, systemAudio: permissions.systemAudio)))
        emit(.devices(devicesEvent().with(replyTo: id)))
        emit(.processes(processesEvent().with(replyTo: id)))
        emit(.activity(activityEvent().with(replyTo: id)))
        for processor in processors {
            if let open = processor.openEvent { emit(HelperEvent.trackOpen(open).replying(to: id)) }
            if let update = processor.epochChangeEvent { emit(HelperEvent.trackUpdate(update).replying(to: id)) }
            if let region = processor.openRegion { emit(HelperEvent.regionOpen(region).replying(to: id)) }
            // An outage reported before this connection is still on: say it again. Not as a
            // reply: an error reply would end the snapshot.
            if let error = processor.spoolError { emit(error) }
        }
        emitClock(reason: .request, replyTo: id)
        // After the clock, so core places them with a fresh anchor. That clock vouches only for
        // these replays: core closes any call or listen span it knows that is not replayed here
        // at the last clock that vouched for it.
        for bundleId in calls.active.keys.sorted() {
            if let call = calls.active[bundleId] { emit(HelperEvent.call(call.activeEvent).replying(to: id)) }
        }
        for bundleId in listens.active.keys.sorted() {
            if let listen = listens.active[bundleId] { emit(HelperEvent.listen(listen.activeEvent).replying(to: id)) }
        }
        for bundleId in seenCalls.active.keys.sorted() {
            if let call = seenCalls.active[bundleId] { emit(HelperEvent.callSeen(seenEvent(call.activeEvent)).replying(to: id)) }
        }
        emit(.situation(situationEvent(replyTo: id)))
        emit(.holds(HoldsEvent(replyTo: id, holds: zones.lastHolds)))
        emit(.ack(id))
    }

    private func requestPermissions(id: String, scope: PauseScope) {
        let finish: @Sendable () -> Void = { [weak self] in
            guard let self else { return }
            self.queue.async {
                let changed = self.permissions.refresh(microphone: self.env.permissions.microphone(), systemAudio: self.env.permissions.systemAudio())
                self.emit(.permissions(PermissionsEvent(replyTo: id, microphone: self.permissions.microphone, systemAudio: self.permissions.systemAudio)))
                if changed { self.reconcile(reason: .permission) }
                self.emit(.ack(id))
            }
        }
        let systemProbe: @Sendable () -> Void = { [weak self] in
            guard let self else { return }
            self.queue.async {
                guard scope.coversSystemAudio else { return finish() }
                self.probeSystemAudio(then: finish)
            }
        }
        if scope.coversMicrophone {
            env.permissions.requestMicrophone { _ in systemProbe() }
        } else {
            systemProbe()
        }
    }

    /// The system-audio prompt appears on the first `AudioDeviceStart` of a tap aggregate: start
    /// a short probe tap when `system:other` is not already running.
    private func probeSystemAudio(then finish: @escaping @Sendable () -> Void) {
        guard system?.ioProc == nil else { return finish() }
        let description = TapDescription(scope: .globalExcluding([]), name: "Sondine permission probe")
        guard let tap = try? hal.createProcessTap(description) else { return finish() }
        let uid = (try? hal.tapUID(tap)) ?? description.uuid.uuidString
        guard let aggregate = try? hal.createAggregateDevice(AggregateDescription(
            name: "Sondine permission probe", uid: DeviceCatalog.ownAggregatePrefix + UUID().uuidString.lowercased(), tapUIDs: [uid]
        )) else {
            hal.destroyProcessTap(tap)
            return finish()
        }
        let proc = try? hal.createIOProc(device: aggregate, inputOnly: false) { _, _ in }
        if let proc { try? hal.startIO(proc) }
        queue.asyncAfter(deadline: .now() + .seconds(1)) { [hal] in
            if let proc {
                hal.stopIO(proc)
                hal.destroyIOProc(proc)
            }
            hal.destroyAggregateDevice(aggregate)
            hal.destroyProcessTap(tap)
            finish()
        }
    }

    // MARK: Reconcile

    func reconcile(reason: TrackEndReason) {
        reconcileMicrophone(reason: reason)
        updateCalls()
        reconcileSystem(reason: reason)
    }

    var captureAllowed: Bool { config != nil && !asleep && sessionActive && !stopped }

    /// Calls and the other apps listening to a microphone are reported while Sondine listens to
    /// anything: never while fully paused, asleep, or stopped, and never for Sondine's own or an
    /// excluded app. One pass decides both, by app: an app with one process in a call is a call,
    /// never also a listener. The same calls are also said as `call.seen` whatever the user's
    /// pause (ADR 036), from the catalog that already runs in a pause: no listener is added.
    func updateCalls() {
        let candidates = captureAllowed ? (processes?.processes ?? []).filter { exclusion(for: $0) == nil } : []
        let appsWithOutput = Set(candidates.filter(\.io.runningOutput).compactMap { $0.resolution.app?.bundleId })
        let seen: [CallTracker.Source] = candidates.compactMap { process in
            guard let source = CallPolicy.source(of: process, appsWithOutput: appsWithOutput), WireText.isBundleId(source.bundleId) else { return nil }
            let uid = process.io.inputDevices.lazy.compactMap { self.devices.device($0)?.uid }.first { WireText.isPlainText($0, maxUnits: 512) }
            return CallTracker.Source(bundleId: source.bundleId, via: source.via, inputDeviceUid: uid)
        }
        let reporting = !(paused.microphone && paused.systemAudio)
        let scope = reporting ? candidates : []
        let sources = reporting ? seen : []
        let inCall = Set(sources.map(\.bundleId))
        let listeners: [ListenTracker.Source] = scope.compactMap { process in
            guard let source = ListenPolicy.source(of: process), !inCall.contains(source.bundleId), WireText.isBundleId(source.bundleId) else { return nil }
            return ListenTracker.Source(bundleId: source.bundleId, via: source.via)
        }
        let anchor = env.clock.anchor()
        let at = ClockPoint(hostTicks: anchor.hostTicks, continuousNs: anchor.continuousNs)
        for event in calls.update(sources: sources, at: at, newId: { UUID().uuidString.lowercased() }) {
            emit(.call(event))
        }
        for event in listens.update(sources: listeners, at: at, newId: { UUID().uuidString.lowercased() }) {
            emit(.listen(event))
        }
        // Asleep or in another user's session, nothing is observed: the calls seen stay as they
        // were until the Mac is back, so a call does not end only because nobody looked.
        if (!asleep && sessionActive) || stopped {
            for event in seenCalls.update(sources: seen, at: at, newId: { UUID().uuidString.lowercased() }) {
                emit(.callSeen(seenEvent(event)))
            }
        }
        updateCallFollow(now: anchor.continuousNs)
    }

    /// A seen call as `call.seen`, named by its app as the catalog resolved it, when it has a name.
    func seenEvent(_ event: CallEvent) -> CallSeenEvent {
        let name = (processes?.processes ?? []).lazy
            .compactMap { $0.resolution.app }
            .first { $0.bundleId == event.bundleId }?.name
            .flatMap { WireText.sanitized($0, maxUnits: 256) }
        return CallSeenEvent(replyTo: nil, callId: event.callId, state: event.state, at: event.at, bundleId: event.bundleId, name: name, via: event.via)
    }

    func reconcileMicrophone(reason: TrackEndReason) {
        guard let config, captureAllowed, config.microphone.enabled else {
            stopMicrophone(reason: config?.microphone.enabled == false ? .disabled : reason)
            return
        }
        // A denied microphone records nothing: the run ends, and a new one starts once access is back.
        guard !permissions.microphone.status.blocksCapture else {
            stopMicrophone(reason: .permission)
            return
        }
        let decision = MicrophonePolicy.decide(
            devices: devices.devices, defaultInput: devices.defaultInput, pin: pin, allowedTransports: config.microphone.allowedTransports,
            callFollow: callFollow.map { CallFollowCandidate(deviceUid: $0.uid) }
        )
        guard let choice = decision.choice else {
            stopMicrophone(reason: mic.map { devices.device($0.device) == nil ? .deviceRemoved : .deviceChanged } ?? reason)
            if case .none(let why) = decision { notice("input.none", why) }
            return
        }
        // Said even when the microphone does not move (a Bluetooth default while the built-in
        // microphone is already open), so core can explain why the default is not recorded.
        if let substituted = choice.substitutedFor {
            notice("input.substituted", "Automatic mode uses \(choice.device.info.name) instead of the default input \(substituted).")
        } else {
            lastMicNotice = nil
        }
        if let mic, mic.device == choice.device.id {
            if mic.choice != choice { mic.choice = choice }
            if !microphoneBlocked { resumeMicrophoneIfMuted() }
            return
        }
        let ended: TrackEndReason = mic.map { devices.device($0.device)?.info.alive == true ? .deviceChanged : .deviceRemoved } ?? reason
        stopMicrophone(reason: ended)
        // The user's pause or a hold: nothing opens.
        guard !microphoneBlocked else { return }
        startMicrophone(choice)
    }

    private func notice(_ code: String, _ message: String) {
        guard lastMicNotice != code + message else { return }
        lastMicNotice = code + message
        emit(.warning(code, message))
    }

    func reconcileSystem(reason: TrackEndReason) {
        guard let config, captureAllowed, config.systemAudio.enabled, !systemBlocked else {
            let ended: TrackEndReason = config?.systemAudio.enabled == false ? .disabled
                : zones.heldEverything && !paused.systemAudio && captureAllowed ? .held : reason
            stopAppTaps(reason: ended)
            stopSystem(reason: ended)
            return
        }
        guard !permissions.systemAudio.status.blocksCapture else {
            stopAppTaps(reason: .permission)
            stopSystem(reason: .permission)
            return
        }
        // Without app taps, `system:other` holds all system audio, all the time.
        guard config.systemAudio.appTaps.enabled else {
            stopAppTaps(reason: .disabled)
            if system == nil { startSystem() } else { updateSystemExclusions() }
            // Sondine's own reference does not depend on app taps.
            reconcileSelfPlayback(now: env.clock.anchor().continuousNs)
            return
        }
        reconcileAppTaps(now: env.clock.anchor().continuousNs)
    }

    // MARK: Microphone

    private func startMicrophone(_ choice: MicrophoneChoice) {
        let device = choice.device
        let rate = (try? hal.nominalSampleRate(device.id)) ?? device.info.nominalRate ?? 48_000
        let context = IOCaptureContext(rate: rate, ringSeconds: options.ringSeconds, timebase: env.clock.timebase)
        let frames = options.bufferFrames(rate: rate, range: try? hal.bufferFrameSizeRange(device.id))
        do { try hal.setBufferFrameSize(device.id, frames: frames) } catch {
            emit(.warning("input.buffer-size", "Cannot set the IO buffer size: \(error).", trackKey: TrackKeys.input(device.uid)))
        }
        let source = TrackSource.input(InputSource(
            deviceUid: device.uid, name: Self.shortText(device.info.name, fallback: device.uid), transport: device.transport, selection: choice.selection
        ))
        let processor = TrackProcessor(
            trackKey: TrackKeys.input(device.uid), kind: .microphone, source: source, nominalRate: rate, context: context, services: services(.microphone)
        )
        let capture = MicCapture(choice: choice, processor: processor)
        do {
            let proc = try hal.createIOProc(device: device.id, inputOnly: true) { input, time in context.ingest(input, time) }
            capture.ioProc = proc
            try hal.startIO(proc)
        } catch {
            if let proc = capture.ioProc { hal.destroyIOProc(proc) }
            emit(.error(.captureFailed, "Cannot start the microphone: \(error).", trackKey: processor.trackKey))
            scheduleMicrophoneRetry()
            return
        }
        if let token = try? hal.addListener(device.id, .processorOverload, queue: queue, { [weak processor] in processor?.overloads += 1 }) {
            capture.tokens.append(token)
        }
        mic = capture
        resumeMicrophoneIfMuted()
    }

    /// Ends the microphone's run. With `cutNs` (a hold), what it captured from then on and did
    /// not commit is dropped.
    func stopMicrophone(reason: TrackEndReason, cutNs: UInt64? = nil) {
        guard let capture = mic else { return }
        mic = nil
        capture.tokens.forEach(reason.objectsGone ? hal.discardListener : hal.removeListener)
        if let proc = capture.ioProc { hal.stopIO(proc) }
        _ = capture.processor.drain(cutNs: cutNs)
        capture.processor.close(reason: reason, silenceFromNs: cutNs)
        if let proc = capture.ioProc { hal.destroyIOProc(proc) }
    }

    /// Pause or hold: built-in and USB microphones are muted for the process (instant, and the
    /// recording indicator goes off); Bluetooth IO is stopped, because a muted headset stays in
    /// call mode.
    func muteMicrophone(reason: TrackEndReason, cutNs: UInt64? = nil) {
        guard let capture = mic else { return }
        if capture.choice.device.transport.isBluetooth || (try? hal.setProcessInputMute(true)) == nil {
            stopMicrophone(reason: reason, cutNs: cutNs)
            return
        }
        micMuted = true
        _ = capture.processor.drain(cutNs: cutNs)
        capture.processor.close(reason: reason, silenceFromNs: cutNs)
        capture.processor.discardInput = true
    }

    private func resumeMicrophoneIfMuted() {
        guard micMuted, !microphoneBlocked else { return }
        do {
            try hal.setProcessInputMute(false)
            micMuted = false
            mic?.processor.discardInput = false
        } catch {
            emit(.warning("input.unmute", "Cannot unmute process input: \(error)."))
        }
    }

    /// Recreates the microphone IOProc inside the same run (zeros or a rate mismatch after a
    /// rate change, or no IO at all); the stall becomes a gap.
    private func restartMicrophoneIO(reason: String) {
        guard let capture = mic else { return }
        emit(.warning("input.rebuilt", "Restarted microphone IO: \(reason).", trackKey: capture.processor.trackKey))
        if let proc = capture.ioProc {
            hal.stopIO(proc)
            hal.destroyIOProc(proc)
            capture.ioProc = nil
        }
        _ = capture.processor.drain()
        capture.processor.noteIORestarted(afterStall: true)
        let context = capture.processor.context
        do {
            let proc = try hal.createIOProc(device: capture.device, inputOnly: true) { input, time in context.ingest(input, time) }
            capture.ioProc = proc
            try hal.startIO(proc)
        } catch {
            emit(.error(.captureFailed, "Cannot restart the microphone: \(error).", trackKey: capture.processor.trackKey))
            stopMicrophone(reason: .error)
            scheduleMicrophoneRetry()
        }
    }

    /// A microphone that failed to start opens again 5 s later, in a new run.
    private func scheduleMicrophoneRetry() {
        guard options.timers else { return }
        microphoneRetry?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.microphoneRetry = nil
            self?.reconcileMicrophone(reason: .error)
        }
        microphoneRetry = work
        queue.asyncAfter(deadline: .now() + .seconds(5), execute: work)
    }

    // MARK: System audio

    func startSystem() {
        let excluded = excludedObjects()
        let capture: SystemCapture
        let processorSource = TrackSource.system(SystemSource(excludedObjectIds: excluded))
        // The aggregate's rate is only known once it exists; the processor starts at 48 kHz and
        // follows the aggregate's nominal rate and the measured rate.
        let placeholder = IOCaptureContext(rate: 48_000, ringSeconds: options.ringSeconds, timebase: env.clock.timebase)
        let processor = TrackProcessor(
            trackKey: TrackKeys.system, kind: .system, source: processorSource, nominalRate: 48_000, context: placeholder, services: services(.system)
        )
        capture = SystemCapture(excluded: excluded, processor: processor)
        do {
            try buildTap(capture, description: systemTapDescription(capture), aggregateName: "Sondine system audio")
        } catch {
            destroyTap(capture)
            emit(.error(.captureFailed, "Cannot start the system audio tap: \(error).", trackKey: TrackKeys.system))
            scheduleSystemRetry()
            return
        }
        system = capture
    }

    func systemTapDescription(_ capture: SystemCapture) -> TapDescription {
        TapDescription(scope: .globalExcluding(capture.excluded), name: "Sondine system:other", uuid: capture.tapUUID)
    }

    /// Tap, then tap-only private aggregate (TapAutoStart off), then IOProc, then start. Each tap
    /// has its own aggregate (ADR 026): a tap starts and stops without touching the others.
    func buildTap(_ capture: TapCapture, description: TapDescription, aggregateName: String) throws {
        capture.tap = try hal.createProcessTap(description)
        // The HAL's tap identity, not the UUID requested.
        let tapUID = (try? hal.tapUID(capture.tap)) ?? capture.tapUUID.uuidString
        capture.aggregate = try hal.createAggregateDevice(AggregateDescription(
            name: aggregateName, uid: DeviceCatalog.ownAggregatePrefix + UUID().uuidString.lowercased(), tapUIDs: [tapUID]
        ))
        // Seed from the aggregate's nominal rate, not the tap format (a Bluetooth call drops
        // the aggregate to 16 or 24 kHz while the tap still says 48 kHz).
        let rate = (try? hal.nominalSampleRate(capture.aggregate)) ?? (try? hal.tapFormat(capture.tap).sampleRate) ?? 48_000
        capture.stream.noteNominalRate(rate, now: env.clock.anchor().continuousNs, armWatchdog: false)
        let frames = options.bufferFrames(rate: rate, range: try? hal.bufferFrameSizeRange(capture.aggregate))
        try? hal.setBufferFrameSize(capture.aggregate, frames: frames)
        let context = capture.stream.context
        let proc = try hal.createIOProc(device: capture.aggregate, inputOnly: false) { input, time in context.ingest(input, time) }
        capture.ioProc = proc
        let aggregate = capture.aggregate
        let processor = capture.stream
        for (object, property) in [(aggregate, HALProperty.nominalSampleRate), (capture.tap, .tapFormat)] {
            if let token = try? hal.addListener(object, property, queue: queue, { [weak self, weak processor] in
                guard let self, let processor else { return }
                let current = (try? self.hal.nominalSampleRate(aggregate)) ?? processor.nominalRate
                processor.noteNominalRate(current, now: self.env.clock.anchor().continuousNs, armWatchdog: true)
            }) {
                capture.tokens.append(token)
            }
        }
        if let token = try? hal.addListener(aggregate, .processorOverload, queue: queue, { [weak processor] in processor?.overloads += 1 }) {
            capture.tokens.append(token)
        }
        try hal.startIO(proc)
    }

    /// Teardown order proven in the prototype: listeners, IO, IOProc, aggregate, tap.
    func destroyTap(_ capture: TapCapture, objectsGone: Bool = false) {
        capture.tokens.forEach(objectsGone ? hal.discardListener : hal.removeListener)
        capture.tokens.removeAll()
        if let proc = capture.ioProc {
            hal.stopIO(proc)
            hal.destroyIOProc(proc)
            capture.ioProc = nil
        }
        if capture.aggregate != 0 { hal.destroyAggregateDevice(capture.aggregate) }
        if capture.tap != 0 { hal.destroyProcessTap(capture.tap) }
        capture.aggregate = 0
        capture.tap = 0
    }

    func stopSystem(reason: TrackEndReason, cutNs: UInt64? = nil) {
        systemRetry?.cancel()
        systemRetry = nil
        residualIdleSinceNs = nil
        guard let capture = system else { return }
        system = nil
        if let proc = capture.ioProc { hal.stopIO(proc) }
        _ = capture.processor.drain(cutNs: cutNs)
        capture.processor.close(reason: reason, silenceFromNs: cutNs)
        destroyTap(capture, objectsGone: reason.objectsGone)
    }

    /// Full tap and aggregate rebuild inside the same run (zero-stall watchdog, or exclusions
    /// the HAL refused to update in place), with the current exclusion list.
    private func rebuildSystemIO(reason: String, afterStall: Bool) {
        guard let capture = system else { return }
        if let proc = capture.ioProc { hal.stopIO(proc) }
        _ = capture.processor.drain()
        destroyTap(capture)
        capture.rebuilds += 1
        capture.processor.noteIORestarted(afterStall: afterStall)
        capture.tapUUID = UUID()
        capture.excluded = excludedObjects()
        do {
            try buildTap(capture, description: systemTapDescription(capture), aggregateName: "Sondine system audio")
            capture.processor.updateSource(.system(SystemSource(excludedObjectIds: capture.excluded)))
            emit(.warning("tap.rebuilt", "Rebuilt the system audio tap: \(reason).", trackKey: TrackKeys.system))
        } catch {
            destroyTap(capture)
            system = nil
            capture.processor.close(reason: .error)
            emit(.error(.captureFailed, "Cannot rebuild the system audio tap: \(error).", trackKey: TrackKeys.system))
            scheduleSystemRetry()
        }
    }

    private func scheduleSystemRetry() {
        guard options.timers else { return }
        systemRetry?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.systemRetry = nil
            self?.reconcileSystem(reason: .error)
        }
        systemRetry = work
        queue.asyncAfter(deadline: .now() + .seconds(5), execute: work)
    }

    /// Process objects `system:other` leaves out: Sondine's own processes (by pid, or
    /// responsible to one of them), apps the user excluded, and apps on their own track.
    func excludedObjects() -> [HALObjectID] {
        let onApps = appTrackObjects
        return processes.processes.filter { exclusion(for: $0) != nil || onApps.contains($0.id) }.map(\.id).sorted()
    }

    func exclusion(for process: CatalogProcess) -> ProcessExclusion? {
        if ownPIDs.contains(process.pid) { return .own }
        if let responsible = process.resolution.responsiblePID, responsible != process.pid, ownPIDs.contains(responsible) { return .own }
        // Before main reports a new renderer or audio service, its app already names it.
        if let bundle = process.resolution.app?.bundleId, bundle == Self.ownBundleId || bundle.hasPrefix(Self.ownBundleId + ".") { return .own }
        let excludedApps = Set(config?.excludedBundleIds ?? [])
        if let bundle = process.resolution.app?.bundleId, excludedApps.contains(bundle) { return .user }
        if let bundle = process.info.bundleID, excludedApps.contains(bundle) { return .user }
        return nil
    }

    /// The exclusion list (Sondine, excluded apps, apps on their own track) is updated in place
    /// (`kAudioTapPropertyDescription`), so `system:other` stays one run. When the HAL refuses,
    /// the tap that still has the old scope stops and is rebuilt with the new list (or system
    /// audio stops): no tap ever runs without a required exclusion.
    func updateSystemExclusions() {
        guard let capture = system else { return }
        let excluded = excludedObjects()
        guard excluded != capture.excluded else { return }
        defer { scheduleActivity() }
        let description = TapDescription(scope: .globalExcluding(excluded), name: "Sondine system:other", uuid: capture.tapUUID)
        do {
            try hal.updateProcessTap(capture.tap, description)
            capture.excluded = excluded
            capture.processor.updateSource(.system(SystemSource(excludedObjectIds: excluded)))
        } catch {
            emit(.warning("tap.exclusions", "Cannot update the system audio exclusions in place: \(error).", trackKey: TrackKeys.system))
            rebuildSystemIO(reason: "the exclusion list changed", afterStall: false)
        }
    }

    // MARK: Listener events

    private func deviceChanged(_ change: DeviceCatalogChange) {
        let now = env.clock.anchor().continuousNs
        switch change {
        case .list, .defaultDevice(.input), .defaultDevice(.global), .alive:
            // A headset a call already reads may only now be listed.
            updateCallFollow(now: now)
            reconcileMicrophone(reason: .deviceChanged)
        case .defaultDevice(.output):
            // A new default output changes what the taps mix: full rebuild, new runs.
            if system != nil || !apps.isEmpty || selfPlayback != nil {
                stopAppTaps(reason: .deviceChanged)
                stopSystem(reason: .deviceChanged)
                reconcileSystem(reason: .deviceChanged)
                for processor in tapProcessors { processor.noteRouteEvent(now: now) }
            }
        case .nominalRate(let id), .format(let id), .hasChanged(let id):
            if let capture = mic, capture.device == id {
                capture.processor.noteNominalRate((try? hal.nominalSampleRate(id)) ?? capture.processor.nominalRate, now: now)
                capture.processor.noteRouteEvent(now: now)
            }
            if id == devices.defaultOutput { for processor in tapProcessors { processor.noteRouteEvent(now: now) } }
        case .dataSource(let id, _):
            if let capture = mic, capture.device == id { capture.processor.noteRouteEvent(now: now) }
            if id == devices.defaultOutput { for processor in tapProcessors { processor.noteRouteEvent(now: now) } }
        }
        publishDevicesIfChanged()
    }

    private func processesChanged(_ change: ProcessCatalogChange) {
        // A call or an excluded app's microphone may start a hold: before anything else.
        updateHolds()
        if case .list = change {
            updateSystemExclusions()
            publishProcessesIfChanged()
        }
        updateCalls()
        reconcileAppTaps(now: env.clock.anchor().continuousNs)
        scheduleActivity()
    }

    /// coreaudiod restarted: every object id and listener is void. Close the runs, register
    /// everything again, and rebuild from UIDs and bundle ids.
    private func serviceRestarted() {
        guard !stopped else { return }
        stopMicrophone(reason: .serviceRestarted)
        stopAppTaps(reason: .serviceRestarted)
        stopSystem(reason: .serviceRestarted)
        for token in systemTokens { hal.discardListener(token) }
        devices.stop(objectsGone: true)
        processes.stop(objectsGone: true)
        applyProcessFlags()
        registerSystemListeners()
        reconcile(reason: .serviceRestarted)
        publishDevicesIfChanged()
        publishProcessesIfChanged()
        scheduleActivity()
        emit(.warning("hal.service-restarted", "coreaudiod restarted; capture was rebuilt."))
    }

    private func sessionChanged() {
        let active = (try? hal.userSessionIsActive()) ?? true
        guard active != sessionActive else { return }
        sessionActive = active
        updateHolds()
        // Another user's session must never be recorded.
        reconcile(reason: .disabled)
    }

    private func powerEvent(_ event: SystemPowerEvent) {
        switch event {
        case .willSleep:
            asleep = true
            stopMicrophone(reason: .sleep)
            stopAppTaps(reason: .sleep)
            stopSystem(reason: .sleep)
            updateCalls()
            endSpeechHold()
        case .didWake:
            emitClock(reason: .wake)
            let settle = DispatchTimeInterval.milliseconds(Int(options.wakeSettleSeconds * 1_000))
            queue.asyncAfter(deadline: .now() + settle) { [weak self] in
                guard let self, self.asleep else { return }
                self.asleep = false
                // Holds outlive the sleep: decide them again before anything opens.
                self.extendNetworkHoldsAfterWake()
                self.updateHolds()
                self.reconcile(reason: .sleep)
                self.emitClock(reason: .wake)
            }
        }
    }

    // MARK: Drain worker

    private func drainTick() {
        guard started, !stopped else { return }
        let anchor = env.clock.anchor()
        updateHoldsIfDue(anchor)
        let now = anchor.continuousNs
        drainAppTaps(now: now)
        if let capture = system {
            capture.processor.updateOutputInScope(Set(residualScope.filter(\.io.runningOutput).map(\.id)), now: now)
            let outcome = capture.processor.drain()
            noteFirstBlock(capture, outcome)
            if outcome.blocks > 0 { closeRetiredAppTaps(now: now) }
            if outcome.firstSignal, permissions.verify(.system) { emitPermissions() }
            if case .rebuild(let reason) = outcome.action { rebuildSystemIO(reason: reason, afterStall: true) }
            if case .rebuild(let reason) = system?.processor.checkStall(now: now) { rebuildSystemIO(reason: reason, afterStall: true) }
        }
        if let capture = mic {
            let outcome = capture.processor.drain()
            if outcome.firstSignal, permissions.verify(.microphone) { emitPermissions() }
            if case .rebuild(let reason) = outcome.action { restartMicrophoneIO(reason: reason) }
            if case .rebuild(let reason) = mic?.processor.checkStall(now: now) { restartMicrophoneIO(reason: reason) }
        }
        drainSelfPlayback()
        // Process changes start taps; the drain only runs their timers (releases, retries).
        if !apps.isEmpty || system != nil || !appBackoff.isEmpty { reconcileAppTaps(now: now) } else { reconcileSelfPlayback(now: now) }
        updateCallFollow(now: now)
        updateSpeechHold(now: now)
        forgetForeground(now: now)
    }

    // MARK: The app in front (ADR 022)

    /// How far back the app in front is kept before the earliest open region (or now): a region
    /// opens a little after the speech it starts at.
    static let foregroundMarginNs: UInt64 = 30_000_000_000

    private func startForeground() {
        let current = env.foreground.start { [weak self] app in
            guard let self else { return }
            // Timed when seen, not when the engine queue gets to it.
            let at = self.env.clock.anchor().continuousNs
            self.queue.async { self.foreground.record(app, atNs: at) }
        }
        foreground.record(current, atNs: env.clock.anchor().continuousNs)
    }

    /// Only what an open region may still need is kept: never a log of the day.
    private func forgetForeground(now: UInt64) {
        let opens = processors.compactMap { $0.openRegion?.at.continuousNs.value }
        let horizon = min(opens.min() ?? now, now)
        foreground.forget(before: horizon > Self.foregroundMarginNs ? horizon - Self.foregroundMarginNs : 0)
    }

    /// The apps in front over a stretch, without those the user excluded from capture.
    private func foregroundSpans(fromNs: UInt64, toNs: UInt64) -> [ForegroundTimeline.Span] {
        let excluded = Set(config?.excludedBundleIds ?? [])
        return foreground.spans(fromNs: fromNs, toNs: toNs).filter {
            !excluded.contains($0.app.bundleId) && WireText.isBundleId($0.app.bundleId)
        }
    }

    /// In-person speech: a mic region is open while no call is going on (the call app keeps the
    /// Mac awake itself). Another app merely holding a microphone is no call: a dictation app
    /// such as Hex keeps one open all day by default (2026-11-08), which used to stop every hold.
    /// The hold is released after the in-person episode gap.
    private func updateSpeechHold(now: UInt64) {
        let inCall = !calls.active.isEmpty
        if mic?.processor.hasOpenRegion == true && !inCall {
            lastInPersonNs = now
            if !speechHeld { speechHeld = env.speechHold.begin() }
        } else if speechHeld, Double(now &- lastInPersonNs) / 1e9 >= options.inPersonGapSeconds {
            endSpeechHold()
        }
    }

    private func endSpeechHold() {
        guard speechHeld else { return }
        env.speechHold.end()
        speechHeld = false
    }

    // MARK: Services

    /// Capture-gate settings from the current `config`.
    private func detectionParameters() -> SpeechActivityParameters {
        var parameters = SpeechActivityParameters()
        if let vad = config?.vad {
            parameters.segmenter.onsetThreshold = Float(vad.threshold)
            parameters.segmenter.offsetThreshold = Float(max(0, vad.threshold - 0.15))
            parameters.segmenter.minSpeechMs = vad.minSpeechMs
            parameters.segmenter.minSilenceMs = vad.minSilenceMs
        }
        return parameters
    }

    /// One VAD stream for the microphone and one for `system:other`, for the helper's lifetime
    /// (each run resets its state); an app track brings its own (`detector`), since several run
    /// at once. All of them share one model.
    func services(_ kind: TrackKind, detector: (any VoiceActivityDetector)? = nil) -> TrackServices {
        let parameters = detectionParameters()
        if kind != .app, detectors[kind] == nil, let made = env.makeDetector(kind) { detectors[kind] = made }
        return TrackServices(
            clock: env.clock,
            spoolRoot: env.spoolRoot,
            sessionId: sessionId,
            helperVersion: options.helperVersion,
            parameters: parameters,
            spoolConfiguration: options.spoolConfiguration,
            detector: kind == .app ? detector : detectors[kind],
            makeFileSystem: env.makeFileSystem,
            allocateEpoch: { [unowned self] in
                epochCounter += 1
                return epochCounter
            },
            emit: { [weak self] event in self?.emit(event) },
            runChanged: { [weak self] in self?.scheduleActivity() },
            foreground: { [weak self] from, to in self?.foregroundSpans(fromNs: from, toNs: to) ?? [] }
        )
    }

    func emit(_ event: HelperEvent) {
        sink?.emit(event)
    }

    private func currentState() -> CaptureState {
        var state = CaptureState()
        state.configured = config != nil
        state.paused = paused
        state.microphoneUid = mic?.choice.device.uid
        state.microphoneSelection = mic?.choice.selection
        state.microphoneRunId = mic?.processor.runId?.uuidString.lowercased()
        state.microphoneNominalRate = mic?.processor.nominalRate
        state.microphoneResamplerRebuilds = mic?.processor.resamplerRebuilds ?? 0
        state.microphoneMuted = micMuted
        state.systemRunId = system?.processor.runId?.uuidString.lowercased()
        state.systemExcludedObjects = system?.excluded ?? []
        state.systemStream = system.map { $0.processor.stream }
        state.systemRebuilds = system?.rebuilds ?? 0
        state.appTracks = apps.values.map { capture in
            CaptureState.AppTrack(bundleId: capture.bundleId, objects: capture.objects, runId: capture.processor.runId?.uuidString.lowercased(), leftResidual: capture.leftResidual)
        }.sorted { $0.bundleId < $1.bundleId }
        state.speechHoldActive = speechHeld
        state.permissions = permissions
        state.processObjects = processes?.processes.count ?? 0
        state.asleep = asleep
        state.foregroundChanges = foreground.changes.count
        state.callFollowUid = callFollow?.uid
        state.holds = zones.lastHolds
        state.heldMicrophone = zones.heldMicrophone
        state.heldEverything = zones.heldEverything
        state.screenAway = zones.screenAway
        state.networks = zones.networks.sorted()
        return state
    }

    static let ownBundleId = "app.sondine"

    static func shortText(_ text: String, fallback: String) -> String {
        WireText.sanitized(text, maxUnits: 256) ?? WireText.sanitized(fallback, maxUnits: 256) ?? "Unknown"
    }
}
