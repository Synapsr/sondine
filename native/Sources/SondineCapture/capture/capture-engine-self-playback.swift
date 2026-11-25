import Foundation
import SondineKit

// Sondine's own sound (ADR 035). Sondine's processes stay out of every track (ADR 026), but
// on the speakers the microphone hears what Sondine plays back. While they run output, and
// while the microphone listens, one private tap on them feeds the `self:playback` reference:
// 10 ms energy frames sent to core as `self.envelope`, never a run, a spool file or a region.
// Core compares them with the microphone to tell echo of a playback from someone speaking.
extension CaptureEngine {
    final class SelfPlaybackCapture: TapCapture {
        var objects: [HALObjectID]
        let reference: SelfPlaybackReference

        init(objects: [HALObjectID], reference: SelfPlaybackReference) {
            self.objects = objects
            self.reference = reference
            super.init(stream: reference)
        }
    }

    static let selfPlaybackName = "Sondine self:playback"
    /// After Sondine's output stops, the tap waits this long before it stops (a pause, a seek).
    static let selfPlaybackHoldNs: UInt64 = 2_000_000_000
    static let selfPlaybackRetryNs: UInt64 = 5_000_000_000

    /// Sondine's own process objects, when the reference may run: the microphone listens and
    /// system audio may be tapped (the user's switch, pause, private zones and permission).
    /// Empty when none of them plays.
    private func selfPlaybackScope() -> [HALObjectID]? {
        guard options.selfPlayback, let config, captureAllowed, config.systemAudio.enabled, !systemBlocked,
              !microphoneBlocked, mic != nil, !micMuted, !permissions.systemAudio.status.blocksCapture,
              let processes else { return nil }
        let own = processes.processes.filter { exclusion(for: $0) == .own }
        guard own.contains(where: \.io.runningOutput) else { return [] }
        return own.map(\.id).sorted()
    }

    /// Starts, follows or stops the reference tap. Runs at every process change and every drain.
    func reconcileSelfPlayback(now: UInt64) {
        guard let scope = selfPlaybackScope() else {
            stopSelfPlayback()
            return
        }
        if scope.isEmpty {
            guard selfPlayback != nil else { return }
            let since = selfIdleSinceNs ?? now
            selfIdleSinceNs = since
            if now &- since >= Self.selfPlaybackHoldNs { stopSelfPlayback() }
            return
        }
        selfIdleSinceNs = nil
        if let capture = selfPlayback {
            guard capture.objects != scope else { return }
            capture.objects = scope
            do {
                try hal.updateProcessTap(capture.tap, selfPlaybackDescription(capture))
            } catch {
                // A new audio service: the reference starts again on a new tap.
                stopSelfPlayback()
                startSelfPlayback(scope, now: now)
            }
            return
        }
        if let retry = selfRetryAtNs, now < retry { return }
        startSelfPlayback(scope, now: now)
    }

    private func selfPlaybackDescription(_ capture: SelfPlaybackCapture) -> TapDescription {
        TapDescription(scope: .processes(capture.objects), name: Self.selfPlaybackName, uuid: capture.tapUUID)
    }

    private func startSelfPlayback(_ objects: [HALObjectID], now: UInt64) {
        // The aggregate's rate is only known once it exists; the reference follows it.
        let context = IOCaptureContext(rate: 48_000, ringSeconds: options.ringSeconds, timebase: env.clock.timebase)
        let reference = SelfPlaybackReference(nominalRate: 48_000, context: context, clock: env.clock)
        let capture = SelfPlaybackCapture(objects: objects, reference: reference)
        capture.requestedNs = now
        do {
            try buildTap(capture, description: selfPlaybackDescription(capture), aggregateName: "Sondine own playback")
        } catch {
            destroyTap(capture)
            selfRetryAtNs = now + Self.selfPlaybackRetryNs
            emit(.warning("tap.self-failed", "Cannot tap Sondine's own playback: \(error)."))
            return
        }
        selfRetryAtNs = nil
        selfPlayback = capture
    }

    /// Ends the reference: what it drained is sent, and nothing of it stays. With `cutNs` (a hold
    /// starts, ADR 029), nothing played after it is sent.
    func stopSelfPlayback(objectsGone: Bool = false, cutNs: UInt64? = nil) {
        selfIdleSinceNs = nil
        guard let capture = selfPlayback else { return }
        selfPlayback = nil
        if let proc = capture.ioProc { hal.stopIO(proc) }
        for event in capture.reference.drain(cutNs: cutNs) { emit(event) }
        if let event = capture.reference.flush(cutNs: cutNs) { emit(event) }
        destroyTap(capture, objectsGone: objectsGone)
    }

    func drainSelfPlayback() {
        guard let capture = selfPlayback else { return }
        for event in capture.reference.drain() { emit(event) }
    }
}
