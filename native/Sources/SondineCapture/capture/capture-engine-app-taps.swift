import Foundation
import SondineKit

// App taps (ADR 026): every app playing in system audio's scope gets its own tap, aggregate and
// track, `app:<bundleId>`; `system:other` keeps the rest (processes with no app, apps over the
// cap, apps released for silence) and runs only while something in its scope plays.
extension CaptureEngine {
    final class AppCapture: TrackTapCapture {
        let bundleId: String
        let name: String?
        var objects: [HALObjectID]
        var held: AppTapPolicy.Held
        /// Its objects are out of `system:other`: its first block arrived (make-before-break).
        var leftResidual = false
        /// When it handed its app back to `system:other` while the app still played.
        var handedOverNs: UInt64?

        init(tap: AppTapPolicy.Tap, processor: TrackProcessor, now: UInt64) {
            bundleId = tap.bundleId
            name = tap.name
            objects = tap.objects
            held = AppTapPolicy.Held(bundleId: tap.bundleId, startedNs: now, lastOutputNs: now)
            super.init(processor: processor)
        }
    }

    /// Every open track processor: the microphone, then the taps.
    var processors: [TrackProcessor] { [mic?.processor].compactMap { $0 } + tapProcessors }

    /// `system:other`, then the app tracks in bundle id order, then those handing over.
    var tapProcessors: [TrackProcessor] {
        [system?.processor].compactMap { $0 } + apps.values.sorted { $0.bundleId < $1.bundleId }.map(\.processor)
            + retiringApps.map(\.processor)
    }

    /// Process objects on an app track, out of `system:other`.
    var appTrackObjects: Set<HALObjectID> { Set(apps.values.filter(\.leftResidual).flatMap(\.objects)) }

    func appTrackKey(of object: HALObjectID) -> String? {
        apps.values.first { $0.leftResidual && $0.objects.contains(object) }?.processor.trackKey
    }

    /// The process objects `system:other` captures now.
    var residualScope: [CatalogProcess] {
        let onApps = appTrackObjects
        return (processes?.processes ?? []).filter { exclusion(for: $0) == nil && !onApps.contains($0.id) }
    }

    /// A process with an app gets that app's tap; alerts are not memory.
    static func tappable(_ process: CatalogProcess) -> Bool {
        guard let bundleId = process.resolution.app?.bundleId, WireText.isBundleId(bundleId) else { return false }
        return process.resolution.daemonRole != .systemSound
    }

    // MARK: Decisions

    /// Applies the decision list: app taps first, then `system:other`. Runs at every process
    /// change and every drain (the release timers).
    func reconcileAppTaps(now: UInt64) {
        reconcileSelfPlayback(now: now)
        guard let config, config.systemAudio.appTaps.enabled, captureAllowed, config.systemAudio.enabled, !systemBlocked,
              !permissions.systemAudio.status.blocksCapture, let processes else { return }
        var grouped: [String: (name: String?, objects: [HALObjectID], output: Bool)] = [:]
        for process in processes.processes where exclusion(for: process) == nil && Self.tappable(process) {
            guard let app = process.resolution.app else { continue }
            var entry = grouped[app.bundleId] ?? (app.name.flatMap { WireText.sanitized($0, maxUnits: 256) }, [], false)
            entry.objects.append(process.id)
            entry.output = entry.output || process.io.runningOutput
            grouped[app.bundleId] = entry
        }
        for (bundleId, entry) in grouped where entry.output && outputSince[bundleId] == nil { outputSince[bundleId] = now }
        // An app whose output stopped may be tapped again (a silence release lasts until then).
        for bundleId in Array(outputSince.keys) where grouped[bundleId]?.output != true { outputSince[bundleId] = nil }
        quietApps = quietApps.filter { grouped[$0]?.output == true }
        appBackoff = appBackoff.filter { $0.value > now }

        let calling = Set(calls.active.keys)
        for capture in apps.values {
            if grouped[capture.bundleId]?.output == true { capture.held.lastOutputNs = now }
            if calling.contains(capture.bundleId) { capture.held.lastCallNs = now }
        }
        let settings = AppTapPolicy.Settings(
            max: config.systemAudio.appTaps.max,
            releaseAfterIdleNs: UInt64(config.systemAudio.appTaps.releaseAfterIdleMs) * 1_000_000,
            releaseAfterSilenceNs: UInt64(config.systemAudio.appTaps.releaseAfterSilenceMs) * 1_000_000,
            callHoldNs: UInt64(options.callFollowHoldSeconds * 1e9)
        )
        let plan = AppTapPolicy.plan(
            apps: grouped.map { AppTapPolicy.App(bundleId: $0.key, name: $0.value.name, objects: $0.value.objects.sorted(), outputRunning: $0.value.output, outputSinceNs: outputSince[$0.key]) },
            calls: calling,
            held: apps.values.map(\.held),
            quiet: quietApps,
            waiting: Set(appBackoff.keys),
            now: now,
            settings: settings
        )
        quietApps.formUnion(plan.silenced)

        var changed = false
        let wanted = Set(plan.taps.map(\.bundleId))
        for bundleId in apps.keys.sorted() where !wanted.contains(bundleId) {
            // Silent, or no longer playing, it has nothing to hand over.
            let playing = grouped[bundleId]?.output == true && !plan.silenced.contains(bundleId)
            stopAppTap(bundleId, reason: .tapReleased, handOver: playing, now: now)
            changed = true
        }
        for tap in plan.taps {
            if let capture = apps[tap.bundleId] {
                if capture.objects != tap.objects {
                    updateAppObjects(capture, tap.objects)
                    changed = true
                }
            } else {
                startAppTap(tap, now: now)
                changed = true
            }
        }
        if reconcileResidual(now: now) { changed = true }
        if changed {
            publishProcessesIfChanged()
            scheduleActivity()
        }
    }

