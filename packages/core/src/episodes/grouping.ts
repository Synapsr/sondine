import type {
  AppTap,
  CallTransition,
  ConstraintOrigin,
  DictationSpan,
  EpisodeContext,
  SpeechRegion,
  SystemEvent,
  SystemEventKind,
} from "./types";

/**
 * Bump when any rule or constant below changes the grouping of the same input.
 * v2: `system:other` speech joins a call when it may carry the call's far
 * side, and call transitions pair by call id (ADR 016, "Episodes").
 * v3: microphone speech while a dictation app listens is a dictation, in its
 * own lane (ADR 020).
 * v4: a call closes after 5 min without speech, and a dictation during a call
 * stays a dictation (Téo, 2026-11-09: hours in Discord without talking).
 * v5: media splits by the page its browser reported playing (ADR 023): two
 * videos in a row are two episodes.
 * v6: one media lane per source; a region with a known page other than its
 * episode's known page starts the next episode, and a region with no page
 * (the browser said nothing then) joins the one going on unless another app
 * made it (ADR 023, Yab's link, 2026-11-10): a video is one episode even
 * when its page is known for a minute of it.
 */
export const GROUPING_VERSION = "grouping/6";

const SECOND_NS = 1_000_000_000n;

/**
 * Grouping constants: v1's, v3's dictation window and v4's call silence.
 * Starting values, to calibrate on a labelled week (ADR 007).
 */
export const GROUPING_V4 = {
  /** Silence that closes an in-person episode. */
  inPersonGapNs: 45n * SECOND_NS,
  /** Silence that closes a media episode; media pauses (music beds, ads) run longer than talk. */
  mediaGapNs: 120n * SECOND_NS,
  /** A call that stops and restarts within this window is one call (reconnects, mute toggles). */
  callRejoinGapNs: 45n * SECOND_NS,
  /**
   * Silence on every track of a call that closes its episode, the call still
   * on: a voice channel kept open for hours gives one episode per exchange.
   */
  callSilenceGapNs: 5n * 60n * SECOND_NS,
  /** Hard cap on an episode's span; longer stretches split at their longest gap. */
  capNs: 3n * 3600n * SECOND_NS,
  /** Lag allowed between an echo copy and the speech it copies. */
  echoToleranceNs: 2n * SECOND_NS,
  /**
   * Speech counts as a dictation only this long into the app's listening: a
   * dictation app that keeps the microphone open all day must not turn the
   * day's conversations into dictations.
   */
  dictationWindowNs: 10n * 60n * SECOND_NS,
} as const;

/**
 * Lane an episode's regions were grouped in. Media and live talk never share
 * a lane: only a call joins mic speech with app speech. Mic speech while a
 * dictation app listens is the user talking to that app: its own lane.
 */
export type EpisodeLane =
  | { readonly kind: "call"; readonly callKey: string; readonly sessionStartNs: bigint }
  | { readonly kind: "in_person" }
  | { readonly kind: "media"; readonly sourceKey: string }
  | { readonly kind: "dictation"; readonly bundleId: string };

export type CloseReason =
  | "gap"
  /** Media of another page started (ADR 023). */
  | "page-changed"
  | "call-ended"
  | "call-started"
  | "sleep"
  | "paused"
  | "cap"
  | "manual-split"
  | "auto-split"
  /** The user ended it (« Terminer », ADR 044). */
  | "manual-end";

/**
 * A boundary assertion translated to capture time. `split` forces a boundary
 * at `atNs`; `merge` joins every episode overlapping `[startNs, endNs]`.
 * `trackKeys` limits the constraint to episodes with speech on those tracks.
 * Constraints apply auto first, then manual, each by ascending `seq`, so the
 * last applied wins where two disagree.
 */
export type BoundaryConstraint =
  | {
      readonly kind: "split";
      readonly atNs: bigint;
      readonly trackKeys?: readonly string[];
      readonly origin: ConstraintOrigin;
      readonly seq: number;
    }
  | {
      readonly kind: "merge";
      readonly startNs: bigint;
      readonly endNs: bigint;
      readonly trackKeys?: readonly string[];
      readonly origin: ConstraintOrigin;
      readonly seq: number;
    };

/**
 * The user ended the episode of one lane (« Terminer », ADR 044): nothing
 * heard from `atNs` on joins what was heard before, whatever the gap, and a
 * region said across it is cut there. Unlike a `split`, it applies while the
 * episode is open and to its lane alone, so it never cuts what else was heard
 * then on the same tracks.
 */
export interface EpisodeEnd {
  readonly atNs: bigint;
  /** The episode's lane when it was ended, as `endLaneOf` names it. */
  readonly lane: string;
  /**
   * The region the episode last heard. While it is here, its lane is the
   * ended one, whatever was learned since (a call reported late).
   */
  readonly regionId?: string;
}

export interface GroupingInput {
  /**
   * Speech regions of every track, in any order. A region still open at
   * `untilNs` is passed with `endNs = untilNs`.
   */
  readonly regions: readonly SpeechRegion[];
  readonly calls?: readonly CallTransition[];
  /** App tracks open around the regions; a call app with its own tap is not on `system:other`. */
  readonly appTaps?: readonly AppTap[];
  /** Dictation apps listening around the regions; their mic speech leaves a call. */
  readonly dictations?: readonly DictationSpan[];
  readonly events?: readonly SystemEvent[];
  readonly constraints?: readonly BoundaryConstraint[];
  /** Episodes the user ended; an `atNs` past `untilNs` has no effect yet. */
  readonly ends?: readonly EpisodeEnd[];
  /** Capture time up to which the input is complete ("now"). */
  readonly untilNs: bigint;
}

/** The part of a region an episode holds when a split constraint or an end cut that region. */
export interface RegionSlice {
  readonly regionId: string;
  readonly startNs: bigint;
  readonly endNs: bigint;
}

