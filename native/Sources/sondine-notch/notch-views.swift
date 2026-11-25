import SondineNotch
import SwiftUI

// The notch as an island, black like the camera housing, in the menu bar's
// system font whatever the appearance. Compact: her initial, or the call
// app's icon, left of the notch; « ? » and a dot, full while Sondine listens,
// right of it. Peek: the island grows down by one line, « Marie ? ».
// Announce: a call that starts, with its switch, or a card (a call that
// ended, a forgotten pause), with its buttons. Open (the pointer resting on
// it, or a click when the user chose so): the call and its switch, its
// recording's buttons, her last conversations, the other people suggested,
// and what hides them. One shape morphs between the four; its content fades
// and scales in from the top (GUI.md's popup scale), at its final width, so
// the island uncovers it from the middle and nothing in it slides; Reduce
// Motion turns both off.

private let primary = Color.white.opacity(0.92)
private let secondary = Color.white.opacity(0.55)
private let monogramSize: CGFloat = 20

enum IslandState: Equatable {
    case compact, peek, announce, open
}

struct IslandView: View {
    let model: NotchModel
    let act: (NotchAction) -> Void

    var body: some View {
        let size = model.size
        ZStack(alignment: .top) {
            IslandShape(ear: NotchGeometry.ear, bottom: model.bottomRadius)
                .fill(.black)
                .frame(width: size.width + 2 * NotchGeometry.ear, height: size.height)
            if let show = model.show {
                content(show)
                    .frame(width: size.width, height: size.height, alignment: .top)
                    .clipShape(UnevenRoundedRectangle(bottomLeadingRadius: model.bottomRadius, bottomTrailingRadius: model.bottomRadius))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    @ViewBuilder
    private func content(_ show: NotchShow) -> some View {
        let first = show.people.first
        VStack(spacing: 0) {
            // The menu bar's band, the notch in its middle.
            HStack(spacing: 0) {
                Group {
                    if model.state == .compact || model.state == .peek {
                        if let first {
                            Monogram(text: first.monogram)
                                .transition(.opacity)
                        } else if let call = show.call {
                            AppGlyph(icon: call.icon, monogram: call.monogram, size: monogramSize)
                                .transition(.opacity)
                        }
                    }
                }
                .frame(width: NotchGeometry.wing)
                Color.clear.frame(width: model.notchWidth)
                Group {
                    if model.state == .compact {
                        HStack(spacing: 4) {
                            if first != nil {
                                Text(verbatim: "?")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(secondary)
                            }
                            if let call = show.call { ListeningDot(on: call.on) }
                        }
                        .transition(.opacity)
                    }
                }
                .frame(width: NotchGeometry.wing)
            }
            .frame(height: model.notchHeight)
            switch model.state {
            case .compact:
                EmptyView()
            case .peek:
                Text(first?.label ?? "")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.white)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.horizontal, NotchGeometry.peekPadding)
                    .frame(height: NotchGeometry.peekLine - 4, alignment: .center)
                    .transition(.appear)
            case .announce:
                AnnounceContent(show: show, act: act)
                    .frame(width: model.contentWidth)
                    .transition(.appear)
            case .open:
                OpenContent(show: show, act: act)
                    .frame(width: model.contentWidth)
                    .transition(.appear)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { if model.state != .open, show.card == nil { act(.open) } }
        .accessibilityElement(children: holdsControls ? .contain : .ignore)
        .accessibilityLabel(holdsControls ? "" : label(show))
        .accessibilityAddTraits(holdsControls ? [] : .isButton)
    }

    private var holdsControls: Bool { model.state == .open || model.state == .announce }

    private func label(_ show: NotchShow) -> String {
        [show.call.map { "\($0.title), \($0.detail)" }, show.people.first?.label]
            .compactMap { $0 }
            .joined(separator: ", ")
    }
}

/// Full while Sondine listens to the call, hollow while it does not.
struct ListeningDot: View {
    let on: Bool

    var body: some View {
        Circle()
            .strokeBorder(on ? Color.clear : secondary, lineWidth: 1.5)
            .background(Circle().fill(on ? Color.green : Color.clear))
            .frame(width: 7, height: 7)
    }
}

/// The app's icon, or its initial while main has none.
struct AppGlyph: View {
    let icon: Data?
    let monogram: String
    let size: CGFloat

    var body: some View {
        if let icon, let image = NSImage(data: icon) {
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .frame(width: size, height: size)
        } else {
            Text(monogram)
                .font(.system(size: size * 0.55, weight: .semibold))
                .foregroundStyle(Color.white)
                .frame(width: size, height: size)
                .background(RoundedRectangle(cornerRadius: size * 0.25).fill(Color.white.opacity(0.2)))
        }
    }
}

/// An app, two lines, and what sits at the end of them: the call's row, or a card's.
struct HeaderRow<Trailing: View>: View {
    let icon: Data?
    let monogram: String?
    let title: String
    let detail: String
    @ViewBuilder let trailing: Trailing

    var body: some View {
        HStack(spacing: 10) {
            if let monogram { AppGlyph(icon: icon, monogram: monogram, size: 26) }
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.white)
                Text(detail)
                    .font(.system(size: 11))
                    .foregroundStyle(secondary)
            }
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
            trailing
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
    }
}

/// The call going on, with its switch.
struct CallRow: View {
    let call: NotchCall
    let act: (NotchAction) -> Void

    var body: some View {
        HeaderRow(icon: call.icon, monogram: call.monogram, title: call.title, detail: call.detail) {
            // Drawn here: AppKit greys a switch in a window that is never key.
            Button { act(.toggle(!call.on)) } label: {
                Capsule()
                    .fill(call.on ? Color.green : Color.white.opacity(0.25))
                    .frame(width: 36, height: 21)
                    .overlay(alignment: call.on ? .trailing : .leading) {
                        Circle().fill(Color.white).padding(2)
                    }
                    .contentShape(Rectangle().inset(by: -8))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(call.toggle)
            .accessibilityValue(call.on ? "1" : "0")
            .accessibilityAddTraits(.isToggle)
        }
    }
}

/// Below the notch's band, unasked: the call that starts, or the card; also measured to size it.
struct AnnounceContent: View {
    let show: NotchShow
    let act: (NotchAction) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let call = show.call {
                CallRow(call: call, act: act)
            } else if let card = show.card {
                HeaderRow(icon: card.icon, monogram: card.monogram, title: card.title, detail: card.detail) {}
                if !card.actions.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(card.actions, id: \.kind) { action in
                            NotchButton(label: action.label) { act(.card(action)) }
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.bottom, 2)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 4)
        .padding(.bottom, 10)
    }
}

/// A button as wide as its share of the row.
struct NotchButton: View {
    let label: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.white)
                .lineLimit(1)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(hovering ? 0.22 : 0.14)))
        .onHover { hovering = $0 }
    }
}

