/// The user's pin (`pin.input`): a hard override of automatic selection.
public struct InputPin: Sendable, Equatable {
    public var deviceUid: String
    /// Explicit consent to open a Bluetooth microphone (drops the headset to call quality).
    public var allowBluetooth: Bool

    public init(deviceUid: String, allowBluetooth: Bool) {
        self.deviceUid = deviceUid
        self.allowBluetooth = allowBluetooth
    }
}

/// The input device a call is using (call-follow, ADR 026): the engine holds it for the call
/// and a few seconds after; the policy checks the device is a real microphone.
public struct CallFollowCandidate: Sendable, Equatable {
    public var deviceUid: String

    public init(deviceUid: String) {
        self.deviceUid = deviceUid
    }
}

public struct MicrophoneChoice: Sendable, Equatable {
    public var device: CatalogDevice
    public var selection: InputSelection
    /// Set when automatic mode did not use the default input, with the reason (for a warning).
    public var substitutedFor: String?
}

public enum MicrophoneDecision: Sendable, Equatable {
    case open(MicrophoneChoice)
    /// No microphone; `reason` explains why, for a warning.
    case none(reason: String)

    public var choice: MicrophoneChoice? {
        if case .open(let choice) = self { return choice }
        return nil
    }
}

/// One active microphone (architecture §3 Microphones). First match wins:
/// 1. the pinned device, a hard override (absent or refused means no microphone, never another one);
/// 2. the input device of a call (call-follow), Bluetooth included: the call already holds it;
/// 3. the default input, if its transport is on the allowlist (built-in, USB, Thunderbolt, PCI);
/// 4. the built-in microphone;
/// 5. none.
/// Bluetooth, Continuity, virtual, aggregate and loopback devices are never opened automatically.
public enum MicrophonePolicy {
    public static func decide(
        devices: [CatalogDevice],
        defaultInput: HALObjectID?,
        pin: InputPin?,
        allowedTransports: [Transport] = Transport.defaultAllowlist,
        callFollow: CallFollowCandidate? = nil
    ) -> MicrophoneDecision {
        let usable = devices.filter { $0.hasInput && $0.info.alive && !$0.uid.hasPrefix(DeviceCatalog.ownAggregatePrefix) }

        if let pin {
            guard let device = usable.first(where: { $0.uid == pin.deviceUid }) else {
                return .none(reason: "The pinned microphone is not connected.")
            }
            if device.transport.isBluetooth && !pin.allowBluetooth {
                return .none(reason: "The pinned microphone is Bluetooth; opening it needs explicit consent.")
            }
            return .open(MicrophoneChoice(device: device, selection: .pinned, substitutedFor: nil))
        }

        if let callFollow, let device = usable.first(where: { $0.uid == callFollow.deviceUid }), canFollow(device) {
            return .open(MicrophoneChoice(device: device, selection: .callFollow, substitutedFor: nil))
        }

        let allowed = Set(allowedTransports).subtracting(Transport.neverAutomatic)
        func automatic(_ device: CatalogDevice) -> Bool { allowed.contains(device.transport) && !device.loopback }

        var substituted: String?
        if let current = usable.first(where: { $0.id == defaultInput }) {
            if automatic(current) {
                return .open(MicrophoneChoice(device: current, selection: .automaticDefault, substitutedFor: nil))
            }
            substituted = current.uid
        }
        if let builtIn = usable.first(where: { $0.transport == .builtIn && !$0.loopback }), allowed.contains(.builtIn) {
            return .open(MicrophoneChoice(device: builtIn, selection: .automaticDefault, substitutedFor: substituted))
        }
        return .none(reason: substituted == nil ? "No microphone is available." : "The default input is not on the automatic allowlist.")
    }

    /// A device a call reads that the microphone may follow: a live input that is a microphone,
    /// not a loopback, virtual or aggregate device (Sondine's own included), nor one whose input
    /// streams all carry what a speaker plays (an echo reference).
    public static func canFollow(_ device: CatalogDevice) -> Bool {
        guard device.hasInput, device.info.alive, !device.loopback, device.transport != .virtual, device.transport != .aggregate,
              !device.uid.hasPrefix(DeviceCatalog.ownAggregatePrefix) else { return false }
        let types = device.info.inputTerminalTypes
        return types.isEmpty || !types.allSatisfy(speakerTerminals.contains)
    }

    static let speakerTerminals = Set(["spkr", "hdph", "lfes", "rspk"].map(fourCharCode))
}
