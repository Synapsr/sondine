import {
  contextHomes,
  contextHomesIn,
  dropPinnedContext,
  linkedTranscripts,
  settleContext,
} from "./context-items";
import { settleTags, tagHomes, tagHomesIn } from "./recording-tags";
import { checkpointTruncate, transaction, type CheckpointResult, type Database } from "./database";
import {
  deleteEpisode,
  deletedChunks,
  deleteUnlinkedTranscripts,
  speechPostRollMs,
  speechPreRollMs,
  type DeletedChunk,
} from "./delete-episode";
import { msToSamples } from "./deleted-ranges";
import {
  cancelJobs,
  deriveRun,
  loadMembers,
  loadTranscript,
  redecide,
  Refused,
  republish,
  retireLive,
  sampleAt,
  sizeOf,
  liveSpanOf,
  wallAt,
  writeMembers,
  type Member,
  type Transcript,
} from "./episode-boundaries";
import { cutForegroundSpans } from "./foreground";
import { outside, type Interval } from "./people";
import { bumpInputGeneration, type SegmentInput, type TurnInput } from "./publish";
import { int, intOrNull, str } from "./rows";
import type { AssertionOrigin } from "./schema/enums";

// « Supprimer ce passage » (M2; ADR 006): some sentences of a closed episode,
// and everything heard meanwhile on its tracks, go for good. A tombstone over
// the passage on each of its tracks (with the regions' roll where the passage
// leaves speech) keeps any import, regroup or late job from bringing it back;
// its audio blocks are marked for scrubbing; segments and turns over it go,
// whatever transcript holds them, with the corrections they carry; other
// assertions and the apps in front then (ADR 022) keep their parts outside. Every transcript that held some of it
// (final or live, this episode's or another grouping's) is published again
// without it at a new input generation, so a job still running on the old
// audio is refused, voice embeddings that heard it go with the old run, and
// nothing waits for a new transcription. Not undoable: ⌘Z keeps no text.
//
// Audio is scrubbed by whole spool blocks (2 s, each under its own CRC that
// the archiver checks): nothing of the passage stays on disk, and the edges
// of the sentences kept around it may lose up to that much sound, never their
// text.

export type PassageRefusal =
  /** No such closed episode. */
  | "missing"
  /** The passage does not meet the episode's audio. */
  | "outside";

export type DeletePassageResult =
  | { readonly deleted: false; readonly reason: PassageRefusal }
  | {
      readonly deleted: true;
      /** Nothing said was left of the episode: it was deleted whole. */
      readonly episodeDeleted: boolean;
      readonly chunks: readonly DeletedChunk[];
      readonly segmentCount: number;
      readonly checkpoint: CheckpointResult | null;
    };

interface Tombstone {
  readonly trackRunId: number;
  readonly from: number;
  readonly to: number;
}

const meets = (stones: readonly Tombstone[], trackRunId: number, start: number, end: number) =>
  stones.some(
    (stone) =>
      stone.trackRunId === trackRunId && start < stone.to && Math.max(end, start + 1) > stone.from,
  );

/** The parts of a turn outside the tombstones, its times kept in step with its samples. */
function turnOutside(turn: TurnInput, stones: readonly Tombstone[]): TurnInput[] {
  const cuts = stones
    .filter((stone) => stone.trackRunId === turn.trackRunId)
    .map((stone): Interval => [stone.from, stone.to])
    .toSorted((a, b) => a[0] - b[0]);
  const parts = outside([turn.sampleStart, Math.max(turn.sampleEnd, turn.sampleStart + 1)], cuts);
  if (parts.length === 1 && parts[0]?.[0] === turn.sampleStart && parts[0][1] >= turn.sampleEnd) {
    return [turn];
  }
  const msPerSample = (turn.endMs - turn.startMs) / Math.max(1, turn.sampleEnd - turn.sampleStart);
  const msAt = (sample: number) =>
    turn.startMs + Math.round((sample - turn.sampleStart) * msPerSample);
  return parts
    .map(([a, b]) => ({ ...turn, sampleStart: a, sampleEnd: b, startMs: msAt(a), endMs: msAt(b) }))
    .filter((part) => part.endMs > part.startMs);
}

/** The member nearest to a wall time: its region's clock places that time on the track. */
function nearest(members: readonly Member[], ms: number): Member {
  const distance = (member: Member) => {
    const start = wallAt(member, member.start);
    const end = wallAt(member, member.end);
    return ms < start ? start - ms : ms > end ? ms - end : 0;
  };
  return members.reduce((best, member) => (distance(member) < distance(best) ? member : best));
}

