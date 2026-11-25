import Foundation
import SondineKit
import Testing
@testable import SondineCapture

/// Timing of the drain worker on the fake HAL: gaps between IO callbacks, rate generations of
/// queued blocks, and the track state replayed in snapshots.
@Suite(.serialized)
struct TrackProcessorTests {
    private static let mic = "BuiltInMicrophoneDevice"

    private func gaps(_ recorder: EventRecorder) -> [GapSpan] {
        recorder.all.flatMap { event -> [GapSpan] in
            if case .commit(let commit) = event { commit.gaps } else { [] }
        }
    }

    @Test func missingCallbacksWithoutADiscontinuityBecomeAGap() throws {
        let harness = try EngineHarness()
        harness.start()
        harness.feedMicrophone(seconds: 0.5)
        // No IO callback for 3 s, and no discontinuity flag: the HAL simply skipped them.
        harness.clock.advance(seconds: 3)
        harness.feedMicrophone(seconds: 0.5)
        harness.engine.stop()

        let close = try #require(harness.recorder.trackCloses.first)
        #expect(close.endSample == 64_000)
        #expect(gaps(harness.recorder) == [GapSpan(reason: .stall, fromSample: 8_000, toSample: 56_000)])
    }

    @Test func ordinaryCallbackSpacingIsNotAGap() throws {
        let harness = try EngineHarness()
        harness.start()
        for _ in 0..<12 { harness.feedMicrophone(seconds: 0.085) }
        harness.engine.stop()
        #expect(gaps(harness.recorder).isEmpty)
        let close = try #require(harness.recorder.trackCloses.first)
        #expect(close.endSample == 16_320)
    }

    @Test func blocksQueuedBeforeARateChangeKeepTheirRate() throws {
        let harness = try EngineHarness()
        harness.start()
        // 250 ms at 48 kHz waits in the ring when the device switches to 24 kHz.
        harness.hal.deliver(toDevice: Self.mic, interleaved: EngineHarness.noise(frames: 12_000, amplitude: 0.01), channels: 1, hostTicks: harness.clock.nanoseconds)
        harness.clock.advance(seconds: 0.25)
        harness.hal.setNominalRate(uid: Self.mic, rate: 24_000)
        harness.settle()
        harness.hal.deliver(toDevice: Self.mic, interleaved: EngineHarness.noise(frames: 6_000, amplitude: 0.01), channels: 1, hostTicks: harness.clock.nanoseconds)
        harness.clock.advance(seconds: 0.25)
        harness.engine.drainNow()
        harness.engine.stop()

        let close = try #require(harness.recorder.trackCloses.first)
        #expect(close.endSample == 8_000)
        #expect(gaps(harness.recorder).isEmpty)
        let update = try #require(harness.recorder.trackUpdates.first { $0.reason == .rateChange })
        #expect(update.nominalRate == 24_000)
        #expect(update.sampleIndex == 4_000)
    }

    @Test func aSnapshotDescribesTheTrackAsItIsNow() throws {
        let harness = try EngineHarness()
        harness.start()
        for _ in 0..<4 { harness.feedMicrophone(seconds: 0.25) }
        harness.hal.setNominalRate(uid: Self.mic, rate: 44_100)
        harness.settle()
        for _ in 0..<4 { harness.feedMicrophone(seconds: 0.25, rate: 44_100) }
        let update = try #require(harness.recorder.trackUpdates.last { $0.reason == .rateChange })

        let first = try #require(harness.recorder.trackOpens.first)

        harness.send(.snapshot(id: "snap"))
        // The run's opening, as it is now but with its first epoch (its start and anchor
        // belong to it), then the change that started the current epoch.
        let open = try #require(harness.recorder.trackOpens.last { $0.replyTo == "snap" })
        #expect(open.epoch == first.epoch)
        #expect(open.anchor == first.anchor)
        #expect(open.nominalRate == 44_100)
        #expect(open.runId == update.runId)
        let replayed = try #require(harness.recorder.trackUpdates.last { $0.replyTo == "snap" })
        #expect(replayed.reason == .rateChange)
        #expect(replayed.epoch == update.epoch)
        #expect(replayed.sampleIndex == update.sampleIndex)
        #expect(replayed.at == update.at)
        harness.engine.stop()
    }
}
