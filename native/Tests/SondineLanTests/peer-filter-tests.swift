import Foundation
@testable import SondineLan
import Testing

/// ADR 008, « Which peers », over interface lists the tests make up.
@Suite struct PeerFilterTests {
    static let wifi = NetworkInterface(
        name: "en0", flags: [.up, .broadcast],
        addresses: [
            .v4(address: ip("192.168.1.13"), mask: ip("255.255.255.0")), .v6(address: bytes("fe80::1c2b:3a4d:5e6f:7081"), prefixLength: 64),
            .v6(address: bytes("2a01:cb08:85e9:3700:1c2f:916a:49cd:3882"), prefixLength: 64),
        ]
    )
    static let ethernet = NetworkInterface(name: "en8", flags: [.up, .broadcast], addresses: [.v4(address: ip("10.0.0.2"), mask: ip("255.255.0.0"))])
    static let loopback = NetworkInterface(
        name: "lo0", flags: [.up, .loopback],
        addresses: [.v4(address: ip("127.0.0.1"), mask: ip("255.0.0.0")), .v4(address: ip("10.254.254.254"), mask: ip("255.0.0.0")), .v6(address: bytes("::1"), prefixLength: 128)]
    )
    static let tailscale = NetworkInterface(
        name: "utun4", flags: [.up, .pointToPoint],
        addresses: [.v4(address: ip("100.88.10.20"), mask: ip("255.255.255.255")), .v6(address: bytes("fd7a:115c:a1e0::9001:ba2a"), prefixLength: 128)]
    )
    static let otherVPN = NetworkInterface(name: "utun7", flags: [.up, .pointToPoint], addresses: [.v4(address: ip("172.20.0.2"), mask: ip("255.255.255.0"))])
    static let awdl = NetworkInterface(name: "awdl0", flags: [.up, .broadcast], addresses: [.v6(address: bytes("fe80::4:5"), prefixLength: 64)])
    static let home = [loopback, wifi, ethernet, awdl, tailscale, otherVPN]

    private func path(_ address: String, _ interfaces: [NetworkInterface] = home, tailnet: Bool = false, loopback: Bool = false) -> PeerPath? {
        PeerFilter.classify(PeerAddress(address)!, interfaces: interfaces, policy: PeerPolicy(tailnet: tailnet, loopback: loopback))
    }

    @Test func ipv4OnADirectlyConnectedSubnetIsLan() {
        #expect(path("192.168.1.31") == .lan)
        #expect(path("192.168.1.255") == .lan)
        #expect(path("10.0.200.7") == .lan)
        #expect(path("::ffff:192.168.1.31") == .lan, "an IPv4-mapped address is its IPv4 peer")
    }

    @Test func ipv4ElsewhereIsRefused() {
        #expect(path("192.168.2.31") == nil, "another subnet, even private")
        #expect(path("8.8.8.8") == nil)
        #expect(path("10.1.0.1") == nil)
        #expect(path("172.20.0.9") == nil, "a subnet behind a tunnel is not the local network")
    }

    @Test func aSubnetOnAnInterfaceThatIsDownOrNotBroadcastIsRefused() {
        var down = Self.wifi
        down.flags = [.broadcast]
        #expect(path("192.168.1.31", [down]) == nil)
        var tunnelWithBroadcast = Self.wifi
        tunnelWithBroadcast.name = "utun9"
        #expect(path("192.168.1.31", [tunnelWithBroadcast]) == nil, "utun is a tunnel whatever its flags")
        var pointToPoint = Self.wifi
        pointToPoint.flags = [.up, .broadcast, .pointToPoint]
        #expect(path("192.168.1.31", [pointToPoint]) == nil)
    }

    @Test func ipv6LinkLocalCountsOnlyOnALocalNetworkInterface() {
        #expect(path("fe80::aa:bb%en0") == .lan)
        #expect(path("fe80::aa:bb%en8") == .lan)
        #expect(path("fe80::aa:bb%utun4") == nil, "a tunnel")
        #expect(path("fe80::aa:bb%awdl0") == nil, "Apple's peer-to-peer Wi-Fi")
        #expect(path("fe80::aa:bb%en5") == nil, "an interface the Mac does not have")
        #expect(path("fe80::aa:bb") == nil, "no interface: no way to tell")
    }

