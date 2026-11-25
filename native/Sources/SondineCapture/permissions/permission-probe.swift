import AVFoundation
import Darwin
import Foundation
import Synchronization

/// Reads permission states without prompting, and asks for the microphone prompt on request.
/// Status is reported apart from stream health; `granted-verified` comes only from a signal.
public protocol PermissionProbe: Sendable {
    func microphone() -> PermissionState
    func systemAudio() -> PermissionState
    /// Shows the microphone prompt (only from `request.permissions` in the real app).
    func requestMicrophone(_ completion: @escaping @Sendable (Bool) -> Void)
}

/// The real probes: `AVCaptureDevice.authorizationStatus` for the microphone, and the private
/// `TCCAccessPreflight("kTCCServiceAudioCapture")` for system audio when it can be loaded.
/// Neither prompts. TCC credits the responsible process, so results from a terminal describe
/// the terminal, not Sondine.app.
public final class SystemPermissionProbe: PermissionProbe, @unchecked Sendable {
    private typealias Preflight = @convention(c) (CFString, CFDictionary?) -> Int

    private let preflight: Preflight?

    public init() {
        if let handle = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW),
           let symbol = dlsym(handle, "TCCAccessPreflight") {
            preflight = unsafeBitCast(symbol, to: Preflight.self)
        } else {
            preflight = nil
        }
    }

    public func microphone() -> PermissionState {
        let status: PermissionStatus = switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .notDetermined: .notDetermined
        case .restricted: .restricted
        case .denied: .denied
        case .authorized: .granted
        @unknown default: .unknown
        }
        return PermissionState(status: status, evidence: .authorizationStatus)
    }

    public func systemAudio() -> PermissionState {
        guard let preflight else { return .notChecked }
        // 0 granted, 1 denied, 2 not yet asked (as AudioCap reads it); anything else is unknown.
        let status: PermissionStatus = switch preflight("kTCCServiceAudioCapture" as CFString, nil) {
        case 0: .granted
        case 1: .denied
        case 2: .notDetermined
        default: .unknown
        }
        return PermissionState(status: status, evidence: .tccPreflight)
    }

    public func requestMicrophone(_ completion: @escaping @Sendable (Bool) -> Void) {
        AVCaptureDevice.requestAccess(for: .audio, completionHandler: completion)
    }
}

/// Scripted permissions for tests and `serve --hal fake`; never touches TCC.
public final class FakePermissionProbe: PermissionProbe, @unchecked Sendable {
    private struct State {
        var microphone = PermissionState(status: .granted, evidence: .authorizationStatus)
        var systemAudio = PermissionState(status: .granted, evidence: .tccPreflight)
        var microphoneRequests = 0
        var grantOnRequest = true
    }

    private let state = Mutex(State())

    public init() {}

    public func set(microphone: PermissionState? = nil, systemAudio: PermissionState? = nil) {
        state.withLock { state in
            if let microphone { state.microphone = microphone }
            if let systemAudio { state.systemAudio = systemAudio }
        }
    }

    public var microphoneRequests: Int { state.withLock { $0.microphoneRequests } }

    public func microphone() -> PermissionState { state.withLock { $0.microphone } }
    public func systemAudio() -> PermissionState { state.withLock { $0.systemAudio } }

    public func requestMicrophone(_ completion: @escaping @Sendable (Bool) -> Void) {
        let granted = state.withLock { state -> Bool in
            state.microphoneRequests += 1
            if state.grantOnRequest { state.microphone = PermissionState(status: .granted, evidence: .authorizationStatus) }
            return state.grantOnRequest
        }
        completion(granted)
    }
}

/// Combines probe readings with signal evidence: a non-zero sample upgrades a track's
/// permission to `granted-verified`; only an explicit denial (revocation) takes it back.
/// Silence never proves denial.
public struct PermissionTracker: Sendable, Equatable {
    public private(set) var microphone = PermissionState.notChecked
    public private(set) var systemAudio = PermissionState.notChecked

    public init() {}

    /// Returns true when either state changed.
    public mutating func refresh(microphone probedMicrophone: PermissionState, systemAudio probedSystem: PermissionState) -> Bool {
        let before = self
        microphone = Self.merge(current: microphone, probed: probedMicrophone)
        systemAudio = Self.merge(current: systemAudio, probed: probedSystem)
        return before != self
    }

    public mutating func verify(_ kind: TrackKind) -> Bool {
        let verified = PermissionState(status: .grantedVerified, evidence: .firstSignal)
        switch kind {
        case .microphone:
            guard microphone != verified else { return false }
            microphone = verified
        case .system, .app:
            guard systemAudio != verified else { return false }
            systemAudio = verified
        }
        return true
    }

    static func merge(current: PermissionState, probed: PermissionState) -> PermissionState {
        guard current.status == .grantedVerified else { return probed }
        return probed.status == .denied || probed.status == .restricted ? probed : current
    }
}
