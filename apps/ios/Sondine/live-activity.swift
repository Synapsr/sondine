import ActivityKit
import Foundation
import SondinePhone
import WidgetKit

/// The Live Activity through ActivityKit: started, updated and ended by the
/// app, with no push service (ADR 032). One at a time.
struct ActivityKitPresenter: LiveActivityPresenting {
    private typealias Recording = Activity<RecordingActivityAttributes>

    func start(_ display: LiveActivityDisplay) async -> Bool {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return false }
        let started: Recording
        do {
            started = try Recording.request(attributes: RecordingActivityAttributes(), content: content(display), pushType: nil)
        } catch {
            return false
        }
        // The one it replaces at 8 hours, or one a killed app left.
        for activity in Recording.activities where activity.id != started.id {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        return true
    }

    func update(_ display: LiveActivityDisplay) async {
        for activity in Recording.activities {
            await activity.update(content(display))
        }
    }

    func end() async {
        for activity in Recording.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    private func content(_ display: LiveActivityDisplay) -> ActivityContent<RecordingActivityAttributes.ContentState> {
        ActivityContent(state: .init(display), staleDate: display.staleAtMs.map(Date.init(milliseconds:)))
    }
}

/// The control's state in the shared keychain group, read by the widget extension.
struct SharedControlState: ControlStatePublishing {
    func publish(_ state: ControlState, changed: Bool) {
        SharedState.control = state
        if changed { ControlCenter.shared.reloadControls(ofKind: SharedState.controlKind) }
    }
}

/// The UI test shows nothing outside the app.
struct NoLiveActivity: LiveActivityPresenting, ControlStatePublishing {
    func start(_ display: LiveActivityDisplay) async -> Bool { false }
    func update(_ display: LiveActivityDisplay) async {}
    func end() async {}
    func publish(_ state: ControlState, changed: Bool) {}
}
