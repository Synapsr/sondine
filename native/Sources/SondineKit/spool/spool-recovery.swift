import Foundation

/// What recovery found and did for one manifest and its PCM file.
public struct SpoolFileRecovery: Sendable, Equatable, Codable {
    public enum Status: String, Sendable, Codable {
        /// Every commit verified and nothing was cut.
        case intact
        /// Bytes or manifest lines were cut and a `recovery-truncated` gap was recorded if samples were lost.
        case repaired
        /// The manifest has no valid header; nothing was changed.
        case unreadable
        /// The manifest commits samples but its PCM file is missing; nothing was changed.
        case missingData
    }

    /// Manifest path relative to the recovered directory.
    public var manifest: String
    /// PCM path relative to the recovered directory, when the header names one.
    public var file: String?
    public var status: Status
    public var problem: String?
    /// Commits kept (verified).
    public var commits = 0
    public var keptBytes: Int64 = 0
    public var cutBytes: Int64 = 0
    /// Run sample index after the last kept commit.
    public var keptEndSample: Int64?
    public var lostSamples: Int64 = 0
    public var crcMismatches = 0
    /// Commits whose bytes are missing, out of order, or not contiguous.
    public var missingBlocks = 0
    /// The manifest ended with an incomplete or unparsable line, which was removed.
    public var tornLine = false
    /// Valid lines removed because they followed the first bad commit or line.
    public var droppedRecords = 0
    public var gap: ManifestGap?
}

public struct SpoolRecoveryReport: Sendable, Equatable, Codable {
    public var files: [SpoolFileRecovery]

    public var repairedFiles: Int { files.filter { $0.status == .repaired }.count }
    public var lostSamples: Int64 { files.reduce(0) { $0 + $1.lostSamples } }
    public var cutBytes: Int64 { files.reduce(0) { $0 + $1.cutBytes } }
}

/// Brings a spool back to its last durable state after a crash or power loss (architecture §3):
/// each PCM file is truncated to the end of its longest prefix of commits whose CRC matches,
/// torn or invalid trailing manifest lines are removed, and the lost samples are recorded as a
/// `recovery-truncated` gap. The gap is synced before anything is cut, so a crash during
/// recovery loses no evidence: the next run finishes the repair. Running it again changes nothing.
///
/// Run it before any writer opens the directory.
public enum SpoolRecovery {
    public static func recover(
        directory: URL,
        fileSystem: any SpoolFileSystem = PosixSpoolFileSystem(),
        syncMode: SpoolSyncMode = .fsync,
        onlyNewestFilePerRun: Bool = false
    ) throws -> SpoolRecoveryReport {
        var manifests = try findManifests(in: directory, fileSystem: fileSystem).sorted { $0.path < $1.path }
        if onlyNewestFilePerRun {
            // Files before the newest one of a run were complete when the writer rotated.
            let byRun = Dictionary(grouping: manifests) { $0.deletingLastPathComponent().path }
            manifests = byRun.values.compactMap { $0.max { $0.lastPathComponent < $1.lastPathComponent } }
                .sorted { $0.path < $1.path }
        }
        let base = directory.standardizedFileURL.path(percentEncoded: false)
        func relative(_ url: URL) -> String {
            let path = url.standardizedFileURL.path(percentEncoded: false)
            let prefix = base.hasSuffix("/") ? base : base + "/"
            return path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : path
        }
        return SpoolRecoveryReport(
            files: try manifests.map { try recoverFile(manifest: $0, relative: relative, fileSystem: fileSystem, syncMode: syncMode) }
        )
    }

    private static func findManifests(in directory: URL, fileSystem: any SpoolFileSystem) throws -> [URL] {
        var result: [URL] = []
        for url in try fileSystem.contentsOfDirectory(at: directory) {
            if fileSystem.isDirectory(at: url) {
                result += try findManifests(in: url, fileSystem: fileSystem)
            } else if url.pathExtension == "jsonl" {
                result.append(url)
            }
        }
        return result
    }

    private struct Line {
        var record: ManifestRecord
        var end: Int64
    }

