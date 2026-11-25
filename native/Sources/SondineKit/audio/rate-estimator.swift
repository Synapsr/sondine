/// Sample rate measured from delivered frames over host time.
public struct RateEstimate: Sendable, Equatable {
    public var measuredRate: Double
    public var nominalRate: Double
    /// Host time covered by the window.
    public var spanSeconds: Double
    /// (measured − nominal) / nominal.
    public var deviation: Double
    /// The window covers at least the minimum span, so the value can be trusted.
    public var isSettled: Bool
    /// |deviation| ≤ tolerance (±0.1 % by default).
    public var isWithinTolerance: Bool
    /// |deviation| > 1 %: the device or tap should be rebuilt if zeros follow (architecture §3).
    public var exceedsRebuildThreshold: Bool

    public init(
        measuredRate: Double,
        nominalRate: Double,
        spanSeconds: Double,
        deviation: Double,
        isSettled: Bool,
        isWithinTolerance: Bool,
        exceedsRebuildThreshold: Bool
    ) {
        self.measuredRate = measuredRate
        self.nominalRate = nominalRate
        self.spanSeconds = spanSeconds
        self.deviation = deviation
        self.isSettled = isSettled
        self.isWithinTolerance = isWithinTolerance
        self.exceedsRebuildThreshold = exceedsRebuildThreshold
    }
}

/// Frames ÷ Δhost time over a sliding window of IO blocks.
public struct MeasuredRateEstimator: Sendable {
    public private(set) var nominalRate: Double
    public let timebase: HostTimebase
    public let windowSeconds: Double
    public let minimumSpanSeconds: Double
    public let tolerance: Double
    public private(set) var estimate: RateEstimate?
    public private(set) var resets = 0

    private var points: [(ticks: UInt64, frames: UInt64)] = []
    private var start = 0
    private var cumulativeFrames: UInt64 = 0

    public init(
        nominalRate: Double,
        timebase: HostTimebase = .current,
        windowSeconds: Double = 2,
        minimumSpanSeconds: Double = 1,
        tolerance: Double = 0.001
    ) {
        precondition(nominalRate > 0, "nominal rate must be positive")
        self.nominalRate = nominalRate
        self.timebase = timebase
        self.windowSeconds = windowSeconds
        self.minimumSpanSeconds = minimumSpanSeconds
        self.tolerance = tolerance
    }

    /// Records one block. Dropped frames still elapsed in device time, so they count.
    @discardableResult
    public mutating func observe(hostTicks: UInt64, frameCount: Int, droppedFramesBefore: UInt64 = 0) -> RateEstimate? {
        cumulativeFrames &+= droppedFramesBefore
        if let last = points.last {
            if hostTicks <= last.ticks || isImplausibleStep(from: last, toTicks: hostTicks) {
                // Host time jumped (sleep, device restart): the old window no longer describes this stream.
                restart()
            }
        }
        points.append((hostTicks, cumulativeFrames))
        cumulativeFrames &+= UInt64(frameCount)

        let windowTicks = UInt64(max(0, timebase.ticks(fromSeconds: windowSeconds)))
        while points.count - start > 2, hostTicks - points[start].ticks > windowTicks {
            start += 1
        }
        if start > 512 {
            points.removeFirst(start)
            start = 0
        }
        estimate = computeEstimate()
        return estimate
    }

    /// Clears the window, optionally with a new nominal rate (device format change).
    public mutating func reset(nominalRate: Double? = nil) {
        if let nominalRate {
            precondition(nominalRate > 0, "nominal rate must be positive")
            self.nominalRate = nominalRate
        }
        restart()
        cumulativeFrames = 0
    }

    private mutating func restart() {
        points.removeAll(keepingCapacity: true)
        start = 0
        estimate = nil
        resets += 1
    }

    private func isImplausibleStep(from last: (ticks: UInt64, frames: UInt64), toTicks ticks: UInt64) -> Bool {
        let frames = Double(cumulativeFrames - last.frames)
        let seconds = timebase.seconds(fromTicks: Int64(ticks - last.ticks))
        // Short steps are dominated by timestamp jitter; only judge steps of 50 ms or more.
        guard seconds >= 0.05 || frames / nominalRate >= 0.05 else { return false }
        let rate = frames / seconds
        // A 4× band around the best known rate: wide enough that a device delivering half its
        // nominal rate (Bluetooth call mode) is measured, not mistaken for a stall.
        let reference = estimate.flatMap { $0.isSettled ? $0.measuredRate : nil } ?? nominalRate
        return rate < reference / 4 || rate > reference * 4
    }

    private func computeEstimate() -> RateEstimate? {
        guard points.count - start >= 2, let newest = points.last else { return nil }
        let oldest = points[start]
        let span = timebase.seconds(fromTicks: Int64(newest.ticks - oldest.ticks))
        guard span > 0 else { return nil }
        let measured = Double(newest.frames - oldest.frames) / span
        let deviation = (measured - nominalRate) / nominalRate
        return RateEstimate(
            measuredRate: measured,
            nominalRate: nominalRate,
            spanSeconds: span,
            deviation: deviation,
            isSettled: span >= minimumSpanSeconds,
            isWithinTolerance: abs(deviation) <= tolerance,
            exceedsRebuildThreshold: abs(deviation) > 0.01
        )
    }
}

/// Chooses the input rate the resampler is built for.
public enum ResampleRatePolicy {
    public static let standardRates: [Double] = [
        8_000, 11_025, 12_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 88_200, 96_000, 176_400, 192_000,
    ]

    /// The nominal rate while the estimate is unsettled or within tolerance; otherwise the
    /// standard rate the measurement matches (a device that reports 48 kHz but runs at 24 kHz),
    /// else the measured rate rounded to 1 Hz. Clock drift inside the tolerance is left to
    /// timestamps, so the converter is not rebuilt for jitter.
    public static func inputRate(nominal: Double, estimate: RateEstimate?, tolerance: Double = 0.001) -> Double {
        guard let estimate, estimate.isSettled, !estimate.isWithinTolerance else { return nominal }
        let measured = estimate.measuredRate
        if let standard = standardRates.min(by: { abs($0 - measured) < abs($1 - measured) }),
           abs(standard - measured) / standard <= tolerance {
            return standard
        }
        return measured.rounded()
    }
}
