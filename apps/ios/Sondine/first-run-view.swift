import SwiftUI

/// Première ouverture (iphone-screens.md §1, U9), as the Mac's: the steps
/// as a bar across the top, each page centered and short, its lines rising
/// in turn, « Retour » on the left and the next step on the right. iOS asks
/// for the microphone on the last page, not before.
struct FirstRunView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var page = 0
    @State private var forward = true
    @State private var refused = false
    private let pages = 3

    var body: some View {
        VStack(spacing: 0) {
            StepsBar(count: pages, current: page)
                .padding(.top, Theme.Space.xs)
            Spacer()
            Group {
                switch page {
                case 0:
                    FirstRunPage(
                        symbol: "waveform",
                        title: "Sondine records when you ask",
                        text: "Lock the iPhone: it goes on. Your Mac transcribes.")
                case 1:
                    FirstRunPage(
                        symbol: "person.2.wave.2",
                        title: "Every voice nearby is recorded",
                        text: "Asking the people around you is up to you. Recordings leave the iPhone only for your Mac, or when you share them.")
                default:
                    FirstRunPage(
                        symbol: "mic",
                        title: "Allow the microphone",
                        text: refused
                            ? "The microphone is off for Sondine. Turn it on in Settings."
                            : "iOS asks now, and to notify you when a call interrupts a recording.",
                        warns: refused)
                }
            }
            .id(page)
            .transition(.asymmetric(
                insertion: .offset(x: forward ? 48 : -48).combined(with: .opacity),
                removal: .offset(x: forward ? -48 : 48).combined(with: .opacity)))
            Spacer()
            HStack(spacing: Theme.Space.s) {
                if page > 0 {
                    Button {
                        go(to: page - 1)
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(Theme.text)
                            .frame(width: 54, height: 54)
                            .background(Theme.surface, in: .circle)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("Back"))
                    .transition(.scale.combined(with: .opacity))
                }
                Button(action: next) {
                    Text(page < pages - 1 ? "Continue" : refused ? "Open Settings" : "Allow the microphone")
                        .contentTransition(.opacity)
                }
                .buttonStyle(PrimaryButtonStyle())
                .accessibilityIdentifier("first-run-next")
            }
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.bottom, Theme.Space.s)
        .background(Theme.canvas)
        .animation(Theme.Motion.large, value: page)
        .animation(Theme.Motion.small, value: refused)
        .sensoryFeedback(.selection, trigger: page)
    }

    private func go(to next: Int) {
        forward = next > page
        page = next
    }

    private func next() {
        if page < pages - 1 {
            go(to: page + 1)
        } else if refused, let settings = URL(string: UIApplication.openSettingsURLString) {
            openURL(settings)
        } else {
            Task {
                if await model.allowMicrophone() {
                    withAnimation(Theme.Motion.large) { model.firstRunDone = true }
                } else {
                    refused = true
                }
            }
        }
    }
}

/// The steps, as the Mac's: one segment each, ink up to the current one.
private struct StepsBar: View {
    let count: Int
    let current: Int

    var body: some View {
        HStack(spacing: Theme.Space.xxs) {
            ForEach(0..<count, id: \.self) { index in
                Capsule()
                    .fill(index <= current ? Theme.ink : Theme.line)
                    .frame(height: 3)
            }
        }
        .animation(Theme.Motion.large, value: current)
        .accessibilityElement()
        .accessibilityLabel(Text("Step \(current + 1) of \(count)"))
    }
}

/// A page: its symbol, title and one sentence, centered; they rise in turn.
private struct FirstRunPage: View {
    let symbol: String
    let title: LocalizedStringKey
    let text: LocalizedStringKey
    var warns = false
    @State private var shown = false

    var body: some View {
        VStack(spacing: Theme.Space.m) {
            KindTile(symbol: symbol, size: 72)
                .rise(shown, order: 0)
            Text(title)
                .font(Theme.Text.xl)
                .tracking(-0.64)
                .foregroundStyle(Theme.text)
                .rise(shown, order: 1)
            Text(text)
                .font(Theme.Text.m)
                .foregroundStyle(warns ? Theme.danger : Theme.muted)
                .contentTransition(.opacity)
                .rise(shown, order: 2)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: 340)
        .onAppear { shown = true }
    }
}

extension View {
    /// Rises a little and appears, after those before it (the Mac's stagger).
    func rise(_ shown: Bool, order: Int) -> some View {
        opacity(shown ? 1 : 0)
            .offset(y: shown ? 0 : 12)
            .blur(radius: shown ? 0 : 4)
            .animation(Theme.Motion.large.delay(0.06 * Double(order)), value: shown)
    }
}
