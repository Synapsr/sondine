import CoreAudio
import Foundation
import SondineKit
import Testing
@testable import SondineCapture

/// The `self:playback` reference (ADR 035) on the fake HAL: Sondine's own process plays a tone,
/// its private tap sends 10 ms energy frames as `self.envelope`, and nothing else of it exists:
/// no run, no spool file, no region, and it stays out of every track.
@Suite struct SelfPlaybackTests {
    typealias Scene = AppTapsTests.Scene

    static let sondine = AppBundle(bundleId: "app.sondine", name: "Sondine")
    static let music = AppBundle(bundleId: "com.apple.Music", name: "Music")

    static func selfTaps(_ scene: Scene) -> Int {
        scene.hal.taps.filter { $0.description.name == CaptureEngine.selfPlaybackName }.count
    }

    /// Frames in order, with the continuous time each event says its first frame was played.
    static func frames(_ scene: Scene) -> [(startNs: UInt64, levels: [Int])] {
        scene.harness.recorder.selfEnvelopes.map { ($0.start.continuousNs.value, $0.levels) }
    }

    @Test func sondinePlayingSendsItsEnergyAndNothingElse() throws {
        let scene = try Scene(apps: [7_001: Self.sondine, 7_002: Self.music])
        let own = scene.process(pid: 7_001, bundleID: "app.sondine", source: "sondine", frequency: 300)
        let music = scene.process(pid: 7_002, bundleID: "com.apple.Music", source: "music", frequency: 500)
        scene.play(own)
        scene.play(music)
        #expect(Self.selfTaps(scene) == 1)
        let playedNs = scene.harness.clock.anchor().continuousNs
        scene.run(seconds: 4)
        #expect(scene.state.appTracks.map(\.bundleId) == ["com.apple.Music"])
        // Stopping the engine sends what was drained and not sent yet.
        let matrix = try scene.matrix()
        // Sondine on no track; the other app on its own.
        #expect(matrix["sondine"] == nil)
        #expect(AppTapsTests.near(matrix["music"]?["app:com.apple.Music"], 4))
        #expect(scene.harness.recorder.trackOpens.allSatisfy { !$0.trackKey.contains("sondine") })
        let events = Self.frames(scene)
        let levels = events.flatMap(\.levels)
        // 100 frames a second, but for the resampler's latency.
        #expect(levels.count >= 390 && levels.count <= 400, "\(levels.count) frames")
        // About a second per event: sent at the first drain past 100 frames.
        #expect(events.allSatisfy { $0.levels.count <= SelfPlaybackReference.framesPerEvent + 26 }, "\(events.map(\.levels.count))")
        // A 0.1 sine is -23 dBFS: 10 ms frames of it read -23.0 within a few tenths.
        let steady = levels.dropFirst(5)
        #expect(steady.allSatisfy { abs($0 - -230) <= 5 }, "levels \(steady.prefix(8))")
        // Contiguous frames: each event starts where the previous one ended.
        for (previous, next) in zip(events, events.dropFirst()) {
            let expected = previous.startNs + UInt64(previous.levels.count) * 10_000_000
            #expect(next.startNs >= expected - 1_000_000 && next.startNs <= expected + 1_000_000)
        }
        // The first frame was played when the first block was.
        let first = events.first?.startNs ?? 0
        #expect(first >= playedNs && first <= playedNs + 20_000_000, "\(first) after \(playedNs)")
    }

    @Test func theTapStopsShortlyAfterSondineStopsPlaying() throws {
        let scene = try Scene(apps: [7_001: Self.sondine])
        let own = scene.process(pid: 7_001, bundleID: "app.sondine", source: "sondine", frequency: 300)
        scene.play(own)
        scene.run(seconds: 1.5)
        scene.play(own, false)
        scene.run(seconds: 1)
        #expect(Self.selfTaps(scene) == 1)
        scene.run(seconds: 1.5)
        #expect(Self.selfTaps(scene) == 0)
        #expect(scene.hal.aggregates.isEmpty)
        // What it drained before stopping was sent: nothing waits inside the helper.
        let sent = Self.frames(scene).flatMap(\.levels).count
        #expect(sent >= 140)
        scene.play(own)
        #expect(Self.selfTaps(scene) == 1)
    }

