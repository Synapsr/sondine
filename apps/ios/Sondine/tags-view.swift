import SondinePhone
import SwiftUI

// A recording's tags on the iPhone (ADR 039): under its title on its page,
// and in one line under a recording just stopped on Home, one tap each. A
// tag waits in the outbox until the Mac applies it; what shows is the Mac's,
// with what waits on top. And « Moi ? »: a voice Sondine took for the user,
// confirmed in one tap.

/// Lays its children out in lines, wrapping like text.
struct FlowLayout: Layout {
    var spacing: CGFloat = Theme.Space.xs

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                y += line + spacing
                x = 0
                line = 0
            }
            x += size.width + spacing
            line = max(line, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                y += line + spacing
                x = bounds.minX
                line = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}

/// One tag as a capsule: ink when on, a hairline when off.
struct TagChip: View {
    let tag: String
    var on = true

    var body: some View {
        Text("# \(tag)")
            .font(Theme.Text.s)
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: 220)
            .foregroundStyle(on ? Theme.onInk : Theme.text)
            .padding(.horizontal, Theme.Space.s)
            .padding(.vertical, Theme.Space.xs)
            .background(Capsule().fill(on ? Theme.ink : Color.clear))
            .overlay(Capsule().strokeBorder(on ? Color.clear : Theme.line))
    }
}

/// « + », or the tag mark when there is no tag yet.
private struct AddTagMark: View {
    var empty = false

    var body: some View {
        Image(systemName: empty ? "tag" : "plus")
            .font(Theme.Text.s)
            .foregroundStyle(Theme.muted)
            .padding(.horizontal, Theme.Space.s)
            .padding(.vertical, Theme.Space.xs)
            .overlay(Capsule().strokeBorder(Theme.line))
    }
}

/// The recording's tags under its title, and « + » to change them.
struct RecordingTags: View {
    @Environment(AppModel.self) private var model
    let recording: StoredRecording
    @State private var editing = false

    var body: some View {
        let tags = model.tags(recording)
        FlowLayout {
            ForEach(tags, id: \.self) { tag in
                TagChip(tag: tag, on: false)
            }
            Button {
                editing = true
            } label: {
                AddTagMark(empty: tags.isEmpty)
            }
            .accessibilityLabel(Text("Tags"))
            .accessibilityIdentifier("tags")
        }
        .sheet(isPresented: $editing) { TagSheet(recording: recording) }
    }
}

/// Under the recording just stopped, on Home: the recent tags in one line,
/// one tap each, and « + » for the sheet. Nothing to dismiss.
struct QuickTags: View {
    @Environment(AppModel.self) private var model
    let recording: StoredRecording
    @State private var editing = false
    /// The tags as first offered: a tap does not move them.
    @State private var offered: [String] = []

    var body: some View {
        let on = Set(model.tags(recording).map(TagName.key))
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Space.xs) {
                ForEach(stable(offered, model.offeredTags(recording)), id: \.self) { tag in
                    let chosen = on.contains(TagName.key(tag))
                    Button {
                        model.setTag(recording, name: tag, on: !chosen)
                    } label: {
                        TagChip(tag: tag, on: chosen)
                    }
                    .buttonStyle(.plain)
                }
                Button {
                    editing = true
                } label: {
                    AddTagMark()
                }
                .accessibilityLabel(Text("Tags"))
            }
            .padding(.leading, 72)
            .padding(.trailing, Theme.Space.xs)
        }
        .padding(.bottom, Theme.Space.s)
        .onAppear { if offered.isEmpty { offered = model.offeredTags(recording) } }
        .sheet(isPresented: $editing) { TagSheet(recording: recording) }
    }
}

/// « Taguer l'enregistrement »: the recent tags to tap, which scroll, and a
/// field for a new one.
struct TagSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let recording: StoredRecording
    @State private var text = ""
    @State private var offered: [String] = []

    var body: some View {
        let on = Set(model.tags(recording).map(TagName.key))
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            HStack {
                Text("Tag this recording")
                    .font(Theme.Text.title)
                    .foregroundStyle(Theme.text)
                Spacer()
                Button("Done") { dismiss() }
                    .font(Theme.Text.title)
                    .foregroundStyle(Theme.ink)
            }
            TextField(text: $text) { Text("New tag") }
                .font(Theme.Text.m)
                .padding(.horizontal, Theme.Space.s)
                .padding(.vertical, Theme.Space.xs)
                .background(RoundedRectangle(cornerRadius: Theme.Radius.s).fill(Theme.surface))
                .submitLabel(.done)
                .onSubmit {
                    if let name = TagName.clean(text) { model.setTag(recording, name: name, on: true) }
                    text = ""
                }
            ScrollView {
                FlowLayout {
                    ForEach(stable(offered, model.offeredTags(recording)), id: \.self) { tag in
                        let chosen = on.contains(TagName.key(tag))
                        Button {
                            model.setTag(recording, name: tag, on: !chosen)
                        } label: {
                            TagChip(tag: tag, on: chosen)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(Theme.Space.m)
        .onAppear { if offered.isEmpty { offered = model.offeredTags(recording) } }
        .presentationDetents([.medium, .large])
        .presentationBackground(Theme.canvas)
    }
}

/// « Téo ? · C'est moi »: a voice Sondine took for the user, confirmed in one tap (ADR 039).
struct SelfGuess: View {
    @Environment(AppModel.self) private var model
    let recording: StoredRecording
    let result: PhoneResult

    var body: some View {
        let pending = model.pendingSelf(recording)
        ForEach(
            result.speakers.filter { $0.guessSelf == true && $0.name == nil && !pending.contains($0.ordinal) },
            id: \.ordinal
        ) { speaker in
            // One of its sentences, so the Mac names this voice only if its transcript is still the one read here.
            if let sentence = result.sentences.first(where: { $0.speaker == speaker.ordinal }) {
                HStack(spacing: Theme.Space.s) {
                    Text(VoiceWords.speaker(speaker))
                        .font(Theme.Text.s)
                        .foregroundStyle(Theme.muted)
                    Button("That's me") {
                        model.confirmSelf(recording, ordinal: speaker.ordinal, sentenceId: sentence.id)
                    }
                    .font(Theme.Text.s)
                    .foregroundStyle(Theme.ink)
                    .accessibilityIdentifier("thats-me")
                }
            }
        }
    }
}

/// The tags in the order first offered, then those added since, most recent first.
private func stable(_ offered: [String], _ now: [String]) -> [String] {
    let kept = offered.filter { tag in now.contains { TagName.key($0) == TagName.key(tag) } }
    let added = now.filter { tag in !offered.contains { TagName.key($0) == TagName.key(tag) } }
    return added + kept
}