export interface Episode {
  /**
   * Stable within one grouping version: the ID of the first live region, with
   * `@<startNs>` appended when the episode starts inside that region.
   */
  readonly key: string;
  /** Live member regions, ordered by start. A region cut by a split or an end is in both episodes. */
  readonly regionIds: readonly string[];
  /** Members this episode holds only part of (see `regionIds`); usually empty. */
  readonly regionSlices: readonly RegionSlice[];
  /** Echo and duplicate copies attached to this episode; never counted as voiced. */
  readonly hiddenRegionIds: readonly string[];
  readonly startNs: bigint;
  readonly endNs: bigint;
  /** Deduplicated voiced time: live members only, prorated by duration for slices. */
  readonly voicedMs: number;
  readonly context: EpisodeContext;
  readonly lanes: readonly EpisodeLane[];
  /** The one page its media regions heard (ADR 023); null when none did, or several (a merge). */
  readonly pageKey: string | null;
  readonly trackKeys: readonly string[];
  readonly bundleIds: readonly string[];
  /** Still open: more speech may join it. */
  readonly provisional: boolean;
  /** Null while provisional. */
  readonly closeReason: CloseReason | null;
  /** When the user ended it, for `manual-end`; null otherwise. */
  readonly endedAtNs: bigint | null;
  /** When a provisional episode closes if nothing new arrives. */
  readonly closesAtNs: bigint | null;
  /** Device changes and capture restarts inside the span; they never split an episode. */
  readonly discontinuities: readonly SystemEvent[];
  /** Span above the cap: one region longer than the cap, or a manual merge. */
  readonly exceedsCap: boolean;
  readonly constraintSeqs: readonly number[];
}

export interface UnassignedRegion {
  readonly regionId: string;
  readonly reason: "self-playback" | "echo-without-source";
}

export interface GroupingResult {
  readonly version: typeof GROUPING_VERSION;
  readonly episodes: readonly Episode[];
  readonly unassigned: readonly UnassignedRegion[];
}

export class GroupingInputError extends Error {
  override readonly name = "GroupingInputError";
}

interface CallSession {
  readonly callKey: string;
  readonly bundleId: string | undefined;
  readonly startNs: bigint;
  /**
   * Null while the call is still active at `untilNs`. Equal to `startNs` for
   * a closed instant (a call whose helper died before vouching for it again):
   * it covers that instant only, and still joins its app's spans within the
   * rejoin window.
   */
  readonly endNs: bigint | null;
}

interface HardBoundary {
  readonly atNs: bigint;
  readonly reason: "sleep" | "paused";
}

interface Draft {
  members: SpeechRegion[];
  closeReason: CloseReason | null;
  closesAtNs: bigint | null;
  endedAtNs: bigint | null;
  constraintSeqs: number[];
}

interface Cause {
  readonly atNs: bigint;
  readonly reason: CloseReason;
}

interface Context {
  readonly untilNs: bigint;
  readonly boundaries: readonly HardBoundary[];
  readonly sessions: readonly CallSession[];
  readonly ends: readonly EpisodeEnd[];
}

/** Call sessions and app taps, for lane assignment. */
interface CallState {
  readonly sessions: readonly CallSession[];
  readonly appTaps: readonly AppTap[];
}

const HARD_BOUNDARY: Partial<Record<SystemEventKind, HardBoundary["reason"]>> = {
  sleep: "sleep",
  wake: "sleep",
  pause: "paused",
  resume: "paused",
};

const IN_PERSON: EpisodeLane = { kind: "in_person" };

/**
 * Groups speech regions into episodes (architecture §7, ADR 007).
 *
 * Pure and deterministic: the same input gives the same output whatever the
 * input order. Causal: an episode closed at `untilNs` stays identical when
 * later input arrives, so callers can re-run it as regions stream in.
 */
export function groupEpisodes(input: GroupingInput): GroupingResult {
  validate(input);
  const regions = input.regions.toSorted(compareRegions);
  const live = regions.filter((region) => region.echoFlag === undefined);
  const boundaries = (input.events ?? [])
    .flatMap((event): HardBoundary[] => {
      const reason = HARD_BOUNDARY[event.kind];
      return reason === undefined ? [] : [{ atNs: event.atNs, reason }];
    })
    .toSorted((a, b) => compareBig(a.atNs, b.atNs) || compareText(a.reason, b.reason));
  const sessions = callSessions(input.calls ?? [], live, input.untilNs);
  const callState: CallState = { sessions, appTaps: input.appTaps ?? [] };

  // By piece: the two sides of a region an end cut may be in two lanes.
  const laneOf = new Map<string, EpisodeLane>();
  const lanes = new Map<
    string,
    { lane: EpisodeLane; session: CallSession | null; regions: SpeechRegion[] }
  >();
  const dictations = (input.dictations ?? []).toSorted(
    (a, b) => compareBig(a.startNs, b.startNs) || compareText(a.bundleId, b.bundleId),
  );
  const assign = (region: SpeechRegion) => {
    const dictation = dictationLane(region, dictations);
    const session = dictation === null ? sessionFor(region, callState) : null;
    const lane = dictation ?? (session !== null ? callLane(session) : nonCallLane(region));
    return { lane, session };
  };
  const ends = (input.ends ?? [])
    .filter((end) => end.atNs <= input.untilNs)
    .map((end): EpisodeEnd => {
      const heard = live.find((region) => region.id === end.regionId);
      if (heard === undefined || heard.startNs >= end.atNs) return end;
      const said = { ...heard, endNs: minBig(heard.endNs, end.atNs) };
      return { atNs: end.atNs, lane: endLaneOf(assign(said).lane) };
    })
    .toSorted((a, b) => compareBig(a.atNs, b.atNs) || compareText(a.lane, b.lane));
  const context: Context = { untilNs: input.untilNs, boundaries, sessions, ends };
  // Each region, or its pieces where the user ended an episode across it.
  const pieces =
    ends.length === 0
      ? live
      : live
          .flatMap((region) => cutAtEnds(region, ends, (piece) => endLaneOf(assign(piece).lane)))
          .toSorted(compareRegions);
  for (const region of pieces) {
    const { lane, session } = assign(region);
    laneOf.set(pieceKey(region), lane);
    // A constraint may cut a piece further: its region's last lane answers then.
    laneOf.set(region.id, lane);
    const key = laneKey(lane);
    const entry = lanes.get(key);
    if (entry === undefined) lanes.set(key, { lane, session, regions: [region] });
    else entry.regions.push(region);
  }

  let drafts: Draft[] = [];
  for (const key of [...lanes.keys()].toSorted()) {
    const entry = lanes.get(key);
    if (entry === undefined) continue;
    drafts.push(...groupLane(entry.lane, entry.session, entry.regions, context));
  }

  const constraints = (input.constraints ?? []).toSorted(compareConstraints);
  for (const constraint of constraints.filter((c) => c.origin === "auto")) {
    drafts = applyConstraint(drafts, constraint);
  }
  drafts = drafts.flatMap(enforceCap);
  for (const constraint of constraints.filter((c) => c.origin === "manual")) {
    drafts = applyConstraint(drafts, constraint);
  }

  const softEvents = (input.events ?? [])
    .filter((event) => HARD_BOUNDARY[event.kind] === undefined)
    .toSorted((a, b) => compareBig(a.atNs, b.atNs) || compareText(a.kind, b.kind));
  const laneOfMember = (region: SpeechRegion) =>
    laneOf.get(pieceKey(region)) ?? laneOf.get(region.id) ?? IN_PERSON;
  const byId = new Map(live.map((region) => [region.id, region]));
  const finished = drafts
    .filter((draft) => draft.members.length > 0)
    .map((draft) => finalize(draft, laneOfMember, softEvents, byId))
    .toSorted(
      (a, b) =>
        compareBig(a.episode.startNs, b.episode.startNs) ||
        compareText(a.episode.key, b.episode.key),
    );

  const { attached, unassigned } = attachHidden(regions, finished);
  return {
    version: GROUPING_VERSION,
    episodes: finished.map(({ episode }) => ({
      ...episode,
      hiddenRegionIds: attached.get(episode.key) ?? [],
    })),
    unassigned,
  };
}

