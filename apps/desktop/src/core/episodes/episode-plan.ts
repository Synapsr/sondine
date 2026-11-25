import {
  decideSize,
  endLaneOf,
  GROUPING_V4,
  GROUPING_VERSION,
  groupEpisodes,
  kindInputsOf,
  SIZE_TABLE_VERSION,
  sizeInputOf,
  type AppTap,
  type CallTransition,
  type DictationSpan,
  type Episode,
  type EpisodeEnd,
  type EpisodeSize,
  type SpeechRegion,
} from "@sondine/core";
import { speechPostRollMs, speechPreRollMs } from "@sondine/db";
import type {
  ClosedEpisode,
  EpisodeMember,
  EpisodePlan,
  EpisodeRepair,
  EpisodeWrite,
  OpenEpisode,
  OpenRunClock,
  SelfEchoKind,
  SelfPlayback,
  StoredAppTap,
  StoredCall,
  StoredEnd,
  StoredListen,
  StoredRegion,
  StoredWebPlay,
} from "@sondine/db";

// One grouping pass as a pure function (ADR 016, "Episodes"): stored regions
// in, the episode writes out. The pass module reads the input and applies the
// plan in one transaction.

/** Boot estimates of one boot differ by clock adjustments only; boots are minutes apart. */
export const BOOT_TOLERANCE_MS = 60_000;

/**
 * An episode the user ended closes once every open track is imported this
 * far past its end. The helper closes a region only after this much silence
 * (its pre-roll and post-roll): one still open by then was said across the
 * end, while one closing before it, as when the user ends right after their
 * last word, ended first. The rest is room for its event.
 */
export const END_IMPORT_MS = speechPreRollMs + speechPostRollMs + 700;

const NS_PER_US = 1_000n;
const NS_PER_MS = 1_000_000n;
const END_IMPORT_NS = BigInt(END_IMPORT_MS) * NS_PER_MS;

export interface PlanInput {
  /** Regions no closed episode holds. */
  readonly regions: readonly StoredRegion[];
  readonly openEpisodes: readonly OpenEpisode[];
  readonly openRuns: readonly OpenRunClock[];
  /** Closed episodes around the window's closed regions, for late-region repair. */
  readonly closedEpisodes: readonly ClosedEpisode[];
  /** Calls around the window (helper `call` events). */
  readonly calls?: readonly StoredCall[];
  /** App track runs around the window. */
  readonly appTaps?: readonly StoredAppTap[];
  /** Dictation apps listening around the window (listen spans of the apps that count). */
  readonly dictations?: readonly StoredListen[];
  /** Sondine playing recordings back around the window (ADR 020). */
  readonly selfPlaybacks?: readonly SelfPlayback[];
  /** What the mic regions heard during them, by region id, once judged (ADR 035). */
  readonly selfEchoes?: ReadonlyMap<number, SelfEchoKind>;
  /** Browser tabs playing pages around the window (ADR 023). */
  readonly webPlays?: readonly StoredWebPlay[];
  /** Episodes the user ended around the window (ADR 044). */
  readonly ends?: readonly StoredEnd[];
  readonly nowMs: number;
}

/** What ending an episode now needs: its lane, and now on its boot's capture clock. */
export interface EndPoint {
  readonly lane: string;
  readonly continuousUs: number;
  readonly bootWallMs: number;
}

export interface PlanResult {
  readonly plan: EpisodePlan;
  /** Regions without any clock to place them; they wait for one. */
  readonly unplaced: readonly number[];
  /** Episodes still open after this pass. */
  readonly openAfter: number;
  /** Where each episode still open could end now, by id. */
  readonly endPoints: ReadonlyMap<number, EndPoint>;
}

/** A region, or the part of it from `from` on, on its boot's continuous timeline. */
interface Placed {
  readonly region: StoredRegion;
  readonly bootWallMs: number;
  /** First sample of this part. */
  readonly from: number;
  readonly startNs: bigint;
  /** Null while the region is open. */
  readonly endNs: bigint | null;
}

interface Boot {
  /** The latest estimate: its "now" is the earliest, so episodes never close early. */
  bootWallMs: number;
  /** The estimate of its latest clock reading: the wall clock as it is now. */
  latest: { readonly ns: bigint; readonly bootWallMs: number };
  readonly ends: StoredEnd[];
  readonly regions: Placed[];
  readonly watermarksNs: bigint[];
  readonly calls: StoredCall[];
  readonly appTaps: StoredAppTap[];
  readonly dictations: StoredListen[];
}

