import Darwin
import Foundation
import SondineKit
import Testing

/// Reads a manifest strictly; every line must decode.
func manifestRecords(_ url: URL) throws -> [ManifestRecord] {
    try lines(of: url).map { try ManifestRecord.decode(line: Data($0.utf8)) }
}

extension [ManifestRecord] {
    var commits: [ManifestCommit] {
        compactMap { if case .commit(let commit) = $0 { commit } else { nil } }
    }
    var gaps: [ManifestGap] {
        compactMap { if case .gap(let gap) = $0 { gap } else { nil } }
    }
    var envelopes: [ManifestEnvelope] {
        compactMap { if case .envelope(let envelope) = $0 { envelope } else { nil } }
    }
    var header: ManifestHeader? {
        if case .header(let header)? = first { header } else { nil }
    }
}

extension [SpoolEvent] {
    var commits: [SpoolCommitEvent] {
        compactMap { if case .committed(let commit) = $0 { commit } else { nil } }
    }
}

struct SpoolFixture {
    let directory: TemporaryDirectory
    let identity = SpoolIdentity(
        sessionId: UUID(uuidString: "6F1C2A4E-8B3D-4C5E-9F10-2A3B4C5D6E7F")!,
        trackKey: "input:BuiltInMicrophoneDevice",
        runId: UUID(uuidString: "1B0E6C52-3F4A-4D8B-9C21-7E5F9A0B1C2D")!,
        helperVersion: "0.1.0"
    )
    let clock = FixedClock()

    init() throws { directory = try TemporaryDirectory() }

    static let runPath = "input-BuiltInMicrophoneDevice/1b0e6c52-3f4a-4d8b-9c21-7e5f9a0b1c2d"
    var runDirectory: URL { directory.url.appending(path: Self.runPath) }
    func pcm(_ sequence: Int) -> URL { runDirectory.appending(path: String(format: "%04d.pcm", sequence)) }
    func manifest(_ sequence: Int) -> URL { runDirectory.appending(path: String(format: "%04d.jsonl", sequence)) }

    func writer(
        commitSamples: Int = 32_000,
        rotationSamples: Int64 = 9_600_000,
        retrySamples: Int64 = 160_000,
        fileSystem: any SpoolFileSystem = PosixSpoolFileSystem()
    ) throws -> SpoolWriter {
        var configuration = SpoolConfiguration()
        configuration.commitSamples = commitSamples
        configuration.rotationSamples = rotationSamples
        configuration.retrySamples = retrySamples
        return try SpoolWriter(
            root: directory.url, identity: identity, epoch: 1,
            configuration: configuration, fileSystem: fileSystem, clock: clock
        )
    }

    /// Ramp samples so every position has a distinct value.
    static func samples(from start: Int, count: Int) -> [Int16] {
        (start..<start + count).map { Int16(truncatingIfNeeded: $0 &* 7) }
    }

    /// Appends `count` samples in 100 ms chunks, host time following the sample index.
    @discardableResult
    func feed(_ writer: SpoolWriter, count: Int, chunk: Int = 1_600) -> [SpoolEvent] {
        var events: [SpoolEvent] = []
        var done = 0
        while done < count {
            let size = min(chunk, count - done)
            let index = Int(writer.nextSampleIndex)
            let ticks = clock.hostTicks + UInt64(clock.timebase.ticks(fromSeconds: Double(index) / 16_000))
            events += writer.append(Self.samples(from: index, count: size), firstSampleHostTicks: ticks)
            done += size
        }
        return events
    }

    func data(_ url: URL) throws -> Data { try Data(contentsOf: url) }
}

