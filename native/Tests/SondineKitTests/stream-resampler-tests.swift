import SondineKit
import Testing

@Suite struct StreamResamplerTests {
    let timebase = HostTimebase(numer: 125, denom: 3)

    /// Feeds `input` in 10 ms blocks and returns the concatenated output and the chunks.
    private func resample(
        _ input: [Float],
        rate: Double,
        channels: Int = 1,
        resampler: StreamResampler? = nil,
        startSeconds: Double = 1
    ) throws -> (output: [Float], chunks: [ResampledChunk]) {
        let converter = resampler ?? StreamResampler(timebase: timebase)
        let blockFrames = Int(rate / 100)
        var chunks: [ResampledChunk] = []
        var frame = 0
        let frames = input.count / channels
        while frame < frames {
            let count = min(blockFrames, frames - frame)
            let ticks = UInt64(timebase.ticks(fromSeconds: startSeconds + Double(frame) / rate))
            let produced = try input.withUnsafeBufferPointer { buffer in
                try converter.process(
                    interleaved: UnsafeBufferPointer(rebasing: buffer[frame * channels..<(frame + count) * channels]),
                    channelCount: channels,
                    inputRate: rate,
                    hostTicks: ticks
                )
            }
            chunks += produced
            frame += count
        }
        if resampler == nil, let tail = try converter.flush() { chunks.append(tail) }
        return (chunks.flatMap(\.samples), chunks)
    }

    @Test(arguments: [48_000.0, 44_100.0, 24_000.0, 16_000.0])
    func sineKeepsItsFrequencyAndStaysClean(rate: Double) throws {
        let input = Signal.sine(frequency: 1_000, rate: rate, seconds: 2, amplitude: 0.5)
        let (output, chunks) = try resample(input, rate: rate)
        #expect(abs(output.count - 32_000) <= 2)
        // Chunks are contiguous in the output index space.
        for (previous, next) in zip(chunks, chunks.dropFirst()) {
            #expect(previous.endSampleIndex == next.firstSampleIndex)
        }
        let middle = output[1_600..<(output.count - 1_600)]
        let frequency = Signal.frequency(middle, rate: 16_000)
        #expect(abs(frequency - 1_000) < 0.1, "frequency \(frequency) Hz at \(rate) Hz input")
        let thd = Signal.thdPlusNoiseDb(middle, rate: 16_000, frequency: frequency)
        #expect(thd < -100, "THD+N \(thd) dB at \(rate) Hz input")
        let peak = middle.map(abs).max() ?? 0
        #expect(abs(peak - 0.5) < 0.01)
    }

    @Test func sixteenKilohertzInputIsPassedThroughExactly() throws {
        let input = Signal.sine(frequency: 440, rate: 16_000, seconds: 0.5)
        let (output, _) = try resample(input, rate: 16_000)
        #expect(output == input)
    }

    @Test func stereoIsAveragedToMono() throws {
        let left = Signal.sine(frequency: 1_000, rate: 48_000, seconds: 1, amplitude: 0.4)
        var stereo = [Float](repeating: 0, count: left.count * 2)
        for (index, value) in left.enumerated() {
            stereo[index * 2] = value
            stereo[index * 2 + 1] = value
        }
        let (output, _) = try resample(stereo, rate: 48_000, channels: 2)
        let middle = output[1_600..<(output.count - 1_600)]
        #expect(abs((middle.map(abs).max() ?? 0) - 0.4) < 0.01)
        #expect(abs(Signal.frequency(middle, rate: 16_000) - 1_000) < 0.1)
    }

    @Test func outputIsTimeAlignedWithTheInput() throws {
        // A click at exactly 0.5 s must land at output sample 8000.
        var input = [Float](repeating: 0, count: 48_000)
        input[24_000] = 1
        let (output, chunks) = try resample(input, rate: 48_000)
        let peak = try #require(output.indices.max { abs(output[$0]) < abs(output[$1]) })
        #expect(abs(peak - 8_000) <= 1, "click at output sample \(peak)")
        // Each chunk's host time matches its first sample's input time within 1 ms.
        for chunk in chunks {
            let expected = 1 + Double(chunk.firstSampleIndex) / 16_000
            let actual = timebase.seconds(fromTicks: Int64(chunk.firstSampleHostTicks))
            #expect(abs(actual - expected) < 0.001)
        }
    }

