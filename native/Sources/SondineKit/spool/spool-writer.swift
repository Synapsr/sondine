import Foundation

/// Who wrote a track run's spool files (manifest header fields).
public struct SpoolIdentity: Sendable, Equatable {
    public var sessionId: UUID
    public var trackKey: String
    public var runId: UUID
    public var helperVersion: String

    public init(sessionId: UUID, trackKey: String, runId: UUID, helperVersion: String) {
        self.sessionId = sessionId
        self.trackKey = trackKey
        self.runId = runId
        self.helperVersion = helperVersion
    }
}

public struct SpoolConfiguration: Sendable, Equatable {
    /// Samples per commit: 2 s at 16 kHz (architecture §3).
    public var commitSamples = 32_000
    /// Run samples covered by one PCM file: 10 min at 16 kHz.
    public var rotationSamples: Int64 = 9_600_000
    public var syncMode = SpoolSyncMode.fsync
    /// While failed, retry after this many more samples arrived (10 s).
    public var retrySamples: Int64 = 160_000

    public init() {}
}

public enum SpoolFailure: Sendable, Equatable {
    case diskFull(String)
    case writeError(String)

    var gapReason: GapReason {
        switch self {
        case .diskFull: .diskFull
        case .writeError: .writeError
        }
    }
}

public enum SpoolWriterState: Sendable, Equatable {
    case writing
    /// Writing stopped; incoming samples are counted into a gap until a retry succeeds.
    case failed(SpoolFailure)
    case closed
}

/// A durable block, with the gaps recorded since the previous commit (the `commit` event).
public struct SpoolCommitEvent: Sendable, Equatable {
    /// PCM file relative to the spool root.
    public var file: String
    public var commit: ManifestCommit
    public var gaps: [ManifestGap]
}

public enum SpoolEvent: Sendable, Equatable {
    case fileOpened(file: String, header: ManifestHeader)
    case committed(SpoolCommitEvent)
    /// A gap made durable without a commit (at close, or when writing resumed).
    case gapRecorded(ManifestGap)
    /// Writing stopped (disk full or I/O error); samples from `lostFromSample` are not stored.
    /// Once per outage: retries that fail again stay silent.
    case failed(SpoolFailure, lostFromSample: Int64)
    /// A block was committed again; `gap` spans the whole outage (the manifest holds one gap
    /// record per failed attempt).
    case resumed(gap: ManifestGap)
}

/// Writes one track run to raw PCM16 16 kHz files with append-only JSON-lines manifests.
///
/// Commit protocol (architecture §3): write the block, sync the PCM file, append the commit
/// record (after any pending gap records), sync the manifest. Each PCM file covers
/// `rotationSamples` of run time and has its own manifest starting with a header.
///
/// Sample indices count time: lost samples (gaps) advance the index without bytes.
/// Not thread-safe: owned by the track's drain worker.
public final class SpoolWriter {
    public let root: URL
    public let runDirectory: String
    public let identity: SpoolIdentity
    public let configuration: SpoolConfiguration
    public private(set) var state = SpoolWriterState.writing
    public private(set) var epoch: UInt32
    /// Run index of the next sample to append.
    public private(set) var nextSampleIndex: Int64
    public private(set) var committedSamples: Int64 = 0

    private struct OpenFile {
        var sequence: Int64
        var name: String
        var startSample: Int64
        var data: SpoolFileHandle
        var manifest: SpoolFileHandle
        var dataLength: Int64 = 0
        var manifestLength: Int64 = 0
        var commits: Int64 = 0
        var endSample: Int64
    }

    private let fileSystem: any SpoolFileSystem
    private let clock: any HostClock
    private let directory: URL
    private var file: OpenFile?
    private var nextSequence: Int64 = 0
    /// Files of `nextSequence` created by an `ensureFile` that then failed.
    private var unfinishedFiles: Set<String> = []
    private var pending: [Int16] = []
    private var pendingStart: Int64
    private var anchors: [(offset: Int, hostTicks: UInt64)] = []
    /// Gaps not yet written to a manifest.
    private var unwrittenGaps: [ManifestGap] = []
    /// Gaps since the previous commit, reported with the next commit event.
    private var gapsSinceCommit: [ManifestGap] = []
    private var envelope: [EnvelopeFrame] = []
    private var regions: [ManifestRegion] = []
    private var failedFromSample: Int64 = 0
    /// First sample and reason of the current outage: set by its first failure, cleared by the
    /// first block committed after it. A retry that only stores its gap record does not end it.
    private var outage: (fromSample: Int64, reason: GapReason)?
    private var samplesSinceRetry: Int64 = 0

