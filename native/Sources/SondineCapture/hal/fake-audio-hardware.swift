import CoreAudio
import Dispatch
import Foundation
import Synchronization

/// A scriptable in-memory HAL for tests and `sondine-audio serve --hal fake`.
///
/// Scripts change devices and processes and fire the same listeners Core Audio would (on the
/// queue each listener was registered with). IO is driven by hand: `deliver` calls the
/// registered IOProc blocks synchronously, as the HAL's IO thread would.
public final class FakeAudioHardware: AudioHardware, @unchecked Sendable {
    public struct Device: Sendable, Equatable {
        public var info: HALDeviceInfo
        public var bufferRange: ClosedRange<UInt32>
        public var bufferFrames: UInt32
    }

    public struct Process: Sendable, Equatable {
        public var info: HALProcessInfo
        public var io: HALProcessIO
    }

    public struct IOProc: Sendable {
        public var handle: HALIOProcHandle
        public var block: HALIOBlock
        public var inputOnly: Bool
        public var started: Bool
    }

    public struct Tap: Sendable, Equatable {
        public var id: HALObjectID
        public var description: TapDescription
        public var uid: String
    }

    public struct Aggregate: Sendable, Equatable {
        public var id: HALObjectID
        public var description: AggregateDescription
    }

    /// A sine a process object plays while its output runs.
    public struct Tone: Sendable, Equatable {
        public var frequency: Double
        public var amplitude: Float

        public init(frequency: Double, amplitude: Float) {
            self.frequency = frequency
            self.amplitude = amplitude
        }
    }

    private struct Listener {
        var object: HALObjectID
        var property: HALProperty
        var queue: DispatchQueue
        var block: @Sendable () -> Void
    }

    private struct State {
        var nextID: HALObjectID = 60
        var devices: [Device] = []
        var processes: [Process] = []
        var defaultInput: HALObjectID?
        var defaultOutput: HALObjectID?
        var listeners: [UInt64: Listener] = [:]
        var nextToken: UInt64 = 1
        var nextProc: UInt = 1
        var procs: [UInt: IOProc] = [:]
        var taps: [Tap] = []
        var aggregates: [Aggregate] = []
        var sleepingAllowed: Bool?
        var favorSavingPower: Bool?
        var inputMuted = false
        var sessionActive = true
        /// What each process object plays while its output runs (tap mixing).
        var tones: [HALObjectID: Tone] = [:]
        var calls: [String: Int] = [:]
        var failing: Set<String> = []
        var log: [String] = []
    }

    public static let systemObject = halSystemObject
    private let state = Mutex(State())

    public init() {}

    /// A MacBook: built-in microphone (default input) and built-in speakers (default output).
    public static func macBook(rate: Double = 48_000) -> FakeAudioHardware {
        let hal = FakeAudioHardware()
        hal.addDevice(uid: "BuiltInMicrophoneDevice", name: "MacBook Air Microphone", transport: "bltn", input: 1, output: 0, rate: rate, dataSource: (.input, "imic"))
        hal.addDevice(uid: "BuiltInSpeakerDevice", name: "MacBook Air Speakers", transport: "bltn", input: 0, output: 2, rate: rate, dataSource: (.output, "ispk"))
        hal.setDefault(.input, uid: "BuiltInMicrophoneDevice")
        hal.setDefault(.output, uid: "BuiltInSpeakerDevice")
        return hal
    }

    // MARK: Scripting

    @discardableResult
    public func addDevice(
        uid: String,
        name: String,
        transport: String,
        input: Int,
        output: Int,
        rate: Double = 48_000,
        dataSource: (HALScope, String)? = nil,
        bufferRange: ClosedRange<UInt32> = 15...4_096,
        inputTerminal: String = "micr"
    ) -> HALObjectID {
        let id = state.withLock { state -> HALObjectID in
            let id = state.nextID
            state.nextID += 1
            var info = HALDeviceInfo(
                id: id, uid: uid, name: name, transportCode: fourCharCode(transport),
                inputChannels: input, outputChannels: output, nominalRate: rate
            )
            if let (scope, code) = dataSource {
                if scope == .input { info.inputDataSource = fourCharCode(code) } else { info.outputDataSource = fourCharCode(code) }
            }
            if input > 0 { info.inputTerminalTypes = [fourCharCode(inputTerminal)] }
            state.devices.append(Device(info: info, bufferRange: bufferRange, bufferFrames: 512))
            return id
        }
        fire(Self.systemObject, .devices)
        return id
    }