/**
 * The lane an end names: a call without its session, whose start moves when
 * an earlier span of the same app is learned.
 */
export function endLaneOf(lane: EpisodeLane): string {
  return lane.kind === "call" ? `call:${lane.callKey}` : laneKey(lane);
}

/**
 * Cuts a region at the ends it was said across: one whose part before the end
 * is in the ended lane, by its own midpoint (which stays as the region goes
 * on), or which would join that lane whole. Each piece then finds its lane.
 */
function cutAtEnds(
  region: SpeechRegion,
  ends: readonly EpisodeEnd[],
  laneOfPiece: (piece: SpeechRegion) => string,
): SpeechRegion[] {
  const out: SpeechRegion[] = [];
  let rest = region;
  for (const end of ends) {
    if (end.atNs <= rest.startNs || end.atNs >= rest.endNs) continue;
    const [head, tail] = cutRegion(rest, end.atNs);
    if (laneOfPiece(head) !== end.lane && laneOfPiece(rest) !== end.lane) continue;
    out.push(head);
    rest = tail;
  }
  return [...out, rest];
}

/** A region, or one piece of it. */
const pieceKey = (region: SpeechRegion) => `${region.id}@${region.startNs}`;

function validate(input: GroupingInput): void {
  const ids = new Set<string>();
  for (const region of input.regions) {
    if (ids.has(region.id)) throw new GroupingInputError(`duplicate region id ${region.id}`);
    ids.add(region.id);
    if (region.endNs < region.startNs) {
      throw new GroupingInputError(`region ${region.id} ends before it starts`);
    }
    if (region.endNs > input.untilNs) {
      throw new GroupingInputError(`region ${region.id} ends after untilNs; clip open regions`);
    }
    if (!Number.isFinite(region.voicedMs) || region.voicedMs < 0) {
      throw new GroupingInputError(`region ${region.id} has an invalid voicedMs`);
    }
  }
  for (const call of input.calls ?? []) {
    if (call.atNs > input.untilNs) {
      throw new GroupingInputError(`call transition for ${call.callKey} is after untilNs`);
    }
  }
  for (const tap of input.appTaps ?? []) {
    if (tap.endNs !== null && tap.endNs < tap.startNs) {
      throw new GroupingInputError(`app tap of ${tap.bundleId} ends before it starts`);
    }
  }
  for (const span of input.dictations ?? []) {
    if (span.endNs !== null && span.endNs < span.startNs) {
      throw new GroupingInputError(`dictation span of ${span.bundleId} ends before it starts`);
    }
  }
  for (const event of input.events ?? []) {
    if (event.atNs > input.untilNs) {
      throw new GroupingInputError(`system event ${event.kind} is after untilNs`);
    }
  }
  for (const constraint of input.constraints ?? []) {
    if (constraint.kind === "merge" && constraint.endNs < constraint.startNs) {
      throw new GroupingInputError(`merge constraint ${constraint.seq} ends before it starts`);
    }
  }
}

