import AudioToolbox
import CoreAudio
import Dispatch
import Foundation
import Synchronization

/// The real HAL. Each property read is a synchronous round trip that coreaudiod serves (about
/// 90 µs of its CPU), so callers read once and then follow listeners; nothing here polls.
public final class CoreAudioHardware: AudioHardware, @unchecked Sendable {
    // The block is only handed back to Core Audio for removal.
    private struct Listener: @unchecked Sendable {
        var object: AudioObjectID
        var address: AudioObjectPropertyAddress
        var queue: DispatchQueue
        var block: AudioObjectPropertyListenerBlock
    }

    private struct Registry: @unchecked Sendable {
        var nextToken: UInt64 = 1
        var listeners: [UInt64: Listener] = [:]
        var procs: [UInt: AudioDeviceIOProcID] = [:]
    }

    private let registry = Mutex(Registry())

    public init() {}

    // MARK: System object

    public func deviceIDs() throws -> [HALObjectID] {
        try readArray(AudioObjectID(kAudioObjectSystemObject), address(kAudioHardwarePropertyDevices), AudioObjectID(0))
    }

    public func defaultDevice(_ scope: HALScope) throws -> HALObjectID? {
        let selector = scope == .output ? kAudioHardwarePropertyDefaultOutputDevice : kAudioHardwarePropertyDefaultInputDevice
        let id: AudioObjectID = try read(AudioObjectID(kAudioObjectSystemObject), address(selector), AudioObjectID(0))
        return id == kAudioObjectUnknown ? nil : id
    }

    public func processObjectIDs() throws -> [HALObjectID] {
        try readArray(AudioObjectID(kAudioObjectSystemObject), address(kAudioHardwarePropertyProcessObjectList), AudioObjectID(0))
    }

    // MARK: Devices

    public func deviceInfo(_ device: HALObjectID) throws -> HALDeviceInfo {
        let uid = try readString(device, address(kAudioDevicePropertyDeviceUID))
        let name = (try? readString(device, address(kAudioObjectPropertyName))) ?? uid
        let transport: UInt32 = (try? read(device, address(kAudioDevicePropertyTransportType), UInt32(0))) ?? 0
        let alive: UInt32 = (try? read(device, address(kAudioDevicePropertyDeviceIsAlive), UInt32(1))) ?? 1
        let rate: Double? = try? read(device, address(kAudioDevicePropertyNominalSampleRate), Float64(0))
        let inputChannels = channelCount(device, scope: kAudioObjectPropertyScopeInput)
        let outputChannels = channelCount(device, scope: kAudioObjectPropertyScopeOutput)
        return HALDeviceInfo(
            id: device,
            uid: uid,
            name: name,
            transportCode: transport,
            inputChannels: inputChannels,
            outputChannels: outputChannels,
            alive: alive != 0,
            nominalRate: rate.flatMap { $0 > 0 ? $0 : nil },
            inputDataSource: inputChannels > 0 ? optionalRead(device, address(kAudioDevicePropertyDataSource, kAudioObjectPropertyScopeInput)) : nil,
            outputDataSource: outputChannels > 0 ? optionalRead(device, address(kAudioDevicePropertyDataSource, kAudioObjectPropertyScopeOutput)) : nil,
            inputTerminalTypes: inputChannels > 0 ? terminalTypes(device) : []
        )
    }

    public func nominalSampleRate(_ device: HALObjectID) throws -> Double {
        try read(device, address(kAudioDevicePropertyNominalSampleRate), Float64(0))
    }

    public func inputStreamFormat(_ device: HALObjectID) throws -> HALStreamFormat {
        HALStreamFormat(sampleRate: try nominalSampleRate(device), channels: channelCount(device, scope: kAudioObjectPropertyScopeInput))
    }

    public func bufferFrameSizeRange(_ device: HALObjectID) throws -> ClosedRange<UInt32> {
        let range: AudioValueRange = try read(device, address(kAudioDevicePropertyBufferFrameSizeRange), AudioValueRange())
        let low = UInt32(max(1, range.mMinimum.rounded(.up)))
        return low...max(low, UInt32(range.mMaximum.rounded(.down)))
    }

