import Foundation
import Network
import SondinePhone
import Synchronization
import Testing

// Away from home through Tailscale (ADR 008, « Which peers »; plan § M5.5):
// the finder's order and times over a fake network, and the path the client
// learns from `hello`.

/// A network the test describes: what Bonjour finds, and how each address answers.
final class FakeNetwork: MacNetwork {
    enum Answer: Sendable {
        /// The connection opens after this long.
        case opens(after: Duration)
        /// It fails after this long (no route, refused).
        case fails(after: Duration)
        /// Nothing comes back: only the finder's timeout ends it.
        case hangs
    }

    struct Probe: Sendable {
        let endpoint: MacEndpoint
        let startedAt: ContinuousClock.Instant
    }

    let services: [MacEndpoint]
    let answers: [MacEndpoint: Answer]
    let probes = Mutex<[Probe]>([])
    let browses = Mutex(0)

    init(services: [MacEndpoint] = [], answers: [MacEndpoint: Answer]) {
        self.services = services
        self.answers = answers
    }

    var probed: [MacEndpoint] { probes.withLock { $0.map(\.endpoint) } }

    func browse(pin: String, for duration: Duration) async -> [MacEndpoint] {
        browses.withLock { $0 += 1 }
        try? await Task.sleep(for: duration)
        return services
    }

    func connects(_ endpoint: MacEndpoint) async -> Bool {
        probes.withLock { $0.append(Probe(endpoint: endpoint, startedAt: .now)) }
        switch answers[endpoint] ?? .fails(after: .zero) {
        case let .opens(after): return (try? await Task.sleep(for: after)) != nil
        case let .fails(after):
            try? await Task.sleep(for: after)
            return false
        case .hangs:
            // Until cancelled, as an NWConnection to an address that never answers.
            while !Task.isCancelled { try? await Task.sleep(for: .milliseconds(10)) }
            return false
        }
    }
}

@Suite struct MacFinderTests {
    let home = MacEndpoint(host: "192.168.1.24", port: 49_321)
    let ethernet = MacEndpoint(host: "10.0.0.2", port: 49_321)
    let tunnel = MacEndpoint(host: "100.88.10.20", port: 49_321)
    let tunnelV6 = MacEndpoint(host: "fd7a:115c:a1e0::9001:ba2a", port: 49_321)
    let bonjour = MacEndpoint(host: "fe80::1c2b:3a4d:5e6f:7081%en0", port: 49_321)

    /// Short times, so the tests measure the order and the limits, not seconds.
    private func finder(_ network: FakeNetwork) -> NetworkMacFinder {
        var finder = NetworkMacFinder(network: network)
        finder.browseFor = .milliseconds(50)
        finder.probeFor = .milliseconds(300)
        finder.tunnelProbeFor = .milliseconds(600)
        return finder
    }

    private func timed(_ find: () async -> [MacEndpoint]) async -> ([MacEndpoint], Duration) {
        let start = ContinuousClock.now
        let found = await find()
        return (found, ContinuousClock.now - start)
    }

    @Test func tunnelAddressesAreToldApartByTheirRange() {
        for host in ["100.64.0.1", "100.88.10.20", "100.127.255.254", "fd7a:115c:a1e0::1", "fd7a:115c:a1e0:ab12::9%utun4"] {
            #expect(MacEndpoint(host: host, port: 1).isTailnet, "\(host)")
        }
        for host in ["100.63.255.255", "100.128.0.1", "192.168.1.24", "10.0.0.2", "fd7a:115c:a1e1::1", "fe80::1%en0", "Sondine.local"] {
            #expect(!MacEndpoint(host: host, port: 1).isTailnet, "\(host)")
        }
    }

    @Test func atHomeTheTunnelIsNeverTried() async {
        let network = FakeNetwork(
            services: [bonjour], answers: [home: .opens(after: .milliseconds(5)), tunnel: .opens(after: .milliseconds(5))])
        let found = await finder(network).find(pin: "pin", known: [tunnel, home])
        #expect(found == [bonjour, home], "Bonjour first, then the home address; the tunnel's not at all")
        #expect(network.probed == [home])
    }

    @Test func withBonjourBlockedTheHomeAddressStillWins() async {
        let network = FakeNetwork(answers: [home: .opens(after: .milliseconds(5)), tunnel: .opens(after: .milliseconds(5))])
        #expect(await finder(network).find(pin: "pin", known: [home, tunnel]) == [home])
        #expect(!network.probed.contains(tunnel))
    }

