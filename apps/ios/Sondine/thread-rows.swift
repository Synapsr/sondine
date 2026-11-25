import SondinePhone
import SwiftUI

// The rows the phone shares with the Mac's Today (U9): a day's heading, a
// conversation's row (its hour, a tile, a title and one line under it), a
// journal line and a commitment, and the quiet line that says why nothing
// shows. No cards: rows on the canvas, as on the Mac.

/// « Aujourd'hui », « Hier », « lundi 17 novembre ».
enum DayWords {
    static func heading(_ day: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(day) { return String(localized: "Today") }
        if calendar.isDateInYesterday(day) { return String(localized: "Yesterday") }
        let sameYear = calendar.isDate(day, equalTo: .now, toGranularity: .year)
        let format = Date.FormatStyle.dateTime.weekday(.wide).day().month(.wide)
        return sameYear ? day.formatted(format) : day.formatted(format.year())
    }
}

/// A day's heading over its rows.
struct DayHeading: View {
    let day: Date

    var body: some View {
        SectionHeading(verbatim: DayWords.heading(day).capitalizedFirst)
            .padding(.top, Theme.Space.l)
            .padding(.bottom, Theme.Space.xxs)
    }
}

extension String {
    /// « lundi 17 novembre » → « Lundi 17 novembre ».
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}

/// A small square with a symbol, as the Mac's kind tile.
struct KindTile: View {
    let symbol: String
    var size: CGFloat = 32

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.44, weight: .medium))
            .foregroundStyle(Theme.text)
            .frame(width: size, height: size)
            .background(Theme.surface, in: .rect(cornerRadius: size * 0.28))
            .accessibilityHidden(true)
    }
}

/// A conversation's row: the hour, a tile, a title, and one line under it
/// (its journal line, or where it stands); something short at the end.
struct ThreadRow<Tile: View, Trailing: View>: View {
    let time: String
    let title: String
    let detail: String?
    var detailIsProblem = false
    @ViewBuilder let tile: Tile
    @ViewBuilder let trailing: Trailing

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.s) {
            Text(time)
                .font(Theme.Text.s.monospacedDigit())
                .foregroundStyle(Theme.muted)
                .frame(width: 44, alignment: .leading)
                .padding(.top, 7)
            tile
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(Theme.Text.title)
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                if let detail {
                    Text(detail)
                        .font(Theme.Text.s)
                        .foregroundStyle(detailIsProblem ? Theme.danger : Theme.muted)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, detail == nil ? 6 : 0)
            trailing
                .padding(.top, 7)
        }
        .padding(.vertical, Theme.Space.xs)
        .padding(.horizontal, Theme.Space.xs)
    }
}

/// A commitment: an empty circle, or a checked one with its text struck;
/// read only on the phone (marking done stays on the Mac).
struct CommitmentMark: View {
    let done: Bool
    var late = false

    var body: some View {
        ZStack {
            Circle()
                .strokeBorder(late ? Theme.danger : Theme.faint, lineWidth: 1.5)
                .opacity(done ? 0 : 1)
            Circle().fill(Theme.ink).opacity(done ? 1 : 0)
            Image(systemName: "checkmark")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(Theme.onInk)
                .opacity(done ? 1 : 0)
        }
        .frame(width: 18, height: 18)
        .accessibilityLabel(done ? Text("Done") : Text("Commitment"))
    }
}

/// A journal line: a short rule on its left, as the Mac's summary.
struct JournalLine: View {
    let text: String
    var meta: String?

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.s) {
            Capsule()
                .fill(Theme.line)
                .frame(width: 2)
                .padding(.vertical, 3)
            VStack(alignment: .leading, spacing: 2) {
                Text(text).font(Theme.Text.m).foregroundStyle(Theme.text)
                if let meta {
                    Text(meta).font(Theme.Text.xs.monospacedDigit()).foregroundStyle(Theme.muted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// A commitment's row: its mark, its text, when it was said and when it is due.
struct CommitmentLine: View {
    let text: String
    let done: Bool
    var late = false
    var meta: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
            CommitmentMark(done: done, late: late)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
            VStack(alignment: .leading, spacing: 2) {
                Text(text)
                    .font(Theme.Text.m)
                    .foregroundStyle(done ? Theme.muted : Theme.text)
                    .strikethrough(done, color: Theme.muted)
                if let meta {
                    Text(meta)
                        .font(Theme.Text.xs.monospacedDigit())
                        .foregroundStyle(late ? Theme.danger : Theme.muted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// A line saying why nothing shows, muted.
struct ProblemText: View {
    let text: String

    var body: some View {
        Text(text)
            .font(Theme.Text.s)
            .foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("memory-problem")
    }
}

/// A transcript's sentence: who and when, small, then what was said.
struct SentenceView: View {
    let speaker: String
    let startMs: Int64
    let text: String
    var marked = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xxs) {
            HStack(spacing: Theme.Space.xs) {
                Text(speaker).font(Theme.Text.heading).foregroundStyle(Theme.text)
                Text(Notices.clock(startMs)).font(Theme.Text.xs.monospacedDigit()).foregroundStyle(Theme.muted)
            }
            Text(text).font(Theme.Text.m).foregroundStyle(Theme.text)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, Theme.Space.xs)
        .padding(.horizontal, Theme.Space.xs)
        .background(marked ? Theme.surface : .clear, in: .rect(cornerRadius: Theme.Radius.s))
        .accessibilityElement(children: .combine)
    }
}
