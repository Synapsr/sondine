import Darwin

// Which peers `sondine-lan` accepts (ADR 008, « Which peers »), as a pure
// function of the peer's address and the Mac's interfaces, so tests give it
// any interface list. The relay calls it before TLS starts.

/// A peer's IP address, without its port. IPv6 keeps the interface a
/// link-local address is scoped to.
public enum PeerAddress: Hashable, Sendable {
    /// Host byte order.
    case v4(UInt32)
    case v6([UInt8], zone: String?)

    /// An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is the IPv4 peer it maps.
    public static func ipv6(_ bytes: [UInt8], zone: String?) -> PeerAddress {
        precondition(bytes.count == 16)
        if bytes[0..<10].allSatisfy({ $0 == 0 }) && bytes[10] == 0xff && bytes[11] == 0xff {
            return .v4(UInt32(bytes[12]) << 24 | UInt32(bytes[13]) << 16 | UInt32(bytes[14]) << 8 | UInt32(bytes[15]))
        }
        return .v6(bytes, zone: zone)
    }

    /// Parses `a.b.c.d`, or an IPv6 address with an optional `%zone`.
    public init?(_ text: String) {
        var v4 = in_addr()
        if inet_pton(AF_INET, text, &v4) == 1 {
            self = .v4(UInt32(bigEndian: v4.s_addr))
            return
        }
        let parts = text.split(separator: "%", maxSplits: 1, omittingEmptySubsequences: false)
        var v6 = in6_addr()
        guard inet_pton(AF_INET6, String(parts[0]), &v6) == 1 else { return nil }
        let bytes = withUnsafeBytes(of: v6) { Array($0) }
        self = .ipv6(bytes, zone: parts.count == 2 ? String(parts[1]) : nil)
    }

    /// The address as `PhoneRelayHello.peer` carries it: dotted IPv4, or
    /// IPv6 with its zone when link-local.
    public var description: String {
        switch self {
        case .v4(let value):
            var address = in_addr(s_addr: value.bigEndian)
            var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
            inet_ntop(AF_INET, &address, &buffer, socklen_t(buffer.count))
            return text(buffer)
        case .v6(let bytes, let zone):
            var address = in6_addr()
            withUnsafeMutableBytes(of: &address) { $0.copyBytes(from: bytes) }
            var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
            inet_ntop(AF_INET6, &address, &buffer, socklen_t(buffer.count))
            if let zone, isIPv6LinkLocal(bytes) { return "\(text(buffer))%\(zone)" }
            return text(buffer)
        }
    }

    /// What kind of address it is, the only thing logs say about a peer.
    public var addressClass: String {
        switch self {
        case .v4(let value):
            if value >> 24 == 127 { return "loopback" }
            if value >> 16 == 0xA9FE { return "link-local" }
            if value >> 24 == 10 || value >> 20 == 0xAC1 || value >> 16 == 0xC0A8 { return "private" }
            if value >> 22 == 0x191 { return "shared (100.64/10)" }
            return "public"
        case .v6(let bytes, _):
            if bytes == ipv6Loopback { return "loopback" }
            if isIPv6LinkLocal(bytes) { return "link-local" }
            if bytes[0] & 0xfe == 0xfc { return "unique-local" }
            return "public"
        }
    }
}

/// One address of an interface, with its netmask.
public enum InterfaceAddress: Hashable, Sendable {
    /// Host byte order.
    case v4(address: UInt32, mask: UInt32)
    case v6(address: [UInt8], prefixLength: Int)
}

public struct InterfaceFlags: OptionSet, Hashable, Sendable {
    public let rawValue: UInt32
    public init(rawValue: UInt32) { self.rawValue = rawValue }
    public static let up = InterfaceFlags(rawValue: UInt32(IFF_UP))
    public static let broadcast = InterfaceFlags(rawValue: UInt32(IFF_BROADCAST))
    public static let loopback = InterfaceFlags(rawValue: UInt32(IFF_LOOPBACK))
    public static let pointToPoint = InterfaceFlags(rawValue: UInt32(IFF_POINTOPOINT))
}

public struct NetworkInterface: Hashable, Sendable {
    public var name: String
    public var flags: InterfaceFlags
    public var addresses: [InterfaceAddress]

    public init(name: String, flags: InterfaceFlags, addresses: [InterfaceAddress]) {
        self.name = name
        self.flags = flags
        self.addresses = addresses
    }

    var isLoopback: Bool { flags.contains(.loopback) }

    /// A tunnel: point-to-point, or one of the `utun` interfaces VPNs use.
    var isTunnel: Bool { !isLoopback && (flags.contains(.pointToPoint) || name.hasPrefix("utun")) }

    /// Wi-Fi or Ethernet: up, broadcast-capable, not loopback, not a tunnel.
    /// Apple's peer-to-peer Wi-Fi (`awdl`, `llw`) joins nearby devices, not
    /// the network the Mac is on, so it is not one.
    var isLocalNetwork: Bool {
        flags.contains(.up) && flags.contains(.broadcast) && !isLoopback && !isTunnel
            && !name.hasPrefix("awdl") && !name.hasPrefix("llw")
    }
}

/// The path a peer took: what `PhoneRelayHello.via` says.
public enum PeerPath: String, Sendable {
    case lan, tailnet, loopback
}

