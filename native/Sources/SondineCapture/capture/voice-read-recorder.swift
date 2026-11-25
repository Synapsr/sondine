import Foundation
import SondineKit

/// The voice read (ADR 034): the user reads a short text aloud so Sondine learns their voice.
/// `sondine-audio read-voice` opens one microphone, chosen as the helper chooses it (the default
/// input from the allowlist, else the built-in one; never Bluetooth on its own), and hands its
/// audio at 16 kHz PCM16 mono to `write`, with the level of what each drain read. It is not part
/// of the capture engine: nothing reaches the spool, a region or an episode, and the helper's own
/// microphone is paused by core while it runs.
public final class VoiceReadRecorder: @unchecked Sendable {
    public struct Level: Sendable, Equatable {
        /// Audio written so far, in milliseconds.
        public var ms: Int
        /// Loudness of what this drain wrote, 0 to 1.
        public var rms: Float
        public var peak: Float
    }

    public struct RecorderError: Error, CustomStringConvertible {
        public let description: String
        init(_ description: String) { self.description = description }
    }

    private let hal: any AudioHardware
    private let write: ([Int16]) throws -> Void
    private var proc: HALIOProcHandle?
    private var context: IOCaptureContext?
    private var resampler = StreamResampler()
    private var rate: Double = 48_000
    private var scratch: [Float] = []
    public private(set) var writtenSamples: Int64 = 0

    public init(hal: any AudioHardware, write: @escaping ([Int16]) throws -> Void) {
        self.hal = hal
        self.write = write
    }

    /// Opens the microphone and starts its IO. Returns the device it opened.
    @discardableResult
    public func start() throws -> CatalogDevice {
        let devices = try hal.deviceIDs().compactMap { try? CatalogDevice(info: hal.deviceInfo($0)) }
        let decision = MicrophonePolicy.decide(devices: devices, defaultInput: try hal.defaultDevice(.input), pin: nil)
        guard let choice = decision.choice else {
            if case .none(let reason) = decision { throw RecorderError(reason) }
            throw RecorderError("No microphone is available.")
        }
        let device = choice.device
        rate = (try? hal.nominalSampleRate(device.id)) ?? device.info.nominalRate ?? 48_000
        let context = IOCaptureContext(rate: rate, ringSeconds: 10)
        let proc = try hal.createIOProc(device: device.id, inputOnly: true) { input, time in context.ingest(input, time) }
        do {
            try hal.startIO(proc)
        } catch {
            hal.destroyIOProc(proc)
            throw error
        }
        self.context = context
        self.proc = proc
        return device
    }

    /// Resamples and writes what the IO delivered since the last drain.
    public func drain() throws -> Level {
        guard let context else { return Level(ms: milliseconds, rms: 0, peak: 0) }
        var chunks: [ResampledChunk] = []
        var failure: Error?
        context.ring.read { view in
            let count = view.block.frameCount
            if scratch.count < count { scratch = [Float](repeating: 0, count: count) }
            scratch.withUnsafeMutableBufferPointer { view.copy(into: $0.baseAddress!) }
            do {
                let produced = try scratch.withUnsafeBufferPointer { buffer in
                    try resampler.process(
                        interleaved: UnsafeBufferPointer(rebasing: buffer.prefix(count)),
                        channelCount: 1,
                        inputRate: rate,
                        hostTicks: view.block.hostTicks,
                        droppedFramesBefore: view.block.droppedFramesBefore
                    )
                }
                chunks.append(contentsOf: produced)
            } catch {
                failure = error
            }
        }
        if let failure { throw failure }
        return try emit(chunks)
    }

    /// Stops the IO and writes what the resampler still holds.
    public func stop() throws -> Level {
        if let proc {
            hal.stopIO(proc)
            hal.destroyIOProc(proc)
        }
        proc = nil
        var level = try drain()
        if let tail = try resampler.flush() { level = try emit([tail]) }
        context = nil
        return level
    }

    private var milliseconds: Int { Int(writtenSamples * 1000 / Int64(StreamResampler.outputRate)) }

    private func emit(_ chunks: [ResampledChunk]) throws -> Level {
        var sum: Double = 0
        var peak: Float = 0
        var count = 0
        for chunk in chunks where !chunk.samples.isEmpty {
            for value in chunk.samples {
                sum += Double(value) * Double(value)
                peak = max(peak, abs(value))
            }
            count += chunk.samples.count
            try write(PCM16.convert(chunk.samples).samples)
            writtenSamples += Int64(chunk.samples.count)
        }
        let rms = count == 0 ? 0 : Float((sum / Double(count)).squareRoot())
        return Level(ms: milliseconds, rms: min(1, rms), peak: min(1, peak))
    }
}
