import SondinePhone
import SwiftUI

/// Mac (iphone-screens.md §5, M5.2). Not paired: what pairing is, why iOS
/// will ask for the local network (before it asks), the QR scan, the six
/// digits to compare, the Mac's answer. Paired: the Mac's name, whether it
/// answers and, from M5.5, whether at home or through Tailscale, the last
/// sync, what waits, « Synchroniser maintenant » and « Oublier ce Mac… ».
struct MacView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let mac = model.syncStatus.mac {
                PairedMacView(mac: mac)
            } else {
                PairingView()
            }
        }
        .navigationTitle("Mac")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct PairedMacView: View {
    @Environment(AppModel.self) private var model
    let mac: PairedMac
    @State private var confirmsForget = false
    @State private var forgetting = false

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Space.l) {
                VStack(spacing: Theme.Space.xs) {
                    KindTile(symbol: "desktopcomputer", size: 64)
                        .overlay(alignment: .bottomTrailing) {
                            Circle()
                                .fill(model.syncStatus.reachable ? Theme.success : Theme.faint)
                                .frame(width: 14, height: 14)
                                .overlay(Circle().strokeBorder(Theme.canvas, lineWidth: 3))
                                .offset(x: 4, y: 4)
                        }
                    Text(mac.name).font(Theme.Text.l).foregroundStyle(Theme.text)
                    Text(reachability)
                        .font(Theme.Text.s)
                        .foregroundStyle(Theme.muted)
                        .accessibilityIdentifier("mac-reachability")
                }
                .padding(.top, Theme.Space.s)
                if let problem = model.syncStatus.problem {
                    Text(MacWords.problem(problem))
                        .font(Theme.Text.s)
                        .foregroundStyle(Theme.danger)
                        .multilineTextAlignment(.center)
                }
                RowGroup {
                    if model.syncStatus.reachable, let path = model.syncStatus.path {
                        SettingsRow(
                            symbol: path == .tailnet ? "network" : "house", title: "Path",
                            value: path == .tailnet ? String(localized: "Through Tailscale") : String(localized: "At home"),
                            opens: false)
                        .accessibilityIdentifier("mac-path")
                    }
                    SettingsRow(
                        symbol: "arrow.triangle.2.circlepath", title: "Last sync",
                        value: mac.lastSyncMs.map(Self.when) ?? String(localized: "Never"), opens: false)
                    SettingsRow(symbol: "tray.and.arrow.up", title: "Waiting", value: waiting, opens: false)
                }
                Button {
                    model.syncNow()
                } label: {
                    Label(model.syncStatus.syncing ? "Syncing…" : "Sync now", systemImage: "arrow.triangle.2.circlepath")
                        .symbolEffect(.rotate, isActive: model.syncStatus.syncing)
                }
                .buttonStyle(SecondaryButtonStyle())
                .disabled(model.syncStatus.syncing)
                Button(role: .destructive) {
                    confirmsForget = true
                } label: {
                    Text("Forget this Mac…").font(Theme.Text.s).foregroundStyle(Theme.danger)
                }
                .disabled(forgetting)
            }
            .padding(Theme.Space.m)
        }
        .background(Theme.canvas)
        .confirmationDialog("Forget this Mac?", isPresented: $confirmsForget, titleVisibility: .visible) {
            Button("Forget", role: .destructive) {
                forgetting = true
                Task {
                    _ = await model.forgetMac()
                    forgetting = false
                }
            }
        } message: {
            Text("The iPhone stops syncing with it and erases its access, the results it fetched, and the deletions, names and notes not yet sent. Recordings not sent stay on the iPhone.")
        }
    }

    private var reachability: String {
        if model.syncStatus.reachable { return String(localized: "Reachable") }
        guard let seen = mac.lastSeenMs else { return String(localized: "Not seen yet") }
        return String(localized: "Last seen \(Self.when(seen))")
    }

    private var waiting: String {
        let count = model.waiting.count
        guard count > 0 else { return String(localized: "Nothing waits") }
        let size = model.waitingBytes.formatted(.byteCount(style: .file))
        return String(localized: "\(count) recordings · \(size)")
    }

    static func when(_ ms: Int64) -> String {
        Date(milliseconds: ms).formatted(.relative(presentation: .named))
    }
}