    /// Every address a request would try, in order, as the client drains them.
    private func drained(_ finder: some MacFinding, _ known: [MacEndpoint]) async -> [MacEndpoint] {
        var candidates = MacCandidates(finder: finder, pin: "pin", known: known)
        var all: [MacEndpoint] = []
        while let endpoint = await candidates.next() { all.append(endpoint) }
        return all
    }

    @Test func awayTheTunnelIsTriedOnceHomeHasNotAnswered() async {
        let network = FakeNetwork(answers: [
            home: .hangs, ethernet: .fails(after: .milliseconds(5)), tunnel: .opens(after: .milliseconds(20)),
        ])
        let (found, elapsed) = await timed { await drained(finder(network), [home, ethernet, tunnel]) }
        #expect(found == [tunnel])
        let probes = network.probes.withLock { $0 }
        let firstHome = probes.filter { !$0.endpoint.isTailnet }.map(\.startedAt).min()
        let tunnelStart = probes.first { $0.endpoint == tunnel }?.startedAt
        if let firstHome, let tunnelStart {
            #expect(tunnelStart - firstHome >= .milliseconds(300), "the home address had its whole time first")
        } else {
            Issue.record("both were probed")
        }
        #expect(elapsed < .milliseconds(300 + 600 + 400), "well within both limits")
    }

    /// Codex Astra's review: away from home, another machine at the saved
    /// private address accepted the port, the finder took it for the Mac and
    /// never tried the tunnel. An open port is not the Mac: the tunnel comes
    /// after it, for the pinned `hello` to decide.
    @Test func aHomeAddressThatAcceptsThePortDoesNotHideTheTunnel() async {
        let network = FakeNetwork(answers: [home: .opens(after: .milliseconds(5)), tunnel: .opens(after: .milliseconds(5))])
        #expect(await finder(network).find(pin: "pin", known: [home, tunnel]) == [home])
        #expect(await drained(finder(network), [home, tunnel]) == [home, tunnel])
    }

    @Test func onCellularTheTunnelComesAsSoonAsHomeFails() async {
        // No route to the home addresses: they fail at once, and Bonjour's time is all it costs.
        let network = FakeNetwork(answers: [home: .fails(after: .milliseconds(2)), tunnel: .opens(after: .milliseconds(20))])
        var finder = finder(network)
        finder.probeFor = .seconds(2)
        let (found, elapsed) = await timed { await drained(finder, [home, tunnel]) }
        #expect(found == [tunnel])
        #expect(elapsed < .seconds(1), "well before the home address's 2 s")
    }

    @Test func nothingAnsweringNeverHangs() async {
        let network = FakeNetwork(answers: [home: .hangs, tunnel: .hangs, tunnelV6: .hangs])
        let (found, elapsed) = await timed { await drained(finder(network), [home, tunnel, tunnelV6]) }
        #expect(found.isEmpty)
        #expect(elapsed >= .milliseconds(300 + 600))
        #expect(elapsed < .milliseconds(300 + 600 + 500), "cut at each limit")
    }

    @Test func tunnelsKeepTheMacsOrder() async {
        let network = FakeNetwork(answers: [
            home: .fails(after: .zero), tunnel: .opens(after: .milliseconds(40)), tunnelV6: .opens(after: .milliseconds(5)),
        ])
        #expect(await finder(network).findTunnel(pin: "pin", known: [home, tunnel, tunnelV6]) == [tunnel, tunnelV6])
        #expect(await drained(finder(network), [home, tunnel, tunnelV6]) == [tunnel, tunnelV6])
    }

    @Test func eachAddressIsTriedOnceTheOneThatAnsweredLastFirst() async {
        let network = FakeNetwork(answers: [home: .opens(after: .zero), ethernet: .opens(after: .zero), tunnel: .opens(after: .zero)])
        var candidates = MacCandidates(finder: finder(network), pin: "pin", known: [home, ethernet, tunnel], first: [tunnel])
        var all: [MacEndpoint] = []
        while let endpoint = await candidates.next() { all.append(endpoint) }
        #expect(all == [tunnel, home, ethernet])
        var preferring = MacCandidates(finder: finder(network), pin: "pin", known: [home, ethernet], preferred: ethernet)
        #expect(await preferring.next() == ethernet)
        var gone = MacCandidates(
            finder: finder(FakeNetwork(answers: [home: .opens(after: .zero)])), pin: "pin", known: [home, ethernet],
            preferred: ethernet)
        #expect(await gone.next() == home, "an address the finder did not find again is not waited for")
    }