    @Test func rateChangeMidStreamRebuildsAndKeepsTime() throws {
        let resampler = StreamResampler(timebase: timebase)
        let first = Signal.sine(frequency: 1_000, rate: 48_000, seconds: 1, amplitude: 0.5)
        // Same tone, phase-continuous in time, after the device switches to 44.1 kHz.
        let second = Signal.sine(frequency: 1_000, rate: 44_100, seconds: 1, amplitude: 0.5, start: 1)
        let (a, chunksA) = try resample(first, rate: 48_000, resampler: resampler, startSeconds: 1)
        let (b, chunksB) = try resample(second, rate: 44_100, resampler: resampler, startSeconds: 2)
        let tail = try resampler.flush()
        let output = a + b + (tail?.samples ?? [])
        let chunks = chunksA + chunksB + (tail.map { [$0] } ?? [])

        #expect(resampler.rebuildCount == 1)
        #expect(resampler.inputRate == 44_100)
        #expect(abs(output.count - 32_000) <= 4)
        for (previous, next) in zip(chunks, chunks.dropFirst()) {
            #expect(previous.endSampleIndex == next.firstSampleIndex)
        }
        let before = output[1_600..<14_400]
        let after = output[17_600..<30_400]
        for segment in [before, after] {
            #expect(abs(Signal.frequency(segment, rate: 16_000) - 1_000) < 0.1)
            #expect(Signal.thdPlusNoiseDb(segment, rate: 16_000, frequency: 1_000) < -100)
        }
        // The first chunk after the switch is stamped from the new block's host time.
        let switched = try #require(chunksB.first { $0.firstSampleIndex >= 16_000 })
        let expected = 1 + Double(switched.firstSampleIndex) / 16_000
        #expect(abs(timebase.seconds(fromTicks: Int64(switched.firstSampleHostTicks)) - expected) < 0.001)
    }

    @Test func droppedInputFramesAdvanceTheOutputIndex() throws {
        let resampler = StreamResampler(timebase: timebase)
        let block = Signal.sine(frequency: 500, rate: 48_000, seconds: 0.1)
        let before = try block.withUnsafeBufferPointer {
            try resampler.process(interleaved: $0, channelCount: 1, inputRate: 48_000, hostTicks: 1_000)
        }
        let flushedEnd = resampler.nextOutputIndex
        let after = try block.withUnsafeBufferPointer {
            try resampler.process(interleaved: $0, channelCount: 1, inputRate: 48_000, hostTicks: 2_000, droppedFramesBefore: 4_800)
        }
        #expect(before.count == 1)
        // The first chunk is the flushed tail; the next starts after the 100 ms hole.
        let tail = try #require(after.first)
        #expect(tail.firstSampleIndex == flushedEnd)
        let resumed = try #require(after.last)
        #expect(resumed.firstSampleIndex == tail.endSampleIndex + 1_600)
    }

    @Test func rejectsUnsupportedInput() {
        let resampler = StreamResampler()
        let samples: [Float] = [0]
        #expect(throws: ResamplerError.self) {
            try samples.withUnsafeBufferPointer {
                try resampler.process(interleaved: $0, channelCount: 0, inputRate: 48_000, hostTicks: 0)
            }
        }
    }
}

@Suite struct PCM16Tests {
    @Test func clampsAndGuardsNonFiniteValues() {
        let input: [Float] = [0, 0.5, -0.5, 1, -1, 1.5, -2, .nan, .infinity, -.infinity, 1e-9, 0.25]
        let (samples, stats) = PCM16.convert(input)
        #expect(samples.map { Int16(littleEndian: $0) } == [0, 16_384, -16_384, 32_767, -32_767, 32_767, -32_767, 0, 32_767, -32_767, 0, 8_192])
        #expect(stats.clipped == 4)
        #expect(stats.nonFinite == 3)
    }

    @Test func roundTripErrorIsBelowOneStep() {
        let input = Signal.sine(frequency: 997, rate: 16_000, seconds: 0.1, amplitude: 0.9)
        let (samples, stats) = PCM16.convert(input)
        #expect(stats == PCM16ConversionStats())
        let restored = samples.withUnsafeBufferPointer { PCM16.floats(fromLittleEndian: $0) }
        let error = zip(input, restored).map { abs($0 - $1) }.max() ?? 1
        #expect(error <= 0.5 / 32_767 + 1e-7)
    }

    @Test func bytesAreLittleEndian() {
        let (samples, _) = PCM16.convert([Float(0x0102) / 32_767])
        let bytes = samples.withUnsafeBytes { Array($0) }
        #expect(bytes == [0x02, 0x01])
    }
}
