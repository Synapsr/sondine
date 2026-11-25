import Foundation

// Playback of a phone recording from the Mac (ADR 008, architecture §11):
// `GET /v1/recordings/<id>/audio?g=<generation>` by byte ranges of at most
// 1 MiB, through the pinned session, held in memory for the player and never
// written to disk. The Mac answers the WAV it plays in its own window.

/// What one range read gave.
public enum RemoteAudioRead: Equatable, Sendable {
    /// The bytes from the asked offset (possibly fewer than asked), and the WAV's whole length.
    case bytes(Data, total: Int64)
    /// The Mac refused it: `gone`, `stale` (the generation moved: fetch the result again), `range`, `busy`, `not-yours`…
    case refused(status: Int, PhoneErrorCode)
    /// No address answered.
    case unreachable
    case notPaired
}

public enum ContentRange {
    /// `bytes <start>-<end>/<total>`; nil for anything else (`*` totals included).
    public static func parse(_ header: String) -> (start: Int64, end: Int64, total: Int64)? {
        guard let match = header.wholeMatch(of: /\s*bytes\s+(\d{1,15})-(\d{1,15})\/(\d{1,15})\s*/),
              let start = Int64(match.1), let end = Int64(match.2), let total = Int64(match.3),
              start <= end, end < total
        else { return nil }
        return (start, end, total)
    }
}

/// Reads a range of the Mac's WAV in requests of at most `chunk` bytes.
public struct RemoteAudioReader: Sendable {
    public typealias Fetch = @Sendable (ClosedRange<Int64>) async -> RemoteAudioRead

    public let chunk: Int64
    private let fetch: Fetch

    public init(chunk: Int64 = PhoneSync.audioChunkBytes, fetch: @escaping Fetch) {
        self.chunk = chunk
        self.fetch = fetch
    }

    /// Reads from `offset` for `length` bytes (to the end when nil), handing each piece to
    /// `deliver` as it comes; stops when `deliver` says so, at the end, or at a failure.
    /// Returns the WAV's length when known, or the read that failed.
    public func read(
        from offset: Int64, length: Int64?, deliver: (Data, _ total: Int64) async -> Bool
    ) async -> Result<Int64, ReadFailure> {
        var next = offset
        var total: Int64?
        let stop = length.map { offset + $0 }
        while true {
            var last = next + chunk - 1
            if let stop { last = min(last, stop - 1) }
            if let total { last = min(last, total - 1) }
            guard next <= last else { return .success(total ?? 0) }
            switch await fetch(next...last) {
            case let .bytes(data, whole):
                total = whole
                guard !data.isEmpty else { return .success(whole) }
                let piece = data.prefix(Int(last - next + 1))
                guard await deliver(piece, whole) else { return .success(whole) }
                next += Int64(piece.count)
                if next >= whole || next >= (stop ?? Int64.max) { return .success(whole) }
            case let failure:
                return .failure(.failed(failure))
            }
        }
    }

    public enum ReadFailure: Error, Equatable {
        case failed(RemoteAudioRead)
    }
}
