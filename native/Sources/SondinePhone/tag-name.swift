import Foundation

/// A tag's name and key (ADR 039), the same rule as `tagName` and `tagKey` in
/// `packages/core/src/text/tags.ts`, checked by both against
/// `packages/protocol/fixtures/vectors/tag-names.jsonl`. A name is the user's
/// spelling, cleaned; its key is what makes two names one tag: « Idées » and « idees ».
public enum TagName {
    /// Longest name, in characters as people count them (grapheme clusters)…
    public static let maxCharacters = 40
    /// …and in UTF-16 code units, what the wire counts (a family emoji is 11).
    public static let maxUnits = 200
    /// Most tags on one recording.
    public static let perRecording = 20

    /// The name as kept: NFC, control characters and leading « # » removed,
    /// spaces trimmed and collapsed; nil when nothing is left or it is too long.
    public static func clean(_ typed: String) -> String? {
        var scalars = String.UnicodeScalarView()
        var space = false
        for scalar in typed.precomposedStringWithCanonicalMapping.unicodeScalars {
            let category = scalar.properties.generalCategory
            // JavaScript's `\s` (Unicode white space and the byte order mark) and control characters.
            let blank = category == .control || category == .lineSeparator || category == .paragraphSeparator
                || scalar.properties.isWhitespace || scalar.value == 0xFEFF
            if blank {
                space = true
                continue
            }
            if space, !scalars.isEmpty { scalars.append(" ") }
            space = false
            scalars.append(scalar)
        }
        var name = String(scalars)
        while name.hasPrefix("#") { name.removeFirst() }
        name = name.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, name.count <= maxCharacters, name.utf16.count <= maxUnits else { return nil }
        return name
    }

    /// A recording's tags as the phone shows them: the Mac's (`mac`), with
    /// the outbox's tag operations on it applied on top, oldest first.
    public static func shown(mac: [String], waiting: [OutboxOperation], recordingId: UUID) -> [String] {
        var shown = mac
        for operation in waiting where operation.kind == .tag && operation.recordingId == recordingId {
            guard let key = operation.tagKey, let name = operation.name else { continue }
            shown.removeAll { Self.key($0) == key }
            if operation.on == true { shown.append(name) }
        }
        return shown
    }

    /// The tags to offer: those put on this phone lately, then the Mac's, once each.
    public static func recent(waiting: [OutboxOperation], mac: [String]) -> [String] {
        var out: [String] = []
        let mine = waiting.filter { $0.kind == .tag && $0.on == true }.reversed().compactMap(\.name)
        for name in mine + mac where !out.contains(where: { key($0) == key(name) }) { out.append(name) }
        return out
    }

    /// Two names with the same key are one tag: lower case, without accents.
    public static func key(_ name: String) -> String {
        let lowered = name.lowercased().decomposedStringWithCanonicalMapping
        var scalars = String.UnicodeScalarView()
        for scalar in lowered.unicodeScalars {
            switch scalar.properties.generalCategory {
            case .nonspacingMark, .spacingMark, .enclosingMark: continue
            default: scalars.append(scalar)
            }
        }
        return String(scalars).precomposedStringWithCanonicalMapping
    }
}
