import Darwin
import Foundation
import SondineKit
import Testing

/// `<data>/spool` must stay inside the data directory, whatever symlinks say.
struct SpoolLocationTests {
    private func path(_ url: URL) -> String { url.path(percentEncoded: false) }

    @Test func aMissingSpoolIsCreatedPrivateInsideTheDataDirectory() throws {
        let directory = try TemporaryDirectory()
        let root = try SpoolLayout.resolveRoot(dataDirectory: directory.url)
        let canonical = try #require(realpath(path(directory.url), nil).map { String(cString: $0) })
        #expect(path(root).hasPrefix(canonical + "/"))
        #expect(root.lastPathComponent == "spool")
        var info = stat()
        #expect(lstat(path(root), &info) == 0)
        #expect(info.st_mode & S_IFMT == S_IFDIR)
        #expect(info.st_mode & 0o777 == 0o700)
        // Idempotent.
        #expect(try SpoolLayout.resolveRoot(dataDirectory: directory.url) == root)
    }

    @Test func aSymlinkOutOfTheDataDirectoryIsRefused() throws {
        let directory = try TemporaryDirectory()
        let data = directory.url.appending(path: "data", directoryHint: .isDirectory)
        let outside = directory.url.appending(path: "outside", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: false)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
        try FileManager.default.createSymbolicLink(atPath: path(data) + "/spool", withDestinationPath: path(outside))
        #expect(throws: SpoolLocationError.self) { try SpoolLayout.resolveRoot(dataDirectory: data) }

        // A dangling link is refused too, and nothing is created where it points.
        try FileManager.default.removeItem(atPath: path(data) + "/spool")
        try FileManager.default.createSymbolicLink(atPath: path(data) + "/spool", withDestinationPath: path(outside) + "/later")
        #expect(throws: SpoolLocationError.self) { try SpoolLayout.resolveRoot(dataDirectory: data) }
        #expect(!FileManager.default.fileExists(atPath: path(outside) + "/later"))
    }

    @Test func aSymlinkThatStaysInsideResolvesToItsTarget() throws {
        let directory = try TemporaryDirectory()
        let target = directory.url.appending(path: "spool-v2", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
        try FileManager.default.createSymbolicLink(atPath: path(directory.url) + "/spool", withDestinationPath: "spool-v2")
        let root = try SpoolLayout.resolveRoot(dataDirectory: directory.url)
        #expect(root.lastPathComponent == "spool-v2")
    }

    @Test func aFileInTheWayIsRefused() throws {
        let directory = try TemporaryDirectory()
        FileManager.default.createFile(atPath: path(directory.url) + "/spool", contents: Data())
        #expect(throws: SpoolLocationError.self) { try SpoolLayout.resolveRoot(dataDirectory: directory.url) }
    }
}
