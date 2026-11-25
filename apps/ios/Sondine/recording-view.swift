import SondinePhone
import SwiftUI

/// Enregistrement en cours (iphone-screens.md §3, U9): the elapsed time,
/// large; the level of the last seconds as moving bars, which freeze when an
/// interruption stops them; the microphone when it is not the phone's own;
/// « Arrêter », round, with no confirmation. No pause: stopping and starting
/// again makes the next file of the session, as an interruption does.
struct RecordingInProgressView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    /// The last levels heard, oldest first, one per update.
    @State private var levels: [Double] = Array(repeating: 0, count: LevelBars.count)

    var body: some View {
        VStack(spacing: 0) {
            header
            Spacer()
            switch model.snapshot.phase {
            case let .recording(state):
                clock(state.elapsedMs, live: true)
                LevelBars(levels: levels, live: true)
                    .padding(.top, Theme.Space.xl)
                details(state)
            case let .interrupted(state):
                clock(Int64(state.samples) * 1000 / Int64(phoneSampleRate), live: false)
                LevelBars(levels: levels, live: false)
                    .padding(.top, Theme.Space.xl)
                interrupted(state)
            case .idle:
                Text("Stopped").font(Theme.Text.l).foregroundStyle(Theme.muted)
            }
            Spacer()
            controls
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, Theme.Space.m)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.canvas)
        .animation(Theme.Motion.large, value: phaseKind)
        .onChange(of: model.snapshot.phase) { _, phase in
            if case let .recording(state) = phase {
                levels = Array((levels + [LevelBars.share(state.levelDbfs)]).suffix(LevelBars.count))
            }
            // Stopped by itself (no room, a write failed): back home, which says why.
            if phase == .idle { dismiss() }
        }
        .sensoryFeedback(.impact(weight: .medium), trigger: phaseKind)
    }

    /// Recording, interrupted or stopped: what the screen's motion follows.
    private var phaseKind: Int {
        switch model.snapshot.phase {
        case .recording: 0
        case .interrupted: 1
        case .idle: 2
        }
    }

    private var header: some View {
        HStack(spacing: Theme.Space.xs) {
            LiveDot(live: model.isRecording)
            Text(model.isRecording ? "Recording" : "Interrupted")
                .font(Theme.Text.heading)
                .foregroundStyle(model.isRecording ? Theme.text : Theme.muted)
                .contentTransition(.opacity)
        }
        .frame(maxWidth: .infinity)
    }

    private func clock(_ ms: Int64, live: Bool) -> some View {
        Text(Duration.milliseconds(ms).formatted(.time(pattern: .hourMinuteSecond)))
            .font(Theme.Text.clock)
            .tracking(-1.3)
            .foregroundStyle(live ? Theme.text : Theme.muted)
            .contentTransition(.numericText(countsDown: false))
            .animation(Theme.Motion.small, value: ms / 1000)
            .accessibilityIdentifier("elapsed")
    }

    @ViewBuilder
    private func details(_ state: PhoneRecorder.Recording) -> some View {
        VStack(spacing: Theme.Space.xs) {
            if state.route.kind != .builtIn, let name = state.route.name {
                Label(name, systemImage: state.route.kind == .bluetooth ? "airpods" : "headphones")
                    .font(Theme.Text.s)
                    .foregroundStyle(Theme.muted)
                    .padding(.horizontal, Theme.Space.s)
                    .padding(.vertical, Theme.Space.xxs)
                    .background(Theme.surface, in: .capsule)
            }
            if let free = state.lowSpaceBytes {
                Text("Only \(free.formatted(.byteCount(style: .file))) free")
                    .font(Theme.Text.s)
                    .foregroundStyle(Theme.danger)
            }
        }
        .padding(.top, Theme.Space.l)
    }

    private func interrupted(_ state: PhoneRecorder.Interrupted) -> some View {
        VStack(spacing: Theme.Space.xs) {
            Text(state.cause == .call
                ? String(localized: "Interrupted at \(Notices.clock(state.atMs)) by a call")
                : String(localized: "Interrupted at \(Notices.clock(state.atMs))"))
                .font(Theme.Text.title)
                .foregroundStyle(Theme.text)
            Text("What was recorded is kept.")
                .font(Theme.Text.s)
                .foregroundStyle(Theme.muted)
            if let refusal = model.refusal {
                Text(RefusalWords.text(refusal)).font(Theme.Text.s).foregroundStyle(Theme.danger)
            }
        }
        .multilineTextAlignment(.center)
        .padding(.top, Theme.Space.l)
        .transition(.blurReplace)
    }

    /// « Arrêter », round; after an interruption, « Reprendre » beside it.
    private var controls: some View {
        HStack(spacing: Theme.Space.l) {
            if model.interrupted != nil {
                Button {
                    Task { await model.resume() }
                } label: {
                    HStack(spacing: Theme.Space.xs) {
                        Circle().fill(Theme.danger).frame(width: 10, height: 10)
                        Text("Resume")
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .accessibilityIdentifier("resume")
                .transition(.move(edge: .leading).combined(with: .opacity))
            }
            Button {
                Task {
                    await model.stop()
                    dismiss()
                }
            } label: {
                StopMark()
            }
            .buttonStyle(StopButtonStyle())
            .accessibilityLabel(Text("Stop"))
            .accessibilityIdentifier("stop")
        }
        .padding(.bottom, Theme.Space.s)
    }
}

/// The red dot of a recording under way, breathing; grey when it stopped.
private struct LiveDot: View {
    let live: Bool
    @State private var breathes = false

    var body: some View {
        Circle()
            .fill(live ? Theme.danger : Theme.faint)
            .frame(width: 8, height: 8)
            .opacity(live && breathes ? 0.35 : 1)
            .animation(live ? .easeInOut(duration: 1).repeatForever(autoreverses: true) : .default, value: breathes)
            .onAppear { breathes = true }
            .accessibilityHidden(true)
    }
}

/// The last seconds' level as bars, newest on the right; frozen, they fade.
struct LevelBars: View {
    static let count = 44
    let levels: [Double]
    let live: Bool

    /// −60 dBFS and below is nothing, 0 dBFS everything.
    static func share(_ dbfs: Double) -> Double { max(0, min(1, (dbfs + 60) / 60)) }

    var body: some View {
        HStack(alignment: .center, spacing: 3) {
            ForEach(Array(levels.enumerated()), id: \.offset) { index, level in
                Capsule()
                    .fill(live ? Theme.ink : Theme.faint)
                    .frame(width: 3, height: 4 + 60 * level)
                    // Older bars recede.
                    .opacity(0.25 + 0.75 * Double(index + 1) / Double(levels.count))
            }
        }
        .frame(height: 64)
        .animation(.linear(duration: 0.1), value: levels)
        .animation(Theme.Motion.large, value: live)
        .accessibilityHidden(true)
    }
}

/// The stop button's face: a rounded square.
private struct StopMark: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 7)
            .fill(Theme.onInk)
            .frame(width: 26, height: 26)
    }
}

private struct StopButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(width: 76, height: 76)
            .background(Theme.ink, in: .circle)
            .overlay(Circle().strokeBorder(Theme.line, lineWidth: 4).padding(-7))
            .scaleEffect(configuration.isPressed ? 0.92 : 1)
            .animation(Theme.Motion.small, value: configuration.isPressed)
    }
}
