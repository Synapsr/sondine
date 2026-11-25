import SwiftUI

/// Réglages (iphone-screens.md §8, U9), as the Mac's: rows with an icon, a
/// title and their state, a row opening its page. The Mac (screen 5); the
/// room recordings take while they wait; this version and when it expires;
/// « À propos »: what the app sends, and to whom.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: Theme.Space.l) {
                    RowGroup {
                        NavigationLink {
                            MacView()
                        } label: {
                            SettingsRow(symbol: "desktopcomputer", title: "Mac", value: macState)
                        }
                        .accessibilityIdentifier("settings-mac")
                        SettingsRow(
                            symbol: "tray.and.arrow.up", title: "Waiting for the Mac",
                            value: model.waitingBytes.formatted(.byteCount(style: .file)), opens: false)
                    }
                    RowGroup {
                        SettingsRow(symbol: "app.badge", title: "Version", value: model.build.headerVersion, opens: false)
                        SettingsRow(
                            symbol: "calendar", title: "Expires on",
                            value: model.build.expiresAt.formatted(date: .long, time: .omitted), opens: false)
                        .accessibilityIdentifier("expires")
                    }
                    RowGroup {
                        NavigationLink {
                            AboutView()
                        } label: {
                            SettingsRow(symbol: "lock", title: "Privacy and licence", value: nil)
                        }
                    }
                }
                .padding(Theme.Space.m)
            }
            .background(Theme.canvas)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var macState: String {
        guard let mac = model.syncStatus.mac else { return String(localized: "Not paired") }
        return model.syncStatus.reachable ? mac.name : String(localized: "\(mac.name) · not reachable")
    }
}

/// Rows together on a quiet surface, hairlines between them.
struct RowGroup<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) {
            Group(subviews: content) { rows in
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    if index > 0 {
                        Rectangle().fill(Theme.line).frame(height: 1).padding(.leading, 56)
                    }
                    row
                }
            }
        }
        .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.m))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.m).strokeBorder(Theme.line, lineWidth: 1))
        .buttonStyle(RowButtonStyle())
    }
}

/// A row: its icon, title, state, and a chevron when it opens a page.
struct SettingsRow: View {
    let symbol: String
    let title: LocalizedStringKey
    let value: String?
    var opens = true
    var valueColor = Theme.muted

    var body: some View {
        HStack(spacing: Theme.Space.s) {
            KindTile(symbol: symbol, size: 30)
            Text(title).font(Theme.Text.title).foregroundStyle(Theme.text)
            Spacer(minLength: Theme.Space.s)
            if let value {
                Text(value)
                    .font(Theme.Text.s)
                    .foregroundStyle(valueColor)
                    .lineLimit(1)
                    .multilineTextAlignment(.trailing)
            }
            if opens {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.faint)
            }
        }
        .padding(.horizontal, Theme.Space.s)
        .padding(.vertical, Theme.Space.s)
        .contentShape(.rect)
    }
}

/// What the app sends, where it keeps recordings, and its licence.
private struct AboutView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Space.m) {
                about("paperplane", "Once paired, Sondine talks only to your own Mac, over your Wi-Fi, or through Tailscale if you allow it on the Mac: your recordings, their names, tags, notes and deletions, and what you search. The Mac may have them transcribed by a server you chose there. In a TestFlight beta, Apple tells the developer about sessions and crashes.")
                about("lock", "Recordings are kept on this iPhone, outside its backups. Finished ones are readable only while it is unlocked.")
                about("chevron.left.forwardslash.chevron.right", "Sondine is free software under the GNU AGPL 3.0. This app uses no third-party code. Its typeface, Allo, is under the SIL Open Font License.")
                Text("A TestFlight build stops opening 90 days after it was sent. Installing the next one keeps every recording.")
                    .font(Theme.Text.s)
                    .foregroundStyle(Theme.muted)
                    .padding(.top, Theme.Space.s)
            }
            .padding(Theme.Space.l)
        }
        .background(Theme.canvas)
        .navigationTitle("Privacy and licence")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func about(_ symbol: String, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .top, spacing: Theme.Space.s) {
            KindTile(symbol: symbol, size: 30)
            Text(text).font(Theme.Text.m).foregroundStyle(Theme.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
        }
    }
}