function callSessions(
  transitions: readonly CallTransition[],
  live: readonly SpeechRegion[],
  untilNs: bigint,
): CallSession[] {
  // Transitions pair within one call id (or, without ids, within one source).
  const byCall = new Map<string, CallTransition[]>();
  for (const transition of transitions) {
    const key =
      transition.callId === undefined
        ? transition.callKey
        : `${transition.callKey}\u0000${transition.callId}`;
    const list = byCall.get(key);
    if (list === undefined) byCall.set(key, [transition]);
    else list.push(transition);
  }

  const bySource = new Map<string, CallSession[]>();
  for (const list of byCall.values()) {
    const intervals = list[0]?.callId === undefined ? pairInTime(list) : callSpan(list);
    for (const interval of intervals) {
      const sourceList = bySource.get(interval.callKey);
      if (sourceList === undefined) bySource.set(interval.callKey, [interval]);
      else sourceList.push(interval);
    }
  }
  // Intervals of one source that overlap or restart within the rejoin window are one call.
  const declared = [...bySource.values()].flatMap(mergeIntervals);

  // Regions that carry call evidence but no declared call cover them still form a call.
  const inferredByKey = new Map<string, CallSession[]>();
  for (const region of live) {
    const isMic = region.trackKind === "input" || region.trackKind === "phone";
    if (!region.appContext.callActive || !(isMic || region.appContext.isCallApp)) continue;
    if (declared.some((session) => covers(session, midpoint(region)))) continue;
    const bundleId = region.appContext.bundleId;
    const callKey = `inferred:${bundleId ?? "unknown"}`;
    const interval: CallSession = {
      callKey,
      bundleId,
      startNs: region.startNs,
      endNs: region.endNs,
    };
    const list = inferredByKey.get(callKey);
    if (list === undefined) inferredByKey.set(callKey, [interval]);
    else list.push(interval);
  }
  const inferred = [...inferredByKey.values()].flatMap(mergeIntervals);

  return [...declared, ...inferred]
    .filter((session) => session.startNs <= untilNs)
    .toSorted((a, b) => compareBig(a.startNs, b.startNs) || compareText(a.callKey, b.callKey));
}

/**
 * The span of one call id. A call id is one active span, so its `ended`
 * closes its `active` whatever their order, at equal times too: a call that
 * ends where it starts (a helper that died before its next clock) is a closed
 * instant, never an open call. An `ended` before the start ends it at the
 * start; an id without an `active` has no span.
 */
function callSpan(transitions: readonly CallTransition[]): CallSession[] {
  const actives = transitions
    .filter((transition) => transition.state === "active")
    .toSorted(
      (a, b) => compareBig(a.atNs, b.atNs) || compareText(a.bundleId ?? "", b.bundleId ?? ""),
    );
  const first = actives[0];
  if (first === undefined) return [];
  let endNs: bigint | null = null;
  for (const transition of transitions) {
    if (transition.state === "ended") {
      endNs = maxBig(endNs ?? first.atNs, transition.atNs);
    }
  }
  return [
    {
      callKey: first.callKey,
      bundleId: actives.find((transition) => transition.bundleId !== undefined)?.bundleId,
      startNs: first.atNs,
      endNs,
    },
  ];
}

/**
 * The spans of one source whose transitions carry no call id, paired in time
 * order. At one instant, a stop and a restart of an open call stay one call;
 * a start and a stop of a closed one make a closed instant.
 */
function pairInTime(transitions: readonly CallTransition[]): CallSession[] {
  const ordered = transitions.toSorted(
    (a, b) =>
      compareBig(a.atNs, b.atNs) ||
      compareText(a.state, b.state) ||
      compareText(a.bundleId ?? "", b.bundleId ?? ""),
  );
  const instants = new Map<bigint, CallTransition[]>();
  for (const transition of ordered) {
    const list = instants.get(transition.atNs);
    if (list === undefined) instants.set(transition.atNs, [transition]);
    else list.push(transition);
  }
  const callKey = ordered[0]?.callKey ?? "";
  const intervals: CallSession[] = [];
  let openStart: bigint | null = null;
  let bundleId: string | undefined;
  for (const [atNs, instant] of instants) {
    const ends = instant.some((transition) => transition.state === "ended");
    const starts = instant.filter((transition) => transition.state === "active");
    const wasOpen = openStart !== null;
    if (openStart !== null && ends) {
      intervals.push({ callKey, bundleId, startNs: openStart, endNs: atNs });
      openStart = null;
    }
    for (const transition of starts) bundleId = transition.bundleId ?? bundleId;
    if (starts.length > 0 && openStart === null) openStart = atNs;
    if (!wasOpen && ends && openStart !== null) {
      intervals.push({ callKey, bundleId, startNs: openStart, endNs: atNs });
      openStart = null;
    }
  }
  if (openStart !== null) intervals.push({ callKey, bundleId, startNs: openStart, endNs: null });
  return intervals;
}

function mergeIntervals(intervals: readonly CallSession[]): CallSession[] {
  const sorted = intervals.toSorted(
    (a, b) =>
      compareBig(a.startNs, b.startNs) ||
      compareBig(a.endNs ?? a.startNs, b.endNs ?? b.startNs) ||
      compareText(a.bundleId ?? "", b.bundleId ?? ""),
  );
  const merged: CallSession[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (
      last !== undefined &&
      (last.endNs === null || interval.startNs - last.endNs < GROUPING_V4.callRejoinGapNs)
    ) {
      const endNs =
        last.endNs === null || interval.endNs === null ? null : maxBig(last.endNs, interval.endNs);
      merged[merged.length - 1] = { ...last, bundleId: last.bundleId ?? interval.bundleId, endNs };
    } else {
      merged.push(interval);
    }
  }
  return merged;
}

/**
 * The call a live region hears, if any, at its midpoint:
 * - the call of its own app (an app track, or a region attributed to it);
 * - for a mic, or a call app's region, the earliest covering call;
 * - for `system:other`, the call its attribution names, else (ambiguous or
 *   unknown attribution) the earliest covering call whose app has no tap of
 *   its own: the far side of a call is on `system:other` until the call app
 *   is tapped. A region attributed to another app stays media.
 */
function sessionFor(region: SpeechRegion, state: CallState): CallSession | null {
  const mid = midpoint(region);
  const covering = state.sessions.filter((session) => covers(session, mid));
  const first = covering[0];
  if (first === undefined) return null;
  const sameApp = covering.find(
    (session) => session.bundleId !== undefined && session.bundleId === region.appContext.bundleId,
  );
  if (sameApp !== undefined) return sameApp;
  const isMic = region.trackKind === "input" || region.trackKind === "phone";
  if (isMic || region.appContext.isCallApp) return first;
  if (region.trackKind !== "system") return null;
  const attributed = region.appContext.attributedBundleId;
  if (attributed !== undefined) {
    return covering.find((session) => session.bundleId === attributed) ?? null;
  }
  return (
    covering.find(
      (session) =>
        session.bundleId === undefined || !hasOwnTap(session.bundleId, mid, state.appTaps),
    ) ?? null
  );
}

