import Dispatch
import Foundation
import SondineKit

/// Private zones in the engine (ADR 029): what the Mac's situation is, the facts zones hold on,
/// and the holds they make. Queue-confined.
struct ZoneState {
    var screenAway = false
    /// When the screen went away, as seen.
    var screenAwaySince: ClockAnchor?
    /// The networks the Mac is on, as SystemConfiguration says them: memory only, never logged.
    var signatures: [NetworkSignature] = []
    /// Their keyed hashes, IPv4 first, unique, at most 8; empty without a key.
    var networks: [String] = []
    /// Calls (`calls`) and excluded apps in a call or listening (`app:<bundleId>`), each until
    /// `holdAfterCallSeconds` after it ends.
    var facts = LingeringFacts()
    /// The networks the Mac is on (`network:<hash>`), each until `networkLingerSeconds` after it
    /// is gone, whatever the zones say, so a zone turned on knows when the Mac joined.
    var networkFacts = LingeringFacts()
    var tracker = HoldTracker()
    var heldMicrophone = false
    var heldEverything = false
    var lastSituation: SituationEvent?
    var lastHolds: [HoldOccurrence] = []
    /// Continuous time when a lingering fact ends.
    var nextDeadlineNs: UInt64?
    /// Wall time when a schedule window starts or ends.
    var nextBoundaryWallNs: UInt64?
    /// The windows on, valid from `fromWallNs` until the next boundary for these windows in this
    /// time zone: the calendar is read again only at a boundary, a clock or time zone change, or
    /// a config.
    var schedule: (windows: [CaptureConfig.ScheduleWindow], timeZone: TimeZone, fromWallNs: UInt64, active: [HoldSchedule.Instance])?
    var boundaryTimer: DispatchSourceTimer?
    var boundaryTimerWallNs: UInt64?
}

extension CaptureEngine {
    static let networkFactPrefix = "network:"
    static let appFactPrefix = "app:"
    static let callsFact = "calls"

    /// Capture the user's pause or a hold keeps closed.
    var microphoneBlocked: Bool { paused.microphone || zones.heldMicrophone }
    var systemBlocked: Bool { paused.systemAudio || zones.heldEverything }

    // MARK: Situation

    /// Starts watching the screen, the networks and the wall clock. Changes are timed when seen,
    /// not when the engine queue gets to them: a hold drops what was captured after its trigger.
    func startSituation() {
        let now = env.clock.anchor()
        if env.screen.watchScreen(handler: { [weak self] away in
            guard let self else { return }
            let at = self.env.clock.anchor()
            self.queue.async { self.screenChanged(away, at: at) }
        }) {
            zones.screenAway = true
            zones.screenAwaySince = now
        }
        zones.signatures = env.networks.start { [weak self] signatures in
            guard let self else { return }
            let at = self.env.clock.anchor()
            self.queue.async { self.networksChanged(signatures, at: at) }
        }
        rehashNetworks()
        env.wallClock.start { [weak self] in
            guard let self else { return }
            self.queue.async { self.wallClockChanged() }
        }
        zones.lastSituation = situationEvent()
    }

    func stopSituation() {
        env.screen.stopWatchingScreen()
        env.networks.stop()
        env.wallClock.stop()
        zones.boundaryTimer?.cancel()
        zones.boundaryTimer = nil
        zones.boundaryTimerWallNs = nil
    }

    func screenChanged(_ away: Bool, at: ClockAnchor) {
        guard !stopped, away != zones.screenAway else { return }
        zones.screenAway = away
        zones.screenAwaySince = away ? at : nil
        publishSituationIfChanged()
        updateHolds()
    }

    func networksChanged(_ signatures: [NetworkSignature], at: ClockAnchor) {
        guard !stopped else { return }
        zones.signatures = signatures
        guard rehashNetworks() else { return }
        publishSituationIfChanged()
        updateHolds(observedAt: at)
    }

    private func wallClockChanged() {
        guard !stopped else { return }
        zones.boundaryTimerWallNs = nil
        zones.schedule = nil
        updateHolds()
    }

    /// Hashes the signatures with the config's key: IPv4 first, unique, at most 8. Returns
    /// whether the hashes changed.
    @discardableResult
    func rehashNetworks() -> Bool {
        var hashes: [String] = []
        if let key = config?.holds.networkKeyBytes, key.count == 32 {
            for signature in zones.signatures where hashes.count < 8 {
                let hash = NetworkHashing.hash(signature: signature.raw, key: key)
                if !hashes.contains(hash) { hashes.append(hash) }
            }
        }
        guard hashes != zones.networks else { return false }
        zones.networks = hashes
        return true
    }

    func situationEvent(replyTo: String? = nil) -> SituationEvent {
        SituationEvent(replyTo: replyTo, screenAway: zones.screenAway, networks: zones.networks.sorted())
    }

    func publishSituationIfChanged() {
        let event = situationEvent()
        guard event != zones.lastSituation else { return }
        zones.lastSituation = event
        emit(.situation(event))
    }

    // MARK: Holds

