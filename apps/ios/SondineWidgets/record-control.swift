import SondinePhone
import SwiftUI
import WidgetKit

/// « Enregistrer » for the Lock Screen, Control Center and the Action button
/// (iphone-screens.md, « Control »): on starts a recording, or resumes an
/// interrupted one; off stops it, as « Arrêter » does.
struct RecordControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: SharedState.controlKind, provider: Provider()) { recording in
            ControlWidgetToggle(isOn: recording, action: SetRecordingIntent()) {
                Label("Record", systemImage: "record.circle")
            } valueLabel: { on in
                Label(on ? "Recording" : "Record", systemImage: on ? "stop.circle" : "record.circle")
            }
            .tint(Theme.danger)
        }
        .displayName("Record")
        .description("Starts or stops a recording with Sondine.")
    }

    /// What the app last said, believed for 5 minutes while it records.
    struct Provider: ControlValueProvider {
        var previewValue: Bool { false }

        func currentValue() async throws -> Bool {
            SharedState.control?.isRecording(nowMs: SystemClock().nowMs()) ?? false
        }
    }
}
