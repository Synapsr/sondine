import Foundation

// The notch's wire (packages/protocol/src/notch-messages.ts, ADR 025, ADR 036): main
// sends `show` lines on stdin, the helper sends what the user clicked on
// stdout. Objects are strict, as on the TypeScript side: an unknown field, a
// missing one or a value out of bounds rejects the line.

public enum NotchLimits {
    public static let labelMax = 200
    public static let wordsMax = 44
    public static let peopleMax = 4
    public static let conversationsMax = 3
    public static let monogramMax = 16
    public static let iconMax = 24 * 1024
    public static let callKeyMax = 64
    public static let cardActionsMax = 2
    public static let lineMax = 64 * 1024
}

public enum NotchMessageError: Error, Equatable {
    case notAnObject
    case unknownFields([String])
    case invalid(String)
}

public struct NotchConversation: Equatable, Sendable {
    public let episodeId: Int
    public let when: String
    public let words: String?

    public init(episodeId: Int, when: String, words: String?) {
        self.episodeId = episodeId
        self.when = when
        self.words = words
    }
}

public struct NotchPerson: Equatable, Sendable {
    public let personId: Int
    public let label: String
    /// Her initial, beside the notch.
    public let monogram: String
    public let conversations: [NotchConversation]
    public let none: String?
}

/// The recording of the call going on, and its buttons.
public struct NotchEpisode: Equatable, Sendable {
    public let episodeId: Int
    public let open: String
    public let end: String
}

/// The call going on, with its switch.
public struct NotchCall: Equatable, Sendable {
    public let callId: String
    public let title: String
    public let detail: String
    /// The app's icon, a PNG.
    public let icon: Data?
    public let monogram: String
    public let on: Bool
    public let toggle: String
    /// It has just started: the island says it.
    public let announce: Bool
    public let episode: NotchEpisode?
    public let mute: String
}

public struct NotchCardAction: Equatable, Sendable {
    public enum Kind: String, Sendable {
        case openEpisode = "open-episode"
        case endEpisode = "end-episode"
        case resume
    }

    public let kind: Kind
    public let label: String
    /// Present but for `resume`.
    public let episodeId: Int?
}

/// Something said once: a call that ended, a forgotten pause.
public struct NotchCard: Equatable, Sendable {
    public let key: String
    public let title: String
    public let detail: String
    public let icon: Data?
    public let monogram: String?
    public let actions: [NotchCardAction]
}

public struct NotchDismiss: Equatable, Sendable {
    public let label: String
    public let callId: Int
}

public struct NotchShow: Equatable, Sendable {
    public let view: Int
    public let call: NotchCall?
    public let people: [NotchPerson]
    public let dismiss: NotchDismiss?
    public let card: NotchCard?
    /// Resting the pointer on the island opens it; otherwise a click does.
    public let openOnHover: Bool
}

public enum NotchCommand: Equatable, Sendable {
    case show(NotchShow)

    public static func decode(line: Data) throws -> NotchCommand {
        let object = try Fields(try json(line))
        try object.only(["type", "view", "call", "people", "dismiss", "card", "openOnHover"])
        guard try object.string("type") == "show" else { throw NotchMessageError.invalid("type") }
        let people = try object.array("people").map(person)
        guard people.count <= NotchLimits.peopleMax else { throw NotchMessageError.invalid("people") }
        return .show(NotchShow(
            view: try object.id("view"),
            call: try object.nullable("call") { try call($0.child("call")) },
            people: people,
            dismiss: try object.nullable("dismiss") {
                let dismiss = try $0.child("dismiss")
                try dismiss.only(["label", "callId"])
                return NotchDismiss(label: try dismiss.label("label"), callId: try dismiss.id("callId"))
            },
            card: try object.nullable("card") { try card($0.child("card")) },
            openOnHover: try object.bool("openOnHover")
        ))
    }

