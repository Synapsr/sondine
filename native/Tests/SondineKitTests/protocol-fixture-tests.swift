import Foundation
import SondineKit
import Testing

/// Golden fixtures shared with `packages/protocol` (skipped when the package is absent).
@Suite(.enabled(if: Paths.hasProtocolFixtures, "packages/protocol/fixtures is missing"))
struct ProtocolFixtureTests {
    private func fixture(_ path: String) throws -> [String] {
        try lines(of: Paths.protocolFixtures.appending(path: path))
    }

    /// Parses a JSON line into Foundation objects, so key order and number spelling do not matter.
    private func object(_ line: some DataProtocol) throws -> NSDictionary {
        try #require(try JSONSerialization.jsonObject(with: Data(line)) as? NSDictionary)
    }

    @Test func validManifestRecordsDecodeAndReencodeToTheSameJson() throws {
        let lines = try fixture("manifest-records.jsonl")
        #expect(!lines.isEmpty)
        var types: Set<String> = []
        for line in lines {
            let record = try ManifestRecord.decode(line: Data(line.utf8))
            let encoded = try record.encodedLine()
            #expect(encoded.last == 0x0A)
            #expect(try object(encoded.dropLast()) == object(Data(line.utf8)), "re-encoded \(line)")
            types.insert(try #require(try object(Data(line.utf8))["type"] as? String))
        }
        // Every record type the Swift side writes appears in the fixtures.
        #expect(types == ["header", "commit", "gap", "envelope", "region"])
    }

    @Test func invalidManifestRecordsAreRejected() throws {
        let lines = try fixture("invalid/manifest-records.jsonl")
        #expect(!lines.isEmpty)
        for line in lines {
            #expect(throws: ManifestError.self, "accepted \(line)") {
                try ManifestRecord.decode(line: Data(line.utf8))
            }
        }
    }

    @Test func crcVectorsMatchZlib() throws {
        struct Vector: Decodable {
            var name: String
            var bytes: String
            var crc32: UInt32
        }
        let vectors = try fixture("vectors/crc32.jsonl").map { try JSONDecoder().decode(Vector.self, from: Data($0.utf8)) }
        #expect(!vectors.isEmpty)
        for vector in vectors {
            let bytes = try #require(Data(base64Encoded: vector.bytes))
            #expect(CRC32.checksum(bytes) == vector.crc32, "\(vector.name)")
        }
    }

    @Test func envelopeVectorsRoundTrip() throws {
        struct Vector: Decodable {
            var data: String
            var values: [Float]
        }
        let vectors = try fixture("vectors/envelope.jsonl").map { try JSONDecoder().decode(Vector.self, from: Data($0.utf8)) }
        #expect(!vectors.isEmpty)
        for vector in vectors {
            #expect(ManifestEnvelope.decode(vector.data) == vector.values)
            #expect(ManifestEnvelope.encode(vector.values) == vector.data)
        }
    }

    @Test func spoolLayoutMatchesTheCommitEventFixture() throws {
        // helper-events.jsonl names spool files `<track directory>/<runId>/NNNN.pcm`.
        let commits = try fixture("helper-events.jsonl").compactMap { line -> NSDictionary? in
            let value = try object(Data(line.utf8))
            return value["type"] as? String == "commit" ? value : nil
        }
        #expect(!commits.isEmpty)
        for commit in commits {
            let trackKey = try #require(commit["trackKey"] as? String)
            let runId = try #require(commit["runId"] as? String)
            let file = try #require(commit["file"] as? String)
            #expect(file.hasPrefix(SpoolLayout.runDirectory(trackKey: trackKey, runId: runId) + "/"))
        }
    }
}