    public func setBufferFrameSize(_ device: HALObjectID, frames: UInt32) throws {
        try write(device, address(kAudioDevicePropertyBufferFrameSize), frames)
    }

    // MARK: Process objects

    public func processInfo(_ process: HALObjectID) throws -> HALProcessInfo {
        let pid: pid_t = try read(process, address(kAudioProcessPropertyPID), pid_t(0))
        let bundle = try? readString(process, address(kAudioProcessPropertyBundleID))
        return HALProcessInfo(id: process, pid: pid, bundleID: bundle.flatMap { $0.isEmpty ? nil : $0 })
    }

    public func processIO(_ process: HALObjectID) throws -> HALProcessIO {
        let input: UInt32 = try read(process, address(kAudioProcessPropertyIsRunningInput), UInt32(0))
        let output: UInt32 = try read(process, address(kAudioProcessPropertyIsRunningOutput), UInt32(0))
        return HALProcessIO(
            runningInput: input != 0,
            runningOutput: output != 0,
            inputDevices: input != 0
                ? (try? readArray(process, address(kAudioProcessPropertyDevices, kAudioObjectPropertyScopeInput), AudioObjectID(0))) ?? []
                : [],
            outputDevices: output != 0
                ? (try? readArray(process, address(kAudioProcessPropertyDevices, kAudioObjectPropertyScopeOutput), AudioObjectID(0))) ?? []
                : []
        )
    }

    // MARK: Listeners

    public func addListener(
        _ object: HALObjectID,
        _ property: HALProperty,
        queue: DispatchQueue,
        _ block: @escaping @Sendable () -> Void
    ) throws -> HALListenerToken {
        var propertyAddress = Self.address(of: property)
        let listener: AudioObjectPropertyListenerBlock = { _, _ in block() }
        let status = AudioObjectAddPropertyListenerBlock(object, &propertyAddress, queue, listener)
        guard status == noErr else { throw HALError("AudioObjectAddPropertyListenerBlock", status: status) }
        let id = registry.withLock { state in
            let id = state.nextToken
            state.nextToken += 1
            state.listeners[id] = Listener(object: object, address: propertyAddress, queue: queue, block: listener)
            return id
        }
        return HALListenerToken(id: id)
    }

    public func removeListener(_ token: HALListenerToken) {
        guard let listener = registry.withLock({ $0.listeners.removeValue(forKey: token.id) }) else { return }
        var propertyAddress = listener.address
        _ = AudioObjectRemovePropertyListenerBlock(listener.object, &propertyAddress, listener.queue, listener.block)
    }

    public func discardListener(_ token: HALListenerToken) {
        _ = registry.withLock { $0.listeners.removeValue(forKey: token.id) }
    }

    // MARK: IO

    public func createIOProc(device: HALObjectID, inputOnly: Bool, _ block: @escaping HALIOBlock) throws -> HALIOProcHandle {
        var procID: AudioDeviceIOProcID?
        // A nil queue runs the block directly on the HAL's real-time IO thread.
        let status = AudioDeviceCreateIOProcIDWithBlock(&procID, device, nil) { _, input, inputTime, _, _ in
            block(input, inputTime)
        }
        guard status == noErr, let procID else { throw HALError("AudioDeviceCreateIOProcIDWithBlock", status: status) }
        if inputOnly { disableOutputStreams(device: device, procID: procID) }
        let raw = UInt(bitPattern: unsafeBitCast(procID, to: Int.self))
        registry.withLock { $0.procs[raw] = procID }
        return HALIOProcHandle(device: device, raw: raw)
    }

    public func destroyIOProc(_ handle: HALIOProcHandle) {
        guard let procID = registry.withLock({ $0.procs.removeValue(forKey: handle.raw) }) else { return }
        _ = AudioDeviceDestroyIOProcID(handle.device, procID)
    }

    public func startIO(_ handle: HALIOProcHandle) throws {
        guard let procID = registry.withLock({ $0.procs[handle.raw] }) else { throw HALError("AudioDeviceStart", status: -1) }
        let status = AudioDeviceStart(handle.device, procID)
        guard status == noErr else { throw HALError("AudioDeviceStart", status: status) }
    }