@Suite struct SpoolWriterTests {
    @Test func commitsWriteDataThenVerifiableManifestRecords() throws {
        let fixture = try SpoolFixture()
        let writer = try fixture.writer()
        let events = fixture.feed(writer, count: 40_000)
        #expect(events.commits.count == 1)
        let closing = writer.close()
        #expect(closing.commits.count == 1)

        let records = try manifestRecords(fixture.manifest(0))
        let header = try #require(records.header)
        #expect(header.trackKey == "input:BuiltInMicrophoneDevice")
        #expect(header.runId == "1b0e6c52-3f4a-4d8b-9c21-7e5f9a0b1c2d")
        #expect(header.sessionId == "6f1c2a4e-8b3d-4c5e-9f10-2a3b4c5d6e7f")
        #expect(header.file == "0000.pcm")
        #expect(header.sequence == 0 && header.startSample == 0 && header.epoch == 1)
        #expect(header.timebase.numer == 125 && header.timebase.denom == 3)
        #expect(header.anchor.hostTicks.value == fixture.clock.hostTicks)
        #expect(header.anchor.wallNs.value == fixture.clock.wallNs)

        let commits = records.commits
        #expect(commits.map(\.seq) == [0, 1])
        #expect(commits.map(\.sampleIndex) == [0, 32_000])
        #expect(commits.map(\.sampleCount) == [32_000, 8_000])
        #expect(commits.map(\.committedOffset) == [64_000, 80_000])

        let data = try fixture.data(fixture.pcm(0))
        #expect(data.count == 80_000)
        for commit in commits {
            let block = data[Int(commit.blockOffset)..<Int(commit.committedOffset)]
            #expect(CRC32.checksum(Data(block)) == commit.crc32)
        }
        // First-sample clocks: host ticks follow the sample index; continuous time adds sleep.
        let tps = fixture.clock.timebase.ticksPerSecond
        let second = commits[1].at
        #expect(abs(Double(second.hostTicks.value - fixture.clock.hostTicks) / tps - 2) < 1e-6)
        let expectedContinuous = fixture.clock.timebase.nanoseconds(fromTicks: second.hostTicks.value) + fixture.clock.sleptNs
        #expect(second.continuousNs.value == expectedContinuous)
        #expect(writer.state == .closed)
    }

