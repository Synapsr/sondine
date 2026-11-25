import Foundation

// What shows a recording outside the app (ADR 032, step M5.6): the Live
// Activity on the Lock Screen and in the Dynamic Island, and the control's
// state. ActivityKit and WidgetKit sit behind protocols, as the audio session
// does; the app implements them, the tests fake them.

/// What the Live Activity shows.
public struct LiveActivityDisplay: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        case recording
        /// « Interrompu à 14:32 », the counter stopped there.
        case interrupted(atMs: Int64, cause: InterruptionCause)
    }

    public var state: State
    /// The wall-clock time the counter counts from: now less what was
    /// recorded, so the Lock Screen and the app agree after an interruption.
    /// iOS draws the counter itself: no update per second.
    public var countsFromMs: Int64
    /// Past this time with no update while recording, the activity says it is
    /// out of date: the app was killed and nothing records. None while
    /// interrupted: nothing is expected from the app then.
    public var staleAtMs: Int64?

    public init(state: State, countsFromMs: Int64, staleAtMs: Int64?) {
        self.state = state
        self.countsFromMs = countsFromMs
        self.staleAtMs = staleAtMs
    }
}

/// The Live Activity (ActivityKit in the app).
public protocol LiveActivityPresenting: Sendable {
    /// Starts one, then ends any other (the one it replaces, or one a killed
    /// app left); false when iOS refuses, and the others stay.
    func start(_ display: LiveActivityDisplay) async -> Bool
    func update(_ display: LiveActivityDisplay) async
    /// Ends it, and any a killed app left behind.
    func end() async
}

/// Whether the control shows « recording », as the app last said.
public struct ControlState: Equatable, Sendable, Codable {
    public var recording: Bool
    public var updatedAtMs: Int64

    /// The app says it again every 2 minutes while it records; past 5 minutes
    /// it is not believed (the app was killed mid-recording).
    public static let believedForMs: Int64 = 300_000

    public init(recording: Bool, updatedAtMs: Int64) {
        self.recording = recording
        self.updatedAtMs = updatedAtMs
    }

    public func isRecording(nowMs: Int64) -> Bool {
        recording && nowMs - updatedAtMs < Self.believedForMs
    }
}

/// Where the control reads its state (a keychain group the widget extension shares).
public protocol ControlStatePublishing: Sendable {
    /// `changed`: recording started or stopped, so the control is drawn again now.
    func publish(_ state: ControlState, changed: Bool)
}

/// When the Live Activity starts, changes and ends, from the recorder's phase
/// and the clock. iOS keeps a Live Activity 8 hours, and a recording started
/// from the Lock Screen (an `AudioRecordingIntent`) must keep one: a minute
/// before, a new activity takes over. If iOS refuses it, the old one runs to
/// its end, and a minute after iOS's limit, if the recording truly goes on, a
/// notification says so.
public struct LiveActivityPlan: Sendable {
    /// How long iOS keeps a Live Activity.
    public static let iosLimitMs: Int64 = 8 * 3_600_000
    /// The next activity takes over a minute before.
    public static let rolloverMs: Int64 = iosLimitMs - 60_000
    /// Without a next one, whether the recording went on is told a minute after.
    public static let afterLimitMs: Int64 = iosLimitMs + 60_000
    /// An unchanged activity is said again this often while recording, with
    /// its out-of-date time moved on.
    public static let refreshMs: Int64 = 120_000
    public static let staleAfterMs: Int64 = 300_000
    /// The counter moves only when it is off by more than this (the
    /// microphone delivers by blocks).
    public static let driftMs: Int64 = 2_000

    public enum Step: Equatable, Sendable {
        case start(LiveActivityDisplay)
        case update(LiveActivityDisplay)
        case end
        /// 8 hours are near: a new activity replaces this one.
        case rollover(LiveActivityDisplay)
        /// iOS ended the activity and nothing replaced it, but the recording
        /// started at `sinceMs` goes on: say so.
        case retire(sinceMs: Int64)
    }

    private var sessionId: UUID?
    private var sessionStartedAtMs: Int64 = 0
    private var activityStartedAtMs: Int64?
    /// While a rollover waits for iOS: when the activity it replaces started.
    private var replacing: Int64?
    /// iOS refused the next activity: the current one runs to its end.
    private var lastOne = false
    private var shown: LiveActivityDisplay?
    private var shownAtMs: Int64 = 0
    /// No activity for the rest of this session: iOS refused one, or ended the last.
    private var retired = false

    public init() {}

    /// An activity shows this session's recording now.
    public var isShowing: Bool { activityStartedAtMs != nil }

