import Darwin
import Foundation
import SondineKit

// State events the engine publishes on change and replays in snapshots.
extension CaptureEngine {
    func readyEvent(replyTo id: String) -> ReadyEvent {
        ReadyEvent(
            replyTo: id,
            protocolVersion: HelperProtocol.version,
            sessionId: sessionId.uuidString.lowercased(),
            helper: VersionPair(version: options.helperVersion, build: options.helperBuild),
            os: Self.operatingSystem,
            timebase: WireTimebase(env.clock.timebase),
            paused: paused,
            capabilities: ReadyEvent.Capabilities(
                appTaps: true,
                maxAppTaps: 8,
                vad: ReadyEvent.Capabilities.Vad(engine: env.vad.engine, version: env.vad.version)
            )
        )
    }

    static let operatingSystem: VersionPair = {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        let text = "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
        var size = 0
        sysctlbyname("kern.osversion", nil, &size, nil, 0)
        var buffer = [CChar](repeating: 0, count: max(size, 1))
        sysctlbyname("kern.osversion", &buffer, &size, nil, 0)
        let build = String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
        return VersionPair(version: text, build: WireText.isVersion(build) ? build : "unknown")
    }()

    func devicesEvent() -> DevicesEvent {
        let entries = devices.devices.prefix(256).compactMap { device -> AudioDeviceEntry? in
            guard WireText.isPlainText(device.uid, maxUnits: 512) else { return nil }
            let dataSource = device.hasOutput && !device.hasInput ? device.info.outputDataSource : device.info.inputDataSource ?? device.info.outputDataSource
            return AudioDeviceEntry(
                uid: device.uid,
                name: Self.shortText(device.info.name, fallback: device.uid),
                transport: device.transport,
                transportCode: device.info.transportCode == 0 ? nil : fourCharText(device.info.transportCode),
                input: device.hasInput,
                output: device.hasOutput,
                alive: device.info.alive,
                nominalRate: device.info.nominalRate.flatMap { $0 > 0 && $0 <= 768_000 ? $0 : nil },
                dataSource: dataSource.flatMap(fourCharText),
                loopback: device.loopback
            )
        }
        return DevicesEvent(
            defaultInputUid: devices.defaultInputDevice?.uid,
            defaultOutputUid: devices.defaultOutputDevice?.uid,
            devices: entries
        )
    }

    func processesEvent() -> ProcessesEvent {
        let entries = processes.processes.prefix(1_024).map { process -> AudioProcessEntry in
            let resolution = process.resolution
            let app = resolution.app.flatMap { app -> AppIdentity? in
                guard WireText.isBundleId(app.bundleId) else { return nil }
                return AppIdentity(bundleId: app.bundleId, name: app.name.flatMap { WireText.sanitized($0, maxUnits: 256) })
            }
            let mapping = app == nil ? nil : resolution.evidence.map { evidence in
                ProcessMapping(evidence: evidence, confidence: resolution.confidence ?? .medium, viaTerminal: resolution.viaTerminal)
            }
            let excluded = exclusion(for: process)
            let track = excluded != nil ? nil : appTrackKey(of: process.id) ?? TrackKeys.system
            return AudioProcessEntry(
                objectId: process.id,
                pid: process.pid,
                startWallNs: resolution.startWallNs.flatMap { $0 <= UInt64(Int64.max) ? ClockValue($0) : nil },
                halBundleId: process.info.bundleID.flatMap { WireText.isBundleId($0) ? $0 : nil },
                app: mapping == nil ? nil : app,
                mapping: mapping,
                trackKey: track,
                excluded: excluded
            )
        }
        return ProcessesEvent(processes: Array(entries))
    }