    @Test func aGapStartsTheFramesAgainAtTheirOwnTime() throws {
        let scene = try Scene(apps: [7_001: Self.sondine])
        scene.play(scene.process(pid: 7_001, bundleID: "app.sondine", source: "sondine", frequency: 300))
        scene.run(seconds: 1.5)
        // The tap delivers nothing for 800 ms (the IO stalled), then goes on.
        scene.harness.clock.advance(seconds: 0.8)
        scene.frame += 38_400
        let resumedNs = scene.harness.clock.anchor().continuousNs
        scene.run(seconds: 1.5)
        _ = try scene.matrix()
        let events = Self.frames(scene)
        let after = try #require(events.first { $0.startNs >= resumedNs - 1_000_000 })
        #expect(after.startNs <= resumedNs + 20_000_000, "\(after.startNs) after \(resumedNs)")
        let before = events.filter { $0.startNs < resumedNs }
        let end = (before.last?.startNs ?? 0) + UInt64(before.last?.levels.count ?? 0) * 10_000_000
        #expect(end <= resumedNs - 700_000_000)
    }

    @Test func noReferenceWhileTheMicrophoneOrSystemAudioIsOff() throws {
        let scene = try Scene(apps: [7_001: Self.sondine])
        let own = scene.process(pid: 7_001, bundleID: "app.sondine", source: "sondine", frequency: 300)
        scene.play(own)
        #expect(Self.selfTaps(scene) == 1)
        scene.harness.send(.pause(id: "p", scope: .systemAudio))
        #expect(Self.selfTaps(scene) == 0)
        scene.harness.send(.resume(id: "r", scope: .systemAudio))
        #expect(Self.selfTaps(scene) == 1)
        scene.harness.send(.pause(id: "m", scope: .microphone))
        scene.run(seconds: 0.3)
        #expect(Self.selfTaps(scene) == 0)
        scene.harness.send(.resume(id: "n", scope: .microphone))
        scene.run(seconds: 0.3)
        #expect(Self.selfTaps(scene) == 1)
    }

    @Test func turnedOffItNeverTaps() throws {
        let scene = try Scene(apps: [7_001: Self.sondine], options: { $0.selfPlayback = false })
        scene.play(scene.process(pid: 7_001, bundleID: "app.sondine", source: "sondine", frequency: 300))
        scene.run(seconds: 1)
        #expect(Self.selfTaps(scene) == 0)
        #expect(scene.harness.recorder.selfEnvelopes.isEmpty)
    }

