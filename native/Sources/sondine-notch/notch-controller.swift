import AppKit
import SondineNotch
import SwiftUI

/// A diagnostic for main's log: a category, never a name or words.
func warn(_ category: String) {
    FileHandle.standardError.write(Data("sondine-notch: \(category)\n".utf8))
}

/// How many times slower the island moves: 1, or in debug builds what the
/// notch lab asks for (apps/desktop/src/main/notch-lab.ts).
private let slow: Double = {
    #if DEBUG
    let asked = ProcessInfo.processInfo.environment["SONDINE_NOTCH_SLOW"].flatMap(Double.init) ?? 1
    return min(max(asked, 1), 8)
    #else
    return 1
    #endif
}()

/// What the views read.
@MainActor @Observable
final class NotchModel {
    var show: NotchShow?
    var state: IslandState = .compact
    /// The island's body in its current state, animated between states.
    var size: CGSize = .zero
    var bottomRadius: CGFloat = 0
    /// What the announced and the open island hold, whatever their width on the way.
    var contentWidth: CGFloat = 0
    var notchWidth: CGFloat = 0
    var notchHeight: CGFloat = 0
}

enum NotchAction {
    case open
    case openPerson(Int)
    case openEpisode(Int)
    case dismiss(Int)
    /// The call's switch, to on or off.
    case toggle(Bool)
    case mute
    case endEpisode(Int)
    case card(NotchCardAction)
}

/// Above the menu bar and its items, below the menus they open. It never
/// becomes key or main, so the call keeps the keyboard, and the helper is
/// never activated: a click acts at once, and main brings Sondine forward.
final class NotchPanel: NSPanel {
    init() {
        super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        collectionBehavior = [
            .canJoinAllSpaces, .canJoinAllApplications, .stationary, .ignoresCycle,
            .fullScreenAuxiliary, .fullScreenDisallowsTiling,
        ]
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = true
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        isMovable = false
        isRestorable = false
        animationBehavior = .none
        // Who the call is with never shows in a screen share or a recording (ADR 029).
        sharingType = .none
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// AppKit moves windows out of the menu bar; this one belongs there.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

/// Acts on the first click, though its window is never key, and says when
/// the pointer comes in or leaves.
final class NotchHostingView: NSHostingView<IslandView> {
    var onEnter: () -> Void = {}
    var onExit: () -> Void = {}

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas where area.owner === self { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(
            rect: .zero,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self
        ))
    }

    override func mouseEntered(with event: NSEvent) { onEnter() }
    override func mouseExited(with event: NSEvent) { onExit() }
}

/// Holds the island's view at one size, hung from the top and centred, whatever
/// the window's: the window jumps to the size of a morph, and a view that
/// followed it would find its new middle little by little, with the morph.
final class NotchCanvas: NSView {
    /// As large as the island ever is, its ears included.
    var size: CGSize = .zero {
        didSet { if size != oldValue { place() } }
    }

    override func resizeSubviews(withOldSize oldSize: NSSize) { place() }

    private func place() {
        for view in subviews {
            view.frame = CGRect(
                x: (bounds.width - size.width) / 2,
                y: bounds.height - size.height,
                width: size.width,
                height: size.height
            )
        }
    }
}

/// The island's states and its window. The window grows to hold a morph,
/// then fits the island once it settles.
@MainActor
final class NotchController {
    /// How long the name shows below the notch when someone is recognized.
    private static let peekOnArrival: TimeInterval = 4
    /// How long a call that starts, or a card, shows on its own.
    private static let announceDelay: TimeInterval = 8
    /// How long the island takes to close on a card before it is done.
    private static let cardCloseDelay: TimeInterval = 0.4 * slow
    /// How long the pointer rests on the island before it opens (the
    /// default), or, when a click opens it, before the compact island peeks.
    private static let openDelay: TimeInterval = 0.35
    private static let peekDelay: TimeInterval = 0.12
    /// How long the pointer may stay out before a peek, or the open island, closes.
    private static let peekLeaveDelay: TimeInterval = 0.3
    private static let openLeaveDelay: TimeInterval = 0.6
    private static let morph = Animation.spring(response: 0.36, dampingFraction: 0.82).speed(1 / slow)
    private static let peekFont = NSFont.systemFont(ofSize: 13, weight: .medium)

    private let model = NotchModel()
    private let canvas = NotchCanvas()
    private lazy var panel: NotchPanel = {
        let panel = NotchPanel()
        let host = NotchHostingView(rootView: IslandView(model: model) { [weak self] action in self?.act(action) })
        host.sizingOptions = []
        host.onEnter = { [weak self] in self?.pointerCame() }
        host.onExit = { [weak self] in self?.pointerLeft() }
        host.autoresizingMask = []
        canvas.addSubview(host)
        panel.contentView = canvas
        return panel
    }()
    private var geometry: NotchGeometry?
    private var reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    private var readySent = false
    private var sessionActive = true
    /// A call that started, or a card, while another user's session showed.
    private var unsaid = false
    private var pointerInside = false
    /// The next state change on a timer.
    private var pending: DispatchWorkItem?
    /// The latest morph: only its end fits the window to the island.
    private var morphs = 0
    private var outsideClicks: Any?

