import Foundation
import Synchronization
import Testing
@testable import SondineCapture

/// The voice read's recorder (ADR 034) on fake hardware: one microphone, as the helper picks it,
/// at 16 kHz PCM16, nothing kept but what it hands to its sink.
@Suite struct VoiceReadRecorderTests {
    /// A second of a 440 Hz tone at half scale, at `rate`.
    private func tone(rate: Double, seconds: Double = 1) -> [Float] {
        (0..<Int(rate * seconds)).map { 0.5 * Float(sin(2 * Double.pi * 440 * Double($0) / rate)) }
    }

    @Test func recordsTheMicrophoneAt16kHz() throws {
        let hal = FakeAudioHardware.macBook(rate: 48_000)
        let written = Mutex<[Int16]>([])
        let recorder = VoiceReadRecorder(hal: hal) { samples in written.withLock { $0 += samples } }
        let device = try recorder.start()
        #expect(device.uid == "BuiltInMicrophoneDevice")
        hal.deliver(toDevice: "BuiltInMicrophoneDevice", interleaved: tone(rate: 48_000), channels: 1, hostTicks: 1_000)
        let level = try recorder.drain()
        #expect(level.rms > 0.3 && level.rms < 0.4)
        #expect(level.peak > 0.45 && level.peak <= 0.5)
        let final = try recorder.stop()
        // A second in, about 16,000 samples out once the resampler is flushed.
        #expect(abs(Int(recorder.writtenSamples) - 16_000) < 100)
        #expect(final.ms >= 990 && final.ms <= 1_010)
        #expect(written.withLock { $0.count } == Int(recorder.writtenSamples))
        #expect(hal.startedInputs().isEmpty)
    }

    @Test func neverOpensABluetoothMicrophoneOnItsOwn() throws {
        let hal = FakeAudioHardware.macBook()
        hal.addDevice(uid: "airpods", name: "AirPods", transport: "blue", input: 1, output: 2)
        hal.setDefault(.input, uid: "airpods")
        let recorder = VoiceReadRecorder(hal: hal) { _ in }
        #expect(try recorder.start().uid == "BuiltInMicrophoneDevice")
        _ = try recorder.stop()
    }

    @Test func failsWithoutAMicrophone() {
        let hal = FakeAudioHardware()
        hal.addDevice(uid: "BuiltInSpeakerDevice", name: "Speakers", transport: "bltn", input: 0, output: 2)
        let recorder = VoiceReadRecorder(hal: hal) { _ in }
        #expect(throws: VoiceReadRecorder.RecorderError.self) { try recorder.start() }
    }
}