    /// A device clock 0.5 % slower than the host's: over a minute, counting samples would place
    /// the last frames 300 ms early; each event follows its blocks' own timestamps instead.
    @Test func eventsFollowTheBlocksClockNotTheSampleCount() throws {
        let clock = ManualClock()
        let rate = 48_000.0
        let block = 4_096
        let stretch = 1.005
        let start = clock.anchor().hostTicks
        let context = IOCaptureContext(rate: rate, ringSeconds: 30, timebase: clock.timebase)
        let reference = SelfPlaybackReference(nominalRate: rate, context: context, clock: clock)
        let tone = [Float](repeating: 0.05, count: block)
        var events: [SelfEnvelopeEvent] = []
        tone.withUnsafeBufferPointer { samples in
            for index in 0..<(Int(60 * rate) / block) {
                var buffer = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(
                    mNumberChannels: 1, mDataByteSize: UInt32(block * 4), mData: UnsafeMutableRawPointer(mutating: samples.baseAddress)
                ))
                var time = AudioTimeStamp()
                time.mHostTime = start + UInt64(Double(index * block) / rate * stretch * 1e9)
                time.mFlags = .hostTimeValid
                context.ingest(&buffer, &time)
                for event in reference.drain() { if case .selfEnvelope(let envelope) = event { events.append(envelope) } }
            }
        }
        let last = try #require(events.last)
        let frames = events.dropLast().reduce(0) { $0 + $1.levels.count }
        // Where the last event's first frame was played, on the blocks' clock.
        let expected = Double(start) + Double(frames) * 0.01 * stretch * 1e9
        #expect(abs(Double(last.start.hostTicks.value) - expected) < 20_000_000, "\(last.start.hostTicks.value) against \(expected)")
    }

    /// A hold whose trigger came before it was processed (ADR 029): nothing played after the
    /// trigger that the helper still holds leaves it, neither the ring's blocks nor frames not
    /// sent yet. (Frames already sent stay in core's memory, unused: the microphone is held too.)
    @Test func aHoldsCutKeepsWhatWasPlayedAfterItInside() throws {
        let clock = ManualClock()
        let rate = 48_000.0
        let block = 4_096
        let start = clock.anchor()
        let context = IOCaptureContext(rate: rate, ringSeconds: 30, timebase: clock.timebase)
        let reference = SelfPlaybackReference(nominalRate: rate, context: context, clock: clock)
        let tone = [Float](repeating: 0.05, count: block)
        var events: [SelfEnvelopeEvent] = []
        func collect(_ sent: [HelperEvent]) {
            for event in sent { if case .selfEnvelope(let envelope) = event { events.append(envelope) } }
        }
        tone.withUnsafeBufferPointer { samples in
            for index in 0..<(Int(4 * rate) / block) {
                var buffer = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(
                    mNumberChannels: 1, mDataByteSize: UInt32(block * 4), mData: UnsafeMutableRawPointer(mutating: samples.baseAddress)
                ))
                var time = AudioTimeStamp()
                time.mHostTime = clock.anchor().hostTicks
                time.mFlags = .hostTimeValid
                context.ingest(&buffer, &time)
                clock.advance(seconds: Double(block) / rate)
                // Drained regularly for the first 1.2 s, then the hold is processed late.
                if index < Int(1.2 * rate) / block { collect(reference.drain()) }
            }
        }
        let cutNs = start.continuousNs + 1_500_000_000
        collect(reference.drain(cutNs: cutNs))
        if let last = reference.flush(cutNs: cutNs), case .selfEnvelope(let envelope) = last { events.append(envelope) }
        let end = try #require(events.last).start.continuousNs.value + UInt64(events.last?.levels.count ?? 0) * 10_000_000
        #expect(end <= cutNs, "\(end) after the cut \(cutNs)")
        #expect(end >= cutNs - 150_000_000)
    }

    /// What the reference costs the helper per minute of playback (drain, resampling to 16 kHz,
    /// envelope), printed for the bench note; the bound only catches a regression by an order
    /// of magnitude.
    @Test func theReferenceIsCheap() throws {
        let clock = ManualClock()
        let rate = 48_000.0
        let block = 4_096
        let seconds = 60
        let tone = (0..<block).map { Float(0.1 * sin(Double($0) * 2 * Double.pi * 300 / rate)) }
        let context = IOCaptureContext(rate: rate, ringSeconds: 30, timebase: clock.timebase)
        let reference = SelfPlaybackReference(nominalRate: rate, context: context, clock: clock)
        var blocks = 0
        var events = 0
        var cpuNs: UInt64 = 0
        let total = Int(Double(seconds) * rate) / block
        tone.withUnsafeBufferPointer { samples in
            for _ in 0..<total {
                var buffer = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(
                    mNumberChannels: 1, mDataByteSize: UInt32(block * 4), mData: UnsafeMutableRawPointer(mutating: samples.baseAddress)
                ))
                var time = AudioTimeStamp()
                time.mHostTime = clock.anchor().hostTicks
                time.mFlags = .hostTimeValid
                context.ingest(&buffer, &time)
                blocks += 1
                clock.advance(seconds: Double(block) / rate)
                if blocks % 3 == 0 {
                    let started = DispatchTime.now().uptimeNanoseconds
                    events += reference.drain().count
                    cpuNs += DispatchTime.now().uptimeNanoseconds - started
                }
            }
        }
        let perMinuteMs = Double(cpuNs) / 1e6 * 60 / Double(seconds)
        print("self:playback reference: \(String(format: "%.2f", perMinuteMs)) ms of CPU per minute of playback, \(events) events")
        #expect(events >= 55)
        #expect(perMinuteMs < 200)
    }
}