    /// Unplugs a device: it reports not alive, leaves the list, and stops being a default.
    public func removeDevice(uid: String) {
        guard let id = deviceID(uid: uid) else { return }
        let changed = state.withLock { state -> [HALScope] in
            if let index = state.devices.firstIndex(where: { $0.info.id == id }) { state.devices[index].info.alive = false }
            state.devices.removeAll { $0.info.id == id }
            for key in state.procs.keys where state.procs[key]?.handle.device == id { state.procs[key]?.started = false }
            var changed: [HALScope] = []
            if state.defaultInput == id {
                state.defaultInput = state.devices.first { $0.info.inputChannels > 0 && $0.info.transportCode == fourCharCode("bltn") }?.info.id
                changed.append(.input)
            }
            if state.defaultOutput == id {
                state.defaultOutput = state.devices.first { $0.info.outputChannels > 0 }?.info.id
                changed.append(.output)
            }
            return changed
        }
        fire(id, .deviceIsAlive)
        fire(Self.systemObject, .devices)
        for scope in changed { fire(Self.systemObject, scope == .input ? .defaultInputDevice : .defaultOutputDevice) }
        dropListeners(on: [id])
    }

    public func setDefault(_ scope: HALScope, uid: String?) {
        let id = uid.flatMap(deviceID(uid:))
        state.withLock { state in
            if scope == .output { state.defaultOutput = id } else { state.defaultInput = id }
        }
        fire(Self.systemObject, scope == .output ? .defaultOutputDevice : .defaultInputDevice)
    }

    /// Changes a device's nominal rate. Aggregates follow the default output's rate.
    public func setNominalRate(uid: String, rate: Double) {
        guard let id = deviceID(uid: uid) else { return }
        let aggregates = state.withLock { state -> [HALObjectID] in
            if let index = state.devices.firstIndex(where: { $0.info.id == id }) { state.devices[index].info.nominalRate = rate }
            return state.defaultOutput == id ? state.aggregates.map(\.id) : []
        }
        fire(id, .nominalSampleRate)
        for aggregate in aggregates { fire(aggregate, .nominalSampleRate) }
    }

    public func setDataSource(uid: String, scope: HALScope, code: String) {
        guard let id = deviceID(uid: uid) else { return }
        state.withLock { state in
            guard let index = state.devices.firstIndex(where: { $0.info.id == id }) else { return }
            if scope == .input {
                state.devices[index].info.inputDataSource = fourCharCode(code)
            } else {
                state.devices[index].info.outputDataSource = fourCharCode(code)
            }
        }
        fire(id, .dataSource(scope))
    }

    @discardableResult
    public func addProcess(pid: Int32, bundleID: String?) -> HALObjectID {
        let id = state.withLock { state -> HALObjectID in
            let id = state.nextID
            state.nextID += 1
            state.processes.append(Process(info: HALProcessInfo(id: id, pid: pid, bundleID: bundleID), io: HALProcessIO()))
            return id
        }
        fire(Self.systemObject, .processObjectList)
        return id
    }

    public func removeProcess(_ id: HALObjectID) {
        state.withLock { $0.processes.removeAll { $0.info.id == id } }
        fire(Self.systemObject, .processObjectList)
        dropListeners(on: [id])
    }

    /// Sets a process object's IO; fires only the listeners whose value changed.
    public func setProcessIO(_ id: HALObjectID, input: Bool, output: Bool, inputDevices: [String] = [], outputDevices: [String] = []) {
        let inputIDs = inputDevices.compactMap(deviceID(uid:))
        let outputIDs = outputDevices.compactMap(deviceID(uid:))
        let changed = state.withLock { state -> [HALProperty] in
            guard let index = state.processes.firstIndex(where: { $0.info.id == id }) else { return [] }
            let old = state.processes[index].io
            let new = HALProcessIO(runningInput: input, runningOutput: output, inputDevices: inputIDs, outputDevices: outputIDs)
            state.processes[index].io = new
            var changed: [HALProperty] = []
            if old.runningInput != new.runningInput { changed.append(.processIsRunningInput) }
            if old.runningOutput != new.runningOutput { changed.append(.processIsRunningOutput) }
            if old.inputDevices != new.inputDevices { changed.append(.processDevices(.input)) }
            if old.outputDevices != new.outputDevices { changed.append(.processDevices(.output)) }
            return changed
        }
        for property in changed { fire(id, property) }
    }

