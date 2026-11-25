import Foundation

/// Energy gate settings. The gate only decides when the VAD runs; it is tuned to be
/// permissive because missed speech here is unrecoverable once the spool expires.
public struct EnergyGateParameters: Sendable, Equatable, Codable {
    /// Opens when a frame is this far above the noise floor.
    public var openMarginDb: Float = 9
    /// Stays open while frames are this far above the floor.
    public var closeMarginDb: Float = 5
    /// Never opens below this absolute level.
    public var minimumOpenDb: Float = -70
    /// Consecutive frames above the open threshold needed to open (clicks stay closed).
    public var openFrames: Int = 2
    /// Time below the close threshold before the gate closes.
    public var hangoverMs: Int = 400
    /// Time constant of the floor following a quieter background.
    public var floorFallSeconds: Float = 0.2
    /// Time constant of the floor rising toward a louder background while closed.
    public var floorRiseSeconds: Float = 4
    /// Rise of the floor while open, so a sudden steady noise eventually closes the gate.
    public var openFloorRiseDbPerSecond: Float = 0.5
    /// Frames at or below this level are digital silence: closed, and they never move the floor.
    public var digitalSilenceDb: Float = -110

    public init() {}
}

public struct GateDecision: Sendable, Equatable {
    public var frameIndex: Int64
    public var isOpen: Bool
    /// Floor used for this decision (before this frame updated it).
    public var floorDb: Float
}

public struct EnergyGateStatistics: Sendable, Equatable, Codable {
    public var frames = 0
    public var openFrames = 0
    public var digitalSilenceFrames = 0
    public var opens = 0
    public var minimumFloorDb: Float?
    public var maximumFloorDb: Float?
    public var finalFloorDb: Float?

    public var openRatio: Double { frames == 0 ? 0 : Double(openFrames) / Double(frames) }
}

/// Adaptive-noise-floor gate with level and time hysteresis, fed 10 ms envelope frames.
public struct EnergyGate: Sendable {
    public let parameters: EnergyGateParameters
    public private(set) var isOpen = false
    public private(set) var floorDb: Float?
    public private(set) var statistics = EnergyGateStatistics()

    private var framesAbove = 0
    private var msBelow = 0
    private let fallCoefficient: Float
    private let riseCoefficient: Float
    private static let frameSeconds: Float = 0.01

    public init(parameters: EnergyGateParameters = EnergyGateParameters()) {
        self.parameters = parameters
        fallCoefficient = 1 - exp(-Self.frameSeconds / max(parameters.floorFallSeconds, 0.001))
        riseCoefficient = 1 - exp(-Self.frameSeconds / max(parameters.floorRiseSeconds, 0.001))
    }

    public mutating func process(_ frame: EnvelopeFrame) -> GateDecision {
        let level = frame.db
        let silent = level <= parameters.digitalSilenceDb
        if floorDb == nil, !silent { floorDb = level }
        let floor = floorDb ?? LogEnergyEnvelope.floorDb

        if silent {
            if isOpen { msBelow += 10 }
            framesAbove = 0
            statistics.digitalSilenceFrames += 1
        } else if isOpen {
            let closeThreshold = max(
                floor + parameters.closeMarginDb,
                parameters.minimumOpenDb - (parameters.openMarginDb - parameters.closeMarginDb)
            )
            msBelow = level >= closeThreshold ? 0 : msBelow + 10
        } else {
            let openThreshold = max(floor + parameters.openMarginDb, parameters.minimumOpenDb)
            framesAbove = level >= openThreshold ? framesAbove + 1 : 0
            if framesAbove >= parameters.openFrames {
                isOpen = true
                msBelow = 0
                statistics.opens += 1
            }
        }
        if isOpen, msBelow >= parameters.hangoverMs {
            isOpen = false
            framesAbove = 0
        }

        if !silent, let current = floorDb {
            if level < current {
                floorDb = current + (level - current) * fallCoefficient
            } else if isOpen {
                floorDb = min(level, current + parameters.openFloorRiseDbPerSecond * Self.frameSeconds)
            } else {
                floorDb = current + (level - current) * riseCoefficient
            }
        }

        statistics.frames += 1
        if isOpen { statistics.openFrames += 1 }
        if let value = floorDb {
            statistics.minimumFloorDb = min(statistics.minimumFloorDb ?? value, value)
            statistics.maximumFloorDb = max(statistics.maximumFloorDb ?? value, value)
            statistics.finalFloorDb = value
        }
        return GateDecision(frameIndex: frame.index, isOpen: isOpen, floorDb: floor)
    }

    /// Closes the gate after a discontinuity; the floor is kept (same room, same device).
    public mutating func interrupt() {
        isOpen = false
        framesAbove = 0
        msBelow = 0
    }
}
