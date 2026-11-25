import Foundation
import SondineKit

// Swift mirror of `packages/protocol` (helper socket, protocol 7). The zod schemas are the
// source of truth; the golden fixtures in `packages/protocol/fixtures` are the contract.

public enum HelperProtocol {
    public static let version = 7
    /// Longest accepted line in bytes, newline excluded.
    public static let maxLineBytes = 1_048_576
}

/// A field the schema marks nullable: always present on the wire, `null` when absent.
/// (Plain optionals are omitted when nil, which is how the schema spells optional fields.)
@propertyWrapper
public struct Nullable<Value: Codable & Sendable & Equatable>: Codable, Sendable, Equatable {
    public var wrappedValue: Value?

    public init(wrappedValue: Value?) { self.wrappedValue = wrappedValue }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        wrappedValue = container.decodeNil() ? nil : try container.decode(Value.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        if let wrappedValue { try container.encode(wrappedValue) } else { try container.encodeNil() }
    }
}

public enum PermissionStatus: String, Codable, Sendable, Equatable, CaseIterable {
    case unknown
    case notDetermined = "not-determined"
    case restricted
    case denied
    case granted
    case grantedVerified = "granted-verified"

    /// Only System Settings can lift these; a run must not continue under them.
    public var blocksCapture: Bool { self == .denied || self == .restricted }
}

public enum PermissionEvidence: String, Codable, Sendable, Equatable, CaseIterable {
    case authorizationStatus = "authorization-status"
    case tccPreflight = "tcc-preflight"
    case firstSignal = "first-signal"
    case notChecked = "not-checked"
}

public enum StreamState: String, Codable, Sendable, Equatable, CaseIterable {
    case starting, running, stalled
    case zeroSuspect = "zero-suspect"
}

public enum AttributionConfidence: String, Codable, Sendable, Equatable, CaseIterable {
    case exact
    case singleActive = "single-active"
    case ambiguous
}

public enum MappingEvidence: String, Codable, Sendable, Equatable, CaseIterable {
    case responsibility, ancestry, path
    case daemonMap = "daemon-map"
    case halBundleId = "hal-bundle-id"
}

public enum MappingConfidence: String, Codable, Sendable, Equatable, CaseIterable {
    case high, medium, low
}

public enum InputSelection: String, Codable, Sendable, Equatable, CaseIterable {
    case pinned
    case callFollow = "call-follow"
    case automaticDefault = "default"
}

public enum PauseScope: String, Codable, Sendable, Equatable, CaseIterable {
    case all, microphone
    case systemAudio = "system-audio"

    public var coversMicrophone: Bool { self != .systemAudio }
    public var coversSystemAudio: Bool { self != .microphone }
}

public enum TrackEndReason: String, Codable, Sendable, Equatable, CaseIterable {
    /// `paused` is the user's pause only; `held`, a private zone (ADR 029).
    case paused, held, disabled, excluded
    case deviceRemoved = "device-removed"
    case deviceChanged = "device-changed"
    case tapReleased = "tap-released"
    case sleep
    case serviceRestarted = "service-restarted"
    case permission, error, shutdown

    /// The run ended because its Core Audio objects are gone, listeners included.
    var objectsGone: Bool { self == .deviceRemoved || self == .serviceRestarted }
}

public enum TrackUpdateReason: String, Codable, Sendable, Equatable, CaseIterable {
    case rateChange = "rate-change"
    case formatChange = "format-change"
    case stream, source
}

public enum ClockReason: String, Codable, Sendable, Equatable, CaseIterable {
    case periodic, wake, request
}

public enum HealthStage: String, Codable, Sendable, Equatable, CaseIterable {
    case ioCallback = "io-callback"
    case drain, resample
    case energyGate = "energy-gate"
    case vad, envelope
    case spoolWrite = "spool-write"
    case spoolFsync = "spool-fsync"
    case manifestFsync = "manifest-fsync"
    /// From the decision to start a tap to its first block (ADR 026).
    case tapStart = "tap-start"
}