export function planEpisodes(input: PlanInput): PlanResult {
  const unplaced: number[] = [];
  const placed: Placed[] = [];
  for (const region of input.regions) {
    const at = place(region);
    if (at === null) unplaced.push(region.id);
    else placed.push(at);
  }

  const openMembers = new Set(
    input.openEpisodes.flatMap((episode) => episode.members.map((member) => member.regionId)),
  );
  const playbacks = input.selfPlaybacks ?? [];
  const heard = input.selfEchoes ?? new Map<number, SelfEchoKind>();
  const { repairs, repaired } = planRepairs(
    placed.filter(
      (item) =>
        !openMembers.has(item.region.id) && !playedBack(item.region, playbacks, input.nowMs, heard),
    ),
    input.closedEpisodes,
    input.dictations ?? [],
  );
  const boots = partitionByBoot(
    placed.flatMap((item) => {
      const rest = repaired.get(item.region.id);
      return rest === undefined ? [item] : rest === null ? [] : [rest];
    }),
    input.openRuns,
  );
  for (const call of input.calls ?? []) bootFor(boots, bootOf(call.started))?.calls.push(call);
  for (const tap of input.appTaps ?? []) bootFor(boots, bootOf(tap.start))?.appTaps.push(tap);
  for (const span of input.dictations ?? []) {
    bootFor(boots, bootOf(span.started))?.dictations.push(span);
  }
  for (const end of input.ends ?? []) bootFor(boots, end.bootWallMs)?.ends.push(end);

  const outputs: Output[] = [];
  for (const boot of boots) {
    if (boot.regions.length === 0) continue;
    outputs.push(...groupBoot(boot, input.nowMs, playbacks, heard, input.webPlays ?? []));
  }

  const identities = assignIdentities(outputs, input.openEpisodes);
  const previousSize = new Map(input.openEpisodes.map((episode) => [episode.id, episode.size]));
  const writes: EpisodeWrite[] = outputs.map((output, index) => {
    const episodeId = identities.get(index) ?? null;
    return toWrite(output, episodeId, episodeId === null ? null : previousSize.get(episodeId));
  });
  const matched = new Set(identities.values());
  const endPoints = new Map<number, EndPoint>();
  for (const [index, episodeId] of identities) {
    const output = outputs[index];
    const [lane] = output?.episode.lanes ?? [];
    if (output === undefined || output.close || lane === undefined) continue;
    const { bootWallMs } = output.boot.latest;
    endPoints.set(episodeId, {
      lane: endLaneOf(lane),
      continuousUs: Math.max(0, input.nowMs - bootWallMs) * 1000,
      bootWallMs,
    });
  }
  const deletes = input.openEpisodes.map((episode) => episode.id).filter((id) => !matched.has(id));

  return {
    plan: {
      groupingVersion: GROUPING_VERSION,
      classifierVersion: SIZE_TABLE_VERSION,
      writes,
      deletes,
      repairs,
    },
    unplaced,
    openAfter: writes.filter((write) => !write.close).length,
    endPoints,
  };
}

/** When the boot of a clock reading began, in wall ms: the same for every reading of one boot. */
function bootOf(clock: { readonly wallMs: number; readonly continuousUs: number }): number {
  return clock.wallMs - Math.floor(clock.continuousUs / 1000);
}

/**
 * The speech the VAD heard in a closed region (or part of one, its share),
 * without the pauses its span holds (ADR 007, "Size"): six coughs 4 s apart span 2.5 s of regions but hold
 * 1.1 s of voice. An open region, or one closed before the helper reported
 * it, counts its whole span.
 */
function voicedMsOf(
  { region, from }: { readonly region: StoredRegion; readonly from: number },
  spanMs: number,
  to = region.sampleEnd,
): number {
  if (region.voicedSamples === null || region.sampleEnd === null || to === null) return spanMs;
  const share = (to - from) / Math.max(1, region.sampleEnd - region.sampleStart);
  return Math.min(spanMs, (region.voicedSamples * share * 1000) / region.sampleRate);
}

/** Continuous time of a number of samples of a region. */
const spanNs = (region: StoredRegion, samples: number): bigint =>
  (BigInt(samples) * 1_000_000_000n) / BigInt(region.sampleRate);

/**
 * Continuous time of a region, from its own clocks or from the chunk holding
 * its first sample; from its cut on when an episode the user ended holds what
 * comes before (`sampleAfter` rounds up, so this start is never before the end).
 */