/// The steps before a pairing, one at a time.
private struct PairingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @AppStorage("localNetworkExplained") private var localNetworkExplained = false

    private enum Step: Equatable {
        case start
        case localNetwork
        case scanning
        case waiting(PairingInvite)
        case failed(String)
    }

    @State private var step = Step.start
    @State private var scanProblem: String?
    @State private var pairing: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.l) {
            switch step {
            case .start:
                if let lost = model.syncStatus.revokedBy {
                    VStack(alignment: .leading, spacing: Theme.Space.xs) {
                        Text("This Mac removed this phone's access").font(Theme.Text.m.weight(.semibold))
                        Text(lost.name).font(Theme.Text.s).foregroundStyle(Theme.muted)
                        Text("The results fetched were erased. Recordings not sent stay on the iPhone; pair again to send them.")
                            .font(Theme.Text.s)
                    }
                    .foregroundStyle(Theme.danger)
                    .accessibilityIdentifier("mac-revoked")
                }
                page(
                    symbol: "desktopcomputer",
                    title: "Pair this iPhone with your Mac",
                    text: "Once paired, your recordings go to your Mac by themselves when the app is open at home, on the same Wi-Fi. The Mac transcribes them, then the iPhone erases their audio.")
                Text("On the Mac: Settings ▸ Phone ▸ Pair an iPhone…")
                    .font(Theme.Text.s)
                    .foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity)
                Spacer()
                Button {
                    step = localNetworkExplained ? .scanning : .localNetwork
                } label: {
                    Text("Scan the code")
                }
                .buttonStyle(PrimaryButtonStyle())
                .accessibilityIdentifier("pair-scan")
            case .localNetwork:
                page(
                    symbol: "wifi",
                    title: "iOS will ask for the local network",
                    text: "Sondine looks for your Mac on your Wi-Fi, and talks to it alone. Tap Allow when iOS asks.")
                Spacer()
                Button {
                    localNetworkExplained = true
                    step = .scanning
                    // The first Bonjour search is what makes iOS ask, now that it is explained.
                    let finder = model.finder
                    if let network = finder as? NetworkMacFinder { Task { await network.askForLocalNetwork() } }
                } label: {
                    Text("Continue")
                }
                .buttonStyle(PrimaryButtonStyle())
            case .scanning:
                Text("Point the camera at the code on the Mac.").font(Theme.Text.m)
                QRScannerView { text in scanned(text) } failed: { problem in
                    scanProblem = problem == .denied
                        ? String(localized: "The camera is off for Sondine. Turn it on in Settings to scan the code.")
                        : String(localized: "No camera on this device.")
                }
                .clipShape(.rect(cornerRadius: Theme.Radius.m))
                .frame(maxHeight: 360)
                if let scanProblem {
                    Text(scanProblem).font(Theme.Text.s).foregroundStyle(Theme.danger)
                }
                Spacer()
                Button("Cancel") { step = .start }
                    .buttonStyle(SecondaryButtonStyle())
            case let .waiting(invite):
                Text("Check that the Mac shows the same digits").font(Theme.Text.l)
                Text(spaced(model.pairingDigits(invite)))
                    .font(Theme.Text.clock)
                    .frame(maxWidth: .infinity)
                    .accessibilityIdentifier("pair-digits")
                HStack(spacing: Theme.Space.xs) {
                    ProgressView()
                    Text("Waiting for confirmation on the Mac…").font(Theme.Text.s).foregroundStyle(Theme.muted)
                }
                Spacer()
                Button("Cancel") {
                    pairing?.cancel()
                    step = .start
                }
                .buttonStyle(SecondaryButtonStyle())
            case let .failed(reason):
                Text(reason).font(Theme.Text.m).foregroundStyle(Theme.danger)
                Spacer()
                Button {
                    step = .scanning
                } label: {
                    Text("Try again")
                }
                .buttonStyle(PrimaryButtonStyle())
            }
        }
        .padding(Theme.Space.l)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.canvas)
        .onDisappear { pairing?.cancel() }
    }

    private func scanned(_ text: String) {
        guard step == .scanning else { return }
        switch PairingInvite.scan(text) {
        case let .invite(invite):
            step = .waiting(invite)
            pairing = Task {
                let failure = await model.pair(invite)
                guard !Task.isCancelled else { return }
                if let failure { step = .failed(MacWords.pairing(failure)) }
            }
        case let .version(version):
            step = .failed(MacWords.version(mac: version, phone: PhoneSync.version))
        case .notAnInvite:
            scanProblem = String(localized: "This is not a Sondine pairing code.")
        }
    }

    /// « 215 764 »: easier to compare.
    private func spaced(_ digits: String) -> String { "\(digits.prefix(3)) \(digits.suffix(3))" }

    private func page(symbol: String, title: LocalizedStringKey, text: LocalizedStringKey) -> some View {
        VStack(spacing: Theme.Space.m) {
            KindTile(symbol: symbol, size: 64)
            Text(title).font(Theme.Text.l).foregroundStyle(Theme.text)
            Text(text).font(Theme.Text.m).foregroundStyle(Theme.muted)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.top, Theme.Space.xl)
    }
}