    /// coreaudiod restarted: every object gets a new id, taps, aggregates and IOProcs are gone,
    /// and listeners must be registered again (after `ServiceRestarted` is delivered).
    public func restartService() {
        let previous = state.withLock { state -> [HALObjectID] in
            var renumbered: [HALObjectID: HALObjectID] = [:]
            func renumber(_ id: HALObjectID) -> HALObjectID {
                if let existing = renumbered[id] { return existing }
                let new = state.nextID
                state.nextID += 1
                renumbered[id] = new
                return new
            }
            let old = state.devices.map(\.info.id) + state.processes.map(\.info.id)
            for index in state.devices.indices { state.devices[index].info.id = renumber(state.devices[index].info.id) }
            for index in state.processes.indices {
                state.processes[index].info.id = renumber(state.processes[index].info.id)
                state.processes[index].io.inputDevices = state.processes[index].io.inputDevices.map(renumber)
                state.processes[index].io.outputDevices = state.processes[index].io.outputDevices.map(renumber)
            }
            state.defaultInput = state.defaultInput.map(renumber)
            state.defaultOutput = state.defaultOutput.map(renumber)
            state.procs.removeAll()
            state.taps.removeAll()
            state.aggregates.removeAll()
            state.log.append("restartService")
            return old
        }
        dropListeners(on: previous)
        // Listeners registered before the restart are dead once it has been delivered; the ones
        // the handler registers afterwards stay.
        let stale = state.withLock { Array($0.listeners.keys) }
        fire(Self.systemObject, .serviceRestarted)
        state.withLock { state in for token in stale { state.listeners.removeValue(forKey: token) } }
    }

    public func setUserSessionActive(_ active: Bool) {
        state.withLock { $0.sessionActive = active }
        fire(Self.systemObject, .userSessionIsActiveOrHeadless)
    }

    /// Makes the next calls of `operation` (for example "createProcessTap") throw.
    public func fail(_ operation: String, _ failing: Bool = true) {
        state.withLock { state in
            if failing { state.failing.insert(operation) } else { state.failing.remove(operation) }
        }
    }

    // MARK: IO driving

    /// Calls every started IOProc of the device with one interleaved Float32 buffer.
    public func deliver(toDevice uid: String, interleaved samples: [Float], channels: Int, hostTicks: UInt64) {
        guard let id = deviceID(uid: uid) else { return }
        deliver(to: id, samples: samples, channels: channels, hostTicks: hostTicks)
    }

    /// What a process object plays while its output runs (nil: silence).
    public func setTone(_ id: HALObjectID, _ tone: Tone?) {
        state.withLock { $0.tones[id] = tone }
    }

    /// One IO cycle of every started tap aggregate at 48 kHz, frames `[startFrame, startFrame +
    /// frames)` of a shared timeline: each tap delivers the mix of the tones of the process
    /// objects in its scope whose output runs, as Core Audio mixes a process tap.
    public func deliverToTaps(startFrame: Int64, frames: Int, hostTicks: UInt64) {
        let rate = 48_000.0
        let mixes = state.withLock { state -> [(HALObjectID, [Tone])] in
            state.aggregates.compactMap { aggregate in
                guard state.procs.values.contains(where: { $0.handle.device == aggregate.id && $0.started }),
                      let tap = state.taps.first(where: { aggregate.description.tapUIDs.contains($0.uid) }) else { return nil }
                let playing = state.processes.filter { process in
                    guard process.io.runningOutput else { return false }
                    switch tap.description.scope {
                    case .globalExcluding(let excluded): return !excluded.contains(process.info.id)
                    case .processes(let included): return included.contains(process.info.id)
                    }
                }
                return (aggregate.id, playing.compactMap { state.tones[$0.info.id] })
            }
        }
        for (aggregate, tones) in mixes {
            var samples = [Float](repeating: 0, count: frames)
            for tone in tones {
                let step = 2 * Double.pi * tone.frequency / rate
                for index in 0..<frames { samples[index] += tone.amplitude * Float(sin(step * Double(startFrame + Int64(index)))) }
            }
            deliver(to: aggregate, samples: samples, channels: 1, hostTicks: hostTicks)
        }
    }