    @Test func aSlowBonjourIsCutToo() async {
        // Bonjour's resolution may hang; the finder stops waiting a second after its browse.
        final class StuckBonjour: MacNetwork {
            func browse(pin: String, for duration: Duration) async -> [MacEndpoint] {
                while !Task.isCancelled { try? await Task.sleep(for: .milliseconds(10)) }
                return []
            }
            func connects(_ endpoint: MacEndpoint) async -> Bool { endpoint.isTailnet }
        }
        var finder = NetworkMacFinder(network: StuckBonjour())
        finder.browseFor = .milliseconds(50)
        finder.probeFor = .milliseconds(100)
        finder.tunnelProbeFor = .milliseconds(100)
        let (found, elapsed) = await timed { await drained(finder, [tunnel]) }
        #expect(found == [tunnel])
        #expect(elapsed < .milliseconds(50 + 1_000 + 500))
    }

    /// Codex Astra's review: a probe of a home address must not leave by the
    /// carrier; a tunnel's may, as its requests do.
    @Test func probesUseCellularForTunnelAddressesOnly() {
        #expect(SystemMacNetwork.parameters(for: home).prohibitedInterfaceTypes == [.cellular])
        #expect(SystemMacNetwork.parameters(for: bonjour).prohibitedInterfaceTypes == [.cellular])
        #expect(SystemMacNetwork.parameters(for: nil).prohibitedInterfaceTypes == [.cellular], "a Bonjour service")
        #expect(SystemMacNetwork.parameters(for: tunnel).prohibitedInterfaceTypes?.contains(.cellular) != true)
        #expect(SystemMacNetwork.parameters(for: tunnelV6).prohibitedInterfaceTypes?.contains(.cellular) != true)
    }
}

/// The client learns the path from `hello` and syncs at home again once home answers.
@Suite struct MacPathTests {
    /// Codex Astra's review, through the client: away from home, another
    /// machine at the Mac's home address accepts the port and fails the pin;
    /// the tunnel is tried next and the sync goes through it.
    @Test func anotherMachineAtTheHomeAddressDoesNotHideTheTunnel() async throws {
        let mac = FakeMac()
        let network = FakeNetwork(answers: [
            mac.endpoint: .opens(after: .zero), MacEndpoint(host: mac.tunnelHost, port: mac.port): .opens(after: .zero),
        ])
        var finder = NetworkMacFinder(network: network)
        finder.browseFor = .milliseconds(10)
        let rig = try SyncRig(finder: finder)
        try await rig.paired(with: mac)
        mac.addTunnel()
        #expect(await rig.client.sync() == .done)
        #expect(await rig.client.status.path == .home)

        FakeMacProtocol.impostor(at: mac.host)
        defer { FakeMacProtocol.unregister(mac.host) }
        let recording = try rig.recording(bytes: 20_000)
        #expect(await rig.client.sync() == .done)
        #expect(await rig.client.status.path == .tailnet)
        #expect(rig.store.recording(recording.id)?.sync.stored == true)
        #expect(rig.credentials.read() != nil, "a failed pin is not a refusal: the pairing stays")
    }

    @Test func theStatusSaysHowTheMacWasReached() async throws {
        let mac = FakeMac()
        let rig = try SyncRig()
        try await rig.paired(with: mac)
        #expect(await rig.client.status.path == .home)

        // « Autoriser par Tailscale » on: the next contact at home learns the tunnel's address.
        mac.addTunnel()
        #expect(await rig.client.sync() == .done)
        #expect(await rig.client.status.path == .home)
        #expect(rig.device.file.mac?.addrs == [mac.host, mac.tunnelHost])

        // Away: home does not answer, the tunnel does, and a recording goes through it.
        mac.reachableAtHome(false)
        let recording = try rig.recording(bytes: 50_000)
        #expect(await rig.client.sync() == .done)
        #expect(await rig.client.status.path == .tailnet)
        #expect(await rig.client.status.reachable)
        #expect(rig.store.recording(recording.id)?.sync.stored == true)

        // Home again: the tunnel that answered last does not jump ahead of home.
        mac.reachableAtHome(true)
        #expect(await rig.client.sync() == .done)
        #expect(await rig.client.status.path == .home)
        #expect(mac.state.withLock { $0.hellos } == [.home, .tailnet, .home])

        // Neither answers: no path.
        mac.reachableAtHome(false)
        FakeMacProtocol.unregister(mac.tunnelHost)
        #expect(await rig.client.sync() == .unreachable)
        let status = await rig.client.status
        #expect(!status.reachable && status.path == nil)
    }
}