    /// `system:other` runs while something in its scope plays (alerts and apps about to get
    /// their own tap do not count), and stops `residualHoldSeconds` after. Returns whether it
    /// started, stopped or changed scope.
    @discardableResult
    func reconcileResidual(now: UInt64) -> Bool {
        let pending = Set(apps.values.filter { !$0.leftResidual }.flatMap(\.objects))
        let demand = residualScope.contains { process in
            process.io.runningOutput && !pending.contains(process.id) && process.resolution.daemonRole != .systemSound
        }
        let before = system.map { ($0.processor.runId, $0.excluded) }
        if demand {
            residualIdleSinceNs = nil
            if system == nil {
                // After a failed start, the retry waits its turn; paused or held, nothing opens.
                guard systemRetry == nil, !systemBlocked else { return false }
                startSystem()
                system?.requestedNs = now
            } else {
                updateSystemExclusions()
            }
        } else if system != nil {
            updateSystemExclusions()
            let since = residualIdleSinceNs ?? now
            residualIdleSinceNs = since
            if Double(now &- since) / 1e9 >= options.residualHoldSeconds { stopSystem(reason: .tapReleased) }
        }
        let after = system.map { ($0.processor.runId, $0.excluded) }
        return before?.0 != after?.0 || before?.1 != after?.1 || (before == nil) != (after == nil)
    }

    // MARK: Taps

    func appSource(_ capture: AppCapture) -> TrackSource {
        .app(AppSource(bundleId: capture.bundleId, name: capture.name, objectIds: Array(capture.objects.prefix(64))))
    }

    func appTapDescription(_ capture: AppCapture) -> TapDescription {
        TapDescription(scope: .processes(capture.objects), name: "Sondine \(TrackKeys.app(capture.bundleId))", uuid: capture.tapUUID)
    }

    private func startAppTap(_ tap: AppTapPolicy.Tap, now: UInt64) {
        let trackKey = TrackKeys.app(tap.bundleId)
        // One track per app: a tap still handing over gives way to the new one.
        for capture in retiringApps where capture.bundleId == tap.bundleId { closeAppTap(capture, reason: .tapReleased) }
        retiringApps.removeAll { $0.bundleId == tap.bundleId }
        // Its own VAD state, on the model every track shares.
        let detector = env.makeDetector(.app)
        // The aggregate's rate is only known once it exists; the processor follows it.
        let placeholder = IOCaptureContext(rate: 48_000, ringSeconds: options.ringSeconds, timebase: env.clock.timebase)
        let source = TrackSource.app(AppSource(bundleId: tap.bundleId, name: tap.name, objectIds: Array(tap.objects.prefix(64))))
        let processor = TrackProcessor(
            trackKey: trackKey, kind: .app, source: source, nominalRate: 48_000, context: placeholder, services: services(.app, detector: detector)
        )
        let capture = AppCapture(tap: tap, processor: processor, now: now)
        capture.requestedNs = now
        do {
            try buildTap(capture, description: appTapDescription(capture), aggregateName: "Sondine app audio")
        } catch {
            destroyTap(capture)
            // It stays on `system:other`; another try in a while.
            appBackoff[tap.bundleId] = now + Self.appRetryNs
            emit(.warning("tap.app-failed", "Cannot start an app tap: \(error).", trackKey: trackKey))
            return
        }
        apps[tap.bundleId] = capture
    }