    private static func call(_ object: Fields) throws -> NotchCall {
        try object.only(["callId", "title", "detail", "icon", "monogram", "on", "toggle", "announce", "episode", "mute"])
        return NotchCall(
            callId: try object.text("callId", max: NotchLimits.callKeyMax),
            title: try object.label("title"),
            detail: try object.label("detail"),
            icon: try object.icon(),
            monogram: try object.text("monogram", max: NotchLimits.monogramMax),
            on: try object.bool("on"),
            toggle: try object.label("toggle"),
            announce: try object.bool("announce"),
            episode: try object.nullable("episode") {
                let episode = try $0.child("episode")
                try episode.only(["episodeId", "open", "end"])
                return NotchEpisode(
                    episodeId: try episode.id("episodeId"), open: try episode.label("open"), end: try episode.label("end"))
            },
            mute: try object.label("mute")
        )
    }

    private static func card(_ object: Fields) throws -> NotchCard {
        try object.only(["key", "title", "detail", "icon", "monogram", "actions"])
        let actions = try object.array("actions").map { value in
            let action = try Fields(value)
            try action.only(["action", "label", "episodeId"])
            guard let kind = NotchCardAction.Kind(rawValue: try action.string("action")) else {
                throw NotchMessageError.invalid("action")
            }
            return NotchCardAction(
                kind: kind,
                label: try action.label("label"),
                episodeId: try action.nullable("episodeId") { try $0.id("episodeId") }
            )
        }
        guard actions.count <= NotchLimits.cardActionsMax else { throw NotchMessageError.invalid("actions") }
        return NotchCard(
            key: try object.text("key", max: NotchLimits.callKeyMax),
            title: try object.label("title"),
            detail: try object.label("detail"),
            icon: try object.icon(),
            monogram: try object.nullable("monogram") { try $0.text("monogram", max: NotchLimits.monogramMax) },
            actions: actions
        )
    }

    private static func person(_ value: Any) throws -> NotchPerson {
        let object = try Fields(value)
        try object.only(["personId", "label", "monogram", "conversations", "none"])
        let conversations = try object.array("conversations").map(conversation)
        guard conversations.count <= NotchLimits.conversationsMax else { throw NotchMessageError.invalid("conversations") }
        return NotchPerson(
            personId: try object.id("personId"),
            label: try object.label("label"),
            monogram: try object.text("monogram", max: NotchLimits.monogramMax),
            conversations: conversations,
            none: try object.nullable("none") { try $0.label("none") }
        )
    }

    private static func conversation(_ value: Any) throws -> NotchConversation {
        let object = try Fields(value)
        try object.only(["episodeId", "when", "words"])
        return NotchConversation(
            episodeId: try object.id("episodeId"),
            when: try object.label("when"),
            words: try object.nullable("words") { try $0.text("words", max: NotchLimits.wordsMax) }
        )
    }
}

public enum NotchEvent: Equatable, Sendable {
    /// Shown beside the notch of a screen.
    case ready
    /// No screen has a notch: the helper exits.
    case noNotch
    case openPerson(view: Int, personId: Int)
    case openEpisode(view: Int, episodeId: Int)
    case dismiss(view: Int, callId: Int)
    case toggle(view: Int, callId: String, on: Bool)
    case mute(view: Int, callId: String)
    case endEpisode(view: Int, episodeId: Int)
    case resume(view: Int)
    /// The card has had its time, or was answered.
    case done(view: Int, key: String)

    /// One JSON line, newline included.
    public func encodedLine() -> Data {
        let object: [String: Any] = switch self {
        case .ready: ["type": "ready"]
        case .noNotch: ["type": "no-notch"]
        case let .openPerson(view, personId): ["type": "open-person", "view": view, "personId": personId]
        case let .openEpisode(view, episodeId): ["type": "open-episode", "view": view, "episodeId": episodeId]
        case let .dismiss(view, callId): ["type": "dismiss", "view": view, "callId": callId]
        case let .toggle(view, callId, on): ["type": "toggle", "view": view, "callId": callId, "on": on]
        case let .mute(view, callId): ["type": "mute", "view": view, "callId": callId]
        case let .endEpisode(view, episodeId): ["type": "end-episode", "view": view, "episodeId": episodeId]
        case let .resume(view): ["type": "resume", "view": view]
        case let .done(view, key): ["type": "done", "view": view, "key": key]
        }
        // Only strings, integers and booleans: serialization cannot fail.
        var line = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
        line.append(0x0A)
        return line
    }

