@preconcurrency import AVFoundation
import Observation
import SondinePhone
import UniformTypeIdentifiers

/// Plays a recording the Mac holds (ADR 008, architecture §11): AVPlayer on
/// an asset whose bytes come from the Mac by ranges of at most 1 MiB, through
/// the pinned session, held in memory by the player and never written to disk.
@MainActor @Observable
final class MacPlayer {
    enum State: Equatable {
        case idle, loading, playing, paused
        /// The Mac's audio moved on (a passage deleted): the result is fetched again.
        case stale
        /// The Mac no longer has it (deleted, or taken by retention).
        case gone
        case failed
    }

    private(set) var state = State.idle
    private var player: AVPlayer?
    private var loader: MacAudioLoader?
    private var playing: (id: UUID, generation: Int)?
    private var ended: NSObjectProtocol?

    /// Plays from `offsetMs` into the Mac's audio, or from where it paused.
    func play(
        _ recordingId: UUID, audio: PhoneResultAudio, fromMs offsetMs: Int64? = nil,
        fetch: @escaping RemoteAudioReader.Fetch, failed: @escaping @MainActor (RemoteAudioRead) -> Void
    ) {
        if playing?.id != recordingId || playing?.generation != audio.generation || player == nil {
            stop()
            let loader = MacAudioLoader(fetch: fetch) { [weak self] read in
                Task { @MainActor in
                    guard let self else { return }
                    switch read {
                    case .refused(_, .stale): self.state = .stale
                    case .refused(_, .gone): self.state = .gone
                    default: self.state = .failed
                    }
                    self.player?.pause()
                    failed(read)
                }
            }
            var components = URLComponents()
            components.scheme = MacAudioLoader.scheme
            components.host = "recording"
            components.path = "/\(recordingId.wire)"
            components.queryItems = [URLQueryItem(name: "g", value: String(audio.generation))]
            guard let url = components.url else { return }
            let asset = AVURLAsset(url: url)
            asset.resourceLoader.setDelegate(loader, queue: MacAudioLoader.queue)
            let item = AVPlayerItem(asset: asset)
            // Nothing ahead of what plays is kept longer than needed.
            item.preferredForwardBufferDuration = 30
            let player = AVPlayer(playerItem: item)
            self.loader = loader
            self.player = player
            playing = (recordingId, audio.generation)
            ended = NotificationCenter.default.addObserver(
                forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.state = .paused }
            }
            state = .loading
        }
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        if let offsetMs {
            player?.seek(to: CMTime(value: max(offsetMs, 0), timescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero)
        }
        player?.play()
        state = .playing
    }

    func pause() {
        player?.pause()
        if state == .playing || state == .loading { state = .paused }
    }

    func stop() {
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        player = nil
        loader?.cancelAll()
        loader = nil
        playing = nil
        if let ended { NotificationCenter.default.removeObserver(ended) }
        ended = nil
        state = .idle
    }

    var isPlaying: Bool { state == .playing || state == .loading }

    /// Where playback is, in seconds from the audio's start: the player's bar.
    var position: Double {
        let seconds = player?.currentTime().seconds ?? 0
        return seconds.isFinite ? seconds : 0
    }
}

/// Answers AVFoundation's requests for the `sondine-mac:` asset: its type
/// (WAV), its length and byte-range access, and each range of bytes, read
/// from the Mac as they are asked and handed over as they come.
final class MacAudioLoader: NSObject, AVAssetResourceLoaderDelegate, @unchecked Sendable {
    static let scheme = "sondine-mac"
    static let queue = DispatchQueue(label: "app.sondine.ios.mac-audio")

    private let reader: RemoteAudioReader
    private let failed: @Sendable (RemoteAudioRead) -> Void
    /// The reads under way, by request; touched on `queue` only.
    private var tasks: [ObjectIdentifier: Task<Void, Never>] = [:]

    init(fetch: @escaping RemoteAudioReader.Fetch, failed: @escaping @Sendable (RemoteAudioRead) -> Void) {
        reader = RemoteAudioReader(fetch: fetch)
        self.failed = failed
    }

    /// A request crosses into the read's task; AVFoundation lets it be answered from any thread.
    private struct Pending: @unchecked Sendable {
        let request: AVAssetResourceLoadingRequest
    }

    func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader, shouldWaitForLoadingOfRequestedResource request: AVAssetResourceLoadingRequest
    ) -> Bool {
        let key = ObjectIdentifier(request)
        let pending = Pending(request: request)
        tasks[key] = Task { [weak self] in
            guard let self else { return }
            await serve(pending)
            Self.queue.async { [weak self] in self?.tasks[key] = nil }
        }
        return true
    }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader, didCancel request: AVAssetResourceLoadingRequest) {
        tasks.removeValue(forKey: ObjectIdentifier(request))?.cancel()
    }

    func cancelAll() {
        Self.queue.async { [self] in
            for task in tasks.values { task.cancel() }
            tasks.removeAll()
        }
    }

    private func serve(_ pending: Pending) async {
        let request = pending.request
        let data = request.dataRequest
        let offset = data?.requestedOffset ?? 0
        // Only the type and length asked: two bytes tell the length.
        let length: Int64? = data.map { $0.requestsAllDataToEndOfResource ? nil : Int64($0.requestedLength) } ?? 2
        var described = false
        let describe = { (total: Int64) in
            guard !described, let info = request.contentInformationRequest else { return }
            described = true
            info.contentType = UTType.wav.identifier
            info.contentLength = total
            info.isByteRangeAccessSupported = true
        }
        let outcome = await reader.read(from: offset, length: length) { piece, total in
            describe(total)
            data?.respond(with: piece)
            return !Task.isCancelled && !request.isCancelled
        }
        guard !request.isCancelled else { return }
        switch outcome {
        case let .success(total):
            describe(total)
            request.finishLoading()
        case let .failure(.failed(read)):
            failed(read)
            request.finishLoading(with: NSError(domain: "app.sondine.ios.mac-audio", code: 1))
        }
    }
}