    private static func recoverFile(
        manifest url: URL,
        relative: (URL) -> String,
        fileSystem: any SpoolFileSystem,
        syncMode: SpoolSyncMode
    ) throws -> SpoolFileRecovery {
        var report = SpoolFileRecovery(manifest: relative(url), status: .intact)
        let manifest = try fileSystem.openFile(at: url)
        defer { fileSystem.close(manifest) }
        let manifestSize = try fileSystem.size(of: manifest)
        let bytes = try fileSystem.read(manifest, at: 0, count: Int(manifestSize))

        // Parse complete lines until the first one that does not decode.
        var lines: [Line] = []
        var start = 0
        var invalidTail = false
        while start < bytes.count {
            guard let newline = bytes[start...].firstIndex(of: 0x0A) else {
                invalidTail = true
                break
            }
            // Only the first line may be a header; anything else that does not decode ends the manifest.
            guard let record = try? ManifestRecord.decode(line: bytes[start..<newline]),
                  lines.isEmpty || !record.isHeader
            else {
                invalidTail = true
                break
            }
            lines.append(Line(record: record, end: Int64(newline + 1)))
            start = newline + 1
        }
        report.tornLine = invalidTail

        guard case .header(let header)? = lines.first?.record else {
            report.status = .unreadable
            report.problem = lines.isEmpty ? "no complete header line" : "first record is not a header"
            return report
        }
        let dataURL = url.deletingLastPathComponent().appending(path: header.file)
        report.file = relative(dataURL)
        let commits = lines.compactMap { line -> ManifestCommit? in
            if case .commit(let commit) = line.record { commit } else { nil }
        }
        guard fileSystem.fileExists(at: dataURL) else {
            if !commits.isEmpty {
                report.status = .missingData
                report.problem = "PCM file \(header.file) is missing"
                report.lostSamples = commits.reduce(0) { $0 + $1.sampleCount }
            }
            return report
        }
        let data = try fileSystem.openFile(at: dataURL)
        defer { fileSystem.close(data) }
        let dataSize = try fileSystem.size(of: data)

        // Keep the longest prefix of records whose commits verify.
        var keptLineEnd = lines[0].end
        var keptOffset: Int64 = 0
        var expectedSeq: Int64 = 0
        var firstFailure: ManifestCommit?
        var recordedEnd = header.startSample
        var recordedOffset: Int64 = 0
        // Only recovery writes `recovery-truncated` gaps, after the last commit and before it cuts
        // anything: one found there is the loss measured by an interrupted earlier recovery.
        let lastCommit = lines.lastIndex { if case .commit = $0.record { true } else { false } } ?? 0
        var journal: ManifestGap?
        for (index, line) in lines.enumerated().dropFirst() {
            if index > lastCommit, case .gap(let gap) = line.record, gap.reason == .recoveryTruncated {
                journal = journal.map { $0.union(gap) } ?? gap
                continue
            }
            switch line.record {
            case .commit(let commit):
                recordedEnd = max(recordedEnd, commit.endSample)
                recordedOffset = max(recordedOffset, commit.committedOffset)
                guard firstFailure == nil else { break }
                if commit.seq != expectedSeq || commit.blockOffset != keptOffset || commit.committedOffset > dataSize {
                    report.missingBlocks += 1
                    firstFailure = commit
                } else if try checksum(data, commit, fileSystem) != commit.crc32 {
                    report.crcMismatches += 1
                    firstFailure = commit
                } else {
                    keptOffset = commit.committedOffset
                    expectedSeq += 1
                    report.commits += 1
                    report.keptEndSample = commit.endSample
                }
            case .gap(let gap):
                recordedEnd = max(recordedEnd, gap.toSample)
            case .header, .envelope, .region:
                break
            }
            if firstFailure == nil {
                keptLineEnd = line.end
            } else {
                report.droppedRecords += 1
            }
        }

        // A torn rewrite of the final gap line (step 3 below) can hide the journal behind an
        // unreadable line; it is then still the file's last line.
        if invalidTail, let last = trailingJournal(bytes, after: lines[lines.count - 1].end) {
            journal = journal.map { $0.union(last) } ?? last
        }

        let tailBytes = max(0, dataSize - max(keptOffset, recordedOffset))
        let tailSamples = tailBytes / Int64(SpoolFormat.bytesPerSample)
        let lostFrom = firstFailure?.sampleIndex ?? recordedEnd
        let lostTo = recordedEnd + tailSamples
        var loss = lostTo > lostFrom ? ManifestGap(reason: .recoveryTruncated, fromSample: lostFrom, toSample: lostTo) : nil
        if let journal { loss = loss.map { $0.union(journal) } ?? journal }
        report.keptBytes = keptOffset
        report.cutBytes = max(0, dataSize - keptOffset)

        // Final manifest: the kept lines, then the gap line.
        let gapLine = try loss.map { [UInt8](try ManifestRecord.gap($0).encodedLine()) } ?? []
        let finalSize = keptLineEnd + Int64(gapLine.count)
        let endsWithGap = bytes.count >= gapLine.count && bytes.suffix(gapLine.count).elementsEqual(gapLine)
        var manifestLength = manifestSize
        guard report.cutBytes > 0 || manifestLength != finalSize || !endsWithGap else { return report }

        // 1. Journal the loss before anything that proves it is cut: append the gap line after the
        //    last readable line (dropping only an unreadable tail), then sync.
        if !gapLine.isEmpty {
            if !endsWithGap {
                let end = lines[lines.count - 1].end
                try gapLine.withUnsafeBytes { try fileSystem.write($0, to: manifest, at: end) }
                manifestLength = end + Int64(gapLine.count)
                try fileSystem.truncate(manifest, to: manifestLength)
            }
            try fileSystem.sync(manifest, mode: syncMode)
        }
        // 2. Cut the PCM file to the verified prefix.
        if report.cutBytes > 0 {
            try fileSystem.truncate(data, to: keptOffset)
            try fileSystem.sync(data, mode: syncMode)
        }
        // 3. Drop the unverified lines. The gap line is written over them before the file is
        //    shortened, so a complete copy of it stays in the file at every step.
        if manifestLength != finalSize {
            if !gapLine.isEmpty {
                try gapLine.withUnsafeBytes { try fileSystem.write($0, to: manifest, at: keptLineEnd) }
                try fileSystem.sync(manifest, mode: syncMode)
            }
            try fileSystem.truncate(manifest, to: finalSize)
            try fileSystem.sync(manifest, mode: syncMode)
        }
        if let loss {
            report.gap = loss
            report.lostSamples = loss.sampleCount
        }
        report.status = .repaired
        return report
    }

