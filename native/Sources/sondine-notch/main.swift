import AppKit
import SondineNotch

// sondine-notch: the island beside the notch (ADR 025, ADR 036).
//
// Main starts it while a call goes on, or for a card, and writes one `show`
// line per change on stdin (packages/protocol/src/notch-messages.ts);
// it writes what the user clicked on stdout. It reads no file, keeps nothing,
// and exits when stdin closes, so it never outlives main. Without a screen
// with a notch it says `no-notch` and exits.

// A closed stdout is handled where it is written.
signal(SIGPIPE, SIG_IGN)

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = NotchController()
readLines(
    from: .standardInput,
    maxLength: NotchLimits.lineMax,
    onLine: { line in DispatchQueue.main.async { MainActor.assumeIsolated { controller.receive(line) } } },
    onTooLong: { warn("line-too-long") },
    onEnd: { DispatchQueue.main.async { MainActor.assumeIsolated { controller.end() } } }
)
app.run()
