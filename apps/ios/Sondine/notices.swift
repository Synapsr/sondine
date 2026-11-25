import Foundation
import SondinePhone

/// The words of the local notifications, from the String Catalog.
enum Notices {
    @Sendable static func words(_ notice: LocalNotifier.Notice) -> (title: String, body: String) {
        switch notice {
        case let .interrupted(atMs, cause):
            let time = clock(atMs)
            let title = String(localized: "Recording interrupted at \(time)")
            let body = cause == .call
                ? String(localized: "A call took the microphone. Open Sondine to resume.")
                : String(localized: "Another app or iOS took the microphone. Open Sondine to resume.")
            return (title, body)
        case let .stopped(atMs, end):
            let time = clock(atMs)
            let title = String(localized: "Recording stopped at \(time)")
            let body = end == .lowSpace
                ? String(localized: "The iPhone is almost full. What was recorded is kept.")
                : String(localized: "The file could not be written. What was recorded is kept.")
            return (title, body)
        case let .continues(sinceMs):
            let title = String(localized: "Sondine is still recording")
            let body = String(localized: "Since \(clock(sinceMs)). iOS takes the Live Activity off the Lock Screen after 8 hours; stop the recording in Sondine or with the control.")
            return (title, body)
        case let .couldNotStart(refusal):
            return (String(localized: "Sondine did not start recording"), RefusalWords.gesture(refusal))
        }
    }

    static func clock(_ ms: Int64) -> String {
        Date(timeIntervalSince1970: TimeInterval(ms) / 1000).formatted(date: .omitted, time: .shortened)
    }
}