    /// The manifest's last complete line, when it starts at or after `offset` and is a
    /// `recovery-truncated` gap.
    private static func trailingJournal(_ bytes: [UInt8], after offset: Int64) -> ManifestGap? {
        guard bytes.last == 0x0A else { return nil }
        let body = bytes.dropLast()
        let start = body.lastIndex(of: 0x0A).map { $0 + 1 } ?? body.startIndex
        guard Int64(start) >= offset,
              case .gap(let gap)? = try? ManifestRecord.decode(line: body[start...]),
              gap.reason == .recoveryTruncated
        else { return nil }
        return gap
    }

    private static func checksum(_ data: SpoolFileHandle, _ commit: ManifestCommit, _ fileSystem: any SpoolFileSystem) throws -> UInt32 {
        var crc: UInt32 = 0
        var offset = commit.blockOffset
        let chunk: Int64 = 1 << 16
        while offset < commit.committedOffset {
            let count = Int(min(chunk, commit.committedOffset - offset))
            let bytes = try fileSystem.read(data, at: offset, count: count)
            guard bytes.count == count else { return ~commit.crc32 }
            crc = CRC32.checksum(bytes, continuing: crc)
            offset += Int64(count)
        }
        return crc
    }
}

extension ManifestRecord {
    var isHeader: Bool {
        if case .header = self { true } else { false }
    }
}

extension ManifestGap {
    /// The smallest gap covering both, with this gap's reason.
    func union(_ other: ManifestGap) -> ManifestGap {
        ManifestGap(reason: reason, fromSample: min(fromSample, other.fromSample), toSample: max(toSample, other.toSample))
    }
}