    public init(
        root: URL,
        identity: SpoolIdentity,
        epoch: UInt32,
        runDirectory: String? = nil,
        startSample: Int64 = 0,
        configuration: SpoolConfiguration = SpoolConfiguration(),
        fileSystem: any SpoolFileSystem = PosixSpoolFileSystem(),
        clock: any HostClock = MachHostClock()
    ) throws {
        precondition(configuration.commitSamples > 0 && configuration.rotationSamples > 0, "spool sizes must be positive")
        let runDirectory = runDirectory
            ?? SpoolLayout.runDirectory(trackKey: identity.trackKey, runId: identity.runId.uuidString.lowercased())
        try ManifestValidation.spoolPath(runDirectory)
        self.root = root
        self.identity = identity
        self.epoch = epoch
        self.runDirectory = runDirectory
        self.configuration = configuration
        self.fileSystem = fileSystem
        self.clock = clock
        nextSampleIndex = startSample
        pendingStart = startSample
        directory = root.appending(path: self.runDirectory, directoryHint: .isDirectory)
        try fileSystem.createDirectory(at: directory)
        // Each new directory entry is durable only once its parent is synced (root up to the run's parent).
        var parent = root
        try fileSystem.syncDirectory(at: parent)
        for component in self.runDirectory.split(separator: "/").dropLast() {
            parent = parent.appending(path: String(component), directoryHint: .isDirectory)
            try fileSystem.syncDirectory(at: parent)
        }
    }

    deinit {
        if let file {
            fileSystem.close(file.data)
            fileSystem.close(file.manifest)
        }
    }

    /// Appends PCM16 samples whose first sample was captured at `hostTicks`.
    public func append(_ samples: UnsafeBufferPointer<Int16>, firstSampleHostTicks hostTicks: UInt64) -> [SpoolEvent] {
        guard !samples.isEmpty else { return [] }
        var events: [SpoolEvent] = []
        switch state {
        case .closed:
            return []
        case .failed:
            samplesSinceRetry += Int64(samples.count)
            // The gap ends before these samples, so a successful retry stores them.
            if samplesSinceRetry >= configuration.retrySamples { events = retry() }
            guard state == .writing else {
                nextSampleIndex += Int64(samples.count)
                return events
            }
        case .writing:
            break
        }
        if pending.isEmpty { pendingStart = nextSampleIndex }
        anchors.append((pending.count, hostTicks))
        pending.append(contentsOf: samples)
        nextSampleIndex += Int64(samples.count)
        while state == .writing, pending.count >= blockLimit() {
            events += commitBlock(count: blockLimit())
        }
        return events
    }

    public func append(_ samples: [Int16], firstSampleHostTicks hostTicks: UInt64) -> [SpoolEvent] {
        samples.withUnsafeBufferPointer { append($0, firstSampleHostTicks: hostTicks) }
    }

    /// Converts Float32 samples (clamped, NaN-guarded) and appends them.
    public func append(floats samples: [Float], firstSampleHostTicks hostTicks: UInt64) -> (events: [SpoolEvent], stats: PCM16ConversionStats) {
        let converted = PCM16.convert(samples)
        return (append(converted.samples, firstSampleHostTicks: hostTicks), converted.stats)
    }

    /// Envelope frames are written with the next commit. While writing is failed they are
    /// dropped with the audio they describe.
    public func appendEnvelope(_ frames: [EnvelopeFrame]) {
        guard state == .writing else { return }
        envelope += frames
    }

    /// Closed regions are written to the manifest of the file current at the next commit.
    public func appendRegion(_ region: ManifestRegion) {
        guard state != .closed else { return }
        regions.append(region)
    }

