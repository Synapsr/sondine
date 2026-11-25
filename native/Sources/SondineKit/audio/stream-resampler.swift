import Accelerate
@preconcurrency import AVFAudio

/// 16 kHz mono output of the resampler.
public struct ResampledChunk: Sendable, Equatable {
    public var samples: [Float]
    /// Index of the first sample in the 16 kHz output stream.
    public var firstSampleIndex: Int64
    /// Host time of the first sample, derived from the input block timestamps.
    public var firstSampleHostTicks: UInt64

    public var endSampleIndex: Int64 { firstSampleIndex + Int64(samples.count) }
}

public enum ResamplerError: Error, Equatable {
    case unsupportedFormat(rate: Double, channels: Int)
    case conversionFailed(String)
}

/// Downmixes interleaved Float32 blocks to mono and resamples them to 16 kHz with
/// `AVAudioConverter`. The converter is rebuilt (after flushing its tail) whenever the input
/// rate or channel count changes; 16 kHz input bypasses it.
///
/// Not thread-safe: owned by one drain worker.
public final class StreamResampler {
    public static let outputRate: Double = 16_000

    public let timebase: HostTimebase
    public let quality: AVAudioQuality
    public private(set) var inputRate: Double?
    public private(set) var inputChannels: Int?
    /// Converter rebuilds after the first configuration (rate changes).
    public private(set) var rebuildCount = 0
    /// Index of the next output sample.
    public private(set) var nextOutputIndex: Int64

    private var converter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?
    private let outputFormat: AVAudioFormat
    private var inputBuffer: AVAudioPCMBuffer?
    private var outputBuffer: AVAudioPCMBuffer?
    private var mono: [Float] = []

    // Timeline of the current converter: input frames consumed, output index at build time,
    // and the most recent block anchor (input frame position, host ticks).
    private var segmentStartOutputIndex: Int64 = 0
    private var segmentInputFrames: Int64 = 0
    private var anchorInputFrame: Int64 = 0
    private var anchorHostTicks: UInt64 = 0
    private var gapCarry: Double = 0

