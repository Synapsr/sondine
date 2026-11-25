import Foundation
import zlib

/// CRC-32/ISO-HDLC, the value of zlib's `crc32()` and Node's `zlib.crc32()`.
public enum CRC32 {
    public static func checksum(_ bytes: UnsafeRawBufferPointer, continuing value: UInt32 = 0) -> UInt32 {
        guard var base = bytes.baseAddress?.assumingMemoryBound(to: Bytef.self) else { return value }
        var remaining = bytes.count
        var crc = uLong(value)
        while remaining > 0 {
            let length = min(remaining, Int(UInt32.max))
            crc = zlib.crc32(crc, base, uInt(length))
            base += length
            remaining -= length
        }
        return UInt32(truncatingIfNeeded: crc)
    }

    public static func checksum<Bytes: ContiguousBytes>(_ bytes: Bytes, continuing value: UInt32 = 0) -> UInt32 {
        bytes.withUnsafeBytes { checksum($0, continuing: value) }
    }
}
