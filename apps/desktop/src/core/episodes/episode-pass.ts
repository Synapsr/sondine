import { GROUPING_V4 } from "@sondine/core";
import {
  applyEpisodePlan,
  deleteUnlinkedTranscripts,
  dictationApps,
  dropRecordingsKeepingNothing,
  linkedTranscripts,
  loadAppTapsBetween,
  loadCallsBetween,
  loadClosedEpisodesBetween,
  loadEnds,
  loadListensBetween,
  loadSelfEchoes,
  loadSelfPlaybacksBetween,
  loadOpenEpisodes,
  loadOpenRunClocks,
  loadUngroupedRegions,
  loadWebPlaysBetween,
  transaction,
  type ApplyReport,
  type ClosedEpisode,
  type Database,
  type DroppedEpisodes,
} from "@sondine/db";
import { planEpisodes, playedBack, type EndPoint } from "./episode-plan";

/** How far back a routine pass looks for regions, beyond the open episodes. */
export const PASS_HORIZON_MS = 6 * 3_600_000;

/** A late region may join an episode the user ended this long after its last speech (ADR 044). */
const END_REACH_MS = Number(GROUPING_V4.callSilenceGapNs / 1_000_000n);

/**
 * Calls, app taps and listening apps are read this far before the first
 * region: a call rejoins within it.
 */
const CALL_LOOKBACK_MS = Number(GROUPING_V4.callRejoinGapNs / 1_000_000n) + 15_000;

export interface PassOptions {
  readonly nowMs: number;
  /**
   * Scan every region, not only the recent ones: at startup and after a
   * spool reconciliation imported regions, the only ways a late region
   * arrives.
   */
  readonly fullScan: boolean;
}

export interface PassReport extends ApplyReport {
  readonly regions: number;
  readonly unplaced: number;
  /** Episodes still open: the builder passes again in 15 s while any is. */
  readonly openAfter: number;
  /** Where each episode open before and after this pass could end now (ADR 044). */
  readonly endPoints: ReadonlyMap<number, EndPoint>;
  /**
   * Episodes this pass closed that a private zone keeps nothing of (a site
   * left out, ADR 023 and 029), deleted before anything transcribed them, and
   * the transcriptions of context items the pass settled away (ADR 024), with
   * the audio blocks to scrub.
   */
  readonly dropped: DroppedEpisodes;
}

/** One grouping pass: reads the window, plans, and writes the result in one transaction. */
export function runEpisodePass(db: Database, options: PassOptions): PassReport {
  return transaction(db, () => {
    // Context the pass may settle away takes its transcription along (ADR 024).
    const linked = linkedTranscripts(db);
    const openEpisodes = loadOpenEpisodes(db);
    const oldestOpen = openEpisodes.reduce(
      (min, episode) => Math.min(min, episode.startedAtMs),
      options.nowMs,
    );
    const regions = loadUngroupedRegions(
      db,
      options.fullScan
        ? {}
        : { sinceWallMs: Math.min(oldestOpen, options.nowMs - PASS_HORIZON_MS) },
    );
    const members = new Set(
      openEpisodes.flatMap((episode) => episode.members.map((member) => member.regionId)),
    );
    const firstMs = regions.reduce(
      (min, region) => Math.min(min, region.wallStartMs),
      Number.POSITIVE_INFINITY,
    );
    const fromMs = Number.isFinite(firstMs) ? firstMs - CALL_LOOKBACK_MS : options.nowMs;
    const selfPlaybacks =
      regions.length === 0 ? [] : loadSelfPlaybacksBetween(db, fromMs, options.nowMs);
    // What the mic regions heard during them, judged against the reference (ADR 035).
    const selfEchoes = loadSelfEchoes(
      db,
      regions
        .filter((region) => playedBack(region, selfPlaybacks, options.nowMs))
        .map((region) => region.id),
    );
    const closedEpisodes = new Map<number, ClosedEpisode>();
    for (const region of regions) {
      if (members.has(region.id) || region.wallEndMs === null) continue;
      // Sondine heard on the speakers stays out of every episode, and every pass reads it again:
      // no episode to look for around it.
      if (playedBack(region, selfPlaybacks, options.nowMs, selfEchoes)) continue;
      const fromMs = region.wallStartMs - END_REACH_MS;
      for (const episode of loadClosedEpisodesBetween(db, fromMs, region.wallEndMs)) {
        closedEpisodes.set(episode.id, episode);
      }
    }
    // The user's rule as it is now: open episodes follow a change, closed ones keep theirs.
    const dictating = regions.length === 0 ? new Set<string>() : dictationApps(db);
    const { plan, unplaced, openAfter, endPoints } = planEpisodes({
      regions,
      openEpisodes,
      openRuns: loadOpenRunClocks(db),
      closedEpisodes: [...closedEpisodes.values()],
      calls: regions.length === 0 ? [] : loadCallsBetween(db, fromMs, options.nowMs),
      appTaps: regions.length === 0 ? [] : loadAppTapsBetween(db, fromMs, options.nowMs),
      selfPlaybacks,
      selfEchoes,
      webPlays: regions.length === 0 ? [] : loadWebPlaysBetween(db, fromMs, options.nowMs),
      dictations:
        dictating.size === 0
          ? []
          : loadListensBetween(db, fromMs, options.nowMs).filter((listen) =>
              dictating.has(listen.bundleId),
            ),
      ends: regions.length === 0 ? [] : loadEnds(db, fromMs - PASS_HORIZON_MS),
      nowMs: options.nowMs,
    });
    const report = applyEpisodePlan(db, plan, options.nowMs);
    // In the same transaction: a dropped episode's job never runs.
    // Repaired ones too: a late region may bring a closed episode into a zone.
    const unkept = dropRecordingsKeepingNothing(
      db,
      [...new Set([...report.closed, ...report.repaired])],
      options.nowMs,
    );
    const transcripts = deleteUnlinkedTranscripts(db, linked, {
      origin: "app",
      nowMs: options.nowMs,
    });
    const dropped = {
      episodeIds: [...unkept.episodeIds, ...transcripts.episodeIds],
      chunks: [...unkept.chunks, ...transcripts.chunks],
    };
    return {
      ...report,
      regions: regions.length,
      unplaced: unplaced.length,
      openAfter,
      endPoints,
      dropped,
    };
  });
}