    @Test func storedSamplesAreTheAppendedPcm() throws {
        let fixture = try SpoolFixture()
        let writer = try fixture.writer(commitSamples: 1_000)
        fixture.feed(writer, count: 2_500, chunk: 333)
        _ = writer.close()
        let data = try fixture.data(fixture.pcm(0))
        let stored = data.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }.map { Int16(littleEndian: $0) }
        #expect(stored == SpoolFixture.samples(from: 0, count: 2_500))
    }

    @Test func rotationKeepsSampleIndicesContiguous() throws {
        let fixture = try SpoolFixture()
        let writer = try fixture.writer(commitSamples: 3_000, rotationSamples: 10_000)
        let events = fixture.feed(writer, count: 25_000, chunk: 1_000) + writer.close()
        let opened = events.compactMap { if case .fileOpened(let file, _) = $0 { file } else { nil } }
        #expect(opened == ["\(SpoolFixture.runPath)/0000.pcm", "\(SpoolFixture.runPath)/0001.pcm", "\(SpoolFixture.runPath)/0002.pcm"])

        var next: Int64 = 0
        for sequence in 0..<3 {
            let records = try manifestRecords(fixture.manifest(sequence))
            let header = try #require(records.header)
            #expect(header.sequence == Int64(sequence))
            #expect(header.startSample == next)
            #expect(header.file == String(format: "%04d.pcm", sequence))
            var offset: Int64 = 0
            for (seq, commit) in records.commits.enumerated() {
                #expect(commit.seq == Int64(seq))
                #expect(commit.sampleIndex == next)
                #expect(commit.blockOffset == offset)
                #expect(commit.endSample <= header.startSample + 10_000)
                next = commit.endSample
                offset = commit.committedOffset
            }
            #expect(Int64(try fixture.data(fixture.pcm(sequence)).count) == offset)
        }
        #expect(next == 25_000)
        let stored = try (0..<3).map { try fixture.data(fixture.pcm($0)) }.reduce(Data(), +)
        let samples = stored.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        #expect(samples == SpoolFixture.samples(from: 0, count: 25_000))
    }

    @Test func gapsAdvanceTheIndexAndPrecedeTheNextCommit() throws {
        let fixture = try SpoolFixture()
        let writer = try fixture.writer(commitSamples: 1_000)
        fixture.feed(writer, count: 1_000)
        let gapEvents = writer.markGap(lostSamples: 500, reason: .ringOverflow)
        #expect(gapEvents.isEmpty)
        #expect(writer.nextSampleIndex == 1_500)
        let events = fixture.feed(writer, count: 1_000)
        _ = writer.close()

        let gap = ManifestGap(reason: .ringOverflow, fromSample: 1_000, toSample: 1_500)
        #expect(events.commits.first?.gaps == [gap])
        #expect(events.commits.first?.commit.sampleIndex == 1_500)
        let records = try manifestRecords(fixture.manifest(0))
        let types = records.map { record -> String in
            switch record {
            case .header: "header"
            case .commit: "commit"
            case .gap: "gap"
            case .envelope: "envelope"
            case .region: "region"
            }
        }
        #expect(types == ["header", "commit", "gap", "commit"])
        #expect(records.gaps == [gap])
        #expect(try fixture.data(fixture.pcm(0)).count == 4_000)
    }

    @Test func envelopesAndRegionsAreWrittenWithTheNextCommit() throws {
        let fixture = try SpoolFixture()
        let writer = try fixture.writer(commitSamples: 3_200)
        writer.appendEnvelope((0..<20).map { EnvelopeFrame(index: Int64($0), db: -40 - Float($0)) })
        writer.appendEnvelope([EnvelopeFrame(index: 30, db: -130)])
        let region = ManifestRegion(
            regionId: UUID(), startSample: 100, endSample: 3_000, voicedSamples: 1_200, closeReason: .silence,
            speechProbability: SpeechProbabilityStats(mean: 0.8, max: 0.99),
            level: LevelStats(mean: -30, peak: -12)
        )
        writer.appendRegion(region)
        fixture.feed(writer, count: 3_200)
        _ = writer.close()
        let records = try manifestRecords(fixture.manifest(0))
        let envelopes = records.envelopes
        // A discontinuity starts a new record; values are clamped to the protocol's floor.
        #expect(envelopes.map(\.sampleIndex) == [0, 30 * 160])
        #expect(envelopes.map(\.count) == [20, 1])
        #expect(envelopes[0].values == (0..<20).map { -40 - Float($0) })
        #expect(envelopes[1].values == [-120])
        #expect(records.contains(.region(region)))
    }

    @Test func aRegionRecordKeepsTheVoiceItsSpanHolds() throws {
        let json = #"{"startSample":0,"endSample":20000,"speechStartSample":4000,"speechEndSample":12000,"maxProbability":0.9,"meanProbability":0.6,"voicedSamples":3072,"splitBefore":false,"splitAfter":false,"closeReason":"silence"}"#
        let region = try JSONDecoder().decode(SpeechRegion.self, from: Data(json.utf8))
        let record = ManifestRegion(region: region, regionId: UUID())
        #expect(record.startSample == 4_000 && record.endSample == 12_000)
        #expect(record.voicedSamples == 3_072)
        // Never more voice than the span: the protocol refuses it.
        var loud = region
        loud.voicedSamples = 9_000
        #expect(ManifestRegion(region: loud, regionId: UUID()).voicedSamples == 8_000)
        // Lines written before the field existed still decode, without it.
        let old = #"{"type":"region","regionId":"5f4cab96-7d8e-41cf-9065-bc9d3e4f5061","startSample":64000,"endSample":136000,"closeReason":"silence","speechProbability":{"mean":0.82,"max":0.99},"level":{"mean":-31.5,"peak":-9.25}}"#
        guard case .region(let decoded) = try ManifestRecord.decode(line: Data(old.utf8)) else {
            Issue.record("not a region")
            return
        }
        #expect(decoded.voicedSamples == nil)
    }

    @Test func aNearlyFullDiskReportsOneOutageUntilABlockIsStored() throws {
        let fixture = try SpoolFixture()
        let fileSystem = FaultInjectingFileSystem()
        let writer = try fixture.writer(commitSamples: 1_600, retrySamples: 3_200, fileSystem: fileSystem)
        fixture.feed(writer, count: 1_600)

        // Small manifest lines still fit; PCM blocks do not.
        var full = true
        fileSystem.writeFault = { handle, _ in full && handle.path.hasSuffix(".pcm") ? .noSpace(operation: "write", path: handle.path) : nil }
        var events: [SpoolEvent] = []
        for _ in 0..<6 { events += fixture.feed(writer, count: 1_600) }
        // Each retry stores its gap record, then the next block fails again: one failure, no resume.
        #expect(events.filter { if case .failed = $0 { true } else { false } }.count == 1)
        #expect(!events.contains { if case .resumed = $0 { true } else { false } })

        full = false
        let resumed = fixture.feed(writer, count: 3_200) + fixture.feed(writer, count: 1_600)
        let outage = try #require(resumed.compactMap { if case .resumed(let gap) = $0 { gap } else { nil } }.first)
        let commit = try #require(resumed.commits.first)
        #expect(outage == ManifestGap(reason: .diskFull, fromSample: 1_600, toSample: commit.commit.sampleIndex))
        // The commit carries every gap record of the outage, end to end.
        #expect(commit.gaps.first?.fromSample == 1_600)
        #expect(commit.gaps.last?.toSample == commit.commit.sampleIndex)
        for (earlier, later) in zip(commit.gaps, commit.gaps.dropFirst()) { #expect(earlier.toSample == later.fromSample) }
        _ = writer.close()
    }

    @Test func diskFullStopsWritingRecordsAGapAndResumes() throws {
        let fixture = try SpoolFixture()
        let fileSystem = FaultInjectingFileSystem()
        let writer = try fixture.writer(commitSamples: 1_600, retrySamples: 3_200, fileSystem: fileSystem)
        fixture.feed(writer, count: 3_200)
        #expect(writer.committedSamples == 3_200)

        var diskFull = true
        fileSystem.writeFault = { handle, _ in diskFull ? .noSpace(operation: "write", path: handle.path) : nil }
        let failing = fixture.feed(writer, count: 1_600)
        #expect(failing.contains(.failed(.diskFull("write \(fixture.pcm(0).path(percentEncoded: false)): no space left on device"), lostFromSample: 3_200)))
        guard case .failed(.diskFull) = writer.state else {
            Issue.record("writer should be failed with disk full, is \(writer.state)")
            return
        }
        // The PCM file still ends at the last commit.
        #expect(try fixture.data(fixture.pcm(0)).count == 6_400)

        // Still full at the first retry: nothing changes and samples keep counting.
        fixture.feed(writer, count: 3_200)
        #expect(writer.nextSampleIndex == 8_000)
        if case .failed = writer.state {} else { Issue.record("retry should fail while the disk is full") }

        diskFull = false
        // The second chunk triggers the retry: the gap ends before it, and it is stored.
        let resumed = fixture.feed(writer, count: 3_200)
        let gap = ManifestGap(reason: .diskFull, fromSample: 3_200, toSample: 9_600)
        #expect(resumed.contains(.resumed(gap: gap)))
        #expect(writer.state == .writing)
        #expect(resumed.commits.first?.commit.sampleIndex == 9_600)
        #expect(resumed.commits.first?.gaps == [gap])
        let after = fixture.feed(writer, count: 1_600)
        #expect(after.commits.first?.commit.sampleIndex == 11_200)
        #expect(after.commits.first?.gaps == [])
        _ = writer.close()

        let records = try manifestRecords(fixture.manifest(0))
        #expect(records.gaps == [gap])
        #expect(records.commits.map(\.sampleIndex) == [0, 1_600, 9_600, 11_200])
        let stored = try fixture.data(fixture.pcm(0)).withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        #expect(Array(stored[3_200...]) == SpoolFixture.samples(from: 9_600, count: 3_200))
        let report = try SpoolRecovery.recover(directory: fixture.directory.url)
        #expect(report.files.map(\.status) == [.intact])
    }

    @Test func manifestFailureCutsTheUncommittedBlock() throws {
        let fixture = try SpoolFixture()
        let fileSystem = FaultInjectingFileSystem()
        let writer = try fixture.writer(commitSamples: 1_000, fileSystem: fileSystem)
        fixture.feed(writer, count: 1_000)
        let manifestPath = fixture.manifest(0).path(percentEncoded: false)
        fileSystem.writeFault = { handle, _ in handle.path == manifestPath ? .noSpace(operation: "write", path: handle.path) : nil }
        let events = fixture.feed(writer, count: 1_000)
        #expect(events.contains { if case .failed(.diskFull, 1_000) = $0 { true } else { false } })
        #expect(try fixture.data(fixture.pcm(0)).count == 2_000)
        #expect(try manifestRecords(fixture.manifest(0)).commits.count == 1)
    }

    enum CreationStep: CaseIterable { case header, pcm, directory }

    /// A file whose creation failed half way (manifest created, then the header write, the PCM
    /// creation or the directory sync failed) is reused by the retry instead of blocking it.
    @Test(arguments: CreationStep.allCases)
    func failedFileCreationDoesNotBlockRetries(step: CreationStep) throws {
        let fixture = try SpoolFixture()
        let fileSystem = FaultInjectingFileSystem()
        let writer = try fixture.writer(commitSamples: 1_600, retrySamples: 3_200, fileSystem: fileSystem)
        var full = true
        func noSpace(_ path: String) -> SpoolIOError? { full ? .noSpace(operation: "test", path: path) : nil }
        switch step {
        case .header: fileSystem.writeFault = { handle, _ in handle.path.hasSuffix(".jsonl") ? noSpace(handle.path) : nil }
        case .pcm: fileSystem.createFault = { url in url.pathExtension == "pcm" ? noSpace(url.path) : nil }
        case .directory: fileSystem.syncDirectoryFault = { url in noSpace(url.path) }
        }
        let failing = fixture.feed(writer, count: 1_600)
        #expect(failing.contains { if case .failed(.diskFull, 0) = $0 { true } else { false } })

        full = false
        let resumed = fixture.feed(writer, count: 3_200)
        #expect(resumed.contains(.resumed(gap: ManifestGap(reason: .diskFull, fromSample: 0, toSample: 3_200))))
        #expect(writer.state == .writing)
        #expect(resumed.commits.first?.commit.sampleIndex == 3_200)
        _ = writer.close()
        #expect(fileSystem.openDescriptors.isEmpty)

        let names = try FileManager.default.contentsOfDirectory(atPath: fixture.runDirectory.path(percentEncoded: false)).sorted()
        #expect(names == ["0000.jsonl", "0000.pcm"])
        let records = try manifestRecords(fixture.manifest(0))
        #expect(records.header?.sequence == 0)
        #expect(records.header?.startSample == 3_200)
        #expect(records.commits.map(\.sampleIndex) == [3_200])
        #expect(try SpoolRecovery.recover(directory: fixture.directory.url).files.map(\.status) == [.intact])
    }

    @Test func ioErrorsAreReportedAsWriteErrors() throws {
        let fixture = try SpoolFixture()
        let fileSystem = FaultInjectingFileSystem()
        let writer = try fixture.writer(commitSamples: 1_000, fileSystem: fileSystem)
        fileSystem.syncFault = { handle in .failed(operation: "fsync", path: handle.path, errno: EIO) }
        let events = fixture.feed(writer, count: 1_000)
        #expect(events.contains { if case .failed(.writeError, 0) = $0 { true } else { false } })
    }
}