/**
 * One tombstone per track the passage reaches, over the whole passage, with
 * the roll of every region whose own start or end falls inside it
 * (transcription heard that roll).
 */
function tombstonesOf(
  members: readonly Member[],
  fromMs: number,
  toMs: number,
): { stone: Tombstone; wallFrom: number; wallTo: number }[] {
  const tracks = new Map<number, Member[]>();
  for (const member of members) {
    tracks.set(member.trackRunId, [...(tracks.get(member.trackRunId) ?? []), member]);
  }
  return [...tracks].flatMap(([trackRunId, held]) => {
    const head = nearest(held, fromMs);
    const tail = nearest(held, toMs);
    const a = sampleAt(head, fromMs);
    const b = Math.max(sampleAt(tail, toMs), a + 1);
    let from = a;
    let to = b;
    for (const member of held) {
      const pre = msToSamples(speechPreRollMs, member.sampleRate);
      const post = msToSamples(speechPostRollMs, member.sampleRate);
      if (member.start === member.regionStart && member.start >= a && member.start <= b) {
        from = Math.min(from, member.start - pre);
      }
      if (member.end === member.regionEnd && member.end >= a && member.end <= b) {
        to = Math.max(to, member.end + post);
      }
    }
    from = Math.max(0, from);
    // Only a track whose audio the passage reaches: its slices with their roll.
    const reaches = held.some(
      (member) =>
        from < member.end + msToSamples(speechPostRollMs, member.sampleRate) &&
        to > member.start - msToSamples(speechPreRollMs, member.sampleRate),
    );
    if (!reaches) return [];
    const wallFrom = Math.min(fromMs, wallAt(head, from));
    const wallTo = Math.max(toMs, wallAt(tail, to));
    return [{ stone: { trackRunId, from, to }, wallFrom, wallTo }];
  });
}

/** An episode's transcripts as they were before the deletion: final, and live. */
interface Held {
  readonly episodeId: number;
  readonly final: Transcript | null;
  readonly live: Transcript | null;
}

/**
 * Publishes an episode's transcripts again without what the tombstones took,
 * at a new input generation; returns the diarization for its size decision.
 */
function rebuild(
  db: Database,
  held: Held,
  stones: readonly Tombstone[],
  nowMs: number,
): { speakers: number; turns: number } | null {
  const { episodeId, final, live } = held;
  cancelJobs(db, episodeId, nowMs);
  retireLive(db, episodeId);
  const generation = bumpInputGeneration(db, episodeId, nowMs);
  const without = (transcript: Transcript) => ({
    segments: transcript.segments.filter(
      (segment: SegmentInput) =>
        !meets(stones, segment.trackRunId, segment.sampleStart, segment.sampleEnd),
    ),
    turns: transcript.turns.flatMap((turn) => turnOutside(turn, stones)),
  });
  let diarization: { speakers: number; turns: number } | null = null;
  if (final !== null) {
    const rest = without(final);
    const run = deriveRun(db, final.runId, episodeId, generation, "passage", nowMs);
    diarization = republish(db, episodeId, run, generation, rest.segments, rest.turns, nowMs);
    // Still due for a complete analysis, as it was; the rest shows meanwhile.
    if (!final.current) {
      bumpInputGeneration(db, episodeId, nowMs);
      diarization = null;
    }
  } else if (live !== null) {
    const rest = without(live);
    const run = deriveRun(db, live.runId, episodeId, generation, "passage", nowMs);
    republish(db, episodeId, run, generation, rest.segments, rest.turns, nowMs, "asr_live");
  }
  return diarization;
}

/**
 * Deletes what was heard over `[fromMs, toMs)` (wall clock) in a closed
 * episode, in one transaction; removing the audio bytes is left to the
 * caller, as for `deleteEpisode`.
 */
