import Foundation
import Testing
@testable import SondineCapture

/// The capture engine on the fake HAL: discovery, microphone selection and rebuilds, the
/// `system:other` tap, the watchdog, pause, power and permissions. No hardware, no prompt.
@Suite(.serialized)
struct CaptureEngineTests {
    private static let mic = "BuiltInMicrophoneDevice"
    private static let usb = "AppleUSBAudioEngine:Generic:USB Microphone:1234:1"

    @Test func startSetsThePowerFlagsAndWaitsForAConfig() throws {
        let harness = try EngineHarness()
        harness.engine.start()
        #expect(harness.hal.sleepingAllowed == true)
        #expect(harness.hal.favorSavingPower == true)
        #expect(harness.hal.startedIOProcs.isEmpty)
        #expect(harness.hal.taps.isEmpty)

        harness.send(.config(id: "c2", CaptureConfig()))
        #expect(harness.recorder.acks("c2") == 1)
        #expect(harness.engine.state.microphoneUid == Self.mic)
        #expect(harness.engine.state.microphoneSelection == .automaticDefault)
        #expect(harness.hal.taps.count == 1)
        harness.engine.stop()
    }

    @Test func theIOBufferSizeIsExplicit() throws {
        let harness = try EngineHarness()
        harness.start()
        // 85 ms at 48 kHz rounds to 4096 frames.
        #expect(harness.hal.bufferFrames(uid: Self.mic) == 4_096)
        #expect(CaptureOptions().bufferFrames(rate: 44_100, range: 15...4_096) == 4_096)
        #expect(CaptureOptions().bufferFrames(rate: 16_000, range: 15...4_096) == 1_024)
        #expect(CaptureOptions().bufferFrames(rate: 48_000, range: 15...1_024) == 1_024)
        harness.engine.stop()
    }