/// The small Mac mark on the home screen: reachable or not; opens « Mac ».
struct MacMark: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Image(systemName: "desktopcomputer")
            .foregroundStyle(Theme.text)
            .overlay(alignment: .bottomTrailing) {
                if model.isPaired {
                    Circle()
                        .fill(model.syncStatus.reachable ? Theme.success : Theme.faint)
                        .frame(width: 7, height: 7)
                        .offset(x: 3, y: 2)
                }
            }
            .accessibilityLabel(Text(label))
    }

    private var label: String {
        guard model.isPaired else { return String(localized: "Mac: not paired") }
        return model.syncStatus.reachable ? String(localized: "Mac: reachable") : String(localized: "Mac: not reachable")
    }
}

/// The words for pairing and sync problems.
enum MacWords {
    static func pairing(_ failure: PhoneSyncClient.PairingFailure) -> String {
        switch failure {
        case .unreachable:
            String(localized: "The Mac did not answer. Check that the iPhone is on the same Wi-Fi as the Mac and that Sondine may use the local network (Settings ▸ Sondine).")
        case .refused: String(localized: "Pairing was refused on the Mac.")
        case .expired: String(localized: "This code was already used or has expired. Show a new one on the Mac.")
        case let .version(mac, phone): version(mac: mac, phone: phone)
        case .tailnet: String(localized: "Pair at home, on the same Wi-Fi as the Mac.")
        case .busy: String(localized: "The Mac is busy. Try again in a minute.")
        case .failed: String(localized: "Pairing did not finish. Try again with a new code.")
        }
    }

    /// Which app to update, with both versions.
    static func version(mac: Int, phone: Int) -> String {
        mac > phone
            ? String(localized: "Update Sondine on the iPhone (Mac: version \(mac), iPhone: version \(phone)).")
            : String(localized: "Update Sondine on the Mac (Mac: version \(mac), iPhone: version \(phone)).")
    }

    static func problem(_ problem: PhoneSyncClient.Problem) -> String {
        switch problem {
        case let .version(mac, phone): version(mac: mac, phone: phone)
        case .macFull: String(localized: "The Mac has no room left for the next recording. It stays on the iPhone.")
        case .busy: String(localized: "The Mac is busy. Sondine tries again soon.")
        }
    }
}
