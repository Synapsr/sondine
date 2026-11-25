import { transaction, type Database } from "./database";
import { int, intOrNull, str, type Row } from "./rows";
import { voicedSegments } from "./voice-speech";

// People and the names of voices (architecture §6, §8; ADR 012). A name is
// never stored on a speaker, which a reanalysis replaces: naming a voice
// writes `speaker_is` assertions over that speaker's speech (its segments
// whose times hold, merged), anchored to the capture (track run and
// samples). At read time a speaker of the current transcript takes a
// person's name only when that person's anchors cover most of the speech it
// has alone and no one else's compete there; a
// speaker split by a later run keeps the name on each part, a merge of two
// named voices stays unnamed. Naming or unnaming a voice cuts its speech out
// of older anchors (their other parts stay), so revoking a new name never
// brings an older one back, and correcting one voice never unnames another.
// Where voices may not be identified (media, a "do not identify" rule), no
// name is read, whatever was named before.

export interface Person {
  readonly id: number;
  readonly name: string;
  readonly isSelf: boolean;
}

/**
 * A name needs at least this much anchored speech under the speaker, so a
 * « hm » cut out of another voice's speech never takes its name; a shorter
 * voice takes a name only from anchors laid on it (`MIN_ANCHORED_MS` aside).
 */
const MIN_ANCHORED_MS = 1_000;
/** How far an anchor laid on a short voice may reach past it (a reanalysis moves bounds). */
const LAID_ON_SLACK_MS = 250;
/** Share of the speaker's own speech its person's anchors must cover. */
const MIN_COVERAGE = 0.5;
/**
 * Share of all anchored speech under the speaker that must be one person's;
 * any other person may cover the rest at most.
 */
const MIN_AGREEMENT = 0.8;

/** `[start, end)` in samples of one track run. */
export type Interval = readonly [number, number];