function hasOwnTap(bundleId: string, atNs: bigint, taps: readonly AppTap[]): boolean {
  return taps.some(
    (tap) =>
      tap.bundleId === bundleId && tap.startNs <= atNs && (tap.endNs === null || atNs <= tap.endNs),
  );
}

function callLane(session: CallSession): EpisodeLane {
  return { kind: "call", callKey: session.callKey, sessionStartNs: session.startNs };
}

/**
 * Mic speech whose midpoint falls in the first `dictationWindowNs` of a
 * dictation app listening (the earliest such app when several listen) is
 * said to that app, during a call too. Phone recordings are never
 * dictations: the Mac's listeners say nothing of them.
 */
function dictationLane(
  region: SpeechRegion,
  dictations: readonly DictationSpan[],
): EpisodeLane | null {
  if (region.trackKind !== "input") return null;
  const mid = midpoint(region);
  const span = dictations.find(
    (candidate) =>
      candidate.startNs <= mid &&
      mid - candidate.startNs <= GROUPING_V4.dictationWindowNs &&
      (candidate.endNs === null || mid <= candidate.endNs),
  );
  return span === undefined ? null : { kind: "dictation", bundleId: span.bundleId };
}

/**
 * Outside calls and dictations: mic and phone speech is in person, the rest
 * media, one lane per source; pages split a media lane's episodes
 * (`groupLane`).
 */
function nonCallLane(region: SpeechRegion): EpisodeLane {
  if (region.trackKind === "input" || region.trackKind === "phone") return IN_PERSON;
  return { kind: "media", sourceKey: region.appContext.bundleId ?? region.trackKey };
}

/** The app a region heard: its track's, or the one `system:other` named. */
function appOf(region: SpeechRegion): string | undefined {
  return region.appContext.bundleId ?? region.appContext.attributedBundleId;
}

/** The page a media draft heard, and its app: its first member with one. */
function pageOfDraft(
  members: readonly SpeechRegion[],
): { readonly key: string; readonly app: string | undefined } | undefined {
  const member = members.find((candidate) => candidate.appContext.pageKey !== undefined);
  const key = member?.appContext.pageKey;
  return member === undefined || key === undefined ? undefined : { key, app: appOf(member) };
}

/**
 * Whether a region ends a media draft that heard `page`: it heard another
 * page, or it heard none and another app made it (`system:other` holds
 * every app without a track of its own). A region without a page from the
 * page's browser, or from no known app, joins it.
 */
function leavesPage(
  region: SpeechRegion,
  page: { readonly key: string; readonly app: string | undefined },
): boolean {
  const key = region.appContext.pageKey;
  if (key !== undefined) return key !== page.key;
  const app = appOf(region);
  return app !== undefined && page.app !== undefined && app !== page.app;
}

function laneKey(lane: EpisodeLane): string {
  switch (lane.kind) {
    case "call":
      return `call:${lane.sessionStartNs}:${lane.callKey}`;
    case "in_person":
      return "in_person";
    case "media":
      return `media:${lane.sourceKey}`;
    case "dictation":
      return `dictation:${lane.bundleId}`;
  }
}

function groupLane(
  lane: EpisodeLane,
  session: CallSession | null,
  regions: readonly SpeechRegion[],
  context: Context,
): Draft[] {
  const out: Draft[] = [];
  const ends = context.ends.filter((end) => end.lane === endLaneOf(lane));
  let current: Draft | null = null;
  // Running maxima of the open draft, so each region costs O(1) outside cap cuts.
  let lastEnd = 0n;
  let lastMid = 0n;
  // The open media draft's known page: another page starts the next episode.
  let page: { readonly key: string; readonly app: string | undefined } | undefined;
  for (const region of regions) {
    if (current !== null) {
      // Another page splits only after the open episode's speech ended: an
      // overlapping region (still growing, perhaps) joins, whatever later input says.
      const cause =
        firstOf(
          endBetween(ends, current.members, region.startNs),
          closeCause(lastEnd, lastMid, region.startNs, lane, context),
        ) ??
        (lane.kind === "media" &&
        page !== undefined &&
        region.startNs >= lastEnd &&
        leavesPage(region, page)
          ? { atNs: region.startNs, reason: "page-changed" as const }
          : null);
      if (cause !== null) {
        closeAt(current, cause);
        out.push(current);
        current = null;
      }
    }
    if (current === null) {
      current = {
        members: [region],
        closeReason: null,
        closesAtNs: null,
        endedAtNs: null,
        constraintSeqs: [],
      };
      lastEnd = region.endNs;
      lastMid = midpoint(region);
      page = pageOfDraft([region]);
      continue;
    }
    current.members.push(region);
    lastEnd = maxBig(lastEnd, region.endNs);
    lastMid = maxBig(lastMid, midpoint(region));
    page ??= pageOfDraft([region]);
    // Regions arrive sorted by start, so the first member starts the span.
    if (lastEnd - (current.members[0]?.startNs ?? region.startNs) > GROUPING_V4.capNs) {
      splitAtCap(current, out);
      page = pageOfDraft(current.members);
      lastEnd = spanEnd(current.members);
      lastMid = current.members.reduce(
        (max, member) => maxBig(max, midpoint(member)),
        midpoint(region),
      );
    }
  }
  if (current === null) return out;

  const ended = endBetween(ends, current.members, context.untilNs);
  if (ended !== null) {
    closeAt(current, ended);
  } else if (session !== null) {
    closeCall(current, lastEnd, session, context);
  } else {
    const cause = closeCause(lastEnd, lastMid, context.untilNs, lane, context);
    if (cause !== null) current.closeReason = cause.reason;
    else current.closesAtNs = lastEnd + gapFor(lane);
  }
  out.push(current);
  return out;
}

function closeAt(draft: Draft, cause: Cause): void {
  draft.closeReason = cause.reason;
  draft.endedAtNs = cause.reason === "manual-end" ? cause.atNs : null;
}

