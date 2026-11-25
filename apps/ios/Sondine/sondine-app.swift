import SondinePhone
import SwiftUI
import UserNotifications

@main
struct SondineApp: App {
    @UIApplicationDelegateAdaptor(NotificationDelegate.self) private var notifications
    @State private var model = AppModel.shared
    @Environment(\.scenePhase) private var scenePhase

    init() {
        Theme.registerFonts()
        Self.styleBars()
    }

    /// The navigation bars' titles in Allo, as the Mac's.
    private static func styleBars() {
        let ink = UIColor(Theme.text)
        let appearance = UINavigationBarAppearance()
        appearance.configureWithDefaultBackground()
        if let large = UIFont(name: "AlloVariable-DisplaySemiBold", size: 32) {
            appearance.largeTitleTextAttributes = [
                .font: UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: large), .foregroundColor: ink, .kern: -0.64,
            ]
        }
        if let inline = UIFont(name: "AlloVariable-SemiBold", size: 17) {
            appearance.titleTextAttributes = [.font: UIFontMetrics(forTextStyle: .headline).scaledFont(for: inline), .foregroundColor: ink]
        }
        let scrolled = appearance.copy()
        appearance.configureWithTransparentBackground()
        appearance.largeTitleTextAttributes = scrolled.largeTitleTextAttributes
        appearance.titleTextAttributes = scrolled.titleTextAttributes
        UINavigationBar.appearance().standardAppearance = scrolled
        UINavigationBar.appearance().scrollEdgeAppearance = appearance
        UINavigationBar.appearance().compactAppearance = scrolled
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if model.firstRunDone {
                    HomeView()
                } else {
                    FirstRunView()
                }
            }
            .environment(model)
            .tint(Theme.ink)
            .onChange(of: scenePhase) { _, phase in
                // Back unlocked: what a kill left open is closed, files go « complete », and the sync runs.
                switch phase {
                case .active: model.becameActive()
                case .background: model.wentToBackground()
                default: break
                }
            }
        }
    }
}

/// Shows « Enregistrement interrompu » even while the app is in front; a tap
/// opens the app, whose recording screen offers « Reprendre », and the
/// notification's own « Reprendre » opens it and resumes.
final class NotificationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        LocalNotifier.registerCategories(resumeTitle: String(localized: "Resume"))
        return true
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
        guard response.actionIdentifier == LocalNotifier.resumeAction else { return }
        // After a relaunch nothing is interrupted any more: the app just opens.
        guard await AppModel.shared.interrupted != nil else { return }
        await AppModel.shared.resume()
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