@Suite struct SpoolProtocolTests {
    /// Writes every record type the helper produces. With `SONDINE_EXPORT_MANIFESTS=<dir>`, the
    /// manifests are copied there so `packages/protocol` can validate the Swift output.
    @Test func writerOutputCoversEveryRecordType() throws {
        let fixture = try SpoolFixture()
        let fileSystem = FaultInjectingFileSystem()
        let writer = try fixture.writer(commitSamples: 1_600, rotationSamples: 8_000, retrySamples: 1_600, fileSystem: fileSystem)
        writer.appendEnvelope((0..<10).map { EnvelopeFrame(index: Int64($0), db: -50 + Float($0)) })
        fixture.feed(writer, count: 3_200)
        _ = writer.markGap(lostSamples: 320, reason: .ringOverflow)
        writer.appendRegion(ManifestRegion(
            regionId: UUID(), startSample: 400, endSample: 3_000, closeReason: .silence,
            speechProbability: SpeechProbabilityStats(mean: 0.75, max: 0.98), level: LevelStats(mean: -31.5, peak: -12.25)
        ))
        fixture.feed(writer, count: 6_400)
        var full = true
        fileSystem.writeFault = { handle, _ in full ? .noSpace(operation: "write", path: handle.path) : nil }
        fixture.feed(writer, count: 1_600)
        full = false
        fixture.feed(writer, count: 3_200)
        _ = writer.close()
        // A crash leaves uncommitted bytes in the newest file.
        let newest = try #require(try FileManager.default.contentsOfDirectory(at: fixture.runDirectory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "pcm" }.max { $0.lastPathComponent < $1.lastPathComponent })
        let handle = try FileHandle(forWritingTo: newest)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(repeating: 1, count: 640))
        try handle.close()
        let report = try SpoolRecovery.recover(directory: fixture.directory.url)
        #expect(report.repairedFiles == 1)

