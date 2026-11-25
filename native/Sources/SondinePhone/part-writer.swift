@preconcurrency import AVFoundation
import CoreMedia
import Foundation

/// How a recording's audio is encoded (ADR 032): lossless unless the M5.1
/// measurement on real iPhone speech says AAC costs nothing.
public enum PhoneCodec: String, Sendable {
    case alac
    case aac
}

/// Sondine keeps audio at 16 kHz mono everywhere.
public let phoneSampleRate = 16_000

/// One file of a recording, being written.
public protocol PartWriter: AnyObject, Sendable {
    /// Appends 16 kHz mono samples; throws when the file cannot take them (a full disk).
    func append(_ samples: [Int16]) throws
    /// Closes the file so any reader sees all of it.
    func finish() async throws
}

public protocol PartWriterFactory: Sendable {
    func makeWriter(url: URL, header: PhoneRecordingHeader) throws -> any PartWriter
}

public enum PartWriterError: Error, Equatable {
    case cannotStart(String)
    case notReady
    case appendFailed(String)
    case finishFailed(String)
}

/// The app's writer: fragmented MPEG-4 audio (`.m4a`), a movie fragment every
/// 2 s, so a kill, a crash or an empty battery loses the last seconds only,
/// with the header in the comment tag before the first sample.
public final class AssetPartWriter: PartWriter, @unchecked Sendable {
    /// Seconds of audio per movie fragment: what a kill may lose.
    public static let fragmentSeconds = 2.0

    // Touched only by the recorder's actor, one call at a time.
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let format: CMAudioFormatDescription
    private var written: Int64 = 0

    public init(url: URL, header: PhoneRecordingHeader, codec: PhoneCodec) throws {
        do {
            writer = try AVAssetWriter(outputURL: url, fileType: .m4a)
        } catch {
            throw PartWriterError.cannotStart(String(describing: error))
        }
        let fragment = CMTime(seconds: Self.fragmentSeconds, preferredTimescale: 600)
        writer.movieFragmentInterval = fragment
        writer.initialMovieFragmentInterval = fragment
        let comment = AVMutableMetadataItem()
        comment.identifier = .iTunesMetadataUserComment
        comment.value = try header.json() as NSString
        writer.metadata = [comment]
        let settings: [String: Any] = switch codec {
        case .alac:
            [
                AVFormatIDKey: kAudioFormatAppleLossless, AVSampleRateKey: phoneSampleRate,
                AVNumberOfChannelsKey: 1, AVEncoderBitDepthHintKey: 16,
            ]
        case .aac:
            [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: phoneSampleRate,
                AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32_000,
            ]
        }
        input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { throw PartWriterError.cannotStart("input refused") }
        writer.add(input)
        var description = AudioStreamBasicDescription(
            mSampleRate: Double(phoneSampleRate), mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
            mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2, mChannelsPerFrame: 1,
            mBitsPerChannel: 16, mReserved: 0)
        var made: CMAudioFormatDescription?
        let status = CMAudioFormatDescriptionCreate(
            allocator: kCFAllocatorDefault, asbd: &description, layoutSize: 0, layout: nil,
            magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &made)
        guard status == noErr, let made else { throw PartWriterError.cannotStart("format \(status)") }
        format = made
        guard writer.startWriting() else {
            throw PartWriterError.cannotStart(String(describing: writer.error))
        }
        writer.startSession(atSourceTime: .zero)
    }

    public func append(_ samples: [Int16]) throws {
        guard !samples.isEmpty else { return }
        let bytes = samples.count * 2
        var block: CMBlockBuffer?
        var status = CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: bytes,
            blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
            dataLength: bytes, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
        guard status == noErr, let block else { throw PartWriterError.appendFailed("block \(status)") }
        status = samples.withUnsafeBytes { raw in
            CMBlockBufferReplaceDataBytes(
                with: raw.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes)
        }
        guard status == noErr else { throw PartWriterError.appendFailed("copy \(status)") }
        var buffer: CMSampleBuffer?
        status = CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format,
            sampleCount: samples.count,
            presentationTimeStamp: CMTime(value: written, timescale: CMTimeScale(phoneSampleRate)),
            packetDescriptions: nil, sampleBufferOut: &buffer)
        guard status == noErr, let buffer else { throw PartWriterError.appendFailed("buffer \(status)") }
        // In real time the input is almost always ready; give the encoder a moment when it is not.
        var waited = 0
        while !input.isReadyForMoreMediaData {
            guard writer.status == .writing, waited < 500 else { throw PartWriterError.notReady }
            usleep(2_000)
            waited += 1
        }
        guard input.append(buffer) else {
            throw PartWriterError.appendFailed(String(describing: writer.error))
        }
        written += Int64(samples.count)
    }

    public func finish() async throws {
        guard writer.status == .writing else {
            throw PartWriterError.finishFailed(String(describing: writer.error))
        }
        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else {
            throw PartWriterError.finishFailed(String(describing: writer.error))
        }
    }
}

public struct AssetPartWriterFactory: PartWriterFactory {
    public let codec: PhoneCodec
    public init(codec: PhoneCodec = .alac) { self.codec = codec }
    public func makeWriter(url: URL, header: PhoneRecordingHeader) throws -> any PartWriter {
        try AssetPartWriter(url: url, header: header, codec: codec)
    }
}