    /// Calls the started IOProc of the aggregate that holds the tap with this name.
    public func deliverToTap(named name: String, samples: [Float], hostTicks: UInt64) {
        let aggregate = state.withLock { state -> HALObjectID? in
            guard let tap = state.taps.first(where: { $0.description.name == name }) else { return nil }
            return state.aggregates.first { $0.description.tapUIDs.contains(tap.uid) }?.id
        }
        guard let aggregate else { return }
        deliver(to: aggregate, samples: samples, channels: 1, hostTicks: hostTicks)
    }

    /// Devices and aggregates with a started IOProc: input channels and nominal rate.
    public func startedInputs() -> [(device: HALObjectID, channels: Int, rate: Double)] {
        state.withLock { state in
            let devices = Set(state.procs.values.filter(\.started).map(\.handle.device)).sorted()
            let outputRate = state.devices.first { $0.info.id == state.defaultOutput }?.info.nominalRate ?? 48_000
            return devices.compactMap { id in
                if let device = state.devices.first(where: { $0.info.id == id }) {
                    guard device.info.inputChannels > 0 else { return nil }
                    return (id, device.info.inputChannels, device.info.nominalRate ?? 48_000)
                }
                return state.aggregates.contains { $0.id == id } ? (id, 1, outputRate) : nil
            }
        }
    }

    /// Calls the started IOProcs of a device or aggregate, as the HAL's IO thread would.
    public func deliver(toObject device: HALObjectID, samples: [Float], channels: Int, hostTicks: UInt64) {
        deliver(to: device, samples: samples, channels: channels, hostTicks: hostTicks)
    }

    public func startedBlocks(device: HALObjectID) -> [HALIOBlock] {
        state.withLock { state in state.procs.values.filter { $0.handle.device == device && $0.started }.map(\.block) }
    }

    private func deliver(to device: HALObjectID, samples: [Float], channels: Int, hostTicks: UInt64) {
        let blocks = startedBlocks(device: device)
        guard !blocks.isEmpty else { return }
        let list = AudioBufferList.allocate(maximumBuffers: 1)
        defer { free(list.unsafeMutablePointer) }
        var copy = samples
        copy.withUnsafeMutableBytes { bytes in
            list[0] = AudioBuffer(mNumberChannels: UInt32(channels), mDataByteSize: UInt32(bytes.count), mData: bytes.baseAddress)
            var time = AudioTimeStamp()
            time.mHostTime = hostTicks
            time.mFlags = .hostTimeValid
            for block in blocks { block(list.unsafePointer, &time) }
        }
    }

    // MARK: Inspection

    public func deviceID(uid: String) -> HALObjectID? {
        state.withLock { state in
            state.devices.first { $0.info.uid == uid }?.info.id ?? state.aggregates.first { $0.description.uid == uid }?.id
        }
    }

    public var startedIOProcs: [IOProc] { state.withLock { $0.procs.values.filter(\.started).sorted { $0.handle.raw < $1.handle.raw } } }
    public var ioProcs: [IOProc] { state.withLock { $0.procs.values.sorted { $0.handle.raw < $1.handle.raw } } }
    public var taps: [Tap] { state.withLock { $0.taps } }
    public var aggregates: [Aggregate] { state.withLock { $0.aggregates } }
    public var inputMuted: Bool { state.withLock { $0.inputMuted } }
    public var sleepingAllowed: Bool? { state.withLock { $0.sleepingAllowed } }
    public var favorSavingPower: Bool? { state.withLock { $0.favorSavingPower } }
    public var operationLog: [String] { state.withLock { $0.log } }
    public func calls(_ operation: String) -> Int { state.withLock { $0.calls[operation, default: 0] } }
    public func listenerCount(on object: HALObjectID) -> Int { state.withLock { $0.listeners.values.filter { $0.object == object }.count } }
    public var listenerCount: Int { state.withLock { $0.listeners.count } }
    public func bufferFrames(uid: String) -> UInt32? {
        state.withLock { $0.devices.first { $0.info.uid == uid }?.bufferFrames }
    }
    public func device(uid: String) -> Device? { state.withLock { $0.devices.first { $0.info.uid == uid } } }

    // MARK: AudioHardware

    public func deviceIDs() throws -> [HALObjectID] {
        try record("deviceIDs") { state in state.devices.map(\.info.id) + state.aggregates.map(\.id) }
    }

    public func defaultDevice(_ scope: HALScope) throws -> HALObjectID? {
        try record("defaultDevice") { state in scope == .output ? state.defaultOutput : state.defaultInput }
    }