    @Test func ipv6InAPrefixTheMacHoldsOnTheWifiIsLan() {
        // Téo's iPhone on the same Wi-Fi reached the Mac's global IPv6 address (2026-11-13).
        #expect(path("2a01:cb08:85e9:3700:8:9:a:b") == .lan)
        #expect(path("2a01:cb08:85e9:3701::1") == nil, "the next /64 is not on the link")
        var vpn = Self.otherVPN
        vpn.addresses = [.v6(address: bytes("2a01:cb08:85e9:3700::1"), prefixLength: 64)]
        #expect(path("2a01:cb08:85e9:3700:8:9:a:b", [vpn]) == nil, "a prefix behind a tunnel is not the local network")
        #expect(PeerFilter.samePrefix(bytes("2001:db8::"), bytes("2001:db8:ff::"), 33))
        #expect(!PeerFilter.samePrefix(bytes("2001:db8::"), bytes("2001:db8:8000::"), 33))
    }

    @Test func otherIpv6IsRefused() {
        #expect(path("2a01:cb00::1") == nil)
        #expect(path("fd00::1") == nil, "unique local, not link-local")
        #expect(path("fd7a:115c:a1e0::77") == nil, "Tailscale's range, without the switch")
    }

    @Test func loopbackOnlyWhenAllowed() {
        for address in ["127.0.0.1", "127.8.9.10", "::1", "10.254.254.254", "fe80::1%lo0"] {
            #expect(path(address) == nil, "\(address)")
            #expect(path(address, loopback: true) == .loopback, "\(address)")
            #expect(path(address, tailnet: true) == nil, "\(address)")
        }
    }

    @Test func tailnetRangesOnATunnelOnlyWithTheSwitch() {
        #expect(path("100.101.102.103") == nil)
        #expect(path("100.101.102.103", tailnet: true) == .tailnet)
        #expect(path("100.64.0.1", tailnet: true) == .tailnet)
        #expect(path("100.127.255.254", tailnet: true) == .tailnet)
        #expect(path("fd7a:115c:a1e0::77", tailnet: true) == .tailnet)
        #expect(path("100.128.0.1", tailnet: true) == nil, "outside 100.64.0.0/10")
        #expect(path("100.63.255.255", tailnet: true) == nil, "outside 100.64.0.0/10")
        #expect(path("fd7a:115c:a1e1::77", tailnet: true) == nil, "outside fd7a:115c:a1e0::/48")
        #expect(path("8.8.8.8", tailnet: true) == nil)
    }

    @Test func tailnetNeedsATunnelHoldingAnAddressInTheRange() {
        let noTunnel = [Self.loopback, Self.wifi, Self.otherVPN]
        #expect(path("100.101.102.103", noTunnel, tailnet: true) == nil)
        var wifiInRange = Self.wifi
        wifiInRange.addresses = [.v4(address: ip("100.70.0.2"), mask: ip("255.255.255.255"))]
        #expect(path("100.101.102.103", [wifiInRange], tailnet: true) == nil, "the range on a broadcast interface is not a tunnel")
        var down = Self.tailscale
        down.flags = [.pointToPoint]
        #expect(path("100.101.102.103", [down], tailnet: true) == nil)
    }

    /// Tailscale as macOS shows it: a `utun` holding the Mac's 100.x/32, up
    /// and point-to-point. The switch alone decides; a phone on the Wi-Fi stays `lan`.
    @Test func theSwitchDecidesForAPhoneOnTailscale() {
        let mac = [Self.loopback, Self.wifi, Self.tailscale]
        for phone in ["100.101.102.103", "100.64.0.1", "fd7a:115c:a1e0:ab12:4843:cd96:6258:b240"] {
            #expect(path(phone, mac) == nil, "\(phone), switch off")
            #expect(path(phone, mac, tailnet: true) == .tailnet, "\(phone), switch on")
        }
        #expect(path("192.168.1.31", mac, tailnet: true) == .lan, "at home, the same phone is on the Wi-Fi")
        // A tunnel holding only Tailscale's IPv6 range still carries its IPv4 peers: one interface, both ranges.
        var v6Only = Self.tailscale
        v6Only.addresses = [.v6(address: bytes("fd7a:115c:a1e0::9001:ba2a"), prefixLength: 128)]
        #expect(path("100.101.102.103", [Self.wifi, v6Only], tailnet: true) == .tailnet)
        // Tailscale stopped: its tunnel goes, and with it the path.
        #expect(path("100.101.102.103", [Self.loopback, Self.wifi, Self.otherVPN], tailnet: true) == nil)
    }

