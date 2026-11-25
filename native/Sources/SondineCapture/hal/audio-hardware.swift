import CoreAudio
import Dispatch
import Foundation

/// A Core Audio object id (device, process object, tap, aggregate). Never a durable key:
/// ids change across launches and after `ServiceRestarted`.
public typealias HALObjectID = UInt32

/// `kAudioObjectSystemObject`.
public let halSystemObject: HALObjectID = 1

public enum HALScope: Sendable, Hashable {
    case global, input, output
}

/// Properties the helper listens to. Each one maps to one Core Audio selector and scope.
public enum HALProperty: Sendable, Hashable {
    // System object
    case devices
    case defaultInputDevice
    case defaultOutputDevice
    case processObjectList
    case serviceRestarted
    case userSessionIsActiveOrHeadless
    // Devices
    case deviceIsAlive
    case nominalSampleRate
    case streamFormat(HALScope)
    case dataSource(HALScope)
    case deviceHasChanged
    case processorOverload
    // Process objects
    case processIsRunningInput
    case processIsRunningOutput
    case processDevices(HALScope)
    // Taps
    case tapFormat
}

/// One Core Audio device as read from the HAL.
public struct HALDeviceInfo: Sendable, Equatable {
    public var id: HALObjectID
    public var uid: String
    public var name: String
    /// `kAudioDevicePropertyTransportType` as a four-character code (`bltn`, `usb `, ...).
    public var transportCode: UInt32
    public var inputChannels: Int
    public var outputChannels: Int
    public var alive: Bool
    public var nominalRate: Double?
    public var inputDataSource: UInt32?
    public var outputDataSource: UInt32?
    /// Terminal types of the input streams (`kAudioStreamPropertyTerminalType`), for
    /// call-follow validation: a speaker's echo-reference stream is not a microphone.
    public var inputTerminalTypes: [UInt32]

    public init(
        id: HALObjectID,
        uid: String,
        name: String,
        transportCode: UInt32,
        inputChannels: Int,
        outputChannels: Int,
        alive: Bool = true,
        nominalRate: Double? = 48_000,
        inputDataSource: UInt32? = nil,
        outputDataSource: UInt32? = nil,
        inputTerminalTypes: [UInt32] = []
    ) {
        self.id = id
        self.uid = uid
        self.name = name
        self.transportCode = transportCode
        self.inputChannels = inputChannels
        self.outputChannels = outputChannels
        self.alive = alive
        self.nominalRate = nominalRate
        self.inputDataSource = inputDataSource
        self.outputDataSource = outputDataSource
        self.inputTerminalTypes = inputTerminalTypes
    }
}

/// Identity of a Core Audio process object, read once when it appears.
public struct HALProcessInfo: Sendable, Equatable {
    public var id: HALObjectID
    public var pid: Int32
    public var bundleID: String?

    public init(id: HALObjectID, pid: Int32, bundleID: String?) {
        self.id = id
        self.pid = pid
        self.bundleID = bundleID
    }
}

/// IO state of a process object, refreshed by its listeners.
public struct HALProcessIO: Sendable, Equatable {
    public var runningInput: Bool
    public var runningOutput: Bool
    public var inputDevices: [HALObjectID]
    public var outputDevices: [HALObjectID]

    public init(runningInput: Bool = false, runningOutput: Bool = false, inputDevices: [HALObjectID] = [], outputDevices: [HALObjectID] = []) {
        self.runningInput = runningInput
        self.runningOutput = runningOutput
        self.inputDevices = inputDevices
        self.outputDevices = outputDevices
    }
}

/// Stream format as the IOProc sees it (always native Float32 for HAL IOProcs).
public struct HALStreamFormat: Sendable, Equatable {
    public var sampleRate: Double
    public var channels: Int

    public init(sampleRate: Double, channels: Int) {
        self.sampleRate = sampleRate
        self.channels = channels
    }
}

/// A private process tap. Always unmuted: a tap is a copy, and a muted tap would silence the user.
public struct TapDescription: Sendable, Equatable {
    public enum Scope: Sendable, Equatable {
        /// Every process except these objects (`system:other`).
        case globalExcluding([HALObjectID])
        /// Only these objects (an app tap, M3).
        case processes([HALObjectID])
    }

    public var scope: Scope
    public var name: String
    public var uuid: UUID
    public var mono = true
    public var isPrivate = true

    public init(scope: Scope, name: String, uuid: UUID = UUID()) {
        self.scope = scope
        self.name = name
        self.uuid = uuid
    }
}

/// A private, tap-only aggregate device. `TapAutoStart` stays off so `AudioDeviceStart` never
/// waits for audio, and no output sub-device is opened (no Bluetooth hardware is touched).
public struct AggregateDescription: Sendable, Equatable {
    public var name: String
    public var uid: String
    public var tapUIDs: [String]
    public var isPrivate = true
    public var tapAutoStart = false
    public var driftCompensation = true

