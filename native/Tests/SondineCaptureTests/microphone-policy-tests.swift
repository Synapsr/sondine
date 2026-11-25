import Synchronization
import Testing
@testable import SondineCapture

/// The microphone selection matrix (architecture §3 Microphones).
struct MicrophonePolicyTests {
    private static let nextID = Atomic<HALObjectID>(100)

    private static func device(_ uid: String, _ transport: String, input: Int = 1, output: Int = 0, alive: Bool = true, name: String? = nil) -> CatalogDevice {
        CatalogDevice(info: HALDeviceInfo(
            id: nextID.add(1, ordering: .relaxed).newValue, uid: uid, name: name ?? uid, transportCode: fourCharCode(transport),
            inputChannels: input, outputChannels: output, alive: alive
        ))
    }

    private let builtIn = device("BuiltInMicrophoneDevice", "bltn")
    private let speakers = device("BuiltInSpeakerDevice", "bltn", input: 0, output: 2)
    private let usb = device("usb-mic", "usb ")
    private let thunderbolt = device("tb-interface", "thun")
    private let pci = device("pci-card", "pci ")
    private let bluetooth = device("airpods", "blue")
    private let bluetoothLE = device("le-headset", "blea")
    private let continuity = device("iphone", "ccwd")
    private let virtual = device("virtual", "virt")
    private let aggregate = device("aggregate", "grup")
    private let loopback = device("BlackHole2ch_UID", "usb ", name: "BlackHole 2ch")

    private var all: [CatalogDevice] { [builtIn, speakers, usb, thunderbolt, pci, bluetooth, bluetoothLE, continuity, virtual, aggregate, loopback] }

    @Test(arguments: ["BuiltInMicrophoneDevice", "usb-mic", "tb-interface", "pci-card"])
    func anAllowlistedDefaultIsUsed(uid: String) throws {
        let target = try #require(all.first { $0.uid == uid })
        let choice = try #require(MicrophonePolicy.decide(devices: all, defaultInput: target.id, pin: nil).choice)
        #expect(choice.device.uid == uid)
        #expect(choice.selection == .automaticDefault)
        #expect(choice.substitutedFor == nil)
    }

    @Test(arguments: ["airpods", "le-headset", "iphone", "virtual", "aggregate", "BlackHole2ch_UID"])
    func aRefusedDefaultFallsBackToTheBuiltInMicrophone(uid: String) throws {
        let target = try #require(all.first { $0.uid == uid })
        let choice = try #require(MicrophonePolicy.decide(devices: all, defaultInput: target.id, pin: nil).choice)
        #expect(choice.device.uid == "BuiltInMicrophoneDevice")
        #expect(choice.substitutedFor == uid)
    }

    @Test func withoutABuiltInMicrophoneARefusedDefaultMeansNone() {
        let devices = [bluetooth, continuity, speakers]
        let decision = MicrophonePolicy.decide(devices: devices, defaultInput: bluetooth.id, pin: nil)
        #expect(decision.choice == nil)
        #expect(decision == .none(reason: "The default input is not on the automatic allowlist."))
        #expect(MicrophonePolicy.decide(devices: [speakers], defaultInput: nil, pin: nil) == .none(reason: "No microphone is available."))
    }

    @Test func aConfiguredAllowlistCannotEnableBluetoothOrVirtualDevices() {
        let decision = MicrophonePolicy.decide(
            devices: [bluetooth, virtual], defaultInput: bluetooth.id, pin: nil, allowedTransports: [.bluetooth, .virtual, .builtIn]
        )
        #expect(decision.choice == nil)
    }

    @Test func aNarrowerAllowlistSkipsUSB() throws {
        let choice = try #require(MicrophonePolicy.decide(devices: all, defaultInput: usb.id, pin: nil, allowedTransports: [.builtIn]).choice)
        #expect(choice.device.uid == "BuiltInMicrophoneDevice")
    }

    @Test func aPinIsAHardOverride() throws {
        let pinned = try #require(MicrophonePolicy.decide(devices: all, defaultInput: builtIn.id, pin: InputPin(deviceUid: "usb-mic", allowBluetooth: false)).choice)
        #expect(pinned.device.uid == "usb-mic")
        #expect(pinned.selection == .pinned)
        // Even a virtual device opens when the user pins it.
        #expect(MicrophonePolicy.decide(devices: all, defaultInput: nil, pin: InputPin(deviceUid: "virtual", allowBluetooth: false)).choice?.device.uid == "virtual")
        // An absent pinned device means no microphone, never another one.
        let missing = MicrophonePolicy.decide(devices: all, defaultInput: builtIn.id, pin: InputPin(deviceUid: "gone", allowBluetooth: false))
        #expect(missing.choice == nil)
    }

    @Test func aPinnedBluetoothMicrophoneNeedsConsent() {
        #expect(MicrophonePolicy.decide(devices: all, defaultInput: nil, pin: InputPin(deviceUid: "airpods", allowBluetooth: false)).choice == nil)
        #expect(MicrophonePolicy.decide(devices: all, defaultInput: nil, pin: InputPin(deviceUid: "airpods", allowBluetooth: true)).choice?.device.uid == "airpods")
    }

    @Test func deadDevicesAndSondineAggregatesAreNeverChosen() {
        let dead = Self.device("dead-usb", "usb ", alive: false)
        let own = Self.device(DeviceCatalog.ownAggregatePrefix + "x", "bltn")
        #expect(MicrophonePolicy.decide(devices: [dead, own], defaultInput: dead.id, pin: nil).choice == nil)
    }

    @Test func callFollowValidatesTheDevice() {
        let follow = CallFollowCandidate(deviceUid: "airpods")
        #expect(MicrophonePolicy.decide(devices: all, defaultInput: builtIn.id, pin: nil, callFollow: follow).choice?.selection == .callFollow)
        let loopbackFollow = CallFollowCandidate(deviceUid: "BlackHole2ch_UID")
        #expect(MicrophonePolicy.decide(devices: all, defaultInput: builtIn.id, pin: nil, callFollow: loopbackFollow).choice?.device.uid == "BuiltInMicrophoneDevice")
    }

    @Test func transportCodesDecode() {
        #expect(Transport(code: fourCharCode("bltn")) == .builtIn)
        #expect(Transport(code: fourCharCode("usb ")) == .usb)
        #expect(Transport(code: fourCharCode("blea")) == .bluetoothLE)
        #expect(Transport(code: fourCharCode("ccwd")) == .continuity)
        #expect(Transport(code: fourCharCode("grup")) == .aggregate)
        #expect(Transport(code: 0) == .unknown)
        #expect(fourCharText(fourCharCode("usb ")) == "usb ")
    }
}
