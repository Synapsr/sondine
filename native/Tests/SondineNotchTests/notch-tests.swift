import CoreGraphics
import Foundation
import SondineNotch
import Testing

private let fixtures = URL(filePath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appending(path: "packages/protocol/fixtures")

private func lines(_ path: String) throws -> [String] {
    try String(contentsOf: fixtures.appending(path: path), encoding: .utf8)
        .split(separator: "\n")
        .map(String.init)
        .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
}

private func object(_ line: some DataProtocol) throws -> NSDictionary {
    try #require(try JSONSerialization.jsonObject(with: Data(line)) as? NSDictionary)
}

/// Golden fixtures shared with `packages/protocol` (notch-messages.ts).
@Suite(.enabled(if: FileManager.default.fileExists(atPath: fixtures.appending(path: "notch-commands.jsonl").path(percentEncoded: false))))
struct NotchMessageTests {
    @Test func mainsCommandsDecode() throws {
        let commands = try lines("notch-commands.jsonl").map { try NotchCommand.decode(line: Data($0.utf8)) }
        #expect(commands.count == 7)
        guard case let .show(first) = commands[0] else { Issue.record("not a show"); return }
        #expect(first.view == 1)
        #expect(first.call == nil)
        #expect(first.people[0].label == "Marie ?")
        #expect(first.dismiss?.label == "Masquer pour cet appel")
        #expect(first.dismiss?.callId == 4)
        #expect(first.people[0].conversations[0] == NotchConversation(
            episodeId: 9, when: "Aujourd’hui 10:05", words: "On reprend le budget de la semaine prochain…"))
        #expect(first.people[0].conversations[1].words == nil)
        #expect(first.people[0].monogram == "M")
        #expect(first.openOnHover)
        guard case let .show(second) = commands[1] else { Issue.record("not a show"); return }
        #expect(second.people[0].none == "Aucune conversation avant")
        #expect(second.people.map(\.personId) == [3, 5])
        #expect(!second.openOnHover)
        // Main clips to 44 UTF-16 units; the wire counts code points, as zod does.
        guard case let .show(third) = commands[2] else { Issue.record("not a show"); return }
        #expect(third.people[0].conversations[0].words?.utf16.count == 44)
        #expect(third.people[0].conversations[0].words?.unicodeScalars.count == 43)
        guard case let .show(fourth) = commands[3] else { Issue.record("not a show"); return }
        let call = try #require(fourth.call)
        #expect(call.on)
        #expect(call.announce)
        #expect(call.icon?.count == 8)
        #expect(call.episode?.episodeId == 31)
        #expect(call.episode?.end == "Terminer")
        #expect(fourth.people.isEmpty && fourth.dismiss == nil && fourth.card == nil)
        // The call and whom it may be with, in one view.
        guard case let .show(fifth) = commands[4] else { Issue.record("not a show"); return }
        #expect(fifth.call?.on == false)
        #expect(fifth.call?.episode == nil)
        #expect(fifth.people.first?.label == "Marie ?")
        guard case let .show(sixth) = commands[5] else { Issue.record("not a show"); return }
        #expect(sixth.card?.actions.map(\.kind) == [.openEpisode, .endEpisode])
        #expect(sixth.card?.actions.map(\.episodeId) == [31, 31])
        guard case let .show(seventh) = commands[6] else { Issue.record("not a show"); return }
        #expect(seventh.card?.monogram == nil)
        #expect(seventh.card?.actions.map(\.kind) == [.resume])
        #expect(seventh.card?.actions.first?.episodeId == nil)
    }

    @Test func invalidCommandsAreRejected() throws {
        let lines = try lines("invalid/notch-commands.jsonl")
        #expect(!lines.isEmpty)
        for line in lines {
            #expect(throws: NotchMessageError.self, "accepted \(line)") { try NotchCommand.decode(line: Data(line.utf8)) }
        }
    }

    @Test func eventsReencodeToTheSameJson() throws {
        let lines = try lines("notch-events.jsonl")
        var types: Set<String> = []
        for line in lines {
            let encoded = try NotchEvent.decode(line: Data(line.utf8)).encodedLine()
            #expect(encoded.last == 0x0A)
            #expect(try object(encoded.dropLast()) == object(Data(line.utf8)), "re-encoded \(line)")
            types.insert(try #require(try object(Data(line.utf8))["type"] as? String))
        }
        // Every event the helper sends appears in the fixtures.
        #expect(types == [
            "ready", "no-notch", "open-person", "open-episode", "dismiss", "toggle", "mute", "end-episode", "resume", "done",
        ])
    }

    @Test func invalidEventsAreRejected() throws {
        for line in try lines("invalid/notch-events.jsonl") {
            #expect(throws: NotchMessageError.self, "accepted \(line)") { try NotchEvent.decode(line: Data(line.utf8)) }
        }
    }

    @Test func booleansAndFractionsAreNotIds() {
        #expect(throws: NotchMessageError.self) {
            try NotchEvent.decode(line: Data(#"{"type":"dismiss","view":true,"callId":4}"#.utf8))
        }
        #expect(throws: NotchMessageError.self) {
            try NotchEvent.decode(line: Data(#"{"type":"dismiss","view":1,"callId":4.5}"#.utf8))
        }
    }
}

struct NotchGeometryTests {
    /// A 15-inch MacBook Air at its default scaling, as NSScreen reports it.
    private let air = NotchGeometry(
        screenFrame: CGRect(x: 0, y: 0, width: 1710, height: 1107),
        topLeftArea: CGRect(x: 0, y: 1073.5, width: 762.5, height: 33.5),
        topRightArea: CGRect(x: 947.5, y: 1073.5, width: 762.5, height: 33.5),
        topInset: 33.5
    )

    @Test func findsTheNotchBetweenTheTopCorners() throws {
        let geometry = try #require(air)
        #expect(geometry.notch == CGRect(x: 762.5, y: 1073.5, width: 185, height: 33.5))
    }

    @Test func readsOnlyTheCornersWidthsOnAScreenAwayFromTheOrigin() throws {
        let geometry = try #require(NotchGeometry(
            screenFrame: CGRect(x: -1710, y: 200, width: 1710, height: 1107),
            topLeftArea: CGRect(x: 0, y: 1073.5, width: 762.5, height: 33.5),
            topRightArea: CGRect(x: 947.5, y: 1073.5, width: 762.5, height: 33.5),
            topInset: 33.5
        ))
        #expect(geometry.notch == CGRect(x: -947.5, y: 1273.5, width: 185, height: 33.5))
    }

    @Test func aScreenWithoutANotchHasNone() {
        let frame = CGRect(x: 0, y: 0, width: 2560, height: 1440)
        #expect(NotchGeometry(screenFrame: frame, topLeftArea: nil, topRightArea: nil, topInset: 0) == nil)
        #expect(NotchGeometry(screenFrame: frame, topLeftArea: .zero, topRightArea: .zero, topInset: 25) == nil)
        #expect(NotchGeometry(
            screenFrame: frame,
            topLeftArea: CGRect(x: 0, y: 0, width: 1280, height: 25),
            topRightArea: CGRect(x: 1280, y: 0, width: 1280, height: 25),
            topInset: 25
        ) == nil)
    }

    @Test func theIslandGrowsFromTheNotchInEachState() throws {
        let geometry = try #require(air)
        // Compact: the notch and two 32 pt wings, as tall as the menu bar.
        #expect(geometry.size(.compact) == CGSize(width: 249, height: 33.5))
        // Peek: one line more; as wide as compact for a short name, wider for a long one, within bounds.
        #expect(geometry.size(.peek(labelWidth: 50.2)) == CGSize(width: 249, height: 59.5))
        #expect(geometry.size(.peek(labelWidth: 260)).width == 296)
        #expect(geometry.size(.peek(labelWidth: 900)).width == NotchGeometry.peekMaxWidth)
        // A call that starts is as wide as the open island: its switch does not move when it opens.
        #expect(geometry.size(.announce(contentHeight: 52)) == CGSize(width: 340, height: 85.5))
        // Open: the panel's width, its rows below the band, never taller than the screen.
        #expect(geometry.size(.open(contentHeight: 120.2)) == CGSize(width: 340, height: 154.5))
        #expect(geometry.size(.open(contentHeight: 5_000)).height == 1107)
    }

    @Test func theCanvasHoldsEveryStateAndNeverChanges() throws {
        let geometry = try #require(air)
        #expect(geometry.canvas == CGSize(width: 356, height: 1107))
        for state: NotchGeometry.State in [
            .compact, .peek(labelWidth: 900), .announce(contentHeight: 90), .open(contentHeight: 5_000),
        ] {
            let frame = geometry.frame(geometry.size(state))
            #expect(frame.width <= geometry.canvas.width && frame.height <= geometry.canvas.height)
        }
    }

    @Test func theWindowHangsCentredOnTheNotchWithItsEars() throws {
        let geometry = try #require(air)
        let compact = geometry.frame(geometry.size(.compact))
        #expect(compact == CGRect(x: 722.5, y: 1073.5, width: 265, height: 33.5))
        #expect(compact.midX == geometry.notch.midX)
        let open = geometry.frame(geometry.size(.open(contentHeight: 120)))
        #expect(open.midX == geometry.notch.midX)
        #expect(open.maxY == 1107)
        // Every state shares its centre and its top: growing the window never moves the island.
        #expect(open.contains(compact))
        // A pointer pushed to the top of the screen is on the island.
        #expect(geometry.holds(CGPoint(x: geometry.notch.midX, y: 1107), size: geometry.size(.compact)))
        #expect(!geometry.holds(CGPoint(x: geometry.notch.midX, y: 1000), size: geometry.size(.compact)))
    }
}
