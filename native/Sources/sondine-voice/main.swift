import Foundation
import SondineVoice

// sondine-voice embed --model <wespeaker_v2.mlmodelc>
//
// Reads one request on stdin and writes one answer on stdout, both JSON. The
// audio comes inside the request (PCM16 mono 16 kHz, base64, one string per
// contiguous piece of a voice's exclusive speech), so the tool opens no file
// but its model and needs no network.
//
//   {"speakers":[{"key":"input:mic/1/1","pieces":["<base64>", ...]}]}
//   {"modelVersion":"wespeaker-v2:<sha256>:sondine-windows-v1",
//    "speakers":[{"key":"…","embedding":[256 floats],"speechMs":12000}],
//    "errors":[{"key":"…","message":"…"}]}

struct Request: Decodable {
    struct Speaker: Decodable {
        let key: String
        let pieces: [String]
    }
    let speakers: [Speaker]
}

struct Answer: Encodable {
    struct Speaker: Encodable {
        let key: String
        let embedding: [Float]
        let speechMs: Int
    }
    struct Failure: Encodable {
        let key: String
        let message: String
    }
    let modelVersion: String
    let speakers: [Speaker]
    let errors: [Failure]
}

/// Requests above this are refused: 64 voices of 30 s, base64, with room to spare.
let maximumRequestBytes = 96 << 20

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("sondine-voice: \(message)\n".utf8))
    exit(1)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 3, arguments[0] == "embed", arguments[1] == "--model" else {
    fail("usage: sondine-voice embed --model <wespeaker_v2.mlmodelc> < request.json")
}
let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count <= maximumRequestBytes else { fail("the request is too large") }
let request: Request
do {
    request = try JSONDecoder().decode(Request.self, from: input)
} catch {
    fail("the request is not valid JSON: \(error)")
}
guard request.speakers.count <= 64, Set(request.speakers.map(\.key)).count == request.speakers.count else {
    fail("send at most 64 voices, each key once")
}
do {
    let embedder = try VoiceEmbedder(modelDirectory: URL(fileURLWithPath: arguments[2]))
    var speakers: [Answer.Speaker] = []
    var errors: [Answer.Failure] = []
    for speaker in request.speakers {
        do {
            let pieces = try speaker.pieces.map { piece -> [Float] in
                guard let data = Data(base64Encoded: piece), data.count % 2 == 0 else {
                    throw VoiceError("a piece is not base64 PCM16")
                }
                return floats(pcm16: data)
            }
            let voice = try embedder.voice(pieces: pieces)
            speakers.append(.init(
                key: speaker.key,
                embedding: voice.embedding,
                speechMs: voice.speechSamples * 1000 / VoiceLimits.sampleRate
            ))
        } catch {
            errors.append(.init(key: speaker.key, message: "\(error)"))
        }
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let answer = try encoder.encode(Answer(modelVersion: embedder.modelVersion, speakers: speakers, errors: errors))
    FileHandle.standardOutput.write(answer + Data([10]))
} catch {
    fail("\(error)")
}
