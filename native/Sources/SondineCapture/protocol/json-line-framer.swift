import Foundation

/// Splits a byte stream into lines. Lines over the limit are reported once and skipped up to
/// their newline; `\r\n` endings and blank lines are accepted.
public struct JSONLineFramer: Sendable {
    public enum Item: Sendable, Equatable {
        case line(Data)
        case oversized
    }

    public let maxLineBytes: Int
    private var buffer = Data()
    private var discarding = false

    public init(maxLineBytes: Int = HelperProtocol.maxLineBytes) {
        self.maxLineBytes = maxLineBytes
    }

    public mutating func push(_ bytes: some DataProtocol) -> [Item] {
        var items: [Item] = []
        for byte in bytes {
            if byte == 0x0A {
                if discarding {
                    discarding = false
                } else {
                    if buffer.last == 0x0D { buffer.removeLast() }
                    if !buffer.isEmpty { items.append(.line(buffer)) }
                }
                buffer.removeAll(keepingCapacity: true)
                continue
            }
            if discarding { continue }
            buffer.append(byte)
            if buffer.count > maxLineBytes + 1 {
                items.append(.oversized)
                buffer.removeAll(keepingCapacity: false)
                discarding = true
            }
        }
        return items
    }
}