    /// Decides the holds again from the facts and the zones, says it when they change, and
    /// applies them: a hold starting stops what it covers and drops what it captured after its
    /// trigger and did not commit; a hold ending lets capture open again if nothing else keeps it
    /// closed. Asleep, in another user's session, or before the first config, the holds stay as
    /// they are: sleep and wake end no occurrence. `configChanged`: a zone turned on or a lift
    /// withdrawn holds from now, not from its trigger's start.
    func updateHolds(observedAt: ClockAnchor? = nil, configChanged: Bool = false) {
        guard let config, captureAllowed else { return }
        let now = env.clock.anchor()
        let lingerNs = UInt64(options.holdAfterCallSeconds * 1e9)
        let networkLingerNs = UInt64(options.networkLingerSeconds * 1e9)

        let users = microphoneUsers()
        var present = Set(users.excludedApps.map { Self.appFactPrefix + $0 })
        if users.anyCall { present.insert(Self.callsFact) }
        zones.facts.update(present: present, at: now, lingerNs: lingerNs)
        let onNetworks = Set(zones.networks.map { Self.networkFactPrefix + $0 })
        zones.networkFacts.update(present: onNetworks, at: observedAt ?? now, lingerNs: networkLingerNs)

        var triggers: [HoldTracker.Trigger] = []
        let excluded = Set(config.excludedBundleIds)
        for (key, fact) in zones.facts.facts {
            if key == Self.callsFact {
                guard config.holds.calls else { continue }
                triggers.append(.init(key: key, reason: .calls, since: fact.since, sinceWallMs: fact.sinceWallMs))
            } else if key.hasPrefix(Self.appFactPrefix) {
                let bundleId = String(key.dropFirst(Self.appFactPrefix.count))
                guard excluded.contains(bundleId) else { continue }
                triggers.append(.init(key: key, reason: .app, bundleId: bundleId, since: fact.since, sinceWallMs: fact.sinceWallMs))
            }
        }
        if config.holds.screen, zones.screenAway, let since = zones.screenAwaySince {
            triggers.append(.init(
                key: "screen", reason: .screen, since: ClockPoint(hostTicks: since.hostTicks, continuousNs: since.continuousNs),
                sinceWallMs: Int64(since.wallNs / 1_000_000)
            ))
        }
        let zoneNetworks = Set(config.holds.networks)
        for (key, fact) in zones.networkFacts.facts {
            let hash = String(key.dropFirst(Self.networkFactPrefix.count))
            guard zoneNetworks.contains(hash) else { continue }
            triggers.append(.init(key: key, reason: .network, network: hash, since: fact.since, sinceWallMs: fact.sinceWallMs))
        }
        for instance in activeWindows(config.holds.schedule, now: now) {
            let startWallNs = UInt64(max(0, instance.start.timeIntervalSince1970) * 1e9)
            triggers.append(.init(
                key: "schedule:" + instance.occurrenceId, reason: .schedule, window: instance.window,
                since: Self.clockPoint(wallNs: startWallNs, now: now, timebase: env.clock.timebase),
                sinceWallMs: Int64(startWallNs / 1_000_000), occurrenceId: instance.occurrenceId
            ))
        }
        zones.nextDeadlineNs = [zones.facts.nextEnd(lingerNs: lingerNs), zones.networkFacts.nextEnd(lingerNs: networkLingerNs)]
            .compactMap { $0 }.min()
        scheduleBoundaryTimer()

        let started = zones.tracker.update(triggers.sorted { $0.key < $1.key }) { UUID().uuidString.lowercased() }
        let lifted = Set(config.holds.lifted)
        let held = zones.tracker.held(lifted: lifted)
        let wire = zones.tracker.wire(lifted: lifted)
        if wire != zones.lastHolds {
            zones.lastHolds = wire
            emit(.holds(HoldsEvent(holds: wire)))
        }

        // From when to drop what a newly held track captured: its trigger's start, or now when
        // a zone or a lift changed (the audio before was allowed).
        let cut = { (scope: HoldScope?) -> UInt64 in
            guard !configChanged else { return now.continuousNs }
            let starts = started.filter { !lifted.contains($0.id) && (scope == nil || $0.trigger.scope == scope) }
                .map(\.trigger.since.continuousNs.value)
            return min(starts.min() ?? now.continuousNs, now.continuousNs)
        }
        let wasMicrophone = zones.heldMicrophone
        let wasEverything = zones.heldEverything
        zones.heldMicrophone = held.microphone
        zones.heldEverything = held.everything
        if held.everything && !wasEverything { holdSystemAudio(cutNs: cut(.all)) }
        if held.microphone && !wasMicrophone { holdMicrophone(cutNs: cut(nil)) }
        if !held.microphone && wasMicrophone { reconcileMicrophone(reason: .held) }
        if !held.everything && wasEverything { reconcileSystem(reason: .held) }
    }