export function deletePassage(
  db: Database,
  input: {
    readonly episodeId: number;
    readonly fromMs: number;
    readonly toMs: number;
    readonly origin: AssertionOrigin;
    readonly nowMs: number;
  },
): DeletePassageResult {
  const { episodeId, fromMs, toMs, origin, nowMs } = input;
  if (!(fromMs < toMs)) return { deleted: false, reason: "outside" };
  let outcome: DeletePassageResult;
  try {
    outcome = transaction(db, (): DeletePassageResult => {
      const episode = db
        .statement("SELECT id FROM episodes WHERE id = ? AND state = 'closed'")
        .get(episodeId);
      if (episode === undefined) return { deleted: false, reason: "missing" };
      const members = loadMembers(db, episodeId);
      if (members.length === 0) return { deleted: false, reason: "outside" };
      const planned = tombstonesOf(members, fromMs, toMs);
      if (planned.length === 0) return { deleted: false, reason: "outside" };
      const passage = planned.map(({ stone }) => stone);
      // Its context, and the context anchored in the passage, before anything moves (ADR 024).
      const homes = new Map([...contextHomesIn(db, passage), ...contextHomes(db, [episodeId])]);
      // Its tags too (ADR 039): what the passage took of their anchor moves to the audio left.
      const tags = new Map([...tagHomesIn(db, passage), ...tagHomes(db, [episodeId])]);
      const linked = linkedTranscripts(db);

      // The episode keeps its audio around the passage; a hole inside a slice stays a hole.
      const kept = members.flatMap((member): Member[] => {
        const stone = passage.find((candidate) => candidate.trackRunId === member.trackRunId);
        if (stone === undefined || stone.to <= member.start || stone.from >= member.end) {
          return [member];
        }
        if (stone.from <= member.start && stone.to >= member.end) return [];
        if (stone.from <= member.start) return [{ ...member, start: stone.to }];
        if (stone.to >= member.end) return [{ ...member, end: stone.from }];
        return [member];
      });
      const own: Held = {
        episodeId,
        final: loadTranscript(db, episodeId, "asr"),
        live: loadTranscript(db, episodeId, "asr_live"),
      };
      // Nothing left to read or hear goes whole: no slice left, or a complete
      // transcript with nothing said outside the passage. A live or stale one
      // may not have heard the rest yet.
      const whole =
        kept.length === 0 ||
        (own.final !== null &&
          own.final.current &&
          own.final.segments.every((segment) =>
            meets(passage, segment.trackRunId, segment.sampleStart, segment.sampleEnd),
          ));
      // Everything that goes: the passage, and the episode whole when it goes.
      const stones = whole
        ? [
            ...passage,
            ...members.map((member) => ({
              trackRunId: member.trackRunId,
              from: Math.max(
                0,
                member.start -
                  (member.start <= member.regionStart
                    ? msToSamples(speechPreRollMs, member.sampleRate)
                    : 0),
              ),
              to:
                member.end +
                (member.end >= member.regionEnd
                  ? msToSamples(speechPostRollMs, member.sampleRate)
                  : 0),
            })),
          ]
        : passage;

      // Every other episode whose transcript or audio reaches what goes, as it was.
      const overlapping = `track_run_id = ? AND sample_start < ? AND max(sample_end, sample_start + 1) > ?`;
      const holders = db.statement(
        `SELECT episode_id FROM segments WHERE ${overlapping}
         UNION SELECT episode_id FROM speaker_turns WHERE ${overlapping}`,
      );
      const listeners = db.statement(
        `SELECT DISTINCT m.episode_id FROM episode_regions m
         JOIN speech_regions r ON r.id = m.speech_region_id
         WHERE r.track_run_id = ? AND m.slice_sample_start < ? + ?
           AND coalesce(m.slice_sample_end, r.sample_end, m.slice_sample_start + 1) + ? > ?`,
      );
      const others = new Set<number>();
      for (const stone of stones) {
        const at = [stone.trackRunId, stone.to, stone.from] as const;
        for (const row of holders.all(...at, ...at)) others.add(int(row, "episode_id"));
        const rate =
          members.find((member) => member.trackRunId === stone.trackRunId)?.sampleRate ?? 16_000;
        const roll = msToSamples(speechPreRollMs + speechPostRollMs, rate);
        for (const row of listeners.all(stone.trackRunId, stone.to, roll, roll, stone.from)) {
          others.add(int(row, "episode_id"));
        }
      }
      others.delete(episodeId);
      const held: Held[] = [...others].map((id) => ({
        episodeId: id,
        final: loadTranscript(db, id, "asr"),
        live: loadTranscript(db, id, "asr_live"),
      }));

      const insertTombstone = db.statement(
        `INSERT INTO deleted_ranges
           (scope, track_run_id, sample_start, sample_end, wall_start_ms, wall_end_ms, origin, created_at_ms)
         VALUES ('track_run', ?, ?, ?, ?, ?, ?, ?)`,
      );
      const markChunks = db.statement(
        `UPDATE chunks SET audio_state = 'deleted'
         WHERE track_run_id = ? AND sample_start < ? AND sample_start + sample_count > ?
           AND audio_state <> 'deleted' RETURNING id`,
      );
      const unindex = db.statement(
        `INSERT INTO segments_fts (segments_fts, rowid, search_text)
         SELECT 'delete', id, search_text FROM segments WHERE ${overlapping}`,
      );
      // A correction leaves with the segment it corrected, wherever its anchor lies.
      const deleteCorrections = db.statement(
        `DELETE FROM user_assertions WHERE id IN (
           SELECT edit_id FROM segments WHERE ${overlapping} AND edit_id IS NOT NULL)`,
      );
      const deleteSegments = db.statement(`DELETE FROM segments WHERE ${overlapping}`);
      const deleteTurns = db.statement(`DELETE FROM speaker_turns WHERE ${overlapping}`);
      const edits = db.statement(
        `DELETE FROM user_assertions WHERE kind = 'transcript_edit' AND ${overlapping}`,
      );
      const anchors = db.statement(`SELECT * FROM user_assertions WHERE ${overlapping}`);
      const removeAnchor = db.statement("DELETE FROM user_assertions WHERE id = ?");
      const keepAnchor = db.statement(
        `INSERT INTO user_assertions (kind, track_run_id, sample_start, sample_end, payload, origin,
           created_at_ms, revoked_at_ms, person_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const chunkIds: number[] = [];
      let segmentCount = 0;
      // The passage itself (its gaps between regions included); the episode's
      // own slices, when it goes whole, are deleteEpisode's.
      for (const { stone, wallFrom, wallTo } of planned) {
        insertTombstone.run(
          stone.trackRunId,
          stone.from,
          stone.to,
          wallFrom,
          Math.max(wallTo, wallFrom + 1),
          origin,
          nowMs,
        );
        const at = [stone.trackRunId, stone.to, stone.from] as const;
        for (const row of markChunks.all(...at)) chunkIds.push(int(row, "id"));
        unindex.run(...at);
        deleteCorrections.run(...at);
        segmentCount += Number(deleteSegments.run(...at).changes);
        deleteTurns.run(...at);
        cutForegroundSpans(db, stone.trackRunId, stone.from, stone.to);
        // What was pinned to a sentence of the passage goes with it.
        dropPinnedContext(db, stone.trackRunId, stone.from, stone.to);
        // Corrections hold the words said; the user's other word stays on the rest.
        edits.run(...at);
        for (const row of anchors.all(...at)) {
          const anchor: Interval = [
            int(row, "sample_start"),
            Math.max(int(row, "sample_end"), int(row, "sample_start") + 1),
          ];
          removeAnchor.run(int(row, "id"));
          for (const [a, b] of outside(anchor, [[stone.from, stone.to]])) {
            keepAnchor.run(
              str(row, "kind"),
              stone.trackRunId,
              a,
              b,
              str(row, "payload"),
              str(row, "origin"),
              int(row, "created_at_ms"),
              intOrNull(row, "revoked_at_ms"),
              intOrNull(row, "person_id"),
            );
          }
        }
      }

      if (whole) {
        const removed = deleteEpisode(db, episodeId, { origin, nowMs, checkpoint: false });
        for (const other of held) rebuild(db, other, stones, nowMs);
        settleContext(db, homes, nowMs);
        settleTags(db, tags);
        const transcripts = deleteUnlinkedTranscripts(db, linked, { origin, nowMs });
        return {
          deleted: true,
          episodeDeleted: true,
          chunks: [
            ...deletedChunks(db, chunkIds),
            ...(removed.deleted ? removed.chunks : []),
            ...transcripts.chunks,
          ],
          segmentCount:
            segmentCount + (removed.deleted ? removed.segmentCount : 0) + transcripts.segmentCount,
          checkpoint: null,
        };
      }
      // Other episodes that heard the passage, or hold its audio, lose it too.
      for (const other of held) rebuild(db, other, stones, nowMs);

      const previous = sizeOf(db, episodeId);
      writeMembers(db, episodeId, kept);
      const drop = db.statement(
        `DELETE FROM speech_regions WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM episode_regions WHERE speech_region_id = ?)`,
      );
      for (const id of new Set(members.map((member) => member.regionId))) drop.run(id, id);
      const diarization = rebuild(db, own, stones, nowMs);
      redecide(db, episodeId, liveSpanOf(db, kept), diarization, previous, nowMs);
      // The conversation keeps its context and tags: what the passage took out of its audio moves.
      settleContext(db, homes, nowMs);
      settleTags(db, tags);
      // A transcription pinned to a sentence of the passage goes with its item.
      const transcripts = deleteUnlinkedTranscripts(db, linked, { origin, nowMs });
      return {
        deleted: true,
        episodeDeleted: false,
        chunks: [...deletedChunks(db, chunkIds), ...transcripts.chunks],
        segmentCount: segmentCount + transcripts.segmentCount,
        checkpoint: null,
      };
    });
  } catch (error) {
    if (error instanceof Refused) return { deleted: false, reason: "outside" };
    throw error;
  }
  if (!outcome.deleted) return outcome;
  return { ...outcome, checkpoint: checkpointTruncate(db) };
}