public struct PeerPolicy: Sendable {
    /// « Autoriser par Tailscale »: peers from Tailscale's ranges on a tunnel.
    public var tailnet: Bool
    /// Development only.
    public var loopback: Bool
    /// The end-to-end test's stand-in for a tunnel: a peer at `::1` is taken
    /// as one from Tailscale's ranges (refused unless `tailnet`, labelled
    /// `tailnet`). Only a debug build's command line can set it.
    public var loopbackV6AsTailnet: Bool

    public init(tailnet: Bool = false, loopback: Bool = false, loopbackV6AsTailnet: Bool = false) {
        self.tailnet = tailnet
        self.loopback = loopback
        self.loopbackV6AsTailnet = loopbackV6AsTailnet
    }
}

public enum PeerFilter {
    /// The path `peer` took, or nil when it is refused.
    ///
    /// - Loopback (127/8, ::1, or an address of a loopback interface): only
    ///   when the policy allows it.
    /// - Local network: an IPv4 address in a subnet directly connected
    ///   through a broadcast-capable interface, an IPv6 link-local address
    ///   scoped to such an interface, or another IPv6 address in a prefix the
    ///   Mac holds on such an interface (a phone on the same Wi-Fi reaches the
    ///   Mac's global IPv6 address when the router gives one).
    /// - Tailnet, when allowed: an address in 100.64.0.0/10 or
    ///   fd7a:115c:a1e0::/48 while a tunnel interface holds an address in
    ///   that range, which is how the peer's packets arrive.
    public static func classify(_ peer: PeerAddress, interfaces: [NetworkInterface], policy: PeerPolicy) -> PeerPath? {
        if policy.loopbackV6AsTailnet, case .v6(let bytes, _) = peer, bytes == ipv6Loopback {
            return policy.tailnet ? .tailnet : nil
        }
        if isLoopback(peer, interfaces: interfaces) { return policy.loopback ? .loopback : nil }
        let local = interfaces.filter(\.isLocalNetwork)
        switch peer {
        case .v4(let address):
            let onLink = local.contains { interface in
                interface.addresses.contains { entry in
                    guard case .v4(let own, let mask) = entry, mask != 0 else { return false }
                    return own & mask == address & mask
                }
            }
            if onLink { return .lan }
        case .v6(let bytes, let zone):
            if isIPv6LinkLocal(bytes) {
                if let zone, local.contains(where: { $0.name == zone }) { return .lan }
            } else {
                // A global or unique-local address in a prefix on the link, as
                // the Mac's own address there says: IPv6's directly connected subnet.
                let onLink = local.contains { interface in
                    interface.addresses.contains { entry in
                        guard case .v6(let own, let prefixLength) = entry, !isIPv6LinkLocal(own),
                              (1...128).contains(prefixLength) else { return false }
                        return samePrefix(own, bytes, prefixLength)
                    }
                }
                if onLink { return .lan }
            }
        }
        if policy.tailnet, inTailnetRange(peer) {
            let tunnelInRange = interfaces.contains { interface in
                interface.isTunnel && interface.flags.contains(.up) && interface.addresses.contains { entry in
                    switch entry {
                    case .v4(let address, _): return inTailnetRange(.v4(address))
                    case .v6(let address, _): return inTailnetRange(.v6(address, zone: nil))
                    }
                }
            }
            if tunnelInRange { return .tailnet }
        }
        return nil
    }

    static func isLoopback(_ peer: PeerAddress, interfaces: [NetworkInterface]) -> Bool {
        switch peer {
        case .v4(let address):
            if address >> 24 == 127 { return true }
        case .v6(let bytes, let zone):
            if bytes == ipv6Loopback { return true }
            if let zone, isIPv6LinkLocal(bytes), interfaces.contains(where: { $0.name == zone && $0.isLoopback }) { return true }
        }
        // An address the Mac gave one of its loopback interfaces (lo0 aliases).
        return interfaces.filter(\.isLoopback).contains { interface in
            interface.addresses.contains { entry in
                switch (entry, peer) {
                case (.v4(let own, _), .v4(let address)): return own == address
                case (.v6(let own, _), .v6(let address, _)): return own == address
                default: return false
                }
            }
        }
    }

    /// Whether `a` and `b` share their first `bits` bits.
    static func samePrefix(_ a: [UInt8], _ b: [UInt8], _ bits: Int) -> Bool {
        guard a.count == 16, b.count == 16 else { return false }
        let whole = bits / 8
        if a[0..<whole] != b[0..<whole] { return false }
        let rest = bits % 8
        if rest == 0 { return true }
        let mask = UInt8(0xff) << (8 - rest)
        return a[whole] & mask == b[whole] & mask
    }

    /// 100.64.0.0/10 and fd7a:115c:a1e0::/48, the ranges Tailscale gives its nodes.
    static func inTailnetRange(_ peer: PeerAddress) -> Bool {
        switch peer {
        case .v4(let address): return address >> 22 == 0x191  // 100.64.0.0/10
        case .v6(let bytes, _): return Array(bytes.prefix(6)) == [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0]
        }
    }
}

/// A C string buffer's text, up to its terminator.
private func text(_ buffer: [CChar]) -> String {
    String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
}

let ipv6Loopback: [UInt8] = Array(repeating: 0, count: 15) + [1]

func isIPv6LinkLocal(_ bytes: [UInt8]) -> Bool {
    bytes.count == 16 && bytes[0] == 0xfe && bytes[1] & 0xc0 == 0x80
}