    public func stopIO(_ handle: HALIOProcHandle) {
        guard let procID = registry.withLock({ $0.procs[handle.raw] }) else { return }
        _ = AudioDeviceStop(handle.device, procID)
    }

    // MARK: Taps and aggregates

    public func createProcessTap(_ description: TapDescription) throws -> HALObjectID {
        var tap = AudioObjectID(kAudioObjectUnknown)
        let status = AudioHardwareCreateProcessTap(Self.tapDescription(description), &tap)
        guard status == noErr, tap != kAudioObjectUnknown else { throw HALError("AudioHardwareCreateProcessTap", status: status) }
        return tap
    }

    public func updateProcessTap(_ tap: HALObjectID, _ description: TapDescription) throws {
        var propertyAddress = address(kAudioTapPropertyDescription)
        let object = Self.tapDescription(description)
        let reference = Unmanaged.passUnretained(object)
        let status = withUnsafePointer(to: reference) { pointer in
            AudioObjectSetPropertyData(tap, &propertyAddress, 0, nil, UInt32(MemoryLayout.size(ofValue: reference)), pointer)
        }
        withExtendedLifetime(object) {}
        guard status == noErr else { throw HALError("set kAudioTapPropertyDescription", status: status) }
    }

    public func destroyProcessTap(_ tap: HALObjectID) {
        _ = AudioHardwareDestroyProcessTap(tap)
    }

    public func tapUID(_ tap: HALObjectID) throws -> String {
        try readString(tap, address(kAudioTapPropertyUID))
    }

    public func tapFormat(_ tap: HALObjectID) throws -> HALStreamFormat {
        let format: AudioStreamBasicDescription = try read(tap, address(kAudioTapPropertyFormat), AudioStreamBasicDescription())
        return HALStreamFormat(sampleRate: format.mSampleRate, channels: Int(format.mChannelsPerFrame))
    }

    public func createAggregateDevice(_ description: AggregateDescription) throws -> HALObjectID {
        let taps: [[String: Any]] = description.tapUIDs.map { uid in
            [
                kAudioSubTapUIDKey: uid,
                kAudioSubTapDriftCompensationKey: description.driftCompensation,
                kAudioSubTapDriftCompensationQualityKey: kAudioAggregateDriftCompensationLowQuality,
            ]
        }
        let dictionary: [String: Any] = [
            kAudioAggregateDeviceNameKey: description.name,
            kAudioAggregateDeviceUIDKey: description.uid,
            kAudioAggregateDeviceIsPrivateKey: description.isPrivate,
            kAudioAggregateDeviceTapAutoStartKey: description.tapAutoStart,
            kAudioAggregateDeviceTapListKey: taps,
        ]
        var device = AudioObjectID(kAudioObjectUnknown)
        let status = AudioHardwareCreateAggregateDevice(dictionary as CFDictionary, &device)
        guard status == noErr, device != kAudioObjectUnknown else { throw HALError("AudioHardwareCreateAggregateDevice", status: status) }
        return device
    }

    public func destroyAggregateDevice(_ device: HALObjectID) {
        _ = AudioHardwareDestroyAggregateDevice(device)
    }

    // MARK: Process-wide settings

    public func setSleepingIsAllowed(_ allowed: Bool) throws {
        try write(AudioObjectID(kAudioObjectSystemObject), address(kAudioHardwarePropertySleepingIsAllowed), UInt32(allowed ? 1 : 0))
    }

    public func setPowerHintFavorSavingPower(_ favor: Bool) throws {
        let hint: AudioHardwarePowerHint = favor ? .favorSavingPower : .none
        try write(AudioObjectID(kAudioObjectSystemObject), address(kAudioHardwarePropertyPowerHint), hint.rawValue)
    }

    public func setProcessInputMute(_ muted: Bool) throws {
        try write(AudioObjectID(kAudioObjectSystemObject), address(kAudioHardwarePropertyProcessInputMute), UInt32(muted ? 1 : 0))
    }