    /// The schedule windows on now, from the calendar only when something may have changed.
    private func activeWindows(_ windows: [CaptureConfig.ScheduleWindow], now: ClockAnchor) -> [HoldSchedule.Instance] {
        let timeZone = env.wallClock.timeZone
        if let cached = zones.schedule, cached.windows == windows, cached.timeZone == timeZone, now.wallNs >= cached.fromWallNs,
           zones.nextBoundaryWallNs.map({ now.wallNs < $0 }) ?? true {
            return cached.active
        }
        let schedule = HoldSchedule(windows: windows, timeZone: timeZone)
        let wallNow = Date(timeIntervalSince1970: Double(now.wallNs) / 1e9)
        let active = schedule.active(at: wallNow)
        zones.nextBoundaryWallNs = schedule.nextBoundary(after: wallNow).map { UInt64(max(0, $0.timeIntervalSince1970) * 1e9) }
        zones.schedule = (windows, timeZone, now.wallNs, active)
        return active
    }

    /// A drain is due after a schedule boundary or a lingering hold's end: decide first, so what
    /// the drain reads is already cut.
    func updateHoldsIfDue(_ now: ClockAnchor) {
        if let due = zones.nextDeadlineNs, now.continuousNs >= due {
            updateHolds()
        } else if let boundary = zones.nextBoundaryWallNs, now.wallNs >= boundary {
            updateHolds()
        }
    }

    /// After a wake the network takes a while to come back: its holds wait for it.
    func extendNetworkHoldsAfterWake() {
        let now = env.clock.anchor().continuousNs
        zones.networkFacts.extend(
            prefix: Self.networkFactPrefix, untilNs: now + UInt64(options.networkWakeGraceSeconds * 1e9),
            lingerNs: UInt64(options.networkLingerSeconds * 1e9)
        )
    }

    /// Whether any call is going on (an excluded app's included), and the excluded apps in a call
    /// or listening to a microphone: what would be a `call` or `listen` span were they not
    /// excluded. Unlike `updateCalls`, this does not depend on the user's pause.
    func microphoneUsers() -> (anyCall: Bool, excludedApps: Set<String>) {
        let all = (processes?.processes ?? []).filter { exclusion(for: $0) != .own }
        let appsWithOutput = Set(all.filter(\.io.runningOutput).compactMap { $0.resolution.app?.bundleId })
        var anyCall = false
        var apps: Set<String> = []
        for process in all where process.io.runningInput {
            if let call = CallPolicy.source(of: process, appsWithOutput: appsWithOutput), WireText.isBundleId(call.bundleId) { anyCall = true }
            guard exclusion(for: process) == .user, process.resolution.daemonRole != .systemSound, let bundleId = excludedBundleId(of: process) else { continue }
            apps.insert(bundleId)
        }
        return (anyCall, apps)
    }

    /// The bundle id in `excludedBundleIds` a process is excluded by.
    private func excludedBundleId(of process: CatalogProcess) -> String? {
        let excluded = Set(config?.excludedBundleIds ?? [])
        if let bundle = process.resolution.app?.bundleId, excluded.contains(bundle) { return bundle }
        if let bundle = process.info.bundleID, excluded.contains(bundle) { return bundle }
        return nil
    }

    /// A hold starts on the microphone: it stops as a pause stops it (muted; stopped for
    /// Bluetooth), and what it captured from `cutNs` on and did not commit is dropped.
    func holdMicrophone(cutNs: UInt64) {
        muteMicrophone(reason: .held, cutNs: cutNs)
    }

    /// A hold starts on everything: every tap stops, without handing anything back to
    /// `system:other`, and what they captured from `cutNs` on and did not commit is dropped.
    func holdSystemAudio(cutNs: UInt64) {
        stopAppTaps(reason: .held, cutNs: cutNs)
        stopSystem(reason: .held, cutNs: cutNs)
    }

    /// One wall-clock timer to the next schedule boundary; the drain checks too, so a boundary
    /// is cut where it is even when the timer fires late.
    private func scheduleBoundaryTimer() {
        guard options.timers else { return }
        guard let wallNs = zones.nextBoundaryWallNs else {
            zones.boundaryTimer?.cancel()
            zones.boundaryTimer = nil
            zones.boundaryTimerWallNs = nil
            return
        }
        guard wallNs != zones.boundaryTimerWallNs else { return }
        let timer = zones.boundaryTimer ?? {
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.setEventHandler { [weak self] in
                guard let self else { return }
                self.zones.boundaryTimerWallNs = nil
                self.updateHolds()
            }
            timer.resume()
            return timer
        }()
        zones.boundaryTimer = timer
        zones.boundaryTimerWallNs = wallNs
        let deadline = DispatchWallTime(timespec: timespec(tv_sec: Int(wallNs / 1_000_000_000), tv_nsec: Int(wallNs % 1_000_000_000)))
        timer.schedule(wallDeadline: deadline, repeating: .never, leeway: .milliseconds(100))
    }

    /// The helper's clocks at a wall time in the past, read back from `now`.
    static func clockPoint(wallNs: UInt64, now: ClockAnchor, timebase: HostTimebase) -> ClockPoint {
        let back = now.wallNs > wallNs ? now.wallNs - wallNs : 0
        let ticks = timebase.ticks(fromNanoseconds: back)
        return ClockPoint(
            hostTicks: now.hostTicks > ticks ? now.hostTicks - ticks : 0,
            continuousNs: now.continuousNs > back ? now.continuousNs - back : 0
        )
    }
}