    static let appRetryNs: UInt64 = 5_000_000_000

    /// Ends an app's track. An app still playing goes back to `system:other` first
    /// (make-before-break): `system:other` starts or widens, and the tap runs on until
    /// `system:other` delivers a block (`closeRetiredAppTaps`).
    func stopAppTap(_ bundleId: String, reason: TrackEndReason, handOver: Bool, now: UInt64) {
        guard let capture = apps.removeValue(forKey: bundleId) else { return }
        if capture.leftResidual { reconcileResidual(now: now) }
        if handOver && capture.leftResidual {
            capture.handedOverNs = now
            retiringApps.append(capture)
        } else {
            closeAppTap(capture, reason: reason)
        }
    }

    /// `system:other` delivered: the taps that handed their app over to it at least
    /// `handOverNs` ago (blocks already queued before the hand-over do not count) can stop.
    func closeRetiredAppTaps(now: UInt64) {
        let retired = retiringApps.filter { now &- ($0.handedOverNs ?? now) >= Self.handOverNs }
        guard !retired.isEmpty else { return }
        retiringApps.removeAll { capture in retired.contains { $0 === capture } }
        for capture in retired { closeAppTap(capture, reason: .tapReleased) }
    }

    static let handOverNs: UInt64 = 500_000_000

    private func closeAppTap(_ capture: AppCapture, reason: TrackEndReason, cutNs: UInt64? = nil) {
        if let proc = capture.ioProc { hal.stopIO(proc) }
        _ = capture.processor.drain(cutNs: cutNs)
        capture.processor.close(reason: reason, silenceFromNs: cutNs)
        destroyTap(capture, objectsGone: reason.objectsGone)
    }

    /// Ends every app track at once (pause, hold, sleep, shutdown, a lost permission or device):
    /// nothing goes back to `system:other`, which stops or is rebuilt by the caller. The
    /// `self:playback` reference stops with them.
    func stopAppTaps(reason: TrackEndReason, cutNs: UInt64? = nil) {
        for bundleId in apps.keys.sorted() {
            guard let capture = apps.removeValue(forKey: bundleId) else { continue }
            closeAppTap(capture, reason: reason, cutNs: cutNs)
        }
        for capture in retiringApps { closeAppTap(capture, reason: reason, cutNs: cutNs) }
        retiringApps.removeAll()
        quietApps.removeAll()
        outputSince.removeAll()
        appBackoff.removeAll()
        stopSelfPlayback(objectsGone: reason.objectsGone, cutNs: cutNs)
    }

    /// A process object of a tapped app appeared or left: the tap follows in place, then
    /// `system:other` lets the new one go.
    private func updateAppObjects(_ capture: AppCapture, _ objects: [HALObjectID]) {
        capture.objects = objects
        do {
            try hal.updateProcessTap(capture.tap, appTapDescription(capture))
            capture.processor.updateSource(appSource(capture))
        } catch {
            emit(.warning("tap.app-objects", "Cannot update an app tap in place: \(error).", trackKey: capture.processor.trackKey))
            rebuildAppIO(capture, reason: "its processes changed")
        }
        if capture.leftResidual { updateSystemExclusions() }
    }

