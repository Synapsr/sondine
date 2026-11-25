import AppKit
import Foundation

/// Sondine back after a crash of Electron main (plan M4, "relaunch after a crash"). Main writes
/// `quit` on the helper's lifetime pipe before it lets the helper go; the pipe closing without
/// it means main died. The helper then opens the app it lives in, in the background, as the user
/// would (so macOS credits it for the microphone as before), unless main died within a minute of
/// the helper starting: a crash at launch would loop.
enum Relaunch {
    /// A main gone sooner than this after the helper started is not brought back.
    static let minimumUptime: TimeInterval = 60

    /// The app bundle this helper is in (`Sondine.app/Contents/Helpers/sondine-audio`); nil
    /// outside one, as in development and tests.
    static func appURL() -> URL? {
        guard let executable = Bundle.main.executableURL?.resolvingSymlinksInPath() else { return nil }
        let app = executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let helpers = executable.deletingLastPathComponent()
        guard app.pathExtension == "app", helpers.lastPathComponent == "Helpers" else { return nil }
        return app
    }

    /// Opens the app, then calls `done` (at once when there is nothing to open).
    static func openApp(uptime: TimeInterval, done: @escaping @Sendable () -> Void) {
        guard uptime >= minimumUptime, let url = appURL() else {
            fputs("sondine-audio: main is gone; not relaunching (uptime \(Int(uptime)) s)\n", stderr)
            done()
            return
        }
        fputs("sondine-audio: main is gone without quitting; relaunching Sondine\n", stderr)
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
            if let error { fputs("sondine-audio: relaunch failed: \(error.localizedDescription)\n", stderr) }
            done()
        }
    }
}
