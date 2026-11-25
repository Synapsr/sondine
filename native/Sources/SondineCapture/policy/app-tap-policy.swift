/// Which apps get their own tap (ADR 026). Every app playing sound in system audio's scope gets
/// one, calls first, up to the cap; `system:other` keeps what is left (processes with no app, apps
/// over the cap, apps released for silence) and runs only while something in its scope plays.
/// Pure: the engine reads the process catalog and its taps, and applies the plan.
public enum AppTapPolicy {
    public struct Settings: Sendable, Equatable {
        public var max: Int
        /// An app's tap ends once none of its process objects ran output for this long.
        public var releaseAfterIdleNs: UInt64
        /// An app whose track heard only exact zeros this long goes back to `system:other`.
        public var releaseAfterSilenceNs: UInt64
        /// A call app keeps its tap this long after its call ends.
        public var callHoldNs: UInt64

        public init(max: Int = 8, releaseAfterIdleNs: UInt64 = 30_000_000_000, releaseAfterSilenceNs: UInt64 = 120_000_000_000, callHoldNs: UInt64 = 10_000_000_000) {
            self.max = max
            self.releaseAfterIdleNs = releaseAfterIdleNs
            self.releaseAfterSilenceNs = releaseAfterSilenceNs
            self.callHoldNs = callHoldNs
        }
    }

    /// One app in system audio's scope: every process object resolved to it.
    public struct App: Sendable, Equatable {
        public var bundleId: String
        public var name: String?
        public var objects: [HALObjectID]
        public var outputRunning: Bool
        /// When its output started running (none: not running), for the order of the slots.
        public var outputSinceNs: UInt64?

        public init(bundleId: String, name: String?, objects: [HALObjectID], outputRunning: Bool, outputSinceNs: UInt64?) {
            self.bundleId = bundleId
            self.name = name
            self.objects = objects
            self.outputRunning = outputRunning
            self.outputSinceNs = outputSinceNs
        }
    }

    /// A tap the engine holds.
    public struct Held: Sendable, Equatable {
        public var bundleId: String
        public var startedNs: UInt64
        /// The last instant one of its objects ran output.
        public var lastOutputNs: UInt64
        /// The last instant its track delivered a non-zero sample.
        public var lastSignalNs: UInt64?
        /// The last instant its app was in a call.
        public var lastCallNs: UInt64?

        public init(bundleId: String, startedNs: UInt64, lastOutputNs: UInt64, lastSignalNs: UInt64? = nil, lastCallNs: UInt64? = nil) {
            self.bundleId = bundleId
            self.startedNs = startedNs
            self.lastOutputNs = lastOutputNs
            self.lastSignalNs = lastSignalNs
            self.lastCallNs = lastCallNs
        }
    }

    public struct Tap: Sendable, Equatable {
        public var bundleId: String
        public var name: String?
        public var objects: [HALObjectID]
    }

    public struct Plan: Sendable, Equatable {
        /// The taps to hold, in slot order.
        public var taps: [Tap] = []
        /// Held taps released for silence: their app goes back to `system:other` and is not
        /// tapped again until its output stops and starts again.
        public var silenced: Set<String> = []
    }

    /// - Parameters:
    ///   - apps: the apps in scope (Sondine's own, excluded apps and system sounds left out).
    ///   - calls: apps in a call now.
    ///   - quiet: apps released for silence whose output has not stopped since (a call still
    ///     gets its tap).
    ///   - waiting: apps whose tap failed to start, until another try.
    public static func plan(
        apps: [App], calls: Set<String>, held: [Held], quiet: Set<String>, waiting: Set<String> = [], now: UInt64, settings: Settings
    ) -> Plan {
        var plan = Plan()
        guard settings.max > 0 else { return plan }
        let byBundle = Dictionary(apps.map { ($0.bundleId, $0) }, uniquingKeysWith: { first, _ in first })
        func inCall(_ bundleId: String, _ held: Held?) -> Bool {
            if calls.contains(bundleId) { return true }
            guard let last = held?.lastCallNs else { return false }
            return now &- last < settings.callHoldNs
        }

        // Held taps first: an app keeps its slot (and its track) until it stops playing.
        var kept: [(tap: Tap, call: Bool)] = []
        for tap in held.sorted(by: { ($0.startedNs, $0.bundleId) < ($1.startedNs, $1.bundleId) }) {
            guard let app = byBundle[tap.bundleId] else { continue }
            let call = inCall(tap.bundleId, tap)
            if !call {
                if !app.outputRunning, now &- tap.lastOutputNs >= settings.releaseAfterIdleNs { continue }
                let heard = max(tap.startedNs, tap.lastSignalNs ?? 0)
                if now &- heard >= settings.releaseAfterSilenceNs {
                    if app.outputRunning { plan.silenced.insert(tap.bundleId) }
                    continue
                }
            }
            kept.append((Tap(bundleId: app.bundleId, name: app.name, objects: app.objects), call))
        }
        // A lower cap: calls keep theirs, then the earliest taps.
        if kept.count > settings.max {
            kept = Array((kept.filter(\.call) + kept.filter { !$0.call }).prefix(settings.max))
        }

        // Then the apps that start playing (or join a call), calls first, earliest output first.
        let holding = Set(held.map(\.bundleId))
        let newcomers = apps
            .filter { app in
                let call = calls.contains(app.bundleId)
                return !holding.contains(app.bundleId) && !waiting.contains(app.bundleId)
                    && (call || (app.outputRunning && !quiet.contains(app.bundleId)))
            }
            .sorted { a, b in
                let callA = calls.contains(a.bundleId), callB = calls.contains(b.bundleId)
                if callA != callB { return callA }
                let sinceA = a.outputSinceNs ?? .max, sinceB = b.outputSinceNs ?? .max
                return sinceA != sinceB ? sinceA < sinceB : a.bundleId < b.bundleId
            }

        var slots = kept
        for app in newcomers {
            let call = calls.contains(app.bundleId)
            let tap = Tap(bundleId: app.bundleId, name: app.name, objects: app.objects)
            if slots.count < settings.max {
                slots.append((tap, call))
            } else if call, let victim = slots.lastIndex(where: { !$0.call }) {
                // A call takes the slot of the latest app that is not in a call.
                slots.remove(at: victim)
                slots.append((tap, call))
            }
        }
        plan.taps = slots.map(\.tap)
        return plan
    }
}
