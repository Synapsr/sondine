import Foundation
import Testing
@testable import SondineCapture

/// Opt-in check against the real Core Audio HAL: `SONDINE_REAL_HAL=1 swift test --filter RealHAL`.
/// It only reads devices and process objects. No IOProc is created, no IO starts, no tap or
/// aggregate is made and no permission is requested, so no prompt can appear.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["SONDINE_REAL_HAL"] == "1", "set SONDINE_REAL_HAL=1"))
struct RealHALEnumerationTests {
    @Test func enumeratesDevicesAndProcesses() throws {
        let hal = CoreAudioHardware()
        let devices = try hal.deviceIDs().compactMap { try? hal.deviceInfo($0) }
        #expect(!devices.isEmpty)
        let defaultInput = try hal.defaultDevice(.input)
        let defaultOutput = try hal.defaultDevice(.output)
        print("real HAL: \(devices.count) devices")
        for device in devices {
            let marks = [device.id == defaultInput ? "default-in" : nil, device.id == defaultOutput ? "default-out" : nil].compactMap { $0 }
            print("  device \(Transport(code: device.transportCode).rawValue) in=\(device.inputChannels) out=\(device.outputChannels) rate=\(device.nominalRate ?? 0) \(device.name) \(marks.joined(separator: " "))")
        }

        let resolver = ProcessResolver(introspection: DarwinProcessIntrospection())
        let processes = try hal.processObjectIDs().compactMap { id -> (HALProcessInfo, HALProcessIO, ProcessResolution)? in
            guard let info = try? hal.processInfo(id) else { return nil }
            return (info, (try? hal.processIO(id)) ?? HALProcessIO(), resolver.resolve(pid: info.pid, halBundleID: info.bundleID))
        }
        #expect(!processes.isEmpty)
        var evidence: [String: Int] = [:]
        var apps: Set<String> = []
        for (_, io, resolution) in processes {
            evidence[resolution.evidence?.rawValue ?? "unresolved", default: 0] += 1
            if let app = resolution.app {
                apps.insert((app.name ?? app.bundleId) + (io.runningOutput ? " (output)" : "") + (io.runningInput ? " (input)" : ""))
            }
        }
        print("real HAL: \(processes.count) process objects; evidence \(evidence.sorted { $0.key < $1.key })")
        print("real HAL apps: \(apps.sorted().joined(separator: ", "))")
        #expect(try hal.userSessionIsActive())
    }
}
