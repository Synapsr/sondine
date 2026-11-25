import Foundation
import Testing
@testable import SondineCapture

/// Golden fixtures shared with `packages/protocol`: the helper decodes every valid control
/// message, rejects every invalid one, and encodes events to the same JSON as the fixtures.
@Suite(.enabled(if: CapturePaths.hasProtocolFixtures, "packages/protocol/fixtures is missing"))
struct ProtocolGoldenTests {
    private func object(_ data: some DataProtocol) throws -> NSDictionary {
        try #require(try JSONSerialization.jsonObject(with: Data(data)) as? NSDictionary)
    }

    @Test func validControlMessagesDecodeAndReencodeToTheSameJson() throws {
        let lines = try CapturePaths.lines("control-messages.jsonl")
        #expect(!lines.isEmpty)
        var types: Set<String> = []
        for line in lines {
            let message = try ControlMessage.decode(line: Data(line.utf8)).get()
            types.insert(message.type)
            let encoded = try message.encodedLine()
            #expect(encoded.last == 0x0A)
            #expect(try object(encoded.dropLast()) == object(Data(line.utf8)), "re-encoded \(line)")
        }
        #expect(types == Set(ControlMessage.types))
        #expect(types.contains("request.permissions"))
    }

    @Test func invalidControlMessagesAreRejectedWithACode() throws {
        let lines = try CapturePaths.lines("invalid/control-messages.jsonl")
        #expect(!lines.isEmpty)
        for line in lines {
            switch ControlMessage.decode(line: Data(line.utf8)) {
            case .success(let message):
                Issue.record("accepted \(line) as \(message)")
            case .failure(let failure):
                #expect([.requestInvalid, .protocolUnsupported].contains(failure.code), "\(line): \(failure.code)")
            }
        }
    }

    @Test func anUnsupportedProtocolVersionIsNamedAsSuch() throws {
        let other = HelperProtocol.version + 1
        let line = #"{"type":"hello","id":"c1","protocol":\#(other),"client":{"name":"sondine-core","version":"0.1.0"}}"#
        guard case .failure(let failure) = ControlMessage.decode(line: Data(line.utf8)) else {
            Issue.record("accepted protocol \(other)")
            return
        }
        #expect(failure.code == .protocolUnsupported)
        #expect(failure.id == "c1")
    }

    @Test func helperEventsMatchTheFixturesExactly() throws {
        let lines = try CapturePaths.lines("helper-events.jsonl")
        #expect(!lines.isEmpty)
        var types: Set<String> = []
        for line in lines {
            let event = try JSONDecoder().decode(HelperEvent.self, from: Data(line.utf8))
            types.insert(event.type)
            let encoded = try event.encodedLine()
            #expect(try object(encoded.dropLast()) == object(Data(line.utf8)), "re-encoded \(line)")
        }
        #expect(types == Set(HelperEventTypes.all))
    }

    @Test func theFramerSplitsLinesAndSkipsOversizedOnes() {
        var framer = JSONLineFramer(maxLineBytes: 8)
        #expect(framer.push(Data("ab\r\n\ncd".utf8)) == [.line(Data("ab".utf8))])
        #expect(framer.push(Data("\n0123456789012\nok\n".utf8)) == [.line(Data("cd".utf8)), .oversized, .line(Data("ok".utf8))])
    }
}

enum HelperEventTypes {
    static let all = [
        "ready", "ack", "permissions", "devices", "processes", "track.open", "track.update", "track.close",
        "region.open", "region.close", "commit", "activity", "call", "listen", "call.seen", "situation", "holds", "clock", "self.envelope", "health", "warning", "error",
    ]
}
