import Foundation
import SondineKit
import Testing
@testable import SondineCapture

/// App taps (ADR 026) on the fake HAL: each fake process plays its own tone, each tap delivers
/// the mix of what its scope covers, and the spool is read back. A source's energy on a track,
/// in seconds of its tone, gives the attribution confusion matrix.
@Suite struct AppTapsTests {
    static let mic = "BuiltInMicrophoneDevice"
    static let speakers = "BuiltInSpeakerDevice"

    static let music = AppBundle(bundleId: "com.apple.Music", name: "Music")
    static let yab = AppBundle(bundleId: "dev.serafim.fast", name: "Yab")
    static let discord = AppBundle(bundleId: "com.hnc.Discord", name: "Discord")
    static let podcasts = AppBundle(bundleId: "com.apple.podcasts", name: "Podcasts")
    static let sondine = AppBundle(bundleId: "app.sondine", name: "Sondine")
    static let sounds = AppBundle(bundleId: "com.apple.systemsoundserverd", name: nil)

    /// A fake Mac: apps resolved by pid, a 48 kHz timeline fed in 256 ms IO cycles.
    final class Scene {
        let harness: EngineHarness
        var frame: Int64 = 0
        private(set) var tones: [String: Double] = [:]

        init(
            apps: [Int32: AppBundle],
            cap: Int = 8,
            configure: (inout CaptureConfig) -> Void = { _ in },
            options: (inout CaptureOptions) -> Void = { _ in }
        ) throws {
            harness = try EngineHarness(introspection: FixtureIntrospection(rows: apps.mapValues { .init(app: $0) }), configure: options)
            var config = CaptureConfig()
            config.systemAudio.appTaps.enabled = true
            config.systemAudio.appTaps.max = cap
            configure(&config)
            harness.start(config)
        }

        var hal: FakeAudioHardware { harness.hal }
        var engine: CaptureEngine { harness.engine }
        var state: CaptureState { engine.state }

        /// A process object that plays `frequency` while its output runs; `source` names it in
        /// the matrix.
        @discardableResult
        func process(pid: Int32, bundleID: String?, source: String, frequency: Double) -> HALObjectID {
            let id = hal.addProcess(pid: pid, bundleID: bundleID)
            hal.setTone(id, .init(frequency: frequency, amplitude: 0.1))
            tones[source] = frequency
            harness.settle()
            return id
        }

        func play(_ id: HALObjectID, _ on: Bool = true, input: Bool = false) {
            hal.setProcessIO(id, input: input, output: on, inputDevices: input ? [AppTapsTests.mic] : [], outputDevices: on ? [AppTapsTests.speakers] : [])
            harness.settle()
        }

        /// `seconds` of IO for every started tap, drained at the helper's cadence.
        func run(seconds: Double) {
            let cycle = 12_288
            var left = Int((seconds * 48_000).rounded())
            while left > 0 {
                let frames = min(cycle, left)
                hal.deliverToTaps(startFrame: frame, frames: frames, hostTicks: harness.clock.nanoseconds)
                frame += Int64(frames)
                left -= frames
                harness.clock.advance(seconds: Double(frames) / 48_000)
                engine.drainNow()
            }
        }

        /// Seconds of each source's tone found on each track, from the spool.
        func matrix() throws -> [String: [String: Double]] {
            engine.stop()
            var result: [String: [String: Double]] = [:]
            let root = harness.directory.url.appending(path: "spool", directoryHint: .isDirectory)
            let keys = Set(harness.recorder.trackOpens.map(\.trackKey)).filter { !$0.hasPrefix("input:") }
            for key in keys {
                let samples = try AppTapsTests.pcm(root: root, trackKey: key)
                for (source, frequency) in tones {
                    let seconds = AppTapsTests.toneSeconds(samples, frequency: frequency, amplitude: 0.1)
                    if seconds > 0.05 { result[source, default: [:]][key] = seconds }
                }
            }
            return result
        }
    }

    // MARK: Spool analysis