    public init(firstOutputIndex: Int64 = 0, timebase: HostTimebase = .current, quality: AVAudioQuality = .high) {
        nextOutputIndex = firstOutputIndex
        self.timebase = timebase
        self.quality = quality
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: Self.outputRate, channels: 1, interleaved: false
        ) else {
            preconditionFailure("16 kHz mono Float32 is always a valid format")
        }
        outputFormat = format
    }

    /// Converts one block of interleaved frames.
    ///
    /// - Parameters:
    ///   - droppedFramesBefore: input frames lost right before this block; the converter state is
    ///     discarded and the output index advances by the lost duration.
    /// - Returns: zero, one or two chunks (the old converter's tail when it was rebuilt, then the
    ///   new output). Chunks are contiguous unless frames were dropped.
    public func process(
        interleaved samples: UnsafeBufferPointer<Float>,
        channelCount: Int,
        inputRate rate: Double,
        hostTicks: UInt64,
        droppedFramesBefore: UInt64 = 0
    ) throws -> [ResampledChunk] {
        guard channelCount > 0, rate >= 1_000, rate <= 768_000 else {
            throw ResamplerError.unsupportedFormat(rate: rate, channels: channelCount)
        }
        var chunks: [ResampledChunk] = []
        if droppedFramesBefore > 0 || rate != inputRate || channelCount != inputChannels {
            if let tail = try flush() { chunks.append(tail) }
            if droppedFramesBefore > 0 {
                let exact = Double(droppedFramesBefore) * Self.outputRate / (inputRate ?? rate) + gapCarry
                let whole = exact.rounded(.down)
                gapCarry = exact - whole
                nextOutputIndex += Int64(whole)
            }
            try configure(rate: rate, channels: channelCount)
        }

        let frameCount = samples.count / channelCount
        guard frameCount > 0 else { return chunks }
        downmix(samples, channels: channelCount, frames: frameCount)

        anchorInputFrame = segmentInputFrames
        anchorHostTicks = hostTicks
        segmentInputFrames += Int64(frameCount)

        if converter == nil {
            chunks.append(emit(mono, frames: frameCount))
        } else {
            let output = try convert(frames: frameCount, endOfStream: false)
            if !output.isEmpty { chunks.append(emit(output, frames: output.count)) }
        }
        return chunks
    }

    /// Drains the converter's remaining output (end of stream, gap, or rebuild).
    public func flush() throws -> ResampledChunk? {
        guard let converter else { return nil }
        let output = try convert(frames: 0, endOfStream: true)
        converter.reset()
        let chunk = output.isEmpty ? nil : emit(output, frames: output.count)
        // A reset converter starts a new timeline at the current output index.
        segmentStartOutputIndex = nextOutputIndex
        segmentInputFrames = 0
        anchorInputFrame = 0
        return chunk
    }

    /// Restarts at a new output index (new epoch), dropping converter state.
    public func reset(nextOutputIndex index: Int64) {
        converter?.reset()
        nextOutputIndex = index
        segmentStartOutputIndex = index
        segmentInputFrames = 0
        anchorInputFrame = 0
        gapCarry = 0
    }

    // MARK: Private

    private func configure(rate: Double, channels: Int) throws {
        inputChannels = channels
        segmentStartOutputIndex = nextOutputIndex
        segmentInputFrames = 0
        anchorInputFrame = 0
        // Same rate: the flushed converter (or the 16 kHz bypass) is reused.
        if rate == inputRate { return }
        if inputRate != nil { rebuildCount += 1 }
        inputRate = rate
        if rate == Self.outputRate {
            converter = nil
            inputFormat = nil
            return
        }
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false),
              let newConverter = AVAudioConverter(from: format, to: outputFormat)
        else {
            throw ResamplerError.unsupportedFormat(rate: rate, channels: channels)
        }
        newConverter.sampleRateConverterAlgorithm = AVSampleRateConverterAlgorithm_Normal
        newConverter.sampleRateConverterQuality = quality.rawValue
        converter = newConverter
        inputFormat = format
        inputBuffer = nil
    }

    private func downmix(_ samples: UnsafeBufferPointer<Float>, channels: Int, frames: Int) {
        if mono.count < frames { mono = [Float](repeating: 0, count: frames) }
        guard let source = samples.baseAddress else { return }
        mono.withUnsafeMutableBufferPointer { destination in
            guard let out = destination.baseAddress else { return }
            if channels == 1 {
                out.update(from: source, count: frames)
                return
            }
            vDSP_vclr(out, 1, vDSP_Length(frames))
            for channel in 0..<channels {
                vDSP_vadd(source + channel, vDSP_Stride(channels), out, 1, out, 1, vDSP_Length(frames))
            }
            var scale = 1 / Float(channels)
            vDSP_vsmul(out, 1, &scale, out, 1, vDSP_Length(frames))
        }
    }

    private func convert(frames: Int, endOfStream: Bool) throws -> [Float] {
        guard let converter, let inputFormat, let inputRate else { return [] }
        if frames > 0 {
            if (inputBuffer?.frameCapacity ?? 0) < AVAudioFrameCount(frames) {
                inputBuffer = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: AVAudioFrameCount(max(frames, 4_096)))
            }
            guard let inputBuffer, let destination = inputBuffer.floatChannelData?[0] else {
                throw ResamplerError.conversionFailed("cannot allocate input buffer")
            }
            mono.withUnsafeBufferPointer { source in
                if let base = source.baseAddress { destination.update(from: base, count: frames) }
            }
            inputBuffer.frameLength = AVAudioFrameCount(frames)
        }

        let expected = Int((Double(max(frames, 1)) * Self.outputRate / inputRate).rounded(.up)) + 256
        if (outputBuffer?.frameCapacity ?? 0) < AVAudioFrameCount(expected) {
            outputBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: AVAudioFrameCount(max(expected, 4_096)))
        }
        guard let outputBuffer, let outputData = outputBuffer.floatChannelData?[0] else {
            throw ResamplerError.conversionFailed("cannot allocate output buffer")
        }

        let feed = InputFeed(buffer: frames > 0 ? inputBuffer : nil, endOfStream: endOfStream)
        var result: [Float] = []
        while true {
            outputBuffer.frameLength = 0
            var conversionError: NSError?
            let status = converter.convert(to: outputBuffer, error: &conversionError) { _, status in
                feed.next(status)
            }
            if status == .error {
                throw ResamplerError.conversionFailed(conversionError?.localizedDescription ?? "unknown error")
            }
            let produced = Int(outputBuffer.frameLength)
            if produced > 0 {
                result.append(contentsOf: UnsafeBufferPointer(start: outputData, count: produced))
            }
            // `.haveData` with a full buffer means more output is waiting.
            if status != .haveData || produced < Int(outputBuffer.frameCapacity) { break }
        }
        return result
    }

    private func emit(_ samples: [Float], frames: Int) -> ResampledChunk {
        let first = nextOutputIndex
        let chunk = ResampledChunk(
            samples: Array(samples.prefix(frames)),
            firstSampleIndex: first,
            firstSampleHostTicks: hostTicks(forOutputIndex: first)
        )
        nextOutputIndex = first + Int64(frames)
        return chunk
    }

    private func hostTicks(forOutputIndex index: Int64) -> UInt64 {
        let rate = inputRate ?? Self.outputRate
        let inputPosition = Double(index - segmentStartOutputIndex) * rate / Self.outputRate
        let offsetSeconds = (inputPosition - Double(anchorInputFrame)) / rate
        let ticks = Int64(anchorHostTicks) + timebase.ticks(fromSeconds: offsetSeconds)
        return UInt64(max(0, ticks))
    }
}

/// Supplies one buffer per conversion call, then reports no data (or end of stream).
private final class InputFeed: @unchecked Sendable {
    private var buffer: AVAudioPCMBuffer?
    private let endOfStream: Bool

    init(buffer: AVAudioPCMBuffer?, endOfStream: Bool) {
        self.buffer = buffer
        self.endOfStream = endOfStream
    }

    func next(_ status: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer? {
        if let buffer {
            self.buffer = nil
            status.pointee = .haveData
            return buffer
        }
        status.pointee = endOfStream ? .endOfStream : .noDataNow
        return nil
    }
}