    /// Records `lostSamples` missing samples at the current position (commits pending audio first).
    public func markGap(lostSamples: Int64, reason: GapReason) -> [SpoolEvent] {
        guard lostSamples > 0, state != .closed else { return [] }
        var events = flushPending()
        if state == .writing {
            let gap = ManifestGap(reason: reason, fromSample: nextSampleIndex, toSample: nextSampleIndex + lostSamples)
            unwrittenGaps.append(gap)
            gapsSinceCommit.append(gap)
        }
        nextSampleIndex += lostSamples
        if case .failed = state {
            samplesSinceRetry += lostSamples
            if samplesSinceRetry >= configuration.retrySamples { events += retry() }
        }
        return events
    }

    /// Replaces the samples not committed yet from `sampleIndex` on with digital silence, and
    /// their envelope frames with the floor: what a hold drops (ADR 029). Committed samples
    /// stay. Returns how many samples were silenced.
    @discardableResult
    public func silencePending(from sampleIndex: Int64) -> Int64 {
        guard state == .writing, !pending.isEmpty else { return 0 }
        let first = Int(max(0, min(Int64(pending.count), sampleIndex - pendingStart)))
        guard first < pending.count else { return 0 }
        for index in first..<pending.count { pending[index] = 0 }
        let frame = Int64(LogEnergyEnvelope.frameSamples)
        for index in envelope.indices where (envelope[index].index + 1) * frame > sampleIndex {
            envelope[index].db = LogEnergyEnvelope.floorDb
        }
        return Int64(pending.count - first)
    }

    /// Commits pending audio, then switches the epoch for later commits.
    public func beginEpoch(_ newEpoch: UInt32) -> [SpoolEvent] {
        let events = flushPending()
        epoch = newEpoch
        return events
    }

    /// Commits everything pending now (pause, shutdown, or a time-based flush).
    public func commit() -> [SpoolEvent] {
        flushPending()
    }

    /// Commits what is pending, writes trailing gaps and records, and closes the files.
    public func close() -> [SpoolEvent] {
        guard state != .closed else { return [] }
        var events: [SpoolEvent] = []
        switch state {
        case .writing:
            events += flushPending()
            if state == .writing, !unwrittenGaps.isEmpty || !envelope.isEmpty || !regions.isEmpty {
                let gaps = unwrittenGaps
                do {
                    try ensureFile(for: nextSampleIndex, events: &events)
                    try appendRecords(gaps.map(ManifestRecord.gap) + pendingRecords())
                    unwrittenGaps.removeAll()
                    events += gaps.map(SpoolEvent.gapRecorded)
                } catch {
                    events.append(.failed(Self.failure(from: error), lostFromSample: nextSampleIndex))
                }
            }
        case .failed:
            events += retry()
        case .closed:
            break
        }
        if let file {
            fileSystem.close(file.data)
            fileSystem.close(file.manifest)
            self.file = nil
        }
        state = .closed
        return events
    }

    // MARK: Private

    private func relative(_ name: String) -> String { "\(runDirectory)/\(name)" }

    /// Samples the next block may hold: the commit size, cut at the current file's end.
    private func blockLimit() -> Int {
        var limit = Int64(configuration.commitSamples)
        if let file, pendingStart < file.endSample {
            limit = min(limit, file.endSample - pendingStart)
        }
        return Int(limit)
    }

    private func flushPending() -> [SpoolEvent] {
        var events: [SpoolEvent] = []
        while state == .writing, !pending.isEmpty {
            events += commitBlock(count: min(pending.count, blockLimit()))
        }
        return events
    }