public enum ErrorCode: String, Codable, Sendable, Equatable, CaseIterable {
    case protocolUnsupported = "protocol.unsupported"
    case requestInvalid = "request.invalid"
    case requestRejected = "request.rejected"
    case permissionDenied = "permission.denied"
    case diskFull = "disk.full"
    case spoolIO = "spool.io"
    case captureFailed = "capture.failed"
    case vadUnavailable = "vad.unavailable"
    case `internal`
}

public enum ProcessExclusion: String, Codable, Sendable, Equatable, CaseIterable {
    case own, user
}

public typealias ClockPoint = ManifestClockPoint
public typealias WireClockAnchor = ManifestClockAnchor
public typealias WireTimebase = ManifestTimebase

public struct GapSpan: Codable, Sendable, Equatable {
    public var reason: GapReason
    public var fromSample: Int64
    public var toSample: Int64

    public init(reason: GapReason, fromSample: Int64, toSample: Int64) {
        self.reason = reason
        self.fromSample = fromSample
        self.toSample = toSample
    }

    public init(_ gap: ManifestGap) {
        self.init(reason: gap.reason, fromSample: gap.fromSample, toSample: gap.toSample)
    }
}

/// Text checks shared by the decoder (strict input) and the encoder side (sanitized output).
public enum WireText {
    /// `RequestId`: `^[A-Za-z0-9._:-]{1,64}$`.
    public static func isRequestId(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        return (1...64).contains(bytes.count) && bytes.allSatisfy { isAlphanumeric($0) || $0 == 46 || $0 == 95 || $0 == 58 || $0 == 45 }
    }

    /// `ShortText` and `DeviceUid`: no control characters, counted in UTF-16 units as JS does.
    public static func isPlainText(_ text: String, maxUnits: Int) -> Bool {
        let units = text.utf16.count
        return units >= 1 && units <= maxUnits && !text.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f }
    }

    /// `VersionText`: `^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`.
    public static func isVersion(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        guard (1...64).contains(bytes.count), isAlphanumeric(bytes[0]) else { return false }
        return bytes.allSatisfy { isAlphanumeric($0) || $0 == 46 || $0 == 95 || $0 == 43 || $0 == 45 }
    }

    /// `Uuid`: lowercase canonical.
    public static func isUuid(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        guard bytes.count == 36 else { return false }
        return bytes.enumerated().allSatisfy { index, byte in
            [8, 13, 18, 23].contains(index) ? byte == 45 : (48...57).contains(byte) || (97...102).contains(byte)
        }
    }

    /// `NetworkHash`: 32 lowercase hex characters.
    public static func isNetworkHash(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        return bytes.count == 32 && bytes.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    /// `BundleId`: `^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$`.
    public static func isBundleId(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        guard (1...255).contains(bytes.count), isAlphanumeric(bytes[0]) else { return false }
        return bytes.allSatisfy { isAlphanumeric($0) || $0 == 95 || $0 == 46 || $0 == 45 }
    }

    /// `WarningCode`: dotted lowercase segments, at most 64 bytes.
    public static func isWarningCode(_ text: String) -> Bool {
        let segments = text.split(separator: ".", omittingEmptySubsequences: false)
        guard text.utf8.count <= 64, segments.count >= 2 else { return false }
        return segments.allSatisfy { segment in
            guard let first = segment.utf8.first, (97...122).contains(first) else { return false }
            return segment.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
        }
    }

    /// Replaces control characters and cuts to `maxUnits` UTF-16 units; nil when nothing is left.
    public static func sanitized(_ text: String, maxUnits: Int) -> String? {
        var result = ""
        var units = 0
        for scalar in text.unicodeScalars {
            let clean: Unicode.Scalar = scalar.value < 0x20 || scalar.value == 0x7f ? " " : scalar
            let width = UTF16.width(clean)
            if units + width > maxUnits { break }
            result.unicodeScalars.append(clean)
            units += width
        }
        let trimmed = result.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func isAlphanumeric(_ byte: UInt8) -> Bool {
        (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte)
    }
}

/// Track keys: `input:<deviceUID>`, `app:<bundleID>`, `system:other`.
public enum TrackKeys {
    public static let system = "system:other"
    public static func input(_ uid: String) -> String { "input:\(uid)" }
    public static func app(_ bundleId: String) -> String { "app:\(bundleId)" }
}