/** The earlier of two causes; the first on a tie. */
function firstOf(a: Cause | null, b: Cause | null): Cause | null {
  return b === null || (a !== null && a.atNs <= b.atNs) ? a : b;
}

/** The end that closes a draft whose next region starts at `atNs`, if any. */
function endBetween(
  ends: readonly EpisodeEnd[],
  members: readonly SpeechRegion[],
  atNs: bigint,
): Cause | null {
  if (ends.length === 0) return null;
  const startNs = spanStart(members);
  const end = ends.find((candidate) => candidate.atNs > startNs && candidate.atNs <= atNs);
  return end === undefined ? null : { atNs: end.atNs, reason: "manual-end" };
}

function gapFor(lane: EpisodeLane): bigint {
  switch (lane.kind) {
    case "media":
      return GROUPING_V4.mediaGapNs;
    case "call":
      return GROUPING_V4.callSilenceGapNs;
    case "in_person":
    case "dictation":
      return GROUPING_V4.inPersonGapNs;
  }
}

/**
 * First event between the end of the open draft (`lastEnd`) and `atNs` that
 * closes it, if any. `lastMid` is its latest region midpoint, the instant
 * lane assignment used.
 */
function closeCause(
  lastEnd: bigint,
  lastMid: bigint,
  atNs: bigint,
  lane: EpisodeLane,
  context: Context,
): Cause | null {
  const candidates: Cause[] = [];
  const boundary = context.boundaries.find((b) => b.atNs >= lastEnd && b.atNs <= atNs);
  if (boundary !== undefined) candidates.push(boundary);
  if (lane.kind === "in_person") {
    const call = context.sessions.find((s) => s.startNs > lastMid && s.startNs <= atNs);
    if (call !== undefined) candidates.push({ atNs: call.startNs, reason: "call-started" });
  }
  const gapNs = gapFor(lane);
  if (atNs - lastEnd >= gapNs) candidates.push({ atNs: lastEnd + gapNs, reason: "gap" });

  let best: Cause | null = null;
  for (const candidate of candidates) {
    if (best === null || candidate.atNs < best.atNs) best = candidate;
  }
  return best;
}

/**
 * Closes a call's last draft at the first of: a hard boundary (or the call's
 * end before it), the call's end with no restart within the rejoin window,
 * and `callSilenceGapNs` without speech. Otherwise it stays open until the
 * earliest that can still come.
 */
function closeCall(draft: Draft, lastEnd: bigint, session: CallSession, context: Context): void {
  const boundary = context.boundaries.find((b) => b.atNs >= lastEnd && b.atNs <= context.untilNs);
  const endNs = session.endNs;
  const silentAt = lastEnd + GROUPING_V4.callSilenceGapNs;
  const causes: Cause[] = [];
  if (boundary !== undefined) {
    causes.push(
      endNs !== null && endNs <= boundary.atNs
        ? { atNs: minBig(endNs + GROUPING_V4.callRejoinGapNs, boundary.atNs), reason: "call-ended" }
        : boundary,
    );
  } else if (endNs !== null && context.untilNs - endNs >= GROUPING_V4.callRejoinGapNs) {
    causes.push({ atNs: endNs + GROUPING_V4.callRejoinGapNs, reason: "call-ended" });
  }
  if (silentAt <= context.untilNs) causes.push({ atNs: silentAt, reason: "gap" });
  let first: Cause | null = null;
  for (const cause of causes) if (first === null || cause.atNs < first.atNs) first = cause;
  if (first !== null) draft.closeReason = first.reason;
  else {
    draft.closesAtNs =
      endNs === null ? silentAt : minBig(endNs + GROUPING_V4.callRejoinGapNs, silentAt);
  }
}

/**
 * Keeps an open draft under the cap as regions arrive: when the newest region
 * pushes the span over the cap, everything before the longest gap closes.
 * Only past regions decide the cut, so closed episodes never move later.
 */
function splitAtCap(current: Draft, out: Draft[]): void {
  while (spanEnd(current.members) - spanStart(current.members) > GROUPING_V4.capNs) {
    const cut = longestGapCut(current.members);
    if (cut === null) return;
    out.push({
      members: current.members.slice(0, cut + 1),
      closeReason: "cap",
      closesAtNs: null,
      endedAtNs: null,
      constraintSeqs: [...current.constraintSeqs],
    });
    current.members = current.members.slice(cut + 1);
  }
}

/** Recursive cap split for drafts that grew over the cap through automatic merges. */
function enforceCap(draft: Draft): Draft[] {
  if (spanEnd(draft.members) - spanStart(draft.members) <= GROUPING_V4.capNs) return [draft];
  const cut = longestGapCut(draft.members);
  if (cut === null) return [draft];
  const head: Draft = {
    members: draft.members.slice(0, cut + 1),
    closeReason: "cap",
    closesAtNs: null,
    endedAtNs: null,
    constraintSeqs: [...draft.constraintSeqs],
  };
  const tail: Draft = { ...draft, members: draft.members.slice(cut + 1) };
  return [...enforceCap(head), ...enforceCap(tail)];
}

/**
 * Index of the region after which the longest silence starts. Without any
 * silence (contiguous segmenter cuts, overlapping tracks) the gap is zero or
 * negative, so the boundary with the least overlap wins. Ties go to the latest
 * boundary that keeps the head within the cap, so uniform speech is cut as
 * close to the cap as possible.
 */
function longestGapCut(members: readonly SpeechRegion[]): number | null {
  const startNs = spanStart(members);
  let maxEnd: bigint | null = null;
  let best: number | null = null;
  let bestGap = 0n;
  for (let index = 0; index < members.length - 1; index += 1) {
    const region = members[index];
    const next = members[index + 1];
    if (region === undefined || next === undefined) break;
    maxEnd = maxEnd === null ? region.endNs : maxBig(maxEnd, region.endNs);
    const gap = next.startNs - maxEnd;
    const fits = maxEnd - startNs <= GROUPING_V4.capNs;
    if (best === null || gap > bestGap || (gap === bestGap && fits)) {
      best = index;
      bestGap = gap;
    }
  }
  return best;
}