    public func userSessionIsActive() throws -> Bool {
        let value: UInt32 = try read(
            AudioObjectID(kAudioObjectSystemObject), address(kAudioHardwarePropertyUserSessionIsActiveOrHeadless), UInt32(1)
        )
        return value != 0
    }

    // MARK: Private

    private static func tapDescription(_ description: TapDescription) -> CATapDescription {
        let tap: CATapDescription
        switch description.scope {
        case .globalExcluding(let objects):
            tap = description.mono
                ? CATapDescription(monoGlobalTapButExcludeProcesses: objects)
                : CATapDescription(stereoGlobalTapButExcludeProcesses: objects)
        case .processes(let objects):
            tap = description.mono
                ? CATapDescription(monoMixdownOfProcesses: objects)
                : CATapDescription(stereoMixdownOfProcesses: objects)
        }
        tap.name = description.name
        tap.uuid = description.uuid
        tap.isPrivate = description.isPrivate
        tap.muteBehavior = .unmuted
        tap.deviceUID = nil
        return tap
    }

    static func address(of property: HALProperty) -> AudioObjectPropertyAddress {
        switch property {
        case .devices: address(kAudioHardwarePropertyDevices)
        case .defaultInputDevice: address(kAudioHardwarePropertyDefaultInputDevice)
        case .defaultOutputDevice: address(kAudioHardwarePropertyDefaultOutputDevice)
        case .processObjectList: address(kAudioHardwarePropertyProcessObjectList)
        case .serviceRestarted: address(kAudioHardwarePropertyServiceRestarted)
        case .userSessionIsActiveOrHeadless: address(kAudioHardwarePropertyUserSessionIsActiveOrHeadless)
        case .deviceIsAlive: address(kAudioDevicePropertyDeviceIsAlive)
        case .nominalSampleRate: address(kAudioDevicePropertyNominalSampleRate)
        case .streamFormat(let scope): address(kAudioDevicePropertyStreamConfiguration, coreScope(scope))
        case .dataSource(let scope): address(kAudioDevicePropertyDataSource, coreScope(scope))
        case .deviceHasChanged: address(kAudioDevicePropertyDeviceHasChanged)
        case .processorOverload: address(kAudioDeviceProcessorOverload)
        case .processIsRunningInput: address(kAudioProcessPropertyIsRunningInput)
        case .processIsRunningOutput: address(kAudioProcessPropertyIsRunningOutput)
        case .processDevices(let scope): address(kAudioProcessPropertyDevices, coreScope(scope))
        case .tapFormat: address(kAudioTapPropertyFormat)
        }
    }

    private static func coreScope(_ scope: HALScope) -> AudioObjectPropertyScope {
        switch scope {
        case .global: kAudioObjectPropertyScopeGlobal
        case .input: kAudioObjectPropertyScopeInput
        case .output: kAudioObjectPropertyScopeOutput
        }
    }

    private static func address(
        _ selector: AudioObjectPropertySelector,
        _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
    ) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    private func address(
        _ selector: AudioObjectPropertySelector,
        _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
    ) -> AudioObjectPropertyAddress {
        Self.address(selector, scope)
    }

