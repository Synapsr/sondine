import Foundation

/// The control (Lock Screen, Control Center, the Action button) and the Live
/// Activity's buttons (ADR 032, step M5.6): one gesture turns recording on or
/// off, through the recorder's own « Enregistrer », « Reprendre » and
/// « Arrêter », so a file stopped from the Lock Screen is closed as the app
/// closes it.
///
/// iOS may refuse to start the microphone from the background, and keeps it
/// there only while a Live Activity shows the recording. When either fails,
/// the gesture opens the app to start it there; when the app cannot be
/// opened, a notification says why. It never fails silently.
public struct RecordingControl: Sendable {
    /// Where the gesture runs.
    public enum Context: Equatable, Sendable {
        /// The app is in front: its screen shows a refusal.
        case app
        /// In the background, the phone perhaps locked. `canOpenApp`: iOS lets
        /// the gesture bring the app to the front.
        case background(canOpenApp: Bool)
    }

    public enum Outcome: Equatable, Sendable {
        case started
        /// The next file of an interrupted session.
        case resumed
        case stopped
        /// Already as asked.
        case unchanged
        /// Refused in the background for a reason the app can overcome: open it
        /// and ask again there (`Context.app`).
        case openApp(PhoneRecorder.StartRefusal)
        /// Refused, and the user was told: by the app's screen, or by a notification.
        case refused(PhoneRecorder.StartRefusal)
    }

    private let recorder: PhoneRecorder
    private let presence: RecordingPresence
    private let notifier: any PhoneNotifying

    public init(recorder: PhoneRecorder, presence: RecordingPresence, notifier: any PhoneNotifying) {
        self.recorder = recorder
        self.presence = presence
        self.notifier = notifier
    }

    /// Recording on (start, or resume an interrupted session) or off (stop).
    /// The Live Activity is up to date when it returns.
    public func set(recording on: Bool, context: Context) async -> Outcome {
        let outcome = await apply(on, context: context)
        let showing = await presence.refresh()
        switch (outcome, context) {
        case (.started, .background), (.resumed, .background):
            if showing { return outcome }
            // Started out of sight with nothing showing it: iOS would cut the
            // microphone (`AudioRecordingIntent`), so it stops here, and says so.
            await recorder.stop()
            await presence.refresh()
            return refused(.noLiveActivity, context: context)
        default:
            return outcome
        }
    }

    private func apply(_ on: Bool, context: Context) async -> Outcome {
        let phase = await recorder.snapshot.phase
        guard on else {
            if phase == .idle { return .unchanged }
            await recorder.stop()
            return .stopped
        }
        do throws(PhoneRecorder.StartRefusal) {
            switch phase {
            case .recording:
                return .unchanged
            case .idle:
                try await recorder.start()
                return .started
            case .interrupted:
                try await recorder.resume()
                return .resumed
            }
        } catch .busy {
            // Started meanwhile, by the app or another gesture.
            return .unchanged
        } catch {
            return refused(error, context: context)
        }
    }

    /// What only the app in front can overcome: iOS's block on starting the
    /// microphone from the background, a microphone not allowed yet, no Live
    /// Activity (the app in front records without one), and a phone not
    /// unlocked since it restarted (opening the app asks to unlock it).
    public static func needsApp(_ refusal: PhoneRecorder.StartRefusal) -> Bool {
        switch refusal {
        case .session, .noPermission, .noLiveActivity, .locked: true
        case .busy, .lowSpace, .files: false
        }
    }

    private func refused(_ refusal: PhoneRecorder.StartRefusal, context: Context) -> Outcome {
        switch context {
        case .app:
            return .refused(refusal)
        case let .background(canOpenApp):
            if canOpenApp, Self.needsApp(refusal) { return .openApp(refusal) }
            notifier.recordingCouldNotStart(refusal)
            return .refused(refusal)
        }
    }
}