function place(region: StoredRegion): Placed | null {
  const whole = placeWhole(region);
  if (whole === null || region.from <= region.sampleStart) return whole;
  const startNs = whole.startNs + spanNs(region, region.from - region.sampleStart);
  return {
    ...whole,
    from: region.from,
    startNs,
    endNs: whole.endNs !== null && whole.endNs < startNs ? startNs : whole.endNs,
  };
}

function placeWhole(region: StoredRegion): Placed | null {
  const rate = BigInt(region.sampleRate);
  const from = region.sampleStart;
  const spanNs =
    region.sampleEnd === null
      ? null
      : (BigInt(region.sampleEnd - region.sampleStart) * 1_000_000_000n) / rate;
  if (region.continuousStartUs !== null) {
    const startNs = BigInt(region.continuousStartUs) * NS_PER_US;
    const endNs =
      region.continuousEndUs !== null && region.sampleEnd !== null
        ? BigInt(region.continuousEndUs) * NS_PER_US
        : spanNs === null
          ? null
          : startNs + spanNs;
    return {
      region,
      bootWallMs: bootOf({ wallMs: region.wallStartMs, continuousUs: region.continuousStartUs }),
      from,
      startNs,
      endNs: endNs !== null && endNs < startNs ? startNs : endNs,
    };
  }
  const clock = region.chunkClock;
  if (clock === null) return null;
  const startNs =
    BigInt(clock.continuousUs) * NS_PER_US +
    (BigInt(region.sampleStart - clock.sampleStart) * 1_000_000_000n) / rate;
  return {
    region,
    bootWallMs: bootOf(clock),
    from,
    startNs,
    endNs: spanNs === null ? null : startNs + spanNs,
  };
}

function runWatermark(run: OpenRunClock): { bootWallMs: number; ns: bigint } | null {
  if (run.lastChunk !== null) {
    const chunk = run.lastChunk;
    return {
      bootWallMs: bootOf(chunk),
      ns:
        BigInt(chunk.continuousUs) * NS_PER_US +
        (BigInt(chunk.sampleCount) * 1_000_000_000n) / BigInt(run.sampleRate),
    };
  }
  if (run.anchor !== null) {
    return {
      bootWallMs: bootOf(run.anchor),
      ns: BigInt(run.anchor.continuousUs) * NS_PER_US,
    };
  }
  return null;
}

/**
 * Continuous time restarts at boot: regions are grouped per boot, found by
 * clustering each clock reading's boot estimate (wall minus continuous).
 */
function partitionByBoot(placed: readonly Placed[], runs: readonly OpenRunClock[]): Boot[] {
  const boots: Boot[] = [];
  const sorted = placed.toSorted((a, b) => a.bootWallMs - b.bootWallMs);
  for (const item of sorted) {
    const last = boots.at(-1);
    if (last !== undefined && item.bootWallMs - last.bootWallMs <= BOOT_TOLERANCE_MS) {
      last.regions.push(item);
      last.bootWallMs = Math.max(last.bootWallMs, item.bootWallMs);
      noteClock(last, item.startNs, item.bootWallMs);
    } else {
      boots.push({
        bootWallMs: item.bootWallMs,
        latest: { ns: item.startNs, bootWallMs: item.bootWallMs },
        ends: [],
        regions: [item],
        watermarksNs: [],
        calls: [],
        appTaps: [],
        dictations: [],
      });
    }
  }
  for (const run of runs) {
    const mark = runWatermark(run);
    // A run without any clock cannot be placed: it holds every boot back.
    if (mark === null) {
      for (const boot of boots) boot.watermarksNs.push(0n);
      continue;
    }
    const boot = bootFor(boots, mark.bootWallMs);
    if (boot === undefined) continue;
    boot.watermarksNs.push(mark.ns);
    noteClock(boot, mark.ns, mark.bootWallMs);
  }
  return boots;
}

function noteClock(boot: Boot, ns: bigint, bootWallMs: number): void {
  if (ns >= boot.latest.ns) boot.latest = { ns, bootWallMs };
}

function bootFor(boots: readonly Boot[], bootWallMs: number): Boot | undefined {
  return boots.find(
    (candidate) => Math.abs(candidate.bootWallMs - bootWallMs) <= BOOT_TOLERANCE_MS,
  );
}

interface Output {
  readonly episode: Episode;
  readonly boot: Boot;
  readonly members: readonly EpisodeMember[];
  readonly close: boolean;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  readonly primaryAppId: number | null;
}

