import CryptoKit
import Foundation
import SondineKit

// Private zones the helper enforces itself (ADR 029): a call, the screen away, hours, a network,
// or an excluded app in a call or listening holds capture. Pure logic, so tests drive it without
// a clock or a Mac.

/// The hours of `holds.schedule` on the Mac's clock and time zone: which windows are on, and the
/// next time one starts or ends. A window that ends at or before its start crosses midnight and
/// belongs to its start day. Wall times follow the clock on the wall across DST: a time the clock
/// skips is the next one that exists, a time it reads twice is the first.
public struct HoldSchedule: Sendable {
    public struct Instance: Sendable, Equatable {
        /// Index in `holds.schedule` (the first of identical windows).
        public var window: Int
        public var start: Date
        public var end: Date
        /// Same window, same start day: the same occurrence whenever the helper looks.
        public var occurrenceId: String
    }

    private let windows: [(index: Int, window: CaptureConfig.ScheduleWindow, spec: String)]
    private let calendar: Calendar

    public init(windows: [CaptureConfig.ScheduleWindow], timeZone: TimeZone) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        self.calendar = calendar
        var seen: Set<String> = []
        var unique: [(Int, CaptureConfig.ScheduleWindow, String)] = []
        for (index, window) in windows.enumerated() {
            let spec = "\(window.days.sorted().map(String.init).joined(separator: ","))|\(window.startMinute)|\(window.endMinute)"
            guard seen.insert(spec).inserted else { continue }
            unique.append((index, window, spec))
        }
        self.windows = unique
    }

    /// The windows on at `now`.
    public func active(at now: Date) -> [Instance] {
        let today = calendar.startOfDay(for: now)
        return windows.compactMap { entry in
            // An instance lasts less than a day: it started today or yesterday.
            for offset in [0, -1] {
                guard let day = calendar.date(byAdding: .day, value: offset, to: today),
                      let instance = instance(entry, day: calendar.startOfDay(for: day)) else { continue }
                if instance.start <= now && now < instance.end { return instance }
            }
            return nil
        }
    }

    /// The next time after `now` a window starts or ends; nil without windows.
    public func nextBoundary(after now: Date) -> Date? {
        let today = calendar.startOfDay(for: now)
        var next: Date?
        for entry in windows {
            // A window on one weekday starts again at most a week later.
            for offset in -1...8 {
                guard let day = calendar.date(byAdding: .day, value: offset, to: today),
                      let instance = instance(entry, day: calendar.startOfDay(for: day)) else { continue }
                for edge in [instance.start, instance.end] where edge > now {
                    if next.map({ edge < $0 }) ?? true { next = edge }
                }
            }
        }
        return next
    }

    private func instance(_ entry: (index: Int, window: CaptureConfig.ScheduleWindow, spec: String), day: Date) -> Instance? {
        let window = entry.window
        // Calendar weekdays count from 1 (Sunday).
        guard window.days.contains(calendar.component(.weekday, from: day) - 1),
              let start = time(minute: window.startMinute, of: day) else { return nil }
        let endDay = window.endMinute <= window.startMinute ? calendar.date(byAdding: .day, value: 1, to: day).map(calendar.startOfDay) : day
        guard let endDay, let end = time(minute: window.endMinute, of: endDay), end > start else { return nil }
        let date = calendar.dateComponents([.year, .month, .day], from: day)
        let name = "schedule|\(entry.spec)|\(date.year ?? 0)-\(date.month ?? 0)-\(date.day ?? 0)"
        return Instance(window: entry.index, start: start, end: end, occurrenceId: HoldIds.stable(name))
    }

    /// `minute` past the start of a local day, as the clock on the wall reads it.
    private func time(minute: Int, of day: Date) -> Date? {
        if minute >= 1_440 { return calendar.date(byAdding: .day, value: 1, to: day).map(calendar.startOfDay) }
        return calendar.date(
            bySettingHour: minute / 60, minute: minute % 60, second: 0, of: day,
            matchingPolicy: .nextTime, repeatedTimePolicy: .first, direction: .forward
        )
    }
}

enum HoldIds {
    /// A UUID derived from `name` (SHA-256, version 8), lowercase.
    static func stable(_ name: String) -> String {
        var bytes = Array(SHA256.hash(data: Data(name.utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x80
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        let uuid = UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
        ))
        return uuid.uuidString.lowercased()
    }
}

/// Keyed hashes of networks (ADR 029): the first 16 bytes of HMAC-SHA256(key, NetworkSignature),
/// lowercase hex. A raw signature never leaves the helper's memory.
public enum NetworkHashing {
    public static func hash(signature: String, key: Data) -> String {
        let code = HMAC<SHA256>.authenticationCode(for: Data(signature.utf8), using: SymmetricKey(data: key))
        return code.prefix(16).map { String(format: "%02x", $0) }.joined()
    }
}

/// A fact that holds while it lasts and a while after (a call and 10 s, a network left for a
/// moment): each key keeps the start of its stretch until it has been gone `lingerNs`. A fact is
/// seen to end at the update that no longer finds it: updates run when what they read changes.
struct LingeringFacts: Sendable, Equatable {
    struct Fact: Sendable, Equatable {
        var since: ClockPoint
        var sinceWallMs: Int64
        /// Present at the last update.
        var present: Bool
        /// When it was last present, or seen gone.
        var lastSeenNs: UInt64
    }

