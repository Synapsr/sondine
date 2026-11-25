import Dispatch

/// A device as the policy sees it.
public struct CatalogDevice: Sendable, Equatable {
    public var info: HALDeviceInfo
    public var transport: Transport
    public var loopback: Bool

    public var id: HALObjectID { info.id }
    public var uid: String { info.uid }
    public var hasInput: Bool { info.inputChannels > 0 }
    public var hasOutput: Bool { info.outputChannels > 0 }

    public init(info: HALDeviceInfo) {
        self.info = info
        transport = Transport(code: info.transportCode)
        loopback = LoopbackDevices.isLoopback(uid: info.uid, name: info.name, transport: transport)
    }
}

public enum DeviceCatalogChange: Sendable, Equatable {
    case list
    case defaultDevice(HALScope)
    case alive(HALObjectID)
    case nominalRate(HALObjectID)
    case dataSource(HALObjectID, HALScope)
    case format(HALObjectID)
    case hasChanged(HALObjectID)
}

/// Devices and defaults, kept current by listeners: the device list and the defaults on the
/// system object, and alive, nominal rate, data source, stream configuration and
/// "has changed" on each device. Sondine's own aggregates are left out.
///
/// Confined to the engine queue.
final class DeviceCatalog: @unchecked Sendable {
    static let ownAggregatePrefix = "app.sondine.tap."

    private let hal: any AudioHardware
    private let queue: DispatchQueue
    private let changed: (DeviceCatalogChange) -> Void
    private(set) var devices: [CatalogDevice] = []
    private(set) var defaultInput: HALObjectID?
    private(set) var defaultOutput: HALObjectID?
    private var systemTokens: [HALListenerToken] = []
    private var deviceTokens: [HALObjectID: [HALListenerToken]] = [:]

    init(hal: any AudioHardware, queue: DispatchQueue, changed: @escaping (DeviceCatalogChange) -> Void) {
        self.hal = hal
        self.queue = queue
        self.changed = changed
    }

    func start() throws {
        let system = halSystemObject
        for (property, change) in [
            (HALProperty.devices, DeviceCatalogChange.list),
            (.defaultInputDevice, .defaultDevice(.input)),
            (.defaultOutputDevice, .defaultDevice(.output)),
        ] {
            systemTokens.append(try hal.addListener(system, property, queue: queue) { [weak self] in self?.handle(change) })
        }
        reloadList()
        reloadDefaults()
    }

    /// - Parameter objectsGone: coreaudiod restarted, so every listener died with its object.
    func stop(objectsGone: Bool = false) {
        let release = objectsGone ? hal.discardListener : hal.removeListener
        for token in systemTokens { release(token) }
        systemTokens.removeAll()
        for tokens in deviceTokens.values { tokens.forEach(release) }
        deviceTokens.removeAll()
        devices.removeAll()
        defaultInput = nil
        defaultOutput = nil
    }

    func device(_ id: HALObjectID?) -> CatalogDevice? {
        guard let id else { return nil }
        return devices.first { $0.id == id }
    }

    func device(uid: String) -> CatalogDevice? { devices.first { $0.uid == uid } }

    var defaultInputDevice: CatalogDevice? { device(defaultInput) }
    var defaultOutputDevice: CatalogDevice? { device(defaultOutput) }

    // MARK: Private

    private func handle(_ change: DeviceCatalogChange) {
        switch change {
        case .list:
            reloadList()
        case .defaultDevice:
            reloadDefaults()
        case .alive(let id), .nominalRate(let id), .dataSource(let id, _), .format(let id), .hasChanged(let id):
            refresh(id)
        }
        changed(change)
    }

    private func reloadList() {
        // A failed read keeps the catalog as it is: missing devices would read as unplugged.
        guard let ids = try? hal.deviceIDs() else { return }
        var next: [CatalogDevice] = []
        for id in ids {
            if let existing = devices.first(where: { $0.id == id }) {
                next.append(existing)
                continue
            }
            guard let info = try? hal.deviceInfo(id), !info.uid.hasPrefix(Self.ownAggregatePrefix) else { continue }
            next.append(CatalogDevice(info: info))
            watch(id)
        }
        let kept = Set(next.map(\.id))
        // A device that left the list took its listeners with it.
        let present = Set(ids)
        for (id, tokens) in deviceTokens where !kept.contains(id) {
            tokens.forEach(present.contains(id) ? hal.removeListener : hal.discardListener)
            deviceTokens.removeValue(forKey: id)
        }
        devices = next
    }

    private func reloadDefaults() {
        defaultInput = (try? hal.defaultDevice(.input)) ?? nil
        defaultOutput = (try? hal.defaultDevice(.output)) ?? nil
    }

    private func refresh(_ id: HALObjectID) {
        guard let index = devices.firstIndex(where: { $0.id == id }) else { return }
        if let info = try? hal.deviceInfo(id) {
            devices[index] = CatalogDevice(info: info)
        } else {
            devices[index].info.alive = false
        }
    }

    private func watch(_ id: HALObjectID) {
        var tokens: [HALListenerToken] = []
        let properties: [(HALProperty, DeviceCatalogChange)] = [
            (.deviceIsAlive, .alive(id)),
            (.nominalSampleRate, .nominalRate(id)),
            (.dataSource(.input), .dataSource(id, .input)),
            (.dataSource(.output), .dataSource(id, .output)),
            (.streamFormat(.input), .format(id)),
            (.deviceHasChanged, .hasChanged(id)),
        ]
        for (property, change) in properties {
            if let token = try? hal.addListener(id, property, queue: queue, { [weak self] in self?.handle(change) }) {
                tokens.append(token)
            }
        }
        deviceTokens[id] = tokens
    }
}
