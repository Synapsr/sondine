import Accelerate

/// 10 ms log-energy frames (100 per second at 16 kHz).
public struct EnvelopeFrame: Sendable, Equatable {
    /// Frame index: the frame covers samples [index × 160, (index + 1) × 160).
    public var index: Int64
    /// 10·log10(mean power), full scale = 0 dBFS, clamped to `LogEnergyEnvelope.floorDb`.
    public var db: Float

    public init(index: Int64, db: Float) {
        self.index = index
        self.db = db
    }
}

/// Streams 10 ms log-energy frames aligned to absolute sample indices, whatever the push sizes.
public struct LogEnergyEnvelope: Sendable {
    public static let frameSamples = 160
    public static let floorDb: Float = -120

    private var pending = [Float](repeating: 0, count: LogEnergyEnvelope.frameSamples)
    private var pendingCount = 0
    private var skipCurrentFrame = false
    /// Index of the frame being filled.
    public private(set) var frameIndex: Int64 = 0

    public init(startSampleIndex: Int64 = 0) {
        restart(at: startSampleIndex)
    }

    /// Restarts at `sampleIndex` (stream start or after a gap), discarding the partial frame.
    public mutating func restart(at sampleIndex: Int64) {
        let frame = Int64(Self.frameSamples)
        frameIndex = sampleIndex / frame
        pendingCount = Int(sampleIndex % frame)
        // A frame that began before this sample is incomplete: fill it but never emit it.
        skipCurrentFrame = pendingCount != 0
    }

    public mutating func push(_ samples: UnsafeBufferPointer<Float>, into frames: inout [EnvelopeFrame]) {
        guard let base = samples.baseAddress else { return }
        var offset = 0
        while offset < samples.count {
            let take = min(Self.frameSamples - pendingCount, samples.count - offset)
            let start = pendingCount
            pending.withUnsafeMutableBufferPointer { buffer in
                guard let destination = buffer.baseAddress else { return }
                (destination + start).update(from: base + offset, count: take)
            }
            pendingCount += take
            offset += take
            if pendingCount == Self.frameSamples {
                if !skipCurrentFrame {
                    frames.append(EnvelopeFrame(index: frameIndex, db: Self.level(pending)))
                }
                skipCurrentFrame = false
                frameIndex += 1
                pendingCount = 0
            }
        }
    }

    public mutating func push(_ samples: [Float]) -> [EnvelopeFrame] {
        var frames: [EnvelopeFrame] = []
        frames.reserveCapacity(samples.count / Self.frameSamples + 1)
        samples.withUnsafeBufferPointer { push($0, into: &frames) }
        return frames
    }

    /// Mean-power level of a block in dBFS, clamped to the floor. Non-finite input reads as the floor.
    public static func level(_ samples: [Float]) -> Float {
        samples.withUnsafeBufferPointer { level($0) }
    }

    public static func level(_ samples: UnsafeBufferPointer<Float>) -> Float {
        guard let base = samples.baseAddress, !samples.isEmpty else { return floorDb }
        var meanSquare: Float = 0
        vDSP_measqv(base, 1, &meanSquare, vDSP_Length(samples.count))
        guard meanSquare.isFinite, meanSquare > 0 else { return floorDb }
        return max(floorDb, min(0, 10 * log10f(meanSquare)))
    }
}