/// Between the open island's groups.
struct NotchDivider: View {
    var body: some View {
        Rectangle()
            .fill(Color.white.opacity(0.12))
            .frame(height: 1)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
    }
}

/// The island: straight sides, rounded bottom corners, and concave ears
/// where it meets the top of the screen. `rect` includes the ears.
struct IslandShape: Shape {
    var ear: CGFloat
    var bottom: CGFloat

    var animatableData: CGFloat {
        get { bottom }
        set { bottom = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let left = rect.minX + ear
        let right = rect.maxX - ear
        let radius = min(bottom, (right - left) / 2, max(rect.height - ear, 0))
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addQuadCurve(to: CGPoint(x: left, y: rect.minY + ear), control: CGPoint(x: left, y: rect.minY))
        path.addLine(to: CGPoint(x: left, y: rect.maxY - radius))
        path.addQuadCurve(to: CGPoint(x: left + radius, y: rect.maxY), control: CGPoint(x: left, y: rect.maxY))
        path.addLine(to: CGPoint(x: right - radius, y: rect.maxY))
        path.addQuadCurve(to: CGPoint(x: right, y: rect.maxY - radius), control: CGPoint(x: right, y: rect.maxY))
        path.addLine(to: CGPoint(x: right, y: rect.minY + ear))
        path.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY), control: CGPoint(x: right, y: rect.minY))
        path.closeSubpath()
        return path
    }
}

struct Monogram: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Color.white)
            .frame(width: monogramSize, height: monogramSize)
            .background(Circle().fill(Color.white.opacity(0.2)))
    }
}

/// The open island's rows, below the notch's band; also measured to size it.
struct OpenContent: View {
    let show: NotchShow
    let act: (NotchAction) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let call = show.call {
                CallRow(call: call, act: act)
                if let episode = call.episode {
                    HStack(spacing: 6) {
                        NotchButton(label: episode.open) { act(.openEpisode(episode.episodeId)) }
                        NotchButton(label: episode.end) { act(.endEpisode(episode.episodeId)) }
                    }
                    .padding(.horizontal, 8)
                    .padding(.top, 4)
                    .padding(.bottom, 2)
                }
                if !show.people.isEmpty { NotchDivider() }
            }
            ForEach(Array(show.people.enumerated()), id: \.element.personId) { index, person in
                NotchRow(action: { act(.openPerson(person.personId)) }) {
                    HStack(spacing: 8) {
                        Monogram(text: person.monogram)
                        Text(person.label)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.white)
                            .lineLimit(1)
                    }
                }
                .padding(.top, index == 0 ? 0 : 6)
                if let none = person.none {
                    Text(none)
                        .font(.system(size: 12))
                        .foregroundStyle(secondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                }
                ForEach(person.conversations, id: \.episodeId) { conversation in
                    NotchRow(action: { act(.openEpisode(conversation.episodeId)) }) {
                        HStack(spacing: 6) {
                            Text(conversation.when)
                                .foregroundStyle(secondary)
                                .fixedSize()
                            if let words = conversation.words {
                                Text(words)
                                    .foregroundStyle(primary)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                            }
                        }
                        .font(.system(size: 12))
                    }
                }
            }
            NotchDivider()
            if let dismiss = show.dismiss {
                quiet(dismiss.label) { act(.dismiss(dismiss.callId)) }
            }
            if let call = show.call {
                quiet(call.mute) { act(.mute) }
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 4)
        .padding(.bottom, 10)
    }

    private func quiet(_ label: String, action: @escaping () -> Void) -> some View {
        NotchRow(action: action) {
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(secondary)
        }
    }
}

/// A row of the open island: the whole width clicks, and lights up under the pointer.
struct NotchRow<Label: View>: View {
    let action: () -> Void
    @ViewBuilder let label: Label
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            label
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(hovering ? 0.1 : 0)))
        .onHover { hovering = $0 }
    }
}

extension AnyTransition {
    /// Fades in growing from the top, as the app's popups do (GUI.md: scale 0.96).
    static var appear: AnyTransition {
        .opacity.combined(with: .scale(scale: 0.96, anchor: .top))
    }
}
