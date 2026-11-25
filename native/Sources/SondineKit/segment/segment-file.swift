@preconcurrency import AVFAudio
import Foundation

/// JSON written by `sondine-audio segment` (file mode, used by the bench).
public struct SegmentFileResult: Sendable, Equatable, Codable {
    public struct Input: Sendable, Equatable, Codable {
        public var path: String
        public var sampleRate: Double
        public var channels: Int
        public var frames: Int64
        public var durationMs: Double
    }

    public struct Output: Sendable, Equatable, Codable {
        public var sampleRate: Int
        public var samples: Int64
        public var durationMs: Double
    }

    public struct Region: Sendable, Equatable, Codable {
        public var index: Int
        public var startSample: Int64
        public var endSample: Int64
        public var startMs: Double
        public var endMs: Double
        public var speechStartSample: Int64
        public var speechEndSample: Int64
        public var speechStartMs: Double
        public var speechEndMs: Double
        public var voicedMs: Double
        public var maxProbability: Float
        public var meanProbability: Float
        public var splitBefore: Bool
        public var splitAfter: Bool
        public var closeReason: RegionCloseReason
        /// Power-mean and peak level (dBFS) of the 10 ms frames between the speech bounds.
        public var levelMeanDb: Float
        public var levelPeakDb: Float
    }

    public struct GateStats: Sendable, Equatable, Codable {
        public var frames: Int
        public var openFrames: Int
        public var openRatio: Double
        public var opens: Int
        public var digitalSilenceFrames: Int
        public var minimumFloorDb: Float?
        public var maximumFloorDb: Float?
        public var finalFloorDb: Float?
    }

    public struct VadStats: Sendable, Equatable, Codable {
        public var windows: Int
        public var evaluatedWindows: Int
        public var evaluatedRatio: Double
        public var speechWindows: Int
        public var resets: Int
        public var cpuMs: Double
        public var wallMs: Double
        /// VAD CPU seconds per hour of input audio (the always-on cost of this stage).
        public var cpuSecondsPerAudioHour: Double
        public var cpuMicrosPerEvaluatedWindow: Double
    }

    public struct RegionStats: Sendable, Equatable, Codable {
        public var count: Int
        public var totalMs: Double
        public var voicedMs: Double
        public var coverageRatio: Double
        public var rejectedBursts: Int
        public var splits: Int
    }

    public struct ResamplerStats: Sendable, Equatable, Codable {
        public var inputRate: Double
        public var bypassed: Bool
        public var clippedSamples: Int
        public var nonFiniteSamples: Int
    }

    public struct Stats: Sendable, Equatable, Codable {
        public var gate: GateStats
        public var vad: VadStats
        public var regions: RegionStats
        public var resampler: ResamplerStats
        public var envelopeFrames: Int
    }

    public struct Timing: Sendable, Equatable, Codable {
        public var decode: StageCost
        public var resample: StageCost
        public var envelope: StageCost
        public var gate: StageCost
        public var vad: StageCost
        public var segmenter: StageCost
        public var total: StageCost
    }

    public var schema = "sondine.segment-result"
    public var version = 1
    public var input: Input
    public var output: Output
    public var parameters: SpeechActivityParameters
    /// Nil in gate-only mode.
    public var vad: VoiceActivityDetectorInfo?
    public var regions: [Region]
    public var stats: Stats
    public var timing: Timing
}

public enum SegmentFileError: Error, CustomStringConvertible {
    case cannotOpen(String, String)
    case cannotRead(String)

    public var description: String {
        switch self {
        case .cannotOpen(let path, let reason): "cannot open \(path): \(reason)"
        case .cannotRead(let reason): "cannot read audio: \(reason)"
        }
    }
}

/// Runs the capture gate over an audio file exactly as the helper runs it on a track:
/// downmix and resample to 16 kHz, envelopes, energy gate, VAD, segmenter.
public enum SegmentFile {
    public static let readFrames: AVAudioFrameCount = 8_192

    public static func run(
        input url: URL,
        parameters: SpeechActivityParameters = SpeechActivityParameters(),
        detector: (any VoiceActivityDetector)?
    ) throws -> SegmentFileResult {
        var total = StageCost()
        var result = try total.measure { try process(url, parameters: parameters, detector: detector) }
        result.timing.total = total
        return result
    }