function groupBoot(
  boot: Boot,
  nowMs: number,
  playbacks: readonly SelfPlayback[],
  heard: ReadonlyMap<number, SelfEchoKind>,
  plays: readonly StoredWebPlay[],
): Output[] {
  const nowNs = BigInt(Math.max(0, nowMs - boot.bootWallMs)) * NS_PER_MS;
  let untilNs = nowNs;
  for (const item of boot.regions) {
    const end = item.endNs ?? item.startNs;
    if (end > untilNs) untilNs = end;
  }
  const byId = new Map(boot.regions.map((item) => [String(item.region.id), item]));
  const appTaps = boot.appTaps.map((tap): AppTap => ({
    bundleId: tap.bundleId,
    startNs: BigInt(tap.start.continuousUs) * NS_PER_US,
    endNs: tap.endContinuousUs === null ? null : BigInt(tap.endContinuousUs) * NS_PER_US,
  }));
  const regions: SpeechRegion[] = boot.regions.map((item) => {
    const endNs = item.endNs ?? untilNs;
    const midNs = (item.startNs + endNs) / 2n;
    const tapped = new Set(
      appTaps
        .filter((tap) => tap.startNs <= midNs && (tap.endNs === null || midNs <= tap.endNs))
        .map((tap) => tap.bundleId),
    );
    const pageKey = pageOf(item.region, plays, nowMs, tapped);
    return {
      id: String(item.region.id),
      trackKey: item.region.trackKey,
      trackKind: item.region.sourceKind,
      startNs: item.startNs,
      endNs,
      voicedMs: voicedMsOf(item, Number((endNs - item.startNs) / NS_PER_MS)),
      ...(playedBack(item.region, playbacks, nowMs, heard)
        ? { echoFlag: { kind: "self-playback" as const } }
        : {}),
      appContext: {
        ...(item.region.bundleId === null ? {} : { bundleId: item.region.bundleId }),
        ...(item.region.sourceKind !== "system" || item.region.attributedBundleId === null
          ? {}
          : { attributedBundleId: item.region.attributedBundleId }),
        ...(pageKey === null ? {} : { pageKey }),
        isCallApp: false,
        callActive: false,
      },
    };
  });
  const ends = boot.ends.map((end): EpisodeEnd => {
    const heard = boot.regions.find(
      ({ region, from }) =>
        region.trackRunId === end.trackRunId &&
        from <= end.sampleStart &&
        (region.sampleEnd === null || end.sampleStart < region.sampleEnd),
    );
    return {
      atNs: endNsOf(end),
      lane: end.lane,
      ...(heard === undefined ? {} : { regionId: String(heard.region.id) }),
    };
  });
  const result = groupEpisodes({
    regions,
    ends,
    calls: callTransitions(boot.calls, untilNs),
    appTaps,
    dictations: dictationSpans(boot.dictations, untilNs),
    untilNs,
  });
  const imported = (ns: bigint) =>
    [untilNs, ...boot.watermarksNs].every((mark) => mark >= ns + END_IMPORT_NS);
  // What an open region says past an end is speech only once the end is imported past.
  const unheard = (episode: Episode) =>
    episode.regionIds.every((id) => byId.get(id)?.endNs === null) &&
    ends.some(({ atNs }) => atNs === episode.startNs && !imported(atNs));
  return result.episodes
    .filter((episode) => !unheard(episode))
    .map((episode) => {
      const members = membersOf(episode, byId, untilNs);
      const gapNs = episode.lanes.some((lane) => lane.kind === "media")
        ? GROUPING_V4.mediaGapNs
        : GROUPING_V4.inPersonGapNs;
      const complete =
        episode.endedAtNs === null
          ? boot.watermarksNs.every((mark) => mark >= episode.endNs + gapNs)
          : imported(episode.endedAtNs);
      const items = episode.regionIds.flatMap((id) => byId.get(id) ?? []);
      return {
        episode,
        boot,
        members,
        close: episode.closeReason !== null && complete,
        ...wallSpan(members, items),
        // A dictation's app is the one it was said to: its mic speech names no app.
        primaryAppId: dictationApp(episode, boot.dictations) ?? primaryApp(items),
      };
    });
}

/**
 * A stored call as grouping transitions on its boot's continuous timeline,
 * keyed by app so the spans of one app join (ADR 007: a call that restarts
 * within 45 s is the same call). Clock skew can put a transition just past
 * `untilNs`: an end there is left out (the call is still on at `untilNs`), a
 * start there too (it has not started yet).
 */