        let manifests = try FileManager.default.contentsOfDirectory(at: fixture.runDirectory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "jsonl" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        #expect(manifests.count >= 2)
        var types: Set<String> = []
        var reasons: Set<GapReason> = []
        for manifest in manifests {
            for record in try manifestRecords(manifest) {
                switch record {
                case .header: types.insert("header")
                case .commit: types.insert("commit")
                case .gap(let gap):
                    types.insert("gap")
                    reasons.insert(gap.reason)
                case .envelope: types.insert("envelope")
                case .region: types.insert("region")
                }
            }
        }
        #expect(types == ["header", "commit", "gap", "envelope", "region"])
        #expect(reasons == [.ringOverflow, .diskFull, .recoveryTruncated])

        if let export = ProcessInfo.processInfo.environment["SONDINE_EXPORT_MANIFESTS"], !export.isEmpty {
            let destination = URL(filePath: export, directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
            for manifest in manifests {
                let target = destination.appending(path: manifest.lastPathComponent)
                try? FileManager.default.removeItem(at: target)
                try FileManager.default.copyItem(at: manifest, to: target)
            }
        }
    }
}

@Suite struct SpoolLayoutTests {
    @Test func trackKeysBecomeSafeDirectoryNames() {
        #expect(SpoolLayout.trackDirectory(for: "input:BuiltInMicrophoneDevice") == "input-BuiltInMicrophoneDevice")
        #expect(SpoolLayout.trackDirectory(for: "system:other") == "system-other")
        #expect(SpoolLayout.trackDirectory(for: "app:com.apple.Safari") == "app-com.apple.Safari")
        #expect(SpoolLayout.trackDirectory(for: "input:AppleUSB Audio/é:1") == "input-AppleUSB_Audio__-1")
        #expect(SpoolLayout.trackDirectory(for: ".hidden") == "_.hidden")
        #expect(SpoolLayout.fileName(sequence: 7) == "0007.pcm")
        #expect(SpoolLayout.manifestName(sequence: 12_345) == "12345.jsonl")
    }