    public func processObjectIDs() throws -> [HALObjectID] {
        try record("processObjectIDs") { state in state.processes.map(\.info.id) }
    }

    public func deviceInfo(_ device: HALObjectID) throws -> HALDeviceInfo {
        try record("deviceInfo") { state in
            if let found = state.devices.first(where: { $0.info.id == device }) { return found.info }
            if let aggregate = state.aggregates.first(where: { $0.id == device }) {
                let rate = state.devices.first { $0.info.id == state.defaultOutput }?.info.nominalRate ?? 48_000
                return HALDeviceInfo(
                    id: device, uid: aggregate.description.uid, name: aggregate.description.name,
                    transportCode: fourCharCode("grup"), inputChannels: 1, outputChannels: 0, nominalRate: rate
                )
            }
            throw HALError("deviceInfo", status: Int32(bitPattern: fourCharCode("!obj")))
        }
    }

    public func nominalSampleRate(_ device: HALObjectID) throws -> Double {
        let info = try deviceInfo(device)
        return info.nominalRate ?? 48_000
    }

    public func inputStreamFormat(_ device: HALObjectID) throws -> HALStreamFormat {
        let info = try deviceInfo(device)
        return HALStreamFormat(sampleRate: info.nominalRate ?? 48_000, channels: info.inputChannels)
    }

    public func bufferFrameSizeRange(_ device: HALObjectID) throws -> ClosedRange<UInt32> {
        try record("bufferFrameSizeRange") { state in state.devices.first { $0.info.id == device }?.bufferRange ?? 15...8_192 }
    }

    public func setBufferFrameSize(_ device: HALObjectID, frames: UInt32) throws {
        try record("setBufferFrameSize") { state in
            if let index = state.devices.firstIndex(where: { $0.info.id == device }) { state.devices[index].bufferFrames = frames }
        }
    }

    public func processInfo(_ process: HALObjectID) throws -> HALProcessInfo {
        try record("processInfo") { state in
            guard let found = state.processes.first(where: { $0.info.id == process }) else {
                throw HALError("processInfo", status: Int32(bitPattern: fourCharCode("!obj")))
            }
            return found.info
        }
    }

    public func processIO(_ process: HALObjectID) throws -> HALProcessIO {
        try record("processIO") { state in
            guard let found = state.processes.first(where: { $0.info.id == process }) else {
                throw HALError("processIO", status: Int32(bitPattern: fourCharCode("!obj")))
            }
            return found.io
        }
    }

    public func addListener(
        _ object: HALObjectID,
        _ property: HALProperty,
        queue: DispatchQueue,
        _ block: @escaping @Sendable () -> Void
    ) throws -> HALListenerToken {
        try record("addListener") { state in
            let token = state.nextToken
            state.nextToken += 1
            state.listeners[token] = Listener(object: object, property: property, queue: queue, block: block)
            return HALListenerToken(id: token)
        }
    }

    /// Like Core Audio, a listener whose object is gone is no longer registered: removing it
    /// counts as `removeListener.gone` (Core Audio logs "no object with given ID").
    public func removeListener(_ token: HALListenerToken) {
        _ = try? record("removeListener") { state in
            if state.listeners.removeValue(forKey: token.id) == nil { state.calls["removeListener.gone", default: 0] += 1 }
        }
    }

    public func discardListener(_ token: HALListenerToken) {
        _ = try? record("discardListener") { state in state.listeners.removeValue(forKey: token.id) }
    }

    public func createIOProc(device: HALObjectID, inputOnly: Bool, _ block: @escaping HALIOBlock) throws -> HALIOProcHandle {
        try record("createIOProc") { state in
            guard state.devices.contains(where: { $0.info.id == device }) || state.aggregates.contains(where: { $0.id == device }) else {
                throw HALError("createIOProc", status: Int32(bitPattern: fourCharCode("!dev")))
            }
            let handle = HALIOProcHandle(device: device, raw: state.nextProc)
            state.nextProc += 1
            state.procs[handle.raw] = IOProc(handle: handle, block: block, inputOnly: inputOnly, started: false)
            state.log.append("createIOProc \(device)")
            return handle
        }
    }

    public func destroyIOProc(_ handle: HALIOProcHandle) {
        _ = try? record("destroyIOProc") { state in
            state.procs.removeValue(forKey: handle.raw)
            state.log.append("destroyIOProc \(handle.device)")
        }
    }