function callTransitions(calls: readonly StoredCall[], untilNs: bigint): CallTransition[] {
  const out: CallTransition[] = [];
  for (const call of calls) {
    const base = { callKey: call.bundleId, callId: call.uid, bundleId: call.bundleId };
    const startNs = BigInt(call.started.continuousUs) * NS_PER_US;
    if (startNs > untilNs) continue;
    out.push({ ...base, atNs: startNs, state: "active" });
    if (call.ended === null) continue;
    const endNs = BigInt(call.ended.continuousUs) * NS_PER_US;
    if (endNs <= untilNs) out.push({ ...base, atNs: endNs, state: "ended" });
  }
  return out;
}

/**
 * A mic region the microphone heard while Sondine played a recording on the
 * speakers: its wall midpoint (an open region's reaching now) falls in one
 * of those playbacks. It is Sondine, not the room, and no episode holds it,
 * unless its judgement against the `self:playback` reference (ADR 035,
 * `heard`) found someone speaking: then it is the room's like any other.
 * Until judged (open, or the reference not yet in), and when the reference
 * covers too little of it, it stays out (ADR 020). Through headphones the
 * microphone hears none of it, so nothing is left out.
 */
export function playedBack(
  region: StoredRegion,
  playbacks: readonly SelfPlayback[],
  nowMs: number,
  heard: ReadonlyMap<number, SelfEchoKind> = new Map(),
): boolean {
  if (region.sourceKind !== "input") return false;
  const mid = (region.wallStartMs + (region.wallEndMs ?? nowMs)) / 2;
  const during = playbacks.some(
    (playback) =>
      playback.route === "speakers" && playback.startedWallMs <= mid && mid <= playback.endedWallMs,
  );
  return during && heard.get(region.id) !== "near-end";
}

/**
 * The page an app or `system` region heard, by wall time at its midpoint (an
 * open region's reaching now): the one page its app's browser reported
 * playing then. A `system:other` region macOS named no app for (several
 * apps held their output open) takes the one page any browser played then,
 * among the browsers without a track of their own at that moment (`tapped`,
 * ADR 026: such a browser plays nothing into `system:other`). None when no
 * page played, or several did at once (two tabs mix on one track: nothing
 * tells them apart).
 */
export function pageOf(
  region: StoredRegion,
  plays: readonly StoredWebPlay[],
  nowMs: number,
  tapped: ReadonlySet<string> = new Set(),
): string | null {
  if (region.sourceKind !== "app" && region.sourceKind !== "system") return null;
  const app = region.bundleId ?? region.attributedBundleId;
  if (app === null && region.sourceKind !== "system") return null;
  const mid = (region.wallStartMs + (region.wallEndMs ?? nowMs)) / 2;
  const pages = new Set(
    plays
      .filter(
        (play) =>
          (app === null ? !tapped.has(play.bundleId) : play.bundleId === app) &&
          play.startedWallMs <= mid &&
          mid <= (play.endedWallMs ?? nowMs),
      )
      .map((play) => play.pageKey),
  );
  const [only] = pages;
  return pages.size === 1 && only !== undefined ? only : null;
}

/**
 * Stored listen spans on their boot's continuous timeline. As for calls, a
 * start past `untilNs` (clock skew) has not happened yet, and an end there
 * leaves the span listening at `untilNs`.
 */
function dictationSpans(listens: readonly StoredListen[], untilNs: bigint): DictationSpan[] {
  return listens.flatMap((listen): DictationSpan[] => {
    const startNs = BigInt(listen.started.continuousUs) * NS_PER_US;
    if (startNs > untilNs) return [];
    const endNs = listen.ended === null ? null : BigInt(listen.ended.continuousUs) * NS_PER_US;
    return [
      {
        bundleId: listen.bundleId,
        startNs,
        endNs: endNs === null || endNs > untilNs ? null : endNs,
      },
    ];
  });
}

/** The app of a dictation's lane, as stored with its listen spans. */
function dictationApp(episode: Episode, listens: readonly StoredListen[]): number | null {
  for (const lane of episode.lanes) {
    if (lane.kind !== "dictation") continue;
    const appId = listens.find((listen) => listen.bundleId === lane.bundleId)?.appId ?? null;
    if (appId !== null) return appId;
  }
  return null;
}

/** The first sample at or after `ns`. */
function sampleAfter(item: Placed, ns: bigint): number {
  const rate = BigInt(item.region.sampleRate);
  return item.from + Number(((ns - item.startNs) * rate + 999_999_999n) / 1_000_000_000n);
}

