import Foundation
import SondineCapture
import SystemConfiguration

/// The networks the Mac is on, from SystemConfiguration (ADR 029): the `NetworkSignature` of each
/// service in `State:/Network/Service/*/IPv4` and `*/IPv6` that names a router hardware address
/// (a physical LAN; a VPN in front has none), IPv4 first. No permission: Wi-Fi names and BSSIDs
/// need Location, signatures do not. One notification on the main run loop when those keys
/// change, nothing polled; AirPort keys (link quality) are never watched, they change all the
/// time. A signature is never logged: the engine hashes it with the install's key.
final class SystemNetworkSignatures: NetworkSource, @unchecked Sendable {
    static let patterns = ["State:/Network/Service/.*/IPv4", "State:/Network/Service/.*/IPv6"]

    private let lock = NSLock()
    private var store: SCDynamicStore?
    private var source: CFRunLoopSource?
    private var handler: (@Sendable ([NetworkSignature]) -> Void)?

    func start(handler: @escaping @Sendable ([NetworkSignature]) -> Void) -> [NetworkSignature] {
        var context = SCDynamicStoreContext(
            version: 0, info: Unmanaged.passUnretained(self).toOpaque(), retain: nil, release: nil, copyDescription: nil
        )
        let callback: SCDynamicStoreCallBack = { store, _, info in
            guard let info else { return }
            let me = Unmanaged<SystemNetworkSignatures>.fromOpaque(info).takeUnretainedValue()
            let current = SystemNetworkSignatures.read(store)
            let handler = me.lock.withLock { me.handler }
            handler?(current)
        }
        guard let store = SCDynamicStoreCreate(nil, "app.sondine.audio.networks" as CFString, callback, &context) else { return [] }
        SCDynamicStoreSetNotificationKeys(store, nil, Self.patterns as CFArray)
        let source = SCDynamicStoreCreateRunLoopSource(nil, store, 0)
        if let source { CFRunLoopAddSource(CFRunLoopGetMain(), source, .defaultMode) }
        lock.withLock {
            self.store = store
            self.source = source
            self.handler = handler
        }
        return Self.read(store)
    }

    func stop() {
        let source = lock.withLock { () -> CFRunLoopSource? in
            defer {
                self.source = nil
                store = nil
                handler = nil
            }
            return self.source
        }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .defaultMode) }
    }

    /// The signatures now, IPv4 first, unique.
    static func read(_ store: SCDynamicStore) -> [NetworkSignature] {
        var signatures: [NetworkSignature] = []
        for pattern in patterns {
            let keys = (SCDynamicStoreCopyKeyList(store, pattern as CFString) as? [String] ?? []).sorted()
            for key in keys {
                guard let value = SCDynamicStoreCopyValue(store, key as CFString) as? [String: Any],
                      let signature = value["NetworkSignature"] as? String,
                      signature.contains("RouterHardwareAddress") else { continue }
                let entry = NetworkSignature(signature)
                if !signatures.contains(entry) { signatures.append(entry) }
            }
        }
        return signatures
    }

    /// The signatures now, without watching (self-test).
    static func readOnce() -> [NetworkSignature]? {
        guard let store = SCDynamicStoreCreate(nil, "app.sondine.audio.self-test" as CFString, nil, nil) else { return nil }
        return read(store)
    }
}
