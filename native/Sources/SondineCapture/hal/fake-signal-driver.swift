import Darwin
import Dispatch

/// Drives `sondine-audio serve --hal fake` so the spool, the energy gate, VAD and health run end
/// to end without hardware or permission prompts. Every tick, each started IOProc of the fake
/// HAL gets the frames due since the last one at its device's nominal rate, stamped with ideal
/// host times. The signal is quiet noise (about -50 dBFS) with a -20 dBFS tone one second in four.
public final class FakeSignalDriver: @unchecked Sendable {
    private let hal: FakeAudioHardware
    private let queue = DispatchQueue(label: "app.sondine.audio.fake-signal", qos: .userInitiated)
    private let ticksPerSecond: Double
    // Confined to `queue`.
    private var timer: DispatchSourceTimer?
    private var origin: UInt64 = 0
    private var sent: [HALObjectID: Int64] = [:]
    private var noise: UInt64 = 0x9E37_79B9_7F4A_7C15

    public init(hal: FakeAudioHardware) {
        self.hal = hal
        var timebase = mach_timebase_info_data_t()
        mach_timebase_info(&timebase)
        ticksPerSecond = 1e9 * Double(timebase.denom) / Double(timebase.numer)
    }

    public func start(intervalMs: Int = 20) {
        queue.sync {
            guard timer == nil else { return }
            origin = mach_absolute_time()
            let source = DispatchSource.makeTimerSource(queue: queue)
            source.schedule(deadline: .now(), repeating: .milliseconds(intervalMs), leeway: .milliseconds(5))
            source.setEventHandler { [weak self] in self?.tick() }
            source.resume()
            timer = source
        }
    }

    public func stop() {
        queue.sync {
            timer?.cancel()
            timer = nil
        }
    }

    private func tick() {
        let elapsed = Double(mach_absolute_time() &- origin) / ticksPerSecond
        let inputs = hal.startedInputs()
        // An IOProc that stopped starts again at the current time.
        sent = sent.filter { device, _ in inputs.contains { $0.device == device } }
        for input in inputs {
            let due = Int64(elapsed * input.rate)
            var start = sent[input.device] ?? due - Int64(input.rate / 50)
            // More than a second behind (the process was suspended): skip ahead, as hardware would.
            if due - start > Int64(input.rate) { start = due - Int64(input.rate / 50) }
            let count = Int(due - start)
            guard count > 0, start >= 0 else { continue }
            let hostTicks = origin &+ UInt64(Double(start) / input.rate * ticksPerSecond)
            hal.deliver(toObject: input.device, samples: signal(from: start, count: count, rate: input.rate, channels: input.channels), channels: input.channels, hostTicks: hostTicks)
            sent[input.device] = start + Int64(count)
        }
    }

    private func signal(from start: Int64, count: Int, rate: Double, channels: Int) -> [Float] {
        var samples = [Float](repeating: 0, count: count * channels)
        for frame in 0..<count {
            let seconds = Double(start + Int64(frame)) / rate
            noise ^= noise << 13
            noise ^= noise >> 7
            noise ^= noise << 17
            var value = Float(Int64(bitPattern: noise >> 11) - (1 << 52)) / Float(1 << 52) * 0.003
            if seconds.truncatingRemainder(dividingBy: 4) < 1 { value += Float(sin(2 * Double.pi * 220 * seconds)) * 0.1 }
            for channel in 0..<channels { samples[frame * channels + channel] = value }
        }
        return samples
    }
}
