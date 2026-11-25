/// Device transport, as `packages/protocol` names it (`Transport`).
public enum Transport: String, Sendable, Hashable, Codable, CaseIterable {
    case builtIn = "built-in"
    case usb
    case bluetooth
    case bluetoothLE = "bluetooth-le"
    case thunderbolt
    case pci
    case firewire
    case hdmi
    case displayport
    case airplay
    case avb
    case continuity
    case virtual
    case aggregate
    case unknown

    /// Decodes `kAudioDevicePropertyTransportType`.
    public init(code: UInt32) {
        switch fourCharText(code) {
        case "bltn": self = .builtIn
        case "usb ": self = .usb
        case "blue": self = .bluetooth
        case "blea": self = .bluetoothLE
        case "thun": self = .thunderbolt
        case "pci ": self = .pci
        case "1394": self = .firewire
        case "hdmi": self = .hdmi
        case "dprt": self = .displayport
        case "airp": self = .airplay
        case "eavb": self = .avb
        case "ccwd", "ccwl", "ccap": self = .continuity
        case "virt": self = .virtual
        case "grup", "fgrp": self = .aggregate
        default: self = .unknown
        }
    }

    /// Transports automatic mode never opens, whatever the configured allowlist says:
    /// Bluetooth drops the headset to call quality, Continuity is meant for Macs without a mic,
    /// and virtual or aggregate devices carry other apps' audio.
    public static let neverAutomatic: Set<Transport> = [.bluetooth, .bluetoothLE, .continuity, .virtual, .aggregate]

    /// The default automatic allowlist (architecture §3).
    public static let defaultAllowlist: [Transport] = [.builtIn, .usb, .thunderbolt, .pci]

    public var isBluetooth: Bool { self == .bluetooth || self == .bluetoothLE }
}

/// Known loopback or virtual drivers that carry system audio. They are never microphone
/// candidates, even when their transport claims USB or built-in.
public enum LoopbackDevices {
    static let markers = [
        "blackhole", "loopback", "soundflower", "zoomaudiodevice", "ms teams audio", "microsoft teams audio",
        "ecamm", "rogue amoeba", "audio hijack", "background music", "virtual desktop speakers",
    ]

    public static func isLoopback(uid: String, name: String, transport: Transport) -> Bool {
        if transport == .virtual { return true }
        let haystack = (uid + " " + name).lowercased()
        return markers.contains { haystack.contains($0) }
    }
}