    /// Every PCM16 sample a track's runs stored, run after run.
    static func pcm(root: URL, trackKey: String) throws -> [Float] {
        let directory = root.appending(path: SpoolLayout.trackDirectory(for: trackKey), directoryHint: .isDirectory)
        let files = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "pcm" }.sorted { $0.path < $1.path } ?? []
        var samples: [Float] = []
        for file in files {
            let data = try Data(contentsOf: file)
            data.withUnsafeBytes { raw in
                for value in raw.bindMemory(to: Int16.self) { samples.append(Float(Int16(littleEndian: value)) / 32_768) }
            }
        }
        return samples
    }

    /// Seconds of a tone of `amplitude` in `samples` (16 kHz): Goertzel power per 100 ms window
    /// (a whole number of cycles for tones on 10 Hz steps), against a full window of the tone.
    static func toneSeconds(_ samples: [Float], frequency: Double, amplitude: Float) -> Double {
        let window = 1_600
        let coefficient = 2 * cos(2 * Double.pi * frequency / 16_000)
        let full = pow(Double(amplitude) * Double(window) / 2, 2)
        var seconds = 0.0
        var start = 0
        while start + window <= samples.count {
            var previous = 0.0, before = 0.0
            for index in start..<(start + window) {
                let next = Double(samples[index]) + coefficient * previous - before
                before = previous
                previous = next
            }
            let power = previous * previous + before * before - coefficient * previous * before
            seconds += min(1, power / full) * 0.1
            start += window
        }
        return seconds
    }

    static func near(_ value: Double?, _ expected: Double, tolerance: Double = 0.6) -> Bool {
        guard let value else { return expected == 0 }
        return abs(value - expected) <= tolerance
    }

    // MARK: Scenarios

    @Test func oneAppPlayingHasItsOwnTrackAndNothingRunsInSilence() throws {
        let scene = try Scene(apps: [7_001: Self.music])
        let music = scene.process(pid: 7_001, bundleID: "com.apple.Music", source: "music", frequency: 300)
        // Nothing plays: no tap at all.
        scene.run(seconds: 2)
        #expect(scene.hal.taps.isEmpty)
        #expect(scene.state.systemRunId == nil)

        scene.play(music)
        scene.run(seconds: 10)
        #expect(scene.state.appTracks.map(\.bundleId) == ["com.apple.Music"])
        #expect(scene.state.systemRunId == nil)
        let matrix = try scene.matrix()
        #expect(Self.near(matrix["music"]?["app:com.apple.Music"], 10))
        #expect(matrix["music"]?["system:other"] == nil)
    }

    @Test func twoAppsAtOnceKeepTheirOwnSound() throws {
        let scene = try Scene(apps: [7_001: Self.music, 7_002: Self.yab])
        let music = scene.process(pid: 7_001, bundleID: "com.apple.Music", source: "music", frequency: 300)
        let yab = scene.process(pid: 7_002, bundleID: "dev.serafim.fast", source: "yab", frequency: 500)
        scene.play(music)
        scene.run(seconds: 4)
        scene.play(yab)
        scene.run(seconds: 8)
        let matrix = try scene.matrix()
        #expect(Self.near(matrix["music"]?["app:com.apple.Music"], 12))
        #expect(Self.near(matrix["yab"]?["app:dev.serafim.fast"], 8))
        #expect(matrix["music"]?["app:dev.serafim.fast"] == nil && matrix["yab"]?["app:com.apple.Music"] == nil)
        #expect(matrix["music"]?["system:other"] == nil && matrix["yab"]?["system:other"] == nil)
    }

    @Test func aCallAndAVideoBehindItStayApart() throws {
        let scene = try Scene(apps: [7_001: Self.discord, 7_002: Self.yab])
        let discord = scene.process(pid: 7_001, bundleID: "com.hnc.Discord", source: "call", frequency: 700)
        let yab = scene.process(pid: 7_002, bundleID: "dev.serafim.fast", source: "video", frequency: 500)
        scene.play(yab)
        scene.run(seconds: 5)
        scene.play(discord, input: true)
        scene.run(seconds: 10)
        let calls = scene.harness.recorder.all.compactMap { event -> CallEvent? in if case .call(let call) = event { call } else { nil } }
        #expect(calls.map(\.bundleId) == ["com.hnc.Discord"])
        let matrix = try scene.matrix()
        #expect(Self.near(matrix["call"]?["app:com.hnc.Discord"], 10))
        #expect(Self.near(matrix["video"]?["app:dev.serafim.fast"], 15))
        #expect(matrix["video"]?["app:com.hnc.Discord"] == nil && matrix["call"]?["app:dev.serafim.fast"] == nil)
    }

    @Test func appsOverTheCapShareSystemOtherAndACallTakesASlot() throws {
        let scene = try Scene(apps: [7_001: Self.music, 7_002: Self.yab, 7_003: Self.podcasts, 7_004: Self.discord], cap: 2)
        let music = scene.process(pid: 7_001, bundleID: "com.apple.Music", source: "music", frequency: 300)
        let yab = scene.process(pid: 7_002, bundleID: "dev.serafim.fast", source: "yab", frequency: 500)
        let podcasts = scene.process(pid: 7_003, bundleID: "com.apple.podcasts", source: "podcasts", frequency: 900)
        let discord = scene.process(pid: 7_004, bundleID: "com.hnc.Discord", source: "call", frequency: 700)
        scene.play(music)
        scene.play(yab)
        scene.play(podcasts)
        scene.run(seconds: 5)
        // The two first apps have the slots; the third plays on system:other.
        #expect(scene.state.appTracks.map(\.bundleId) == ["com.apple.Music", "dev.serafim.fast"])
        #expect(scene.state.systemRunId != nil)
        // A call takes the slot of the latest app, which goes back to system:other first.
        scene.play(discord, input: true)
        scene.run(seconds: 5)
        #expect(scene.state.appTracks.map(\.bundleId) == ["com.apple.Music", "com.hnc.Discord"])
        let matrix = try scene.matrix()
        #expect(Self.near(matrix["music"]?["app:com.apple.Music"], 10))
        #expect(Self.near(matrix["podcasts"]?["system:other"], 10))
        #expect(Self.near(matrix["call"]?["app:com.hnc.Discord"], 5))
        // Yab: its own track, then system:other. Nothing is lost: its tap runs on until
        // system:other has delivered for half a second, so that much is heard twice.
        let own = matrix["yab"]?["app:dev.serafim.fast"] ?? 0
        let rest = matrix["yab"]?["system:other"] ?? 0
        #expect(own >= 4.9 && rest >= 4.9 && own + rest <= 11.2)
    }

    @Test func aQuietAppThatStartsACallGetsItsTapBack() throws {
        let scene = try Scene(apps: [7_001: Self.discord])
        let discord = scene.process(pid: 7_001, bundleID: "com.hnc.Discord", source: "call", frequency: 700)
        scene.hal.setTone(discord, nil)
        scene.play(discord)
        scene.run(seconds: 121)
        #expect(scene.state.appTracks.isEmpty)
        // The call starts without its output stopping first.
        scene.hal.setTone(discord, .init(frequency: 700, amplitude: 0.1))
        scene.play(discord, input: true)
        scene.run(seconds: 4)
        #expect(scene.state.appTracks.map(\.bundleId) == ["com.hnc.Discord"])
        let matrix = try scene.matrix()
        #expect((matrix["call"]?["app:com.hnc.Discord"] ?? 0) >= 3.4)
    }

    @Test func aLowerCapReturnsTheLatestAppsToSystemOther() throws {
        let scene = try Scene(apps: [7_001: Self.music, 7_002: Self.yab, 7_003: Self.podcasts])
        scene.play(scene.process(pid: 7_001, bundleID: "com.apple.Music", source: "music", frequency: 300))
        scene.run(seconds: 1)
        scene.play(scene.process(pid: 7_002, bundleID: "dev.serafim.fast", source: "yab", frequency: 500))
        scene.run(seconds: 1)
        scene.play(scene.process(pid: 7_003, bundleID: "com.apple.podcasts", source: "podcasts", frequency: 900))
        scene.run(seconds: 1)
        #expect(scene.state.appTracks.count == 3)
        var config = CaptureConfig()
        config.systemAudio.appTaps.enabled = true
        config.systemAudio.appTaps.max = 1
        scene.harness.send(.config(id: "c2", config))
        scene.run(seconds: 2)
        #expect(scene.state.appTracks.map(\.bundleId) == ["com.apple.Music"])
        #expect(scene.state.systemRunId != nil)
        let matrix = try scene.matrix()
        #expect((matrix["podcasts"]?["system:other"] ?? 0) >= 1.4)
    }

    @Test func callFollowSkipsAnEchoReferenceForTheCallsMicrophone() throws {
        let hal = FakeAudioHardware.macBook()
        hal.addDevice(uid: "echo-ref", name: "Speaker reference", transport: "bltn", input: 1, output: 0, inputTerminal: "spkr")
        hal.addDevice(uid: "airpods", name: "AirPods", transport: "blue", input: 1, output: 2)
        let harness = try EngineHarness(hal: hal, introspection: FixtureIntrospection(rows: [7_001: .init(app: Self.discord), 7_002: .init(app: Self.discord)]))
        harness.start()
        let speaker = hal.addProcess(pid: 7_001, bundleID: "com.hnc.Discord")
        let voice = hal.addProcess(pid: 7_002, bundleID: "com.hnc.Discord")
        harness.settle()
        // An echo reference is no microphone to follow.
        hal.setProcessIO(speaker, input: true, output: true, inputDevices: ["echo-ref"], outputDevices: [Self.speakers])
        harness.settle()
        #expect(harness.engine.state.microphoneUid == Self.mic)
        // Another process of the call reads the headset: that one is followed.
        hal.setProcessIO(voice, input: true, output: false, inputDevices: ["airpods"])
        harness.settle()
        #expect(harness.engine.state.microphoneUid == "airpods")
    }

    @Test func aNewProcessOfATappedAppJoinsItsTrack() throws {
        let scene = try Scene(apps: [7_001: Self.yab, 7_002: Self.yab, 7_003: Self.yab])
        let main = scene.process(pid: 7_001, bundleID: "dev.serafim.fast", source: "page", frequency: 500)
        let gpu = scene.process(pid: 7_002, bundleID: "com.apple.WebKit.GPU", source: "gpu", frequency: 300)
        scene.play(main)
        scene.play(gpu)
        scene.run(seconds: 4)
        #expect(scene.state.appTracks.first?.objects == [main, gpu].sorted())
        let late = scene.process(pid: 7_003, bundleID: "com.apple.WebKit.GPU", source: "late", frequency: 900)
        scene.play(late)
        scene.run(seconds: 4)
        #expect(scene.state.appTracks.first?.objects == [main, gpu, late].sorted())
        #expect(scene.state.systemRunId == nil)
        let matrix = try scene.matrix()
        #expect(Self.near(matrix["page"]?["app:dev.serafim.fast"], 8))
        #expect(Self.near(matrix["late"]?["app:dev.serafim.fast"], 4))
        #expect(matrix["late"]?["system:other"] == nil)
    }

    @Test func silentOutputGoesBackToSystemOtherAndIsStillHeardThere() throws {
        let scene = try Scene(apps: [7_001: Self.music])
        let music = scene.process(pid: 7_001, bundleID: "com.apple.Music", source: "music", frequency: 300)
        scene.hal.setTone(music, nil)
        scene.play(music)
        scene.run(seconds: 121)
        // Two minutes of exact zeros: the app goes back to system:other, which keeps running
        // while its output stays open.
        #expect(scene.state.appTracks.isEmpty)
        #expect(scene.state.systemRunId != nil)
        let closes = scene.harness.recorder.trackCloses.filter { $0.trackKey == "app:com.apple.Music" }
        #expect(closes.map(\.reason) == [.tapReleased])
        // It plays again without restarting its output: system:other hears it, named after it.
        scene.hal.setTone(music, .init(frequency: 300, amplitude: 0.1))
        scene.run(seconds: 3)
        scene.engine.sync()
        let activity = scene.engine.queue.sync { scene.engine.activityEvent() }
        let system = try #require(activity.attribution.first { $0.trackKey == "system:other" })
        #expect(system.confidence == .singleActive && system.bundleId == "com.apple.Music")
        // Once its output stops and starts again, it has its own track again.
        scene.play(music, false)
        scene.play(music)
        scene.run(seconds: 2)
        #expect(scene.state.appTracks.map(\.bundleId) == ["com.apple.Music"])
        let matrix = try scene.matrix()
        #expect(Self.near(matrix["music"]?["system:other"], 3, tolerance: 0.7))
    }

    @Test func tapsEndAfterTheirAppStopsAndSystemOtherStopsWhenNothingPlays() throws {
        let scene = try Scene(apps: [7_001: Self.music])
        let music = scene.process(pid: 7_001, bundleID: "com.apple.Music", source: "music", frequency: 300)
        let stray = scene.process(pid: 7_050, bundleID: nil, source: "stray", frequency: 900)
        scene.play(music)
        scene.play(stray)
        scene.run(seconds: 3)
        #expect(scene.state.systemRunId != nil)
        scene.play(music, false)
        scene.play(stray, false)
        scene.run(seconds: 6)
        // system:other stops 5 s after nothing in its scope plays; the app tap 30 s after.
        #expect(scene.state.systemRunId == nil)
        #expect(scene.state.appTracks.map(\.bundleId) == ["com.apple.Music"])
        scene.run(seconds: 25)
        #expect(scene.state.appTracks.isEmpty)
        #expect(scene.hal.taps.isEmpty && scene.hal.aggregates.isEmpty)
        let matrix = try scene.matrix()
        #expect(Self.near(matrix["stray"]?["system:other"], 3))
        #expect(Self.near(matrix["music"]?["app:com.apple.Music"], 3))
    }

    @Test func sondineExcludedAppsAndAlertsGetNoTap() throws {
        let scene = try Scene(apps: [7_001: Self.sondine, 7_002: Self.music, 7_003: Self.sounds]) { config in
            config.excludedBundleIds = ["com.apple.Music"]
        }
        let own = scene.process(pid: 7_001, bundleID: "app.sondine", source: "sondine", frequency: 300)
        let excluded = scene.process(pid: 7_002, bundleID: "com.apple.Music", source: "music", frequency: 500)
        let alert = scene.process(pid: 7_003, bundleID: "com.apple.systemsoundserverd", source: "alert", frequency: 700)
        scene.play(own)
        scene.play(excluded)
        scene.play(alert)
        scene.run(seconds: 3)
        #expect(scene.state.appTracks.isEmpty)
        #expect(scene.state.systemRunId == nil)
        #expect(try scene.matrix().isEmpty)
    }

    @Test func pausingSystemAudioEndsEveryAppTrack() throws {
        let scene = try Scene(apps: [7_001: Self.music, 7_002: Self.yab])
        scene.play(scene.process(pid: 7_001, bundleID: "com.apple.Music", source: "music", frequency: 300))
        scene.play(scene.process(pid: 7_002, bundleID: "dev.serafim.fast", source: "yab", frequency: 500))
        scene.run(seconds: 2)
        #expect(scene.state.appTracks.count == 2)
        scene.harness.send(.pause(id: "p", scope: .systemAudio))
        #expect(scene.state.appTracks.isEmpty && scene.hal.taps.isEmpty)
        #expect(scene.harness.recorder.trackCloses.filter { $0.trackKey.hasPrefix("app:") }.allSatisfy { $0.reason == .paused })
        scene.harness.send(.resume(id: "r", scope: .systemAudio))
        #expect(scene.state.appTracks.count == 2)
    }

    @Test func snapshotsReplayAppTracksAndActivityNamesThem() throws {
        let scene = try Scene(apps: [7_001: Self.music])
        scene.play(scene.process(pid: 7_001, bundleID: "com.apple.Music", source: "music", frequency: 300))
        scene.run(seconds: 1)
        scene.harness.recorder.clear()
        scene.harness.send(.snapshot(id: "s"))
        let open = try #require(scene.harness.recorder.trackOpens.first { $0.trackKey == "app:com.apple.Music" })
        #expect(open.replyTo == "s")
        guard case .app(let source) = open.source else { Issue.record("not an app source"); return }
        #expect(source.bundleId == "com.apple.Music" && source.name == "Music")
        let activity = scene.engine.queue.sync { scene.engine.activityEvent() }
        let app = try #require(activity.attribution.first { $0.trackKey == "app:com.apple.Music" })
        #expect(app.confidence == .exact && app.bundleId == "com.apple.Music")
        let entry = try #require(scene.engine.queue.sync { scene.engine.processesEvent() }.processes.first { $0.pid == 7_001 })
        #expect(entry.trackKey == "app:com.apple.Music")
    }

    @Test func theMicrophoneFollowsACallHeadsetAndComesBack() throws {
        let hal = FakeAudioHardware.macBook()
        hal.addDevice(uid: "airpods", name: "AirPods", transport: "blue", input: 1, output: 2)
        let harness = try EngineHarness(hal: hal, introspection: FixtureIntrospection(rows: [7_001: .init(app: Self.discord)]))
        var config = CaptureConfig()
        config.systemAudio.appTaps.enabled = true
        harness.start(config)
        #expect(harness.engine.state.microphoneUid == Self.mic)
        let discord = hal.addProcess(pid: 7_001, bundleID: "com.hnc.Discord")
        hal.setProcessIO(discord, input: true, output: true, inputDevices: ["airpods"], outputDevices: ["airpods"])
        harness.settle()
        #expect(harness.engine.state.microphoneUid == "airpods")
        #expect(harness.engine.state.microphoneSelection == .callFollow)
        // The call ends: the headset stays 10 s, then the built-in microphone is back.
        hal.setProcessIO(discord, input: false, output: false)
        harness.settle()
        harness.clock.advance(seconds: 5)
        harness.engine.drainNow()
        #expect(harness.engine.state.microphoneUid == "airpods")
        harness.clock.advance(seconds: 6)
        harness.engine.drainNow()
        #expect(harness.engine.state.microphoneUid == Self.mic)
    }

    @Test func withoutAppTapsSystemOtherRunsAllTheTime() throws {
        let scene = try Scene(apps: [7_001: Self.music]) { $0.systemAudio.appTaps.enabled = false }
        let music = scene.process(pid: 7_001, bundleID: "com.apple.Music", source: "music", frequency: 300)
        scene.play(music)
        scene.run(seconds: 3)
        #expect(scene.state.appTracks.isEmpty)
        let matrix = try scene.matrix()
        #expect(Self.near(matrix["music"]?["system:other"], 3))
    }
}