    private func ensureFile(for sample: Int64, events: inout [SpoolEvent]) throws {
        if let current = file, sample < current.endSample { return }
        if let current = file {
            fileSystem.close(current.data)
            fileSystem.close(current.manifest)
            file = nil
        }
        let sequence = nextSequence
        let name = SpoolLayout.fileName(sequence: sequence)
        let manifestURL = directory.appending(path: SpoolLayout.manifestName(sequence: sequence))
        let header = ManifestHeader(
            sessionId: identity.sessionId,
            trackKey: identity.trackKey,
            runId: identity.runId,
            epoch: epoch,
            file: name,
            sequence: sequence,
            startSample: sample,
            timebase: clock.timebase,
            anchor: clock.anchor(),
            helperVersion: identity.helperVersion
        )
        let headerLine = try ManifestRecord.header(header).encodedLine()
        // The manifest exists before its PCM file, so a PCM file is never orphaned.
        let manifest = try createOrReuse(manifestURL)
        let data: SpoolFileHandle
        do {
            try headerLine.withUnsafeBytes { try fileSystem.write($0, to: manifest, at: 0) }
            try fileSystem.sync(manifest, mode: configuration.syncMode)
            data = try createOrReuse(directory.appending(path: name))
            do {
                try fileSystem.syncDirectory(at: directory)
            } catch {
                fileSystem.close(data)
                throw error
            }
        } catch {
            fileSystem.close(manifest)
            throw error
        }
        unfinishedFiles.removeAll()
        nextSequence += 1
        file = OpenFile(
            sequence: sequence,
            name: name,
            startSample: sample,
            data: data,
            manifest: manifest,
            manifestLength: Int64(headerLine.count),
            endSample: sample + configuration.rotationSamples
        )
        events.append(.fileOpened(file: relative(name), header: header))
    }

    /// Creates a file of the next sequence, or empties the one a failed `ensureFile` left behind,
    /// so a retry keeps the same name instead of failing on the existing file.
    private func createOrReuse(_ url: URL) throws -> SpoolFileHandle {
        let path = url.path(percentEncoded: false)
        guard unfinishedFiles.contains(path) else {
            let handle = try fileSystem.createFile(at: url)
            unfinishedFiles.insert(path)
            return handle
        }
        let handle = try fileSystem.openFile(at: url)
        do {
            try fileSystem.truncate(handle, to: 0)
        } catch {
            fileSystem.close(handle)
            throw error
        }
        return handle
    }

    private func commitBlock(count: Int) -> [SpoolEvent] {
        var events: [SpoolEvent] = []
        do {
            try ensureFile(for: pendingStart, events: &events)
        } catch {
            return events + fail(error)
        }
        guard let current = file else { return events }
        let block = min(count, Int(current.endSample - pendingStart), pending.count)
        let bytes = pending.prefix(block).withUnsafeBytes { Data($0) }
        let crc = CRC32.checksum(bytes)
        let ticks = hostTicks(atPendingOffset: 0)
        let offset = current.dataLength
        do {
            try bytes.withUnsafeBytes { try fileSystem.write($0, to: current.data, at: offset) }
            try fileSystem.sync(current.data, mode: configuration.syncMode)
        } catch {
            try? fileSystem.truncate(current.data, to: offset)
            return events + fail(error)
        }
        let commit = ManifestCommit(
            seq: current.commits,
            epoch: epoch,
            committedOffset: offset + Int64(bytes.count),
            sampleIndex: pendingStart,
            sampleCount: Int64(block),
            crc32: crc,
            at: ManifestClockPoint(hostTicks: ticks, continuousNs: clock.continuousNanoseconds(forHostTicks: ticks))
        )
        let records = unwrittenGaps.map(ManifestRecord.gap) + [.commit(commit)] + pendingRecords()
        do {
            try appendRecords(records)
        } catch {
            // The block is not committed: cut it so the file ends at the last commit.
            try? fileSystem.truncate(current.data, to: offset)
            return events + fail(error)
        }
        // `appendRecords` advanced the manifest length on `file`; update it in place.
        file?.dataLength = commit.committedOffset
        file?.commits += 1
        committedSamples += Int64(block)
        consumePending(block)
        unwrittenGaps.removeAll()
        envelope.removeAll()
        regions.removeAll()
        let gaps = gapsSinceCommit
        gapsSinceCommit.removeAll()
        if let outage {
            self.outage = nil
            events.append(.resumed(gap: ManifestGap(reason: outage.reason, fromSample: outage.fromSample, toSample: commit.sampleIndex)))
        }
        events.append(.committed(SpoolCommitEvent(file: relative(current.name), commit: commit, gaps: gaps)))
        return events
    }