    init() {
        let center = NotificationCenter.default
        center.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.screensChanged() }
        }
        let workspace = NSWorkspace.shared.notificationCenter
        workspace.addObserver(forName: NSWorkspace.sessionDidResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.session(active: false) }
        }
        workspace.addObserver(forName: NSWorkspace.sessionDidBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.session(active: true) }
        }
        workspace.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
        }
    }

    func receive(_ line: Data) {
        let command: NotchCommand
        do {
            command = try NotchCommand.decode(line: line)
        } catch {
            warn("bad-command")
            return
        }
        switch command {
        case let .show(show):
            let before = model.show
            let someoneNew = !show.people.isEmpty
                && (before?.dismiss?.callId != show.dismiss?.callId
                    || before?.people.first?.personId != show.people.first?.personId)
            let says = show.card.map { $0.key != before?.card?.key } ?? (show.call?.announce == true)
            model.show = show
            guard locate() else { return }
            if says {
                announce()
            } else if someoneNew, model.state != .open, model.state != .announce {
                // Someone new: the name shows a moment, then the island settles.
                if !panel.isVisible { go(.compact) }
                go(.peek)
                later(Self.peekOnArrival) { [weak self] in
                    guard let self, !self.pointerInside, self.model.state == .peek else { return }
                    self.go(.compact)
                }
            } else {
                // The same call and people, other rows: fit them.
                go(fitting(model.state, show, before))
            }
            if !readySent {
                readySent = true
                send(.ready)
            }
        }
    }

    /// Main closed stdin: hide at once, then exit.
    func end() {
        panel.orderOut(nil)
        exit(0)
    }

    /// The state that still has something to show.
    private func fitting(_ state: IslandState, _ show: NotchShow, _ before: NotchShow?) -> IslandState {
        switch state {
        case .peek where show.people.isEmpty: .compact
        case .announce where show.call == nil && show.card == nil: .compact
        // The card has gone; the call was not announced.
        case .announce where before?.card != nil && show.card == nil: .compact
        default: state
        }
    }

    /// A call that starts, or a card: it shows a moment, then the island
    /// settles. Its time starts once this session shows.
    private func announce() {
        unsaid = !sessionActive
        guard sessionActive else { return }
        if !panel.isVisible { go(.compact) }
        go(.announce)
        later(Self.announceDelay) { [weak self] in self?.settleAnnounce() }
    }

    /// What was said has had its time, unless the pointer is on it.
    private func settleAnnounce() {
        guard !pointerInside, model.state == .announce else { return }
        if model.show?.card != nil { finishCard() } else { go(.compact) }
    }

    /// Closes on the card, then says it is done: main hides the island, or shows what comes next.
    private func finishCard() {
        guard let card = model.show?.card else { return }
        go(.compact)
        later(Self.cardCloseDelay) { [weak self] in
            guard let self, let show = self.model.show, show.card?.key == card.key else { return }
            self.send(.done(view: show.view, key: card.key))
        }
    }

    /// Finds the screen with a notch; without one, says so and exits.
    private func locate() -> Bool {
        for screen in NSScreen.screens {
            if let geometry = NotchGeometry(
                screenFrame: screen.frame,
                topLeftArea: screen.auxiliaryTopLeftArea,
                topRightArea: screen.auxiliaryTopRightArea,
                topInset: screen.safeAreaInsets.top
            ) {
                self.geometry = geometry
                model.notchWidth = geometry.notch.width
                model.notchHeight = geometry.notch.height
                model.contentWidth = geometry.size(.open(contentHeight: 0)).width
                canvas.size = geometry.canvas
                return true
            }
        }
        send(.noNotch)
        exit(0)
    }

    /// Morphs the island to `state`; the window holds the old and the new
    /// island while it moves, then fits the new one.
    private func go(_ state: IslandState) {
        guard let geometry, let show = model.show else { return }
        let size = geometry.size(measured(state, show, geometry))
        let target = geometry.frame(size)
        let animated = panel.isVisible && sessionActive && !reduceMotion
        panel.setFrame(animated ? panel.frame.union(target) : target, display: true)
        morphs += 1
        let morph = morphs
        let apply = {
            self.model.state = state
            self.model.size = size
            self.model.bottomRadius = Self.radius(state)
        }
        if animated {
            withAnimation(Self.morph, completionCriteria: .logicallyComplete, apply) { [weak self] in
                guard let self, self.morphs == morph else { return }
                self.panel.setFrame(target, display: true)
            }
        } else {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction, apply)
        }
        if sessionActive { panel.orderFrontRegardless() }
        watchOutsideClicks(state == .open)
    }

    private func measured(_ state: IslandState, _ show: NotchShow, _ geometry: NotchGeometry) -> NotchGeometry.State {
        switch state {
        case .compact:
            return .compact
        case .peek:
            let label = show.people.first?.label ?? ""
            return .peek(labelWidth: (label as NSString).size(withAttributes: [.font: Self.peekFont]).width)
        case .announce:
            let width = geometry.size(.announce(contentHeight: 0)).width
            let content = NSHostingView(rootView: AnnounceContent(show: show, act: { _ in }).frame(width: width))
            return .announce(contentHeight: content.fittingSize.height)
        case .open:
            let width = geometry.size(.open(contentHeight: 0)).width
            let content = NSHostingView(rootView: OpenContent(show: show, act: { _ in }).frame(width: width))
            return .open(contentHeight: content.fittingSize.height)
        }
    }

    private static func radius(_ state: IslandState) -> CGFloat {
        switch state {
        case .compact: 10
        case .peek: 14
        case .announce: 18
        case .open: 22
        }
    }

    private func act(_ action: NotchAction) {
        guard let show = model.show else { return }
        switch action {
        case .open:
            pending?.cancel()
            go(.open)
            return
        case let .toggle(on):
            // The switch moves once main says what the capture does.
            guard let call = show.call else { return }
            send(.toggle(view: show.view, callId: call.callId, on: on))
            return
        case let .card(action):
            switch (action.kind, action.episodeId) {
            case let (.openEpisode, episodeId?): send(.openEpisode(view: show.view, episodeId: episodeId))
            case let (.endEpisode, episodeId?): send(.endEpisode(view: show.view, episodeId: episodeId))
            case (.resume, _): send(.resume(view: show.view))
            default: break
            }
            finishCard()
            return
        case let .openPerson(personId):
            send(.openPerson(view: show.view, personId: personId))
        case let .openEpisode(episodeId):
            send(.openEpisode(view: show.view, episodeId: episodeId))
        case let .dismiss(callId):
            send(.dismiss(view: show.view, callId: callId))
        case .mute:
            guard let call = show.call else { return }
            send(.mute(view: show.view, callId: call.callId))
        case let .endEpisode(episodeId):
            send(.endEpisode(view: show.view, episodeId: episodeId))
        }
        go(.compact)
    }

    private func pointerCame() {
        // While the window holds a morph, its transparent part is not the island.
        guard let geometry, geometry.holds(NSEvent.mouseLocation, size: model.size) else { return }
        pointerInside = true
        if model.show?.card != nil {
            // A card stays while the pointer is on it; one closing goes on closing.
            if model.state == .announce { pending?.cancel() }
            return
        }
        let opensOnHover = model.show?.openOnHover == true
        switch model.state {
        case .open:
            pending?.cancel()
        case .peek where !opensOnHover, .announce where !opensOnHover:
            // It stays while the pointer is on it.
            pending?.cancel()
        case .compact, .peek, .announce:
            let next: IslandState = opensOnHover ? .open : model.show?.call != nil ? .announce : .peek
            later(opensOnHover ? Self.openDelay : Self.peekDelay) { [weak self] in
                guard let self, self.pointerInside, self.model.state != .open else { return }
                self.go(next)
            }
        }
    }

    private func pointerLeft() {
        pointerInside = false
        switch model.state {
        case .compact:
            // A card that is closing still says it is done.
            if model.show?.card == nil { pending?.cancel() }
        case .peek:
            later(Self.peekLeaveDelay) { [weak self] in self?.go(.compact) }
        case .announce:
            later(Self.openLeaveDelay) { [weak self] in self?.settleAnnounce() }
        case .open:
            later(Self.openLeaveDelay) { [weak self] in self?.go(.compact) }
        }
    }

    private func later(_ delay: TimeInterval, _ work: @escaping @MainActor () -> Void) {
        pending?.cancel()
        let item = DispatchWorkItem { MainActor.assumeIsolated { work() } }
        pending = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }

    /// While open, a click in another app closes it.
    private func watchOutsideClicks(_ watch: Bool) {
        if watch, outsideClicks == nil {
            outsideClicks = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                MainActor.assumeIsolated { self?.go(.compact) }
            }
        } else if !watch, let monitor = outsideClicks {
            NSEvent.removeMonitor(monitor)
            outsideClicks = nil
        }
    }

    private func screensChanged() {
        guard model.show != nil, locate() else { return }
        go(model.state)
    }

    /// Hidden while the screen is locked or another user's session shows.
    private func session(active: Bool) {
        sessionActive = active
        if active {
            // A card not read to its end shows again.
            if unsaid || model.show?.card != nil { announce() } else { go(.compact) }
        } else {
            pending?.cancel()
            watchOutsideClicks(false)
            panel.orderOut(nil)
        }
    }

    private func send(_ event: NotchEvent) {
        do {
            try FileHandle.standardOutput.write(contentsOf: event.encodedLine())
        } catch {
            // Main is gone.
            exit(0)
        }
    }
}
