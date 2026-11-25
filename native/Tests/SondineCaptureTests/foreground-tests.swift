import Foundation
import SondineKit
import Testing
@testable import SondineCapture

/// The app in front, cut along each speech region (ADR 022), and kept no longer than an open
/// region needs.
@Suite(.serialized)
struct ForegroundTests {
    private static let xcode = ForegroundApp(bundleId: "com.apple.dt.Xcode", name: "Xcode")
    private static let safari = ForegroundApp(bundleId: "com.apple.Safari", name: "Safari")
    private static let sondine = ForegroundApp(bundleId: "app.sondine", name: "Sondine")

    @Test func theTimelineCutsAStretchAtEachChange() {
        var timeline = ForegroundTimeline()
        timeline.record(Self.xcode, atNs: 100)
        timeline.record(Self.xcode, atNs: 150)
        timeline.record(nil, atNs: 200)
        timeline.record(Self.safari, atNs: 300)
        #expect(timeline.changes.count == 3)
        #expect(timeline.spans(fromNs: 50, toNs: 400) == [
            .init(fromNs: 100, toNs: 200, app: Self.xcode),
            .init(fromNs: 300, toNs: 400, app: Self.safari),
        ])
        #expect(timeline.spans(fromNs: 120, toNs: 180) == [.init(fromNs: 120, toNs: 180, app: Self.xcode)])
        #expect(timeline.spans(fromNs: 400, toNs: 400).isEmpty)
    }

    @Test func forgettingKeepsTheAppInFrontThen() {
        var timeline = ForegroundTimeline()
        timeline.record(Self.xcode, atNs: 100)
        timeline.record(Self.safari, atNs: 300)
        timeline.record(Self.sondine, atNs: 500)
        timeline.forget(before: 400)
        #expect(timeline.changes == [.init(atNs: 300, app: Self.safari), .init(atNs: 500, app: Self.sondine)])
        // A late report never goes back in time.
        timeline.record(Self.xcode, atNs: 450)
        #expect(timeline.changes.last == .init(atNs: 500, app: Self.xcode))
    }

    /// Quiet, then 3 s of loud noise (energy-gate speech), then quiet until the region closes.
    private func speak(_ harness: EngineHarness, during: (Int) -> Void = { _ in }) {
        for _ in 0..<12 { harness.feedMicrophone(seconds: 0.25, amplitude: 0.001) }
        for block in 0..<12 {
            during(block)
            harness.feedMicrophone(seconds: 0.25, amplitude: 0.3)
        }
        for _ in 0..<20 { harness.feedMicrophone(seconds: 0.25, amplitude: 0.001) }
    }

    @Test func aRegionClosesWithTheAppsInFrontWhileItLasted() throws {
        let harness = try EngineHarness(foreground: FakeForegroundApps(Self.xcode))
        harness.start()
        // Safari comes to the front 1.5 s into the speech, at sample 72 000 of the run.
        speak(harness) { block in if block == 6 { harness.foreground.bringToFront(Self.safari) } }
        harness.engine.stop()

        let region = try #require(harness.recorder.regionCloses.first)
        #expect(region.foreground.map(\.bundleId) == ["com.apple.dt.Xcode", "com.apple.Safari"])
        let first = try #require(region.foreground.first)
        let last = try #require(region.foreground.last)
        #expect(first.startSample == region.startSample)
        #expect(first.endSample == last.startSample)
        #expect(abs(first.endSample - 72_000) <= 160)
        #expect(last.endSample == region.endSample)
        #expect(last.name == "Safari")
    }

    @Test func anExcludedAppIsNeverNamed() throws {
        let harness = try EngineHarness(foreground: FakeForegroundApps(Self.xcode))
        var config = CaptureConfig()
        config.excludedBundleIds = ["com.apple.Safari"]
        harness.start(config)
        speak(harness) { block in if block == 6 { harness.foreground.bringToFront(Self.safari) } }
        harness.engine.stop()

        let region = try #require(harness.recorder.regionCloses.first)
        #expect(region.foreground.map(\.bundleId) == ["com.apple.dt.Xcode"])
        #expect(region.foreground.first?.endSample ?? 0 < region.endSample)
    }

    @Test func noAppInFrontLeavesTheRegionWithoutOne() throws {
        let harness = try EngineHarness()
        harness.start()
        speak(harness)
        harness.engine.stop()
        let region = try #require(harness.recorder.regionCloses.first)
        #expect(region.foreground.isEmpty)
    }

    @Test func whileNobodySpeaksOnlyTheLastSecondsAreKept() throws {
        let harness = try EngineHarness(foreground: FakeForegroundApps(Self.xcode))
        harness.start()
        for index in 0..<40 {
            harness.foreground.bringToFront(index.isMultiple(of: 2) ? Self.safari : Self.sondine)
            harness.feedMicrophone(seconds: 2, amplitude: 0.001)
        }
        // 80 s of silence: the switches of the last 30 s, and the app in front before them.
        let kept = harness.engine.state.foregroundChanges
        #expect(kept >= 15 && kept <= 17)
        harness.engine.stop()
    }
}