function membersOf(
  episode: Episode,
  byId: ReadonlyMap<string, Placed>,
  untilNs: bigint,
): EpisodeMember[] {
  const slices = new Map(episode.regionSlices.map((slice) => [slice.regionId, slice]));
  return episode.regionIds.flatMap((id) => {
    const item = byId.get(id);
    if (item === undefined) return [];
    const region = item.region;
    const slice = slices.get(id);
    if (slice === undefined) {
      return [{ regionId: region.id, sliceStart: item.from, sliceEnd: null }];
    }
    // A slice that reaches its region's end follows it, open or closed.
    const sliceEnd = slice.endNs >= (item.endNs ?? untilNs) ? null : sampleAfter(item, slice.endNs);
    return [{ regionId: region.id, sliceStart: sampleAfter(item, slice.startNs), sliceEnd }];
  });
}

function wallSpan(
  members: readonly EpisodeMember[],
  items: readonly Placed[],
): { startedAtMs: number; endedAtMs: number | null } {
  let startedAtMs = Number.POSITIVE_INFINITY;
  let endedAtMs: number | null = Number.NEGATIVE_INFINITY;
  const byId = new Map(items.map((item) => [item.region.id, item.region]));
  for (const member of members) {
    const region = byId.get(member.regionId);
    if (region === undefined) continue;
    const toMs = (sample: number) =>
      region.wallStartMs + Math.round(((sample - region.sampleStart) * 1000) / region.sampleRate);
    startedAtMs = Math.min(startedAtMs, toMs(member.sliceStart));
    if (member.sliceEnd !== null) {
      if (endedAtMs !== null) endedAtMs = Math.max(endedAtMs, toMs(member.sliceEnd));
    } else if (region.wallEndMs === null) {
      endedAtMs = null;
    } else if (endedAtMs !== null) {
      endedAtMs = Math.max(endedAtMs, region.wallEndMs);
    }
  }
  if (!Number.isFinite(startedAtMs)) startedAtMs = 0;
  if (endedAtMs !== null && (!Number.isFinite(endedAtMs) || endedAtMs < startedAtMs)) {
    endedAtMs = startedAtMs;
  }
  return { startedAtMs, endedAtMs };
}

/** The app with the most speech among app-sourced regions. */
function primaryApp(items: readonly Placed[]): number | null {
  const voiced = new Map<number, bigint>();
  for (const item of items) {
    if (item.region.appId === null) continue;
    const span = (item.endNs ?? item.startNs) - item.startNs;
    voiced.set(item.region.appId, (voiced.get(item.region.appId) ?? 0n) + span);
  }
  let best: number | null = null;
  let bestNs = -1n;
  for (const [appId, ns] of voiced) {
    if (ns > bestNs || (ns === bestNs && best !== null && appId < best)) {
      best = appId;
      bestNs = ns;
    }
  }
  return best;
}

/**
 * Each output keeps the id of the open episode it shares the most regions
 * with (greedy, ties to the earlier output and the lower id); the others are
 * new. One the user ended keeps the id of the episode it begins, however much
 * was said since, and so does an episode with a transcript.
 */
function assignIdentities(
  outputs: readonly Output[],
  openEpisodes: readonly OpenEpisode[],
): Map<number, number> {
  const pairs: { output: number; episodeId: number; shared: number }[] = [];
  outputs.forEach((output, index) => {
    const ids = new Set(output.members.map((member) => member.regionId));
    for (const episode of openEpisodes) {
      const shared = new Set(
        episode.members.map((member) => member.regionId).filter((id) => ids.has(id)),
      ).size;
      if (shared > 0) pairs.push({ output: index, episodeId: episode.id, shared });
    }
  });
  pairs.sort((a, b) => b.shared - a.shared || a.output - b.output || a.episodeId - b.episodeId);
  const byOutput = new Map<number, number>();
  const taken = new Set<number>();
  outputs.forEach((output, index) => {
    const ended = output.episode.closeReason === "manual-end";
    const [first] = output.members;
    const begun = openEpisodes.find(
      (episode) =>
        !taken.has(episode.id) &&
        (ended || episode.transcribed) &&
        episode.members.some(
          (member) => member.regionId === first?.regionId && member.sliceStart === first.sliceStart,
        ),
    );
    if (begun === undefined) return;
    byOutput.set(index, begun.id);
    taken.add(begun.id);
  });
  for (const pair of pairs) {
    if (byOutput.has(pair.output) || taken.has(pair.episodeId)) continue;
    byOutput.set(pair.output, pair.episodeId);
    taken.add(pair.episodeId);
  }
  return byOutput;
}