function applyConstraint(drafts: Draft[], constraint: BoundaryConstraint): Draft[] {
  const inScope = (draft: Draft): boolean =>
    constraint.trackKeys === undefined ||
    draft.members.some((region) => constraint.trackKeys?.includes(region.trackKey) === true);

  if (constraint.kind === "merge") {
    const targets = drafts.filter(
      (draft) =>
        inScope(draft) &&
        // The user's end is theirs to undo, never an automatic merge's.
        (constraint.origin === "manual" || draft.closeReason !== "manual-end") &&
        spanStart(draft.members) <= constraint.endNs &&
        spanEnd(draft.members) >= constraint.startNs,
    );
    if (targets.length < 2) return drafts;
    return [
      ...drafts.filter((draft) => !targets.includes(draft)),
      mergeDrafts(targets, constraint.seq),
    ];
  }

  return drafts.flatMap((draft) => {
    if (
      !inScope(draft) ||
      spanStart(draft.members) >= constraint.atNs ||
      spanEnd(draft.members) <= constraint.atNs
    ) {
      return [draft];
    }
    // The split lies strictly inside the span, so both sides get at least one member.
    const head: SpeechRegion[] = [];
    const tail: SpeechRegion[] = [];
    for (const region of draft.members) {
      if (region.startNs >= constraint.atNs) tail.push(region);
      else if (region.endNs <= constraint.atNs) head.push(region);
      else {
        const [before, after] = cutRegion(region, constraint.atNs);
        head.push(before);
        tail.push(after);
      }
    }
    const constraintSeqs = [...draft.constraintSeqs, constraint.seq];
    return [
      {
        members: head.toSorted(compareRegions),
        closeReason: constraint.origin === "manual" ? "manual-split" : "auto-split",
        closesAtNs: null,
        endedAtNs: null,
        constraintSeqs,
      },
      { ...draft, members: tail.toSorted(compareRegions), constraintSeqs },
    ];
  });
}

/** Cuts a region at `atNs`; the slices share its voiced time in proportion to duration. */
function cutRegion(region: SpeechRegion, atNs: bigint): [SpeechRegion, SpeechRegion] {
  const share = Number(atNs - region.startNs) / Number(region.endNs - region.startNs);
  const headMs = Math.round(region.voicedMs * share);
  return [
    { ...region, endNs: atNs, voicedMs: headMs },
    { ...region, startNs: atNs, voicedMs: region.voicedMs - headMs },
  ];
}

/** Joins touching slices of one region, so a merge across a split restores it. */
function joinSlices(members: readonly SpeechRegion[]): SpeechRegion[] {
  const out: SpeechRegion[] = [];
  const indexById = new Map<string, number>();
  for (const region of members.toSorted(compareRegions)) {
    const index = indexById.get(region.id);
    const previous = index === undefined ? undefined : out[index];
    if (index !== undefined && previous !== undefined && region.startNs <= previous.endNs) {
      out[index] = {
        ...previous,
        endNs: maxBig(previous.endNs, region.endNs),
        voicedMs: previous.voicedMs + region.voicedMs,
      };
    } else {
      indexById.set(region.id, out.length);
      out.push(region);
    }
  }
  return out.toSorted(compareRegions);
}

function mergeDrafts(targets: readonly Draft[], seq: number): Draft {
  const members = joinSlices(targets.flatMap((draft) => draft.members));
  const open = targets.filter((draft) => draft.closeReason === null);
  let closeReason: CloseReason | null = null;
  let closesAtNs: bigint | null = null;
  let endedAtNs: bigint | null = null;
  if (open.length === 0) {
    let latest: Draft | undefined;
    for (const draft of targets) {
      if (latest === undefined || spanEnd(draft.members) >= spanEnd(latest.members)) latest = draft;
    }
    closeReason = latest?.closeReason ?? null;
    endedAtNs = latest?.endedAtNs ?? null;
  } else if (open.every((draft) => draft.closesAtNs !== null)) {
    closesAtNs = open.reduce((max, draft) => maxBig(max, draft.closesAtNs ?? max), 0n);
  }
  const constraintSeqs = [...new Set([...targets.flatMap((draft) => draft.constraintSeqs), seq])];
  return {
    members,
    closeReason,
    closesAtNs,
    endedAtNs,
    constraintSeqs: constraintSeqs.toSorted((a, b) => a - b),
  };
}

/** An episode before echo attachment, with its members (slices included). */
interface Finished {
  readonly episode: Omit<Episode, "hiddenRegionIds">;
  readonly members: readonly SpeechRegion[];
}

function finalize(
  draft: Draft,
  laneOf: (region: SpeechRegion) => EpisodeLane,
  softEvents: readonly SystemEvent[],
  byId: ReadonlyMap<string, SpeechRegion>,
): Finished {
  const members = draft.members.toSorted(compareRegions);
  const startNs = spanStart(members);
  const endNs = spanEnd(members);
  const lanesByKey = new Map<string, EpisodeLane>();
  for (const region of members) {
    const lane = laneOf(region);
    lanesByKey.set(laneKey(lane), lane);
  }
  const lanes = [...lanesByKey.entries()]
    .toSorted(([a], [b]) => compareText(a, b))
    .map(([, lane]) => lane);
  const slices = members.filter((region) => {
    const whole = byId.get(region.id);
    return whole?.startNs !== region.startNs || whole.endNs !== region.endNs;
  });
  const first = members[0];
  const key =
    first === undefined
      ? ""
      : byId.get(first.id)?.startNs === first.startNs
        ? first.id
        : `${first.id}@${first.startNs}`;
  const pages = new Set(
    members.flatMap((region) =>
      laneOf(region).kind === "media" && region.appContext.pageKey !== undefined
        ? [region.appContext.pageKey]
        : [],
    ),
  );
  const [onlyPage] = pages;
  const episode = {
    key,
    regionIds: [...new Set(members.map((region) => region.id))],
    regionSlices: slices.map((slice) => ({
      regionId: slice.id,
      startNs: slice.startNs,
      endNs: slice.endNs,
    })),
    startNs,
    endNs,
    voicedMs: members.reduce((sum, region) => sum + region.voicedMs, 0),
    context: contextOf(lanes),
    lanes,
    pageKey: pages.size === 1 && onlyPage !== undefined ? onlyPage : null,
    trackKeys: uniqueSorted(members.map((region) => region.trackKey)),
    bundleIds: uniqueSorted(members.flatMap((region) => region.appContext.bundleId ?? [])),
    provisional: draft.closeReason === null,
    closeReason: draft.closeReason,
    endedAtNs: draft.endedAtNs,
    closesAtNs: draft.closeReason === null ? draft.closesAtNs : null,
    discontinuities: softEvents.filter((event) => event.atNs >= startNs && event.atNs <= endNs),
    exceedsCap: endNs - startNs > GROUPING_V4.capNs,
    constraintSeqs: [...draft.constraintSeqs],
  } satisfies Finished["episode"];
  return { episode, members };
}