    @Test func writerRejectsRunDirectoriesOutsideTheRoot() throws {
        let fixture = try SpoolFixture()
        for bad in ["../escape", "/absolute", "a//b", ".hidden/run", ""] {
            #expect(throws: ManifestError.self, "accepted \(bad)") {
                _ = try SpoolWriter(root: fixture.directory.url, identity: fixture.identity, epoch: 1, runDirectory: bad)
            }
        }
    }
}

@Suite struct SpoolRecoveryTests {
    /// Writes `commits` blocks of 1000 samples and closes the writer.
    private func written(commits: Int) throws -> SpoolFixture {
        let fixture = try SpoolFixture()
        let writer = try fixture.writer(commitSamples: 1_000)
        fixture.feed(writer, count: commits * 1_000, chunk: 1_000)
        _ = writer.close()
        return fixture
    }

    private func append(_ bytes: Data, to url: URL) throws {
        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        try handle.write(contentsOf: bytes)
        try handle.close()
    }

    @Test func cleanSpoolIsIntactAndUntouched() throws {
        let fixture = try written(commits: 3)
        let before = try fixture.data(fixture.manifest(0))
        let report = try SpoolRecovery.recover(directory: fixture.directory.url)
        let file = try #require(report.files.first)
        #expect(file.status == .intact)
        #expect(file.commits == 3)
        #expect(file.keptEndSample == 3_000)
        #expect(file.manifest == "\(SpoolFixture.runPath)/0000.jsonl")
        #expect(file.file == "\(SpoolFixture.runPath)/0000.pcm")
        #expect(try fixture.data(fixture.manifest(0)) == before)
    }

    @Test func uncommittedTailIsCutAndRecordedOnce() throws {
        let fixture = try written(commits: 3)
        // A crash after the PCM write, before the commit record.
        try append(Data(repeating: 0x5A, count: 1_000), to: fixture.pcm(0))
        let report = try SpoolRecovery.recover(directory: fixture.directory.url)
        let file = try #require(report.files.first)
        #expect(file.status == .repaired)
        #expect(file.cutBytes == 1_000)
        #expect(file.lostSamples == 500)
        #expect(file.gap == ManifestGap(reason: .recoveryTruncated, fromSample: 3_000, toSample: 3_500))
        #expect(try fixture.data(fixture.pcm(0)).count == 6_000)
        let records = try manifestRecords(fixture.manifest(0))
        #expect(records.last == .gap(ManifestGap(reason: .recoveryTruncated, fromSample: 3_000, toSample: 3_500)))

        // Idempotent.
        let again = try SpoolRecovery.recover(directory: fixture.directory.url)
        #expect(again.files.first?.status == .intact)
        #expect(try manifestRecords(fixture.manifest(0)).count == records.count)
    }