    @Test func theTestsStandInForATunnelIsLoopbackV6Only() {
        let policy = { (tailnet: Bool) in PeerPolicy(tailnet: tailnet, loopback: true, loopbackV6AsTailnet: true) }
        let classify = { (address: String, tailnet: Bool) in
            PeerFilter.classify(PeerAddress(address)!, interfaces: Self.home, policy: policy(tailnet))
        }
        #expect(classify("::1", false) == nil)
        #expect(classify("::1", true) == .tailnet)
        #expect(classify("127.0.0.1", true) == .loopback)
        #expect(classify("192.168.1.31", true) == .lan)
        #expect(PeerFilter.classify(PeerAddress("::1")!, interfaces: Self.home, policy: PeerPolicy(tailnet: true, loopback: true)) == .loopback)
    }

    @Test func aLanInSharedAddressSpaceStaysLan() {
        let carrierLan = NetworkInterface(name: "en0", flags: [.up, .broadcast], addresses: [.v4(address: ip("100.70.1.2"), mask: ip("255.255.255.0"))])
        #expect(path("100.70.1.9", [carrierLan, Self.tailscale], tailnet: true) == .lan)
        #expect(path("100.70.1.9", [carrierLan]) == .lan)
    }

    @Test func addressesPrintAsTheHelloCarriesThem() {
        #expect(PeerAddress("192.168.1.31")!.description == "192.168.1.31")
        #expect(PeerAddress("::ffff:192.168.1.31")!.description == "192.168.1.31")
        #expect(PeerAddress("fe80::aa:bb%en0")!.description == "fe80::aa:bb%en0")
        #expect(PeerAddress("fd7a:115c:a1e0::77%utun4")!.description == "fd7a:115c:a1e0::77", "a zone only on link-local")
        #expect(PeerAddress("::1")!.description == "::1")
        #expect(PeerAddress("not an address") == nil)
        #expect(PeerAddress("192.168.1.256") == nil)
    }

    @Test func logsSayOnlyTheAddressClass() {
        #expect(PeerAddress("127.0.0.1")!.addressClass == "loopback")
        #expect(PeerAddress("192.168.1.31")!.addressClass == "private")
        #expect(PeerAddress("172.31.0.1")!.addressClass == "private")
        #expect(PeerAddress("169.254.3.4")!.addressClass == "link-local")
        #expect(PeerAddress("100.101.102.103")!.addressClass == "shared (100.64/10)")
        #expect(PeerAddress("8.8.8.8")!.addressClass == "public")
        #expect(PeerAddress("fe80::1%en0")!.addressClass == "link-local")
        #expect(PeerAddress("fd7a:115c:a1e0::77")!.addressClass == "unique-local")
        #expect(PeerAddress("2a01:cb00::1")!.addressClass == "public")
    }

    /// The Mac's real interfaces: loopback is there, flagged, and the filter takes it as such.
    @Test func theMacsInterfacesReadBack() throws {
        let interfaces = NetworkInterfaces.current()
        let lo0 = try #require(interfaces.first { $0.name == "lo0" })
        #expect(lo0.flags.contains(.loopback) && lo0.flags.contains(.up))
        #expect(lo0.addresses.contains(.v4(address: ip("127.0.0.1"), mask: ip("255.0.0.0"))))
        #expect(lo0.addresses.contains(.v6(address: bytes("::1"), prefixLength: 128)))
        #expect(lo0.addresses.contains(.v6(address: bytes("fe80::1"), prefixLength: 64)), "the scope is cleared from link-local addresses")
        #expect(PeerFilter.classify(PeerAddress("127.0.0.1")!, interfaces: interfaces, policy: PeerPolicy(loopback: true)) == .loopback)
        #expect(PeerFilter.classify(PeerAddress("127.0.0.1")!, interfaces: interfaces, policy: PeerPolicy()) == nil)
    }
}

func ip(_ text: String) -> UInt32 {
    guard case .v4(let value) = PeerAddress(text)! else { fatalError(text) }
    return value
}

func bytes(_ text: String) -> [UInt8] {
    guard case .v6(let value, _) = PeerAddress(text)! else { fatalError(text) }
    return value
}