    /// For the fixtures: main is the side that reads these.
    public static func decode(line: Data) throws -> NotchEvent {
        let object = try Fields(try json(line))
        switch try object.string("type") {
        case "ready":
            try object.only(["type"])
            return .ready
        case "no-notch":
            try object.only(["type"])
            return .noNotch
        case "open-person":
            try object.only(["type", "view", "personId"])
            return .openPerson(view: try object.id("view"), personId: try object.id("personId"))
        case "open-episode":
            try object.only(["type", "view", "episodeId"])
            return .openEpisode(view: try object.id("view"), episodeId: try object.id("episodeId"))
        case "dismiss":
            try object.only(["type", "view", "callId"])
            return .dismiss(view: try object.id("view"), callId: try object.id("callId"))
        case "toggle":
            try object.only(["type", "view", "callId", "on"])
            return .toggle(
                view: try object.id("view"),
                callId: try object.text("callId", max: NotchLimits.callKeyMax),
                on: try object.bool("on")
            )
        case "mute":
            try object.only(["type", "view", "callId"])
            return .mute(view: try object.id("view"), callId: try object.text("callId", max: NotchLimits.callKeyMax))
        case "end-episode":
            try object.only(["type", "view", "episodeId"])
            return .endEpisode(view: try object.id("view"), episodeId: try object.id("episodeId"))
        case "resume":
            try object.only(["type", "view"])
            return .resume(view: try object.id("view"))
        case "done":
            try object.only(["type", "view", "key"])
            return .done(view: try object.id("view"), key: try object.text("key", max: NotchLimits.callKeyMax))
        default:
            throw NotchMessageError.invalid("type")
        }
    }
}

private func json(_ line: Data) throws -> Any {
    guard line.count <= NotchLimits.lineMax else { throw NotchMessageError.invalid("line") }
    do {
        return try JSONSerialization.jsonObject(with: line)
    } catch {
        throw NotchMessageError.notAnObject
    }
}

/// A JSON object read field by field, every field required.
private struct Fields {
    let object: [String: Any]

    init(_ value: Any) throws {
        guard let object = value as? [String: Any] else { throw NotchMessageError.notAnObject }
        self.object = object
    }

    func only(_ keys: Set<String>) throws {
        let unknown = object.keys.filter { !keys.contains($0) }.sorted()
        guard unknown.isEmpty else { throw NotchMessageError.unknownFields(unknown) }
    }

    func value(_ key: String) throws -> Any {
        guard let value = object[key] else { throw NotchMessageError.invalid(key) }
        return value
    }

    /// A field that holds an object.
    func child(_ key: String) throws -> Fields {
        try Fields(value(key))
    }

    /// `icon`: a PNG in base64, or null.
    func icon() throws -> Data? {
        try nullable("icon") {
            let text = try $0.text("icon", max: NotchLimits.iconMax)
            guard let data = Data(base64Encoded: text) else { throw NotchMessageError.invalid("icon") }
            return data
        }
    }

    func string(_ key: String) throws -> String {
        guard let value = try value(key) as? String else { throw NotchMessageError.invalid(key) }
        return value
    }

    /// Length in code points, as zod counts it, so both sides agree on the bounds.
    func text(_ key: String, max: Int) throws -> String {
        let value = try string(key)
        guard (1...max).contains(value.unicodeScalars.count) else { throw NotchMessageError.invalid(key) }
        return value
    }

    func label(_ key: String) throws -> String {
        try text(key, max: NotchLimits.labelMax)
    }

    /// A positive integer: a JSON number with no fraction, never a boolean.
    func id(_ key: String) throws -> Int {
        guard let number = try value(key) as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              let value = Int(exactly: number.doubleValue),
              number.doubleValue == Double(value),
              value >= 1, value <= 9_007_199_254_740_991
        else { throw NotchMessageError.invalid(key) }
        return value
    }

    /// A JSON boolean, never a number.
    func bool(_ key: String) throws -> Bool {
        guard let number = try value(key) as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
            throw NotchMessageError.invalid(key)
        }
        return number.boolValue
    }

    func array(_ key: String) throws -> [Any] {
        guard let value = try value(key) as? [Any] else { throw NotchMessageError.invalid(key) }
        return value
    }

    /// A field that must be present, null or a value.
    func nullable<T>(_ key: String, _ read: (Fields) throws -> T) throws -> T? {
        if try value(key) is NSNull { return nil }
        return try read(self)
    }
}