function toWrite(
  output: Output,
  episodeId: number | null,
  previous: EpisodeSize | null | undefined,
): EpisodeWrite {
  const decision = decideSize({
    ...sizeInputOf({ ...output.episode, provisional: !output.close }),
    diarization: null,
    ...(previous === null || previous === undefined ? {} : { previous }),
  });
  return {
    episodeId,
    groupingKey: output.episode.key,
    close: output.close,
    context: output.episode.context,
    size: decision.size,
    sizeState: decision.provisional ? "provisional" : "final",
    kindInputs: kindInputsOf(decision),
    startedAtMs: output.startedAtMs,
    endedAtMs: output.endedAtMs,
    voicedMs: output.episode.voicedMs,
    primaryAppId: output.primaryAppId,
    pageKey: output.episode.pageKey,
    members: output.members,
  };
}

/**
 * The lane a live region groups in, as `groupEpisodes` assigns it outside
 * calls: a mic region said to a dictation app (`dictatedTo`) is in that app's
 * dictation lane. Pages are left out: a late region inside a closed media
 * episode of its source heard that episode's page (ADR 023).
 */
function laneOf(
  source: {
    readonly sourceKind: string;
    readonly bundleId: string | null;
    readonly trackKey: string;
  },
  dictatedTo: string | null,
): string {
  if (source.sourceKind === "input" && dictatedTo !== null) return `dictation:${dictatedTo}`;
  if (source.sourceKind === "input" || source.sourceKind === "phone") return "in_person";
  return `media:${source.bundleId ?? source.trackKey}`;
}

/**
 * The dictation app a closed mic region was said to, by wall time at its
 * midpoint (`groupEpisodes`' rule, during a call too): the earliest app that
 * started listening within the dictation window.
 */
function dictatedTo(region: StoredRegion, dictations: readonly StoredListen[]): string | null {
  if (region.sourceKind !== "input") return null;
  const mid = (region.wallStartMs + (region.wallEndMs ?? region.wallStartMs)) / 2;
  const covers = (span: StoredListen) =>
    span.started.wallMs <= mid && (span.ended === null || mid <= span.ended.wallMs);
  const windowMs = Number(GROUPING_V4.dictationWindowNs / NS_PER_MS);
  let earliest: StoredListen | null = null;
  for (const span of dictations) {
    if (!covers(span) || mid - span.started.wallMs > windowMs) continue;
    if (
      earliest === null ||
      span.started.wallMs < earliest.started.wallMs ||
      (span.started.wallMs === earliest.started.wallMs && span.bundleId < earliest.bundleId)
    ) {
      earliest = span;
    }
  }
  return earliest?.bundleId ?? null;
}

/** A part of a late region up to a cut, or to the region's end. */
interface Piece {
  readonly part: Placed;
  /** Exclusive; null: the region's end. */
  readonly to: number | null;
  /** The episode whose end cut it; null for the part after the last cut. */
  readonly of: ClosedEpisode | null;
  /** What of the region comes after. */
  readonly rest: Placed | null;
}

/** An end its episode still stops at: not one the user merged over since. */
function standingEnd(episode: ClosedEpisode): StoredEnd | null {
  const { end } = episode;
  return end !== null && episode.endedAtMs <= end.atWallMs + 1_000 ? end : null;
}

const endNsOf = (end: StoredEnd): bigint => BigInt(end.continuousUs) * NS_PER_US;

/** A late region's parts between the ends of the episodes it may join; an open region's last part is left out. */
function cutLate(item: Placed, near: readonly ClosedEpisode[]): Piece[] {
  const cuts = near
    .flatMap((episode) => {
      const end = standingEnd(episode);
      return end === null ? [] : [{ episode, atNs: endNsOf(end) }];
    })
    .toSorted((a, b) => (a.atNs < b.atNs ? -1 : a.atNs > b.atNs ? 1 : 0));
  const pieces: Piece[] = [];
  let part = item;
  for (const { episode, atNs } of cuts) {
    if (atNs <= part.startNs || (part.endNs !== null && atNs >= part.endNs)) continue;
    const to = sampleAfter(part, atNs);
    const startNs = part.startNs + spanNs(part.region, to - part.from);
    const rest: Placed = { ...part, from: to, startNs };
    pieces.push({ part, to, of: episode, rest });
    part = rest;
  }
  if (part.endNs !== null && part.region.wallEndMs !== null)
    pieces.push({ part, to: null, of: null, rest: null });
  return pieces;
}

