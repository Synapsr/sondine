import SondineKit
import Testing

@Suite struct RateEstimatorTests {
    let timebase = HostTimebase(numer: 125, denom: 3)

    /// Feeds blocks of `frames` produced at `actualRate`, returning the last estimate.
    private func run(
        _ estimator: inout MeasuredRateEstimator,
        actualRate: Double,
        seconds: Double,
        frames: Int = 512,
        jitterSeconds: Double = 0,
        startSeconds: Double = 10
    ) -> RateEstimate? {
        var generator = SplitMix(seed: 7)
        var produced = 0.0
        var last: RateEstimate?
        while produced / actualRate < seconds {
            let jitter = jitterSeconds * (Double(generator.next() % 2_001) / 1_000 - 1)
            let time = startSeconds + produced / actualRate + jitter
            last = estimator.observe(hostTicks: UInt64(timebase.ticks(fromSeconds: time)), frameCount: frames)
            produced += Double(frames)
        }
        return last
    }

    @Test(arguments: [48_000.0, 44_100.0, 24_000.0, 16_000.0])
    func measuresNominalRates(rate: Double) throws {
        var estimator = MeasuredRateEstimator(nominalRate: rate, timebase: timebase)
        let estimate = try #require(run(&estimator, actualRate: rate, seconds: 3))
        #expect(abs(estimate.measuredRate - rate) / rate < 1e-5)
        #expect(estimate.isSettled)
        #expect(estimate.isWithinTolerance)
        #expect(!estimate.exceedsRebuildThreshold)
        #expect(estimate.spanSeconds <= 2.05)
    }

    @Test func clockDriftInsideToleranceIsMeasuredButAccepted() throws {
        var estimator = MeasuredRateEstimator(nominalRate: 48_000, timebase: timebase)
        let estimate = try #require(run(&estimator, actualRate: 48_024, seconds: 3))
        #expect(abs(estimate.measuredRate - 48_024) < 1)
        #expect(estimate.isWithinTolerance)
        #expect(ResampleRatePolicy.inputRate(nominal: 48_000, estimate: estimate) == 48_000)
    }

    @Test func timestampJitterStaysWithinTolerance() throws {
        var estimator = MeasuredRateEstimator(nominalRate: 48_000, timebase: timebase)
        let estimate = try #require(run(&estimator, actualRate: 48_000, seconds: 4, jitterSeconds: 0.000_2))
        #expect(abs(estimate.deviation) < 0.000_3)
        #expect(estimate.isWithinTolerance)
    }

    @Test func detectsADeviceRunningAtAnotherRate() throws {
        // A Bluetooth mic in call mode reporting 48 kHz while delivering 24 kHz.
        var estimator = MeasuredRateEstimator(nominalRate: 48_000, timebase: timebase)
        let estimate = try #require(run(&estimator, actualRate: 24_000, seconds: 3))
        #expect(!estimate.isWithinTolerance)
        #expect(estimate.exceedsRebuildThreshold)
        #expect(ResampleRatePolicy.inputRate(nominal: 48_000, estimate: estimate) == 24_000)
    }

    @Test func halfRateDeviceWithLargeBlocksAndJitterIsNotMistakenForAStall() throws {
        // 85 ms blocks are long enough to be judged; at exactly half the nominal rate, jitter
        // must not restart the window.
        var estimator = MeasuredRateEstimator(nominalRate: 48_000, timebase: timebase)
        let estimate = try #require(run(&estimator, actualRate: 24_000, seconds: 3, frames: 2_048, jitterSeconds: 0.000_5))
        #expect(estimator.resets == 0)
        #expect(estimate.isSettled)
        #expect(abs(estimate.measuredRate - 24_000) / 24_000 < 0.001)
    }

    @Test func stallWithoutDropAccountingRestartsTheWindow() throws {
        var estimator = MeasuredRateEstimator(nominalRate: 48_000, timebase: timebase)
        _ = run(&estimator, actualRate: 48_000, seconds: 2)
        // IO stops for 1 s and resumes without reporting dropped frames.
        let estimate = run(&estimator, actualRate: 48_000, seconds: 0.2, startSeconds: 13)
        #expect(estimator.resets == 1)
        #expect(estimate?.isSettled == false)
    }

    @Test func droppedFramesStillCountAsElapsedTime() throws {
        var estimator = MeasuredRateEstimator(nominalRate: 48_000, timebase: timebase)
        var produced = 0
        var estimate: RateEstimate?
        var block = 0
        while produced < 48_000 * 3 {
            let dropped = block % 10 == 5 ? 512 : 0
            produced += dropped
            let ticks = UInt64(timebase.ticks(fromSeconds: 10 + Double(produced) / 48_000))
            estimate = estimator.observe(hostTicks: ticks, frameCount: 512, droppedFramesBefore: UInt64(dropped))
            produced += 512
            block += 1
        }
        let result = try #require(estimate)
        #expect(abs(result.measuredRate - 48_000) < 1)
    }

    @Test func hostTimeJumpRestartsTheWindow() throws {
        var estimator = MeasuredRateEstimator(nominalRate: 48_000, timebase: timebase)
        _ = run(&estimator, actualRate: 48_000, seconds: 2)
        let resetsBefore = estimator.resets
        // Ten seconds of sleep between two blocks.
        let estimate = run(&estimator, actualRate: 48_000, seconds: 0.5, startSeconds: 30)
        #expect(estimator.resets == resetsBefore + 1)
        #expect(estimate?.isSettled == false)
        let settled = try #require(run(&estimator, actualRate: 48_000, seconds: 2, startSeconds: 30.5))
        #expect(settled.isSettled)
        #expect(abs(settled.measuredRate - 48_000) < 1)
    }

    @Test func policyKeepsNominalUntilSettledAndRoundsOddRates() {
        let unsettled = RateEstimate(
            measuredRate: 24_000, nominalRate: 48_000, spanSeconds: 0.2, deviation: -0.5,
            isSettled: false, isWithinTolerance: false, exceedsRebuildThreshold: true
        )
        #expect(ResampleRatePolicy.inputRate(nominal: 48_000, estimate: unsettled) == 48_000)
        #expect(ResampleRatePolicy.inputRate(nominal: 48_000, estimate: nil) == 48_000)
        let odd = RateEstimate(
            measuredRate: 37_123.4, nominalRate: 48_000, spanSeconds: 2, deviation: -0.23,
            isSettled: true, isWithinTolerance: false, exceedsRebuildThreshold: true
        )
        #expect(ResampleRatePolicy.inputRate(nominal: 48_000, estimate: odd) == 37_123)
    }
}