    /// Envelope runs (contiguous, at most 6000 frames each) and closed regions.
    private func pendingRecords() -> [ManifestRecord] {
        var records: [ManifestRecord] = []
        var run: [Float] = []
        var runStart: Int64 = 0
        var previous: Int64?
        func flush() {
            guard !run.isEmpty else { return }
            records.append(.envelope(ManifestEnvelope(sampleIndex: runStart * Int64(LogEnergyEnvelope.frameSamples), values: run)))
            run.removeAll()
        }
        for frame in envelope {
            if previous.map({ frame.index != $0 + 1 }) ?? true || run.count == SpoolFormat.maxEnvelopeFrames {
                flush()
                runStart = frame.index
            }
            run.append(max(LogEnergyEnvelope.floorDb, min(0, frame.db)))
            previous = frame.index
        }
        flush()
        return records + regions.map(ManifestRecord.region)
    }

    private func appendRecords(_ records: [ManifestRecord]) throws {
        guard var current = file, !records.isEmpty else { return }
        var bytes = Data()
        for record in records { bytes.append(try record.encodedLine()) }
        let offset = current.manifestLength
        do {
            try bytes.withUnsafeBytes { try fileSystem.write($0, to: current.manifest, at: offset) }
            try fileSystem.sync(current.manifest, mode: configuration.syncMode)
        } catch {
            // Drop a partial line so the next append starts on a line boundary.
            try? fileSystem.truncate(current.manifest, to: offset)
            throw error
        }
        current.manifestLength += Int64(bytes.count)
        file = current
    }

    private func consumePending(_ count: Int) {
        let consumedTicks = hostTicks(atPendingOffset: count)
        pending.removeFirst(count)
        pendingStart += Int64(count)
        anchors = anchors.filter { $0.offset > count }.map { ($0.offset - count, $0.hostTicks) }
        if !pending.isEmpty, anchors.first?.offset != 0 {
            anchors.insert((0, consumedTicks), at: 0)
        }
    }

    /// Host time of a pending sample, from the latest append anchor at or before it.
    private func hostTicks(atPendingOffset offset: Int) -> UInt64 {
        guard let anchor = anchors.last(where: { $0.offset <= offset }) else { return 0 }
        let seconds = Double(offset - anchor.offset) / Double(SpoolFormat.sampleRate)
        return anchor.hostTicks &+ UInt64(max(0, clock.timebase.ticks(fromSeconds: seconds)))
    }

    private func fail(_ error: any Error) -> [SpoolEvent] {
        let failure = Self.failure(from: error)
        state = .failed(failure)
        failedFromSample = pending.isEmpty ? nextSampleIndex : pendingStart
        pending.removeAll()
        anchors.removeAll()
        samplesSinceRetry = 0
        // Only an outage's first failure is reported; a retry that fails again continues it.
        guard outage == nil else { return [] }
        outage = (failedFromSample, failure.gapReason)
        return [.failed(failure, lostFromSample: failedFromSample)]
    }

    /// Tries to make the failure gap durable; on success writing resumes with the next append,
    /// and the next committed block reports the outage as `resumed`.
    private func retry() -> [SpoolEvent] {
        guard case .failed(let failure) = state else { return [] }
        samplesSinceRetry = 0
        guard nextSampleIndex > failedFromSample else {
            state = .writing
            return []
        }
        let gap = ManifestGap(reason: failure.gapReason, fromSample: failedFromSample, toSample: nextSampleIndex)
        var events: [SpoolEvent] = []
        do {
            try ensureFile(for: nextSampleIndex, events: &events)
            try appendRecords((unwrittenGaps + [gap]).map(ManifestRecord.gap))
        } catch {
            return events
        }
        unwrittenGaps.removeAll()
        gapsSinceCommit.append(gap)
        state = .writing
        pendingStart = nextSampleIndex
        return events
    }

    private static func failure(from error: any Error) -> SpoolFailure {
        if let io = error as? SpoolIOError, io.isNoSpace { return .diskFull(io.description) }
        return .writeError(String(describing: error))
    }
}