    func activityEvent() -> ActivityEvent {
        let anchor = env.clock.anchor()
        let running = processes.processes.filter { $0.io.runningInput || $0.io.runningOutput }.prefix(1_024).map { process in
            RunningProcess(
                objectId: process.id,
                output: process.io.runningOutput,
                input: process.io.runningInput,
                inputDeviceUids: process.io.runningInput
                    ? Array(process.io.inputDevices.compactMap { devices.device($0)?.uid }.filter { WireText.isPlainText($0, maxUnits: 512) }.prefix(16))
                    : []
            )
        }
        var attribution: [TrackAttribution] = []
        if let runId = system?.processor.runId {
            let label = AttributionPolicy.systemLabel(scope: residualScope)
            let bundleId = label.bundleId.flatMap { WireText.isBundleId($0) ? $0 : nil }
            attribution.append(TrackAttribution(
                trackKey: TrackKeys.system,
                runId: runId.uuidString.lowercased(),
                confidence: label.confidence,
                bundleId: bundleId,
                candidateObjectIds: Array(label.candidates.prefix(1_024))
            ))
        }
        for capture in apps.values.sorted(by: { $0.bundleId < $1.bundleId }) {
            guard let runId = capture.processor.runId else { continue }
            let playing = Set(processes.processes.filter(\.io.runningOutput).map(\.id))
            attribution.append(TrackAttribution(
                trackKey: capture.processor.trackKey,
                runId: runId.uuidString.lowercased(),
                confidence: .exact,
                bundleId: capture.bundleId,
                candidateObjectIds: Array(capture.objects.filter(playing.contains).prefix(1_024))
            ))
        }
        return ActivityEvent(at: ClockPoint(hostTicks: anchor.hostTicks, continuousNs: anchor.continuousNs), running: Array(running), attribution: attribution)
    }

    func publishDevicesIfChanged() {
        let event = devicesEvent()
        guard event != lastDevices else { return }
        lastDevices = event
        emit(.devices(event))
    }

    func publishProcessesIfChanged() {
        let event = processesEvent()
        guard event != lastProcesses else { return }
        lastProcesses = event
        emit(.processes(event))
    }

    /// `activity` goes out on change, debounced, so a burst of IO listeners makes one event.
    func scheduleActivity() {
        guard !activityScheduled else { return }
        activityScheduled = true
        let delay = DispatchTimeInterval.milliseconds(Int(options.activityDebounceSeconds * 1_000))
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self else { return }
            self.activityScheduled = false
            guard !self.stopped else { return }
            let event = self.activityEvent()
            if let last = self.lastActivity, last.running == event.running, last.attribution == event.attribution { return }
            self.lastActivity = event
            self.emit(.activity(event))
        }
    }

    func emitPermissions(replyTo: String? = nil) {
        emit(.permissions(PermissionsEvent(replyTo: replyTo, microphone: permissions.microphone, systemAudio: permissions.systemAudio)))
    }

    func emitClock(reason: ClockReason, replyTo: String? = nil) {
        emit(.clock(ClockEvent(replyTo: replyTo, reason: reason, anchor: WireClockAnchor(env.clock.anchor()))))
    }

    func healthTick() {
        guard started, !stopped else { return }
        if permissions.refresh(microphone: env.permissions.microphone(), systemAudio: env.permissions.systemAudio()) {
            emitPermissions()
            // A revocation ends the runs; access given back starts them again.
            reconcile(reason: .permission)
        }
        let anchor = env.clock.anchor()
        let windowMs = max(1, min(3_600_000, Int64((anchor.continuousNs &- healthWindowStartNs) / 1_000_000)))
        healthWindowStartNs = anchor.continuousNs
        var tracks: [TrackHealth] = []
        var stages: [StageHistogram] = []
        for processor in processors {
            let health = processor.takeHealth()
            if let track = health.track { tracks.append(track) }
            stages += health.stages
        }
        if tapStartCost.count > 0 { stages.append(tapStartCost.wire(stage: .tapStart, trackKey: nil)) }
        tapStartCost = StageHistogramAccumulator()
        emit(.health(HealthEvent(
            at: ClockPoint(hostTicks: anchor.hostTicks, continuousNs: anchor.continuousNs),
            windowMs: windowMs,
            process: metrics.take(),
            tracks: tracks,
            stages: stages
        )))
    }
}

extension DevicesEvent {
    func with(replyTo id: String) -> DevicesEvent {
        var copy = self
        copy.replyTo = id
        return copy
    }
}

extension ProcessesEvent {
    func with(replyTo id: String) -> ProcessesEvent {
        var copy = self
        copy.replyTo = id
        return copy
    }
}

extension ActivityEvent {
    func with(replyTo id: String) -> ActivityEvent {
        var copy = self
        copy.replyTo = id
        return copy
    }
}