function contextOf(lanes: readonly EpisodeLane[]): EpisodeContext {
  const kinds = new Set(lanes.map((lane) => lane.kind));
  if (kinds.size !== 1) return "mixed";
  if (kinds.has("call")) return "call";
  if (kinds.has("media")) return "media";
  if (kinds.has("dictation")) return "dictation";
  return "in_person";
}

/**
 * Echo and duplicate copies follow the episode holding the speech they copy
 * (most overlap, ties to the earliest episode); self-playback belongs to no
 * episode.
 */
function attachHidden(
  regions: readonly SpeechRegion[],
  finished: readonly Finished[],
): { attached: Map<string, string[]>; unassigned: UnassignedRegion[] } {
  const tolerance = GROUPING_V4.echoToleranceNs;
  const order = new Map(finished.map(({ episode }, index) => [episode.key, index]));
  const byTrack = new Map<string, TrackIndex>();
  for (const { episode, members } of finished) {
    for (const region of members) {
      const index = byTrack.get(region.trackKey) ?? { items: [], longestNs: 0n };
      index.items.push({ region, key: episode.key });
      index.longestNs = maxBig(index.longestNs, region.endNs - region.startNs);
      byTrack.set(region.trackKey, index);
    }
  }
  for (const [trackKey, index] of byTrack) {
    byTrack.set(trackKey, {
      ...index,
      items: index.items.toSorted((a, b) => compareRegions(a.region, b.region)),
    });
  }

  const attached = new Map<string, string[]>();
  const unassigned: UnassignedRegion[] = [];
  for (const region of regions) {
    const flag = region.echoFlag;
    if (flag === undefined) continue;
    if (flag.kind === "self-playback") {
      unassigned.push({ regionId: region.id, reason: "self-playback" });
      continue;
    }
    const index = byTrack.get(flag.ofTrackKey);
    const overlapByKey = new Map<string, bigint>();
    if (index !== undefined) {
      const from = region.startNs - tolerance;
      const to = region.endNs + tolerance;
      // Sources start at most `longestNs` before they end, so the scan can stop there.
      for (let i = upperBound(index.items, to) - 1; i >= 0; i -= 1) {
        const item = index.items[i];
        if (item === undefined || item.region.startNs < from - index.longestNs) break;
        if (item.region.endNs < from) continue;
        const shared =
          minBig(item.region.endNs, region.endNs) - maxBig(item.region.startNs, region.startNs);
        overlapByKey.set(
          item.key,
          (overlapByKey.get(item.key) ?? 0n) + (shared > 0n ? shared : 0n),
        );
      }
    }
    let best: { key: string; overlap: bigint } | null = null;
    for (const [key, overlap] of overlapByKey) {
      if (
        best === null ||
        overlap > best.overlap ||
        (overlap === best.overlap && (order.get(key) ?? 0) < (order.get(best.key) ?? 0))
      ) {
        best = { key, overlap };
      }
    }
    if (best === null) {
      unassigned.push({ regionId: region.id, reason: "echo-without-source" });
      continue;
    }
    const list = attached.get(best.key);
    if (list === undefined) attached.set(best.key, [region.id]);
    else list.push(region.id);
  }
  return { attached, unassigned };
}

interface TrackIndex {
  readonly items: { readonly region: SpeechRegion; readonly key: string }[];
  longestNs: bigint;
}

/** Number of items starting at or before `atNs`; items are sorted by start. */
function upperBound(items: TrackIndex["items"], atNs: bigint): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const item = items[mid];
    if (item !== undefined && item.region.startNs <= atNs) low = mid + 1;
    else high = mid;
  }
  return low;
}

function compareConstraints(a: BoundaryConstraint, b: BoundaryConstraint): number {
  if (a.origin !== b.origin) return a.origin === "auto" ? -1 : 1;
  return a.seq - b.seq;
}

function compareRegions(a: SpeechRegion, b: SpeechRegion): number {
  return (
    compareBig(a.startNs, b.startNs) ||
    compareBig(a.endNs, b.endNs) ||
    compareText(a.trackKey, b.trackKey) ||
    compareText(a.id, b.id)
  );
}

function covers(session: CallSession, atNs: bigint): boolean {
  return session.startNs <= atNs && (session.endNs === null || atNs <= session.endNs);
}

function midpoint(region: SpeechRegion): bigint {
  return (region.startNs + region.endNs) / 2n;
}

function spanStart(members: readonly SpeechRegion[]): bigint {
  return members.reduce((min, region) => minBig(min, region.startNs), members[0]?.startNs ?? 0n);
}

function spanEnd(members: readonly SpeechRegion[]): bigint {
  return members.reduce((max, region) => maxBig(max, region.endNs), members[0]?.endNs ?? 0n);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted(compareText);
}

function compareBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Code-unit order, independent of the host locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