    private func read<T>(_ object: AudioObjectID, _ propertyAddress: AudioObjectPropertyAddress, _ initial: T) throws -> T {
        var propertyAddress = propertyAddress
        var size = UInt32(MemoryLayout<T>.size)
        var value = initial
        let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(object, &propertyAddress, 0, nil, &size, $0) }
        guard status == noErr else { throw HALError("read '\(fourCharText(propertyAddress.mSelector) ?? "?")'", status: status) }
        return value
    }

    private func optionalRead(_ object: AudioObjectID, _ propertyAddress: AudioObjectPropertyAddress) -> UInt32? {
        var probe = propertyAddress
        guard AudioObjectHasProperty(object, &probe) else { return nil }
        return try? read(object, propertyAddress, UInt32(0))
    }

    private func readArray<T>(_ object: AudioObjectID, _ propertyAddress: AudioObjectPropertyAddress, _ zero: T) throws -> [T] {
        var propertyAddress = propertyAddress
        var size: UInt32 = 0
        var status = AudioObjectGetPropertyDataSize(object, &propertyAddress, 0, nil, &size)
        guard status == noErr else { throw HALError("size '\(fourCharText(propertyAddress.mSelector) ?? "?")'", status: status) }
        var values = [T](repeating: zero, count: Int(size) / MemoryLayout<T>.stride)
        guard !values.isEmpty else { return [] }
        status = values.withUnsafeMutableBytes { AudioObjectGetPropertyData(object, &propertyAddress, 0, nil, &size, $0.baseAddress!) }
        guard status == noErr else { throw HALError("read '\(fourCharText(propertyAddress.mSelector) ?? "?")'", status: status) }
        return Array(values.prefix(Int(size) / MemoryLayout<T>.stride))
    }

    private func readString(_ object: AudioObjectID, _ propertyAddress: AudioObjectPropertyAddress) throws -> String {
        var propertyAddress = propertyAddress
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var value: Unmanaged<CFString>?
        let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(object, &propertyAddress, 0, nil, &size, $0) }
        guard status == noErr, let value else { throw HALError("read '\(fourCharText(propertyAddress.mSelector) ?? "?")'", status: status) }
        return value.takeRetainedValue() as String
    }

    private func write<T>(_ object: AudioObjectID, _ propertyAddress: AudioObjectPropertyAddress, _ value: T) throws {
        var propertyAddress = propertyAddress
        var value = value
        let status = withUnsafePointer(to: &value) {
            AudioObjectSetPropertyData(object, &propertyAddress, 0, nil, UInt32(MemoryLayout<T>.size), $0)
        }
        guard status == noErr else { throw HALError("write '\(fourCharText(propertyAddress.mSelector) ?? "?")'", status: status) }
    }

    private func channelCount(_ device: AudioObjectID, scope: AudioObjectPropertyScope) -> Int {
        var propertyAddress = address(kAudioDevicePropertyStreamConfiguration, scope)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(device, &propertyAddress, 0, nil, &size) == noErr, size >= MemoryLayout<AudioBufferList>.size else {
            return 0
        }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(device, &propertyAddress, 0, nil, &size, raw) == noErr else { return 0 }
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    private func terminalTypes(_ device: AudioObjectID) -> [UInt32] {
        let streams = (try? readArray(device, address(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput), AudioStreamID(0))) ?? []
        return streams.compactMap { try? read($0, address(kAudioStreamPropertyTerminalType), UInt32(0)) }
    }

    /// Marks every output stream unused for this IOProc, so a duplex device (a USB headset)
    /// does not run output IO on Sondine's behalf. Best effort.
    private func disableOutputStreams(device: AudioObjectID, procID: AudioDeviceIOProcID) {
        var propertyAddress = address(kAudioDevicePropertyIOProcStreamUsage, kAudioObjectPropertyScopeOutput)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(device, &propertyAddress, 0, nil, &size) == noErr,
              Int(size) >= MemoryLayout<AudioHardwareIOProcStreamUsage>.size
        else { return }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioHardwareIOProcStreamUsage>.alignment)
        defer { raw.deallocate() }
        raw.initializeMemory(as: UInt8.self, repeating: 0, count: Int(size))
        let usage = raw.assumingMemoryBound(to: AudioHardwareIOProcStreamUsage.self)
        usage.pointee.mIOProc = unsafeBitCast(procID, to: UnsafeMutableRawPointer.self)
        guard AudioObjectGetPropertyData(device, &propertyAddress, 0, nil, &size, raw) == noErr,
              let offset = MemoryLayout<AudioHardwareIOProcStreamUsage>.offset(of: \.mStreamIsOn)
        else { return }
        let count = Int(usage.pointee.mNumberStreams)
        guard count > 0, offset + count * MemoryLayout<UInt32>.size <= Int(size) else { return }
        let flags = (raw + offset).assumingMemoryBound(to: UInt32.self)
        for index in 0..<count { flags[index] = 0 }
        _ = AudioObjectSetPropertyData(device, &propertyAddress, 0, nil, size, raw)
    }
}