    public init(name: String, uid: String, tapUIDs: [String]) {
        self.name = name
        self.uid = uid
        self.tapUIDs = tapUIDs
    }
}

/// The IO callback. It runs on the HAL's real-time thread: it must not lock, allocate, or block.
public typealias HALIOBlock = @Sendable (_ input: UnsafePointer<AudioBufferList>, _ inputTime: UnsafePointer<AudioTimeStamp>) -> Void

public struct HALIOProcHandle: Sendable, Hashable {
    public var device: HALObjectID
    /// Opaque `AudioDeviceIOProcID` bits (or a fake id).
    public var raw: UInt

    public init(device: HALObjectID, raw: UInt) {
        self.device = device
        self.raw = raw
    }
}

public struct HALListenerToken: Sendable, Hashable {
    public var id: UInt64
    public init(id: UInt64) { self.id = id }
}

public struct HALError: Error, Equatable, CustomStringConvertible {
    public var operation: String
    public var status: Int32

    public init(_ operation: String, status: Int32) {
        self.operation = operation
        self.status = status
    }

    public var description: String { "\(operation) failed (OSStatus \(status) \(fourCharText(UInt32(bitPattern: status)) ?? ""))" }
}

/// Everything the helper needs from Core Audio, behind a protocol so the policy and the capture
/// engine run against `FakeAudioHardware` in tests (no hardware, no permission prompt).
///
/// Every call is synchronous; listener blocks run on the queue they were registered with.
public protocol AudioHardware: AnyObject, Sendable {
    // System object
    func deviceIDs() throws -> [HALObjectID]
    func defaultDevice(_ scope: HALScope) throws -> HALObjectID?
    func processObjectIDs() throws -> [HALObjectID]

    // Devices
    func deviceInfo(_ device: HALObjectID) throws -> HALDeviceInfo
    func nominalSampleRate(_ device: HALObjectID) throws -> Double
    func inputStreamFormat(_ device: HALObjectID) throws -> HALStreamFormat
    func bufferFrameSizeRange(_ device: HALObjectID) throws -> ClosedRange<UInt32>
    func setBufferFrameSize(_ device: HALObjectID, frames: UInt32) throws

    // Process objects
    func processInfo(_ process: HALObjectID) throws -> HALProcessInfo
    func processIO(_ process: HALObjectID) throws -> HALProcessIO

    // Listeners
    func addListener(
        _ object: HALObjectID,
        _ property: HALProperty,
        queue: DispatchQueue,
        _ block: @escaping @Sendable () -> Void
    ) throws -> HALListenerToken
    func removeListener(_ token: HALListenerToken)
    /// Forgets a listener whose object no longer exists. Core Audio dropped it with the object;
    /// removing it again only logs "no object with given ID".
    func discardListener(_ token: HALListenerToken)

    // IO
    func createIOProc(device: HALObjectID, inputOnly: Bool, _ block: @escaping HALIOBlock) throws -> HALIOProcHandle
    func destroyIOProc(_ handle: HALIOProcHandle)
    func startIO(_ handle: HALIOProcHandle) throws
    func stopIO(_ handle: HALIOProcHandle)

    // Taps and aggregates
    func createProcessTap(_ description: TapDescription) throws -> HALObjectID
    func updateProcessTap(_ tap: HALObjectID, _ description: TapDescription) throws
    func destroyProcessTap(_ tap: HALObjectID)
    func tapUID(_ tap: HALObjectID) throws -> String
    func tapFormat(_ tap: HALObjectID) throws -> HALStreamFormat
    func createAggregateDevice(_ description: AggregateDescription) throws -> HALObjectID
    func destroyAggregateDevice(_ device: HALObjectID)

    // Process-wide HAL settings
    func setSleepingIsAllowed(_ allowed: Bool) throws
    func setPowerHintFavorSavingPower(_ favor: Bool) throws
    func setProcessInputMute(_ muted: Bool) throws
    func userSessionIsActive() throws -> Bool
}

/// `bltn` → "bltn"; nil when a byte is not printable ASCII.
public func fourCharText(_ code: UInt32) -> String? {
    let bytes = [UInt8((code >> 24) & 0xff), UInt8((code >> 16) & 0xff), UInt8((code >> 8) & 0xff), UInt8(code & 0xff)]
    guard bytes.allSatisfy({ $0 >= 0x20 && $0 <= 0x7e }) else { return nil }
    return String(decoding: bytes, as: UTF8.self)
}

/// "bltn" → `bltn`.
public func fourCharCode(_ text: String) -> UInt32 {
    var code: UInt32 = 0
    for byte in text.utf8.prefix(4) { code = code << 8 | UInt32(byte) }
    return code
}
