import Darwin

public enum NetworkInterfaces {
    /// The Mac's interfaces now (`getifaddrs`), read at each connection so a
    /// network joined or left is seen at once.
    public static func current() -> [NetworkInterface] {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return [] }
        defer { freeifaddrs(head) }
        var order: [String] = []
        var byName: [String: NetworkInterface] = [:]
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let entry = cursor {
            defer { cursor = entry.pointee.ifa_next }
            let name = String(cString: entry.pointee.ifa_name)
            if byName[name] == nil {
                order.append(name)
                byName[name] = NetworkInterface(name: name, flags: InterfaceFlags(rawValue: entry.pointee.ifa_flags), addresses: [])
            }
            guard let address = entry.pointee.ifa_addr else { continue }
            switch Int32(address.pointee.sa_family) {
            case AF_INET:
                let own = address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
                let mask = entry.pointee.ifa_netmask.map { pointer in
                    pointer.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
                } ?? UInt32.max
                byName[name]?.addresses.append(.v4(address: own, mask: mask))
            case AF_INET6:
                let own = address.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { pointer in
                    withUnsafeBytes(of: pointer.pointee.sin6_addr) { Array($0) }
                }
                let prefix = entry.pointee.ifa_netmask.map { pointer in
                    pointer.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { mask in
                        withUnsafeBytes(of: mask.pointee.sin6_addr) { $0.reduce(0) { $0 + $1.nonzeroBitCount } }
                    }
                } ?? 128
                byName[name]?.addresses.append(.v6(address: normalizedScope(own), prefixLength: prefix))
            default:
                continue
            }
        }
        return order.compactMap { byName[$0] }
    }

    /// The kernel stores a link-local address's scope in its second 16-bit
    /// word (KAME); the address itself has zeros there.
    private static func normalizedScope(_ bytes: [UInt8]) -> [UInt8] {
        guard isIPv6LinkLocal(bytes) else { return bytes }
        var copy = bytes
        copy[2] = 0
        copy[3] = 0
        return copy
    }
}