function wallOf({ part, to }: Piece): { readonly startMs: number; readonly endMs: number } {
  const { region } = part;
  const at = (sample: number) =>
    region.wallStartMs + Math.round(((sample - region.sampleStart) * 1000) / region.sampleRate);
  const startMs = part.from === region.sampleStart ? region.wallStartMs : at(part.from);
  return { startMs, endMs: to === null ? (region.wallEndMs ?? startMs) : at(to) };
}

/**
 * A closed region that lies inside a closed episode's interval, on one of its
 * lanes and from its boot, joins it: the episode's generation is bumped and it
 * is queued again. Wall clocks can move back across a boot, so wall overlap
 * alone could join a region of a later boot to an old episode. An episode the
 * user ended (ADR 044) reaches to its end and not past it: a region said
 * across gives it the part before, and the rest is grouped, or repaired, on
 * its own (`repaired`: what is left to group of each region, null for nothing).
 */
function planRepairs(
  candidates: readonly Placed[],
  closed: readonly ClosedEpisode[],
  dictations: readonly StoredListen[],
): { repairs: EpisodeRepair[]; repaired: Map<number, Placed | null> } {
  const joined = new Map<number, { episode: ClosedEpisode; pieces: Piece[] }>();
  const repaired = new Map<number, Placed | null>();
  for (const item of candidates) {
    const region = item.region;
    const lane = laneOf(region, dictatedTo(region, dictations));
    const near = closed.filter((episode) => {
      // A dictation's mic speech was said to its app.
      const app = episode.context === "dictation" ? (episode.appBundleId ?? "") : null;
      const sameBoot = episode.clocks.some(
        (clock) => Math.abs(bootOf(clock) - item.bootWallMs) <= BOOT_TOLERANCE_MS,
      );
      return sameBoot && episode.sources.some((source) => laneOf(source, app) === lane);
    });
    for (const piece of cutLate(item, near)) {
      const episode = piece.of ?? closestTo(piece, near);
      if (episode === null) break;
      const entry = joined.get(episode.id) ?? { episode, pieces: [] };
      entry.pieces.push(piece);
      joined.set(episode.id, entry);
      repaired.set(region.id, piece.rest);
    }
  }

  const repairs: EpisodeRepair[] = [];
  for (const { episode, pieces } of joined.values()) {
    let startedAtMs = episode.startedAtMs;
    let endedAtMs = episode.endedAtMs;
    let voicedMs = episode.voicedMs;
    for (const piece of pieces) {
      const { region, from } = piece.part;
      const span = wallOf(piece);
      startedAtMs = Math.min(startedAtMs, span.startMs);
      endedAtMs = Math.max(endedAtMs, span.endMs);
      const to = piece.to ?? region.sampleEnd ?? from;
      voicedMs += Math.round(voicedMsOf(piece.part, ((to - from) * 1000) / region.sampleRate, to));
    }
    const speakers = episode.kindInputs["speakers"];
    const turns = episode.kindInputs["turns"];
    const decision = decideSize({
      context: episode.context ?? "in_person",
      voicedMs,
      elapsedMs: endedAtMs - startedAtMs,
      episodeOpen: false,
      diarization:
        typeof speakers === "number" && typeof turns === "number" ? { speakers, turns } : null,
      ...(episode.size === null ? {} : { previous: episode.size }),
    });
    repairs.push({
      episodeId: episode.id,
      addMembers: pieces.map(({ part, to }) => ({
        regionId: part.region.id,
        sliceStart: part.from,
        sliceEnd: to,
      })),
      startedAtMs,
      endedAtMs,
      voicedMs,
      size: decision.size,
      sizeState: decision.provisional ? "provisional" : "final",
      kindInputs: kindInputsOf(decision),
    });
  }
  return { repairs, repaired };
}

/** The episode whose interval a late part lies most in; null when in none. */
function closestTo(piece: Piece, near: readonly ClosedEpisode[]): ClosedEpisode | null {
  const span = wallOf(piece);
  let best: { episode: ClosedEpisode; overlap: number } | null = null;
  for (const episode of near) {
    const end = standingEnd(episode);
    if (end !== null && piece.part.startNs >= endNsOf(end)) continue;
    const reachMs = Math.max(episode.endedAtMs, end?.atWallMs ?? episode.endedAtMs);
    const overlap = Math.min(reachMs, span.endMs) - Math.max(episode.startedAtMs, span.startMs);
    if (overlap < 0) continue;
    if (best === null || overlap > best.overlap) best = { episode, overlap };
  }
  return best?.episode ?? null;
}