    /// Full tap and aggregate rebuild inside the same run (zero-stall watchdog, or a process
    /// list the HAL refused to update in place).
    private func rebuildAppIO(_ capture: AppCapture, reason: String) {
        guard apps[capture.bundleId] === capture else { return }
        if let proc = capture.ioProc { hal.stopIO(proc) }
        _ = capture.processor.drain()
        destroyTap(capture)
        capture.rebuilds += 1
        capture.processor.noteIORestarted(afterStall: true)
        capture.tapUUID = UUID()
        do {
            try buildTap(capture, description: appTapDescription(capture), aggregateName: "Sondine app audio")
            capture.processor.updateSource(appSource(capture))
            emit(.warning("tap.rebuilt", "Rebuilt an app tap: \(reason).", trackKey: capture.processor.trackKey))
        } catch {
            destroyTap(capture)
            apps[capture.bundleId] = nil
            capture.processor.close(reason: .error)
            let now = env.clock.anchor().continuousNs
            appBackoff[capture.bundleId] = now + Self.appRetryNs
            emit(.error(.captureFailed, "Cannot rebuild an app tap: \(error).", trackKey: capture.processor.trackKey))
            reconcileResidual(now: now)
        }
    }

    // MARK: Drain

    /// Drains every app track. Its first block takes its app out of `system:other`.
    func drainAppTaps(now: UInt64) {
        // A tap handing over keeps draining (and recording) until `system:other` delivers;
        // one whose app stopped playing has nothing left to hand over.
        let playing = Set(processes.processes.filter(\.io.runningOutput).map(\.id))
        for capture in retiringApps {
            _ = capture.processor.drain()
        }
        let done = retiringApps.filter { !$0.objects.contains(where: playing.contains) }
        if !done.isEmpty {
            retiringApps.removeAll { capture in done.contains { $0 === capture } }
            for capture in done { closeAppTap(capture, reason: .tapReleased) }
        }
        guard !apps.isEmpty else { return }
        var left = false
        for capture in apps.values.sorted(by: { $0.bundleId < $1.bundleId }) {
            capture.processor.updateOutputInScope(Set(capture.objects).intersection(playing), now: now)
            let outcome = capture.processor.drain()
            noteFirstBlock(capture, outcome)
            if outcome.blocks > 0, !capture.leftResidual {
                capture.leftResidual = true
                left = true
            }
            if outcome.signal { capture.held.lastSignalNs = now }
            if outcome.firstSignal, permissions.verify(.app) { emitPermissions() }
            if case .rebuild(let reason) = outcome.action {
                rebuildAppIO(capture, reason: reason)
            } else if case .rebuild(let reason) = capture.processor.checkStall(now: now) {
                rebuildAppIO(capture, reason: reason)
            }
        }
        if left {
            updateSystemExclusions()
            publishProcessesIfChanged()
            scheduleActivity()
        }
    }

    /// The time from asking for a tap to its first block (`tap-start`, health).
    func noteFirstBlock(_ capture: TapCapture, _ outcome: DrainOutcome) {
        guard let requested = capture.requestedNs, let ticks = outcome.firstHostTicks else { return }
        capture.requestedNs = nil
        let first = env.clock.continuousNanoseconds(forHostTicks: ticks)
        tapStartCost.record(first > requested ? first - requested : 0)
    }

    // MARK: Call-follow

    /// The microphone follows the input device of a call (`followCalls`), and keeps it
    /// `callFollowHoldSeconds` after the call ends: a call on a headset records the headset's
    /// microphone, already in call mode, rather than the Mac's across the room.
    func updateCallFollow(now: UInt64) {
        let wanted = config?.microphone.followCalls == true ? calls.active.keys.sorted().lazy.compactMap(callInput).first : nil
        var next = callFollow
        if let wanted {
            next = (wanted, nil)
        } else if let current = callFollow {
            let until = current.untilNs ?? now + UInt64(options.callFollowHoldSeconds * 1e9)
            next = now >= until ? nil : (current.uid, until)
        }
        guard next?.uid != callFollow?.uid || next?.untilNs != callFollow?.untilNs else { return }
        let moved = next?.uid != callFollow?.uid
        callFollow = next
        if moved { reconcileMicrophone(reason: .deviceChanged) }
    }

    /// The microphone a call reads now, read from its processes: the first device the
    /// microphone may follow (a headset joined mid-call counts, an echo reference never).
    private func callInput(_ bundleId: String) -> String? {
        processes.processes.lazy
            .filter { $0.io.runningInput && $0.resolution.app?.bundleId == bundleId }
            .flatMap(\.io.inputDevices)
            .compactMap { self.devices.device($0) }
            .first(where: MicrophonePolicy.canFollow)?.uid
    }
}