    public mutating func next(_ phase: PhoneRecorder.Phase, nowMs: Int64) -> [Step] {
        var steps: [Step] = []
        guard let (id, startedAtMs, display) = Self.describe(phase, nowMs: nowMs) else {
            if activityStartedAtMs != nil { steps.append(.end) }
            self = Self()
            return steps
        }
        if id != sessionId {
            if activityStartedAtMs != nil { steps.append(.end) }
            self = Self()
            sessionId = id
        }
        if let startedAtMs { sessionStartedAtMs = startedAtMs }
        if retired { return steps }
        guard let since = activityStartedAtMs else {
            activityStartedAtMs = nowMs
            show(display, at: nowMs)
            steps.append(.start(display))
            return steps
        }
        if lastOne, nowMs - since >= Self.afterLimitMs {
            // iOS ended it a minute ago.
            activityStartedAtMs = nil
            shown = nil
            lastOne = false
            if case .recording = display.state {
                retired = true
                steps.append(.retire(sinceMs: sessionStartedAtMs))
            } else {
                // Interrupted: the interruption's notification said it; a resume may bring one back.
                steps.append(.end)
            }
            return steps
        }
        if !lastOne, nowMs - since >= Self.rolloverMs {
            replacing = since
            activityStartedAtMs = nowMs
            show(display, at: nowMs)
            steps.append(.rollover(display))
            return steps
        }
        if needsUpdate(display, nowMs: nowMs) {
            show(display, at: nowMs)
            steps.append(.update(display))
        }
        return steps
    }

    /// iOS refused the activity: none for the rest of this session.
    public mutating func activityRefused() {
        retired = true
        activityStartedAtMs = nil
        shown = nil
    }

    /// iOS refused the next activity: the current one stays to its end.
    public mutating func rolloverRefused() {
        activityStartedAtMs = replacing
        replacing = nil
        lastOne = true
    }

    private mutating func show(_ display: LiveActivityDisplay, at nowMs: Int64) {
        shown = display
        shownAtMs = nowMs
    }

    private func needsUpdate(_ display: LiveActivityDisplay, nowMs: Int64) -> Bool {
        guard let shown else { return true }
        return shown.state != display.state
            || abs(shown.countsFromMs - display.countsFromMs) > Self.driftMs
            || (display.staleAtMs != nil && nowMs - shownAtMs >= Self.refreshMs)
    }

    /// The session, when it started (unknown while interrupted), and what to show.
    private static func describe(
        _ phase: PhoneRecorder.Phase, nowMs: Int64
    ) -> (UUID, Int64?, LiveActivityDisplay)? {
        switch phase {
        case .idle:
            return nil
        case let .recording(state):
            let display = LiveActivityDisplay(
                state: .recording, countsFromMs: nowMs - state.elapsedMs, staleAtMs: nowMs + staleAfterMs)
            return (state.sessionId, state.startedAtMs, display)
        case let .interrupted(state):
            let recordedMs = Int64(state.samples) * 1000 / Int64(phoneSampleRate)
            let display = LiveActivityDisplay(
                state: .interrupted(atMs: state.atMs, cause: state.cause), countsFromMs: state.atMs - recordedMs,
                staleAtMs: nil)
            return (state.sessionId, nil, display)
        }
    }
}

/// Keeps the Live Activity and the control in step with the recorder. The app
/// calls `refresh()` at each of the recorder's snapshots (several a second
/// while it records), and the control's gesture calls it before it returns:
/// a recording started from the background must show its Live Activity.
public actor RecordingPresence {
    private let recorder: PhoneRecorder
    private let activity: any LiveActivityPresenting
    private let control: any ControlStatePublishing
    private let notifier: any PhoneNotifying
    private let clock: any PhoneClock
    private var plan = LiveActivityPlan()
    private var published: ControlState?
    /// One refresh at a time, in the order asked.
    private var last: Task<Void, Never>?

    public init(
        recorder: PhoneRecorder, activity: any LiveActivityPresenting, control: any ControlStatePublishing,
        notifier: any PhoneNotifying, clock: any PhoneClock = SystemClock()
    ) {
        self.recorder = recorder
        self.activity = activity
        self.control = control
        self.notifier = notifier
        self.clock = clock
    }

    /// At launch: an activity a killed app left on the Lock Screen goes, and
    /// the control stops saying « recording ». A recording a gesture started
    /// meanwhile keeps its own.
    public func clearLeftovers() async {
        await serially {
            if await self.recorder.snapshot.phase == .idle { await self.activity.end() }
            await self.apply()
        }
    }

    /// True when a Live Activity shows the recording afterwards.
    @discardableResult
    public func refresh() async -> Bool {
        await serially { await self.apply() }
        return plan.isShowing
    }

    private func serially(_ work: @escaping @Sendable () async -> Void) async {
        let previous = last
        let task = Task {
            await previous?.value
            await work()
        }
        last = task
        await task.value
    }

    private func apply() async {
        let phase = await recorder.snapshot.phase
        let now = clock.nowMs()
        var recording = false
        if case .recording = phase { recording = true }
        let changed = published?.recording != recording
        if changed || now - (published?.updatedAtMs ?? 0) >= LiveActivityPlan.refreshMs {
            let state = ControlState(recording: recording, updatedAtMs: now)
            published = state
            control.publish(state, changed: changed)
        }
        for step in plan.next(phase, nowMs: now) {
            switch step {
            case let .start(display):
                if await !activity.start(display) { plan.activityRefused() }
            case let .rollover(display):
                if await !activity.start(display) { plan.rolloverRefused() }
            case let .update(display):
                await activity.update(display)
            case .end:
                await activity.end()
            case let .retire(sinceMs):
                await activity.end()
                notifier.recordingContinues(sinceMs: sinceMs)
            }
        }
    }
}
