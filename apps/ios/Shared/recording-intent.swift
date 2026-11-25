import AppIntents
import SondinePhone

/// The app's side of the gestures made outside it: set by the app at launch.
@MainActor protocol RecordingGestureHandling: AnyObject {
    /// Through the recorder's own start, resume and stop; the Live Activity is
    /// up before it returns.
    func setRecording(_ on: Bool, context: RecordingControl.Context) async -> RecordingControl.Outcome
    /// Why recording could not start, in the user's words.
    func words(for refusal: PhoneRecorder.StartRefusal) -> String
}

@MainActor enum RecordingGestures {
    static var handler: (any RecordingGestureHandling)?
}

/// « Enregistrer » outside the app (ADR 032, step M5.6): the control on the
/// Lock Screen, in Control Center and on the Action button, and the Live
/// Activity's « Arrêter » and « Reprendre ».
///
/// It always runs in the app's process, which records; the widget extension
/// only shows it. As an `AudioRecordingIntent` it may start the microphone in
/// the background, the phone locked, provided a Live Activity shows the
/// recording, which the app starts before it returns. When iOS refuses all
/// the same, the app comes to the front and starts there; when even that is
/// refused, a notification says why. Never a silent failure.
struct SetRecordingIntent: SetValueIntent, AudioRecordingIntent, LiveActivityIntent {
    static let title: LocalizedStringResource = "Record with Sondine"
    static let description = IntentDescription("Starts or stops a recording. If iOS does not let it start from the Lock Screen, Sondine opens to start it.")
    /// In place first; the app comes to the front only when iOS refuses.
    static let supportedModes: IntentModes = [.background, .foreground(.dynamic)]
    static let allowedExecutionTargets: IntentExecutionTargets = [.main]
    /// From a locked phone, without unlocking: recording is one gesture (ADR 032).
    static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

    @Parameter(title: "Recording")
    var value: Bool

    init() {}

    init(recording: Bool) {
        value = recording
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        guard let handler = RecordingGestures.handler else {
            throw RecordingGestureError(message: String(localized: "Sondine could not be reached. Open it to record."))
        }
        let mode = systemContext.currentMode
        let context: RecordingControl.Context = mode == .foreground
            ? .app
            : .background(canOpenApp: mode.canContinueInForeground)
        var outcome = await handler.setRecording(value, context: context)
        if case .openApp = outcome {
            do {
                try await continueInForeground(alwaysConfirm: false)
                outcome = await handler.setRecording(value, context: .app)
            } catch {
                // Not brought to the front (the phone stayed locked): the notification says why.
                outcome = await handler.setRecording(value, context: .background(canOpenApp: false))
            }
        }
        if case let .refused(refusal) = outcome {
            throw RecordingGestureError(message: handler.words(for: refusal))
        }
        return .result()
    }
}

/// Shown by iOS where the gesture was made, beside the notification.
struct RecordingGestureError: Error, CustomLocalizedStringResourceConvertible {
    let message: String
    var localizedStringResource: LocalizedStringResource { LocalizedStringResource(stringLiteral: message) }
}
