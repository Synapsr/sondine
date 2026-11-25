import SwiftUI
import WidgetKit

/// The widget extension (ADR 031, step M5.6): it draws, the app records. Its
/// gestures are `SetRecordingIntent`, which iOS runs in the app's process.
@main
struct SondineWidgets: WidgetBundle {
    var body: some Widget {
        RecordControl()
        RecordingLiveActivity()
    }
}
