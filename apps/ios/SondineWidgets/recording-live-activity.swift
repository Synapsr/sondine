import ActivityKit
import SwiftUI
import WidgetKit

/// The recording on the Lock Screen and in the Dynamic Island
/// (iphone-screens.md, « Live Activity »): the elapsed time, « Arrêter », and
/// after an interruption the hour it stopped with « Reprendre ».
struct RecordingLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RecordingActivityAttributes.self) { context in
            LockScreenRecording(state: context.state, isStale: context.isStale)
                .padding(Theme.Space.m)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    RecordingMark(interrupted: context.state.interruptedAt != nil)
                        .font(Theme.Text.l)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Elapsed(state: context.state)
                        .font(Theme.Text.l)
                        .frame(maxWidth: 120, alignment: .trailing)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        Status(state: context.state, isStale: context.isStale)
                        Spacer()
                        Actions(state: context.state)
                    }
                }
            } compactLeading: {
                RecordingMark(interrupted: context.state.interruptedAt != nil)
            } compactTrailing: {
                Elapsed(state: context.state)
                    .frame(maxWidth: 56)
            } minimal: {
                RecordingMark(interrupted: context.state.interruptedAt != nil)
            }
        }
    }
}

private struct LockScreenRecording: View {
    let state: RecordingActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        HStack(alignment: .center, spacing: Theme.Space.m) {
            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                Label {
                    Text(verbatim: "Sondine")
                } icon: {
                    RecordingMark(interrupted: state.interruptedAt != nil)
                }
                .font(Theme.Text.s.weight(.semibold))
                Elapsed(state: state)
                    .font(Theme.Text.xl)
                Status(state: state, isStale: isStale)
            }
            Spacer(minLength: 0)
            Actions(state: state)
        }
    }
}

/// The counter iOS draws from `countsFrom`, stopped at an interruption.
private struct Elapsed: View {
    let state: RecordingActivityAttributes.ContentState

    var body: some View {
        Group {
            if let stoppedAt = state.interruptedAt {
                Text(timerInterval: state.countsFrom...max(state.countsFrom, stoppedAt), pauseTime: stoppedAt, countsDown: false)
            } else {
                Text(timerInterval: state.countsFrom...state.countsFrom.addingTimeInterval(24 * 3_600), countsDown: false)
            }
        }
        .monospacedDigit()
        .multilineTextAlignment(.trailing)
    }
}

private struct RecordingMark: View {
    let interrupted: Bool

    var body: some View {
        Image(systemName: interrupted ? "pause.circle.fill" : "record.circle")
            .foregroundStyle(interrupted ? Theme.muted : Theme.danger)
    }
}

/// One line under the counter, when there is something to say.
private struct Status: View {
    let state: RecordingActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        if isStale, state.interruptedAt == nil {
            // No update for 5 minutes while recording: the app was closed, and nothing records.
            Text("Sondine no longer answers. Open it to see whether it records.")
                .font(Theme.Text.xs)
                .foregroundStyle(Theme.danger)
        } else if let at = state.interruptedAt {
            let time = at.formatted(date: .omitted, time: .shortened)
            Text(state.byCall ? "Interrupted at \(time) by a call" : "Interrupted at \(time)")
                .font(Theme.Text.xs)
                .foregroundStyle(Theme.muted)
        }
    }
}

/// « Arrêter », and « Reprendre » after an interruption: both run in the app.
private struct Actions: View {
    let state: RecordingActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: Theme.Space.xs) {
            if state.interruptedAt != nil {
                Button(intent: SetRecordingIntent(recording: true)) {
                    Label("Resume", systemImage: "record.circle")
                }
                .tint(Theme.ink)
            }
            Button(intent: SetRecordingIntent(recording: false)) {
                Label("Stop", systemImage: "stop.fill")
            }
            .tint(state.interruptedAt == nil ? Theme.ink : Theme.muted)
        }
        .buttonStyle(.borderedProminent)
        .labelStyle(.iconOnly)
        .font(Theme.Text.m.weight(.semibold))
    }
}
