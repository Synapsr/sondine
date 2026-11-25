/// Counts of samples that needed guarding during a Float32 → PCM16 conversion.
public struct PCM16ConversionStats: Sendable, Equatable {
    public var clipped = 0
    public var nonFinite = 0

    public init(clipped: Int = 0, nonFinite: Int = 0) {
        self.clipped = clipped
        self.nonFinite = nonFinite
    }

    public static func += (lhs: inout PCM16ConversionStats, rhs: PCM16ConversionStats) {
        lhs.clipped += rhs.clipped
        lhs.nonFinite += rhs.nonFinite
    }
}

/// Float32 [-1, 1] ↔ signed 16-bit little-endian PCM.
public enum PCM16 {
    public static let scale: Float = 32_767

    /// Converts with round-to-nearest and a symmetric scale. Values outside [-1, 1] clamp to
    /// ±32767; NaN becomes 0 and ±Inf clamps, so a bad driver buffer cannot corrupt the spool.
    @discardableResult
    public static func convert(
        _ source: UnsafeBufferPointer<Float>,
        into destination: UnsafeMutableBufferPointer<Int16>
    ) -> PCM16ConversionStats {
        precondition(destination.count >= source.count, "destination too small")
        var stats = PCM16ConversionStats()
        for index in source.indices {
            let value = source[index]
            let sample: Int16
            if value.isNaN {
                stats.nonFinite += 1
                sample = 0
            } else if value >= 1 {
                if value > 1 { stats.clipped += 1 }
                if value.isInfinite { stats.nonFinite += 1 }
                sample = Int16.max
            } else if value <= -1 {
                if value < -1 { stats.clipped += 1 }
                if value.isInfinite { stats.nonFinite += 1 }
                sample = -Int16.max
            } else {
                sample = Int16((value * scale).rounded(.toNearestOrEven))
            }
            destination[index] = sample.littleEndian
        }
        return stats
    }

    public static func convert(_ source: [Float]) -> (samples: [Int16], stats: PCM16ConversionStats) {
        var stats = PCM16ConversionStats()
        let samples = [Int16](unsafeUninitializedCapacity: source.count) { buffer, count in
            source.withUnsafeBufferPointer { stats = convert($0, into: buffer) }
            count = source.count
        }
        return (samples, stats)
    }

    public static func floats(fromLittleEndian samples: UnsafeBufferPointer<Int16>) -> [Float] {
        samples.map { Float(Int16(littleEndian: $0)) / scale }
    }
}
