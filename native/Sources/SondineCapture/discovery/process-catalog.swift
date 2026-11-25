import Dispatch

/// A Core Audio process object, its incarnation, its resolved app, and its live IO state.
public struct CatalogProcess: Sendable, Equatable {
    public var info: HALProcessInfo
    public var resolution: ProcessResolution
    public var io: HALProcessIO

    public var id: HALObjectID { info.id }
    public var pid: Int32 { info.pid }
    /// A process incarnation is (pid, start time): pids are reused, start times are not.
    public var incarnation: ProcessIncarnation { ProcessIncarnation(pid: info.pid, startWallNs: resolution.startWallNs) }
}

public struct ProcessIncarnation: Sendable, Hashable {
    public var pid: Int32
    public var startWallNs: UInt64?
}

public enum ProcessCatalogChange: Sendable, Equatable {
    /// Objects appeared or disappeared.
    case list(added: [HALObjectID], removed: [HALObjectID])
    /// IsRunningInput, IsRunningOutput or Devices changed on one object.
    case io(HALObjectID)
}

/// Process objects, driven by listeners only (architecture §3 Discovery): one listener on the
/// process object list; when an object appears its pid, bundle id and app are read and resolved
/// once, and listeners on IsRunningInput, IsRunningOutput and Devices (input and output) keep its
/// IO state. There is no periodic scan: each read costs coreaudiod CPU.
///
/// Confined to the engine queue.
final class ProcessCatalog: @unchecked Sendable {
    private let hal: any AudioHardware
    private let queue: DispatchQueue
    private let resolver: ProcessResolver
    private let changed: (ProcessCatalogChange) -> Void
    private(set) var processes: [CatalogProcess] = []
    private var listToken: HALListenerToken?
    private var objectTokens: [HALObjectID: [HALListenerToken]] = [:]
    /// Resolutions by incarnation, so a process with several objects is resolved once.
    private var resolved: [ProcessIncarnation: ProcessResolution] = [:]

    init(hal: any AudioHardware, queue: DispatchQueue, resolver: ProcessResolver, changed: @escaping (ProcessCatalogChange) -> Void) {
        self.hal = hal
        self.queue = queue
        self.resolver = resolver
        self.changed = changed
    }

    func start() throws {
        listToken = try hal.addListener(halSystemObject, .processObjectList, queue: queue) { [weak self] in self?.reloadList(notify: true) }
        reloadList(notify: false)
    }

    /// - Parameter objectsGone: coreaudiod restarted, so every listener died with its object.
    func stop(objectsGone: Bool = false) {
        let release = objectsGone ? hal.discardListener : hal.removeListener
        if let listToken { release(listToken) }
        listToken = nil
        for tokens in objectTokens.values { tokens.forEach(release) }
        objectTokens.removeAll()
        processes.removeAll()
    }

    func process(_ id: HALObjectID) -> CatalogProcess? { processes.first { $0.id == id } }

    // MARK: Private

    private func reloadList(notify: Bool) {
        let ids = (try? hal.processObjectIDs()) ?? processes.map(\.id)
        let known = Set(processes.map(\.id))
        let current = Set(ids)
        var added: [HALObjectID] = []
        var next: [CatalogProcess] = []
        for id in ids {
            if let existing = processes.first(where: { $0.id == id }) {
                next.append(existing)
                continue
            }
            guard let info = try? hal.processInfo(id), info.pid > 0 else { continue }
            let startNs = resolver.introspection.startWallNs(info.pid)
            let key = ProcessIncarnation(pid: info.pid, startWallNs: startNs)
            let resolution = resolved[key] ?? resolver.resolve(pid: info.pid, halBundleID: info.bundleID)
            resolved[key] = resolution
            // Listeners first, then the read, so a change between the two is not missed.
            watch(id)
            let io = (try? hal.processIO(id)) ?? HALProcessIO()
            next.append(CatalogProcess(info: info, resolution: resolution, io: io))
            added.append(id)
        }
        let removed = known.subtracting(current).sorted()
        // The object left the list, and its listeners went with it.
        for id in removed {
            objectTokens.removeValue(forKey: id)?.forEach(hal.discardListener)
        }
        let live = Set(next.map(\.incarnation))
        resolved = resolved.filter { live.contains($0.key) }
        processes = next
        if notify, !added.isEmpty || !removed.isEmpty { changed(.list(added: added, removed: removed)) }
    }

    private func refreshIO(_ id: HALObjectID) {
        guard let index = processes.firstIndex(where: { $0.id == id }), let io = try? hal.processIO(id) else { return }
        guard processes[index].io != io else { return }
        processes[index].io = io
        changed(.io(id))
    }

    /// On macOS 27.0.1 the `IsRunning…` listeners never fire; the `Devices` listeners fire on
    /// every IO start and stop (`sondine-audio self-test listeners`, 150 of 150 changes,
    /// 2026-11-04). Keep all four, and re-read both flags on any of them.
    private func watch(_ id: HALObjectID) {
        var tokens: [HALListenerToken] = []
        for property in [HALProperty.processIsRunningInput, .processIsRunningOutput, .processDevices(.input), .processDevices(.output)] {
            if let token = try? hal.addListener(id, property, queue: queue, { [weak self] in self?.refreshIO(id) }) {
                tokens.append(token)
            }
        }
        objectTokens[id] = tokens
    }
}
