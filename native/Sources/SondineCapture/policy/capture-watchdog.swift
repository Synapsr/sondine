/// Watches one track's IO for exact-zero stalls and rate mismatches (architecture §3, ADR 004).
///
/// - Zero stall (taps): 15 s of exact zeros while output runs in the tap's scope that the tap
///   has not heard: nothing since the latest output start of a process still playing → rebuild.
///   Apps keep their output open in silence after a sound (Chromium apps for about 30 s), so
///   zeros after a signal are not a stall. Within 30 s after a route or rate change, zeros count
///   with a 3 s threshold until the tap hears something. Rebuilds are rate limited to one per
///   5 min for each open track; a stall inside that window is reported as `zero-suspect`
///   instead, which clears on signal or once no output runs in scope.
/// - After a rate or format change (taps and microphones): the resampler is rebuilt first; the
///   device or tap is rebuilt only if exact zeros (3 s) or a measured-rate mismatch above 1 %
///   follow within 5 s.
/// - No IO (taps and microphones): no IO cycle for 5 s → restart, then again after a wait that
///   doubles while the IO stays silent, up to 5 min. A device can stop calling back for good:
///   the built-in microphone did when AirPods connected (2026-11-09), and gave nothing for
///   1 h 38 until Sondine restarted.
///
/// Times are seconds on one monotonic clock (continuous time).
public struct CaptureWatchdog: Sendable, Equatable {
    public struct Settings: Sendable, Equatable {
        public var zeroStallSeconds = 15.0
        public var postEventZeroSeconds = 3.0
        public var postEventWindowSeconds = 30.0
        public var rateCheckWindowSeconds = 5.0
        public var rebuildIntervalSeconds = 300.0
        /// No IO cycle this long restarts the IO.
        public var ioStallSeconds = 5.0
        /// A signal this long before an output start still counts as hearing it: the HAL can
        /// report the start a drain after the first samples.
        public var outputStartGraceSeconds = 0.5
        /// Off for microphones: exact zeros there mean a mute, not a stall.
        public var watchesZeroStalls = true

        public init() {}

        public static let microphone: Settings = {
            var settings = Settings()
            settings.watchesZeroStalls = false
            return settings
        }()
    }

    public enum Action: Sendable, Equatable {
        case none
        case rebuild(reason: String)
        case reportSuspect
        case clearSuspect
    }

    public let settings: Settings
    public private(set) var zeroSeconds = 0.0
    public private(set) var suspect = false
    public private(set) var lastRebuild: Double?
    private var lastEvent: Double?
    private var rateCheckUntil: Double?
    private var lastSignal: Double?
    /// The latest output start among the processes in scope still running output.
    public var latestOutputStart: Double?
    /// Restarts for no IO since the last block, and when the latest was.
    public private(set) var ioRestarts = 0
    private var lastIORestart: Double?

    public init(settings: Settings = Settings()) {
        self.settings = settings
    }

    /// A route change: zeros right after it rebuild sooner.
    public mutating func noteEvent(at now: Double) {
        lastEvent = now
    }

    /// A rate or format change: arms the follow-up check.
    public mutating func noteRateChange(at now: Double) {
        lastEvent = now
        rateCheckUntil = now + settings.rateCheckWindowSeconds
    }

    /// The IO was restarted (a rebuild): counting starts over and a stall is reported again; the
    /// rate limit stays. After a stall the new tap must prove itself with a signal; after a
    /// rebuild for another reason, what the old tap heard still counts.
    public mutating func reset(keepingSignal: Bool = false) {
        zeroSeconds = 0
        rateCheckUntil = nil
        suspect = false
        if !keepingSignal { lastSignal = nil }
    }

    /// Nothing plays in scope any more, so silence proves nothing: returns true when that
    /// cleared a suspicion.
    public mutating func clearSuspect() -> Bool {
        guard suspect else { return false }
        suspect = false
        return true
    }

    /// One drained block of `seconds` of audio.
    public mutating func observe(
        allZero: Bool,
        seconds: Double,
        outputActiveInScope: Bool,
        rateMismatch: Bool,
        at now: Double
    ) -> Action {
        ioRestarts = 0
        lastIORestart = nil
        if !allZero {
            lastSignal = now
            zeroSeconds = 0
            if let until = rateCheckUntil, now <= until, rateMismatch {
                return rebuild("measured rate differs from the nominal rate by more than 1 %", at: now)
            }
            if let until = rateCheckUntil, now > until { rateCheckUntil = nil }
            if suspect {
                suspect = false
                return .clearSuspect
            }
            return .none
        }

        let checkingRate = rateCheckUntil.map { now <= $0 } ?? false
        if let until = rateCheckUntil, now > until { rateCheckUntil = nil }
        let recentEvent = lastEvent.map { now - $0 <= settings.postEventWindowSeconds } ?? false
        // A tap is silent whenever nothing plays, and after a sound while its app keeps output
        // open, so its zeros count only while output runs that it has not heard; a microphone is
        // never exactly silent unless muted, so its zeros count after a rate change.
        let watching: Bool
        if settings.watchesZeroStalls {
            let unheardStart = !heard(since: latestOutputStart.map { $0 - settings.outputStartGraceSeconds })
            let unheardChange = (recentEvent || checkingRate) && !heard(since: lastEvent)
            watching = outputActiveInScope && (unheardStart || unheardChange)
        } else {
            watching = checkingRate
        }
        guard watching else {
            zeroSeconds = 0
            return .none
        }
        zeroSeconds += seconds
        let threshold = checkingRate || recentEvent ? settings.postEventZeroSeconds : settings.zeroStallSeconds
        guard zeroSeconds >= threshold else { return .none }
        return rebuild(checkingRate ? "exact zeros after a rate change" : "exact zeros while output is running", at: now)
    }

    /// No IO cycle for `seconds`: restart once `ioStallSeconds` have passed, then after a wait that
    /// doubles with each restart the IO did not answer, up to `rebuildIntervalSeconds`.
    public mutating func observeNoIO(seconds: Double, at now: Double) -> Action {
        guard seconds >= settings.ioStallSeconds else { return .none }
        if let lastIORestart {
            let wait = min(settings.rebuildIntervalSeconds, settings.ioStallSeconds * Double(1 << min(ioRestarts, 16)))
            guard now - lastIORestart >= wait else { return .none }
        }
        ioRestarts += 1
        lastIORestart = now
        return .rebuild(reason: "no IO for \(Int(seconds)) s")
    }

    private func heard(since time: Double?) -> Bool {
        guard let lastSignal else { return false }
        return time.map { lastSignal >= $0 } ?? true
    }

    private mutating func rebuild(_ reason: String, at now: Double) -> Action {
        zeroSeconds = 0
        rateCheckUntil = nil
        if let lastRebuild, now - lastRebuild < settings.rebuildIntervalSeconds {
            guard !suspect else { return .none }
            suspect = true
            return .reportSuspect
        }
        lastRebuild = now
        return .rebuild(reason: reason)
    }
}