    public func startIO(_ handle: HALIOProcHandle) throws {
        try record("startIO") { state in
            guard state.procs[handle.raw] != nil else { throw HALError("startIO", status: Int32(bitPattern: fourCharCode("!obj"))) }
            state.procs[handle.raw]?.started = true
            state.log.append("startIO \(handle.device)")
        }
    }

    public func stopIO(_ handle: HALIOProcHandle) {
        _ = try? record("stopIO") { state in
            state.procs[handle.raw]?.started = false
            state.log.append("stopIO \(handle.device)")
        }
    }

    public func createProcessTap(_ description: TapDescription) throws -> HALObjectID {
        try record("createProcessTap") { state in
            let id = state.nextID
            state.nextID += 1
            state.taps.append(Tap(id: id, description: description, uid: description.uuid.uuidString))
            state.log.append("createProcessTap \(description.name)")
            return id
        }
    }

    public func updateProcessTap(_ tap: HALObjectID, _ description: TapDescription) throws {
        try record("updateProcessTap") { state in
            guard let index = state.taps.firstIndex(where: { $0.id == tap }) else {
                throw HALError("updateProcessTap", status: Int32(bitPattern: fourCharCode("!obj")))
            }
            state.taps[index].description = description
        }
    }

    public func destroyProcessTap(_ tap: HALObjectID) {
        _ = try? record("destroyProcessTap") { state in
            state.taps.removeAll { $0.id == tap }
            state.log.append("destroyProcessTap")
        }
    }

    public func tapUID(_ tap: HALObjectID) throws -> String {
        try record("tapUID") { state in
            guard let found = state.taps.first(where: { $0.id == tap }) else {
                throw HALError("tapUID", status: Int32(bitPattern: fourCharCode("!obj")))
            }
            return found.uid
        }
    }

    public func tapFormat(_ tap: HALObjectID) throws -> HALStreamFormat {
        try record("tapFormat") { state in
            let rate = state.devices.first { $0.info.id == state.defaultOutput }?.info.nominalRate ?? 48_000
            return HALStreamFormat(sampleRate: rate, channels: 1)
        }
    }

    public func createAggregateDevice(_ description: AggregateDescription) throws -> HALObjectID {
        let id = try record("createAggregateDevice") { state -> HALObjectID in
            let id = state.nextID
            state.nextID += 1
            state.aggregates.append(Aggregate(id: id, description: description))
            state.log.append("createAggregateDevice")
            return id
        }
        fire(Self.systemObject, .devices)
        return id
    }

    public func destroyAggregateDevice(_ device: HALObjectID) {
        _ = try? record("destroyAggregateDevice") { state in
            state.aggregates.removeAll { $0.id == device }
            state.procs = state.procs.filter { $0.value.handle.device != device }
            state.log.append("destroyAggregateDevice")
        }
        fire(Self.systemObject, .devices)
    }

    public func setSleepingIsAllowed(_ allowed: Bool) throws {
        try record("setSleepingIsAllowed") { $0.sleepingAllowed = allowed }
    }

    public func setPowerHintFavorSavingPower(_ favor: Bool) throws {
        try record("setPowerHintFavorSavingPower") { $0.favorSavingPower = favor }
    }

    public func setProcessInputMute(_ muted: Bool) throws {
        try record("setProcessInputMute") { state in
            state.inputMuted = muted
            state.log.append("setProcessInputMute \(muted)")
        }
    }

    public func userSessionIsActive() throws -> Bool {
        try record("userSessionIsActive") { $0.sessionActive }
    }

    // MARK: Private

    private func record<T>(_ operation: String, _ body: (inout State) throws -> T) throws -> T {
        try state.withLock { state in
            state.calls[operation, default: 0] += 1
            if state.failing.contains(operation) { throw HALError(operation, status: Int32(bitPattern: fourCharCode("fake"))) }
            return try body(&state)
        }
    }

    private func fire(_ object: HALObjectID, _ property: HALProperty) {
        let targets = state.withLock { state in state.listeners.values.filter { $0.object == object && $0.property == property } }
        for listener in targets { listener.queue.async(execute: listener.block) }
    }

    private func dropListeners(on objects: [HALObjectID]) {
        let set = Set(objects)
        state.withLock { state in state.listeners = state.listeners.filter { !set.contains($0.value.object) } }
    }
}