/** Sorted, disjoint intervals covering the same samples. */
function union(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter(([a, b]) => b > a).toSorted((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out.at(-1);
    if (last !== undefined && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The samples of one union outside another. */
function minus(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let j = 0;
  for (const [start, end] of a) {
    while (j < b.length && (b[j]?.[1] ?? 0) <= start) j++;
    let from = start;
    for (let k = j; k < b.length && (b[k]?.[0] ?? end) < end; k++) {
      const [cutStart, cutEnd] = b[k] ?? [end, end];
      if (cutStart > from) out.push([from, cutStart]);
      from = Math.max(from, cutEnd);
    }
    if (from < end) out.push([from, end]);
  }
  return out;
}

/**
 * Each speaker's speech where no other speaker of the run speaks on the same
 * track run, when it lasts `MIN_ANCHORED_MS` or more; else all its speech.
 * People talk over each other (« oui », « hm »): a name given to one voice
 * covers that time too, and must not count against the other's.
 */
function aloneSpeech(speech: ReadonlyMap<string, Speech>): Map<string, Speech> {
  const out = new Map<string, Speech>();
  for (const [label, tracks] of speech) {
    const alone: Speech = new Map();
    let aloneMs = 0;
    for (const [trackRunId, track] of tracks) {
      const others = union(
        [...speech]
          .filter(([other]) => other !== label)
          .flatMap(([, otherTracks]) => otherTracks.get(trackRunId)?.intervals ?? []),
      );
      const intervals = minus(track.intervals, others);
      aloneMs += (total(intervals) * 1000) / track.sampleRate;
      if (intervals.length > 0) alone.set(trackRunId, { ...track, intervals });
    }
    out.set(label, aloneMs >= MIN_ANCHORED_MS ? alone : tracks);
  }
  return out;
}

/** Samples two unions share. */
function shared(a: readonly Interval[], b: readonly Interval[]): number {
  let total = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const [a0, a1] = a[i] ?? [0, 0];
    const [b0, b1] = b[j] ?? [0, 0];
    total += Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
    if (a1 < b1) i++;
    else j++;
  }
  return total;
}

/** The parts of `interval` outside a union (sorted, disjoint). */
export function outside(interval: Interval, cuts: readonly Interval[]): Interval[] {
  const parts: Interval[] = [];
  let from = interval[0];
  for (const [a, b] of cuts) {
    if (b <= from || a >= interval[1]) continue;
    if (a > from) parts.push([from, a]);
    from = Math.max(from, b);
  }
  if (from < interval[1]) parts.push([from, interval[1]]);
  return parts;
}

const total = (intervals: readonly Interval[]) =>
  intervals.reduce((sum, [a, b]) => sum + (b - a), 0);

/** One speaker's speech: per track run, its sample rate and merged intervals. */
type Speech = Map<number, { readonly sampleRate: number; readonly intervals: Interval[] }>;

/** Each speaker's speech in a run: its segments whose times hold (`voicedSegments`). */
function speakerSpeech(db: Database, runId: number): Map<string, Speech> {
  const raw = new Map<string, Map<number, { sampleRate: number; intervals: Interval[] }>>();
  for (const segment of voicedSegments(db, runId)) {
    const tracks = raw.get(segment.label) ?? new Map();
    raw.set(segment.label, tracks);
    const track = tracks.get(segment.trackRunId) ?? {
      sampleRate: segment.sampleRate,
      intervals: [],
    };
    track.intervals.push([segment.sampleStart, segment.sampleEnd]);
    tracks.set(segment.trackRunId, track);
  }
  const speech = new Map<string, Speech>();
  for (const [label, tracks] of raw) {
    const merged: Speech = new Map();
    for (const [trackRunId, track] of tracks) {
      const intervals = union(track.intervals);
      if (intervals.length > 0) merged.set(trackRunId, { ...track, intervals });
    }
    if (merged.size > 0) speech.set(label, merged);
  }
  return speech;
}

function personOf(row: Row, prefix = ""): Person {
  return {
    id: int(row, `${prefix}id`),
    name: str(row, `${prefix}name`),
    isSelf: int(row, `${prefix}is_self`) === 1,
  };
}

const activeAnchors = (db: Database) =>
  db.statement(
    `SELECT a.id, a.track_run_id, a.sample_start, a.sample_end, a.origin, a.created_at_ms,
            p.id AS p_id, p.name AS p_name, p.is_self AS p_is_self
     FROM user_assertions a JOIN people p ON p.id = a.person_id
     WHERE a.kind = 'speaker_is' AND a.revoked_at_ms IS NULL AND a.track_run_id = ?
       AND a.sample_start < ? AND a.sample_end > ?`,
  );

/** The person each speaker of a run is, by label; unnamed speakers are absent. */
export function resolveSpeakers(db: Database, runId: number): Map<string, Person> {
  const resolved = new Map<string, Person>();
  const run = db.statement("SELECT episode_id FROM analysis_runs WHERE id = ?").get(runId);
  if (run === undefined || !namingAllowed(db, int(run, "episode_id"))) return resolved;
  const speech = speakerSpeech(db, runId);
  if (speech.size === 0) return resolved;
  // The anchors under the run, per track and person, merged.
  const envelopes = new Map<number, Interval>();
  for (const tracks of speech.values()) {
    for (const [trackRunId, track] of tracks) {
      const first = track.intervals[0]?.[0] ?? 0;
      const last = track.intervals.at(-1)?.[1] ?? 0;
      const envelope = envelopes.get(trackRunId);
      envelopes.set(trackRunId, [
        Math.min(envelope?.[0] ?? first, first),
        Math.max(envelope?.[1] ?? last, last),
      ]);
    }
  }
  const query = activeAnchors(db);
  const people = new Map<number, Person>();
  const byTrack = new Map<
    number,
    {
      all: Interval[];
      byPerson: Map<number, Interval[]>;
      /** Each person's anchors as written, not merged. */
      anchors: Map<number, Interval[]>;
    }
  >();
  for (const [trackRunId, [start, end]] of envelopes) {
    const raw = new Map<number, Interval[]>();
    for (const row of query.all(trackRunId, end, start)) {
      const person = personOf(row, "p_");
      people.set(person.id, person);
      raw.set(person.id, [
        ...(raw.get(person.id) ?? []),
        [int(row, "sample_start"), int(row, "sample_end")],
      ]);
    }
    byTrack.set(trackRunId, {
      all: union([...raw.values()].flat()),
      byPerson: new Map([...raw].map(([personId, list]) => [personId, union(list)])),
      anchors: raw,
    });
  }
  /**
   * Whether a person's anchors over a voice were laid on that voice: each
   * one that meets its speech lies within its extent, give or take
   * `LAID_ON_SLACK_MS`. The user named this very voice, however short;
   * an anchor of a longer voice that covers it reaches past it.
   */
  const laidOn = (voice: Speech | undefined, personId: number | undefined): boolean =>
    voice !== undefined &&
    personId !== undefined &&
    [...voice].every(([trackRunId, track]) => {
      const slack = (LAID_ON_SLACK_MS * track.sampleRate) / 1000;
      const from = (track.intervals[0]?.[0] ?? 0) - slack;
      const to = (track.intervals.at(-1)?.[1] ?? 0) + slack;
      return (byTrack.get(trackRunId)?.anchors.get(personId) ?? [])
        .filter((anchor) => shared([anchor], track.intervals) > 0)
        .every(([a, b]) => a >= from && b <= to);
    });
  // A name is read where its voice speaks alone.
  for (const [label, tracks] of aloneSpeech(speech)) {
    let speechMs = 0;
    let anchoredMs = 0;
    const perPerson = new Map<number, number>();
    for (const [trackRunId, track] of tracks) {
      const toMs = (samples: number) => (samples * 1000) / track.sampleRate;
      speechMs += toMs(total(track.intervals));
      const anchors = byTrack.get(trackRunId);
      if (anchors === undefined) continue;
      anchoredMs += toMs(shared(track.intervals, anchors.all));
      for (const [personId, intervals] of anchors.byPerson) {
        perPerson.set(
          personId,
          (perPerson.get(personId) ?? 0) + toMs(shared(track.intervals, intervals)),
        );
      }
    }
    const [best, runnerUp] = [...perPerson].toSorted((a, b) => b[1] - a[1]);
    const person = best === undefined ? undefined : people.get(best[0]);
    const bestMs = best?.[1] ?? 0;
    if (
      person !== undefined &&
      (bestMs >= MIN_ANCHORED_MS || (bestMs > 0 && laidOn(speech.get(label), best?.[0]))) &&
      bestMs >= MIN_COVERAGE * speechMs &&
      bestMs >= MIN_AGREEMENT * anchoredMs &&
      (runnerUp?.[1] ?? 0) <= (1 - MIN_AGREEMENT) * anchoredMs
    ) {
      resolved.set(label, person);
    }
  }
  return resolved;
}

/** The episode's current transcript run, which supplies its speakers. */
export function currentSpeakerRun(db: Database, episodeId: number): number | null {
  const row = db
    .statement("SELECT run_id FROM episode_analysis WHERE episode_id = ? AND stage = 'asr'")
    .get(episodeId);
  return row === undefined ? null : int(row, "run_id");
}

/** Contexts whose voices are never identified. */
const unnamed: ReadonlySet<string> = new Set(["media", "dictation"]);

/**
 * Whether voices may be named in an episode (ADR 012): never in media or a
 * dictation (the user alone, talking to an app), and not where a "do not
 * identify" rule applies. The most specific rule wins:
 * the episode's, then its app's or a device's (any refusal refuses), then the
 * global one; recognition is on by default.
 */
export function namingAllowed(db: Database, episodeId: number): boolean {
  const episode = db.statement("SELECT context FROM episodes WHERE id = ?").get(episodeId);
  if (episode === undefined || unnamed.has(String(episode["context"]))) return false;
  return identityRulesAllow(db, episodeId);
}

/**
 * Whether the « do not identify » rules let an episode's voices be processed
 * at all, whatever its context: the episode's rule, then its app's or a
 * device's (any refusal refuses), then the global one. For dictations, which
 * name no one but may teach the user's voice (ADR 030).
 */
export function identityRulesAllow(db: Database, episodeId: number): boolean {
  const episode = db.statement("SELECT primary_app_id FROM episodes WHERE id = ?").get(episodeId);
  if (episode === undefined) return false;
  const rule = (scope: string, column: string | null, value: number | null): boolean | null => {
    const row =
      column === null
        ? db.statement("SELECT recognize FROM identity_rules WHERE scope = ?").get(scope)
        : db
            .statement(`SELECT recognize FROM identity_rules WHERE scope = ? AND ${column} = ?`)
            .get(scope, value);
    return row === undefined ? null : int(row, "recognize") === 1;
  };
  const own = rule("episode", "episode_id", episodeId);
  if (own !== null) return own;
  const appId = intOrNull(episode, "primary_app_id");
  const devices = db
    .statement(
      `SELECT DISTINCT t.device_id FROM episode_regions er
       JOIN speech_regions r ON r.id = er.speech_region_id
       JOIN track_runs t ON t.id = r.track_run_id
       WHERE er.episode_id = ? AND t.device_id IS NOT NULL`,
    )
    .all(episodeId)
    .map((row) => int(row, "device_id"));
  const scoped = [
    ...(appId === null ? [] : [rule("app", "app_id", appId)]),
    ...devices.map((deviceId) => rule("device", "device_id", deviceId)),
  ].filter((value) => value !== null);
  if (scoped.includes(false)) return false;
  if (scoped.includes(true)) return true;
  return rule("global", null, null) ?? true;
}

/**
 * Whether an app's sound may be identified: false when the user said not to
 * for that app (ADR 012). A call's own app counts before its episode names
 * one (ADR 025).
 */
export function appMayBeIdentified(db: Database, appId: number | null): boolean {
  if (appId === null) return true;
  const row = db
    .statement("SELECT recognize FROM identity_rules WHERE scope = 'app' AND app_id = ?")
    .get(appId);
  return row === undefined || int(row, "recognize") === 1;
}

/**
 * « Reconnaître les voix ici » for one episode (ADR 012). Its own rule is kept
 * only where it differs from what its app, its devices or the global switch
 * decide. Off deletes its voice embeddings (biometric data); on lets the voice
 * pass embed again. False: no such episode, or media or a dictation (never
 * identified).
 */
export function setEpisodeRecognition(
  db: Database,
  input: { readonly episodeId: number; readonly allowed: boolean; readonly nowMs: number },
): boolean {
  return transaction(db, () => {
    const episode = db.statement("SELECT context FROM episodes WHERE id = ?").get(input.episodeId);
    if (episode === undefined || unnamed.has(String(episode["context"]))) return false;
    db.statement("DELETE FROM identity_rules WHERE scope = 'episode' AND episode_id = ?").run(
      input.episodeId,
    );
    if (namingAllowed(db, input.episodeId) !== input.allowed) {
      db.statement(
        `INSERT INTO identity_rules (scope, episode_id, recognize, created_at_ms, updated_at_ms)
         VALUES ('episode', ?, ?, ?, ?)`,
      ).run(input.episodeId, input.allowed ? 1 : 0, input.nowMs, input.nowMs);
    }
    if (!input.allowed) {
      db.statement("DELETE FROM speaker_embeddings WHERE episode_id = ?").run(input.episodeId);
      db.statement(
        "DELETE FROM voice_passes WHERE run_id IN (SELECT id FROM analysis_runs WHERE episode_id = ?)",
      ).run(input.episodeId);
    }
    return true;
  });
}

export type NameTarget =
  | { readonly kind: "existing"; readonly personId: number }
  | { readonly kind: "new"; readonly name: string }
  /** The user; `name` is used only when the user's row does not exist yet. */
  | { readonly kind: "self"; readonly name: string };

export type SpeakerChange<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      /**
       * `stale`: the transcript the caller saw is no longer current;
       * `not-allowed`: media or a "do not identify" rule; `not-found`: no such
       * episode, speaker or person; `not-held`: the name would not read on
       * the voice, so nothing was written; `named`: voices joined by the user
       * must both be unnamed (ADR 038).
       */
      readonly reason: "stale" | "not-allowed" | "not-found" | "not-held" | "named";
    };

/** The speaker's speech in the run the caller saw, once it is still current and allowed. */
function changeTarget(
  db: Database,
  input: { readonly episodeId: number; readonly runId: number; readonly label: string },
): SpeakerChange<Speech> {
  const runId = currentSpeakerRun(db, input.episodeId);
  if (runId === null) return { ok: false, reason: "not-found" };
  if (runId !== input.runId) return { ok: false, reason: "stale" };
  if (!namingAllowed(db, input.episodeId)) return { ok: false, reason: "not-allowed" };
  const speech = speakerSpeech(db, runId).get(input.label);
  if (speech === undefined) return { ok: false, reason: "not-found" };
  return { ok: true, value: speech };
}

/**
 * Takes this speech out of every active anchor: an anchor it meets is
 * revoked and its parts outside the speech are written again, unchanged
 * otherwise, so other voices keep their names.
 */
function cutOut(db: Database, speech: Speech, nowMs: number): void {
  const query = activeAnchors(db);
  const revoke = db.statement("UPDATE user_assertions SET revoked_at_ms = ? WHERE id = ?");
  const keep = db.statement(
    `INSERT INTO user_assertions
       (kind, track_run_id, sample_start, sample_end, origin, created_at_ms, person_id)
     VALUES ('speaker_is', ?, ?, ?, ?, ?, ?)`,
  );
  for (const [trackRunId, track] of speech) {
    const first = track.intervals[0]?.[0] ?? 0;
    const last = track.intervals.at(-1)?.[1] ?? 0;
    for (const row of query.all(trackRunId, last, first)) {
      const anchor: Interval = [int(row, "sample_start"), int(row, "sample_end")];
      const parts = outside(anchor, track.intervals);
      if (parts.length === 1 && parts[0]?.[0] === anchor[0] && parts[0][1] === anchor[1]) continue;
      revoke.run(nowMs, int(row, "id"));
      for (const [a, b] of parts) {
        keep.run(trackRunId, a, b, str(row, "origin"), int(row, "created_at_ms"), int(row, "p_id"));
      }
    }
  }
}

function findPerson(db: Database, personId: number): Person | null {
  const row = db.statement("SELECT id, name, is_self FROM people WHERE id = ?").get(personId);
  return row === undefined ? null : personOf(row);
}

const cleanName = (name: string) => name.trim().replace(/\s+/gu, " ").slice(0, 80);

function targetPerson(db: Database, target: NameTarget, nowMs: number): Person | null {
  switch (target.kind) {
    case "existing":
      return findPerson(db, target.personId);
    case "self": {
      const row = db.statement("SELECT id, name, is_self FROM people WHERE is_self = 1").get();
      if (row !== undefined) return personOf(row);
      return insertPerson(db, cleanName(target.name), true, nowMs);
    }
    case "new":
      return insertPerson(db, cleanName(target.name), false, nowMs);
  }
}

function insertPerson(db: Database, name: string, isSelf: boolean, nowMs: number): Person | null {
  if (name === "") return null;
  const result = db
    .statement(
      "INSERT INTO people (name, is_self, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)",
    )
    .run(name, isSelf ? 1 : 0, nowMs, nowMs);
  return { id: Number(result.lastInsertRowid), name, isSelf };
}

/** The user's row, made with `name` when there is none yet (a voice read, ADR 034). */
export function ensureSelf(db: Database, name: string, nowMs: number): Person | null {
  return targetPerson(db, { kind: "self", name }, nowMs);
}

/** The user's own person row, once they said which voice is theirs. */
export function selfPersonId(db: Database): number | null {
  const row = db.statement("SELECT id FROM people WHERE is_self = 1").get();
  return row === undefined ? null : int(row, "id");
}

/** A name written that the voice would not read: undone. */
class NameNotHeld extends Error {
  override readonly name = "NameNotHeld";
}

/**
 * Names one voice of the transcript the caller saw (`runId`). Naming it again
 * as the person it already reads as writes nothing; a name the voice would
 * not read is not kept (`not-held`), so a click never silently does nothing.
 */
export function nameSpeaker(
  db: Database,
  input: {
    readonly episodeId: number;
    readonly runId: number;
    readonly label: string;
    readonly person: NameTarget;
    readonly nowMs: number;
  },
): SpeakerChange<Person> {
  try {
    return transaction(db, (): SpeakerChange<Person> => {
      const target = changeTarget(db, input);
      if (!target.ok) return target;
      const current = resolveSpeakers(db, input.runId).get(input.label);
      const wanted =
        input.person.kind === "existing"
          ? input.person.personId
          : input.person.kind === "self"
            ? selfPersonId(db)
            : null;
      if (current !== undefined && current.id === wanted) return { ok: true, value: current };
      const person = targetPerson(db, input.person, input.nowMs);
      if (person === null) return { ok: false, reason: "not-found" };
      cutOut(db, target.value, input.nowMs);
      const insert = db.statement(
        `INSERT INTO user_assertions
           (kind, track_run_id, sample_start, sample_end, origin, created_at_ms, person_id)
         VALUES ('speaker_is', ?, ?, ?, 'app', ?, ?)`,
      );
      for (const [trackRunId, track] of target.value) {
        for (const [a, b] of track.intervals) insert.run(trackRunId, a, b, input.nowMs, person.id);
      }
      if (resolveSpeakers(db, input.runId).get(input.label)?.id !== person.id) {
        throw new NameNotHeld();
      }
      return { ok: true, value: person };
    });
  } catch (error) {
    if (error instanceof NameNotHeld) return { ok: false, reason: "not-held" };
    throw error;
  }
}

/** Takes the name off one voice; the person stays. */
export function unnameSpeaker(
  db: Database,
  input: {
    readonly episodeId: number;
    readonly runId: number;
    readonly label: string;
    readonly nowMs: number;
  },
): SpeakerChange<null> {
  return transaction(db, (): SpeakerChange<null> => {
    const target = changeTarget(db, input);
    if (!target.ok) return target;
    cutOut(db, target.value, input.nowMs);
    return { ok: true, value: null };
  });
}

export interface PersonEpisodes {
  readonly person: Person;
  /** The episodes whose current transcript names this person, newest first. */
  readonly episodeIds: readonly number[];
  readonly lastHeardMs: number | null;
}

/** A current transcript some name reaches, with the person each voice is. */
export interface NamedRun {
  readonly episodeId: number;
  readonly runId: number;
  readonly startedAtMs: number;
  readonly speakers: ReadonlyMap<string, Person>;
}

/**
 * The current transcripts whose speech meets an active name, newest first,
 * each resolved once. Found from the extent of each one's sentences per track
 * run (one pass) and one indexed probe each: joining every anchor with every
 * sentence took 0.6 s on 4,400 anchors (2026-11-09), this 8 ms.
 */
export function namedRuns(db: Database): NamedRun[] {
  const extents = db
    .statement(
      `SELECT x.run_id, x.track_run_id, min(x.sample_start) AS lo, max(x.sample_end) AS hi,
         ea.episode_id, e.started_at_ms
       FROM episode_analysis ea
       JOIN segments x ON x.run_id = ea.run_id
       JOIN episodes e ON e.id = ea.episode_id
       WHERE ea.stage = 'asr'
       GROUP BY x.run_id, x.track_run_id`,
    )
    .all();
  const anchored = db.statement(
    `SELECT 1 FROM user_assertions
     WHERE track_run_id = ? AND sample_start < ? AND sample_end > ?
       AND kind = 'speaker_is' AND revoked_at_ms IS NULL LIMIT 1`,
  );
  const found = new Map<number, Row>();
  for (const row of extents) {
    const runId = int(row, "run_id");
    if (found.has(runId)) continue;
    if (anchored.get(int(row, "track_run_id"), int(row, "hi"), int(row, "lo")) !== undefined) {
      found.set(runId, row);
    }
  }
  return [...found.values()]
    .toSorted(
      (a, b) =>
        int(b, "started_at_ms") - int(a, "started_at_ms") ||
        int(b, "episode_id") - int(a, "episode_id"),
    )
    .map((row) => ({
      episodeId: int(row, "episode_id"),
      runId: int(row, "run_id"),
      startedAtMs: int(row, "started_at_ms"),
      speakers: resolveSpeakers(db, int(row, "run_id")),
    }))
    .filter((run) => run.speakers.size > 0);
}

/** Every person, with the episodes their name reaches now, newest heard first. */
export function listPeople(
  db: Database,
  runs: readonly NamedRun[] = namedRuns(db),
): PersonEpisodes[] {
  const people = db
    .statement("SELECT id, name, is_self FROM people ORDER BY name COLLATE NOCASE, id")
    .all()
    .map((row) => personOf(row));
  const heard = new Map<number, { episodeIds: number[]; lastHeardMs: number }>();
  for (const run of runs) {
    for (const person of new Set([...run.speakers.values()].map((p) => p.id))) {
      const entry = heard.get(person) ?? { episodeIds: [], lastHeardMs: run.startedAtMs };
      if (!entry.episodeIds.includes(run.episodeId)) entry.episodeIds.push(run.episodeId);
      heard.set(person, entry);
    }
  }
  return people
    .map((person) => ({
      person,
      episodeIds: heard.get(person.id)?.episodeIds ?? [],
      lastHeardMs: heard.get(person.id)?.lastHeardMs ?? null,
    }))
    .toSorted((a, b) => (b.lastHeardMs ?? 0) - (a.lastHeardMs ?? 0));
}

export function getPerson(db: Database, personId: number): Person | null {
  return findPerson(db, personId);
}

/** False when no such person (deleted) or the name is empty. */
export function renamePerson(
  db: Database,
  input: { readonly personId: number; readonly name: string; readonly nowMs: number },
): boolean {
  const name = cleanName(input.name);
  if (name === "") return false;
  return (
    db
      .statement("UPDATE people SET name = ?, updated_at_ms = ? WHERE id = ?")
      .run(name, input.nowMs, input.personId).changes > 0
  );
}

export type PeopleMerge =
  | { readonly ok: true; readonly value: Person }
  /** `same`: one person twice; `not-found`: either is gone. */
  | { readonly ok: false; readonly reason: "same" | "not-found" };

/**
 * « Fusionner avec… » (ADR 025): `otherId` was `personId` all along. Every
 * assertion naming the other, revoked ones too, names this person; the other
 * row goes. This person keeps their name, and is the user if either was.
 * Voice embeddings belong to voices, not people, so the person's voice (and
 * what is suggested from it) is both voices at once. Where the merged person
 * now both is and is not a voice's speech (« Non » to Marie, then that voice
 * named Marie D.), the name wins: each « Non » is cut around the speech named
 * as them, and around earlier « Non » over the same samples, so each sample
 * is refused once.
 */
export function mergePeople(
  db: Database,
  input: { readonly personId: number; readonly otherId: number; readonly nowMs: number },
): PeopleMerge {
  return transaction(db, (): PeopleMerge => {
    if (input.personId === input.otherId) return { ok: false, reason: "same" };
    const person = findPerson(db, input.personId);
    const other = findPerson(db, input.otherId);
    if (person === null || other === null) return { ok: false, reason: "not-found" };
    const isSelf = person.isSelf || other.isSelf;
    // One user at most: the other row lets go first.
    if (other.isSelf) db.statement("UPDATE people SET is_self = 0 WHERE id = ?").run(other.id);
    db.statement("UPDATE people SET is_self = ?, updated_at_ms = ? WHERE id = ?").run(
      isSelf ? 1 : 0,
      input.nowMs,
      person.id,
    );
    db.statement("UPDATE user_assertions SET person_id = ? WHERE person_id = ?").run(
      person.id,
      other.id,
    );
    // The user's voice read follows the user (ADR 034).
    db.statement("UPDATE voice_reads SET person_id = ? WHERE person_id = ?").run(
      person.id,
      other.id,
    );
    settleRefusals(db, person.id, input.nowMs);
    db.statement("DELETE FROM people WHERE id = ?").run(other.id);
    return { ok: true, value: { ...person, isSelf } };
  });
}

/**
 * Cuts a person's active « Non » around their active names and around the
 * « Non » before them on the same samples; an anchor left whole stays as it
 * is, one cut is revoked and its parts written again.
 */
function settleRefusals(db: Database, personId: number, nowMs: number): void {
  const anchors = (kind: "speaker_is" | "speaker_is_not") =>
    db
      .statement(
        `SELECT id, track_run_id, sample_start, sample_end, origin, created_at_ms
         FROM user_assertions
         WHERE kind = ? AND person_id = ? AND revoked_at_ms IS NULL
         ORDER BY track_run_id, created_at_ms, id`,
      )
      .all(kind, personId);
  const names = new Map<number, Interval[]>();
  for (const row of anchors("speaker_is")) {
    const trackRunId = int(row, "track_run_id");
    names.set(trackRunId, [
      ...(names.get(trackRunId) ?? []),
      [int(row, "sample_start"), int(row, "sample_end")],
    ]);
  }
  const revoke = db.statement("UPDATE user_assertions SET revoked_at_ms = ? WHERE id = ?");
  const keep = db.statement(
    `INSERT INTO user_assertions
       (kind, track_run_id, sample_start, sample_end, origin, created_at_ms, person_id)
     VALUES ('speaker_is_not', ?, ?, ?, ?, ?, ?)`,
  );
  const refused = new Map<number, Interval[]>();
  for (const row of anchors("speaker_is_not")) {
    const trackRunId = int(row, "track_run_id");
    const anchor: Interval = [int(row, "sample_start"), int(row, "sample_end")];
    const taken = refused.get(trackRunId) ?? [];
    const parts = outside(anchor, union([...(names.get(trackRunId) ?? []), ...taken]));
    refused.set(trackRunId, [...taken, ...parts]);
    if (parts.length === 1 && parts[0]?.[0] === anchor[0] && parts[0][1] === anchor[1]) continue;
    revoke.run(nowMs, int(row, "id"));
    for (const [a, b] of parts) {
      keep.run(trackRunId, a, b, str(row, "origin"), int(row, "created_at_ms"), personId);
    }
  }
}

/**
 * Deletes a person with their voice (ADR 012): the embeddings of the voices
 * their name reaches (the user's dictations too, ADR 030), then the person
 * and, by cascade, every assertion naming them and their voice read
 * (ADR 034), so their voices read « Voix N » again. Those transcripts stay marked as embedded, so the voices
 * are not embedded again. False when there was no such person.
 */
export function deletePerson(db: Database, personId: number): boolean {
  return transaction(db, () => {
    if (findPerson(db, personId)?.isSelf === true) forgetDictationVoices(db);
    const remove = db.statement("DELETE FROM speaker_embeddings WHERE run_id = ? AND label = ?");
    const entry = listPeople(db).find((item) => item.person.id === personId);
    for (const episodeId of entry?.episodeIds ?? []) {
      const runId = currentSpeakerRun(db, episodeId);
      if (runId === null) continue;
      for (const [label, person] of resolveSpeakers(db, runId)) {
        if (person.id === personId) remove.run(runId, label);
      }
    }
    return db.statement("DELETE FROM people WHERE id = ?").run(personId).changes > 0;
  });
}

/**
 * Deletes the embeddings of the user's dictations and the record that they
 * were embedded (ADR 030): what « Apprendre ma voix depuis mes dictées »
 * turned off, or the user's deletion, leaves.
 */
export function forgetDictationVoices(db: Database): void {
  // Every dictation run's record, with or without an embedding left.
  db.statement(
    `DELETE FROM voice_passes WHERE run_id IN (
       SELECT r.id FROM analysis_runs r JOIN episodes e ON e.id = r.episode_id
       WHERE e.context = 'dictation')`,
  ).run();
  db.statement(
    `DELETE FROM speaker_embeddings
     WHERE episode_id IN (SELECT id FROM episodes WHERE context = 'dictation')`,
  ).run();
}

/** Whether voices are recognised at all (ADR 012: on unless the user turned it off). */
export function recognitionEnabled(db: Database): boolean {
  const row = db.statement("SELECT recognize FROM identity_rules WHERE scope = 'global'").get();
  return row === undefined || int(row, "recognize") === 1;
}

/**
 * Turns « Reconnaître les voix » on or off. Off: no voice reads as a person
 * anywhere, and every voice embedding (biometric data) is deleted with the
 * record of which transcripts were embedded, the user's voice read too
 * (ADR 034: it has no audio to be made again from); the names the user gave
 * stay and read again once it is back on, when the voice pass embeds again.
 */
export function setRecognition(
  db: Database,
  input: { readonly on: boolean; readonly nowMs: number },
) {
  transaction(db, () => {
    db.statement(
      `INSERT INTO identity_rules (scope, recognize, created_at_ms, updated_at_ms)
       VALUES ('global', ?, ?, ?)
       ON CONFLICT (scope) WHERE scope = 'global'
       DO UPDATE SET recognize = excluded.recognize, updated_at_ms = excluded.updated_at_ms`,
    ).run(input.on ? 1 : 0, input.nowMs, input.nowMs);
    if (!input.on) {
      db.statement("DELETE FROM speaker_embeddings").run();
      db.statement("DELETE FROM voice_passes").run();
      db.statement("DELETE FROM voice_reads").run();
    }
  });
}

/**
 * The people named among each episode's voices in its current transcript,
 * the user first, then in the order the voices first spoke; episodes without
 * any are absent. For lists that show who was there (Today).
 */
export function episodePeople(db: Database, episodeIds: readonly number[]): Map<number, Person[]> {
  const out = new Map<number, Person[]>();
  if (episodeIds.length === 0) return out;
  const runs = db
    .statement(
      `SELECT episode_id, run_id FROM episode_analysis
       WHERE stage = 'asr' AND episode_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(episodeIds));
  const ordinals = db.statement(
    "SELECT label FROM episode_speakers WHERE run_id = ? ORDER BY ordinal",
  );
  for (const row of runs) {
    const runId = int(row, "run_id");
    const named = resolveSpeakers(db, runId);
    if (named.size === 0) continue;
    const people: Person[] = [];
    for (const speaker of ordinals.all(runId)) {
      const person = named.get(str(speaker, "label"));
      if (person !== undefined && !people.some((known) => known.id === person.id)) {
        people.push(person);
      }
    }
    out.set(
      int(row, "episode_id"),
      people.toSorted((a, b) => Number(b.isSelf) - Number(a.isSelf)),
    );
  }
  return out;
}