    @Test func theSystemTapIsAPrivateUnmutedGlobalTapOnATapOnlyAggregate() throws {
        let harness = try EngineHarness()
        harness.start()
        let tap = try #require(harness.hal.taps.first)
        #expect(tap.description.isPrivate)
        #expect(tap.description.mono)
        guard case .globalExcluding = tap.description.scope else {
            Issue.record("system:other must be a global tap")
            return
        }
        let aggregate = try #require(harness.hal.aggregates.first)
        #expect(aggregate.description.isPrivate)
        #expect(!aggregate.description.tapAutoStart)
        #expect(aggregate.description.tapUIDs == [tap.uid])
        #expect(aggregate.description.uid.hasPrefix(DeviceCatalog.ownAggregatePrefix))
        // Our own aggregate is never offered as a device.
        #expect(!(harness.recorder.all.contains { event in
            if case .devices(let devices) = event { devices.devices.contains { $0.uid == aggregate.description.uid } } else { false }
        }))
        harness.engine.stop()
        #expect(harness.hal.taps.isEmpty)
        #expect(harness.hal.aggregates.isEmpty)
        #expect(harness.hal.ioProcs.isEmpty)
    }

    @Test func ownProcessesAreExcludedFromTheTap() throws {
        let harness = try EngineHarness()
        let own = harness.hal.addProcess(pid: getpid(), bundleID: "app.sondine.audio")
        let electron = harness.hal.addProcess(pid: 4_120, bundleID: "app.sondine.desktop")
        let music = harness.hal.addProcess(pid: 4_500, bundleID: "com.apple.Music")
        harness.start()
        #expect(harness.engine.state.systemExcludedObjects == [own])

        harness.send(.excludePids(id: "x", pids: [4_120]))
        #expect(harness.engine.state.systemExcludedObjects == [own, electron].sorted())
        let tap = try #require(harness.hal.taps.first)
        #expect(tap.description.scope == .globalExcluding([own, electron].sorted()))
        #expect(!harness.engine.state.systemExcludedObjects.contains(music))
        // The exclusion list changes in place: same tap, a source update on the open run.
        #expect(harness.hal.calls("createProcessTap") == 1)
        harness.engine.stop()
    }

    @Test func aFailedInPlaceExclusionUpdateRebuildsTheTapBeforeTheAck() throws {
        let harness = try EngineHarness()
        let own = harness.hal.addProcess(pid: getpid(), bundleID: "app.sondine.audio")
        let electron = harness.hal.addProcess(pid: 4_120, bundleID: "app.sondine.desktop")
        harness.start()
        harness.feedSystem(seconds: 0.5, amplitude: 0.01)
        let run = harness.engine.state.systemRunId
        harness.hal.fail("updateProcessTap")
        harness.engine.handle(.excludePids(id: "x", pids: [4_120]))
        harness.engine.sync()
        // By the time of the ack, no tap runs without the exclusion.
        #expect(harness.recorder.acks("x") == 1)
        let tap = try #require(harness.hal.taps.first)
        #expect(harness.hal.taps.count == 1)
        #expect(tap.description.scope == .globalExcluding([own, electron].sorted()))
        #expect(harness.hal.calls("createProcessTap") == 2)
        #expect(harness.engine.state.systemExcludedObjects == [own, electron].sorted())
        #expect(harness.engine.state.systemRunId == run)
        #expect(harness.recorder.trackUpdates.last { $0.reason == .source }?.source == .system(SystemSource(excludedObjectIds: [own, electron].sorted())))
        harness.engine.stop()
    }

    @Test func whenNoSafeTapCanBeBuiltSystemAudioStopsBeforeTheAck() throws {
        let harness = try EngineHarness()
        harness.hal.addProcess(pid: getpid(), bundleID: "app.sondine.audio")
        harness.hal.addProcess(pid: 4_120, bundleID: "app.sondine.desktop")
        harness.start()
        harness.feedSystem(seconds: 0.5, amplitude: 0.01)
        harness.hal.fail("updateProcessTap")
        harness.hal.fail("createProcessTap")
        harness.engine.handle(.excludePids(id: "x", pids: [4_120]))
        harness.engine.sync()
        #expect(harness.recorder.acks("x") == 1)
        #expect(harness.hal.taps.isEmpty)
        #expect(harness.hal.aggregates.isEmpty)
        #expect(harness.engine.state.systemRunId == nil)
        #expect(harness.recorder.trackCloses.last?.reason == .error)
        #expect(harness.recorder.errors.contains { $0.code == .captureFailed })
        harness.engine.stop()
    }

    @Test func aNewVADConfigurationReachesTheOpenRuns() throws {
        let harness = try EngineHarness()
        harness.start()
        harness.feedSystem(seconds: 0.5, amplitude: 0.01)
        harness.feedMicrophone(seconds: 0.5)
        var config = CaptureConfig()
        config.vad.threshold = 0.7
        config.vad.minSpeechMs = 300
        config.vad.minSilenceMs = 400
        harness.engine.handle(.config(id: "c2", config))
        harness.engine.sync()
        #expect(harness.recorder.acks("c2") == 1)
        for processor in [harness.engine.mic?.processor, harness.engine.system?.processor] {
            let parameters = try #require(processor?.detectionParameters)
            #expect(parameters.segmenter.onsetThreshold == 0.7)
            #expect(parameters.segmenter.minSpeechMs == 300)
            #expect(parameters.segmenter.minSilenceMs == 400)
        }
        // The runs go on.
        #expect(harness.recorder.trackCloses.isEmpty)
        harness.feedMicrophone(seconds: 0.5)
        harness.engine.stop()
        #expect(harness.recorder.trackCloses.first { $0.trackKey == "input:\(Self.mic)" }?.endSample == 16_000)
    }

    @Test func attributionIsRepublishedWhenTheRunOrTheExclusionsChange() throws {
        let harness = try EngineHarness()
        let music = harness.hal.addProcess(pid: 4_500, bundleID: "com.apple.Music")
        harness.hal.setProcessIO(music, input: false, output: true, outputDevices: ["BuiltInSpeakerDevice"])
        harness.start()
        harness.settle()
        func lastActivity() -> ActivityEvent? {
            harness.recorder.all.compactMap { if case .activity(let event) = $0, event.replyTo == nil { event } else { nil } }.last
        }
        // The system run opens on its first block: core learns who it is attributed to.
        harness.feedSystem(seconds: 0.5, amplitude: 0.01)
        harness.settle()
        let run = try #require(harness.engine.state.systemRunId)
        let opened = try #require(lastActivity()?.attribution.first)
        #expect(opened.runId == run)
        #expect(opened.confidence == .singleActive)
        #expect(opened.candidateObjectIds == [music])

        // Excluding Music changes the scope without any process IO change.
        harness.send(.excludePids(id: "x", pids: [4_500]))
        harness.settle()
        let excluded = try #require(lastActivity()?.attribution.first)
        #expect(excluded.candidateObjectIds.isEmpty)
        #expect(excluded.confidence == .ambiguous)
        harness.engine.stop()
    }

    @Test func discoveryIsListenerDrivenWithoutAPeriodicScan() throws {
        let harness = try EngineHarness()
        harness.start()
        let scans = harness.hal.calls("processObjectIDs")
        for _ in 0..<20 { harness.feedMicrophone(seconds: 0.25) }
        harness.engine.emitHealthNow()
        #expect(harness.hal.calls("processObjectIDs") == scans)

        // A process appears: read once, four listeners attached.
        let zoom = harness.hal.addProcess(pid: 7_001, bundleID: "us.zoom.xos")
        harness.settle()
        #expect(harness.hal.calls("processObjectIDs") == scans + 1)
        #expect(harness.hal.listenerCount(on: zoom) == 4)
        let infoReads = harness.hal.calls("processInfo")

        // Its IO changes: only its listeners fire, nothing is rescanned.
        harness.hal.setProcessIO(zoom, input: true, output: true, inputDevices: [Self.mic])
        harness.settle()
        harness.settle()
        #expect(harness.hal.calls("processObjectIDs") == scans + 1)
        #expect(harness.hal.calls("processInfo") == infoReads)
        let activity = harness.recorder.all.compactMap { if case .activity(let event) = $0 { event } else { nil } }.last
        #expect(activity?.running.first { $0.objectId == zoom }?.inputDeviceUids == [Self.mic])

        // It disappears: its listeners went with it, and the engine does not remove them again.
        harness.hal.removeProcess(zoom)
        harness.settle()
        #expect(harness.hal.listenerCount(on: zoom) == 0)
        #expect(harness.hal.calls("removeListener.gone") == 0)
        harness.engine.stop()
        #expect(harness.hal.calls("removeListener.gone") == 0)
    }

    @Test func callsFollowCallAppsAndDaemonsUsingTheMicrophone() throws {
        let zoomApp = AppBundle(bundleId: "us.zoom.xos", name: "zoom.us")
        let harness = try EngineHarness(introspection: FixtureIntrospection(rows: [7_001: .init(app: zoomApp)]))
        let calls = { harness.recorder.all.compactMap { event -> CallEvent? in if case .call(let call) = event { call } else { nil } } }
        harness.start()
        let zoom = harness.hal.addProcess(pid: 7_001, bundleID: "us.zoom.xos")
        let dictation = harness.hal.addProcess(pid: 950, bundleID: "com.apple.CoreSpeech")
        let facetime = harness.hal.addProcess(pid: 901, bundleID: "com.apple.avconferenced")
        harness.settle()

        // Dictation listens without being a call; Zoom's output alone is no call either.
        harness.hal.setProcessIO(dictation, input: true, output: false, inputDevices: [Self.mic])
        harness.hal.setProcessIO(zoom, input: false, output: true, outputDevices: ["BuiltInSpeakerDevice"])
        harness.settle()
        #expect(calls().isEmpty)

        harness.hal.setProcessIO(zoom, input: true, output: true, inputDevices: [Self.mic], outputDevices: ["BuiltInSpeakerDevice"])
        harness.settle()
        let started = try #require(calls().last)
        #expect(started.state == .active && started.bundleId == "us.zoom.xos" && started.via == .callApp)
        #expect(started.inputDeviceUid == Self.mic && started.replyTo == nil)

        // A snapshot replays the active call with the same id, after its clock (then dictation's
        // listen span, the call as seen, then the situation and the holds).
        harness.send(.snapshot(id: "s"))
        let replay = try #require(calls().last)
        #expect(replay.replyTo == "s" && replay.callId == started.callId && replay.at == started.at)
        let snapshotTypes = harness.recorder.all.filter { $0.replyTo == "s" }.map(\.type)
        #expect(Array(snapshotTypes.suffix(7)) == ["clock", "call", "listen", "call.seen", "situation", "holds", "ack"])

        // Fully paused: the call ends; resumed: a new span with a new id.
        harness.send(.pause(id: "p", scope: .all))
        #expect(calls().last?.state == .ended && calls().last?.callId == started.callId)
        harness.send(.resume(id: "r", scope: .all))
        let resumed = try #require(calls().last)
        #expect(resumed.state == .active && resumed.callId != started.callId)

        // A FaceTime call goes through its daemon.
        harness.hal.setProcessIO(facetime, input: true, output: true, inputDevices: [Self.mic], outputDevices: ["BuiltInSpeakerDevice"])
        harness.settle()
        #expect(calls().last?.bundleId == "com.apple.avconferenced" && calls().last?.via == .callDaemon)

        harness.hal.setProcessIO(zoom, input: false, output: false)
        harness.settle()
        #expect(calls().last?.state == .ended && calls().last?.callId == resumed.callId)

        // Shutting down ends what is still active, before the ack.
        harness.send(.shutdown(id: "x"))
        let ended = calls().filter { $0.state == .ended }.map(\.bundleId)
        #expect(ended == ["us.zoom.xos", "us.zoom.xos", "com.apple.avconferenced"])
        let active = Set(calls().filter { $0.state == .active }.map(\.callId))
        #expect(active == Set(calls().filter { $0.state == .ended }.map(\.callId)))
    }

    @Test func aBrowserIsACallOnlyWhileItAlsoPlaysSound() throws {
        let helium = AppBundle(bundleId: "net.imput.helium", name: "Helium")
        let harness = try EngineHarness(introspection: FixtureIntrospection(rows: [7_101: .init(app: helium), 7_102: .init(app: helium)]))
        let calls = { harness.recorder.all.compactMap { event -> CallEvent? in if case .call(let call) = event { call } else { nil } } }
        harness.start()
        let capture = harness.hal.addProcess(pid: 7_101, bundleID: "net.imput.helium")
        let playback = harness.hal.addProcess(pid: 7_102, bundleID: "net.imput.helium")
        harness.settle()

        // Dictation in a page: the microphone runs, nothing plays.
        harness.hal.setProcessIO(capture, input: true, output: false, inputDevices: [Self.mic])
        harness.settle()
        #expect(calls().isEmpty)

        // A web call: another process of the same browser plays the far side.
        harness.hal.setProcessIO(playback, input: false, output: true, outputDevices: ["BuiltInSpeakerDevice"])
        harness.settle()
        let started = try #require(calls().last)
        #expect(started.state == .active && started.bundleId == "net.imput.helium" && started.via == .browser)

        // The sound stops: the call ends.
        harness.hal.setProcessIO(playback, input: false, output: false)
        harness.settle()
        #expect(calls().last?.state == .ended && calls().last?.callId == started.callId)
        harness.engine.stop()
    }

    @Test func callsAreSeenWhilePausedAndNeverForAnExcludedApp() throws {
        let zoomApp = AppBundle(bundleId: "us.zoom.xos", name: "zoom.us")
        let privateApp = AppBundle(bundleId: "com.example.private", name: "Private")
        let harness = try EngineHarness(introspection: FixtureIntrospection(rows: [7_001: .init(app: zoomApp), 8_100: .init(app: privateApp)]))
        let calls = { harness.recorder.all.compactMap { event -> CallEvent? in if case .call(let call) = event { call } else { nil } } }
        let seen = { harness.recorder.all.compactMap { event -> CallSeenEvent? in if case .callSeen(let call) = event { call } else { nil } } }
        var config = CaptureConfig()
        config.excludedBundleIds = ["com.example.private"]
        harness.start(config)
        let zoom = harness.hal.addProcess(pid: 7_001, bundleID: "us.zoom.xos")
        let excluded = harness.hal.addProcess(pid: 8_100, bundleID: "com.example.private")
        harness.send(.pause(id: "p", scope: .all))
        harness.settle()

        // Paused: no call span, but the call is seen, with its app's name.
        harness.hal.setProcessIO(zoom, input: true, output: true, inputDevices: [Self.mic], outputDevices: ["BuiltInSpeakerDevice"])
        harness.hal.setProcessIO(excluded, input: true, output: true, inputDevices: [Self.mic], outputDevices: ["BuiltInSpeakerDevice"])
        harness.settle()
        #expect(calls().isEmpty)
        let started = try #require(seen().last)
        #expect(seen().count == 1)
        #expect(started.state == .active && started.bundleId == "us.zoom.xos" && started.name == "zoom.us" && started.via == .callApp)

        // Resumed: the call span starts, and the seen call goes on with the same id.
        harness.send(.resume(id: "r", scope: .all))
        #expect(calls().last?.state == .active)
        #expect(seen().count == 1)

        // A snapshot replays it with the same id.
        harness.send(.snapshot(id: "s"))
        #expect(seen().last?.replyTo == "s" && seen().last?.callId == started.callId)

        // Asleep, nothing is observed: the call is not said to end.
        harness.power.send(.willSleep)
        #expect(seen().last?.state == .active)
        harness.power.send(.didWake)
        harness.settle()
        // Wake settles asynchronously (0 s in tests); the excluded app's call holds the microphone.
        try waitUntil { harness.recorder.all.contains { if case .clock(let clock) = $0 { clock.reason == .wake } else { false } } }
        harness.settle()
        #expect(seen().last?.state == .active && seen().last?.callId == started.callId)

        // The call ends: both say so.
        harness.hal.setProcessIO(zoom, input: false, output: false)
        harness.settle()
        #expect(seen().last?.state == .ended && seen().last?.callId == started.callId)
        #expect(calls().last?.state == .ended)
        harness.engine.stop()
    }

    @Test func listenersAreTheAppsHoldingTheMicrophoneOutsideACall() throws {
        let hexApp = AppBundle(bundleId: "anomaly.hex", name: "Hex")
        let helium = AppBundle(bundleId: "net.imput.helium", name: "Helium")
        let excludedApp = AppBundle(bundleId: "com.example.private", name: "Private")
        let harness = try EngineHarness(introspection: FixtureIntrospection(rows: [
            8_001: .init(app: hexApp), 8_002: .init(app: hexApp),
            7_101: .init(app: helium), 7_102: .init(app: helium), 8_100: .init(app: excludedApp),
        ]))
        let listens = { harness.recorder.all.compactMap { event -> ListenEvent? in if case .listen(let listen) = event { listen } else { nil } } }
        let calls = { harness.recorder.all.compactMap { event -> CallEvent? in if case .call(let call) = event { call } else { nil } } }
        var config = CaptureConfig()
        config.excludedBundleIds = ["com.example.private"]
        harness.start(config)
        let hex = harness.hal.addProcess(pid: 8_001, bundleID: "anomaly.hex")
        let hexHelper = harness.hal.addProcess(pid: 8_002, bundleID: "anomaly.hex")
        let speech = harness.hal.addProcess(pid: 950, bundleID: "com.apple.CoreSpeech")
        let capture = harness.hal.addProcess(pid: 7_101, bundleID: "net.imput.helium")
        let playback = harness.hal.addProcess(pid: 7_102, bundleID: "net.imput.helium")
        let excluded = harness.hal.addProcess(pid: 8_100, bundleID: "com.example.private")
        harness.settle()

        // Hex dictates; an excluded app's microphone is never reported.
        harness.hal.setProcessIO(hex, input: true, output: false, inputDevices: [Self.mic])
        harness.hal.setProcessIO(excluded, input: true, output: false, inputDevices: [Self.mic])
        harness.settle()
        let dictation = try #require(listens().last)
        #expect(listens().count == 1)
        #expect(dictation.state == .active && dictation.bundleId == "anomaly.hex" && dictation.via == .app && dictation.replyTo == nil)

        // A second process of the same app joins, then the first stops: still one span.
        harness.hal.setProcessIO(hexHelper, input: true, output: false, inputDevices: [Self.mic])
        harness.settle()
        harness.hal.setProcessIO(hex, input: false, output: false)
        harness.settle()
        #expect(listens().count == 1)

        // The system's speech recognition listens too; a snapshot replays both after its clock.
        harness.hal.setProcessIO(speech, input: true, output: false, inputDevices: [Self.mic])
        harness.settle()
        #expect(listens().last?.bundleId == "com.apple.CoreSpeech" && listens().last?.via == .speech)
        harness.send(.snapshot(id: "s"))
        let snapshotTypes = harness.recorder.all.filter { $0.replyTo == "s" }.map(\.type)
        #expect(Array(snapshotTypes.suffix(6)) == ["clock", "listen", "listen", "situation", "holds", "ack"])
        let replay = listens().filter { $0.replyTo == "s" }
        #expect(replay.map(\.bundleId) == ["anomaly.hex", "com.apple.CoreSpeech"])
        #expect(replay.first?.listenId == dictation.listenId && replay.first?.at == dictation.at)

        // Dictation in a page listens; once the browser also plays sound, it is a call instead.
        harness.hal.setProcessIO(capture, input: true, output: false, inputDevices: [Self.mic])
        harness.settle()
        let page = try #require(listens().last)
        #expect(page.bundleId == "net.imput.helium" && page.state == .active)
        harness.hal.setProcessIO(playback, input: false, output: true, outputDevices: ["BuiltInSpeakerDevice"])
        harness.settle()
        #expect(listens().last?.listenId == page.listenId && listens().last?.state == .ended)
        #expect(calls().last?.bundleId == "net.imput.helium" && calls().last?.state == .active)
        #expect(listens().last?.at == calls().last?.at)

        // Hex lets go of the microphone: its span ends; taking it again is a new span.
        harness.hal.setProcessIO(hexHelper, input: false, output: false)
        harness.settle()
        #expect(listens().last?.listenId == dictation.listenId && listens().last?.state == .ended)
        harness.hal.setProcessIO(hex, input: true, output: false, inputDevices: [Self.mic])
        harness.settle()
        let again = try #require(listens().last)
        #expect(again.state == .active && again.listenId != dictation.listenId)

        // Fully paused: nothing is reported, so every span ends.
        harness.send(.pause(id: "p", scope: .all))
        let ended = Set(listens().filter { $0.state == .ended }.map(\.listenId))
        #expect(ended == Set(listens().filter { $0.state == .active }.map(\.listenId)))
        harness.engine.stop()
    }

    @Test func processesAreResolvedOncePerIncarnation() throws {
        let rows = ProcessResolverTests.rows
        let harness = try EngineHarness(introspection: FixtureIntrospection(rows: rows))
        harness.hal.addProcess(pid: 23_706, bundleID: "com.apple.WebKit.GPU")
        harness.hal.addProcess(pid: 901, bundleID: "com.apple.avconferenced")
        harness.start()
        harness.send(.snapshot(id: "s"))
        let processes = try #require(harness.recorder.all.compactMap { event -> ProcessesEvent? in
            if case .processes(let processes) = event, processes.replyTo == "s" { processes } else { nil }
        }.first)
        let gpu = try #require(processes.processes.first { $0.pid == 23_706 })
        #expect(gpu.app?.bundleId == "com.apple.Safari")
        #expect(gpu.mapping?.evidence == .responsibility)
        #expect(gpu.trackKey == "system:other")
        let facetime = try #require(processes.processes.first { $0.pid == 901 })
        #expect(facetime.mapping?.evidence == .daemonMap)
        #expect(facetime.app?.name == "FaceTime call")
        harness.engine.stop()
    }

    @Test func hotPlugAndDefaultChangesMoveTheMicrophone() throws {
        let harness = try EngineHarness()
        harness.start()
        harness.feedMicrophone(seconds: 0.5)
        #expect(harness.recorder.trackOpens.map(\.trackKey) == ["input:\(Self.mic)"])

        // A USB microphone is plugged in and becomes the default input.
        harness.hal.addDevice(uid: Self.usb, name: "USB Microphone", transport: "usb ", input: 1, output: 0)
        harness.hal.setDefault(.input, uid: Self.usb)
        harness.settle()
        #expect(harness.engine.state.microphoneUid == Self.usb)
        #expect(harness.recorder.trackCloses.last?.reason == .deviceChanged)
        harness.feedMicrophone(uid: Self.usb, seconds: 0.5)
        #expect(harness.recorder.trackOpens.last?.trackKey == "input:\(Self.usb)")

        // Unplugged: back to the built-in microphone; the run ends as removed.
        harness.hal.removeDevice(uid: Self.usb)
        harness.settle()
        #expect(harness.engine.state.microphoneUid == Self.mic)
        #expect(harness.recorder.trackCloses.last?.reason == .deviceRemoved)
        #expect(harness.hal.startedIOProcs.filter { $0.inputOnly }.count == 1)
        #expect(harness.hal.calls("removeListener.gone") == 0)
        harness.engine.stop()
    }

    @Test func aBluetoothDefaultIsNeverOpenedAutomatically() throws {
        let harness = try EngineHarness()
        harness.start()
        harness.recorder.clear()
        harness.hal.addDevice(uid: "airpods", name: "AirPods Pro", transport: "blue", input: 1, output: 2, rate: 24_000)
        harness.hal.setDefault(.input, uid: "airpods")
        harness.settle()
        #expect(harness.engine.state.microphoneUid == Self.mic)
        #expect(harness.recorder.warnings.contains { $0.code == "input.substituted" })
        #expect(!harness.hal.startedIOProcs.contains { $0.handle.device == harness.hal.deviceID(uid: "airpods") })

        // Pinned with consent, it opens; the pin is a hard override.
        harness.send(.pinInput(id: "p", deviceUid: "airpods", allowBluetooth: true))
        #expect(harness.engine.state.microphoneUid == "airpods")
        #expect(harness.engine.state.microphoneSelection == .pinned)
        harness.send(.pinInput(id: "p2", deviceUid: nil, allowBluetooth: false))
        #expect(harness.engine.state.microphoneUid == Self.mic)
        harness.engine.stop()
    }

    @Test func aRateChangeRebuildsTheResamplerBeforeTheDevice() throws {
        let harness = try EngineHarness()
        harness.start()
        for _ in 0..<8 { harness.feedMicrophone(seconds: 0.25) }
        let procs = harness.hal.calls("createIOProc")
        #expect(harness.engine.state.microphoneResamplerRebuilds == 0)

        harness.hal.setNominalRate(uid: Self.mic, rate: 44_100)
        harness.settle()
        #expect(harness.engine.state.microphoneNominalRate == 44_100)
        for _ in 0..<8 { harness.feedMicrophone(seconds: 0.25, rate: 44_100) }
        #expect(harness.engine.state.microphoneResamplerRebuilds == 1)
        #expect(harness.recorder.trackUpdates.contains { $0.reason == .rateChange && $0.nominalRate == 44_100 })
        // Signal kept flowing at the new rate: no device rebuild.
        #expect(harness.hal.calls("createIOProc") == procs)
        #expect(harness.recorder.trackCloses.isEmpty)
        harness.engine.stop()
    }

    @Test func exactZerosAfterARateChangeRestartTheMicrophoneIO() throws {
        let harness = try EngineHarness()
        harness.start()
        for _ in 0..<4 { harness.feedMicrophone(seconds: 0.25) }
        let procs = harness.microphoneIOProcs
        harness.hal.setNominalRate(uid: Self.mic, rate: 44_100)
        harness.settle()
        for _ in 0..<16 { harness.feedMicrophone(seconds: 0.25, rate: 44_100, amplitude: 0) }
        #expect(harness.microphoneIOProcs == procs + 1)
        #expect(harness.recorder.warnings.contains { $0.code == "input.rebuilt" })
        // Same run: the restart is a gap, not a new track run.
        #expect(harness.recorder.trackOpens.count == 1)
        harness.engine.stop()
    }

    @Test func aMicrophoneThatStopsCallingBackIsRestarted() throws {
        let harness = try EngineHarness()
        harness.start()
        for _ in 0..<4 { harness.feedMicrophone(seconds: 0.25) }
        let procs = harness.microphoneIOProcs
        // The device stops calling back, as the built-in microphone did when AirPods connected.
        harness.clock.advance(seconds: 3)
        harness.engine.drainNow()
        #expect(harness.recorder.trackUpdates.last?.stream == .stalled)
        #expect(harness.microphoneIOProcs == procs)
        harness.clock.advance(seconds: 2)
        harness.engine.drainNow()
        #expect(harness.microphoneIOProcs == procs + 1)
        #expect(harness.recorder.warnings.contains { $0.code == "input.rebuilt" && $0.message.contains("no IO") })
        // It calls back again: the same run goes on, the silence is a gap.
        for _ in 0..<4 { harness.feedMicrophone(seconds: 0.25) }
        #expect(harness.recorder.trackUpdates.last?.stream == .running)
        #expect(harness.recorder.trackOpens.count == 1)
        #expect(harness.recorder.trackCloses.isEmpty)
        harness.engine.stop()
    }

    @Test func aMutedMicrophoneIsNotRestartedForSilence() throws {
        let harness = try EngineHarness()
        harness.start()
        harness.feedMicrophone(seconds: 0.5)
        harness.send(.pause(id: "p", scope: .microphone))
        let procs = harness.microphoneIOProcs
        harness.clock.advance(seconds: 30)
        harness.engine.drainNow()
        #expect(harness.microphoneIOProcs == procs)
        harness.engine.stop()
    }

    @Test func serviceRestartedRebuildsEverything() throws {
        let harness = try EngineHarness()
        harness.start()
        harness.feedMicrophone(seconds: 0.5)
        harness.feedSystem(seconds: 0.5, amplitude: 0.01)
        let micBefore = try #require(harness.hal.deviceID(uid: Self.mic))

        harness.hal.restartService()
        harness.settle()
        let micAfter = try #require(harness.hal.deviceID(uid: Self.mic))
        #expect(micAfter != micBefore)
        #expect(Set(harness.recorder.trackCloses.map(\.reason)) == [.serviceRestarted])
        #expect(harness.recorder.trackCloses.count == 2)
        #expect(harness.recorder.warnings.contains { $0.code == "hal.service-restarted" })
        // New IOProc on the renumbered device, a new tap and aggregate, listeners registered again.
        #expect(harness.hal.startedIOProcs.contains { $0.handle.device == micAfter })
        #expect(harness.hal.taps.count == 1)
        #expect(harness.hal.aggregates.count == 1)
        #expect(harness.hal.listenerCount(on: micAfter) > 0)
        #expect(harness.hal.calls("removeListener.gone") == 0)

        // Capture resumes and a later change is still heard.
        harness.feedMicrophone(seconds: 0.5)
        #expect(harness.recorder.trackOpens.filter { $0.trackKey == "input:\(Self.mic)" }.count == 2)
        harness.hal.addDevice(uid: Self.usb, name: "USB Microphone", transport: "usb ", input: 1, output: 0)
        harness.hal.setDefault(.input, uid: Self.usb)
        harness.settle()
        #expect(harness.engine.state.microphoneUid == Self.usb)
        harness.engine.stop()
    }

    @Test func theZeroStallWatchdogRebuildsOnceThenReportsSuspect() throws {
        let harness = try EngineHarness()
        let music = harness.hal.addProcess(pid: 4_500, bundleID: "com.apple.Music")
        harness.start()
        harness.feedSystem(seconds: 1, amplitude: 0.01)
        harness.hal.setProcessIO(music, input: false, output: true, outputDevices: ["BuiltInSpeakerDevice"])
        harness.settle()

        // 14 s of exact zeros: not yet.
        for _ in 0..<14 { harness.feedSystem(seconds: 1) }
        #expect(harness.engine.state.systemRebuilds == 0)
        for _ in 0..<2 { harness.feedSystem(seconds: 1) }
        #expect(harness.engine.state.systemRebuilds == 1)
        #expect(harness.hal.calls("createProcessTap") == 2)
        #expect(harness.recorder.warnings.contains { $0.code == "tap.rebuilt" })
        #expect(harness.hal.taps.count == 1)

        // Another stall inside 5 min: reported, not rebuilt.
        for _ in 0..<20 { harness.feedSystem(seconds: 1) }
        #expect(harness.engine.state.systemRebuilds == 1)
        #expect(harness.engine.state.systemStream == .zeroSuspect)
        #expect(harness.recorder.warnings.contains { $0.code == "tap.zero-stall" })

        // Signal clears the suspicion.
        harness.feedSystem(seconds: 1, amplitude: 0.01)
        #expect(harness.engine.state.systemStream == .running)
        harness.engine.stop()
    }

    @Test func zerosWithoutOutputAreSilenceNotAStall() throws {
        let harness = try EngineHarness()
        harness.start()
        for _ in 0..<40 { harness.feedSystem(seconds: 1) }
        #expect(harness.engine.state.systemRebuilds == 0)
        #expect(harness.engine.state.systemStream == .running)
        harness.engine.stop()
    }

    @Test func silenceAfterASoundWhileTheAppKeepsOutputOpenIsNotAStall() throws {
        let harness = try EngineHarness()
        let chat = harness.hal.addProcess(pid: 4_600, bundleID: "com.example.chat")
        harness.start()
        harness.hal.setProcessIO(chat, input: false, output: true, outputDevices: ["BuiltInSpeakerDevice"])
        harness.settle()
        harness.feedSystem(seconds: 1, amplitude: 0.01)
        for _ in 0..<40 { harness.feedSystem(seconds: 1) }
        #expect(harness.engine.state.systemRebuilds == 0)
        #expect(harness.engine.state.systemStream == .running)

        // The same app starts output again and the tap hears nothing: a stall.
        harness.hal.setProcessIO(chat, input: false, output: false)
        harness.settle()
        harness.feedSystem(seconds: 1)
        harness.hal.setProcessIO(chat, input: false, output: true, outputDevices: ["BuiltInSpeakerDevice"])
        harness.settle()
        for _ in 0..<16 { harness.feedSystem(seconds: 1) }
        #expect(harness.engine.state.systemRebuilds == 1)
        harness.engine.stop()
    }

    @Test func aSuspectedStallClearsOnceNoOutputRuns() throws {
        let harness = try EngineHarness()
        let music = harness.hal.addProcess(pid: 4_500, bundleID: "com.apple.Music")
        harness.start()
        harness.hal.setProcessIO(music, input: false, output: true, outputDevices: ["BuiltInSpeakerDevice"])
        harness.settle()
        for _ in 0..<36 { harness.feedSystem(seconds: 1) }
        #expect(harness.engine.state.systemRebuilds == 1)
        #expect(harness.engine.state.systemStream == .zeroSuspect)

        harness.hal.setProcessIO(music, input: false, output: false)
        harness.settle()
        harness.feedSystem(seconds: 1)
        #expect(harness.engine.state.systemStream == .running)
        harness.engine.stop()
    }

    @Test func aPersistentStallIsReportedAgainAfterTheNextRebuild() throws {
        let harness = try EngineHarness()
        let music = harness.hal.addProcess(pid: 4_500, bundleID: "com.apple.Music")
        harness.start()
        harness.hal.setProcessIO(music, input: false, output: true, outputDevices: ["BuiltInSpeakerDevice"])
        harness.settle()
        var seconds = 0
        while harness.engine.state.systemRebuilds < 2, seconds < 400 {
            harness.feedSystem(seconds: 1)
            seconds += 1
        }
        #expect(harness.engine.state.systemRebuilds == 2)
        #expect(harness.engine.state.systemStream != .zeroSuspect)
        for _ in 0..<16 { harness.feedSystem(seconds: 1) }
        #expect(harness.engine.state.systemStream == .zeroSuspect)
        harness.engine.stop()
    }

    @Test func anotherAppStartingOutputMustBeHeardToo() throws {
        let harness = try EngineHarness()
        let chat = harness.hal.addProcess(pid: 4_600, bundleID: "com.example.chat")
        let music = harness.hal.addProcess(pid: 4_500, bundleID: "com.apple.Music")
        harness.start()
        harness.hal.setProcessIO(chat, input: false, output: true, outputDevices: ["BuiltInSpeakerDevice"])
        harness.settle()
        harness.feedSystem(seconds: 1, amplitude: 0.01)
        for _ in 0..<5 { harness.feedSystem(seconds: 1) }
        harness.hal.setProcessIO(music, input: false, output: true, outputDevices: ["BuiltInSpeakerDevice"])
        harness.settle()
        for _ in 0..<14 { harness.feedSystem(seconds: 1) }
        #expect(harness.engine.state.systemRebuilds == 0)
        for _ in 0..<2 { harness.feedSystem(seconds: 1) }
        #expect(harness.engine.state.systemRebuilds == 1)
        harness.engine.stop()
    }

    @Test func aBriefOutputFromAnotherAppDoesNotRearmTheWatchdog() throws {
        let harness = try EngineHarness()
        let chat = harness.hal.addProcess(pid: 4_600, bundleID: "com.example.chat")
        let sounds = harness.hal.addProcess(pid: 4_700, bundleID: "com.apple.systemsoundserverd")
        harness.start()
        harness.hal.setProcessIO(chat, input: false, output: true, outputDevices: ["BuiltInSpeakerDevice"])
        harness.settle()
        harness.feedSystem(seconds: 1, amplitude: 0.01)
        harness.hal.setProcessIO(sounds, input: false, output: true, outputDevices: ["BuiltInSpeakerDevice"])
        harness.settle()
        for _ in 0..<2 { harness.feedSystem(seconds: 1) }
        harness.hal.setProcessIO(sounds, input: false, output: false)
        harness.settle()
        for _ in 0..<40 { harness.feedSystem(seconds: 1) }
        #expect(harness.engine.state.systemRebuilds == 0)
        harness.engine.stop()
    }

    @Test func aSoundDrainedJustBeforeTheHALReportsItsOutputCounts() throws {
        let harness = try EngineHarness()
        let chat = harness.hal.addProcess(pid: 4_600, bundleID: "com.example.chat")
        harness.start()
        harness.feedSystem(seconds: 0.25, amplitude: 0.01)
        harness.hal.setProcessIO(chat, input: false, output: true, outputDevices: ["BuiltInSpeakerDevice"])
        harness.settle()
        harness.feedSystem(seconds: 0.25)
        for _ in 0..<40 { harness.feedSystem(seconds: 1) }
        #expect(harness.engine.state.systemRebuilds == 0)
        harness.engine.stop()
    }

    @Test func aSoundAfterARouteChangeProvesTheNewRoute() throws {
        let harness = try EngineHarness()
        let chat = harness.hal.addProcess(pid: 4_600, bundleID: "com.example.chat")
        harness.start()
        harness.hal.setProcessIO(chat, input: false, output: true, outputDevices: ["BuiltInSpeakerDevice"])
        harness.settle()
        harness.feedSystem(seconds: 1, amplitude: 0.01)
        harness.hal.setDataSource(uid: "BuiltInSpeakerDevice", scope: .output, code: "hdpn")
        harness.settle()
        harness.feedSystem(seconds: 1, amplitude: 0.01)
        for _ in 0..<10 { harness.feedSystem(seconds: 1) }
        #expect(harness.engine.state.systemRebuilds == 0)

        // Nothing heard since the next route change: zeros rebuild after 3 s.
        harness.hal.setDataSource(uid: "BuiltInSpeakerDevice", scope: .output, code: "ispk")
        harness.settle()
        for _ in 0..<4 { harness.feedSystem(seconds: 1) }
        #expect(harness.engine.state.systemRebuilds == 1)
        harness.engine.stop()
    }

    @Test func watchdogCountsZerosAfterASignalOnlyNearAnEvent() {
        var watchdog = CaptureWatchdog()
        func zeros(_ seconds: Int, from start: Double) -> [CaptureWatchdog.Action] {
            (1...seconds).map {
                watchdog.observe(allZero: true, seconds: 1, outputActiveInScope: true, rateMismatch: false, at: start + Double($0))
            }
        }
        // The HAL reports the output start a little after the first samples.
        _ = watchdog.observe(allZero: false, seconds: 0.25, outputActiveInScope: false, rateMismatch: false, at: 10)
        watchdog.latestOutputStart = 10.3
        #expect(zeros(40, from: 10.3).allSatisfy { $0 == .none })
        // Within 30 s of a route event, the same zeros rebuild after 3 s.
        watchdog.noteEvent(at: 60)
        #expect(zeros(3, from: 60).last == .rebuild(reason: "exact zeros while output is running"))
        // A rebuilt tap must hear something itself.
        watchdog.reset()
        #expect(zeros(15, from: 100).last == .reportSuspect)
    }

    @Test func watchdogRateLimitIsPerFiveMinutes() {
        var watchdog = CaptureWatchdog()
        var now = 0.0
        func zeros(_ seconds: Int) -> [CaptureWatchdog.Action] {
            (0..<seconds).map { _ in
                now += 1
                return watchdog.observe(allZero: true, seconds: 1, outputActiveInScope: true, rateMismatch: false, at: now)
            }
        }
        #expect(zeros(15).last == .rebuild(reason: "exact zeros while output is running"))
        #expect(zeros(15).last == .reportSuspect)
        now += 300
        #expect(zeros(15).last == .rebuild(reason: "exact zeros while output is running"))
        // After a route event the threshold drops to 3 s.
        now += 400
        watchdog.noteEvent(at: now)
        #expect(zeros(3).last == .rebuild(reason: "exact zeros while output is running"))
    }

    @Test func watchdogRestartsSilentIOWithADoublingWait() {
        var watchdog = CaptureWatchdog()
        // The last IO cycle was at 100 s.
        func silent(at now: Double) -> CaptureWatchdog.Action { watchdog.observeNoIO(seconds: now - 100, at: now) }
        #expect(silent(at: 104.9) == .none)
        #expect(silent(at: 105) == .rebuild(reason: "no IO for 5 s"))
        // Each restart that brings nothing doubles the wait: 10 s, 20 s, 40 s, 80 s, 160 s.
        #expect(silent(at: 114) == .none)
        #expect(silent(at: 115) == .rebuild(reason: "no IO for 15 s"))
        #expect(silent(at: 135) == .rebuild(reason: "no IO for 35 s"))
        #expect(silent(at: 175) == .rebuild(reason: "no IO for 75 s"))
        #expect(silent(at: 255) == .rebuild(reason: "no IO for 155 s"))
        #expect(silent(at: 415) == .rebuild(reason: "no IO for 315 s"))
        // Then every 5 min.
        #expect(silent(at: 714) == .none)
        #expect(silent(at: 715) == .rebuild(reason: "no IO for 615 s"))
        // IO again: the next silence restarts after 5 s.
        _ = watchdog.observe(allZero: false, seconds: 0.25, outputActiveInScope: false, rateMismatch: false, at: 800)
        #expect(watchdog.ioRestarts == 0)
        #expect(watchdog.observeNoIO(seconds: 5, at: 805) == .rebuild(reason: "no IO for 5 s"))
    }

    @Test func pauseMutesABuiltInMicrophoneAndStopsBluetoothIO() throws {
        let harness = try EngineHarness()
        harness.start()
        harness.feedMicrophone(seconds: 0.5)
        harness.send(.pause(id: "p", scope: .microphone))
        #expect(harness.hal.inputMuted)
        #expect(harness.engine.state.microphoneMuted)
        #expect(harness.hal.startedIOProcs.contains { $0.inputOnly })
        #expect(harness.recorder.trackCloses.last?.reason == .paused)
        harness.send(.resume(id: "r", scope: .microphone))
        #expect(!harness.hal.inputMuted)

        harness.hal.addDevice(uid: "airpods", name: "AirPods Pro", transport: "blue", input: 1, output: 2, rate: 24_000)
        harness.settle()
        harness.send(.pinInput(id: "pin", deviceUid: "airpods", allowBluetooth: true))
        harness.feedMicrophone(uid: "airpods", seconds: 0.5, rate: 24_000)
        harness.send(.pause(id: "p2", scope: .all))
        #expect(!harness.hal.inputMuted)
        #expect(harness.hal.startedIOProcs.isEmpty)
        #expect(harness.engine.state.paused == PausedState(microphone: true, systemAudio: true))
        harness.send(.resume(id: "r2", scope: .all))
        #expect(harness.engine.state.microphoneUid == "airpods")
        #expect(harness.hal.taps.count == 1)
        harness.engine.stop()
    }

    @Test func permissionsAreVerifiedByTheFirstNonZeroSample() throws {
        let harness = try EngineHarness()
        harness.start()
        harness.feedSystem(seconds: 1)
        #expect(harness.engine.state.permissions.systemAudio.status == .granted)
        harness.feedSystem(seconds: 1, amplitude: 0.01)
        #expect(harness.engine.state.permissions.systemAudio == PermissionState(status: .grantedVerified, evidence: .firstSignal))
        harness.feedMicrophone(seconds: 0.5)
        #expect(harness.engine.state.permissions.microphone.status == .grantedVerified)
        // A denial reported later wins over the verification.
        harness.permissions.set(microphone: PermissionState(status: .denied, evidence: .authorizationStatus))
        harness.engine.emitHealthNow()
        #expect(harness.engine.state.permissions.microphone.status == .denied)
        // Nothing here asked for a permission.
        #expect(harness.permissions.microphoneRequests == 0)
        harness.engine.stop()
    }

    @Test func aRevokedPermissionEndsTheRunUntilAccessIsBack() throws {
        let harness = try EngineHarness()
        harness.start()
        harness.feedMicrophone(seconds: 0.5)
        harness.feedSystem(seconds: 0.5, amplitude: 0.01)
        let micRun = try #require(harness.engine.state.microphoneRunId)
        let systemRun = try #require(harness.engine.state.systemRunId)
        // `tccutil reset` leaves "not determined": the running streams keep their signal, so
        // the verified runs go on.
        harness.permissions.set(
            microphone: PermissionState(status: .notDetermined, evidence: .authorizationStatus),
            systemAudio: PermissionState(status: .notDetermined, evidence: .tccPreflight)
        )
        harness.engine.emitHealthNow()
        #expect(harness.engine.state.microphoneRunId == micRun)
        #expect(harness.engine.state.systemRunId == systemRun)
        // Turned off in System Settings: both runs end with the reason, and nothing restarts.
        harness.permissions.set(
            microphone: PermissionState(status: .denied, evidence: .authorizationStatus),
            systemAudio: PermissionState(status: .denied, evidence: .tccPreflight)
        )
        harness.engine.emitHealthNow()
        #expect(harness.recorder.trackCloses.map(\.reason) == [.permission, .permission])
        #expect(harness.engine.state.microphoneRunId == nil)
        #expect(harness.engine.state.systemRunId == nil)
        #expect(harness.hal.startedIOProcs.isEmpty)
        #expect(harness.hal.taps.isEmpty)
        // Access given back: new runs start.
        harness.permissions.set(
            microphone: PermissionState(status: .granted, evidence: .authorizationStatus),
            systemAudio: PermissionState(status: .granted, evidence: .tccPreflight)
        )
        harness.engine.emitHealthNow()
        harness.feedMicrophone(seconds: 0.5)
        harness.feedSystem(seconds: 0.5, amplitude: 0.01)
        let newMicRun = try #require(harness.engine.state.microphoneRunId)
        let newSystemRun = try #require(harness.engine.state.systemRunId)
        #expect(newMicRun != micRun)
        #expect(newSystemRun != systemRun)
        harness.engine.stop()
    }

    @Test func aDeniedPermissionAtStartOpensNoRun() throws {
        let harness = try EngineHarness()
        harness.permissions.set(microphone: PermissionState(status: .denied, evidence: .authorizationStatus))
        harness.start()
        harness.feedSystem(seconds: 0.5, amplitude: 0.01)
        #expect(harness.engine.state.microphoneUid == nil)
        #expect(harness.engine.state.systemRunId != nil)
        #expect(harness.recorder.trackOpens.allSatisfy { $0.trackKey == TrackKeys.system })
        harness.engine.stop()
    }

    @Test func sleepClosesRunsAndWakeReopensThem() throws {
        let harness = try EngineHarness()
        harness.start()
        harness.feedMicrophone(seconds: 0.5)
        harness.power.send(.willSleep)
        #expect(harness.recorder.trackCloses.last?.reason == .sleep)
        #expect(harness.hal.startedIOProcs.isEmpty)
        harness.power.send(.didWake)
        harness.settle()
        // Wake settles asynchronously (0 s in tests).
        try waitUntil { harness.engine.state.microphoneUid != nil }
        #expect(harness.recorder.all.contains { if case .clock(let clock) = $0 { clock.reason == .wake } else { false } })
        harness.engine.stop()
    }

    @Test func speechOnTheMicrophoneHoldsIdleSleepUntilTheGap() throws {
        let harness = try EngineHarness { $0.inPersonGapSeconds = 5 }
        harness.start()
        for _ in 0..<12 { harness.feedMicrophone(seconds: 0.25, amplitude: 0.001) }
        for _ in 0..<12 { harness.feedMicrophone(seconds: 0.25, amplitude: 0.3) }
        #expect(!harness.recorder.regionOpens.isEmpty)
        #expect(harness.speechHold.isHeld)
        for _ in 0..<40 { harness.feedMicrophone(seconds: 0.25, amplitude: 0.001) }
        #expect(!harness.speechHold.isHeld)
        #expect(harness.speechHold.begins == 1)
        harness.engine.stop()
    }

    @Test func aDictationAppHoldingTheMicrophoneStillLetsInPersonSpeechHoldSleep() throws {
        let hexApp = AppBundle(bundleId: "anomaly.hex", name: "Hex")
        let zoomApp = AppBundle(bundleId: "us.zoom.xos", name: "zoom.us")
        let harness = try EngineHarness(
            introspection: FixtureIntrospection(rows: [8_001: .init(app: hexApp), 7_001: .init(app: zoomApp)])
        ) { $0.inPersonGapSeconds = 5 }
        harness.start()
        let hex = harness.hal.addProcess(pid: 8_001, bundleID: "anomaly.hex")
        harness.settle()
        // Hex keeps the microphone open between dictations.
        harness.hal.setProcessIO(hex, input: true, output: false, inputDevices: [Self.mic])
        harness.settle()
        for _ in 0..<12 { harness.feedMicrophone(seconds: 0.25, amplitude: 0.001) }
        for _ in 0..<12 { harness.feedMicrophone(seconds: 0.25, amplitude: 0.3) }
        #expect(!harness.recorder.regionOpens.isEmpty)
        #expect(harness.speechHold.isHeld)
        for _ in 0..<40 { harness.feedMicrophone(seconds: 0.25, amplitude: 0.001) }
        #expect(!harness.speechHold.isHeld)

        // In a call, the call app keeps the Mac awake: no hold of Sondine's own.
        let zoom = harness.hal.addProcess(pid: 7_001, bundleID: "us.zoom.xos")
        harness.settle()
        harness.hal.setProcessIO(zoom, input: true, output: true, inputDevices: [Self.mic], outputDevices: ["BuiltInSpeakerDevice"])
        harness.settle()
        for _ in 0..<12 { harness.feedMicrophone(seconds: 0.25, amplitude: 0.3) }
        #expect(!harness.speechHold.isHeld)
        #expect(harness.speechHold.begins == 1)
        harness.engine.stop()
    }

    @Test func snapshotRepliesWithStateAndAnAck() throws {
        let harness = try EngineHarness()
        harness.start()
        harness.feedMicrophone(seconds: 0.5)
        harness.send(.snapshot(id: "snap"))
        let replies = harness.recorder.all.filter { $0.replyTo == "snap" }.map(\.type)
        #expect(replies == ["permissions", "devices", "processes", "activity", "track.open", "clock", "situation", "holds", "ack"])
        harness.engine.stop()
    }

    @Test func everyEmittedEventEncodesToOneLine() throws {
        let harness = try EngineHarness()
        harness.start()
        for _ in 0..<12 { harness.feedMicrophone(seconds: 0.25, amplitude: 0.3) }
        harness.feedSystem(seconds: 1, amplitude: 0.01)
        harness.engine.emitHealthNow()
        harness.engine.emitClockNow()
        harness.send(.snapshot(id: "s"))
        harness.engine.stop()
        let events = harness.recorder.all
        #expect(Set(events.map(\.type)).isSuperset(of: ["devices", "processes", "track.open", "track.close", "commit", "health", "clock"]))
        for event in events {
            let line = try event.encodedLine()
            #expect(line.last == 0x0A)
            #expect(!line.dropLast().contains(0x0A))
            #expect(try JSONDecoder().decode(HelperEvent.self, from: line) == event)
        }
    }
}

func waitUntil(timeout: Double = 5, _ condition: () -> Bool) throws {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() {
        guard Date() < deadline else { throw WaitTimeout() }
        Thread.sleep(forTimeInterval: 0.01)
    }
}

struct WaitTimeout: Error {}

extension EngineHarness {
    /// IOProcs created for microphones: the tap's rebuilds left out (a tap the test does not
    /// feed is rebuilt for silence too).
    var microphoneIOProcs: Int { hal.calls("createIOProc") - engine.state.systemRebuilds }
}