    private(set) var facts: [String: Fact] = [:]

    /// `present` are the keys seen at `now`; the others stay until they have been gone `lingerNs`.
    mutating func update(present: Set<String>, at now: ClockAnchor, lingerNs: UInt64) {
        for (key, fact) in facts {
            if present.contains(key) {
                facts[key]?.present = true
                facts[key]?.lastSeenNs = max(fact.lastSeenNs, now.continuousNs)
            } else if fact.present {
                // It ended now: it lingers from here.
                facts[key]?.present = false
                facts[key]?.lastSeenNs = max(fact.lastSeenNs, now.continuousNs)
            }
        }
        for key in present where facts[key] == nil {
            facts[key] = Fact(
                since: ClockPoint(hostTicks: now.hostTicks, continuousNs: now.continuousNs),
                sinceWallMs: Int64(now.wallNs / 1_000_000), present: true, lastSeenNs: now.continuousNs
            )
        }
        facts = facts.filter { _, fact in fact.present || now.continuousNs < fact.lastSeenNs &+ lingerNs }
    }

    /// Keeps the gone keys with `prefix` on until at least `untilNs`, unless seen again (after a
    /// wake, the network takes a while to come back).
    mutating func extend(prefix: String, untilNs: UInt64, lingerNs: UInt64) {
        let floor = untilNs > lingerNs ? untilNs - lingerNs : 0
        for (key, fact) in facts where key.hasPrefix(prefix) && fact.lastSeenNs < floor {
            facts[key]?.lastSeenNs = floor
        }
    }

    /// When the next gone fact ends.
    func nextEnd(lingerNs: UInt64) -> UInt64? {
        facts.values.filter { !$0.present }.map { $0.lastSeenNs &+ lingerNs }.min()
    }
}

/// The holds the helper applies: one occurrence per trigger, from its start to its end. An
/// occurrence keeps its id while its trigger lasts; a lifted one holds nothing.
struct HoldTracker: Sendable, Equatable {
    struct Trigger: Sendable, Equatable {
        /// What identifies the trigger: `calls`, `screen`, `app:<bundleId>`, `network:<hash>`,
        /// `schedule:<id>`.
        var key: String
        var reason: HoldReason
        var bundleId: String?
        var network: String?
        var window: Int?
        var since: ClockPoint
        var sinceWallMs: Int64
        /// A fixed id (a schedule window's instance); else a new one per occurrence.
        var occurrenceId: String?

        var scope: HoldScope { reason == .app ? .microphone : .all }
    }

    struct Occurrence: Sendable, Equatable {
        var id: String
        var trigger: Trigger
    }

    private(set) var occurrences: [String: Occurrence] = [:]

    /// Moves to `triggers`: a trigger already held keeps its occurrence, a new one starts one,
    /// and one gone ends it. Returns the occurrences that started.
    @discardableResult
    mutating func update(_ triggers: [Trigger], newId: () -> String) -> [Occurrence] {
        var next: [String: Occurrence] = [:]
        var started: [Occurrence] = []
        for trigger in triggers where next[trigger.key] == nil {
            if var occurrence = occurrences[trigger.key] {
                // Its details may move (a window's index); its start and id stay.
                occurrence.trigger.bundleId = trigger.bundleId
                occurrence.trigger.network = trigger.network
                occurrence.trigger.window = trigger.window
                next[trigger.key] = occurrence
            } else {
                let occurrence = Occurrence(id: trigger.occurrenceId ?? newId(), trigger: trigger)
                next[trigger.key] = occurrence
                started.append(occurrence)
            }
        }
        occurrences = next
        return started
    }

    /// What the unlifted occurrences hold.
    func held(lifted: Set<String>) -> (microphone: Bool, everything: Bool) {
        let holding = occurrences.values.filter { !lifted.contains($0.id) }
        return (!holding.isEmpty, holding.contains { $0.trigger.scope == .all })
    }

    /// The occurrences as the protocol says them, oldest first.
    func wire(lifted: Set<String>) -> [HoldOccurrence] {
        occurrences.values
            .sorted { ($0.trigger.sinceWallMs, $0.id) < ($1.trigger.sinceWallMs, $1.id) }
            .prefix(128)
            .map { occurrence in
                let trigger = occurrence.trigger
                return HoldOccurrence(
                    occurrenceId: occurrence.id, reason: trigger.reason, scope: trigger.scope, bundleId: trigger.bundleId,
                    network: trigger.network, window: trigger.window, since: trigger.since, sinceWallMs: trigger.sinceWallMs,
                    lifted: lifted.contains(occurrence.id)
                )
            }
    }
}
