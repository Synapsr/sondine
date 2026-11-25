import AppKit
import CoreGraphics
import Foundation
import SondineCapture

/// The app in front, from NSWorkspace: `frontmostApplication` and its activation notification,
/// which need no permission (ADR 022). Both are fed by the main run loop: under
/// `dispatchMain()` the value never changed and no notification came (measured 2026-11-09),
/// so `serve` runs `CFRunLoopRun()`. While the screen is locked, the screen saver runs or the
/// displays sleep, the user is in no app, whatever was in front before; that same state is
/// whether the screen is away, which private zones hold capture on (ADR 029).
final class WorkspaceForegroundApps: ForegroundAppSource, ScreenStateSource, @unchecked Sendable {
    /// In front while the screen is locked or the screen saver runs.
    static let ignored: Set<String> = ["com.apple.loginwindow", "com.apple.ScreenSaver.Engine"]

    private typealias Observer = (center: NotificationCenter, token: any NSObjectProtocol)

    private let lock = NSLock()
    private var observers: [Observer] = []
    private var foregroundHandler: (@Sendable (ForegroundApp?) -> Void)?
    private var screenHandler: (@Sendable (Bool) -> Void)?
    /// Why the screen is away now: locked, the screen saver, the displays asleep.
    private var away: Set<String> = []

    func start(handler: @escaping @Sendable (ForegroundApp?) -> Void) -> ForegroundApp? {
        lock.withLock { foregroundHandler = handler }
        observe()
        return lock.withLock { away.isEmpty } ? Self.foregroundApp(NSWorkspace.shared.frontmostApplication) : nil
    }

    func watchScreen(handler: @escaping @Sendable (Bool) -> Void) -> Bool {
        lock.withLock { screenHandler = handler }
        observe()
        return lock.withLock { !away.isEmpty }
    }

    func stop() {
        let tokens = lock.withLock { () -> [Observer] in
            defer {
                observers = []
                foregroundHandler = nil
                screenHandler = nil
            }
            return observers
        }
        for (center, token) in tokens { center.removeObserver(token) }
    }

    func stopWatchingScreen() { stop() }

    /// Registers the observers once, and reads whether the screen is away now (there is no
    /// notification for the state at launch).
    private func observe() {
        let first = lock.withLock { observers.isEmpty }
        guard first else { return }
        let workspace = NSWorkspace.shared.notificationCenter
        let distributed = DistributedNotificationCenter.default()
        let awayWhile: [(center: NotificationCenter, start: Notification.Name, end: Notification.Name)] = [
            (distributed, Notification.Name("com.apple.screenIsLocked"), Notification.Name("com.apple.screenIsUnlocked")),
            (distributed, Notification.Name("com.apple.screensaver.didstart"), Notification.Name("com.apple.screensaver.didstop")),
            (workspace, NSWorkspace.screensDidSleepNotification, NSWorkspace.screensDidWakeNotification),
        ]
        var initial: Set<String> = []
        if Self.screenLockedNow() { initial.insert(awayWhile[0].start.rawValue) }
        if CGDisplayIsAsleep(CGMainDisplayID()) != 0 { initial.insert(awayWhile[2].start.rawValue) }
        var tokens: [Observer] = []
        tokens.append((workspace, workspace.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil) { [weak self] note in
            self?.report(note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
        }))
        for (center, start, end) in awayWhile {
            let reason = start.rawValue
            tokens.append((center, center.addObserver(forName: start, object: nil, queue: nil) { [weak self] _ in
                self?.changeAway(inserting: reason)
            }))
            tokens.append((center, center.addObserver(forName: end, object: nil, queue: nil) { [weak self] _ in
                self?.changeAway(removing: reason)
            }))
        }
        lock.withLock {
            away = initial
            observers = tokens
        }
    }

    private func report(_ app: NSRunningApplication?) {
        let (isAway, handler) = lock.withLock { (!away.isEmpty, foregroundHandler) }
        handler?(isAway ? nil : Self.foregroundApp(app))
    }

    private func changeAway(inserting: String? = nil, removing: String? = nil) {
        let (wasAway, isAway, foreground, screen) = lock.withLock { () -> (Bool, Bool, (@Sendable (ForegroundApp?) -> Void)?, (@Sendable (Bool) -> Void)?) in
            let was = !away.isEmpty
            if let inserting { away.insert(inserting) }
            if let removing { away.remove(removing) }
            return (was, !away.isEmpty, foregroundHandler, screenHandler)
        }
        if isAway {
            foreground?(nil)
        } else if removing != nil {
            foreground?(Self.foregroundApp(NSWorkspace.shared.frontmostApplication))
        }
        if isAway != wasAway { screen?(isAway) }
    }

    /// Whether the session's screen is locked now (`CGSSessionScreenIsLocked`, no permission).
    static func screenLockedNow() -> Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        return (session["CGSSessionScreenIsLocked"] as? Bool) ?? false
    }

    static func foregroundApp(_ app: NSRunningApplication?) -> ForegroundApp? {
        guard let app, let bundleId = app.bundleIdentifier, !ignored.contains(bundleId) else { return nil }
        let name = WireText.sanitized(app.localizedName ?? "", maxUnits: 256) ?? bundleId
        return ForegroundApp(bundleId: bundleId, name: name)
    }
}