    @Test func tornManifestLineIsIgnored() throws {
        let fixture = try written(commits: 2)
        // The PCM block was synced; the commit line was cut mid-write.
        try append(Data(SpoolFixture.samples(from: 2_000, count: 1_000).withUnsafeBytes { Data($0) }), to: fixture.pcm(0))
        try append(Data(#"{"type":"commit","seq":2,"epoch":1,"committedOff"#.utf8), to: fixture.manifest(0))
        let report = try SpoolRecovery.recover(directory: fixture.directory.url)
        let file = try #require(report.files.first)
        #expect(file.tornLine)
        #expect(file.status == .repaired)
        #expect(file.commits == 2)
        #expect(file.gap == ManifestGap(reason: .recoveryTruncated, fromSample: 2_000, toSample: 3_000))
        let text = try String(contentsOf: fixture.manifest(0), encoding: .utf8)
        #expect(text.hasSuffix("\n"))
        #expect(try manifestRecords(fixture.manifest(0)).commits.count == 2)
    }

    @Test func crcMismatchKeepsOnlyTheVerifiedPrefix() throws {
        let fixture = try written(commits: 4)
        // Corrupt one byte inside block 2 (bytes 4000..<6000).
        let handle = try FileHandle(forUpdating: fixture.pcm(0))
        try handle.seek(toOffset: 4_321)
        try handle.write(contentsOf: Data([0xFF]))
        try handle.close()

        let report = try SpoolRecovery.recover(directory: fixture.directory.url)
        let file = try #require(report.files.first)
        #expect(file.status == .repaired)
        #expect(file.crcMismatches == 1)
        #expect(file.commits == 2)
        #expect(file.keptBytes == 4_000)
        #expect(file.cutBytes == 4_000)
        #expect(file.droppedRecords == 2)
        #expect(file.gap == ManifestGap(reason: .recoveryTruncated, fromSample: 2_000, toSample: 4_000))
        let records = try manifestRecords(fixture.manifest(0))
        #expect(records.commits.map(\.seq) == [0, 1])
        #expect(try fixture.data(fixture.pcm(0)).count == 4_000)
    }

    @Test func commitBeyondTheFileEndIsTreatedAsLost() throws {
        let fixture = try written(commits: 3)
        // Power loss: the manifest reached the disk, the last block did not.
        let handle = try FileHandle(forUpdating: fixture.pcm(0))
        try handle.truncate(atOffset: 5_000)
        try handle.close()
        let file = try #require(try SpoolRecovery.recover(directory: fixture.directory.url).files.first)
        #expect(file.missingBlocks == 1)
        #expect(file.commits == 2)
        #expect(file.gap == ManifestGap(reason: .recoveryTruncated, fromSample: 2_000, toSample: 3_000))
        #expect(try fixture.data(fixture.pcm(0)).count == 4_000)
    }

    enum Damage: CaseIterable { case uncommittedTail, tornLine, crcMismatch, missingBlock }

    /// The damaged spool's manifest and PCM bytes.
    private func damaged(_ damage: Damage) throws -> (manifest: Data, pcm: Data) {
        let fixture: SpoolFixture
        switch damage {
        case .uncommittedTail:
            fixture = try written(commits: 3)
            try append(Data(repeating: 0x5A, count: 1_000), to: fixture.pcm(0))
        case .tornLine:
            fixture = try written(commits: 2)
            try append(Data(SpoolFixture.samples(from: 2_000, count: 1_000).withUnsafeBytes { Data($0) }), to: fixture.pcm(0))
            try append(Data(#"{"type":"commit","seq":2,"epoch":1,"committedOff"#.utf8), to: fixture.manifest(0))
        case .crcMismatch:
            fixture = try written(commits: 4)
            let handle = try FileHandle(forUpdating: fixture.pcm(0))
            try handle.seek(toOffset: 4_321)
            try handle.write(contentsOf: Data([0xFF]))
            try handle.close()
        case .missingBlock:
            fixture = try written(commits: 3)
            let handle = try FileHandle(forUpdating: fixture.pcm(0))
            try handle.truncate(atOffset: 5_000)
            try handle.close()
        }
        return (try fixture.data(fixture.manifest(0)), try fixture.data(fixture.pcm(0)))
    }

    private func restored(_ files: (manifest: Data, pcm: Data)) throws -> SpoolFixture {
        let fixture = try SpoolFixture()
        try FileManager.default.createDirectory(at: fixture.runDirectory, withIntermediateDirectories: true)
        try files.manifest.write(to: fixture.manifest(0))
        try files.pcm.write(to: fixture.pcm(0))
        return fixture
    }

    /// Recovers with a crash right before the file operation numbered `crashAt` (writes, syncs
    /// and truncations count). Returns false when the run finished before reaching it.
    private func recover(_ fixture: SpoolFixture, crashAt: Int, torn: Bool) -> Bool {
        let fileSystem = FaultInjectingFileSystem()
        fileSystem.tearFailedWrites = torn
        var operations = 0
        func step(_ handle: SpoolFileHandle) -> SpoolIOError? {
            defer { operations += 1 }
            return operations == crashAt ? .failed(operation: "crash", path: handle.path, errno: EIO) : nil
        }
        fileSystem.writeFault = { handle, _ in step(handle) }
        fileSystem.syncFault = step
        fileSystem.truncateFault = step
        return (try? SpoolRecovery.recover(directory: fixture.directory.url, fileSystem: fileSystem)) != nil
    }

    /// Crashes at any point of a repair, once or twice, never lose the evidence of the loss:
    /// the next recovery finishes with the same files as an uninterrupted one.
    @Test(arguments: Damage.allCases, [false, true])
    func interruptedRepairsFinishWithTheSameGap(damage: Damage, torn: Bool) throws {
        let files = try damaged(damage)
        let reference = try restored(files)
        let report = try SpoolRecovery.recover(directory: reference.directory.url)
        let gap = try #require(report.files.first?.gap)
        let expected = (manifest: try reference.data(reference.manifest(0)), pcm: try reference.data(reference.pcm(0)))
        #expect(try manifestRecords(reference.manifest(0)).last == .gap(gap))

        crashes: for first in 0..<16 {
            for second in 0..<16 {
                let fixture = try restored(files)
                // A run that finishes before the crash point leaves nothing more to try.
                if recover(fixture, crashAt: first, torn: torn) { break crashes }
                let secondFinished = recover(fixture, crashAt: second, torn: torn)
                if !secondFinished {
                    // A crash at the last sync leaves nothing to repair, so no gap to report.
                    let finishing = try SpoolRecovery.recover(directory: fixture.directory.url)
                    #expect([nil, gap].contains(finishing.files.first?.gap), "crash at \(first) then \(second)")
                }
                let again = try SpoolRecovery.recover(directory: fixture.directory.url)
                #expect(again.files.first?.status == .intact, "crash at \(first) then \(second)")
                #expect(try fixture.data(fixture.manifest(0)) == expected.manifest, "crash at \(first) then \(second)")
                #expect(try fixture.data(fixture.pcm(0)) == expected.pcm, "crash at \(first) then \(second)")
                if secondFinished { break }
            }
        }
    }

    @Test func manifestWithoutHeaderIsLeftAlone() throws {
        let directory = try TemporaryDirectory()
        let run = directory.url.appending(path: "run")
        try FileManager.default.createDirectory(at: run, withIntermediateDirectories: true)
        let garbage = Data("not json\n".utf8)
        try garbage.write(to: run.appending(path: "0000.jsonl"))
        let file = try #require(try SpoolRecovery.recover(directory: directory.url).files.first)
        #expect(file.status == .unreadable)
        #expect(try Data(contentsOf: run.appending(path: "0000.jsonl")) == garbage)
    }

    @Test func newestFileOptionSkipsCompletedFiles() throws {
        let fixture = try SpoolFixture()
        let writer = try fixture.writer(commitSamples: 1_000, rotationSamples: 2_000)
        fixture.feed(writer, count: 5_000, chunk: 1_000)
        _ = writer.close()
        let all = try SpoolRecovery.recover(directory: fixture.directory.url)
        #expect(all.files.count == 3)
        let newest = try SpoolRecovery.recover(directory: fixture.directory.url, onlyNewestFilePerRun: true)
        #expect(newest.files.map(\.manifest) == ["\(SpoolFixture.runPath)/0002.jsonl"])
    }
}