    private static func process(
        _ url: URL,
        parameters: SpeechActivityParameters,
        detector: (any VoiceActivityDetector)?
    ) throws -> SegmentFileResult {
        var decode = StageCost()
        var resample = StageCost()
        let path = url.path(percentEncoded: false)
        let file: AVAudioFile
        do {
            file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: true)
        } catch {
            throw SegmentFileError.cannotOpen(path, error.localizedDescription)
        }
        let format = file.processingFormat
        let channels = Int(format.channelCount)
        let rate = format.sampleRate
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: readFrames) else {
            throw SegmentFileError.cannotRead("cannot allocate a read buffer")
        }
        let timebase = HostTimebase.current
        let resampler = StreamResampler(timebase: timebase)
        let pipeline = SpeechActivityPipeline(parameters: parameters, detector: detector)
        var regions: [SpeechRegion] = []
        var pcmStats = PCM16ConversionStats()
        var framesRead: Int64 = 0

        func consume(_ chunks: [ResampledChunk]) throws {
            for chunk in chunks {
                // The spool stores PCM16; count what the conversion would clip, as the helper does.
                pcmStats += PCM16.convert(chunk.samples).stats
                let output = try pipeline.push(chunk.samples)
                regions += closed(output.events)
            }
        }

        while file.framePosition < file.length {
            do {
                try decode.measure { try file.read(into: buffer, frameCount: readFrames) }
            } catch {
                throw SegmentFileError.cannotRead(error.localizedDescription)
            }
            let frames = Int(buffer.frameLength)
            guard frames > 0, let data = buffer.floatChannelData?[0] else { break }
            let ticks = UInt64(timebase.ticks(fromSeconds: Double(framesRead) / rate))
            let chunks = try resample.measure {
                try resampler.process(
                    interleaved: UnsafeBufferPointer(start: data, count: frames * channels),
                    channelCount: channels,
                    inputRate: rate,
                    hostTicks: ticks
                )
            }
            framesRead += Int64(frames)
            try consume(chunks)
        }
        if let tail = try resample.measure({ try resampler.flush() }) { try consume([tail]) }
        regions += closed(try pipeline.finish())

        let statistics = pipeline.statistics
        let gateStatistics = pipeline.gate.statistics
        let segmenterStatistics = pipeline.segmenter.statistics
        let outputSamples = statistics.samples
        let audioHours = Double(outputSamples) / 16_000 / 3_600
        let regionRecords = regions.enumerated().map { index, region in record(index: index, region) }
        let totalRegionMs = regionRecords.reduce(0) { $0 + $1.endMs - $1.startMs }
        let outputMs = Double(outputSamples) / 16

        return SegmentFileResult(
            input: .init(
                path: path,
                sampleRate: rate,
                channels: channels,
                frames: framesRead,
                durationMs: Double(framesRead) / rate * 1_000
            ),
            output: .init(sampleRate: 16_000, samples: outputSamples, durationMs: outputMs),
            parameters: parameters,
            vad: detector?.info,
            regions: regionRecords,
            stats: .init(
                gate: .init(
                    frames: gateStatistics.frames,
                    openFrames: gateStatistics.openFrames,
                    openRatio: gateStatistics.openRatio,
                    opens: gateStatistics.opens,
                    digitalSilenceFrames: gateStatistics.digitalSilenceFrames,
                    minimumFloorDb: gateStatistics.minimumFloorDb,
                    maximumFloorDb: gateStatistics.maximumFloorDb,
                    finalFloorDb: gateStatistics.finalFloorDb
                ),
                vad: .init(
                    windows: statistics.windows,
                    evaluatedWindows: statistics.evaluatedWindows,
                    evaluatedRatio: statistics.evaluatedRatio,
                    speechWindows: statistics.speechWindows,
                    resets: statistics.vadResets,
                    cpuMs: statistics.vadCost.cpuMs,
                    wallMs: statistics.vadCost.wallMs,
                    cpuSecondsPerAudioHour: audioHours > 0 ? statistics.vadCost.cpuMs / 1_000 / audioHours : 0,
                    cpuMicrosPerEvaluatedWindow: statistics.vadCost.calls > 0
                        ? statistics.vadCost.cpuMs * 1_000 / Double(statistics.vadCost.calls) : 0
                ),
                regions: .init(
                    count: regionRecords.count,
                    totalMs: totalRegionMs,
                    voicedMs: regionRecords.reduce(0) { $0 + $1.voicedMs },
                    coverageRatio: outputMs > 0 ? totalRegionMs / outputMs : 0,
                    rejectedBursts: segmenterStatistics.rejectedBursts,
                    splits: segmenterStatistics.splits
                ),
                resampler: .init(
                    inputRate: rate,
                    bypassed: rate == StreamResampler.outputRate,
                    clippedSamples: pcmStats.clipped,
                    nonFiniteSamples: pcmStats.nonFinite
                ),
                envelopeFrames: statistics.envelopeFrames
            ),
            timing: .init(
                decode: decode,
                resample: resample,
                envelope: statistics.envelopeCost,
                gate: statistics.gateCost,
                vad: statistics.vadCost,
                segmenter: statistics.segmenterCost,
                total: StageCost()
            )
        )
    }

    public static func encode(_ result: SegmentFileResult) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(result)
    }

    private static func closed(_ events: [SegmenterEvent]) -> [SpeechRegion] {
        events.compactMap { event in
            if case .closed(let region) = event { region } else { nil }
        }
    }

    private static func record(index: Int, _ region: SpeechRegion) -> SegmentFileResult.Region {
        func ms(_ sample: Int64) -> Double { Double(sample) / 16 }
        return .init(
            index: index,
            startSample: region.startSample,
            endSample: region.endSample,
            startMs: ms(region.startSample),
            endMs: ms(region.endSample),
            speechStartSample: region.speechStartSample,
            speechEndSample: region.speechEndSample,
            speechStartMs: ms(region.speechStartSample),
            speechEndMs: ms(region.speechEndSample),
            voicedMs: ms(region.voicedSamples),
            maxProbability: region.maxProbability,
            meanProbability: region.meanProbability,
            splitBefore: region.splitBefore,
            splitAfter: region.splitAfter,
            closeReason: region.closeReason,
            levelMeanDb: region.level?.mean ?? LogEnergyEnvelope.floorDb,
            levelPeakDb: region.level?.peak ?? LogEnergyEnvelope.floorDb
        )
    }
}
