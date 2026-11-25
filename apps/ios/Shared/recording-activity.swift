import ActivityKit
import Foundation
import Security
import SondinePhone

/// The Live Activity of a recording (iphone-screens.md, « Live Activity »):
/// the elapsed time, « Arrêter », and the interrupted state. Started and
/// updated by the app only, never by a push service (ADR 032).
struct RecordingActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// The counter counts from here: iOS draws it, with no update per second.
        var countsFrom: Date
        /// Set while interrupted: the counter stops there.
        var interruptedAt: Date?
        var byCall: Bool

        init(_ display: LiveActivityDisplay) {
            countsFrom = Date(milliseconds: display.countsFromMs)
            switch display.state {
            case .recording:
                interruptedAt = nil
                byCall = false
            case let .interrupted(atMs, cause):
                interruptedAt = Date(milliseconds: atMs)
                byCall = cause == .call
            }
        }
    }
}

/// What the app and the widget extension share: the control's state, in a
/// keychain group both may read. An app group would need a registration the
/// App Store Connect API cannot make (ADR 031, « Built at M5.6 »); a keychain
/// group of the team needs none.
enum SharedState {
    /// The control's kind, to draw it again when recording starts or stops.
    static let controlKind = "app.sondine.ios.record"
    /// `$(AppIdentifierPrefix)app.sondine.ios.shared` in both entitlements.
    private static let group = "P5G8WAJ2G2.app.sondine.ios.shared"
    private static let service = "app.sondine.ios.control"

    private static var item: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccessGroup as String: group,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "state",
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    /// Read and written with the phone locked: the control shows on the Lock Screen.
    static var control: ControlState? {
        get {
            var query = item
            query[kSecReturnData as String] = true
            var found: CFTypeRef?
            guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let data = found as? Data else {
                return nil
            }
            return try? JSONDecoder().decode(ControlState.self, from: data)
        }
        set {
            guard let newValue, let data = try? JSONEncoder().encode(newValue) else {
                SecItemDelete(item as CFDictionary)
                return
            }
            let changes = [kSecValueData as String: data]
            if SecItemUpdate(item as CFDictionary, changes as CFDictionary) == errSecItemNotFound {
                var added = item
                added[kSecValueData as String] = data
                added[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                SecItemAdd(added as CFDictionary, nil)
            }
        }
    }
}

extension Date {
    init(milliseconds: Int64) { self.init(timeIntervalSince1970: TimeInterval(milliseconds) / 1000) }
}
